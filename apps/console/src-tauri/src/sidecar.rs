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

// ---------------------------------------------------------------------------
// 路径净化：**交给外部进程**（node）的路径必须先去掉 Windows verbatim 前缀
// ---------------------------------------------------------------------------

/// 去掉 Windows 的 verbatim 前缀（`\\?\` 与 `\\?\UNC\`）。
///
/// ## 为什么非做不可（2026-10-13 真机缺陷的根因）
/// Tauri 的 `resource_dir()` 返回的是**规范化之后的 verbatim 路径**
/// （`\\?\C:\Users\…\nodeagent-console`）。把它当**参数**交给 node 时，
/// node 启动流程会在入口模块的 `realpathSync` 里把它拆成 `C:` 与剩余部分：
///
/// ```text
/// Error: EISDIR: illegal operation on a directory, lstat 'C:'
///     at Object.realpathSync (node:fs:27xx)
/// ```
///
/// → **exit 1，且一行 JS 都来不及执行**（连 sidecar 自己的启动日志都写不出来）。
///
/// ## 真机 A/B —— 二维四格，精确到是「哪一维」出问题
/// Windows 11 ARM64；同一个 `node.exe`、同一份最小脚本 `mini.mjs`；用
/// `ProcessStartInfo` 下发，**精确对应 Rust `Command::new(prog).arg(script)` 的形态**：
///
/// | # | `program` | 脚本参数 | 结果 |
/// |---|---|---|---|
/// | G1 | `C:\…\node.exe` | `C:\…\mini.mjs` | exit 0，正常输出（**= 修复后的形态**） |
/// | G2 | `C:\…\node.exe` | `\\?\C:\…\mini.mjs` | **exit 1**，`EISDIR … lstat 'C:'` |
/// | G3 | `\\?\C:\…\node.exe` | `C:\…\mini.mjs` | exit 0，正常输出 |
/// | G4 | `\\?\C:\…\node.exe` | `\\?\C:\…\mini.mjs` | **exit 1**，`EISDIR … lstat 'C:'` |
///
/// **结论**：炸的是「**脚本参数**带 verbatim」，**不是**「可执行文件带 verbatim」——
/// G3 证明 `program` 位置带前缀 node 照常启动；真机上也有旁证：被控端与 sidecar 进程的
/// `program` 都带 `\\?\`（见 `Get-CimInstance Win32_Process` 的 CommandLine）却长期存活。
/// 因此 `sidecar_command` 里**净化 `script` 才是关键修复**，净化 `node` 属防御性
/// （幂等、无副作用；且 `\\?\` 路径不适合出现在计划任务 `-Execute` 之类场景）。
///
/// 另有一次更贴近原症状的观测（同一台机器，直接用真 `sidecar.mjs`）：
/// 普通路径 **2.5 秒**返回 `check_update` 结果并常驻；
/// `\\?\` 路径 **0.5 秒**即退出、exit 1、**零 JS 执行**（连自带启动日志都没写出来）。
///
/// 控制台侧前后两种表现都由这一条派生：
/// - 修存活检测**之前**：请求写进已死进程的管道 → 干等 45 秒 → 「check_update 超时」；
/// - 修存活检测**之后**：stdout 立即 EOF → 「sidecar 已退出（stdout 关闭），请重试」。
///
/// ## 为什么单测 / CI / 开发模式全都测不出来
/// 开发期 `resolve_sidecar` 走的是 `CARGO_MANIFEST_DIR` 拼出来的**普通路径**；
/// 只有**打包之后**才会从 `resource_dir()` 拿到 verbatim 路径。
/// 于是「本地全绿 + CI 全绿 + 真机必挂」。
///
/// 纯字符串处理，**任何平台都可安全调用**（非 Windows 上一般原样返回），
/// 因此可以用 Windows 形态的字符串在 macOS / Linux 上直接验证 Windows 分支。
///
/// ## 为什么用 `to_str()` 而不是 `to_string_lossy()`
/// 后者会把**非法字节替换成 U+FFFD** 再用替换后的串重建路径 —— 那是**损坏路径**，
/// 比不净化更糟：原本只是 node 会报 EISDIR，改完会变成「指向一个不存在的目录」，
/// 更难排查。故非 UTF-8 一律**原样返回**（Windows 上是含未配对代理项的路径；
/// Unix 上是含非法字节的文件名 —— 两者都不该被我们的「净化」悄悄改写）。
pub(crate) fn unverbatim(path: PathBuf) -> PathBuf {
    let fixed: Option<PathBuf> = path.to_str().and_then(|s| {
        let rest = s.strip_prefix(r"\\?\")?;
        Some(match rest.strip_prefix("UNC\\") {
            // \\?\UNC\server\share\x → \\server\share\x（UNC 必须还原成双反斜杠）
            Some(unc) => PathBuf::from(format!(r"\\{unc}")),
            // \\?\C:\x → C:\x
            None => PathBuf::from(rest),
        })
    });
    fixed.unwrap_or(path)
}

/// 构造「把 sidecar 拉起来」的那条命令 —— **唯一**把路径交给 node 的地方。
///
/// 「必须去掉 verbatim 前缀」这条纪律只在这里守一次；单测直接断言本函数产出的
/// `program` / `args`，因此**在 macOS / Linux 上也守得住 Windows 分支**（守的是
/// 「最终下发文本」，不是「源码里出现过某个常量」）。
fn sidecar_command(node: &Path, script: &Path) -> Command {
    let mut cmd = Command::new(unverbatim(node.to_path_buf()));
    cmd.arg(unverbatim(script.to_path_buf()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true); // app 退出时不留孤儿进程
    cmd
}

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
        // 进程边界：先净化一次（用于报错信息与实际下发文本一致）。
        // 真正「不得带 verbatim 前缀」这道纪律由 `sidecar_command` 兜底 ——
        // 去掉它会复现真机缺陷（node 启动即 EISDIR 退出），单测会红。
        let node = unverbatim(node.to_path_buf());
        let script = unverbatim(script.to_path_buf());

        let mut child = sidecar_command(&node, &script)
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
///
/// ⚠️ 出口一律经 `unverbatim`：`resource_dir()` 在 Windows 上给的是 verbatim 路径。
/// 对本函数而言这是**防御性**净化 —— 真机四格实验（见 `unverbatim`）证明 `program`
/// 位置带 `\\?\` 本身无害（G3 照常启动）。之所以仍然净化，是为了守住「凡从本模块
/// 出去的路径都干净」这一条**单一纪律**：靠「记住哪些位置安全」来省这一步，
/// 迟早会有人把它挪到参数位置而不自知（那才是 G2/G4 的必炸形态）。
pub fn resolve_node(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("NODEAGENT_CONSOLE_NODE") {
        if !p.is_empty() {
            return Ok(unverbatim(PathBuf::from(p)));
        }
    }
    if let Some(dir) = resource_dir {
        let bundled = unverbatim(dir.join(if cfg!(windows) { "node.exe" } else { "node" }));
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
///
/// ⚠️ 出口一律经 `unverbatim` —— **这一条就是 2026-10-13 真机缺陷的修复点**：
/// 打包后 `resource_dir()` 给的是 `\\?\C:\…`，交给 node 当参数会让 node 在启动期
/// `realpathSync` 里炸成 `EISDIR ... lstat 'C:'` 并 exit 1（sidecar 秒退）。
pub fn resolve_sidecar(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("NODEAGENT_CONSOLE_SIDECAR") {
        if !p.is_empty() && Path::new(&p).exists() {
            return Ok(unverbatim(PathBuf::from(p)));
        }
    }
    if let Some(dir) = resource_dir {
        let bundled = unverbatim(dir.join("sidecar.mjs"));
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

    // -----------------------------------------------------------------------
    // 「交给 node 的路径不得带 Windows verbatim 前缀」—— 2026-10-13 真机缺陷
    //
    // 现象（真机）：控制台点「检查更新」，sidecar 被拉起后**存活约 0.5 秒即消失**、
    //   退出码 1，且一行 JS 都没执行（连自带的启动日志都写不出来）；界面报
    //   「sidecar 已退出（stdout 关闭），请重试」（修存活检测之前报「等满 45 秒超时」）。
    // 根因：`resource_dir()` 给的是 verbatim 路径（`\\?\C:\…`），当参数交给 node 后，
    //   node 启动期的 `realpathSync` 把 `\\?\C:` 拆成 `C:` → `EISDIR` → exit 1。
    // 为什么本地/CI 全绿：开发模式走的是仓库相对路径（普通路径），只有打包后才暴露。
    // 因此这里的守卫**必须落在「最终下发给 node 的 program / args」上**，
    // 而不是「源码里有没有调用过某个函数」—— 这样在 macOS / Linux 上也能守住 Windows 分支。
    // -----------------------------------------------------------------------

    #[test]
    fn unverbatim_去掉各类_windows_前缀() {
        // 常见的盘符形态
        assert_eq!(
            unverbatim(PathBuf::from(r"\\?\C:\Users\u\AppData\Local\x\node.exe")),
            PathBuf::from(r"C:\Users\u\AppData\Local\x\node.exe")
        );
        // UNC 形态：\\?\UNC\server\share\x → \\server\share\x
        assert_eq!(
            unverbatim(PathBuf::from(r"\\?\UNC\srv\share\sidecar.mjs")),
            PathBuf::from(r"\\srv\share\sidecar.mjs")
        );
        // 普通路径原样返回（含 POSIX）
        assert_eq!(
            unverbatim(PathBuf::from(r"C:\a\b.mjs")),
            PathBuf::from(r"C:\a\b.mjs")
        );
        assert_eq!(
            unverbatim(PathBuf::from("/Users/x/y.mjs")),
            PathBuf::from("/Users/x/y.mjs")
        );
        // 幂等：净化两次 == 净化一次（spawn 与 sidecar_command 都会调）
        let once = unverbatim(PathBuf::from(r"\\?\C:\a\b.mjs"));
        assert_eq!(unverbatim(once.clone()), once);
    }

    /// 反例守卫：**非 UTF-8 路径必须原样返回，不得被 lossy 重建损坏**。
    ///
    /// ⚠️ 构造必须**同时**含 `\\?\` 前缀与非法字节，否则测不出差异 ——
    /// 不带前缀时新旧实现都会落到「原样返回」那一步（`to_string_lossy` 也安全），
    /// 只有在「剥前缀 → `PathBuf::from(rest)`」这一步才会把 U+FFFD 写进路径。
    /// 若把实现退回 `to_string_lossy()`，本用例立刻变红：那是把「node 报 EISDIR」
    /// 换成「指向一个不存在的路径」，更难排查 —— 宁可原样返回。
    #[cfg(unix)]
    #[test]
    fn unverbatim_对非_utf8_的_verbatim_路径必须原样返回不得损坏() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        // 0xff / 0xfe 永不出现在合法 UTF-8 序列里；前缀形态按 Windows 写法给全
        let raw = OsStr::from_bytes(b"\\\\?\\C:\\na-\xff\xfe-weird.mjs");
        let p = PathBuf::from(raw);
        assert!(p.to_str().is_none(), "构造出来的路径应确实是非 UTF-8");
        assert_eq!(
            unverbatim(p.clone()),
            p,
            "非 UTF-8 路径被改写了（很可能退回了 to_string_lossy）"
        );
    }

    #[test]
    fn unverbatim_对_resource_dir_拼接后的路径同样生效() {
        // 真实形态就是「resource_dir().join("sidecar.mjs")」——前缀在目录上，拼完仍在最前
        let joined = unverbatim(Path::new(r"\\?\C:\app").join("sidecar.mjs"));
        let s = joined.to_string_lossy().into_owned();
        assert!(!s.contains(r"\\?\"), "拼接后仍带 verbatim 前缀：{s}");
        assert!(s.starts_with(r"C:\app"), "应剥成普通路径，实际：{s}");
        assert!(s.ends_with("sidecar.mjs"), "文件名不该被动：{s}");
    }

    #[test]
    fn 交给_node_的路径必须去掉_verbatim_前缀() {
        // 直接断言**最终下发给 node 的文本**（program 与 args），而不是源码长相。
        // 去掉 `sidecar_command` 里的 unverbatim → 本用例立刻变红。
        let cmd = sidecar_command(
            Path::new(r"\\?\C:\Users\u\AppData\Local\nodeagent-console\node.exe"),
            Path::new(r"\\?\C:\Users\u\AppData\Local\nodeagent-console\sidecar.mjs"),
        );
        let std_cmd = cmd.as_std();

        let prog = std_cmd.get_program().to_string_lossy().into_owned();
        assert!(
            !prog.contains(r"\\?\"),
            "program 仍带 verbatim 前缀（示例：{prog}）"
        );
        assert_eq!(
            prog, r"C:\Users\u\AppData\Local\nodeagent-console\node.exe",
            "program 应剥成普通路径"
        );

        let args: Vec<String> = std_cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(
            !args.iter().any(|a| a.contains(r"\\?\")),
            "脚本参数仍带 verbatim 前缀 → node 启动即 EISDIR 退出（真机表现为「sidecar 秒退」）：{args:?}"
        );
        assert_eq!(
            args,
            vec![r"C:\Users\u\AppData\Local\nodeagent-console\sidecar.mjs".to_string()],
            "脚本参数应为唯一一个、且已净化的路径"
        );
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
