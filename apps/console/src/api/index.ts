/** Tauri command 调用封装（前端 → Rust 壳 → Node sidecar → 被控端）。 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentActionResult,
  AgentLogPage,
  AgentStatus,
  ApplyUpdateResult,
  AutostartStatus,
  CapabilityDescriptor,
  ConnectInfo,
  ConsoleSettings,
  ConsoleSystemInfo,
  InvokeResult,
  UpdateInfo,
} from "../types";

/** 建立连接并握手。 */
export function connect(url: string, key: string, clientId = "console", insecure = true) {
  return invoke<ConnectInfo>("connect", { url, key, clientId, insecure });
}

/** 断开连接（停自动重连）。 */
export function disconnect() {
  return invoke<void>("disconnect");
}

/** 泛型能力调用（`timeoutMs` 用于长任务，如装软件 / 长命令）。 */
export function call<T = unknown>(
  capability: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number,
) {
  return invoke<InvokeResult<T>>("invoke_capability", { capability, args, timeoutMs });
}

/** 当前连接的能力清单。 */
export function getCapabilities() {
  return invoke<CapabilityDescriptor[]>("get_capabilities");
}

/** 当前连接状态字符串。 */
export function getState() {
  return invoke<string>("get_state");
}

/**
 * 能力调用失败（业务层失败，非传输层失败）。
 *
 * 协议真源 `InvokeResult.error` 只有 `{ name, message, data? }` —— **不含 code**，
 * 所以分支判断一律走 `name`（如 `E_UNSUPPORTED_PLATFORM`）。
 */
export class CapabilityFailure extends Error {
  readonly capability: string;
  readonly errorName: string;
  readonly data?: unknown;

  constructor(capability: string, errorName: string, message: string, data?: unknown) {
    super(message);
    this.name = "CapabilityFailure";
    this.capability = capability;
    this.errorName = errorName;
    this.data = data;
  }
}

/** 被控端平台不支持该能力（如 macOS 被控端上的 app.* / system.service.list）。 */
export function isUnsupportedPlatform(e: unknown): boolean {
  return e instanceof CapabilityFailure && e.errorName === "E_UNSUPPORTED_PLATFORM";
}

/** 能力被 ACL 拒绝。 */
export function isAclDenied(e: unknown): boolean {
  return e instanceof CapabilityFailure && e.errorName === "E_ACL_DENIED";
}

/** 能力被调用限速拦截。 */
export function isRateLimited(e: unknown): boolean {
  return e instanceof CapabilityFailure && e.errorName === "E_RATE_LIMITED";
}

/**
 * 调用并要求成功：失败时抛出 `CapabilityFailure`（携带被控端 error.name）。
 * 便于页面里 `await ok("fs.list", { path })` 直接拿数据。
 */
export async function ok<T = unknown>(
  capability: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T> {
  const res = await call<T>(capability, args, timeoutMs);
  if (res.status !== "ok") {
    throw new CapabilityFailure(
      capability,
      res.error?.name ?? "E_UNKNOWN",
      res.error?.message ?? `${capability} 执行失败`,
      res.error?.data,
    );
  }
  return res.data as T;
}

// ---------------------------------------------------------------------------
// 本机服务（本机被控端）—— 全部走 Tauri command，不经被控端协议
// ---------------------------------------------------------------------------

/** 本机服务总览：进程状态 + 配置 + 自启 + 设置 + 版本。 */
export function agentStatus() {
  return invoke<AgentStatus>("agent_status");
}

/** 启动本机被控端。`autoRestart` 省略时取设置里的值。 */
export function agentStart(autoRestart?: boolean) {
  return invoke<AgentActionResult>("agent_start", { autoRestart });
}

/** 停止本机被控端（幂等）。 */
export function agentStop() {
  return invoke<AgentActionResult>("agent_stop");
}

/** 重启本机被控端。 */
export function agentRestart(autoRestart?: boolean) {
  return invoke<AgentActionResult>("agent_restart", { autoRestart });
}

/**
 * 退出控制台（由前端的确认框调用）。
 *
 * `keepAgent = true` 保留被控端继续运行 —— 它将成为孤儿进程，
 * 下次启动控制台时会被「复用」逻辑接管；`false` 则先停掉再退出。
 */
export function quitApp(keepAgent: boolean) {
  return invoke<void>("quit_app", { keepAgent });
}

/** 增量取日志（传上次拿到的最大 seq）。 */
export function agentLogs(since = 0) {
  return invoke<AgentLogPage>("agent_logs", { since });
}

/** 清空日志缓冲。 */
export function agentLogsClear() {
  return invoke<void>("agent_logs_clear");
}

/** 开机自启状态。 */
export function autostartStatus() {
  return invoke<AutostartStatus>("autostart_status");
}

/** 开关开机自启。 */
export function autostartSet(enabled: boolean) {
  return invoke<AutostartStatus>("autostart_set", { enabled });
}

/** 检查更新（比对最新 Release）。 */
export function checkUpdate() {
  return invoke<UpdateInfo>("check_update");
}

/** 应用更新：下载 → 校验 → 替换本机被控端脚本 → 重启。 */
export function applyUpdate(url: string, sha256: string, version: string) {
  return invoke<ApplyUpdateResult>("apply_update", { url, sha256, version });
}

/** 读设置。 */
export function settingsGet() {
  return invoke<ConsoleSettings>("settings_get");
}

/** 合并式写设置（只传要改的字段）。 */
export function settingsSet(patch: Partial<ConsoleSettings>) {
  return invoke<ConsoleSettings>("settings_set", { patch });
}

/** 控制台自身信息。 */
export function systemInfo() {
  return invoke<ConsoleSystemInfo>("system_info");
}
