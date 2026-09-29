import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';

type Args = Record<string, unknown>;

export interface RecordResult {
  dir: string;
  frames: number;
  requested_frames: number;
  elapsed_ms: number;
  fps: number;
  video_path?: string;
  /** 无 ffmpeg 时为 true：调用方按帧取回（fs.read / pull） */
  frames_only: boolean;
  message: string;
}

/** 从混杂输出中取第一个 JSON 对象（PowerShell 可能夹杂其他输出）。 */
function extractJsonObj(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 帧循环脚本（一次 PowerShell 调用内完成 N 帧，避免每帧一个进程的开销）。 */
function frameLoopScript(opts: {
  dir: string;
  total: number;
  interval: number;
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  const { dir, total, interval, x, y, width, height } = opts;
  const dirEsc = dir.replace(/\\/g, '\\\\');
  return [
    'Add-Type -AssemblyName System.Drawing',
    `$dir = '${dirEsc}'`,
    `$total = ${total}`,
    `$interval = ${interval}`,
    `$x = ${x}; $y = ${y}; $w = ${width}; $h = ${height}`,
    '$sw = [System.Diagnostics.Stopwatch]::StartNew()',
    'for ($i = 1; $i -le $total; $i++) {',
    '  $t0 = $sw.ElapsedMilliseconds',
    '  $bmp = New-Object System.Drawing.Bitmap($w, $h)',
    '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
    '  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))',
    '  $g.Dispose()',
    "  $bmp.Save((Join-Path $dir ('frame_{0:D4}.jpg' -f $i)), [System.Drawing.Imaging.ImageFormat]::Jpeg)",
    '  $bmp.Dispose()',
    '  $spent = $sw.ElapsedMilliseconds - $t0',
    '  $wait = $interval - $spent',
    '  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }',
    '}',
    '$sw.Stop()',
    'Write-Output (@{ frames = $total; elapsed_ms = $sw.ElapsedMilliseconds; w = $w; h = $h } | ConvertTo-Json -Compress)',
  ].join('\n');
}

/** 有 ffmpeg 则把帧序列封装为 mp4（失败不报错，返回 null）。 */
async function tryMuxMp4(dir: string, fps: number): Promise<string | null> {
  const probe = await execCommand({
    command: 'if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { "yes" } else { "no" }',
    timeoutMs: 15_000,
  });
  if (!probe.stdout.includes('yes')) return null;
  const out = `${dir}\\video.mp4`;
  const cmd = `ffmpeg -y -loglevel error -framerate ${fps} -i "${dir}\\\\frame_%04d.jpg" -c:v libx264 -pix_fmt yuv420p "${out}"`;
  const r = await execCommand({ command: cmd, timeoutMs: 120_000 });
  return r.exit_code === 0 ? out : null;
}

/**
 * 录制屏幕为帧序列（可选封装 mp4）。
 *
 * 设计取舍：被控端**不保证**有 ffmpeg，故始终产出 JPEG 帧序列；若检测到 ffmpeg
 * 则额外封装 mp4。产物留在被控端目录，由调用方用 fs.read / pull 取回
 * —— 避免把大体积视频塞进单条 RPC 响应。
 */
export async function screenRecord(args: Args): Promise<unknown> {
  if (!IS_WINDOWS) {
    throw new CapabilityError(ErrorCodes.UNSUPPORTED_PLATFORM, 'screen.record 当前仅支持 Windows 被控端', {
      platform: process.platform,
    });
  }
  const durationMs = Math.max(1000, Math.min(60_000, (args['duration_ms'] as number | undefined) ?? 5000));
  const fps = Math.max(1, Math.min(10, (args['fps'] as number | undefined) ?? 2));
  const scale = Math.max(0.1, Math.min(1, (args['scale'] as number | undefined) ?? 0.5));
  const region = args['region'] as { x: number; y: number; width: number; height: number } | undefined;
  const total = Math.max(1, Math.round((durationMs / 1000) * fps));
  const interval = Math.round(1000 / fps);

  const dir = join(tmpdir(), `na-rec-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  // 区域：直接用给定矩形；全屏：先取虚拟屏尺寸再按 scale 缩小
  let x = region?.x ?? 0;
  let y = region?.y ?? 0;
  let width = region?.width ?? 0;
  let height = region?.height ?? 0;

  if (!region) {
    const probe = await execCommand({
      command:
        'Add-Type -AssemblyName System.Windows.Forms; Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public class NADPIR { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }\'; [void][NADPIR]::SetProcessDPIAware(); $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen; Write-Output ("{0},{1},{2},{3}" -f $vs.X, $vs.Y, $vs.Width, $vs.Height)',
      timeoutMs: 30_000,
    });
    const nums = probe.stdout.trim().split(',').map(Number);
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
      throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '读取屏幕尺寸失败', {
        detail: probe.stdout.slice(0, 200),
      });
    }
    x = nums[0]!;
    y = nums[1]!;
    width = Math.max(1, Math.round(nums[2]! * scale));
    height = Math.max(1, Math.round(nums[3]! * scale));
  }

  const r = await execCommand({
    command: frameLoopScript({ dir, total, interval, x, y, width, height }),
    timeoutMs: durationMs + 90_000,
    maxOutputBytes: 256 * 1024,
  });
  if (r.exit_code !== 0) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '录制失败', {
      detail: (r.stderr || r.stdout).slice(0, 400),
    });
  }
  const info = extractJsonObj(r.stdout);
  const frames = Number(info?.['frames'] ?? total);
  const video = await tryMuxMp4(dir, fps);

  const result: RecordResult = {
    dir,
    frames,
    requested_frames: total,
    elapsed_ms: Number(info?.['elapsed_ms'] ?? 0),
    fps,
    frames_only: !video,
    message: video
      ? `已录制 ${frames} 帧并封装 mp4：${video}（用 fs.read/pull 取回）`
      : `已录制 ${frames} 帧到 ${dir}（未检测到 ffmpeg，帧序列可用 fs.read/pull 取回）`,
  };
  if (video) result.video_path = video;
  return result;
}
