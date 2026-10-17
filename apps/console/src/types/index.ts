/** 协议类型镜像（对齐 `@nodeagent/protocol`，亦即 sidecar 与 Tauri command 的序列化形状）。 */

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
  /** 最后已知可用版本 LKG（交付流水线 §6 回滚锚点） */
  lkg?: LkgInfo;
}

/**
 * 最后已知可用版本（Last-Known-Good）。
 *
 * 只在「本次启动真正起来了」之后才由被控端写入 ——
 * 故 `matches=false` 意味着当前版本**尚未被证明能启动**（刚更新完、还没完成一次成功启动），
 * 界面应据此提示「暂缓向其余设备放量」。
 */
export interface LkgInfo {
  lkg?: {
    hash?: string;
    bytes?: number;
    script_path?: string;
    recorded_at?: number;
    node_version?: string;
    platform?: string;
  };
  current_hash?: string;
  matches?: boolean;
  byte_delta?: number;
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
  | "agent.update"
  | "session.idle_close"
  // v2.0.3：被拒请求统一留痕（U-01）+ 进程级兜底错误
  | "request.rejected"
  | "agent.error";

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

// ---------------------------------------------------------------------------
// 本机服务（本机被控端托管）—— 契约来源：src-tauri/src/agent.rs
// ---------------------------------------------------------------------------

/** 被控端进程状态机取值（与 Rust `agent::state` 一一对应）。 */
export type AgentState = "stopped" | "starting" | "running" | "stopping" | "crashed";

/** 本机被控端进程快照。 */
export interface AgentProcess {
  state: AgentState;
  pid?: number | null;
  started_at?: number | null;
  uptime_ms?: number | null;
  /** 自动重启已尝试次数 */
  restarts?: number;
  last_exit?: string | null;
  /** 实际使用的 node 可执行文件 */
  node?: string;
  /** 实际运行的那份 agent.mjs（在数据目录里，不在 app 包内） */
  script?: string;
  data_dir?: string;
  /**
   * true = 复用了**非本控制台启动**的被控端（退出控制台时选择「保留」而留下的孤儿）。
   *
   * 此时它已在监听、可直接「连接本机」使用；但拿不到子进程句柄，
   * 故「重启」会先按 PID 收掉再自己拉起（即把控制权收回本控制台）。
   */
  external?: boolean;
}

/** 被控端配置（读自 `<数据目录>/agent.json`）。 */
export interface AgentConfigInfo {
  data_dir: string;
  config_path: string;
  config_exists: boolean;
  node_id: string;
  port: number;
  tls: boolean;
  auth_mode: "psk" | "ed25519" | string;
  /** PSK 明文（本机展示用；它本就在用户自己的 600 权限文件里） */
  key: string;
  /** 端口是否已被监听（可能是一个非本控制台托管的实例） */
  port_in_use: boolean;
  url: string;
}

export interface AutostartStatus {
  enabled: boolean;
  supported: boolean;
  /** 落地位置（plist 路径 / 计划任务名） */
  location: string;
  app_exe: string;
  /** 自启时传给应用的模式参数 */
  mode: string;
  note: string;
  /** 本次操作详情（开关后返回） */
  detail?: string;
}

export interface ConsoleSettings {
  auto_start_agent: boolean;
  auto_restart: boolean;
  close_to_tray: boolean;
  insecure: boolean;
}

export interface AgentStatus {
  manager: AgentProcess;
  config: AgentConfigInfo;
  autostart: AutostartStatus;
  settings: ConsoleSettings;
  app_version: string;
  config_dir: string;
  /** 数据目录里那份脚本的版本（被控端自更新或控制台更新后写入） */
  installed_agent_version?: string | null;
  /** 随包内置的 agent.mjs 路径 */
  bundled_agent?: string;
}

export interface AgentActionResult {
  state?: AgentState;
  pid?: number | null;
  note?: string;
  port_released?: boolean;
}

export interface AgentLogLine {
  seq: number;
  ts: number;
  /** stdout / stderr / system */
  stream: string;
  line: string;
}

export interface AgentLogPage {
  lines: AgentLogLine[];
  total: number;
}

export interface UpdateInfo {
  console_version: string;
  latest_version: string;
  has_update: boolean;
  agent_has_update?: boolean;
  installed_agent_version?: string;
  published_at?: string | null;
  commit?: string | null;
  capabilities?: number | null;
  agent: { url?: string | null; sha256?: string | null; bytes?: number | null };
  release_url: string;
  source: string;
  /** 本次出网走的代理来源（`HTTPS_PROXY` / `system` / `NA_PROXY`…），直连为 null。
   *  2026-10-13 加：境内「检查更新」失败的排查线索，必须能在界面上看到。 */
  via_proxy?: string | null;
  /** 人类可读的出网路径描述（「直连」/「经代理 http://…」）。 */
  via?: string | null;
  checked_at: number;
}

export interface ApplyUpdateResult {
  updated: boolean;
  version: string;
  bytes: number;
  sha256: string;
  backup: string;
  restarted: boolean;
}

export interface ConsoleSystemInfo {
  app_version: string;
  config_dir: string;
  agent_data_dir: string;
  resource_dir: string;
  platform: string;
  arch: string;
  node: string;
  /** 是否以「仅服务模式」启动（开机自启时为 true） */
  agent_only: boolean;
}
