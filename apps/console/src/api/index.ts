/** Tauri command 调用封装（前端 → Rust 壳 → Node sidecar → 被控端）。 */
import { invoke } from "@tauri-apps/api/core";
import type { CapabilityDescriptor, ConnectInfo, InvokeResult } from "../types";

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
