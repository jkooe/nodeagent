import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';
import { macScreenFind, macWindowFocus, macWindowList } from './darwin.js';

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
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
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
    // v12.3：macOS 走 AppleScript 实现（需辅助功能权限），其余平台明确不支持
    if (process.platform === 'darwin') return macWindowList(args);
    throw new CapabilityError(
      ErrorCodes.UNSUPPORTED_PLATFORM,
      'window.list 仅支持 Windows / macOS 被控端',
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
  // 前台窗口排最前：低 limit 时也不会把它截掉（真机踩过：被系统对话框抢占焦点却查不到）
  all.sort((a, b) => Number(b.is_foreground) - Number(a.is_foreground));
  return { windows: all.slice(0, limit), total: all.length };
}

// ---------------- window.focus ----------------

export async function windowFocus(args: Args): Promise<unknown> {
  if (!IS_WINDOWS) {
    if (process.platform === 'darwin') return macWindowFocus(args);
    throw new CapabilityError(
      ErrorCodes.UNSUPPORTED_PLATFORM,
      'window.focus 仅支持 Windows / macOS 被控端',
      { platform: process.platform },
    );
  }
  const title = args['title'] as string | undefined;
  const hwnd = args['hwnd'] as string | undefined;
  if (!title && !hwnd) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, '需提供 title（正则）或 hwnd');
  }
  // v12.2：等窗口出现（应用启动有延迟，一次性查找极易假失败）
  const waitMs = Math.max(0, Math.min(30_000, (args['wait_ms'] as number | undefined) ?? 0));
  if (waitMs > 0 && !hwnd) {
    const t0 = Date.now();
    let lastErr: unknown = null;
    while (Date.now() - t0 < waitMs) {
      try {
        return await focusOnce(title, hwnd);
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new CapabilityError(ErrorCodes.EXECUTION_FAILED, `等待 ${waitMs}ms 仍未找到窗口`, { title });
  }

  return focusOnce(title, hwnd);
}

/** 单次聚焦（供等待重试复用）。 */
async function focusOnce(title: string | undefined, hwnd: string | undefined): Promise<unknown> {
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

# ⚠️ SetForegroundWindow 会被 Windows 的前台锁定规则**静默否决**（真机踩过：
#    返回后 GetForegroundWindow 仍是别人，后续键鼠全打进错误窗口）。
#    故校验一次；未生效则在标题栏做一次真实点击 —— 点击比 API 更能说服系统切换前台。
$activatedBy = 'api'
if ([NAWin32]::GetForegroundWindow() -ne $h) {
  $rr = New-Object NAWin32+RECT
  [void][NAWin32]::GetWindowRect($h, [ref]$rr)
  $cx = [int](($rr.Left + $rr.Right) / 2)
  $cy = [int]($rr.Top + 8)          # 标题栏（避开内容区，避免误触按钮）
  [NAWin32]::SetCursorPos($cx, $cy) | Out-Null
  Start-Sleep -Milliseconds 120
  [NAWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)   # LEFTDOWN
  Start-Sleep -Milliseconds 60
  [NAWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)   # LEFTUP
  Start-Sleep -Milliseconds 350
  if ([NAWin32]::GetForegroundWindow() -eq $h) { $activatedBy = 'click' }
}
$r = New-Object NAWin32+RECT
[void][NAWin32]::GetWindowRect($h, [ref]$r)
$sb2 = New-Object System.Text.StringBuilder 512
[void][NAWin32]::GetWindowTextW($h, $sb2, 512)
[pscustomobject]@{
  found = $true; hwnd = ('0x{0:X}' -f $h.ToInt64()); title = $sb2.ToString()
  x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top)
  focused = ([NAWin32]::GetForegroundWindow() -eq $h)
  activated_by = $activatedBy
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
 * 在界面中查找 UI 元素并返回屏幕坐标。
 *
 * 两种引擎：
 * - UIA（Windows UI Automation）：标准 Win32/WPF/WinForms 控件精确命中
 * - OCR（Windows.Media.Ocr 截图识别）：自绘 UI（Electron/Qt/游戏）兜底
 *
 * 这是解决「看得到画面但读不懂界面」的关键能力：把元素名映射为可点击坐标。
 */
export async function screenFind(args: Args): Promise<unknown> {
  if (!IS_WINDOWS) {
    // macOS：无 UIA 等价物 → 截图 + Vision OCR（见 darwin.ts 的权限说明）
    if (process.platform === 'darwin') return macScreenFind(args);
    throw new CapabilityError(
      ErrorCodes.UNSUPPORTED_PLATFORM,
      'screen.find 仅支持 Windows / macOS 被控端',
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
  const method = (args['method'] as string | undefined) ?? 'auto'; // auto | uia | ocr
  // v12.2：等待语义 —— 界面常有动画/加载延迟，一次性查找极易假失败。
  // wait_ms > 0 时轮询直到命中或超时（返回 waited_ms 让调用方知情）。
  const waitMs = Math.max(0, Math.min(30_000, (args['wait_ms'] as number | undefined) ?? 0));
  const intervalMs = Math.max(100, Math.min(2000, (args['interval_ms'] as number | undefined) ?? 400));
  // v12.3：显式区域（优先于 window）：OCR 只截这一块，更快也更准
  const regionArg = args['region'] as
    | { x: number; y: number; width: number; height: number }
    | undefined;

  // ---------- UIA 引擎 ----------
  const uiaFind = async (): Promise<Record<string, unknown>[]> => {
    const ct = controlType ?? '';
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
// ⚠️ UIA 的 PropertyCondition 是**精确匹配**（IgnoreCase 只影响大小写），
//    实测「管理员: C:\WINDOWS\...」这类标题用 "管理员" 永远匹配不到。
//    故改为遍历后按子串过滤（并限制遍历规模，避免超大 UI 树卡住）。
$cond = [System.Windows.Automation.Condition]::TrueCondition
$ct = ${JSON.stringify(ct)}
if ($ct -ne '') {
  $ctObj = $null
  try { $ctObj = [System.Windows.Automation.ControlType]::$ct } catch {}
  if ($ctObj -ne $null) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctObj)
  }
}
$found = $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$out = New-Object System.Collections.ArrayList
$scanned = 0
foreach ($e in $found) {
  if ($out.Count -ge $limit) { break }
  $scanned++
  if ($scanned -gt 20000) { break }
  try {
    $nm = $e.Current.Name
    if ([string]::IsNullOrEmpty($nm)) { continue }
    if ($nm.IndexOf($text, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    $r = $e.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    $out.Add([pscustomobject]@{
      name = $nm
      control_type = ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\\\\.','')
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
    return toArray<Record<string, unknown>>(extractJson<Record<string, unknown>[]>(out) ?? []);
  };

  // ---------- OCR 引擎（截图 → Windows.Media.Ocr → 文字坐标） ----------
  const ocrFind = async (): Promise<Record<string, unknown>[]> => {
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Windows.Forms
# DPI 感知：保证截图像素与窗口矩形同为物理坐标
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class NADPI { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][NADPI]::SetProcessDPIAware()

$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]

# WinRT IAsyncOperation -> Task 等待辅助
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

# 截图区域：显式 region 优先 > 指定窗口 > 整块虚拟屏
$xv = ${regionArg ? regionArg.x : -1}
$yv = ${regionArg ? regionArg.y : -1}
$wv = ${regionArg ? regionArg.width : -1}
$hv = ${regionArg ? regionArg.height : -1}
$winRe = ${JSON.stringify(regionArg ? '' : windowTitle ?? '')}
$x = 0; $y = 0
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$w = $vs.Width; $h = $vs.Height
if ($xv -ge 0 -and $wv -gt 0) {
  $x = $xv; $y = $yv; $w = $wv; $h = $hv
} elseif ($winRe -ne '') {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class NAEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@
  $found = [IntPtr]::Zero
  $cb = [NAEnum+EnumProc]{
    param($wh, $l)
    if ([NAEnum]::IsWindowVisible($wh)) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][NAEnum]::GetWindowTextW($wh, $sb, 512)
      if ($sb.ToString() -match $winRe) { $script:found = $wh; return $false }
    }
    return $true
  }
  [void][NAEnum]::EnumWindows($cb, [IntPtr]::Zero)
  if ($found -ne [IntPtr]::Zero) {
    $r = New-Object NAEnum+RECT
    [void][NAEnum]::GetWindowRect($found, [ref]$r)
    $x = $r.Left; $y = $r.Top; $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  }
}
if ($w -le 0 -or $h -le 0) { Write-Output '[]'; exit 0 }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$g.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$ras = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
$writer = New-Object Windows.Storage.Streams.DataWriter($ras)
$writer.WriteBytes($ms.ToArray())
Await ($writer.StoreAsync()) ([UInt32]) | Out-Null
$writer.DetachStream()

$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
$soft = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { Write-Output '[]'; exit 0 }
$result = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])

$text = ${JSON.stringify(text)}
$limit = ${Number(limit)}
# Windows OCR 会在中文字符间插入空格（如「我的加速」识别为「我 的 加 速」），
# 因此匹配一律在「去除空白后」的文本上进行（两边同样处理）。
$textPlain = ${JSON.stringify(text)}.Replace(' ','')
if ($textPlain -eq '') { $textPlain = ($text -replace '\\s','') }
$out = New-Object System.Collections.ArrayList
foreach ($line in $result.Lines) {
  if ($out.Count -ge $limit) { break }
  $linePlain = ($line.Text -replace '\\s','')
  if ($linePlain.IndexOf($textPlain, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
  # 优先单个词直接命中
  $best = $null
  foreach ($word in $line.Words) {
    $wp = ($word.Text -replace '\\s','')
    if ($wp.IndexOf($textPlain, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $best = $word; break }
  }
  if ($null -eq $best) {
    # 最小词窗口：从每个词起累积，找到拼接后包含目标的连续词段 → 并集矩形（精确）
    $words = @($line.Words)
    for ($i = 0; $i -lt $words.Count -and $null -eq $best; $i++) {
      $acc = ''
      for ($j = $i; $j -lt $words.Count; $j++) {
        $acc += ($words[$j].Text -replace '\\s','')
        if ($acc.Length -ge $textPlain.Length) {
          if ($acc.IndexOf($textPlain, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $x1 = [double]::MaxValue; $y1 = [double]::MaxValue; $x2 = [double]::MinValue; $y2 = [double]::MinValue
            for ($k = $i; $k -le $j; $k++) {
              $r = $words[$k].BoundingRect
              $x1 = [Math]::Min($x1, $r.X); $y1 = [Math]::Min($y1, $r.Y)
              $x2 = [Math]::Max($x2, $r.X + $r.Width); $y2 = [Math]::Max($y2, $r.Y + $r.Height)
            }
            $best = @{ X = $x1; Y = $y1; Width = ($x2 - $x1); Height = ($y2 - $y1); Text = ($words[$i..$j] | ForEach-Object { $_.Text }) -join ' ' }
          }
          break
        }
      }
    }
  }
  if ($null -ne $best) {
    # 两种形态：OcrWord（有 BoundingRect）或最小词窗口并集（hashtable）
    if ($best -is [hashtable]) {
      $bx = $best.X; $by = $best.Y; $bw = $best.Width; $bh = $best.Height
      $nm = $best.Text
    } else {
      $r = $best.BoundingRect
      $bx = $r.X; $by = $r.Y; $bw = $r.Width; $bh = $r.Height
      $nm = $best.Text
    }
    [void]$out.Add([pscustomobject]@{
      name = $nm; control_type = 'Text(ocr)'
      x = [int]($bx + $bw / 2 + $x); y = [int]($by + $bh / 2 + $y)
      left = [int]($bx + $x); top = [int]($by + $y); width = [int]$bw; height = [int]$bh
    })
  } else {
    # 兜底：整行词并集
    $x1 = [double]::MaxValue; $y1 = [double]::MaxValue; $x2 = [double]::MinValue; $y2 = [double]::MinValue
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      $x1 = [Math]::Min($x1, $r.X); $y1 = [Math]::Min($y1, $r.Y)
      $x2 = [Math]::Max($x2, $r.X + $r.Width); $y2 = [Math]::Max($y2, $r.Y + $r.Height)
    }
    [void]$out.Add([pscustomobject]@{
      name = $line.Text; control_type = 'Text(ocr)'
      x = [int](($x1 + $x2) / 2 + $x); y = [int](($y1 + $y2) / 2 + $y)
      left = [int]($x1 + $x); top = [int]($y1 + $y); width = [int]($x2 - $x1); height = [int]($y2 - $y1)
    })
  }
}
$out | ConvertTo-Json -Compress
`;
    const out = await runPS(script, 90_000);
    return toArray<Record<string, unknown>>(extractJson<Record<string, unknown>[]>(out) ?? []);
  };

  /** 单次尝试（按 method 选择引擎）。 */
  const attempt = async (): Promise<{ matches: Record<string, unknown>[]; engine: string }> => {
    if (method === 'uia') return { matches: (await uiaFind()).slice(0, limit), engine: 'uia' };
    if (method === 'ocr') return { matches: (await ocrFind()).slice(0, limit), engine: 'ocr' };
    // auto：UIA 优先（快且带控件语义），找不到再 OCR 兜底（自绘 UI）
    const uiaMatches = await uiaFind();
    if (uiaMatches.length > 0) return { matches: uiaMatches.slice(0, limit), engine: 'uia' };
    const ocrMatches = await ocrFind();
    return { matches: ocrMatches.slice(0, limit), engine: 'ocr' };
  };

  const startedAt = Date.now();
  let last = await attempt();
  while (last.matches.length === 0 && Date.now() - startedAt < waitMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await attempt();
  }
  return {
    matches: last.matches,
    engine: last.engine,
    waited_ms: Date.now() - startedAt,
    ...(waitMs > 0 ? { wait_ms: waitMs } : {}),
  };
}
