//! nodeagent 桌面控制台（主控 + 被控一体）——Tauri 后端。
//!
//! ## 结构（2026-10 起：sidecar 方案）
//! 本层只做**进程管理 + 消息转发**，真正的协议实现只有 TS 一份（`@nodeagent/client`），
//! 由 `sidecar.rs` 拉起的 Node 进程承载。原先「Rust 版 client 与 TS 版并存」的漂移风险就此消除。
//!
//! command 面（**签名与语义保持不变，前端无需改动**）：
//! - `connect` / `disconnect` / `invoke_capability` / `get_capabilities` / `get_state`
//! Tauri 事件面（名字不变）：`na-state` / `na-log` / `na-event`。

mod sidecar;

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use sidecar::{Sidecar, SidecarEvent};

/// 全局状态。
///
/// `connect` 成功后缓存「能力清单 / 版本 / 连接态」——这样 `get_capabilities`、
/// `get_state` 能保持**同步**（无需每次往返 sidecar），签名与改造前一致。
struct AppState {
    sidecar: tokio::sync::Mutex<Option<std::sync::Arc<Sidecar>>>,
    capabilities: Mutex<Value>,
    agent_version: Mutex<Option<String>>,
    conn_state: Mutex<String>,
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

impl Default for AppState {
    fn default() -> Self {
        Self {
            sidecar: tokio::sync::Mutex::new(None),
            capabilities: Mutex::new(Value::Array(vec![])),
            agent_version: Mutex::new(None),
            conn_state: Mutex::new("未连接".to_string()),
        }
    }
}

/// 懒启动 sidecar（首次调用时拉起，之后复用同一进程）。
async fn ensure_sidecar(app: &AppHandle, state: &AppState) -> Result<std::sync::Arc<Sidecar>, String> {
    let mut guard = state.sidecar.lock().await;
    if let Some(sc) = guard.as_ref() {
        return Ok(std::sync::Arc::clone(sc));
    }

    // 打包后 node 与 sidecar.mjs 随 resource 分发；开发期用系统 node + 仓库内脚本
    let resource_dir = app.path().resource_dir().ok();
    let node = sidecar::resolve_node(resource_dir.as_deref())?;
    let script = sidecar::resolve_sidecar(resource_dir.as_deref())?;

    // 事件桥接：sidecar 通知 → Tauri event（名字与改造前一致）
    let app_events = app.clone();
    let on_event = std::sync::Arc::new(move |evt: SidecarEvent| match evt {
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
    // 连接态由事件驱动：先置「已就绪」，真正连接后会被 connected 覆盖
    *state.conn_state.lock().unwrap() = "未连接".to_string();
    *guard = Some(std::sync::Arc::clone(&sc));
    Ok(sc)
}

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

    // 缓存快照，供同步 command 使用
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
    let sc = { state.sidecar.lock().await.as_ref().map(std::sync::Arc::clone) };
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
            .map(std::sync::Arc::clone)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            invoke_capability,
            get_capabilities,
            get_state
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // app 退出时优雅收尾：先让 sidecar 主动 disconnect，再杀进程
            //（Sidecar 设了 kill_on_drop，即使这里失败也不会留孤儿进程）
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                let sc = tauri::async_runtime::block_on(async {
                    state.sidecar.lock().await.as_ref().map(std::sync::Arc::clone)
                });
                if let Some(sc) = sc {
                    tauri::async_runtime::block_on(async {
                        sc.shutdown().await;
                    });
                }
            }
        });
}
