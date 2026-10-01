import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';
import { runPowerShellSmart } from '../util/ps-helper.js';
import { agentDir } from '../config.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * 执行「不含 prelude」的脚本主体：**优先常驻助手**（类型已预加载），
 * 助手不可用时自动回退到一次性脚本（自带 prelude），保证可用性不倒退。
 */
async function runPS(body: string, timeoutMs = 30_000): Promise<string> {
  try {
    const { stdout } = await runPowerShellSmart({
      body,
      prelude: WIN_HELPER_PRELUDE,
      timeoutMs,
      label: 'win',
      log: (level, msg) => {
        if (level === 'warn') console.error(`[ps-helper] ${msg}`);
      },
    });
    return stdout;
  } catch (err) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '窗口操作失败', {
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 600),
    });
  }
}

/** 一次性执行完整脚本（含 prelude）—— 尚未迁移到助手的路径暂用。 */
async function runPSRaw(script: string, timeoutMs = 30_000): Promise<string> {
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

/**
 * 枚举可见顶层窗口 → JSON（**不含 prelude**，供常驻助手与一次性路径复用）。
 * 注意：本段会被送进常驻进程执行，**严禁出现 exit**（会杀掉助手进程）。
 */
const LIST_BODY = `
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

/**
 * v14：常驻助手预加载段 —— 这些内容**只在助手启动时执行一次**。
 * 过去每次调用都重新编译 C# / 加载程序集，真机实测占单次耗时的绝大部分
 * （window.list 1267ms / window.focus 1631ms，其中「起进程+编译」是固定成本）。
 */
const UIA_ASSEMBLY_PRELUDE = `
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

# v14：按子串在给定 scope 内遍历查找（FindAll + 子串过滤）。
# UIA 的 PropertyCondition 只能精确匹配，故必须遍历后过滤；遍历规模设上限防超大 UI 树卡死。
function Find-UiaByText($scope, [string]$text, [int]$limit, [string]$ct) {
  $cond = [System.Windows.Automation.Condition]::TrueCondition
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
      [void]$out.Add([pscustomobject]@{
        name = $nm
        control_type = ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\\.','')
        automation_id = $e.Current.AutomationId
        x = [int]($r.Left + $r.Width / 2)
        y = [int]($r.Top + $r.Height / 2)
        left = [int]$r.Left; top = [int]$r.Top
        width = [int]$r.Width; height = [int]$r.Height
      })
    } catch {}
  }
  return ,$out
}
`;

/** 助手统一预加载段（window.list / window.focus / screen.find 共用同一个进程）。 */


/**
 * OCR 引擎预加载段（v14）：截图 / DPI / WinRT 类型与 Await 辅助函数。
 * 注意：WinRT 类型加载用 try/catch 包住 —— 个别环境缺组件时只应让 OCR 退化，
 * 不该让整个助手（连带 window.list/focus/UIA）起不来。
 */
const OCR_PRELUDE = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class NADPI { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
  [void][NADPI]::SetProcessDPIAware()
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
  $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  function global:Await($WinRtTask, $ResultType) {
    $asTask = $script:asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }
  $script:ocrReady = $true
} catch {
  $script:ocrReady = $false
}
`;


/**
 * 图像模板匹配预加载段（v15）。
 *
 * 动机：UIA 靠控件树、OCR 靠文字 —— **纯图标/无文字的控件**两者都抓不到（审查报告 §5.2 指出的盲区）。
 * 做法：把模板图与屏幕区域都转灰度，做**零均值归一化互相关（ZNCC）**；
 * 全分辨率逐像素太慢（3440×1440 屏 × 64×64 模板 ≈ 190 亿次），故**粗到精**：
 *   ① 1/4 分辨率全图扫描（约 8000 万次）取候选
 *   ② 对候选在全分辨率 ±10px 邻域精修
 * 编译一次常驻（随助手预加载），运行时纯 native 循环。
 * 亮度和对比度无关（ZNCC 归一化），故对主题/亮度变化不敏感。
 */
const IMAGE_MATCH_PRELUDE = `
Add-Type -AssemblyName System.Drawing
# ⚠️ Add-Type 的老坑：-AssemblyName 只把程序集加载进 PowerShell 会话，
#    编译 C# 时还必须显式 -ReferencedAssemblies，否则报「命名空间 System.Drawing
#    中不存在 Imaging」。真机踩过：编译失败会让整个助手起不来，并伴随误导性的
#    「找不到类型 System.Windows.Forms.SystemInformation」二次错误。
Add-Type @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class NAImageMatch {
  public class Hit { public int x; public int y; public int w; public int h; public double score; }

  private static byte[] Gray(Bitmap src, out int w, out int h) {
    w = src.Width; h = src.Height;
    var dst = new byte[w * h];
    var rect = new Rectangle(0, 0, w, h);
    Bitmap bmp = src.PixelFormat == PixelFormat.Format24bppRgb ? src : src.Clone(rect, PixelFormat.Format24bppRgb);
    var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    try {
      int stride = data.Stride;
      var buf = new byte[stride * h];
      Marshal.Copy(data.Scan0, buf, 0, buf.Length);
      for (int y = 0; y < h; y++) {
        int row = y * stride;
        for (int x = 0; x < w; x++) {
          int i = row + x * 3;
          // BGR -> luma (integer approximation of ITU-R BT.601)
          dst[y * w + x] = (byte)((buf[i + 2] * 77 + buf[i + 1] * 150 + buf[i] * 29) >> 8);
        }
      }
    } finally { bmp.UnlockBits(data); if (bmp != src) bmp.Dispose(); }
    return dst;
  }

  // Area-average downscale (coarse search layer)
  private static byte[] Downscale(byte[] src, int w, int h, int f, out int ow, out int oh) {
    ow = w / f; oh = h / f;
    var dst = new byte[ow * oh];
    for (int y = 0; y < oh; y++) {
      for (int x = 0; x < ow; x++) {
        int sum = 0;
        for (int dy = 0; dy < f; dy++) {
          int row = (y * f + dy) * w;
          for (int dx = 0; dx < f; dx++) sum += src[row + x * f + dx];
        }
        dst[y * ow + x] = (byte)(sum / (f * f));
      }
    }
    return dst;
  }

  // Zero-mean normalized cross correlation; 1.0 = identical
  private static double Zncc(byte[] S, int sw, int sx, int sy, byte[] T, int tw, int th) {
    int n = tw * th;
    double sumT = 0;
    for (int i = 0; i < n; i++) sumT += T[i];
    double meanT = sumT / n;

    double sumS = 0;
    for (int y = 0; y < th; y++) {
      int row = (sy + y) * sw + sx;
      for (int x = 0; x < tw; x++) sumS += S[row + x];
    }
    double meanS = sumS / n;

    double num = 0, dS = 0, dT = 0;
    for (int y = 0; y < th; y++) {
      int row = (sy + y) * sw + sx;
      int trow = y * tw;
      for (int x = 0; x < tw; x++) {
        double a = S[row + x] - meanS;
        double b = T[trow + x] - meanT;
        num += a * b; dS += a * a; dT += b * b;
      }
    }
    double den = Math.Sqrt(dS * dT);
    if (den < 1e-9) return 0;
    return num / den;
  }

  /**
   // (comment removed: ASCII only)
   // (comment removed: ASCII only)
   */
  public static string Match(string screenPath, string templatePath, int maxResults, double threshold, int searchX, int searchY, int searchW, int searchH) {
    var hits = new List<Hit>();
    using (var screenBmp = new Bitmap(screenPath))
    using (var tmplBmp = new Bitmap(templatePath)) {
      int sw, sh, tw, th;
      var S0 = Gray(screenBmp, out sw, out sh);
      var T0 = Gray(tmplBmp, out tw, out th);
      if (tw >= sw || th >= sh) return "[]";

      // Guard: a flat template carries no gradient information, so correlation is
      // undefined (ZNCC denominator ~ 0). Report it explicitly instead of silently
      // returning no hits - a uniform crop usually means the wrong region was picked.
      //
      // NOTE: build all JSON/string literals with the char constant Q.
      // Writing a backslash-quote inside a TS template literal collapses it to a bare
      // quote and breaks the C# compile - this trap bit this file twice.
      const char Q = '"';
      var ci0 = System.Globalization.CultureInfo.InvariantCulture;
      double tSum = 0, tSum2 = 0;
      for (int i = 0; i < T0.Length; i++) { tSum += T0[i]; tSum2 += (double)T0[i] * T0[i]; }
      double tMean = tSum / T0.Length;
      double tVar = (tSum2 / T0.Length) - (tMean * tMean);
      if (tVar < 4.0) {
        return "[" + "{" + Q + "__error" + Q + ":" + Q + "template_has_no_contrast" + Q
          + "," + Q + "variance" + Q + ":" + tVar.ToString("F2", ci0) + "}" + "]";
      }

      // Optional search window: crop a sub-image, then add the offset back to hit coords
      int ox = 0, oy = 0;
      if (searchW > 0 && searchH > 0) {
        ox = Math.Max(0, Math.Min(searchX, sw - 1));
        oy = Math.Max(0, Math.Min(searchY, sh - 1));
        int w = Math.Min(searchW, sw - ox), h = Math.Min(searchH, sh - oy);
        var sub = new byte[w * h];
        for (int y = 0; y < h; y++) Array.Copy(S0, (oy + y) * sw + ox, sub, y * w, w);
        S0 = sub; sw = w; sh = h;
      }

      const int F = 4;
      int sw4, sh4, tw4, th4;
      var S4 = Downscale(S0, sw, sh, F, out sw4, out sh4);
      var T4 = Downscale(T0, tw, th, F, out tw4, out th4);

      // (1) coarse scan: collect candidates.
      // NOTE: the pre-filter must be MUCH looser than the final threshold.
      // Downsampling lowers the correlation of the true position (typically 0.7-0.85
      // for a 0.9+ full-res match), so a tight pre-filter discards the right answer
      // before refinement ever runs (this exact bug made every match return empty).
      var cands = new List<Hit>();
      if (tw4 > 0 && th4 > 0 && tw4 <= sw4 && th4 <= sh4) {
        double preFilter = Math.Max(0.30, threshold - 0.30);
        double bestCoarse = -1; int bx4 = 0, by4 = 0;
        for (int y = 0; y <= sh4 - th4; y++) {
          for (int x = 0; x <= sw4 - tw4; x++) {
            double sc = Zncc(S4, sw4, x, y, T4, tw4, th4);
            if (sc > bestCoarse) { bestCoarse = sc; bx4 = x; by4 = y; }
            if (sc >= preFilter) cands.Add(new Hit { x = x * F, y = y * F, w = tw, h = th, score = sc });
          }
        }
        // Belt and braces: always keep the coarse best, even if it missed the pre-filter
        if (bestCoarse > 0) {
          bool seen = false;
          foreach (var c in cands) { if (Math.Abs(c.x - bx4 * F) < F && Math.Abs(c.y - by4 * F) < F) { seen = true; break; } }
          if (!seen) cands.Add(new Hit { x = bx4 * F, y = by4 * F, w = tw, h = th, score = bestCoarse });
        }
      }
      cands.Sort((a, b) => b.score.CompareTo(a.score));
      if (cands.Count > 40) cands.RemoveRange(40, cands.Count - 40);

      // (2) refine at full resolution within a +/-F*2 neighborhood
      foreach (var c in cands) {
        double best = -1; int bx = c.x, by = c.y;
        for (int dy = -F * 2; dy <= F * 2; dy++) {
          for (int dx = -F * 2; dx <= F * 2; dx++) {
            int x = c.x + dx, y = c.y + dy;
            if (x < 0 || y < 0 || x + tw > sw || y + th > sh) continue;
            double sc = Zncc(S0, sw, x, y, T0, tw, th);
            if (sc > best) { best = sc; bx = x; by = y; }
          }
        }
        if (best >= threshold) hits.Add(new Hit { x = bx + ox, y = by + oy, w = tw, h = th, score = best });
      }

      // (3) de-dup: non-maximum suppression (keep best within 8px)
      hits.Sort((a, b) => b.score.CompareTo(a.score));
      var final = new List<Hit>();
      foreach (var h in hits) {
        bool dup = false;
        foreach (var f in final) {
          if (Math.Abs(f.x - h.x) < 8 && Math.Abs(f.y - h.y) < 8) { dup = true; break; }
        }
        if (!dup) final.Add(h);
        if (final.Count >= maxResults) break;
      }

      var parts = new List<string>();
      foreach (var h in final) {
        // Build JSON by concatenation; reuse the shared Q / ci0 declared above.
        var ci = ci0;
        parts.Add("{" + Q + "x" + Q + ":" + h.x.ToString(ci) + "," + Q + "y" + Q + ":" + h.y.ToString(ci)
          + "," + Q + "width" + Q + ":" + h.w.ToString(ci) + "," + Q + "height" + Q + ":" + h.h.ToString(ci)
          + "," + Q + "score" + Q + ":" + h.score.ToString("F4", ci) + "}");
      }
      return "[" + String.Join(",", parts.ToArray()) + "]";
    }
  }

  // Capture a screen region to a file (avoids extra process round-trips)
  public static string Capture(string outPath, int x, int y, int w, int h) {
    using (var bmp = new Bitmap(w, h))
    using (var g = Graphics.FromImage(bmp)) {
      g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
      bmp.Save(outPath, ImageFormat.Png);
    }
    return outPath;
  }
}
"@ -ReferencedAssemblies System.Drawing
`;

/**
 * 助手统一预加载段（window.list / window.focus / screen.find 的 UIA/OCR/图像三引擎共用）。
 * ⚠️ 必须定义在四段之后（块级作用域），且**四段缺一不可** ——
 * 漏拼会被 esbuild tree-shake，直到运行时才报「找不到类型」（真机踩过）。
 * tests/unit/win-prelude.test.mjs 对此有回归断言。
 */
/**
 * 后台预热常驻助手（agent 启动后调用一次，不阻塞、失败无副作用）。
 *
 * 动机：助手的「首次调用」要付启动 + 类型预加载的固定成本（~1-3s）。
 * 若不预热，这笔成本会算在**第一个真实用户调用**头上（真机指标里能明显看到
 * window.list 的 P95 被抬高）。启动后主动预热，把成本挪到无人等待的时刻。
 */
export function warmupWindowHelper(): void {
  if (!IS_WINDOWS || process.env['NODEAGENT_NO_PS_HELPER']) return;
  setTimeout(() => {
    void runPowerShellSmart({
      body: "Write-Output 'warmup'",
      prelude: WIN_HELPER_PRELUDE,
      timeoutMs: 90_000,
      label: 'win',
      log: () => undefined,
    }).catch(() => {
      /* 预热失败无所谓：真实调用时仍会按原路径重试 */
    });
  }, 1500).unref?.();
}

export const WIN_HELPER_PRELUDE = `${WIN32_PRELUDE}
${UIA_ASSEMBLY_PRELUDE}
${OCR_PRELUDE}
${IMAGE_MATCH_PRELUDE}`;

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
  const out = await runPS(LIST_BODY, 40_000);
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
/**
 * 聚焦脚本主体（不含 prelude）。⚠️ 严禁 exit —— 会杀掉常驻助手进程；
 * 未找到时改为输出 `{"found":false}` 并 return。
 */
function focusBody(title: string | undefined, hwnd: string | undefined): string {
  return `
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
if ($h -eq [IntPtr]::Zero) { Write-Output '{"found":false}'; return }
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
}

/** 单次聚焦（供等待重试复用）。 */
async function focusOnce(title: string | undefined, hwnd: string | undefined): Promise<unknown> {
  const out = await runPS(focusBody(title, hwnd), 40_000);
  const obj = extractJson<Record<string, unknown>>(out) ?? {};
  if (obj['found'] === false) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '未找到匹配的窗口', { title, hwnd });
  }
  delete obj['found'];
  return obj;
}

// ---------------- screen.find ----------------

// v14：原 FIND_SCRIPT_PRELUDE 已并入 WIN_HELPER_PRELUDE（助手启动时预加载一次）

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
  const text = (args['text'] as string | undefined) ?? '';
  const wantImage = (args['method'] as string | undefined) === 'image';
  if (!wantImage && (typeof text !== 'string' || text.length === 0)) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'text 不能为空（method=image 时用 template 代替）');
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
  // v15：图像模板匹配
  const template = args['template'] as string | undefined;
  const threshold = Math.max(0.3, Math.min(0.999, (args['threshold'] as number | undefined) ?? 0.85));

  // ---------- UIA 引擎 ----------
  const uiaFind = async (): Promise<Record<string, unknown>[]> => {
    const ct = controlType ?? '';
    const body = `
$text = ${JSON.stringify(text)}
$limit = ${Number(limit)}
$ct = ${JSON.stringify(controlType ?? '')}
$winTitle = ${JSON.stringify(windowTitle ?? '')}
$out = New-Object System.Collections.ArrayList
if ($winTitle -ne '') {
  # 指定窗口：直接在该窗口子树内找
  $w = Get-WinByTitle $winTitle
  if ($w -eq $null) { Write-Output '[]'; return }   # 严禁 exit：会杀掉常驻助手
  $out = Find-UiaByText $w $text $limit $ct
} else {
  # v14 优化：先在前台窗口子树内找（典型只几百个元素，快一个数量级），
  # 找不到再退回全桌面遍历（原来每次都在全桌面上跑，真机实测 3.1~3.7s）。
  $fgEl = $null
  try {
    $fgEl = [System.Windows.Automation.AutomationElement]::FromHandle([NAWin32]::GetForegroundWindow())
  } catch {}
  if ($fgEl -ne $null) { $out = Find-UiaByText $fgEl $text $limit $ct }
  if ($out.Count -eq 0) {
    $out = Find-UiaByText ([System.Windows.Automation.AutomationElement]::RootElement) $text $limit $ct
  }
}
# ── 输出 ──（遍历与子串过滤已收敛到预加载的 Find-UiaByText，避免逻辑重复）
if ($out.Count -eq 0) { Write-Output '[]' } else { $out | ConvertTo-Json -Compress }
`;
    const out = await runPS(body, 60_000);
    return toArray<Record<string, unknown>>(extractJson<Record<string, unknown>[]>(out) ?? []);
  };

  // ---------- 图像模板引擎（灰度 ZNCC 粗到精，v15） ----------
  // 适用：纯图标 / 无文字的自绘控件（UIA 无控件树、OCR 无文字可读的盲区）
  const imageFind = async (): Promise<Record<string, unknown>[]> => {
    if (!template) {
      throw new CapabilityError(
        ErrorCodes.PARAM_INVALID,
        'method=image 需要 template 参数（被控端上的模板图片路径，支持 png/jpg/bmp）',
      );
    }
    const tmpDir = join(agentDir(), 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const shot = join(tmpDir, `match-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
    // PowerShell 单引号字面量：不插值（避免路径里的 $ 被展开）、不处理反斜杠转义。
    // 不能用 JSON.stringify —— 它会产出双引号串，而 PS 双引号会做变量插值且把 \ 当字面两个反斜杠。
    const q = (v: string): string => `'${v.replace(/'/g, "''")}'`;

    // 截图区域：显式 region 优先，否则整块虚拟屏
    const capX = regionArg ? regionArg.x : 'VSX';
    const capY = regionArg ? regionArg.y : 'VSY';
    const capW = regionArg ? regionArg.width : 'VSW';
    const capH = regionArg ? regionArg.height : 'VSH';

    const body = `
if (-not (Test-Path ${q(template)})) {
  Write-Output '{"__error":"模板文件不存在"}'
  return
}
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$cx = ${typeof capX === 'number' ? capX : '$vs.X'}
$cy = ${typeof capY === 'number' ? capY : '$vs.Y'}
$cw = ${typeof capW === 'number' ? capW : '$vs.Width'}
$ch = ${typeof capH === 'number' ? capH : '$vs.Height'}
try {
  [void][NAImageMatch]::Capture(${q(shot)}, $cx, $cy, $cw, $ch)
  $json = [NAImageMatch]::Match(${q(shot)}, ${q(template)}, ${Number(limit)}, ${threshold}, 0, 0, 0, 0)
  Write-Output $json
} catch {
  Write-Output ('{"__error":"' + $_.Exception.Message.Replace('"','''') + '"}')
} finally {
  Remove-Item ${q(shot)} -Force -ErrorAction SilentlyContinue
}
`;
    const out = await runPS(body, 120_000);
    type ImgHit = { x: number; y: number; width: number; height: number; score: number };
    const raw = extractJson<Record<string, unknown> | ImgHit[]>(out);
    if (raw && !Array.isArray(raw) && typeof raw === 'object' && '__error' in raw) {
      throw new CapabilityError(
        ErrorCodes.EXECUTION_FAILED,
        `图像匹配失败: ${String((raw as { __error?: string }).__error)}`,
      );
    }
    const hits: ImgHit[] = Array.isArray(raw) ? raw : [];
    // 模板纯色时 C# 会返回 [{__error:...}]（数组形式），这里统一转成可读错误
    const first = hits[0] as unknown as { __error?: string; variance?: number } | undefined;
    if (first && typeof first === 'object' && first.__error === 'template_has_no_contrast') {
      throw new CapabilityError(
        ErrorCodes.PARAM_INVALID,
        '模板几乎没有色彩/明暗差异（纯色或低对比），无法用于模板匹配；请改用有纹理或图标的区域',
        { variance: first.variance },
      );
    }
    return hits.map((h) => ({
      name: `image:${template.split(/[\\/]/).pop() ?? 'template'}`,
      control_type: 'Image(template)',
      score: h.score,
      // 命中坐标相对截图原点 -> 补回屏幕原点
      x: Math.round(capX === 'VSX' ? h.x + (regionArg?.x ?? 0) : h.x + Number(capX)),
      y: Math.round(capY === 'VSY' ? h.y + (regionArg?.y ?? 0) : h.y + Number(capY)),
      left: Math.round(capX === 'VSX' ? h.x + (regionArg?.x ?? 0) : h.x + Number(capX)),
      top: Math.round(capY === 'VSY' ? h.y + (regionArg?.y ?? 0) : h.y + Number(capY)),
      width: h.width,
      height: h.height,
    }));
  };

  // ---------- OCR 引擎（截图 → Windows.Media.Ocr → 文字坐标） ----------
  const ocrFind = async (): Promise<Record<string, unknown>[]> => {
    const body = `
# OCR 预加载段已在助手启动时完成（类型/DPI/Await）；此处只做本次逻辑
if ($null -eq $script:ocrReady -or -not $script:ocrReady) { Write-Output '[]'; return }
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
if ($w -le 0 -or $h -le 0) { Write-Output '[]'; return }

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
if ($null -eq $engine) { Write-Output '[]'; return }
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
    const out = await runPS(body, 90_000);
    return toArray<Record<string, unknown>>(extractJson<Record<string, unknown>[]>(out) ?? []);
  };

  /** 单次尝试（按 method 选择引擎）。 */
  const attempt = async (): Promise<{ matches: Record<string, unknown>[]; engine: string }> => {
    if (method === 'uia') return { matches: (await uiaFind()).slice(0, limit), engine: 'uia' };
    if (method === 'ocr') return { matches: (await ocrFind()).slice(0, limit), engine: 'ocr' };
    if (method === 'image') return { matches: (await imageFind()).slice(0, limit), engine: 'image' };
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
