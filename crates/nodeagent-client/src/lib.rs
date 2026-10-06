//! nodeagent 控制端 Rust 客户端。
//!
//! 行为对齐 `packages/client`（Node 版），复刻：
//! - 握手 hello → challenge → auth → auth_ok（psk HMAC / ed25519 签名）
//! - 泛型能力调用 invoke（带超时与 id 匹配）
//! - 事件通知（无 id 的 JSON-RPC notification，`event` 方法）
//! - 断线指数退避重连（1s → 30s，±15% 抖动）
//! - TLS 自签证书 + 指纹钉住（v21，E_CERT_MISMATCH）

pub mod client;
pub mod crypto;
pub mod discovery;
pub mod error;
pub mod tls;
pub mod types;
pub mod ulid;

pub use client::{Client, ClientEvent, ClientOptions, ConnState};
pub use error::{ClientError, ErrorCodes};
