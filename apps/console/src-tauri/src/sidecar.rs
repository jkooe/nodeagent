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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// 「本实例已不可用」的标记（stdout 关闭 / 写入失败）。
    ///
    /// ⚠️ 为什么不能只靠 `child.try_wait()`：往**已退出进程的管道**里写在 Windows 上
    /// 未必立刻报错（管道缓冲区吞下就返回成功），于是请求会一路干等到 `request` 的超时。
    /// 真机实证（2026-10-13，Windows 11 ARM64）：sidecar 早已退出，控制台却仍复用缓存里的
    /// `Arc<Sidecar>`，点「检查更新」等满 45 秒 → 界面显示「检查更新失败：check_update 超时」；
    /// 而同一台机器上**手工拉起 sidecar 跑同一个请求只要 7 秒**。
    /// 所以判定「它死了」要多路取证：进程状态 ∨ stdout EOF ∨ 写入失败。
    dead: Arc<AtomicBool>,
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
        let dead = Arc::new(AtomicBool::new(false));

        // stdout：逐行读，分派「响应」与「通知」
        {
            let pending = Arc::clone(&pending);
            let dead = Arc::clone(&dead);
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

                // 走到这里 = stdout 关闭（EOF 或读取出错）= sidecar 进程已结束。
                dead.store(true, Ordering::SeqCst);
                // 顺手唤醒**所有还在等响应**的请求，让它们立刻失败，
                // 而不是干等各自的 timeout（check_update 45s / download 320s）。
                // 没有这一步，sidecar 死掉的那一刻就会有请求白等好几分钟。
                let mut waiting = pending.lock().unwrap();
                for (_, tx) in waiting.drain() {
                    let _ = tx.send(Err("sidecar 已退出（stdout 关闭），请重试".to_string()));
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
            dead,
        }))
    }

    /// 本实例是否仍然可用（子进程还在跑，且未被判定失效）。
    ///
    /// `try_wait()` 返回 `Ok(None)` = 仍在运行；返回 `Some(_)` = 已退出。
    /// 任何拿不准的情况一律按「不可用」处理 —— 宁可付一次 sidecar 冷启动的代价，
    /// 也不要让用户的每个操作都干等到 timeout（那正是真机上报「更新失败」的形态）。
    pub fn is_alive(&self) -> bool {
        if self.dead.load(Ordering::SeqCst) {
            return false;
        }
        let mut guard = self.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false, // shutdown() 已经把 child 取走了
        }
    }

    /// 发一个请求并等响应（`timeout_secs` 兜底，避免 sidecar 卡住时本壳一起挂）。
    pub async fn request(&self, method: &str, params: Value, timeout_secs: u64) -> Result<Value, String> {
        // 入口先判存活 —— 这是「秒失败」的那一道。
        // 只靠写入报错是不够的：Windows 上往已关闭的管道写可能被缓冲区吞掉而"成功"，
        // 之后就会一路干等到 timeout（真机形态：check_update 45s）。宁可在入口直接拒绝。
        if !self.is_alive() {
            return Err(format!("sidecar 不可用（进程已退出），{method} 已放弃"));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        {
            let mut stdin = self.stdin.lock().await;
            // 写入/刷新失败 = 管道对面没人了 → 立刻置 dead，让下一次 ensure_sidecar 重建。
            // 否则后续每个请求都会重演「写进去、永远没响应、干等到超时」。
            if let Err(e) = stdin.write_all(format!("{msg}\n").as_bytes()).await {
                self.dead.store(true, Ordering::SeqCst);
                return Err(format!(
                    "写入 sidecar 失败：{e}（sidecar 可能已退出，下次操作会自动重建）"
                ));
            }
            if let Err(e) = stdin.flush().await {
                self.dead.store(true, Ordering::SeqCst);
                return Err(format!(
                    "flush sidecar 失败：{e}（sidecar 可能已退出，下次操作会自动重建）"
                ));
            }
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
        // ⚠️ 必须**先把 child 取出来、让锁离开作用域**，再 await kill()。
        // 若写成 `if let Some(child) = self.child.lock().unwrap().take() { child.kill().await }`，
        // MutexGuard 会存活到 if 块结束 → 跨 await 持有 std Mutex（clippy::await_holding_lock，
        // 且真会阻塞 executor）。
        let child = self.child.lock().unwrap().take();
        self.dead.store(true, Ordering::SeqCst); // 主动关闭同样视为不可用
        if let Some(mut child) = child {
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

    // -----------------------------------------------------------------------
    // 「sidecar 退出后不得被复用」—— 2026-10-13 真机缺陷
    //
    // 现象：控制台点「检查更新」等满 45 秒，界面报「check_update 超时」；
    //       而同一台机器上手工拉起 sidecar 跑同一个请求只要 7 秒。
    // 根因：控制台缓存里的 Arc<Sidecar> 指向早已退出的子进程，
    //       ensure_sidecar 只判「缓存里有没有」，不判「那进程还活着没」。
    // -----------------------------------------------------------------------

    /// 把 sidecar 的子进程直接杀掉，模拟真机上它意外退出。
    fn kill_child(sc: &Sidecar) {
        let mut guard = sc.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            let _ = child.start_kill();
        }
    }

    /// 等 is_alive 变为 false（stdout 任务观察到 EOF 会置 dead）。
    async fn wait_dead(sc: &Sidecar) {
        for _ in 0..150 {
            if !sc.is_alive() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn 启动后_is_alive_应为真_shutdown_后应为假() {
        let sc = Sidecar::spawn(&node_bin(), &dev_sidecar_src(), Arc::new(|_| {}))
            .expect("sidecar 应能启动");
        assert!(sc.is_alive(), "刚启动的 sidecar 应判为存活");
        sc.shutdown().await;
        assert!(!sc.is_alive(), "shutdown 之后必须判为不存活");
    }

    #[tokio::test]
    async fn 子进程被杀后_is_alive_必须变假() {
        let sc = Sidecar::spawn(&node_bin(), &dev_sidecar_src(), Arc::new(|_| {}))
            .expect("sidecar 应能启动");
        assert!(sc.is_alive());

        kill_child(&sc);
        wait_dead(&sc).await;

        assert!(
            !sc.is_alive(),
            "子进程已退出，is_alive 仍为真 → ensure_sidecar 会继续复用死实例（就是真机那个缺陷）"
        );
    }

    #[tokio::test]
    async fn 对已退出的_sidecar_发请求必须秒失败而不是干等超时() {
        let sc = Sidecar::spawn(&node_bin(), &dev_sidecar_src(), Arc::new(|_| {}))
            .expect("sidecar 应能启动");

        kill_child(&sc);
        wait_dead(&sc).await;

        // 故意给 30 秒超时：正确实现应当在入口就拒绝（毫秒级）。
        // 首版缺陷的表现恰恰是「干等到超时」，所以这里**断言耗时**而不只是断言出错。
        let t0 = std::time::Instant::now();
        let r = sc.request("state", json!({}), 30).await;
        let cost = t0.elapsed();

        assert!(r.is_err(), "对已退出的 sidecar 发请求必须失败");
        assert!(
            cost < std::time::Duration::from_secs(5),
            "应快速失败，实际耗时 {cost:?} —— 若接近 30s 说明仍在干等超时"
        );
    }
}
