//! nodeagent 桌面控制台（主控 + 被控一体）——Tauri 后端。
//!
//! ## 结构（2026-10 起：sidecar 方案）
//! 本层只做**进程管理 + 消息转发**，真正的协议实现只有 TS 一份（`@nodeagent/client`），
//! 由 `sidecar.rs` 拉起的 Node 进程承载。原先「Rust 版 client 与 TS 版并存」的漂移风险就此消除。
//!
//! `agent.rs` 是同一思路的延伸：本机**被控端**也由本层托管（启动 / 停止 / 重启 / 日志 /
//! 崩溃自愈），用户在界面上点按钮即可，全程不必碰命令行。
//!
//! ## command 面
//! 连接类（签名与语义从未变过）：
//! - `connect` / `disconnect` / `invoke_capability` / `get_capabilities` / `get_state`
//!
//! 本机服务类（2026-10-11 新增）：
//! - `agent_status` / `agent_start` / `agent_stop` / `agent_restart`
//! - `agent_logs` / `agent_logs_clear`
//! - `autostart_status` / `autostart_set`
//! - `check_update` / `apply_update`
//! - `settings_get` / `settings_set` / `system_info`
//!
//! ## 事件面
//! - 连接：`na-state` / `na-log` / `na-event`
//! - 本机服务：`na-agent-state` / `na-agent-log`
//!
//! ## 启动模式
//! - 默认：显示主窗口
//! - `--agent-only`：**不显示窗口**，直接进托盘并托管本机被控端（开机自启用它，
//!   这样登录自启也不会有任何窗口弹出来）
//!
//! ## 单实例（v2.0.3）
//! 见下方「单实例」一节 —— 真机缺陷：无保护时同机会跑起两个被控端。

mod agent;
mod autostart;
mod settings;
mod sidecar;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};

use agent::{AgentEvent, AgentManager};
use sidecar::{Sidecar, SidecarEvent};

/// 全局状态。
///
/// `connect` 成功后缓存「能力清单 / 版本 / 连接态」——这样 `get_capabilities`、
/// `get_state` 能保持**同步**（无需每次往返 sidecar），签名与改造前一致。
struct AppState {
    sidecar: tokio::sync::Mutex<Option<Arc<Sidecar>>>,
    capabilities: Mutex<Value>,
    agent_version: Mutex<Option<String>>,
    conn_state: Mutex<String>,
    /// 本机被控端管理器（在 `setup` 里建，因为需要 AppHandle 来桥接事件）
    agent: Mutex<Option<Arc<AgentManager>>>,
    settings: Mutex<settings::Settings>,
    /// 控制台自身配置目录（设置存这里）
    config_dir: PathBuf,
    /// 控制台版本（由 `package_info` 注入，用于更新比对；不在代码里写死）
    app_version: String,
}

impl AppState {
    fn agent(&self) -> Result<Arc<AgentManager>, String> {
        self.agent
            .lock()
            .unwrap()
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| "被控端管理器尚未初始化".to_string())
    }

    fn settings(&self) -> settings::Settings {
        self.settings.lock().unwrap().clone()
    }
}

/// 连接成功后回传给前端的元信息（字段名与改造前一致）。
#[derive(serde::Serialize)]
struct ConnectInfo {
    capabilities: Value,
    agent_version: Option<String>,
    authorized: Option<Value>,
    peer_cert_fp: Option<String>,
    auth_mode: String,
    client_id: String,
}

/// 本机被控端的三条路径。
struct AgentPaths {
    node: PathBuf,
    script: PathBuf,
    data_dir: PathBuf,
}

/// 解析（并在需要时播种）本机被控端所需路径。
fn resolve_agent_paths(app: &AppHandle, state: &AppState) -> Result<AgentPaths, String> {
    let resource_dir = app.path().resource_dir().ok();
    let node = sidecar::resolve_node(resource_dir.as_deref())?;
    let bundled = agent::resolve_bundled_agent(resource_dir.as_deref())?;
    let data_dir = agent::agent_data_dir();
    let script = agent::seed_agent_script(&bundled, &data_dir, &state.app_version)?;
    Ok(AgentPaths { node, script, data_dir })
}

/// 懒启动 sidecar（首次调用时拉起，之后复用同一进程）。
async fn ensure_sidecar(app: &AppHandle, state: &AppState) -> Result<Arc<Sidecar>, String> {
    let mut guard = state.sidecar.lock().await;
    if let Some(sc) = guard.as_ref() {
        if sc.is_alive() {
            return Ok(Arc::clone(sc));
        }
        // ⚠️ 缓存里那个 sidecar **已经退出**，绝不能继续复用。
        //
        // 为什么以前没发现：往已退出进程的管道里写，在 Windows 上未必立刻报错
        // （管道缓冲区吞下就返回成功），于是请求会一路干等到 `request` 的超时。
        // 真机实证（2026-10-13，Windows 11 ARM64）：控制台从 10-12 起一直开着，
        // 其 sidecar 早已退出；用户点「检查更新」等满 45 秒，界面报
        // 「检查更新失败：check_update 超时」—— 而同一台机器上**手工拉起 sidecar
        // 跑同一个请求只要 7 秒**（两相对照即锁定「复用死实例」）。
        // 丢掉缓存往下走，重新拉起一个。
        eprintln!("[sidecar] 检测到已退出的实例，正在重建");
        *guard = None;
    }

    // 打包后 node 与 sidecar.mjs 随 resource 分发；开发期用系统 node + 仓库内脚本
    let resource_dir = app.path().resource_dir().ok();
    let node = sidecar::resolve_node(resource_dir.as_deref())?;
    let script = sidecar::resolve_sidecar(resource_dir.as_deref())?;

    // 事件桥接：sidecar 通知 → Tauri event（名字与改造前一致）
    let app_events = app.clone();
    let on_event = Arc::new(move |evt: SidecarEvent| match evt {
        SidecarEvent::State(s) => {
            let _ = app_events.emit("na-state", s);
        }
        SidecarEvent::Log(msg) => {
            let _ = app_events.emit("na-log", msg);
        }
        SidecarEvent::Event(params) => {
            let _ = app_events.emit("na-event", params);
        }
        SidecarEvent::Other(raw) => {
            let _ = app_events.emit("na-log", format!("[sidecar] 未知通知: {raw}"));
        }
    });

    let sc = Sidecar::spawn(&node, &script, on_event)?;
    *state.conn_state.lock().unwrap() = "未连接".to_string();
    *guard = Some(Arc::clone(&sc));
    Ok(sc)
}

// ---------------------------------------------------------------------------
// 连接类 command（签名与语义保持不变）
// ---------------------------------------------------------------------------

/// 建立到被控端的连接并完成握手（默认 psk 模式、接受自签证书、开启自动重连）。
#[tauri::command]
async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    key: String,
    client_id: Option<String>,
    insecure: Option<bool>,
) -> Result<ConnectInfo, String> {
    let sc = ensure_sidecar(&app, &state).await?;
    let client_id = client_id.unwrap_or_else(|| "console".to_string());

    let snap = sc
        .request(
            "connect",
            json!({
                "url": url,
                "key": key,
                "client_id": client_id,
                "insecure": insecure.unwrap_or(true),
            }),
            30,
        )
        .await?;

    let caps = snap.get("capabilities").cloned().unwrap_or_else(|| json!([]));
    let ver = snap.get("agent_version").and_then(Value::as_str).map(str::to_string);
    *state.capabilities.lock().unwrap() = caps.clone();
    *state.agent_version.lock().unwrap() = ver.clone();
    *state.conn_state.lock().unwrap() = "connected".to_string();

    Ok(ConnectInfo {
        capabilities: caps,
        agent_version: ver,
        authorized: snap.get("authorized").cloned(),
        peer_cert_fp: snap.get("peer_cert_fp").and_then(Value::as_str).map(str::to_string),
        auth_mode: snap
            .get("auth_mode")
            .and_then(Value::as_str)
            .unwrap_or("psk")
            .to_string(),
        client_id,
    })
}

/// 断开连接（停止自动重连）。
#[tauri::command]
async fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let sc = { state.sidecar.lock().await.as_ref().map(Arc::clone) };
    if let Some(sc) = sc {
        sc.request("disconnect", json!({}), 10).await?;
    }
    *state.conn_state.lock().unwrap() = "未连接".to_string();
    *state.capabilities.lock().unwrap() = json!([]);
    Ok(())
}

/// 调用一项被控端能力。`timeout_ms` 可选：长任务（装软件 / 长命令）需显式放大。
#[tauri::command]
async fn invoke_capability(
    state: State<'_, AppState>,
    capability: String,
    args: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let sc = {
        state
            .sidecar
            .lock()
            .await
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| "未连接".to_string())?
    };
    let mut params = json!({ "capability": capability, "args": args.unwrap_or_else(|| json!({})) });
    if let Some(ms) = timeout_ms.filter(|m| *m > 0) {
        params["timeout_ms"] = json!(ms);
    }
    // sidecar 侧已把「未知能力 / ACL 拒绝 / 超时」归一成 {status:"failed",error:{...}}，
    // 故这里拿到的是稳定的 InvokeResult 形态（前端只需判 status）。
    sc.request("invoke", params, timeout_ms.map(|m| (m / 1000) + 10).unwrap_or(70)).await
}

/// 当前连接的能力清单（读缓存，保持同步签名）。
#[tauri::command]
fn get_capabilities(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(state.capabilities.lock().unwrap().clone())
}

/// 当前连接状态字符串（connected / reconnecting / closed / 未连接）。
#[tauri::command]
fn get_state(state: State<'_, AppState>) -> String {
    state.conn_state.lock().unwrap().clone()
}

// ---------------------------------------------------------------------------
// 本机服务（被控端）command
// ---------------------------------------------------------------------------

/// 本机服务总览：进程状态 + 配置 + 自启 + 设置 + 版本。
#[tauri::command]
async fn agent_status(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    // 管理器可能尚未建（极早的调用）；此时给一个纯配置视图，而不是报错
    let mgr = state.agent.lock().unwrap().clone();
    let snap = match &mgr {
        Some(m) => m.snapshot().await,
        None => json!({ "state": agent::state::STOPPED }),
    };

    // 数据目录以「实际使用的」为准；管理器还没跑过就用默认值
    let data_dir = snap
        .get("data_dir")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(agent::agent_data_dir);
    let cfg = agent::read_agent_config(&data_dir);

    let resource_dir = app.path().resource_dir().ok();
    Ok(json!({
        "manager": snap,
        "config": cfg,
        "autostart": autostart::status(),
        "settings": settings::to_json(&state.settings()),
        "app_version": state.app_version,
        "config_dir": state.config_dir.to_string_lossy(),
        "installed_agent_version": agent::installed_agent_version(&data_dir),
        "bundled_agent": agent::resolve_bundled_agent(resource_dir.as_deref())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    }))
}

/// 启动本机被控端。`auto_restart` 缺省时取设置里的值。
#[tauri::command]
async fn agent_start(
    app: AppHandle,
    state: State<'_, AppState>,
    auto_restart: Option<bool>,
) -> Result<Value, String> {
    let paths = resolve_agent_paths(&app, &state)?;
    let ar = auto_restart.unwrap_or_else(|| state.settings().auto_restart);
    state
        .agent()?
        .start(&paths.node, &paths.script, &paths.data_dir, ar)
        .await
}

/// 停止本机被控端（幂等）。
#[tauri::command]
async fn agent_stop(state: State<'_, AppState>) -> Result<Value, String> {
    state.agent()?.stop().await
}

/// 退出控制台 —— 由前端在用户确认后调用。
///
/// `keep_agent`：
///  - `true`  保留被控端继续运行（它将成为孤儿进程；下次启动会被「复用」逻辑接管）
///  - `false` 先停掉被控端再退出（退出后不留任何后台进程）
///
/// 为什么不直接在托盘菜单里 exit：退出是有**副作用**的决定（留不留下一个
/// 正在监听端口的后台进程），必须让用户明确选择，而不是替用户猜。
#[tauri::command]
async fn quit_app(app: AppHandle, state: State<'_, AppState>, keep_agent: bool) -> Result<(), String> {
    if !keep_agent {
        // 尽力而为：停不掉也要让用户能退出，否则控制台会卡在确认框后面出不来
        if let Ok(mgr) = state.agent() {
            let _ = mgr.stop().await;
        }
    }
    app.exit(0);
    Ok(())
}

/// 重启本机被控端。
#[tauri::command]
async fn agent_restart(
    app: AppHandle,
    state: State<'_, AppState>,
    auto_restart: Option<bool>,
) -> Result<Value, String> {
    let paths = resolve_agent_paths(&app, &state)?;
    let ar = auto_restart.unwrap_or_else(|| state.settings().auto_restart);
    state
        .agent()?
        .restart(&paths.node, &paths.script, &paths.data_dir, ar)
        .await
}

/// 取本机服务日志（增量：传上次拿到的最大 `seq`）。
#[tauri::command]
fn agent_logs(state: State<'_, AppState>, since: Option<u64>) -> Result<Value, String> {
    Ok(state.agent()?.logs_since(since.unwrap_or(0)))
}

/// 清空日志缓冲。
#[tauri::command]
fn agent_logs_clear(state: State<'_, AppState>) -> Result<(), String> {
    state.agent()?.clear_logs();
    Ok(())
}

/// 开机自启状态。
#[tauri::command]
fn autostart_status() -> Value {
    autostart::status()
}

/// 开关开机自启。
#[tauri::command]
fn autostart_set(enabled: bool) -> Result<Value, String> {
    autostart::set(enabled)
}

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

/// 检查更新：比对最新 Release 与本控制台版本，并附上本机被控端已安装版本。
#[tauri::command]
async fn check_update(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let sc = ensure_sidecar(&app, &state).await?;
    // 超时**成对**下发：内层（sidecar 出网）必须小于外层（RPC），
    // 否则用户只会看到「check_update 超时」这种丢掉真实原因的假失败。
    // 见 sidecar.rs 的 UPDATE_CHECK_TIMEOUT_MS / UPDATE_CHECK_RPC_TIMEOUT_SECS。
    let mut snap = sc
        .request(
            "check_update",
            json!({
                "console_version": state.app_version,
                "timeout_ms": sidecar::UPDATE_CHECK_TIMEOUT_MS,
            }),
            sidecar::UPDATE_CHECK_RPC_TIMEOUT_SECS,
        )
        .await?;

    // 本机被控端的版本（数据目录里那份），供界面区分「应用要更新」与「被控端要更新」
    let data_dir = agent::agent_data_dir();
    let installed_version = agent::installed_agent_version(&data_dir).unwrap_or_default();
    let latest = snap
        .get("latest_version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let agent_has_update =
        !installed_version.is_empty() && agent::cmp_version(&latest, &installed_version) > 0;
    snap["installed_agent_version"] = json!(installed_version);
    snap["agent_has_update"] = json!(agent_has_update);
    Ok(snap)
}

/// 应用更新：下载 → 校验 → 替换本机被控端脚本 → 重启。
#[tauri::command]
async fn apply_update(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    sha256: String,
    version: String,
) -> Result<Value, String> {
    let sc = ensure_sidecar(&app, &state).await?;
    let paths = resolve_agent_paths(&app, &state)?;
    let mgr = state.agent()?;

    // ① 下载到暂存文件（**校验通过才落盘**；不直接覆盖在跑的脚本）
    let staged = paths
        .data_dir
        .join("runtime")
        .join(format!("agent.mjs.staged-{}", std::process::id()));
    let dl = sc
        .request(
            "download",
            json!({
                "url": url,
                "sha256": sha256,
                "dest": staged.to_string_lossy(),
                "timeout_ms": sidecar::UPDATE_DOWNLOAD_TIMEOUT_MS,
            }),
            sidecar::UPDATE_DOWNLOAD_RPC_TIMEOUT_SECS,
        )
        .await?;

    // ② 停被控端（Windows 上正被 node 打开的文件不能重命名/替换）
    let was_running = mgr.snapshot().await["state"] == json!(agent::state::RUNNING);
    if was_running {
        mgr.stop().await?;
    }

    // ③ 原子替换：先改名旧文件做备份，再落新文件
    let backup = paths.script.with_extension(format!("mjs.bak-{}", now_secs()));
    let replace = (|| -> Result<(), String> {
        if paths.script.exists() {
            std::fs::rename(&paths.script, &backup)
                .map_err(|e| format!("备份现有脚本失败：{e}"))?;
        }
        std::fs::rename(&staged, &paths.script).map_err(|e| {
            // 失败则回滚
            let _ = std::fs::rename(&backup, &paths.script);
            format!("替换脚本失败（已回滚）：{e}")
        })
    })();
    if let Err(e) = replace {
        let _ = std::fs::remove_file(&staged);
        return Err(e);
    }

    // ④ 记版本：这是「控制台启动时不要把已更新的被控端降级」的依据
    agent::mark_installed_version(&paths.data_dir, &version, "console")?;
    mgr.push_log(
        "system",
        format!("已更新本机被控端到 v{version}（备份：{}）", backup.display()),
    );

    // ⑤ 按需重新拉起
    let mut restarted = false;
    if was_running || state.settings().auto_start_agent {
        match mgr
            .start(&paths.node, &paths.script, &paths.data_dir, state.settings().auto_restart)
            .await
        {
            Ok(_) => restarted = true,
            Err(e) => mgr.push_log("system", format!("更新后启动失败：{e}")),
        }
    }

    Ok(json!({
        "updated": true,
        "version": version,
        "bytes": dl.get("bytes").cloned().unwrap_or(json!(0)),
        "sha256": dl.get("sha256").cloned().unwrap_or(json!("")),
        "backup": backup.to_string_lossy(),
        "restarted": restarted,
    }))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 设置与系统信息
// ---------------------------------------------------------------------------

/// 读设置。
#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Value {
    settings::to_json(&state.settings())
}

/// 合并式写设置（只传要改的字段）。
#[tauri::command]
fn settings_set(state: State<'_, AppState>, patch: Value) -> Result<Value, String> {
    let next = settings::merge(&state.config_dir, &patch)?;
    *state.settings.lock().unwrap() = next.clone();
    Ok(settings::to_json(&next))
}

/// 控制台自身信息（版本、数据目录、平台），供「关于」与故障上报使用。
#[tauri::command]
fn system_info(app: AppHandle, state: State<'_, AppState>) -> Value {
    let resource_dir = app.path().resource_dir().ok();
    // 先取 node 路径，再把 resource_dir 消费成字符串 —— 顺序反了会「借用已移动的值」
    let node = sidecar::resolve_node(resource_dir.as_deref())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    json!({
        "app_version": state.app_version,
        "config_dir": state.config_dir.to_string_lossy(),
        "agent_data_dir": agent::agent_data_dir().to_string_lossy(),
        "resource_dir": resource_dir.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "node": node,
        "agent_only": std::env::args().any(|a| a == autostart::AGENT_ONLY_FLAG),
    })
}

// ---------------------------------------------------------------------------
// 托盘与启动模式
// ---------------------------------------------------------------------------

/// 显示主窗口（托盘菜单与第二次启动都用它）。
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 在后台拉起被控端（忽略错误 —— 失败详情在日志里）。
fn spawn_start_agent(app: &AppHandle, auto_restart: bool) {
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app2.state::<AppState>();
        let mgr = match state.agent() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[console] 被控端管理器不可用：{e}");
                return;
            }
        };
        if mgr.snapshot().await["state"] == json!(agent::state::RUNNING) {
            return;
        }
        match resolve_agent_paths(&app2, &state) {
            Ok(p) => {
                if let Err(e) = mgr.start(&p.node, &p.script, &p.data_dir, auto_restart).await {
                    mgr.push_log("system", format!("自动启动失败：{e}"));
                }
            }
            Err(e) => mgr.push_log("system", format!("自动启动失败（路径解析）：{e}")),
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "agent_start", "启动本机被控端", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "agent_stop", "停止本机被控端", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "agent_restart", "重启本机被控端", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &sep1, &start, &stop, &restart, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("na-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("nodeagent 控制台")
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            match id.as_str() {
                "show" => show_main(app),
                "agent_start" => {
                    let ar = app.state::<AppState>().settings().auto_restart;
                    spawn_start_agent(app, ar);
                }
                "agent_stop" => {
                    let app2 = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app2.state::<AppState>();
                        if let Ok(mgr) = state.agent() {
                            let _ = mgr.stop().await;
                        }
                    });
                }
                "agent_restart" => {
                    let app2 = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app2.state::<AppState>();
                        if let Ok(mgr) = state.agent() {
                            if let Ok(p) = resolve_agent_paths(&app2, &state) {
                                let ar = state.settings().auto_restart;
                                let _ = mgr.restart(&p.node, &p.script, &p.data_dir, ar).await;
                            }
                        }
                    });
                }
                // 2026-10-17「退出前确认」需求：
                // 原实现直接 `app.exit(0)`，而 `kill_on_drop(false)` 会让被控端**成为孤儿
                // 继续监听** —— 用户以为关了控制台就干净了，实际还有个看不见的进程在跑。
                //
                // 现在改为**先问一句**：发事件给前端，由它弹三选一
                // （保留被控端退出 / 停止被控端退出 / 取消），再回调 `quit_app`。
                // 之所以走前端而不是加 tauri-plugin-dialog：前端已有 n-dialog-provider，
                // 不加依赖、风格统一，且能复用既有的 message 视觉。
                "quit" => {
                    let _ = tauri::Emitter::emit(app, "na-quit-requested", ());
                    // 把窗口唤出来，否则用户在最小化状态下看不到确认框
                    if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击托盘图标 → 唤出主窗口（符合习惯）
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 单实例
// ---------------------------------------------------------------------------
//
// ## 为什么必须有（真机缺陷，2026-10-13）
// 控制台此前**完全没有单实例保护**。开机自启会拉起一个 `--agent-only` 实例（无窗口、驻托盘），
// 用户再手动双击图标 → **第二个进程**。而「本机被控端」是**进程内状态**
// （`AgentManager` 各持自己的 `child: Option<Child>` / `pid`），两个进程互相看不见 →
// 同一台机器上跑起**两个被控端**，抢同一个 8765 端口。
//
// 后果按先后顺序分两种，正是用户报的两个症状：
// - **A（两个被控端）**：两边都抢到了不同时机 → 同机并存两个被控端进程；
// - **B（后开的起不来）**：先占住端口的那一侧赢了，后启动的一侧在 `AgentManager::start`
//   的端口检查处失败，界面表现为「应用端无法启动」（本机服务起不来）。
//
// ## 为什么不能简单「已有实例就退出」
// 自启实例是**无窗口**的（`--agent-only`）。若第二次启动只是静默退出，用户双击图标会
// **什么都不发生** —— 比缺陷本身更难排查。正确语义是：
//   第二次启动 → 把「用户想看到界面」这个意图**交给已有实例**（让它显示并聚焦窗口）→ 新进程再退出。
//
// `tauri-plugin-single-instance` 正好是这个语义：回调在**已有实例**里执行，新进程由插件负责收尾退出。
// 它必须注册为**第一个**插件，才能在其他插件与本项目的 `setup`（会拉起被控端）之前完成抢占判定。

/// 第二次启动时执行（在**已有实例**的进程里）。
fn on_second_instance(app: &AppHandle, argv: Vec<String>) {
    // 第二次启动若自己就带 `--agent-only`（例如自启被重复触发），**不要弹窗** ——
    // 那正是「仅服务模式」要避免的行为。只提示已有实例，不做别的。
    if argv.iter().any(|a| a == autostart::AGENT_ONLY_FLAG) {
        return;
    }
    // 已有实例可能是「自启的隐藏实例」或「窗口已关到托盘」→ 两种都要能唤出来。
    show_main(app);
    // 顺带通知前端刷一次状态（第二次启动往往发生在「用户发现没反应、想确认一下」的时刻）。
    // 前端没监听也无害。
    let _ = app.emit("na-second-instance", json!({ "argv": argv }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let agent_only = std::env::args().any(|a| a == autostart::AGENT_ONLY_FLAG);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            on_second_instance(app, argv);
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let config_dir = handle
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let app_version = handle.package_info().version.to_string();
            let loaded = settings::load(&config_dir);

            // 事件桥接：被控端管理器 → Tauri event
            let app_events = handle.clone();
            let emit: agent::AgentEmit = Arc::new(move |evt: AgentEvent| match evt {
                AgentEvent::Log(l) => {
                    let _ = app_events.emit("na-agent-log", l);
                }
                AgentEvent::State(s) => {
                    let _ = app_events.emit("na-agent-state", s);
                }
            });

            let manager = AgentManager::new(emit);
            manager.push_log(
                "system",
                format!(
                    "控制台 v{app_version} 就绪（{} / {}）",
                    std::env::consts::OS,
                    std::env::consts::ARCH
                ),
            );

            app.manage(AppState {
                sidecar: tokio::sync::Mutex::new(None),
                capabilities: Mutex::new(json!([])),
                agent_version: Mutex::new(None),
                conn_state: Mutex::new("未连接".to_string()),
                agent: Mutex::new(Some(Arc::clone(&manager))),
                settings: Mutex::new(loaded.clone()),
                config_dir,
                app_version,
            });

            build_tray(&handle)?;

            // 仅服务模式：不显示窗口（开机自启时不该弹任何窗口出来）
            if agent_only {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.hide();
                }
                manager.push_log("system", "以「仅服务模式」启动（无窗口，常驻托盘）");
            }

            // 自动拉起被控端（默认开）——「运行应用之后就有服务」的期望
            if loaded.auto_start_agent {
                spawn_start_agent(&handle, loaded.auto_restart);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 → 最小化到托盘（可在设置里关掉，改为直接退出）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                let close_to_tray = state.settings().close_to_tray;
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                    if let Ok(mgr) = state.agent() {
                        mgr.push_log("system", "窗口已隐藏到托盘（被控端继续运行；从托盘菜单可退出）");
                    }
                } else {
                    // 用户关掉了「最小化到托盘」→ 点 X 等于退出应用。
                    // 这条路同样会留下孤儿被控端，故**也必须问一句**，
                    // 否则「退出确认」只在托盘菜单生效，从 X 走就绕过去了。
                    api.prevent_close();
                    let _ = tauri::Emitter::emit(window.app_handle(), "na-quit-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // 连接
            connect,
            disconnect,
            invoke_capability,
            get_capabilities,
            get_state,
            // 本机服务
            agent_status,
            agent_start,
            agent_stop,
            quit_app,
            agent_restart,
            agent_logs,
            agent_logs_clear,
            autostart_status,
            autostart_set,
            // 更新
            check_update,
            apply_update,
            // 设置与信息
            settings_get,
            settings_set,
            system_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // app 退出时优雅收尾：先让 sidecar 主动 disconnect，再杀进程
            //（Sidecar 设了 kill_on_drop，即使这里失败也不会留孤儿进程）
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                let sc = tauri::async_runtime::block_on(async {
                    state.sidecar.lock().await.as_ref().map(Arc::clone)
                });
                if let Some(sc) = sc {
                    tauri::async_runtime::block_on(async {
                        sc.shutdown().await;
                    });
                }
            }
        });
}
