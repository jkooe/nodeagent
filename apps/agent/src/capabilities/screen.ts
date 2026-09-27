import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';

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

async function listDisplays(): Promise<Display[]> {
  if (IS_WINDOWS) {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$s = [System.Windows.Forms.Screen]::AllScreens',
      // 读取 DPI 缩放（HKCU AppliedDPI；读不到则按 100% 处理）
      '$dpi = (Get-ItemProperty -Path "HKCU:\\Control Panel\\Desktop\\WindowMetrics" -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI',
      '$scale = if ($dpi) { [math]::Round($dpi / 96.0, 2) } else { 1.0 }',
      '$out = @()',
      'for ($i = 0; $i -lt $s.Count; $i++) {',
      '  $d = $s[$i]',
      '  $out += [pscustomobject]@{ id = $i; name = $d.DeviceName; width = $d.Bounds.Width; height = $d.Bounds.Height; is_primary = $d.Primary; scale = $scale; x = $d.Bounds.X; y = $d.Bounds.Y }',
      '}',
      '$out | ConvertTo-Json -Compress',
    ].join('\n');
    const r = await execCommand({ command: script, timeoutMs: 30_000 });
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

  const displays = await listDisplays();
  const display = displays[opts.display_id] ?? displays[0];
  if (!display) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `显示器 ${opts.display_id} 不存在`);
  }

  // region 缺省 = 整个目标屏；带上多屏偏移
  const region = opts.region ?? { x: display.x, y: display.y, width: display.width, height: display.height };
  if (region.width < 1 || region.height < 1) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'region 宽高必须 ≥ 1', { region });
  }

  if (IS_WINDOWS) return captureWindows(opts, region);
  return capturePosix(opts, region);
}

async function captureWindows(
  opts: CaptureOpts,
  region: { x: number; y: number; width: number; height: number },
): Promise<CaptureResult> {
  const script = [
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

  const r = await execCommand({ command: script, timeoutMs: 60_000, maxOutputBytes: MAX_CAPTURE_BYTES });
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
    `screencapture -x -t ${ext} -R ${region.x},${region.y},${region.width},${region.height} ${JSON.stringify(file)}`;
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
