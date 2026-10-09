/**
 * 枚举可见顶层窗口 → JSON（**不含 prelude**，供常驻助手与一次性路径复用）
 *
 * 2026-10 从 window.ts 抽出（结构拆分，**内容逐字节不变**）。
 * ⚠️ WIN_HELPER_PRELUDE 是本段与另外几段的拼接 —— 改动会直接影响常驻 PS 助手。
 * 拆分以 tests/unit/win-prelude.test.mjs + prelude sha256 比对双重把关。
 */

/**
 * 枚举可见顶层窗口 → JSON（**不含 prelude**，供常驻助手与一次性路径复用）。
 * 注意：本段会被送进常驻进程执行，**严禁出现 exit**（会杀掉助手进程）。
 */
export const LIST_BODY = `
$fg = [NAWin32]::GetForegroundWindow()
$list = New-Object System.Collections.ArrayList
$cb = [NAWin32+EnumProc]{
  param($h, $l)
  if (-not [NAWin32]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][NAWin32]::GetWindowTextW($h, $sb, 512)
  $title = $sb.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $r = New-Object NAWin32+RECT
  if (-not [NAWin32]::GetWindowRect($h, [ref]$r)) { return $true }
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  if ($w -le 0 -or $ht -le 0) { return $true }
  # ⚠️ 变量名不能叫 $pid —— 它是 PowerShell 的自动变量（当前进程 ID），赋值会被忽略，
  #    导致所有窗口都报成 powershell 进程（真机踩过）。
  $procId = 0
  [void][NAWin32]::GetWindowThreadProcessId($h, [ref]$procId)
  $pn = ''
  try { $pn = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  [void]$list.Add([pscustomobject]@{
    hwnd = ('0x{0:X}' -f $h.ToInt64()); title = $title; process = $pn; pid = $procId
    x = $r.Left; y = $r.Top; width = $w; height = $ht
    is_foreground = ($h -eq $fg); is_minimized = [NAWin32]::IsIconic($h)
  })
  return $true
}
[void][NAWin32]::EnumWindows($cb, [IntPtr]::Zero)
$list | ConvertTo-Json -Compress
`;
