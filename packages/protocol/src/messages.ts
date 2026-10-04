import type { RpcError } from './errors.js';

/** JSON-RPC 2.0 请求信封（nodeagent 简化版）。 */
export interface RpcRequest<P = unknown> {
  jsonrpc: '2.0';
  /** ULID，响应回填相同 id */
  id: string;
  method: string;
  params?: P;
}

/** JSON-RPC 2.0 成功响应。 */
export interface RpcResponse<R = unknown> {
  jsonrpc: '2.0';
  id: string;
  result: R;
}

/** JSON-RPC 2.0 错误响应。 */
export interface RpcErrorResponse {
  jsonrpc: '2.0';
  id: string | null;
  error: RpcError;
}

export type RpcMessage<R = unknown> = RpcResponse<R> | RpcErrorResponse;

/** 判断是否为错误响应。 */
export function isErrorResponse(msg: unknown): msg is RpcErrorResponse {
  return typeof msg === 'object' && msg !== null && 'error' in msg;
}

// ---------- 握手 ----------

export interface HelloParams {
  protocol: string;
  client_id: string;
}

export interface ChallengeParams {
  nonce: string;
  expires_at: number;
}

export interface AuthParams {
  client_id: string;
  nonce: string;
  /** psk 模式：Base64(HMAC-SHA256(pre_shared_key, nonce)) */
  hmac?: string;
  /** ed25519 模式：Base64(Ed25519_Sign(privkey, nonce)) */
  signature?: string;
}

export interface AuthOkParams {
  capabilities: CapabilityDescriptor[];
  /** ed25519 模式：本次调用方实际被授权的能力（全量清单的子集） */
  authorized?: string[];
  /** 本次连接采用的认证模式 */
  auth_mode?: 'psk' | 'ed25519';
  /** v20：被控端语义化版本（新增字段，旧控制端忽略即可 → 向后兼容） */
  agent_version?: string;
  /** v20：被控端构建信息（指纹/提交/构建时间），供控制端做版本比对与提示 */
  build?: { hash?: string; commit?: string; built_at?: string };
  /** v20：被控端支持的协议版本（与 HelloParams.protocol 比对） */
  protocol?: string;
}

// ---------- 调用 ----------

export interface InvokeParams {
  capability: string;
  args?: Record<string, unknown>;
}

/** 能力执行结果（业务层）。 */
export interface InvokeResult<T = unknown> {
  status: 'ok' | 'failed';
  data?: T;
  error?: { name: string; message: string; data?: unknown };
}

/** 能力描述（能力清单条目）。 */
export interface CapabilityDescriptor {
  name: string;
  version: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  params_schema: JsonSchema;
  returns_schema?: JsonSchema;
}

/** JSON Schema 子集（见 DEVELOPMENT.md 4.3）。 */
export interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  description?: string;
}
