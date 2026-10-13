import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';
import { shLit } from '../util/quote.js';
import { PS_DPI_AWARE } from '../util/dpi.js';

type Args = Record<string, unknown>;

interface Display {
  id: number;
  name: string;
  width: number;
  height: number;
  is_primary: boolean;
  scale: number;
  /** 相对虚拟桌面原点的偏移（多屏时用于定位 region） */
  x: number;
  y: number;
}

function toArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** 截屏 base64 上限（超出即截断，避免返回损坏数据） */
const MAX_CAPTURE_BYTES = 40 * 1024 * 1024;

// ---------------- screen.info ----------------

/**
 * listDisplays 下发给 PowerShell 的脚本。
 *
 * 导出**仅供单测断言**（检查 DPI 感知确实注入且位于坐标 API 之前）——
 * 真机 2026-10-12 的「缺省整屏只截到左上 1/4」就是这里漏了 DPI 感知，
 * 源码扫描式守卫抓不到（文件里别处也引用了 PS_DPI_AWARE）。
 */
export function buildListDisplaysScript(): string {
  return [
    // ⚠️ 必须最先执行：不设 DPI 感知时，`Screen.Bounds` 返回的是**逻辑**尺寸，
    // 而 `CopyFromScreen` 又按**物理**像素裁剪 → 缺省整屏截图只截到左上 1/4
    //（200% 缩放下 3600×2020 的桌面报成 1800×1010）。真机 2026-10-12 实证。
    PS_DPI_AWARE,
    'Add-Type -AssemblyName System.Windows.Forms',
    '$s = [System.Windows.Forms.Screen]::AllScreens',
    // 读取 DPI 缩放（HKCU AppliedDPI；读不到则按 100% 处理）。
    // 注意：设了 DPI 感知后 Bounds 已是**物理**像素，scale 仅作参考信息保留。
    '$dpi = (Get-ItemProperty -Path "HKCU:\\Control Panel\\Desktop\\WindowMetrics" -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI',
    '$scale = if ($dpi) { [math]::Round($dpi / 96.0, 2) } else { 1.0 }',
    '$out = @()',
    'for ($i = 0; $i -lt $s.Count; $i++) {',
    '  $d = $s[$i]',
    '  $out += [pscustomobject]@{ id = $i; name = $d.DeviceName; width = $d.Bounds.Width; height = $d.Bounds.Height; is_primary = $d.Primary; scale = $scale; x = $d.Bounds.X; y = $d.Bounds.Y }',
    '}',
    '$out | ConvertTo-Json -Compress',
  ].join('\n');
}

async function listDisplays(): Promise<Display[]> {
  if (IS_WINDOWS) {
    const r = await execCommand({ command: buildListDisplaysScript(), timeoutMs: 30_000 });
    if (r.exit_code !== 0) {
      throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '读取显示器信息失败', { detail: r.stderr.slice(0, 500) });
    }
    return toArray<Display>(r.stdout ? JSON.parse(r.stdout) : []);
  }

  // macOS / Linux（开发与测试用）
  const r = await execCommand({ command: 'system_profiler SPDisplaysDataType 2>/dev/null', timeoutMs: 30_000 });
  const m = /Resolution:\s*(\d+)\s*x\s*(\d+)/.exec(r.stdout);
  return [
    {
      id: 0,
      name: 'main',
      width: m ? Number(m[1]) : 0,
      height: m ? Number(m[2]) : 0,
      is_primary: true,
      scale: 1,
      x: 0,
      y: 0,
    },
  ];
}

export async function screenInfo(_args: Args): Promise<unknown> {
  const displays = await listDisplays();
  return {
    displays: displays.map(({ id, name, width, height, is_primary, scale }) => ({
      id,
      name,
      width,
      height,
      is_primary,
      scale,
    })),
  };
}

// ---------------- screen.capture ----------------

interface CaptureOpts {
  display_id: number;
  format: 'png' | 'jpeg';
  quality: number;
  scale: number;
  region?: { x: number; y: number; width: number; height: number };
}

interface CaptureResult {
  image: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  captured_at: number;
}

export async function screenCapture(args: Args): Promise<unknown> {
  const opts: CaptureOpts = {
    display_id: (args['display_id'] as number) ?? 0,
    format: (args['format'] as 'png' | 'jpeg') ?? 'jpeg',
    quality: (args['quality'] as number) ?? 85,
    scale: (args['scale'] as number) ?? 1,
    region: args['region'] as CaptureOpts['region'],
  };

  /**
   * ⚠️ S-01（v2.0.3）：region 的合法性检查必须放在**枚举显示器之前**。
   *
   * 两道闸的由来：被控端会照 region 直接 `New-Object Bitmap $w,$h`（32bpp ≈ 4×w×h 字节），
   * 一个 100000×100000 的请求足以吃光内存（≈40GB）→ 进程被杀。
   * 收敛为「单边 ≤ 16384（常见位图/纹理上限）+ 总像素 ≤ 32M（≈128MB）」。
   *
   * 放在枚举之前有两个理由：① 校验不依赖显示器信息，没理由先付出枚举成本；
   * ② 真要挡住的就是这种请求 —— 让它在任何副作用之前就失败（fail fast）。
   */
  if (opts.region) assertRegionSane(opts.region);

  const displays = await listDisplays();
  const display = displays[opts.display_id] ?? displays[0];
  if (!display) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `显示器 ${opts.display_id} 不存在`);
  }

  // region 缺省 = 整个目标屏；带上多屏偏移。
  // 缺省值也要过同一道闸：显示器自报异常尺寸时同样不能放行。
  const region = opts.region ?? { x: display.x, y: display.y, width: display.width, height: display.height };
  assertRegionSane(region);

  if (IS_WINDOWS) return captureWindows(opts, region);
  return capturePosix(opts, region);
}

/** region 上界校验（S-01）。缺省值与显式传入走**同一份**判据，避免两处漂移。 */
function assertRegionSane(region: NonNullable<CaptureOpts['region']>): void {
  if (region.width < 1 || region.height < 1) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'region 宽高必须 ≥ 1', { region });
  }
  const MAX_EDGE = 16384;
  const MAX_PIXELS = 33_554_432;
  if (region.width > MAX_EDGE || region.height > MAX_EDGE || region.width * region.height > MAX_PIXELS) {
    throw new CapabilityError(
      ErrorCodes.PARAM_INVALID,
      `region 过大：单边须 ≤ ${MAX_EDGE} 且总像素 ≤ ${MAX_PIXELS}（当前 ${region.width}×${region.height}）`,
      { region, max_edge: MAX_EDGE, max_pixels: MAX_PIXELS },
    );
  }
  if (![region.x, region.y, region.width, region.height].every((n) => Number.isFinite(n))) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'region 必须都是有限数字', { region });
  }
}

/** captureWindows 下发给 PowerShell 的脚本（导出**仅供单测断言**，同 buildListDisplaysScript）。 */
export function buildCaptureScript(
  region: { x: number; y: number; width: number; height: number },
  opts: { scale: number; format: string; quality: number },
): string {
  return [
    // ⚠️ 与 listDisplays 同理：region 是物理像素，进程也必须是 DPI 感知，
    // 否则「region 语义（物理）」与「进程坐标观（逻辑）」两套口径并存。
    PS_DPI_AWARE,
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Drawing',
    `$x = ${region.x}; $y = ${region.y}; $w = ${region.width}; $h = ${region.height}`,
    `$scale = ${opts.scale}; $fmt = '${opts.format}'; $q = ${opts.quality}`,
    '$bmp = New-Object System.Drawing.Bitmap $w, $h',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))',
    '$g.Dispose()',
    'if ($scale -lt 1) {',
    '  $nw = [Math]::Max(1, [int]($w * $scale)); $nh = [Math]::Max(1, [int]($h * $scale))',
    '  $small = New-Object System.Drawing.Bitmap $nw, $nh',
    '  $g2 = [System.Drawing.Graphics]::FromImage($small)',
    '  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '  $g2.DrawImage($bmp, 0, 0, $nw, $nh)',
    '  $g2.Dispose(); $bmp.Dispose(); $bmp = $small',
    '}',
    '$ms = New-Object System.IO.MemoryStream',
    "if ($fmt -eq 'jpeg') {",
    "  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    '  $eps = New-Object System.Drawing.Imaging.EncoderParameters 1',
    '  $eps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$q)',
    '  $bmp.Save($ms, $enc, $eps)',
    '} else {',
    '  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
    '}',
    '$bytes = $ms.ToArray()',
    '$bmpW = $bmp.Width; $bmpH = $bmp.Height',
    '$ms.Dispose(); $bmp.Dispose()',
    'Write-Output ("{0}|{1}|{2}" -f [Convert]::ToBase64String($bytes), $bmpW, $bmpH)',
  ].join('\n');
}

async function captureWindows(
  opts: CaptureOpts,
  region: { x: number; y: number; width: number; height: number },
): Promise<CaptureResult> {
  const r = await execCommand({
    command: buildCaptureScript(region, opts),
    timeoutMs: 60_000,
    maxOutputBytes: MAX_CAPTURE_BYTES,
  });
  if (r.exit_code !== 0) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '截屏失败', { detail: r.stderr.slice(0, 500) });
  }
  if (r.truncated) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '截屏数据超出上限被截断，请降低 scale 或改用 jpeg', {
      limitBytes: MAX_CAPTURE_BYTES,
    });
  }

  const parts = r.stdout.trim().split('|');
  if (parts.length !== 3) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '截屏返回格式异常', { preview: r.stdout.slice(0, 120) });
  }
  const [image, w, h] = parts as [string, string, string];
  return {
    image,
    format: opts.format,
    width: Number(w),
    height: Number(h),
    bytes: Math.floor((image.length * 3) / 4),
    captured_at: Date.now(),
  };
}

async function capturePosix(
  opts: CaptureOpts,
  region: { x: number; y: number; width: number; height: number },
): Promise<CaptureResult> {
  const { mkdtempSync, readFileSync, unlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'nodeagent-shot-'));
  const ext = opts.format === 'png' ? 'png' : 'jpg';
  const file = join(dir, `shot.${ext}`);

  // macOS 用 screencapture；区域用 -R x,y,w,h
  const cmd =
    `screencapture -x -t ${ext} -R ${region.x},${region.y},${region.width},${region.height} ${shLit(file)}`;
  const r = await execCommand({ command: cmd, timeoutMs: 30_000 });
  if (r.exit_code !== 0) {
    throw new CapabilityError(ErrorCodes.UNSUPPORTED_PLATFORM, '当前平台截屏不可用（需要 macOS 屏幕录制权限）', {
      detail: r.stderr.slice(0, 300),
    });
  }

  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* 忽略 */
    }
  }

  return {
    image: buf.toString('base64'),
    format: opts.format,
    width: region.width,
    height: region.height,
    bytes: buf.byteLength,
    captured_at: Date.now(),
  };
}
