import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';

type Args = Record<string, unknown>;

function toArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * 把 PowerShell 脚本编码为 UTF-16LE base64。
 * 用于承载含 C# 源码 / 大量引号的脚本，彻底规避转义问题。
 */
function encodePS(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function runPS(script: string, timeoutMs = 30_000): Promise<string> {
  const r = await execCommand({
    command: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePS(script)}`,
    timeoutMs,
  });
  if (r.exit_code !== 0) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '窗口操作失败', {
      detail: (r.stderr || r.stdout).slice(0, 600),
    });
  }
  return r.stdout.trim();
}

/**
 * 从混杂输出中提取 JSON。
 *
 * 背景：PowerShell 的 `Add-Type -AssemblyName` 等语句可能向 stdout 夹杂额外内容，
 * 直接 JSON.parse 会报 "Unexpected non-whitespace character after JSON"。
 * 这里按首个 `[`/`{` 到末个 `]`/`}` 截取，稳健取回 JSON 主体。
 */
function extractJson<T>(raw: string): T | null {
  if (!raw) return null;
  const starts = [raw.indexOf('['), raw.indexOf('{')].filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
  if (end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Win32 窗口枚举与矩形读取（供 window.list / window.focus 复用）。 */
const WIN32_PRELUDE = `
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
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
`;

/** 枚举可见顶层窗口 → JSON 字符串。 */
const LIST_SCRIPT = `${WIN32_PRELUDE}
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
  $pid = 0
  [void][NAWin32]::GetWindowThreadProcessId($h, [ref]$pid)
  $pn = ''
  try { $pn = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch {}
  [void]$list.Add([pscustomobject]@{
    hwnd = ('0x{0:X}' -f $h.ToInt64()); title = $title; process = $pn; pid = $pid
    x = $r.Left; y = $r.Top; width = $w; height = $ht
    is_foreground = ($h -eq $fg); is_minimized = [NAWin32]::IsIconic($h)
  })
  return $true
}
[void][NAWin32]::EnumWindows($cb, [IntPtr]::Zero)
$list | ConvertTo-Json -Compress
`;

interface WinInfo {
  hwnd: string;
  title: string;
  process: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  is_foreground: boolean;
  is_minimized: boolean;
}

// ---------------- window.list ----------------

export async function windowList(args: Args): Promise<unknown> {
  if (!IS_WINDOWS) {
    throw new CapabilityError(
      ErrorCodes.UNSUPPORTED_PLATFORM,
      'window.list 仅在被控端为 Windows 时可用',
      { platform: process.platform },
    );
  }
  const out = await runPS(LIST_SCRIPT, 40_000);
  let all: WinInfo[] = toArray<WinInfo>(extractJson<WinInfo[]>(out) ?? []);
  // 过滤掉 UWP 的隐形壳窗口（尺寸异常大且进程为 ApplicationFrameHost 的重复项保留）
  all = all.filter((w) => w.width > 40 && w.height > 40);

  const pattern = args['title_pattern'] as string | undefined;
  if (pattern) {
    const re = new RegExp(pattern, 'i');
    all = all.filter((w) => re.test(w.title));
  }
  const limit = (args['limit'] as number | undefined) ?? 50;
  return { windows: all.slice(0, limit) };
}

// ---------------- window.focus ----------------

export async function windowFocus(args: Args): Promise<unknown> {
  if (!IS_WINDOWS) {
    throw new CapabilityError(
      ErrorCodes.UNSUPPORTED_PLATFORM,
      'window.focus 仅在被控端为 Windows 时可用',
      { platform: process.platform },
    );
  }
  const title = args['title'] as string | undefined;
  const hwnd = args['hwnd'] as string | undefined;
  if (!title && !hwnd) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, '需提供 title（正则）或 hwnd');
  }

  const script = `${WIN32_PRELUDE}
$h = [IntPtr]::Zero
$want = ${JSON.stringify(hwnd ?? '')}
if ($want -ne '') { $h = [IntPtr][Convert]::ToInt64($want, 16) }
else {
  $re = ${JSON.stringify(title ?? '')}
  $fg = [NAWin32]::GetForegroundWindow()
  $found = [IntPtr]::Zero
  $cb = [NAWin32+EnumProc]{
    param($w, $l)
    if ([NAWin32]::IsWindowVisible($w)) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][NAWin32]::GetWindowTextW($w, $sb, 512)
      $t = $sb.ToString()
      if ($t -match $re) { $script:found = $w; return $false }
    }
    return $true
  }
  [void][NAWin32]::EnumWindows($cb, [IntPtr]::Zero)
  $h = $script:found
}
if ($h -eq [IntPtr]::Zero) { Write-Output '{"found":false}'; exit 0 }
[void][NAWin32]::ShowWindow($h, 9)   # SW_RESTORE
[void][NAWin32]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 400
$r = New-Object NAWin32+RECT
[void][NAWin32]::GetWindowRect($h, [ref]$r)
$sb2 = New-Object System.Text.StringBuilder 512
[void][NAWin32]::GetWindowTextW($h, $sb2, 512)
[pscustomobject]@{
  found = $true; hwnd = ('0x{0:X}' -f $h.ToInt64()); title = $sb2.ToString()
  x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top)
  focused = ([NAWin32]::GetForegroundWindow() -eq $h)
} | ConvertTo-Json -Compress
`;
  const out = await runPS(script, 40_000);
  const obj = extractJson<Record<string, unknown>>(out) ?? {};
  if (obj['found'] === false) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '未找到匹配的窗口', { title, hwnd });
  }
  delete obj['found'];
  return obj;
}

// ---------------- screen.find ----------------

const FIND_SCRIPT_PRELUDE = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
function Get-WinByTitle([string]$re) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $wins) {
    try {
      $t = $w.Current.Name
      if ($t -and $t -match $re) { return $w }
    } catch {}
  }
  return $null
}
`;

/**
 * 在界面中查找 UI 元素并返回屏幕坐标（UI Automation）。
 *
 * 这是解决「看得到画面但读不懂界面」的关键能力：把元素名映射为可点击坐标。
 */
export async function screenFind(args: Args): Promise<unknown> {
  if (!IS_WINDOWS) {
    throw new CapabilityError(
      ErrorCodes.UNSUPPORTED_PLATFORM,
      'screen.find 仅在被控端为 Windows 时可用',
      { platform: process.platform },
    );
  }
  const text = args['text'] as string;
  if (typeof text !== 'string' || text.length === 0) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'text 不能为空');
  }
  const windowTitle = args['window'] as string | undefined;
  const controlType = args['control_type'] as string | undefined;
  const limit = (args['limit'] as number | undefined) ?? 20;

  const ctypeMap: Record<string, string> = {
    Button: 'Button',
    MenuItem: 'MenuItem',
    Edit: 'Edit',
    Text: 'Text',
    ListItem: 'ListItem',
    CheckBox: 'CheckBox',
    RadioButton: 'RadioButton',
    ComboBox: 'ComboBox',
    Tab: 'TabItem',
    TreeItem: 'TreeItem',
    Hyperlink: 'Hyperlink',
    Image: 'Image',
  };
  const ct = controlType ? ctypeMap[controlType] ?? controlType : '';

  const script = `${FIND_SCRIPT_PRELUDE}
$text = ${JSON.stringify(text)}
$limit = ${Number(limit)}
$scope = [System.Windows.Automation.AutomationElement]::RootElement
$winTitle = ${JSON.stringify(windowTitle ?? '')}
if ($winTitle -ne '') {
  $w = Get-WinByTitle $winTitle
  if ($w -eq $null) { Write-Output '[]'; exit 0 }
  $scope = $w
}
$nameCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, $text,
  [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)
$ct = ${JSON.stringify(ct)}
if ($ct -ne '') {
  $ctObj = $null
  try { $ctObj = [System.Windows.Automation.ControlType]::$ct } catch {}
  if ($ctObj -ne $null) {
    $ctCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctObj)
    $cond = New-Object System.Windows.Automation.AndCondition($nameCond, $ctCond)
  } else { $cond = $nameCond }
} else { $cond = $nameCond }
$found = $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$out = New-Object System.Collections.ArrayList
foreach ($e in $found) {
  if ($out.Count -ge $limit) { break }
  try {
    $r = $e.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    $wt = ''
    try {
      $tw = $e.Current.ControlType.ProgrammaticName
      $wt = $tw
    } catch {}
    $out.Add([pscustomobject]@{
      name = $e.Current.Name
      control_type = ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\\.','')
      automation_id = $e.Current.AutomationId
      x = [int]($r.Left + $r.Width / 2)
      y = [int]($r.Top + $r.Height / 2)
      left = [int]$r.Left; top = [int]$r.Top
      width = [int]$r.Width; height = [int]$r.Height
    })
  } catch {}
}
$out | ConvertTo-Json -Compress
`;
  const out = await runPS(script, 60_000);
  const matches = toArray<Record<string, unknown>>(extractJson<Record<string, unknown>[]>(out) ?? []);
  return { matches: matches.slice(0, limit) };
}
