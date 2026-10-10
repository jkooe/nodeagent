//! Node sidecar 管理器 —— 启动 `apps/console/sidecar/main.mjs` 并做 JSON-RPC 转发。
//!
//! ## 为什么是 sidecar（而不是 Rust 版 client）
//! 原设计让本壳自己实现一份 client，与 TS 版（`@nodeagent/client`）**两套协议实现并存** ——
//! 改了一处漏另一处时，构建过、单测过，只在真机暴露。sidecar 让本壳只做
//! **进程管理 + 消息转发**，协议实现只剩 TS 一份。
//!
//! ## 协议（行分隔 JSON，见 apps/console/sidecar/main.mjs 顶部注释）
//! 出（本壳 → sidecar）：`{"jsonrpc":"2.0","id":N,"method":...,"params":{...}}`
//! 入（sidecar → 本壳）：
//!   - 响应：`{"jsonrpc":"2.0","id":N,"result"|"error":...}`
//!   - 通知：`{"jsonrpc":"2.0","method":"event","params":{"kind":...,...}}`
//!
//! ## 可测试性（本项目纪律：不能只 `cargo check`）
//! 本模块的 `spawn` / `request` / 事件回调**都能在 `cargo test` 里真跑** ——
//! 单测直接拉起真实的 node 进程，不依赖 Tauri GUI。GUI 那层才需要人工验证。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

/// sidecar 主动推上来的事件（与 `main.mjs` 的 `params.kind` 一一对应）。
#[derive(Debug, Clone)]
pub enum SidecarEvent {
    /// 连接状态变化：connected / reconnecting / closed
    State(String),
    /// 日志一行
    Log(String),
    /// 被控端主动推送的事件（v12 `event.*`）
    Event(Value),
    /// sidecar 上来的未知通知（保留原始形态，便于排查）
    Other(Value),
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// 一个已启动的 sidecar 进程。
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    stdin: tokio::sync::Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
}

impl Sidecar {
    /// 启动 sidecar 并开始读取其 stdout。
    ///
    /// `on_event`：sidecar 的通知回调（本壳里用于桥接成 Tauri event）。
    pub fn spawn(
        node: &Path,
        script: &Path,
        on_event: Arc<dyn Fn(SidecarEvent) + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        let mut child = Command::new(node)
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true) // app 退出时不留孤儿进程
            .spawn()
            .map_err(|e| format!("启动 sidecar 失败（{} {}）：{e}", node.display(), script.display()))?;

        let stdin = child.stdin.take().ok_or("sidecar stdin 不可用")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout 不可用")?;
        let stderr = child.stderr.take().ok_or("sidecar stderr 不可用")?;

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        // stdout：逐行读，分派「响应」与「通知」
        {
            let pending = Arc::clone(&pending);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let text = line.trim();
                    if text.is_empty() {
                        continue;
                    }
                    let Ok(msg) = serde_json::from_str::<Value>(text) else {
                        // 混入非 JSON 行说明协议被破坏 —— 记日志但不崩
                        eprintln!("[sidecar] 非 JSON 输出：{}", &text[..text.len().min(200)]);
                        continue;
                    };

                    // 响应：有 id
                    if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let out = if let Some(err) = msg.get("error") {
                                Err(err
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("sidecar 返回错误")
                                    .to_string())
                            } else {
                                Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                            };
                            let _ = tx.send(out);
                        }
                        continue;
                    }

                    // 通知：method == "event"
                    if msg.get("method").and_then(Value::as_str) == Some("event") {
                        let p = msg.get("params").cloned().unwrap_or(Value::Null);
                        let kind = p.get("kind").and_then(Value::as_str).unwrap_or("");
                        let evt = match kind {
                            "state" => SidecarEvent::State(
                                p.get("state").and_then(Value::as_str).unwrap_or("closed").to_string(),
                            ),
                            "log" => SidecarEvent::Log(
                                p.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                            ),
                            "agent_event" => {
                                SidecarEvent::Event(p.get("event").cloned().unwrap_or(Value::Null))
                            }
                            _ => SidecarEvent::Other(p),
                        };
                        on_event(evt);
                    }
                }
            });
        }

        // stderr：sidecar 的日志 → 本壳 stderr（保持 stdout 干净）
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("{}", line);
            }
        });

        Ok(Arc::new(Self {
            child: Mutex::new(Some(child)),
            stdin: tokio::sync::Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
        }))
    }

    /// 发一个请求并等响应（`timeout_secs` 兜底，避免 sidecar 卡住时本壳一起挂）。
    pub async fn request(&self, method: &str, params: Value, timeout_secs: u64) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(format!("{msg}\n").as_bytes())
                .await
                .map_err(|e| format!("写入 sidecar 失败：{e}"))?;
            stdin.flush().await.map_err(|e| format!("flush sidecar 失败：{e}"))?;
        }

        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("sidecar 通道已关闭".to_string()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("{method} 超时（{timeout_secs}s）"))
            }
        }
    }

    /// 关掉 sidecar（app 退出或显式 disconnect 时调用）。
    pub async fn shutdown(&self) {
        let _ = self.request("disconnect", json!({}), 5).await;
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill().await;
        }
    }
}

// ---------------------------------------------------------------------------
// 路径解析：开发期用系统 node + 仓库内脚本；打包后从 Tauri resource 目录取
// ---------------------------------------------------------------------------

/// 解析 node 可执行文件。
///
/// 优先级：环境变量 `NODEAGENT_CONSOLE_NODE` → 随包 resource 的 `node` → 系统 `node`。
pub fn resolve_node(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("NODEAGENT_CONSOLE_NODE") {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    if let Some(dir) = resource_dir {
        let bundled = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        if bundled.exists() {
            return Ok(bundled);
        }
    }
    // 系统 node（开发期）
    for cand in ["node", "node.exe"] {
        if which(cand).is_some() {
            return Ok(PathBuf::from(cand));
        }
    }
    Err("找不到 node 可执行文件（可用 NODEAGENT_CONSOLE_NODE 指定）".to_string())
}

/// 极简 which（避免为一个函数引依赖）。
fn which(cmd: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let full = dir.join(cmd);
        if full.is_file() {
            return Some(full);
        }
    }
    None
}

/// 解析 sidecar 脚本。
///
/// 优先级：环境变量 `NODEAGENT_CONSOLE_SIDECAR` → 随包 resource 的 `sidecar.mjs` →
/// 开发期的 `apps/console/sidecar/dist/sidecar.mjs`（相对本 crate）。
pub fn resolve_sidecar(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("NODEAGENT_CONSOLE_SIDECAR") {
        if !p.is_empty() && Path::new(&p).exists() {
            return Ok(PathBuf::from(p));
        }
    }
    if let Some(dir) = resource_dir {
        let bundled = dir.join("sidecar.mjs");
        if bundled.exists() {
            return Ok(bundled);
        }
    }
    // 开发期：src-tauri → apps/console/sidecar/dist/sidecar.mjs
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../sidecar/dist/sidecar.mjs");
    if dev.exists() {
        return Ok(dev);
    }
    Err("找不到 sidecar.mjs（先跑 `pnpm --filter nodeagent-console sidecar:build`，\
或用 NODEAGENT_CONSOLE_SIDECAR 指定）"
        .to_string())
}

// ---------------------------------------------------------------------------
// 单测：真跑 sidecar 进程（不依赖 Tauri GUI）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// 开发期的 sidecar 源码（不依赖打包产物，pnpm 的 node_modules 已能解析其依赖）。
    fn dev_sidecar_src() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecar/main.mjs")
    }

    fn node_bin() -> PathBuf {
        resolve_node(None).expect("需要 node 才能跑 sidecar 单测")
    }

    #[tokio::test]
    async fn 启动后_state_请求应返回未连接() {
        let seen: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&seen);
        let sc = Sidecar::spawn(
            &node_bin(),
            &dev_sidecar_src(),
            Arc::new(move |_e| {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .expect("sidecar 应能启动");

        let r = sc.request("state", json!({}), 15).await.expect("state 应成功");
        assert_eq!(r["connected"], json!(false), "未连接时 connected 应为 false");
        sc.shutdown().await;
    }

    #[tokio::test]
    async fn 未知方法应返回错误而不是崩溃() {
        let sc = Sidecar::spawn(&node_bin(), &dev_sidecar_src(), Arc::new(|_| {}))
            .expect("sidecar 应能启动");

        let err = sc.request("no_such_method", json!({}), 15).await;
        assert!(err.is_err(), "未知方法应返回错误");

        // 关键：进程没崩，后续请求仍可用
        let ok = sc.request("state", json!({}), 15).await.expect("sidecar 不应因错误退出");
        assert_eq!(ok["connected"], json!(false));
        sc.shutdown().await;
    }

    #[tokio::test]
    async fn 未连接时_invoke_应返回明确错误() {
        let sc = Sidecar::spawn(&node_bin(), &dev_sidecar_src(), Arc::new(|_| {}))
            .expect("sidecar 应能启动");

        let err = sc.request("invoke", json!({"capability": "system.info"}), 15).await;
        match err {
            Err(msg) => assert!(msg.contains("尚未连接"), "错误信息应提示未连接，实际：{msg}"),
            Ok(v) => panic!("未连接时 invoke 应失败，实际返回：{v}"),
        }
        sc.shutdown().await;
    }
}
