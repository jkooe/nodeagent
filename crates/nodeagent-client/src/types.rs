//! 协议消息类型（对齐 `packages/protocol/src/messages.ts`）。
//!
//! 所有对外字段名保持 snake_case 与 TS 侧一致，经 serde 序列化/反序列化。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 协议版本（对齐 methods.ts 的 `PROTOCOL_VERSION`）。
pub const PROTOCOL_VERSION: &str = "1.0";

/// JSON-RPC 2.0 请求信封（nodeagent 简化版）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    /// ULID，响应回填相同 id。
    pub id: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

/// JSON-RPC 2.0 成功响应。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: String,
    pub result: Value,
}

/// 协议错误对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub name: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// JSON-RPC 2.0 错误响应。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcErrorResponse {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<String>,
    pub error: RpcError,
}

/// 任意入站消息：成功响应或错误响应（无 id 的通知由上层单独处理）。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum InboundMessage {
    Response(RpcResponse),
    Error(RpcErrorResponse),
    Notification {
        #[serde(default)]
        id: Option<String>,
        method: String,
        #[serde(default)]
        params: Option<Value>,
    },
}

/// 判断消息是否为错误响应。
pub fn is_error_response(msg: &Value) -> bool {
    msg.get("error").is_some()
}

// ---------- 握手 ----------

/// hello 入参。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloParams {
    pub protocol: String,
    pub client_id: String,
}

/// challenge 出参。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChallengeParams {
    pub nonce: String,
    pub expires_at: i64,
}

/// auth 入参。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthParams {
    pub client_id: String,
    pub nonce: String,
    /// psk 模式：Base64(HMAC-SHA256(pre_shared_key, nonce))。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hmac: Option<String>,
    /// ed25519 模式：Base64(Ed25519_Sign(privkey, nonce))。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// auth_ok 出参。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthOkParams {
    pub capabilities: Vec<CapabilityDescriptor>,
    /// ed25519 模式：本次实际被授权的能力（全量子集）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorized: Option<Vec<String>>,
    /// 本次连接采用的认证模式。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<String>,
    /// v20：被控端语义化版本。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_version: Option<String>,
    /// v20：被控端构建信息。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<BuildInfo>,
    /// v20：被控端支持的协议版本。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
}

/// 被控端构建信息（v20）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub built_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cert_sha256: Option<String>,
}

// ---------- 调用 ----------

/// invoke 入参。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvokeParams {
    pub capability: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
}

/// 能力执行结果（业务层）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvokeResult {
    pub status: String, // "ok" | "failed"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<InvokeError>,
}

impl InvokeResult {
    pub fn is_ok(&self) -> bool {
        self.status == "ok"
    }
}

/// 能力执行失败的错误信息。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InvokeError {
    pub name: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// 能力描述（能力清单条目）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityDescriptor {
    pub name: String,
    pub version: String,
    pub description: String,
    pub risk: String, // "low" | "medium" | "high"
    pub params_schema: JsonSchema,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub returns_schema: Option<JsonSchema>,
}

/// JSON Schema 子集（见 DEVELOPMENT.md 4.3）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonSchema {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub schema_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<std::collections::BTreeMap<String, JsonSchema>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<Vec<String>>,
    #[serde(rename = "additionalProperties", skip_serializing_if = "Option::is_none")]
    pub additional_properties: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#enum: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
    #[serde(rename = "minLength", skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u64>,
    #[serde(rename = "maxLength", skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<JsonSchema>>,
    #[serde(rename = "minItems", skip_serializing_if = "Option::is_none")]
    pub min_items: Option<u64>,
    #[serde(rename = "maxItems", skip_serializing_if = "Option::is_none")]
    pub max_items: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}
