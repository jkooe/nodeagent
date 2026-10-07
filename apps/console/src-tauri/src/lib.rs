//! nodeagent 桌面控制台（主控 + 被控一体）——Tauri 后端。
//!
//! command 层把 `nodeagent-client`（Rust 控制端）接到前端：
//! - `connect` / `disconnect` / `invoke_capability` / `get_capabilities` / `get_state`
//! - client 的日志/状态/被控端事件经 Tauri `emit` 推给前端（`na-log`/`na-state`/`na-event`）。

use std::sync::{Arc, Mutex};

use nodeagent_client::{
    CapabilityDescriptor, Client, ClientEvent, ClientOptions, ConnState, InvokeResult,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

/// 全局状态：持有当前连接（`None` = 未连接）。
struct AppState {
    client: Mutex<Option<Client>>,
}

/// 连接成功后回传给前端的元信息。
#[derive(Serialize)]
struct ConnectInfo {
    capabilities: Vec<CapabilityDescriptor>,
    agent_version: Option<String>,
    authorized: Option<Vec<String>>,
    peer_cert_fp: Option<String>,
    auth_mode: String,
    client_id: String,
}

fn conn_state_str(s: ConnState) -> &'static str {
    match s {
        ConnState::Connected => "connected",
        ConnState::Reconnecting => "reconnecting",
        ConnState::Closed => "closed",
    }
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
    let client_id = client_id.unwrap_or_else(|| "console".to_string());
    let client = Client::new(ClientOptions {
        url,
        key,
        client_id: client_id.clone(),
        insecure: insecure.unwrap_or(true),
        auto_reconnect: true,
        ..Default::default()
    });

    // 把 client 的事件桥接成 Tauri 事件，推给前端。
    let app_events = app.clone();
    client.set_handler(Arc::new(move |evt| match evt {
        ClientEvent::State(s) => {
            let _ = app_events.emit("na-state", conn_state_str(s));
        }
        ClientEvent::Log(msg) => {
            let _ = app_events.emit("na-log", msg);
        }
        ClientEvent::Event(params) => {
            let _ = app_events.emit("na-event", params);
        }
    }));

    let caps = client.connect().await.map_err(|e| e.to_string())?;

    let info = ConnectInfo {
        agent_version: client.agent_version(),
        authorized: client.list_authorized(),
        peer_cert_fp: client.peer_cert_fingerprint(),
        auth_mode: "psk".to_string(),
        capabilities: caps,
        client_id,
    };

    *state.client.lock().unwrap() = Some(client);
    Ok(info)
}

/// 断开连接（停止自动重连）。
#[tauri::command]
fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(client) = state.client.lock().unwrap().take() {
        client.close();
    }
    Ok(())
}

/// 调用一项被控端能力。`timeout_ms` 可选：长任务（装软件 / 长命令）需显式放大。
#[tauri::command]
async fn invoke_capability(
    state: State<'_, AppState>,
    capability: String,
    args: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<InvokeResult, String> {
    let client = {
        let guard = state.client.lock().unwrap();
        guard.as_ref().cloned().ok_or_else(|| "未连接".to_string())?
    };
    let args = args.unwrap_or(Value::Object(Default::default()));
    match timeout_ms {
        Some(ms) if ms > 0 => client.invoke_with_timeout(&capability, args, ms).await,
        _ => client.invoke(&capability, args).await,
    }
    .map_err(|e| e.to_string())
}

/// 当前连接的能力清单。
#[tauri::command]
fn get_capabilities(state: State<'_, AppState>) -> Result<Vec<CapabilityDescriptor>, String> {
    let guard = state.client.lock().unwrap();
    let client = guard.as_ref().ok_or_else(|| "未连接".to_string())?;
    Ok(client.list_capabilities())
}

/// 当前连接状态字符串（connected / reconnecting / closed / 未连接）。
#[tauri::command]
fn get_state(state: State<'_, AppState>) -> String {
    match state.client.lock().unwrap().as_ref() {
        Some(client) => conn_state_str(client.state()).to_string(),
        None => "未连接".to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            client: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            invoke_capability,
            get_capabilities,
            get_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
