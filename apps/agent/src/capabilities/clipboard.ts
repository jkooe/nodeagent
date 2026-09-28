import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';

type Args = Record<string, unknown>;

// ---------------- clip.get ----------------

export async function clipGet(_args: Record<string, unknown>): Promise<unknown> {
  if (IS_WINDOWS) {
    const r = await execCommand({
      command: 'Get-Clipboard -Raw -ErrorAction SilentlyContinue',
      timeoutMs: 10_000,
    });
    return { text: r.stdout };
  }
  const r = await execCommand({ command: 'pbpaste 2>/dev/null || xclip -selection clipboard -o 2>/dev/null', timeoutMs: 10_000 });
  return { text: r.stdout };
}

// ---------------- clip.set ----------------

export async function clipSet(args: Args): Promise<unknown> {
  const text = args['text'] as string;
  if (typeof text !== 'string') {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'text 不能为空');
  }
  if (IS_WINDOWS) {
    // 文本经 base64 传输，避免命令行参数编码问题（cmd/PS 对非 ASCII 参数不可靠）
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const r = await execCommand({
      command:
        `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
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
  return { written: text.length };
}
