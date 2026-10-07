/** 协议类型镜像（对齐 Rust 侧 `crates/nodeagent-client` 与 Tauri command 的序列化形状）。 */

/** 能力描述（被控端声明的能力清单条目）。 */
export interface CapabilityDescriptor {
  name: string;
  version: string;
  description: string;
  risk: "low" | "medium" | "high" | string;
  params_schema: JsonSchema;
  returns_schema?: JsonSchema;
}

/** JSON Schema 子集。 */
export interface JsonSchema {
  type?: string;
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

/** connect command 返回的连接元信息。 */
export interface ConnectInfo {
  capabilities: CapabilityDescriptor[];
  agent_version: string | null;
  authorized: string[] | null;
  peer_cert_fp: string | null;
  auth_mode: string;
  client_id: string;
}

/** 能力执行失败的错误信息。 */
export interface InvokeError {
  name: string;
  message: string;
  data?: unknown;
}

/** 能力执行结果（业务层）。 */
export interface InvokeResult<T = unknown> {
  status: "ok" | "failed";
  data?: T;
  error?: InvokeError;
}

/** 连接状态。 */
export type ConnState = "connected" | "reconnecting" | "closed";

// ---------- 各能力的返回结构 ----------

/** 被控端构建信息（v18 构建指纹 + 运行状态）。 */
export interface BuildInfo {
  version?: string;
  hash?: string;
  commit?: string;
  built_at?: string;
  /** 运行中 agent 脚本的 sha256（v21 证书/脚本交叉核对） */
  cert_sha256?: string;
  bytes?: number;
  mtime_ms?: number;
  node?: string;
  started_at?: number;
  uptime_ms?: number;
}

/** PowerShell 常驻助手状态（v15）。 */
export interface PsHelperInfo {
  spawned?: boolean;
  hits?: number;
  failures?: number;
  consecutiveFailures?: number;
  avg_ms?: number;
  [k: string]: unknown;
}

/** v21 来源网段访问控制。 */
export interface NetworkInfo {
  /** null = **未配置 = 放行全部**（应尽快收敛） */
  allow_from?: string[] | null;
}

export interface SystemInfo {
  hostname?: string;
  /** 被控端平台：'Windows' | 'macOS' | 'Linux' —— **平台门控能力的判断依据** */
  os?: string;
  os_version?: string;
  arch?: string;
  cpu_model?: string;
  cpu_cores?: number;
  memory_total?: number;
  uptime_sec?: number;
  is_admin?: boolean;
  pid?: number;
  agent_home?: string;
  /** 被控端入口脚本路径，供一键升级定位 */
  agent_script?: string;
  /** 被控端 Node 可执行文件路径（字段名是 `node_path`，没有独立的 `node`） */
  node_path?: string;
  ps_helper?: PsHelperInfo;
  network?: NetworkInfo;
  build?: BuildInfo;
}

/**
 * 磁盘（对齐 manifest system.status.disks 契约）。
 * 注意：**没有 `used` 字段**，已用量需自行算 `total - free`。
 */
export interface DiskInfo {
  drive?: string;
  total?: number;
  free?: number;
  used_pct?: number;
}

/** 网络适配器（对齐 manifest system.status.net 契约）。 */
export interface NetInfo {
  adapter?: string;
  ip?: string;
  up?: boolean;
}

export interface SystemStatus {
  cpu_pct?: number;
  memory_used?: number;
  memory_total?: number;
  memory_pct?: number;
  disks?: DiskInfo[];
  net?: NetInfo[];
}

/** 进程项（对齐 manifest system.process.list 契约）。 */
export interface ProcessEntry {
  pid: number;
  name: string;
  /** CPU 占用百分比（非 `cpu`） */
  cpu_pct?: number;
  /** 常驻内存字节数（非 `memory`） */
  memory_bytes?: number;
  started_at?: number;
}

/** 服务项（对齐 manifest system.service.list 契约）。 */
export interface ServiceEntry {
  name: string;
  display_name?: string;
  /** 运行状态字段名是 `state`，不是 `status` */
  state?: string;
  start_type?: string;
}

export interface FsEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "other";
  size: number;
  mtime: number;
}

export interface FsListResult {
  entries: FsEntry[];
  total: number;
  truncated: boolean;
}

export interface FsReadResult {
  data: string;
  encoding: string;
  offset: number;
  bytes: number;
  total_bytes: number;
  eof: boolean;
  sha256?: string;
}

/** 已装软件项（对齐 manifest app.list 契约）。 */
export interface AppEntry {
  name: string;
  version?: string;
  publisher?: string;
  /** 'registry' | 'uwp' | 'winget' 等来源标记 */
  source?: string;
}

/** 审计事件类别（对齐 apps/agent/src/audit.ts 的 `AuditType`）。 */
export type AuditType =
  | "agent.start"
  | "agent.stop"
  | "auth.success"
  | "auth.failure"
  | "invoke"
  | "acl.denied"
  | "capability.disabled"
  | "rate.limited"
  | "net.change"
  | "net.deny"
  | "agent.update";

export interface AuditEntry {
  ts?: number;
  type?: AuditType | string;
  client_id?: string;
  remote?: string;
  capability?: string;
  status?: "ok" | "failed" | "denied";
  duration_ms?: number;
  error?: string | null;
  /** 参数摘要（sha256 前缀）——默认只记摘要，不记内容 */
  args_digest?: string;
  /** 参数预览（仅 `log_args:true` 时记录，键含敏感词自动脱敏） */
  args_preview?: string;
  reason?: string;
  /** v11 防篡改：上一条哈希（首条为 "genesis"） */
  prev?: string;
  /** v11 防篡改：本条哈希 */
  hash?: string;
}

export interface AuditListResult {
  entries: AuditEntry[];
  total: number;
  file?: string;
}

/** 审计链首个异常位置（`ok:false` 时存在）。 */
export interface AuditBrokenAt {
  file?: string;
  line?: number;
  reason?: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  /** 无链字段的历史条目数（跳过校验） */
  legacy?: number;
  /** 是**对象**而非数字 */
  broken_at?: AuditBrokenAt | null;
}
