import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';

type Args = Record<string, unknown>;

/**
 * 图片类剪贴板操作必须走**临时文件**：
 * 命令行参数在 Windows 上有 ~32KB 上限，而截图 base64 常达数 MB；
 * execCommand 的 stdout 亦有截断阈值。故改为「PS 写文件 → Node 读文件」绕开限制。
 */
function withTempFile<T>(ext: string, fn: (p: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'na-clip-'));
  const p = join(dir, `clip.${ext}`);
  return fn(p).finally(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  });
}

function psPath(p: string): string {
  return p.replace(/\\/g, '\\\\');
}

// ---------------- clip.get ----------------

export async function clipGet(args: Args = {}): Promise<unknown> {
  const format = (args['format'] as string | undefined) ?? 'auto';

  if (IS_WINDOWS) {
    if (format === 'image' || format === 'auto') {
      const img = await getImageWindows();
      if (img) return img;
      if (format === 'image') {
        throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '剪贴板中没有图片');
      }
    }
    const r = await execCommand({
      command: 'Get-Clipboard -Raw -ErrorAction SilentlyContinue',
      timeoutMs: 10_000,
    });
    return { type: 'text', text: r.stdout };
  }

  const r = await execCommand({
    command: 'pbpaste 2>/dev/null || xclip -selection clipboard -o 2>/dev/null',
    timeoutMs: 10_000,
  });
  return { type: 'text', text: r.stdout };
}

/** Windows：剪贴板图片 → { type:'image', format:'png', image_base64, bytes }；无图返回 null。 */
async function getImageWindows(): Promise<Record<string, unknown> | null> {
  return withTempFile('png', async (p) => {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      'try {',
      '  $img = [System.Windows.Forms.Clipboard]::GetImage()',
      "  if ($null -eq $img) { Write-Output 'EMPTY' } else {",
      `    $img.Save('${psPath(p)}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      "    Write-Output 'OK'",
      '  }',
      "} catch { Write-Output 'EMPTY' }",
    ].join('\n');
    const r = await execCommand({ command: ps, timeoutMs: 30_000 });
    if (!r.stdout.includes('OK')) return null;
    const buf = readFileSync(p);
    return {
      type: 'image',
      format: 'png',
      image_base64: buf.toString('base64'),
      bytes: buf.length,
    };
  });
}

// ---------------- clip.set ----------------

export async function clipSet(args: Args): Promise<unknown> {
  const image = args['image_base64'] as string | undefined;
  const text = args['text'] as string | undefined;

  if (image !== undefined) {
    if (typeof image !== 'string' || image.length === 0) {
      throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'image_base64 不能为空');
    }
    return setImage(image);
  }

  if (typeof text !== 'string') {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, '需提供 text 或 image_base64');
  }

  if (IS_WINDOWS) {
    // 文本经 base64 传输，避免命令行参数编码问题（PS 对非 ASCII 参数不可靠）
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const r = await execCommand({
      command: `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
      timeoutMs: 10_000,
    });
    if (r.exit_code !== 0) {
      throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '写入剪贴板失败', {
        detail: r.stderr.slice(0, 300),
      });
    }
  } else {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const r = await execCommand({
      command: `echo '${b64}' | base64 -d | (pbcopy 2>/dev/null || xclip -selection clipboard -i 2>/dev/null)`,
      timeoutMs: 10_000,
    });
    if (r.exit_code !== 0) {
      throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '写入剪贴板失败', {
        detail: r.stderr.slice(0, 300),
      });
    }
  }
  return { type: 'text', written: text.length };
}

/** Windows：base64 PNG → 临时文件 → 剪贴板图片。 */
async function setImage(b64: string): Promise<Record<string, unknown>> {
  if (!IS_WINDOWS) {
    throw new CapabilityError(ErrorCodes.UNSUPPORTED_PLATFORM, '图片剪贴板当前仅支持 Windows 被控端', {
      platform: process.platform,
    });
  }
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'image_base64 解码后为空');
  }
  return withTempFile('png', async (p) => {
    writeFileSync(p, bytes);
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      `$bytes = [System.IO.File]::ReadAllBytes('${psPath(p)}')`,
      '$ms = New-Object System.IO.MemoryStream(,$bytes)',
      '$img = [System.Drawing.Image]::FromStream($ms)',
      '[System.Windows.Forms.Clipboard]::SetImage($img)',
      "Write-Output 'OK'",
    ].join('\n');
    const r = await execCommand({ command: ps, timeoutMs: 30_000 });
    if (!r.stdout.includes('OK')) {
      throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '写入剪贴板图片失败', {
        detail: (r.stderr || r.stdout).slice(0, 300),
      });
    }
    return { type: 'image', written_bytes: bytes.length };
  });
}
