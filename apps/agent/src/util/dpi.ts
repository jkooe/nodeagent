/**
 * Windows **DPI 感知** PowerShell 前置段（物理像素坐标的唯一真源）。
 *
 * ## 为什么必须有
 *
 * PowerShell 默认是「**DPI 不感知**」进程。在高 DPI（如 200% 缩放）下，这种进程里
 * **同时存在两套坐标系**，而且互不提醒：
 *
 * | 调用 | 该进程看到的 |
 * |---|---|
 * | `[System.Windows.Forms.Screen]::Bounds` | **逻辑**尺寸（物理 3600×2020 → 报 1800×1010） |
 * | `[System.Windows.Forms.SystemInformation]::VirtualScreen` | **逻辑**（同上） |
 * | `CopyFromScreen(0,0,1800,1010)` | **物理**裁剪 → 只截到屏幕左上 1/4 |
 * | `SetCursorPos(552,1489)` | 落点实际在物理 (1104, 2978)（被系统 ×2） |
 * | UIA（`screen.find`） | **物理**（与进程 DPI 感知无关） |
 *
 * 于是最要命的一条链路会静默断掉：`screen.find` 返回物理坐标 → 直接喂给
 * `input.mouse.click` → **点到两倍远的地方**（还可能被屏幕边界截断）。
 * 「找得到、点不准」，而且不报任何错。
 *
 * ## 用法
 *
 * 在 **任何** `System.Windows.Forms` / 截屏 / 光标调用**之前**执行本段；
 * 同一进程内只需一次（`SetProcessDPIAware` 幂等）。新起的 PowerShell 每次都要带上。
 *
 * ## 真机实证（2026-10-12）
 *
 * Parallels Win11 ARM 虚拟机，主机缩放 200%，物理 3600×2020：
 * - 缺省 `screen.capture` 只拿到 1800×1010（= 屏幕左上 1/4），且 `screen.info` 报 1800×1010
 * - `input.mouse.move 100,100` → DPI 感知读回 **(200,200)**
 * - `input.mouse.move 552,1489` → 实际落点 **(1104, 2019)**（截断到屏幕底部）
 * - 补上本段后：`screen.capture` 拿到完整 3600×2020；`screen.find` 的物理坐标
 *   可直接用于 `input.mouse.click`（同一坐标一次点中）
 *
 * ⚠️ 不要删。这不是「锦上添花」的兼容代码，而是坐标口径统一的**前提**。
 * 守卫见 `tests/unit/dpi-awareness.test.mjs`。
 */
export const PS_DPI_AWARE = [
  // Add-Type 现编译一个小 P/Invoke 壳；类名固定，每进程只应出现一次。
  `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class NADpiAware { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'`,
  `[void][NADpiAware]::SetProcessDPIAware()`,
].join('\n');
