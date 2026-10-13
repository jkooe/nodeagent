/**
 * 平台能力守卫（跨平台最小实现）。
 *
 * ## 为什么要统一
 * 各能力原本各自判断平台，风格不一：
 *   - `darwin.ts` 有 `assertDarwin()`
 *   - `window.ts` 写 `if (platform === 'darwin') return macXxx()`，其余平台**静默走到 Windows 实现**，
 *     于是在 Linux 上表现为 `spawn /bin/bash ENOENT` 这类**误导性错误**（像是环境缺依赖，
 *     实际是"本平台根本没实现"）。
 *
 * 统一后的语义：**没实现就明确说"不支持当前平台"**（`E_UNSUPPORTED_PLATFORM`），
 * 并带上「支持哪些平台」，让调用方一眼看懂，也让能力清单的"声明可用"不至于撒谎。
 *
 * ## 用法
 * ```ts
 * assertPlatform('screen.capture', 'win32', 'darwin');
 * ```
 */

import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';

/** 人类可读的平台名（错误信息里用）。 */
const PLATFORM_LABEL: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

export function platformLabel(p: NodeJS.Platform): string {
  return PLATFORM_LABEL[p] ?? p;
}

/**
 * 当前平台是否在允许集合内。
 *
 * 与 `assertPlatform` 的分工：这个用于**条件注册/条件分支**，那个用于**进入能力时兜底拒绝**。
 */
export function isPlatform(...allowed: NodeJS.Platform[]): boolean {
  return allowed.includes(process.platform);
}

/**
 * 断言当前平台受支持；否则抛 `E_UNSUPPORTED_PLATFORM`。
 *
 * @param capability 能力名（写进错误信息，便于定位）
 * @param allowed    支持该能力的平台（如 `'win32', 'darwin'`）
 */
export function assertPlatform(capability: string, ...allowed: NodeJS.Platform[]): void {
  if (isPlatform(...allowed)) return;
  const supported = allowed.map(platformLabel).join(' / ');
  throw new CapabilityError(
    ErrorCodes.UNSUPPORTED_PLATFORM,
    `${capability} 未在 ${platformLabel(process.platform)} 上实现（仅支持 ${supported}）`,
    {
      platform: process.platform,
      supported,
    },
  );
}

/**
 * 仅 Windows 的能力（PowerShell / Win32 实现）。
 *
 * 覆盖：截屏与录屏、键鼠注入、剪贴板、音量、软件装卸（winget）、窗口与 UIA 语义。
 * 注意 **不含** `system.info` / `system.status` / `system.process.list` / `shell.exec` / `fs.*` ——
 * 这些有分平台实现，在 Linux 上可用。
 */
export function assertWindows(capability: string): void {
  assertPlatform(capability, 'win32');
}

/**
 * 图形界面类能力（Windows 或 macOS 有实现，Linux 目前没有）。
 *
 * 用于 `screen.*` / `window.*` / `input.*` 这类：在 Windows 走 Win32/UIA、
 * 在 macOS 走 AppleScript/Vision，**Linux 端尚未实现**（需 X11/Wayland 后端）。
 */
export function assertGuiPlatform(capability: string): void {
  assertPlatform(capability, 'win32', 'darwin');
}
