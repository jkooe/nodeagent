/**
 * Win32 窗口枚举与矩形读取（供 window.list / window.focus 复用）
 *
 * 2026-10 从 window.ts 抽出（结构拆分，**内容逐字节不变**）。
 * ⚠️ WIN_HELPER_PRELUDE 是本段与另外几段的拼接 —— 改动会直接影响常驻 PS 助手。
 * 拆分以 tests/unit/win-prelude.test.mjs + prelude sha256 比对双重把关。
 */

export const WIN32_PRELUDE = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class NAWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
`;
