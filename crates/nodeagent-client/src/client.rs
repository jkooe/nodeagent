//! 控制端客户端主体（对齐 `packages/client/src/client.ts` 的 `NodeAgentClient`）。
//!
//! 复刻行为：连接 → 握手（hello → challenge → auth → auth_ok）→ 泛型能力调用 →
//! 事件通知（无 id 的 `event` 方法）→ 断线指数退避重连（1s → 30s，±15% 抖动）。
//!
//! 并发结构（监督者模式）：
//! - `connect()` 派生一个 `supervise` 任务，串行「建立+握手 → 等读循环断开信号 → 退避重连」。
//! - `establish()` 负责单次连接 + 握手，并派生**读循环**与**写任务**两个子任务。
//! - 读循环在流结束时只 `notify` 监督者、绝不回调 `establish`——从而打破
//!   `establish → spawn(read_loop) → establish` 的类型级递归，让每个 future 都可证 `Send`。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_tungstenite::tungstenite::Message;

use crate::crypto::{compute_hmac, sign_nonce};
use crate::error::{ClientError, ErrorCodes};
use crate::tls;
use crate::types::*;
use crate::ulid::ulid;

/// WebSocket 流类型（TLS 下为 `MaybeTlsStream`）。
type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type WsSink = SplitSink<WsStream, Message>;
type WsReader = SplitStream<WsStream>;

/// 控制面方法名（对齐 `protocol/src/methods.ts` 的 `Methods`）。
const M_HELLO: &str = "hello";
const M_AUTH: &str = "auth";
const M_INVOKE: &str = "invoke";
const M_EVENT: &str = "event";

/// 连接状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnState {
    Connected,
    Reconnecting,
    Closed,
}

/// 对外事件：连接状态变化 / 被控端主动事件 / 日志。
#[derive(Debug, Clone)]
pub enum ClientEvent {
    State(ConnState),
    Event(Value),
    Log(String),
}

/// 事件回调（`Arc` 便于共享给读循环）。
pub type EventHandler = Arc<dyn Fn(ClientEvent) + Send + Sync>;

/// 认证模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    Psk,
    Ed25519,
}

/// 客户端选项。
#[derive(Clone)]
pub struct ClientOptions {
    /// `ws://` 或 `wss://` 地址。
    pub url: String,
    /// psk 预共享密钥。
    pub key: String,
    /// 控制端身份标识。
    pub client_id: String,
    /// 跳过自签证书校验（TLS 仍加密）。
    pub insecure: bool,
    /// 钉住的被控端证书指纹（sha256 hex，64 位）。
    pub cert_sha256: Option<String>,
    /// 认证模式。
    pub auth_mode: AuthMode,
    /// ed25519 模式：私钥（Base64 PKCS8 DER）。
    pub private_key: Option<String>,
    /// 握手超时（默认 10s）。
    pub handshake_timeout_ms: u64,
    /// 单次调用默认超时（默认 60s）。
    pub default_timeout_ms: u64,
    /// 断线后自动重连。
    pub auto_reconnect: bool,
    /// 重连退避上限（默认 30s）。
    pub max_reconnect_delay_ms: u64,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            url: String::new(),
            key: String::new(),
            client_id: String::new(),
            insecure: false,
            cert_sha256: None,
            auth_mode: AuthMode::Psk,
            private_key: None,
            handshake_timeout_ms: 10_000,
            default_timeout_ms: 60_000,
            auto_reconnect: false,
            max_reconnect_delay_ms: 30_000,
        }
    }
}

/// 连接元信息（能力清单 / 授权 / 指纹 / 版本）。
#[derive(Default, Clone)]
struct Meta {
    capabilities: Vec<CapabilityDescriptor>,
    authorized: Option<Vec<String>>,
    peer_cert_fp: Option<String>,
    agent_version: Option<String>,
    agent_build: Option<BuildInfo>,
}

/// 跨任务共享的可变状态。
///
/// 关键约束：`Client` 必须 `Sync`（多处 `&self` 跨 await）。这里的可变字段一律用
/// `std` 的 `Mutex`/`RwLock`（天然 `Send + Sync`），并保证**不在持锁期间 await**：
/// 发送半部分通过「专用写任务 + mpsc 通道」解耦，`pending` 的增删改全是同步短临界区。
struct Shared {
    /// 到「写任务」的通道；写任务独占 sink 并转发消息（发送不跨 await 持锁）。
    write: RwLock<Option<mpsc::UnboundedSender<Message>>>,
    /// 待响应映射（id → oneshot 发送端）；同步锁即可。
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, ClientError>>>>,
    /// 读循环在流结束时通知监督者（「连接已断开」信号）。
    disconnected: Notify,
    meta: RwLock<Meta>,
    state: RwLock<ConnState>,
    reconnect_attempts: AtomicU32,
    stopped: AtomicBool,
    handler: RwLock<Option<EventHandler>>,
}

/// 控制端客户端。
#[derive(Clone)]
pub struct Client {
    opts: Arc<ClientOptions>,
    shared: Arc<Shared>,
}

impl Client {
    pub fn new(opts: ClientOptions) -> Self {
        Self {
            opts: Arc::new(opts),
            shared: Arc::new(Shared {
                write: RwLock::new(None),
                pending: Mutex::new(HashMap::new()),
                disconnected: Notify::new(),
                meta: RwLock::new(Meta::default()),
                state: RwLock::new(ConnState::Closed),
                reconnect_attempts: AtomicU32::new(0),
                stopped: AtomicBool::new(false),
                handler: RwLock::new(None),
            }),
        }
    }

    /// 设置事件回调。
    pub fn set_handler(&self, handler: EventHandler) {
        *self.shared.handler.write().unwrap() = Some(handler);
    }

    /// 建立连接并完成握手，返回能力清单。
    /// 派生监督任务后，仅等待**首次**握手结果（失败即返回错误，不自动重连）。
    pub async fn connect(&self) -> Result<Vec<CapabilityDescriptor>, ClientError> {
        self.shared.stopped.store(false, Ordering::SeqCst);

        let (tx, rx) = oneshot::channel();
        let this = self.clone();
        tokio::spawn(async move {
            this.supervise(Some(tx)).await;
        });

        match rx.await {
            Ok(result) => result,
            Err(_) => Err(ClientError::offline("连接监督任务异常退出")),
        }
    }

    /// 调用一项能力（`args` 为 JSON 对象），用默认超时。
    pub async fn invoke(
        &self,
        capability: &str,
        args: Value,
    ) -> Result<InvokeResult, ClientError> {
        self.invoke_with_timeout(capability, args, self.opts.default_timeout_ms)
            .await
    }

    /// 调用一项能力并显式指定 RPC 超时（长任务如 `app.install` / 长命令用）。
    pub async fn invoke_with_timeout(
        &self,
        capability: &str,
        args: Value,
        timeout_ms: u64,
    ) -> Result<InvokeResult, ClientError> {
        let params = json!({ "capability": capability, "args": args });
        let value = self.request(M_INVOKE, params, timeout_ms).await?;
        serde_json::from_value::<InvokeResult>(value)
            .map_err(|e| ClientError::new(ErrorCodes::PARSE_ERROR, format!("解析调用结果失败: {e}")))
    }

    /// 已获取的能力清单。
    pub fn list_capabilities(&self) -> Vec<CapabilityDescriptor> {
        self.shared.meta.read().unwrap().capabilities.clone()
    }

    /// ed25519 模式下本次被授权的能力；psk 模式返回 `None`。
    pub fn list_authorized(&self) -> Option<Vec<String>> {
        self.shared.meta.read().unwrap().authorized.clone()
    }

    /// 本次连接观测到的对端证书指纹（sha256 hex）。
    pub fn peer_cert_fingerprint(&self) -> Option<String> {
        self.shared.meta.read().unwrap().peer_cert_fp.clone()
    }

    /// 被控端语义化版本。
    pub fn agent_version(&self) -> Option<String> {
        self.shared.meta.read().unwrap().agent_version.clone()
    }

    /// 被控端构建信息。
    pub fn agent_build(&self) -> Option<BuildInfo> {
        self.shared.meta.read().unwrap().agent_build.clone()
    }

    /// 当前连接状态。
    pub fn state(&self) -> ConnState {
        *self.shared.state.read().unwrap()
    }

    /// 主动关闭连接（停止自动重连）。
    pub fn close(&self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        // 丢弃发送通道 → 写任务退出 → sink 释放 → 连接关闭；并唤醒监督者及时退出。
        *self.shared.write.write().unwrap() = None;
        self.shared.disconnected.notify_one();
        self.set_state(ConnState::Closed);
        self.emit_log("主动关闭");
    }

    // ---------- 内部 ----------

    /// 监督循环：反复「建立+握手 → 等断开 → 退避重连」。
    /// 首次握手结果经 `first_tx` 回传给 `connect()`；首次失败直接返回，不重连。
    async fn supervise(
        &self,
        first_tx: Option<oneshot::Sender<Result<Vec<CapabilityDescriptor>, ClientError>>>,
    ) {
        let mut first_tx = first_tx;

        loop {
            let established = match self.establish().await {
                Ok(caps) => {
                    self.shared.reconnect_attempts.store(0, Ordering::SeqCst);
                    self.set_state(ConnState::Connected);
                    // 首次成功：把能力清单回传给 `connect()` 调用方。
                    if let Some(tx) = first_tx.take() {
                        let _ = tx.send(Ok(caps));
                    }
                    true
                }
                Err(e) => {
                    // 首次失败：直接报错返回（不做自动重连，对齐 Node 行为）。
                    if let Some(tx) = first_tx.take() {
                        let _ = tx.send(Err(e));
                        return;
                    }
                    self.emit_log(format!("重连失败: {e}"));
                    false
                }
            };

            // 本次建立成功才有读循环会发「断开」信号；失败则直接进入退避。
            if established {
                self.shared.disconnected.notified().await;
            }

            if self.shared.stopped.load(Ordering::SeqCst) {
                self.set_state(ConnState::Closed);
                return;
            }
            if !self.opts.auto_reconnect {
                self.set_state(ConnState::Closed);
                return;
            }

            let delay = self.next_backoff_delay();
            self.set_state(ConnState::Reconnecting);
            self.emit_log(format!("将在 {}ms 后重连", delay.as_millis()));
            tokio::time::sleep(delay).await;

            if self.shared.stopped.load(Ordering::SeqCst) {
                self.set_state(ConnState::Closed);
                return;
            }
        }
    }

    /// 建立一次连接：TCP/TLS/WS → split → 读循环 + 写任务 → 协议握手。
    async fn establish(&self) -> Result<Vec<CapabilityDescriptor>, ClientError> {
        // TLS 下抓取对端证书指纹（自签 + insecure 时留下的中间人空档，靠钉住兜底）。
        let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let (ws, _resp) = if self.opts.url.starts_with("wss://") {
            let config = tls::build_client_config(
                self.opts.insecure,
                self.opts.cert_sha256.clone(),
                captured.clone(),
            )?;
            let connector = tokio_tungstenite::Connector::Rustls(Arc::new(config));
            tokio_tungstenite::connect_async_tls_with_config(
                self.opts.url.as_str(),
                None,
                false,
                Some(connector),
            )
            .await
            .map_err(|e| self.map_connect_error(e))?
        } else {
            tokio_tungstenite::connect_async(self.opts.url.as_str())
                .await
                .map_err(|e| self.map_connect_error(e))?
        };

        let peer_fp = captured.lock().unwrap().clone();

        let (sink, stream) = ws.split();
        let (tx, rx) = mpsc::unbounded_channel();
        *self.shared.write.write().unwrap() = Some(tx);

        // 写任务独占 sink；读循环独立跑；二者都只持有局部 Send 类型。
        tokio::spawn(async move { writer_task(sink, rx).await });
        let this = self.clone();
        tokio::spawn(async move {
            this.read_loop(stream).await;
        });

        // 握手；失败则关闭连接（丢弃发送通道 → 写任务退出 → sink 释放 → 读循环结束）。
        let result = self.handshake(peer_fp).await;
        if result.is_err() {
            *self.shared.write.write().unwrap() = None;
        }
        result
    }

    /// 握手：hello → challenge → auth → auth_ok；成功后写回元信息。
    async fn handshake(&self, peer_fp: Option<String>) -> Result<Vec<CapabilityDescriptor>, ClientError> {
        let challenge: ChallengeParams = {
            let value = self
                .request(
                    M_HELLO,
                    json!({ "protocol": PROTOCOL_VERSION, "client_id": self.opts.client_id }),
                    self.opts.handshake_timeout_ms,
                )
                .await?;
            serde_json::from_value(value).map_err(|e| {
                ClientError::new(ErrorCodes::PARSE_ERROR, format!("解析 challenge 失败: {e}"))
            })?
        };

        let auth_params = match self.opts.auth_mode {
            AuthMode::Ed25519 => {
                let private_key = self.opts.private_key.as_deref().ok_or_else(|| {
                    ClientError::new(ErrorCodes::AUTH_FAILED, "ed25519 模式需要私钥，请先 keygen")
                })?;
                let signature = sign_nonce(private_key, &challenge.nonce).map_err(|e| {
                    ClientError::new(ErrorCodes::AUTH_FAILED, format!("签名失败: {e}"))
                })?;
                json!({ "client_id": self.opts.client_id, "nonce": challenge.nonce, "signature": signature })
            }
            AuthMode::Psk => {
                let hmac = compute_hmac(&self.opts.key, &challenge.nonce);
                json!({ "client_id": self.opts.client_id, "nonce": challenge.nonce, "hmac": hmac })
            }
        };

        let auth_ok: AuthOkParams = {
            let value = self
                .request(M_AUTH, auth_params, self.opts.handshake_timeout_ms)
                .await?;
            serde_json::from_value(value).map_err(|e| {
                ClientError::new(ErrorCodes::PARSE_ERROR, format!("解析 auth_ok 失败: {e}"))
            })?
        };

        // v21 交叉确认：握手抓到的实际证书 vs 服务端自报 —— 不一致说明自报被篡改/冒充。
        if let (Some(fp), Some(self_reported)) = (
            peer_fp.as_ref(),
            auth_ok
                .build
                .as_ref()
                .and_then(|b| b.cert_sha256.as_ref()),
        ) {
            if fp != self_reported {
                return Err(ClientError::cert_mismatch(
                    "被控端自报的证书指纹与实际握手证书不一致，拒绝使用（可能被冒充）",
                ));
            }
        }

        let capabilities = auth_ok.capabilities.clone();
        let authorized_len = auth_ok.authorized.as_ref().map(|a| a.len());
        {
            let mut meta = self.shared.meta.write().unwrap();
            meta.capabilities = auth_ok.capabilities.clone();
            meta.authorized = auth_ok.authorized.clone();
            meta.peer_cert_fp = peer_fp;
            meta.agent_version = auth_ok.agent_version.clone();
            meta.agent_build = auth_ok.build.clone();
        }

        let capabilities_len = capabilities.len();
        let label = if auth_ok.auth_mode.as_deref() == Some("ed25519") {
            format!("ed25519，授权 {}/{capabilities_len} 项能力", authorized_len.unwrap_or(0))
        } else {
            format!("psk，被控端声明 {capabilities_len} 项能力")
        };
        self.emit_log(format!("握手成功（{label}）"));

        Ok(capabilities)
    }

    /// 底层请求（带超时与 id 匹配）。
    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Value, ClientError> {
        let id = ulid();
        let (tx, rx) = oneshot::channel();

        self.shared.pending.lock().unwrap().insert(id.clone(), tx);

        let req = RpcRequest {
            jsonrpc: "2.0".to_string(),
            id: id.clone(),
            method: method.to_string(),
            params: Some(params),
        };
        let payload = serde_json::to_string(&req)
            .map_err(|e| ClientError::new(ErrorCodes::PARSE_ERROR, e.to_string()))?;

        {
            let sender = self
                .shared
                .write
                .read()
                .unwrap()
                .as_ref()
                .cloned()
                .ok_or_else(|| ClientError::offline("连接未就绪"))?;
            // 同步发送（不持锁 await）：消息经通道转交写任务。
            sender
                .send(Message::Text(payload.into()))
                .map_err(|e| ClientError::offline(format!("发送失败: {e}")))?;
        }

        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Err(_) => {
                self.shared.pending.lock().unwrap().remove(&id);
                Err(ClientError::timeout(format!(
                    "调用超时 ({timeout_ms}ms): {method}"
                )))
            }
            Ok(Err(_)) => Err(ClientError::offline("连接已断开")),
            Ok(Ok(result)) => result,
        }
    }

    /// 读循环：分发响应与事件；流结束后清空 pending 并通知监督者。
    async fn read_loop(&self, mut stream: WsReader) {
        while let Some(Ok(msg)) = stream.next().await {
            if let Err(e) = self.handle_message(msg).await {
                self.emit_log(format!("消息处理失败: {e}"));
            }
        }
        // 流结束（对端关闭 / 网络断开）→ 清空 pending，由监督者决定是否重连。
        self.reject_all_pending();
        self.shared.disconnected.notify_one();
    }

    /// 处理单条消息。
    async fn handle_message(&self, msg: Message) -> Result<(), ClientError> {
        // WebSocket ping 帧：回 pong（保持连接）。
        if msg.is_ping() {
            let pong = msg.into_data();
            if let Some(sender) = self.shared.write.read().unwrap().as_ref() {
                let _ = sender.send(Message::Pong(pong));
            }
            return Ok(());
        }
        if !msg.is_text() && !msg.is_binary() {
            return Ok(());
        }

        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => match String::from_utf8(b.to_vec()) {
                Ok(s) => s,
                Err(_) => return Ok(()),
            },
            _ => return Ok(()),
        };

        let value: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => {
                self.emit_log(format!("收到无法解析的消息: {}", &text[..text.len().min(200)]));
                return Ok(());
            }
        };

        // 有 id → 响应；无 id → 通知（事件）。
        if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
            if let Some(tx) = self.shared.pending.lock().unwrap().remove(id) {
                let result = self.parse_response(&value);
                let _ = tx.send(result);
            }
            return Ok(());
        }

        let method = value.get("method").and_then(|m| m.as_str()).unwrap_or("");
        if method == M_EVENT {
            if let Some(params) = value.get("params").cloned() {
                self.emit_event(params);
            }
        }
        Ok(())
    }

    /// 把响应消息解析为 `Result<Value, ClientError>`。
    fn parse_response(&self, value: &Value) -> Result<Value, ClientError> {
        if is_error_response(value) {
            let err = value.get("error").cloned().unwrap_or(Value::Null);
            let code = err
                .get("code")
                .and_then(|c| c.as_i64())
                .unwrap_or(ErrorCodes::PARSE_ERROR);
            let name = err
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("E_UNKNOWN")
                .to_string();
            let message = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string();
            Err(ClientError {
                code,
                name,
                message,
                data: err.get("data").cloned(),
            })
        } else {
            value
                .get("result")
                .cloned()
                .ok_or_else(|| ClientError::new(ErrorCodes::PARSE_ERROR, "响应缺少 result 字段"))
        }
    }

    /// 指数退避 + ±15% 抖动（1s → 30s）。
    fn next_backoff_delay(&self) -> Duration {
        let attempts = self.shared.reconnect_attempts.fetch_add(1, Ordering::SeqCst);
        let base = (1000u64 << attempts).min(self.opts.max_reconnect_delay_ms);
        let jitter = 0.85 + rand::random::<f64>() * 0.3; // 0.85..=1.15
        Duration::from_millis((base as f64 * jitter) as u64)
    }

    fn reject_all_pending(&self) {
        let drained: Vec<oneshot::Sender<Result<Value, ClientError>>> = {
            let mut map = self.shared.pending.lock().unwrap();
            map.drain().map(|(_, tx)| tx).collect()
        };
        for tx in drained {
            let _ = tx.send(Err(ClientError::offline("连接已断开")));
        }
    }

    fn map_connect_error(&self, e: tokio_tungstenite::tungstenite::Error) -> ClientError {
        let msg = e.to_string();
        if msg.contains("证书指纹不匹配") {
            ClientError::cert_mismatch(msg)
        } else {
            ClientError::offline(format!("无法连接被控端: {msg}"))
        }
    }

    fn set_state(&self, state: ConnState) {
        *self.shared.state.write().unwrap() = state;
        if let Some(h) = self.shared.handler.read().unwrap().as_ref() {
            h(ClientEvent::State(state));
        }
    }

    fn emit_event(&self, params: Value) {
        if let Some(h) = self.shared.handler.read().unwrap().as_ref() {
            h(ClientEvent::Event(params));
        }
    }

    fn emit_log(&self, msg: impl Into<String>) {
        if let Some(h) = self.shared.handler.read().unwrap().as_ref() {
            h(ClientEvent::Log(msg.into()));
        }
    }
}

/// 写任务：独占 sink，把 mpsc 通道里的消息逐条发出去。
/// 通道关闭（`close()` 丢弃 sender）或发送失败时退出，sink 随之释放。
async fn writer_task(mut sink: WsSink, mut rx: mpsc::UnboundedReceiver<Message>) {
    while let Some(msg) = rx.recv().await {
        if sink.send(msg).await.is_err() {
            break;
        }
    }
}
