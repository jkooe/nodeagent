//! 本机被控端（agent）进程管理器 —— 让控制台能「启动 / 停止 / 重启」本机被控端，
//! 用户全程**不必碰命令行**。
//!
//! ## 关键设计（每条都是踩出来的）
//!
//! 1. **脚本必须在数据目录里跑，不能在 app bundle 里跑。**
//!    macOS 的 `.app` 是签名保护的只读资源 —— 自更新写不进去；且开机自启需要**稳定路径**
//!    （用户挪动 / 重装 / 删除 app 不该带走被控端）。故首次运行时把内置的 `agent.mjs`
//!    **播种**到 `<数据目录>/runtime/agent.mjs`，此后一律跑这一份。
//!
//! 2. **绝不覆盖「已自更新」的副本。**
//!    用 `<数据目录>/runtime/agent.seed.json` 记「播种时的应用版本」；只有**应用版本变了**
//!    才重新播种。否则控制台每次启动都会把被控端（可能已自更新到更新版）**降级**回随包版本 ——
//!    这类「悄悄降级」不会报任何错，只是功能莫名回退。
//!
//! 3. **Windows 必须 `CREATE_NO_WINDOW`。**
//!    否则每次 spawn `node.exe` 都会弹一个黑色控制台窗口。本项目的目标之一正是
//!    「不再打开命令行窗口」，故这一步不可省。
//!
//! 4. **退出监控用轮询 `try_wait`，不把 `Child` 移出去。**
//!    若把 `Child` 交给 `wait()` 的 task，`stop()` 就再也拿不到它去 kill 了。
//!    轮询 800ms 代价可忽略，换来 stop 随时可用。
//!
//! ## 可测试性
//! 本模块**不依赖 Tauri GUI** —— 单测直接拉起真实的 node 子进程，验证
//! 「启动 → 捕获日志 → 停止 → 状态收敛」全链路。

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// 日志环形缓冲上限（行）。够回看一次启动/一次故障，又不至于吃内存。
const LOG_CAP: usize = 4000;

/// 被控端状态机取值（前后端共用字面量）。
pub mod state {
    pub const STOPPED: &str = "stopped";
    pub const STARTING: &str = "starting";
    pub const RUNNING: &str = "running";
    pub const STOPPING: &str = "stopping";
    pub const CRASHED: &str = "crashed";
}

/// 一行日志。
#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    /// 全局单调递增序号（环形缓冲淘汰旧行后仍然递增 —— 前端靠它做增量拉取）
    pub seq: u64,
    /// 毫秒时间戳（UTC）
    pub ts: u64,
    /// `stdout` / `stderr` / `system`（本管理器自己产生的说明行）
    pub stream: String,
    pub line: String,
}

impl LogLine {
    fn new(seq: u64, stream: &str, line: impl Into<String>) -> Self {
        Self {
            seq,
            ts: now_ms(),
            stream: stream.to_string(),
            line: line.into(),
        }
    }
}

/// 管理器向外推送的事件。
#[derive(Debug, Clone)]
pub enum AgentEvent {
    Log(LogLine),
    /// 状态变化（取值见 `state::*`）
    State(String),
}

pub type AgentEmit = Arc<dyn Fn(AgentEvent) + Send + Sync>;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 数据目录：优先 `NODEAGENT_HOME`（跨平台统一），否则 `~/.nodeagent`。
///
/// ⚠️ Windows 认 `USERPROFILE`、不认 `HOME` —— 与被控端 `apps/agent/src/config.ts`
/// 的 `agentDir()` 必须保持一致，否则「控制台显示的数据目录」与「被控端实际用的」
/// 会是两个地方。
pub fn agent_data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("NODEAGENT_HOME") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".nodeagent")
}

/// 被控端入口脚本（数据目录里的那一份）。
pub fn agent_script_path(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime").join("agent.mjs")
}

/// 播种标记文件。
fn seed_marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime").join("agent.seed.json")
}

/// 比较 `x.y.z` 版本号（数值逐段比，不做字符串比 —— 否则 `2.0.10 < 2.0.9`）。
pub fn cmp_version(a: &str, b: &str) -> i32 {
    let pa: Vec<u32> = a.split('.').map(|x| x.parse().unwrap_or(0)).collect();
    let pb: Vec<u32> = b.split('.').map(|x| x.parse().unwrap_or(0)).collect();
    for i in 0..pa.len().max(pb.len()) {
        let d = pa.get(i).copied().unwrap_or(0) as i64 - pb.get(i).copied().unwrap_or(0) as i64;
        if d != 0 {
            return if d > 0 { 1 } else { -1 };
        }
    }
    0
}

/// 读出「数据目录里当前脚本所对应的版本」（无标记则视为 `0.0.0`）。
pub fn installed_agent_version(data_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(seed_marker_path(data_dir)).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("version").and_then(Value::as_str).map(str::to_string)
}

/// 记录「数据目录里当前脚本的版本」。
///
/// 播种与被控端自更新（**含控制台发起的更新**）都要写它 —— 这是防止
/// 「控制台启动时把已更新的被控端降级回随包版本」的唯一依据。
pub fn mark_installed_version(data_dir: &Path, version: &str, source: &str) -> Result<(), String> {
    let marker = seed_marker_path(data_dir);
    if let Some(dir) = marker.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建 runtime 目录失败：{e}"))?;
    }
    std::fs::write(
        &marker,
        format!(
            "{{\n  \"version\": \"{}\",\n  \"source\": \"{}\",\n  \"at\": {}\n}}\n",
            version,
            source,
            now_ms()
        ),
    )
    .map_err(|e| format!("写入播种标记失败：{e}"))
}

/// 定位随包（或开发期）的内置 `agent.mjs`。
///
/// 优先级：环境变量 `NODEAGENT_CONSOLE_AGENT` → 随包 resource 的 `agent.mjs` →
/// 开发期的 `apps/agent/dist/index.js`。
///
/// ⚠️ 出口一律经 `sidecar::unverbatim`：`resource_dir()` 在 Windows 上给的是
/// verbatim 路径（`\\?\C:\…`）。本函数的结果最终会**交给 node**（播种后作为脚本路径），
/// 带 `\\?\` 的路径会让 node **启动即 EISDIR 秒退** —— 这正是 2026-10-13
/// 「sidecar 秒退」真机缺陷的同类风险，必须在源头堵掉。
pub fn resolve_bundled_agent(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("NODEAGENT_CONSOLE_AGENT") {
        if !p.is_empty() && Path::new(&p).exists() {
            return Ok(crate::sidecar::unverbatim(PathBuf::from(p)));
        }
    }
    if let Some(dir) = resource_dir {
        let bundled = crate::sidecar::unverbatim(dir.join("agent.mjs"));
        if bundled.exists() {
            return Ok(bundled);
        }
    }
    // 开发期：src-tauri → apps/agent/dist/index.js
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../agent/dist/index.js");
    if dev.exists() {
        return Ok(dev);
    }
    Err("找不到内置 agent.mjs（先跑 `pnpm -r build`，或用 NODEAGENT_CONSOLE_AGENT 指定）".to_string())
}

/// 把内置被控端**播种**到数据目录。
///
/// **只在「数据目录里的脚本版本 < 随包版本」时才覆盖** —— 这条规则防的是两类静默故障：
/// - 控制台每次启动都覆盖 → 把**已自更新**的被控端**降级**回随包版本（功能莫名回退，不报错）；
/// - 应用被降级安装后，反过来把更新的被控端覆盖掉。
///
/// 返回实际使用的脚本路径。
pub fn seed_agent_script(
    bundled: &Path,
    data_dir: &Path,
    app_version: &str,
) -> Result<PathBuf, String> {
    let target = agent_script_path(data_dir);

    if target.exists() {
        let installed = installed_agent_version(data_dir).unwrap_or_else(|| "0.0.0".to_string());
        if cmp_version(app_version, &installed) <= 0 {
            // 数据目录里的版本不低于随包版本（可能是自更新来的）→ 不动它
            return Ok(target);
        }
    }

    std::fs::create_dir_all(target.parent().unwrap_or(data_dir))
        .map_err(|e| format!("创建 runtime 目录失败：{e}"))?;
    std::fs::copy(bundled, &target).map_err(|e| {
        format!(
            "播种被控端脚本失败（{} → {}）：{e}",
            bundled.display(),
            target.display()
        )
    })?;
    // 保留可执行位（POSIX；Windows 无此概念）
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }
    mark_installed_version(data_dir, app_version, "bundled")?;
    Ok(target)
}

/// TCP 探测端口是否已被监听（判断「是否已有实例在跑」）。
///
/// 只做一次 TCP 连接，不跑协议 —— 快、无副作用，足够回答「这个端口有没有人在听」。
pub fn port_in_use(port: u16) -> bool {
    use std::net::{SocketAddr, TcpStream};
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// 读被控端配置（`<数据目录>/agent.json`）里与控制台有关的部分。
///
/// 只读、不创建 —— 配置由被控端自己在首次启动时生成（含随机密钥）。
pub fn read_agent_config(data_dir: &Path) -> Value {
    let p = data_dir.join("agent.json");
    let (node_id, port, key, auth_mode, tls, exists) = match std::fs::read_to_string(&p) {
        Ok(text) => {
            // 剥离 BOM：Windows 上由 PowerShell 写出的 JSON 可能带 BOM
            let parsed: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap_or(json!({}));
            (
                parsed.get("node_id").and_then(Value::as_str).unwrap_or("").to_string(),
                parsed.get("port").and_then(Value::as_u64).unwrap_or(8765),
                parsed.get("key").and_then(Value::as_str).unwrap_or("").to_string(),
                parsed.get("auth_mode").and_then(Value::as_str).unwrap_or("psk").to_string(),
                parsed.get("tls").and_then(Value::as_bool).unwrap_or(true),
                true,
            )
        }
        Err(_) => (String::new(), 8765, String::new(), "psk".to_string(), true, false),
    };
    json!({
        "data_dir": data_dir.to_string_lossy(),
        "config_path": p.to_string_lossy(),
        "config_exists": exists,
        "node_id": node_id,
        "port": port,
        "tls": tls,
        "auth_mode": auth_mode,
        // 密钥回传给本机 UI 属预期（用户要用它连接自己的机器）；
        // 它本来就在用户本机的 600 文件里，不构成额外暴露面。
        "key": key,
        "port_in_use": port_in_use(port as u16),
        "url": format!("ws://127.0.0.1:{port}"),
    })
}

struct Inner {
    state: String,
    child: Option<Child>,
    pid: Option<u32>,
    started_at: Option<u64>,
    restarts: u32,
    last_exit: Option<String>,
}

/// 本机被控端管理器。
pub struct AgentManager {
    inner: tokio::sync::Mutex<Inner>,
    /// 环形日志缓冲。用 `Arc<Mutex<..>>` 是为了让日志泵任务能**同时**入缓冲与推事件，
    /// 而不必持有整个管理器（否则自引用，Arc 循环）。
    logs: Arc<Mutex<VecDeque<LogLine>>>,
    seq: Arc<AtomicU64>,
    emit: AgentEmit,
    /// 脚本与 node 路径（start 时注入，便于 status 展示）
    paths: Mutex<Option<(PathBuf, PathBuf, PathBuf)>>, // (node, script, data_dir)
}

impl AgentManager {
    pub fn new(emit: AgentEmit) -> Arc<Self> {
        Arc::new(Self {
            inner: tokio::sync::Mutex::new(Inner {
                state: state::STOPPED.to_string(),
                child: None,
                pid: None,
                started_at: None,
                restarts: 0,
                last_exit: None,
            }),
            logs: Arc::new(Mutex::new(VecDeque::with_capacity(LOG_CAP))),
            seq: Arc::new(AtomicU64::new(1)),
            emit,
            paths: Mutex::new(None),
        })
    }

    /// 追加一行日志：入环形缓冲 + 推事件。
    pub fn push_log(&self, stream: &str, text: impl Into<String>) {
        let entry = LogLine::new(self.next_seq(), stream, text);
        {
            let mut logs = self.logs.lock().unwrap();
            if logs.len() >= LOG_CAP {
                logs.pop_front();
            }
            logs.push_back(entry.clone());
        }
        (self.emit)(AgentEvent::Log(entry));
    }

    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst)
    }

    async fn set_state(&self, s: &str) {
        {
            let mut inner = self.inner.lock().await;
            if inner.state == s {
                return;
            }
            inner.state = s.to_string();
        }
        (self.emit)(AgentEvent::State(s.to_string()));
    }

    /// 当前状态快照（不探测端口，纯读内存 + 已记录的路径）。
    pub async fn snapshot(&self) -> Value {
        let inner = self.inner.lock().await;
        let paths = self.paths.lock().unwrap().clone();
        let (node, script, data_dir) = match paths {
            Some((n, s, d)) => (
                n.to_string_lossy().to_string(),
                s.to_string_lossy().to_string(),
                d.to_string_lossy().to_string(),
            ),
            None => (String::new(), String::new(), agent_data_dir().to_string_lossy().to_string()),
        };
        json!({
            "state": inner.state,
            "pid": inner.pid,
            "started_at": inner.started_at,
            "uptime_ms": inner.started_at.map(|t| now_ms().saturating_sub(t)),
            "restarts": inner.restarts,
            "last_exit": inner.last_exit,
            "node": node,
            "script": script,
            "data_dir": data_dir,
        })
    }

    /// 取日志（`since` 为上次拿到的最大 `seq`，0 表示取全部缓冲）。
    pub fn logs_since(&self, since: u64) -> Value {
        let logs = self.logs.lock().unwrap();
        let total = self.seq.load(Ordering::SeqCst).saturating_sub(1);
        let lines: Vec<Value> = logs
            .iter()
            .filter(|l| l.seq > since)
            .map(|l| json!({ "seq": l.seq, "ts": l.ts, "stream": l.stream, "line": l.line }))
            .collect();
        json!({ "lines": lines, "total": total })
    }

    pub fn clear_logs(&self) {
        self.logs.lock().unwrap().clear();
    }

    /// 启动被控端。
    ///
    /// 接收者写成 `self: &Arc<Self>`（而非 `&self`）是**必需**的：启动后要挂一个
    /// **自持引用**的监控任务（崩溃自动重启要能再次调用 `start`），而 `&self` 拿不到 `Arc`。
    ///
    /// `auto_restart`：进程意外退出时是否自动拉起（「后台运行」的语义要求）。
    pub async fn start(
        self: &Arc<Self>,
        node: &Path,
        script: &Path,
        data_dir: &Path,
        auto_restart: bool,
    ) -> Result<Value, String> {
        {
            let inner = self.inner.lock().await;
            if inner.child.is_some() {
                return Err("被控端已在运行".to_string());
            }
        }

        // 端口占用检查：既有的（非本控制台托管的）实例在跑时，给出可执行的说明，
        // 而不是让用户看到一个 `EADDRINUSE` 堆栈。
        //
        // ⚠️ 这里是症状 B（「应用端无法启动」）的**现场**：真机上曾有陈旧计划任务拉起的
        //    被控端占着 8765，控制台自己的被控端起不来。端口检查本身是对的，
        //    但只给一句「已被占用」用户无从下手 —— 故补上「怎么找出占用者」。
        let cfg = read_agent_config(data_dir);
        let port = cfg.get("port").and_then(Value::as_u64).unwrap_or(8765) as u16;
        if port_in_use(port) {
            let hint = if cfg!(windows) {
                format!(
                    "netstat -ano | findstr :{port}  找到 PID，再 tasklist /FI \"PID eq <PID>\" 看是谁"
                )
            } else {
                format!("lsof -nP -iTCP:{port} -sTCP:LISTEN")
            };
            return Err(format!(
                "端口 {port} 已被占用 —— 已有另一个被控端在监听（手工安装的、计划任务拉起的，\
                 或另一个控制台实例）。\n\
                 排查占用者：{hint}\n\
                 处理：先停掉它；或把 {} 里的 port 改成别的端口后重启本机服务。",
                data_dir.join("agent.json").display()
            ));
        }

        *self.paths.lock().unwrap() = Some((node.to_path_buf(), script.to_path_buf(), data_dir.to_path_buf()));
        self.set_state(state::STARTING).await;
        self.push_log(
            "system",
            format!(
                "启动被控端：{} {}（数据目录 {}）",
                node.display(),
                script.display(),
                data_dir.display()
            ),
        );

        // 进程边界：交给 node 的三条路径都先去掉 verbatim 前缀。
        // 被控端的脚本路径来自数据目录（本来就是普通路径），但 node 路径来自
        // `resource_dir()`（Windows 上是 `\\?\C:\…`）—— 与 2026-10-13「sidecar 秒退」
        // 同一类风险，故在此统一兜住，不依赖上游是否记得净化。
        let node = crate::sidecar::unverbatim(node.to_path_buf());
        let script = crate::sidecar::unverbatim(script.to_path_buf());
        let data_dir = crate::sidecar::unverbatim(data_dir.to_path_buf());

        let mut cmd = Command::new(&node);
        cmd.arg(&script)
            .current_dir(&data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false); // 由本管理器显式管理生命周期，不留孤儿也不误杀

        // 让被控端与控制台用**同一个**数据目录（不设则各按各自规则解析）
        cmd.env("NODEAGENT_HOME", &data_dir);

        // ⚠️ 消灭黑窗：Windows 上不加这个标志，每 spawn 一次 node 就弹一个控制台窗口
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动被控端失败（{}）：{e}", node.display()))?;

        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        {
            let mut inner = self.inner.lock().await;
            inner.child = Some(child);
            inner.pid = pid;
            inner.started_at = Some(now_ms());
        }
        self.set_state(state::RUNNING).await;

        // 日志泵：既入环形缓冲（供前端「拉取历史」），也推事件（供前端「实时滚动」）
        if let Some(out) = stdout {
            spawn_line_pump(out, "stdout", Arc::clone(&self.emit), Arc::clone(&self.logs), Arc::clone(&self.seq));
        }
        if let Some(err) = stderr {
            spawn_line_pump(err, "stderr", Arc::clone(&self.emit), Arc::clone(&self.logs), Arc::clone(&self.seq));
        }

        // 退出监控 + 自动重启
        AgentManager::spawn_monitor(
            self,
            node.to_path_buf(),
            script.to_path_buf(),
            data_dir.to_path_buf(),
            auto_restart,
        );

        Ok(json!({ "pid": pid, "state": state::RUNNING }))
    }

    /// 停止被控端（幂等）。
    pub async fn stop(&self) -> Result<Value, String> {
        self.set_state(state::STOPPING).await;
        let child = {
            let mut inner = self.inner.lock().await;
            inner.child.take()
        };
        let Some(mut child) = child else {
            self.set_state(state::STOPPED).await;
            return Ok(json!({ "state": state::STOPPED, "note": "本来就未运行" }));
        };
        let pid = child.id();
        self.push_log("system", format!("停止被控端（pid {}）…", pid.map(|p| p.to_string()).unwrap_or_else(|| "?".into())));

        // Windows：用 taskkill /T 连子进程树一起收；POSIX：直接 kill 本进程。
        let killed = if cfg!(windows) {
            match pid {
                Some(p) => {
                    let out = Command::new("taskkill")
                        .args(["/PID", &p.to_string(), "/T", "/F"])
                        .output()
                        .await;
                    match out {
                        Ok(o) => o.status.success(),
                        Err(_) => child.kill().await.is_ok(),
                    }
                }
                None => child.kill().await.is_ok(),
            }
        } else {
            child.kill().await.is_ok()
        };

        let _ = child.wait().await;
        {
            let mut inner = self.inner.lock().await;
            inner.pid = None;
            inner.started_at = None;
            inner.last_exit = Some(if killed { "stopped by console".into() } else { "stop failed".into() });
        }
        self.set_state(state::STOPPED).await;
        self.push_log("system", "被控端已停止");

        // 端口释放确认（如被控端刚触发了「受控重启」，可能留下继承者）
        let data_dir = self
            .paths
            .lock()
            .unwrap()
            .as_ref()
            .map(|(_, _, d)| d.clone())
            .unwrap_or_else(agent_data_dir);
        let port = read_agent_config(&data_dir).get("port").and_then(Value::as_u64).unwrap_or(8765) as u16;
        for _ in 0..12 {
            if !port_in_use(port) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        let still = port_in_use(port);
        if still {
            self.push_log(
                "system",
                format!("⚠️ 端口 {port} 仍未释放 —— 可能存在继承进程（如受控重启产生的后继），请检查"),
            );
        }
        Ok(json!({ "state": state::STOPPED, "port_released": !still }))
    }

    /// 重启 = 停止 + 启动。
    pub async fn restart(
        self: &Arc<Self>,
        node: &Path,
        script: &Path,
        data_dir: &Path,
        auto_restart: bool,
    ) -> Result<Value, String> {
        self.push_log("system", "重启被控端…");
        let _ = self.stop().await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        self.start(node, script, data_dir, auto_restart).await
    }

    /// 退出监控：轮询 `try_wait`（**不把 Child 移出去**，否则 stop() 就杀不到它了）。
    fn spawn_monitor(
        me: &Arc<Self>,
        node: PathBuf,
        script: PathBuf,
        data_dir: PathBuf,
        auto_restart: bool,
    ) {
        let me = Arc::clone(me);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(800)).await;
                let mut inner = me.inner.lock().await;
                let Some(child) = inner.child.as_mut() else {
                    return; // 已被 stop() 取走 → 结束监控
                };
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let code = status.code();
                        inner.child = None;
                        inner.pid = None;
                        inner.started_at = None;
                        inner.last_exit = Some(format!("exit code {:?}", code));
                        drop(inner);

                        me.push_log("system", format!("被控端已退出（exit code {:?}）", code));
                        me.set_state(state::CRASHED).await;

                        if !auto_restart {
                            return;
                        }
                        // 自动重启：退避 2s，超 5 次则放弃并留在 crashed（避免无限重启风暴）
                        let n = {
                            let mut inner = me.inner.lock().await;
                            inner.restarts += 1;
                            inner.restarts
                        };
                        if n > 5 {
                            me.push_log("system", "自动重启已达上限（5 次），停止拉起。请查看上方日志定位原因。");
                            return;
                        }
                        me.push_log("system", format!("将在 2 秒后自动重启（第 {n} 次）…"));
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        let _ = me.stop().await;
                        if let Err(e) = me.start(&node, &script, &data_dir, true).await {
                            me.push_log("system", format!("自动重启失败：{e}"));
                            me.set_state(state::CRASHED).await;
                            return;
                        }
                        // start() 已重新挂上监控，本任务结束
                        return;
                    }
                    Ok(None) => { /* 仍在运行 */ }
                    Err(e) => {
                        me.push_log("system", format!("监控被控端失败：{e}"));
                        return;
                    }
                }
            }
        });
    }
}

/// 逐行读一个管道：入环形缓冲 + 推日志事件。
fn spawn_line_pump<R>(
    reader: R,
    stream: &'static str,
    emit: AgentEmit,
    logs: Arc<Mutex<VecDeque<LogLine>>>,
    seq: Arc<AtomicU64>,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(text)) = lines.next_line().await {
            let entry = LogLine::new(seq.fetch_add(1, Ordering::SeqCst), stream, text);
            {
                let mut buf = logs.lock().unwrap();
                if buf.len() >= LOG_CAP {
                    buf.pop_front();
                }
                buf.push_back(entry.clone());
            }
            emit(AgentEvent::Log(entry));
        }
    });
}

// ---------------------------------------------------------------------------
// 单测：真跑 node 子进程
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn node_bin() -> PathBuf {
        crate::sidecar::resolve_node(None).expect("需要 node 才能跑被控端管理单测")
    }

    /// 造一个「打印两行、然后常驻」的假被控端。
    fn fake_agent(dir: &Path) -> PathBuf {
        let p = dir.join("fake-agent.mjs");
        std::fs::write(
            &p,
            "console.log('READY-LINE');\nconsole.error('ERR-LINE');\nsetInterval(()=>{}, 1000);\n",
        )
        .unwrap();
        p
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("na-agent-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn 启动应捕获日志且状态为running() {
        let dir = tmp_dir("start");
        let script = fake_agent(&dir);
        let m = AgentManager::new(Arc::new(|_| {}));

        m.start(&node_bin(), &script, &dir, false).await.expect("应能启动");
        assert_eq!(m.snapshot().await["state"], json!(state::RUNNING));

        // 等日志泵读到两行
        let mut collected = String::new();
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let logs = m.logs_since(0);
            collected = logs["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l["line"].as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>()
                .join("\n");
            if collected.contains("READY-LINE") && collected.contains("ERR-LINE") {
                break;
            }
        }
        assert!(collected.contains("READY-LINE"), "应捕获 stdout，实际：{collected}");
        assert!(collected.contains("ERR-LINE"), "应捕获 stderr，实际：{collected}");

        let r = m.stop().await.expect("应能停止");
        assert_eq!(r["state"], json!(state::STOPPED));
        assert_eq!(m.snapshot().await["state"], json!(state::STOPPED));
    }

    #[tokio::test]
    async fn 停止后应可再次启动() {
        let dir = tmp_dir("restart");
        let script = fake_agent(&dir);
        let m = AgentManager::new(Arc::new(|_| {}));

        m.start(&node_bin(), &script, &dir, false).await.unwrap();
        m.stop().await.unwrap();
        m.start(&node_bin(), &script, &dir, false).await.expect("停止后应能重新启动");
        assert_eq!(m.snapshot().await["state"], json!(state::RUNNING));
        m.stop().await.unwrap();
    }

    #[tokio::test]
    async fn 重复启动应被拒绝而不是起两个进程() {
        let dir = tmp_dir("dup");
        let script = fake_agent(&dir);
        let m = AgentManager::new(Arc::new(|_| {}));

        m.start(&node_bin(), &script, &dir, false).await.unwrap();
        let err = m.start(&node_bin(), &script, &dir, false).await;
        assert!(err.is_err(), "已在运行时再次启动应被拒绝");
        assert!(err.unwrap_err().contains("已在运行"), "错误信息应说明原因");
        m.stop().await.unwrap();
    }

    #[tokio::test]
    async fn 端口被外部占用时应给出可执行的错误说明() {
        let dir = tmp_dir("port-busy");
        let script = fake_agent(&dir);
        // 占住一个空闲端口，扮演「手工安装的 / 计划任务拉起的另一个被控端」
        // （真机症状 B：陈旧计划任务 na-gui 占着 8765，控制台自己的被控端起不来）
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("应能绑一个空闲端口");
        let port = listener.local_addr().unwrap().port();
        std::fs::write(
            dir.join("agent.json"),
            format!("{{\"node_id\":\"t\",\"port\":{port},\"key\":\"k\",\"tls\":true}}"),
        )
        .unwrap();

        let m = AgentManager::new(Arc::new(|_| {}));
        let err = m
            .start(&node_bin(), &script, &dir, false)
            .await
            .expect_err("端口被占时应拒绝启动");
        assert!(err.contains("已被占用"), "应说明端口被占用，实际：{err}");
        assert!(err.contains(&port.to_string()), "错误里应带上具体端口号，实际：{err}");
        // 关键：必须给出「怎么找出占用者」的可执行线索，否则用户无从下手
        assert!(
            err.contains("lsof") || err.contains("netstat"),
            "应给出排查占用者的命令，实际：{err}"
        );
        // 端口检查失败不该改动状态、更不该留下进程
        assert_eq!(m.snapshot().await["state"], json!(state::STOPPED));
        drop(listener);
    }

    #[tokio::test]
    async fn 进程意外退出应转为crashed() {
        let dir = tmp_dir("crash");
        let p = dir.join("crash-agent.mjs");
        std::fs::write(&p, "console.log('BYE');\nprocess.exit(3);\n").unwrap();
        let m = AgentManager::new(Arc::new(|_| {}));

        m.start(&node_bin(), &p, &dir, false).await.unwrap();
        let mut seen = String::new();
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            seen = m.snapshot().await["state"].as_str().unwrap_or("").to_string();
            if seen == state::CRASHED {
                break;
            }
        }
        assert_eq!(seen, state::CRASHED, "进程退出后状态应为 crashed");
        assert!(
            m.snapshot().await["last_exit"].as_str().unwrap_or("").contains("3"),
            "应记录退出码"
        );
    }

    #[test]
    fn 播种应只在应用版本变化时覆盖() {
        let dir = tmp_dir("seed");
        let bundled = dir.join("bundled.mjs");
        std::fs::write(&bundled, "// v1\n").unwrap();
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();

        let t = seed_agent_script(&bundled, &data, "2.0.0").unwrap();
        assert!(t.exists());
        assert_eq!(std::fs::read_to_string(&t).unwrap(), "// v1\n");

        // 模拟「被控端自更新」改了副本
        std::fs::write(&t, "// self-updated v9\n").unwrap();
        // 同版本再播种 → 不应覆盖
        seed_agent_script(&bundled, &data, "2.0.0").unwrap();
        assert_eq!(
            std::fs::read_to_string(&t).unwrap(),
            "// self-updated v9\n",
            "同版本播种不得覆盖已自更新的副本（否则是静默降级）"
        );

        // 应用升级 → 应重新播种
        std::fs::write(&bundled, "// v2\n").unwrap();
        seed_agent_script(&bundled, &data, "2.1.0").unwrap();
        assert_eq!(std::fs::read_to_string(&t).unwrap(), "// v2\n", "应用版本变化后应重新播种");
    }

    #[test]
    fn 播种不得把更新过的被控端降级() {
        let dir = tmp_dir("seed-down");
        let bundled = dir.join("bundled.mjs");
        std::fs::write(&bundled, "// bundled 2.0.3\n").unwrap();
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();

        // 模拟：被控端已通过控制台更新到 2.1.0
        std::fs::create_dir_all(data.join("runtime")).unwrap();
        std::fs::write(agent_script_path(&data), "// console-updated 2.1.0\n").unwrap();
        mark_installed_version(&data, "2.1.0", "console").unwrap();

        seed_agent_script(&bundled, &data, "2.0.3").unwrap();
        assert_eq!(
            std::fs::read_to_string(agent_script_path(&data)).unwrap(),
            "// console-updated 2.1.0\n",
            "随包版本更低时**不得**覆盖数据目录里更新的被控端（那是静默降级）"
        );
    }

    #[test]
    fn 版本比较应按数值而非字符串() {
        assert_eq!(cmp_version("2.0.10", "2.0.9"), 1, "2.0.10 应大于 2.0.9");
        assert_eq!(cmp_version("2.0.2", "2.0.2"), 0);
        assert_eq!(cmp_version("2.1.0", "2.0.99"), 1);
        assert_eq!(cmp_version("2.0", "2.0.1"), -1, "缺段按 0 处理");
    }
}
