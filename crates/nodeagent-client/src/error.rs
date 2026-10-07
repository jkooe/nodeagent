//! 协议错误码与客户端错误类型（对齐 `packages/protocol/src/errors.ts`）。

use std::fmt;

/// 协议错误码常量（对齐 errors.ts 的 `ErrorCodes`）。
#[allow(non_snake_case)]
pub mod ErrorCodes {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const PARAM_INVALID: i64 = -32602;
    pub const AUTH_FAILED: i64 = -32401;
    pub const AUTH_REQUIRED: i64 = -32402;
    pub const CAPABILITY_NOT_FOUND: i64 = -32403;
    pub const CAPABILITY_DISABLED: i64 = -32404;
    pub const NODE_OFFLINE: i64 = -32405;
    pub const ACL_DENIED: i64 = -32406;
    pub const RATE_LIMITED: i64 = -32407;
    pub const TIMEOUT: i64 = -32412;
    pub const EXECUTION_FAILED: i64 = -32419;
    pub const PROTOCOL_MISMATCH: i64 = -32420;
    pub const UNSUPPORTED_PLATFORM: i64 = -32421;
    /// v21：被控端证书指纹与控制端钉住的不一致（可能被冒充）。
    pub const CERT_MISMATCH: i64 = -32422;
}

/// 错误码 → 名称。
pub fn error_name(code: i64) -> &'static str {
    match code {
        ErrorCodes::PARSE_ERROR => "E_PARSE_ERROR",
        ErrorCodes::INVALID_REQUEST => "E_INVALID_REQUEST",
        ErrorCodes::METHOD_NOT_FOUND => "E_METHOD_NOT_FOUND",
        ErrorCodes::PARAM_INVALID => "E_PARAM_INVALID",
        ErrorCodes::AUTH_FAILED => "E_AUTH_FAILED",
        ErrorCodes::AUTH_REQUIRED => "E_AUTH_REQUIRED",
        ErrorCodes::CAPABILITY_NOT_FOUND => "E_CAPABILITY_NOT_FOUND",
        ErrorCodes::CAPABILITY_DISABLED => "E_CAPABILITY_DISABLED",
        ErrorCodes::NODE_OFFLINE => "E_NODE_OFFLINE",
        ErrorCodes::ACL_DENIED => "E_ACL_DENIED",
        ErrorCodes::RATE_LIMITED => "E_RATE_LIMITED",
        ErrorCodes::TIMEOUT => "E_TIMEOUT",
        ErrorCodes::EXECUTION_FAILED => "E_EXECUTION_FAILED",
        ErrorCodes::PROTOCOL_MISMATCH => "E_PROTOCOL_MISMATCH",
        ErrorCodes::UNSUPPORTED_PLATFORM => "E_UNSUPPORTED_PLATFORM",
        ErrorCodes::CERT_MISMATCH => "E_CERT_MISMATCH",
        _ => "E_UNKNOWN",
    }
}

/// 客户端错误（携带协议错误码，对齐 client.ts 的 `ClientError`）。
#[derive(Debug, Clone)]
pub struct ClientError {
    pub code: i64,
    pub name: String,
    pub message: String,
    pub data: Option<serde_json::Value>,
}

impl ClientError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            name: error_name(code).to_string(),
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    /// 被控端离线/不可达。
    pub fn offline(message: impl Into<String>) -> Self {
        Self::new(ErrorCodes::NODE_OFFLINE, message)
    }

    /// 调用超时。
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorCodes::TIMEOUT, message)
    }

    /// 证书指纹不一致。
    pub fn cert_mismatch(message: impl Into<String>) -> Self {
        Self::new(ErrorCodes::CERT_MISMATCH, message)
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.name, self.message)
    }
}

impl std::error::Error for ClientError {}
