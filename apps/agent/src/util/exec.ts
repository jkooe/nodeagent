import { spawn, type ChildProcess } from 'node:child_process';

export const IS_WINDOWS = process.platform === 'win32';
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB

export type ShellKind = 'powershell' | 'cmd' | 'bash' | 'zsh';

export interface ExecOptions {
  command: string;
  shell?: ShellKind;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  truncated: boolean;
  killed: boolean;
}

interface Launch {
  file: string;
  args: string[];
}

/**
 * PowerShell 输出编码前缀。
 *
 * 背景：Node 侧统一按 UTF-8 解码子进程输出，但 Windows PowerShell 默认使用
 * 控制台代码页（中文系统为 GBK/CP936）输出，导致中文变成 U+FFFD（）。
 * 此处强制 PowerShell 用 UTF-8 输出，从根上消除乱码。
 *
 * 注：均为赋值语句，不产生任何 stdout，不会污染用户命令的输出。
 */
const PS_UTF8_PREFIX =
  '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);' +
  '$OutputEncoding=[Console]::OutputEncoding;';

/** 按平台与 shell 类型构造可执行文件与参数（数组传参，不拼 shell 字符串）。 */
export function buildLaunch(command: string, shell: ShellKind): Launch {
  if (IS_WINDOWS) {
    if (shell === 'cmd') {
      // cmd 的代码页需在命令内切换（chcp 65001），且须静默。
      //
      // ⚠️ 已知局限（实测确认）：`chcp 65001` 只能改变**输出**代码页，
      // 而 Node 传给 cmd.exe 的**命令行参数**在进入 cmd 时已按 ANSI（中文为 GBK）
      // 解释，因此**命令字符串中的中文仍会损坏**（chcp 显示 65001 也无济于事）。
      // 需要在命令里使用中文时，请改用默认的 powershell（那边已完整支持 UTF-8）。
      return { file: 'cmd.exe', args: ['/d', '/s', '/c', `chcp 65001 >nul & ${command}`] };
    }
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        PS_UTF8_PREFIX + command,
      ],
    };
  }
  const bin = shell === 'zsh' ? '/bin/zsh' : '/bin/bash';
  return { file: bin, args: ['-c', command] };
}

/**
 * 执行命令，带超时强杀与输出截断。
 * 超时后杀「整个进程组」，防止孙进程残留。
 */
export function execCommand(opts: ExecOptions): Promise<ExecResult> {
  const { command, cwd, timeoutMs = 30_000, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = opts;
  const shell: ShellKind = opts.shell ?? (IS_WINDOWS ? 'powershell' : 'bash');
  const launch = buildLaunch(command, shell);
  const startedAt = Date.now();

  return new Promise<ExecResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(launch.file, launch.args, {
        cwd,
        detached: !IS_WINDOWS, // POSIX: 独立进程组，便于整组杀死
        windowsHide: true,
        env: {
          ...process.env,
          // 统一子进程输出为 UTF-8（Node 侧按 UTF-8 解码，二者须一致）
          PYTHONIOENCODING: 'utf-8',
          LANG: process.env['LANG'] ?? 'en_US.UTF-8',
          LC_ALL: process.env['LC_ALL'] ?? 'en_US.UTF-8',
        },
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let killed = false;

    const append = (chunk: Buffer, isErr: boolean): void => {
      const size = chunk.byteLength;
      if (isErr) {
        if (stderrBytes + size <= maxOutputBytes) {
          stderr += chunk.toString('utf8');
          stderrBytes += size;
        } else if (stderrBytes < maxOutputBytes) {
          stderr += chunk.subarray(0, maxOutputBytes - stderrBytes).toString('utf8');
          stderrBytes = maxOutputBytes;
          truncated = true;
        } else {
          truncated = true;
        }
      } else {
        if (stdoutBytes + size <= maxOutputBytes) {
          stdout += chunk.toString('utf8');
          stdoutBytes += size;
        } else if (stdoutBytes < maxOutputBytes) {
          stdout += chunk.subarray(0, maxOutputBytes - stdoutBytes).toString('utf8');
          stdoutBytes = maxOutputBytes;
          truncated = true;
        } else {
          truncated = true;
        }
      }
    };

    child.stdout?.on('data', (c: Buffer) => append(c, false));
    child.stderr?.on('data', (c: Buffer) => append(c, true));

    const timer = setTimeout(() => {
      killed = true;
      killTree(child);
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    const finish = (code: number | null): void => {
      clearTimeout(timer);
      resolve({
        // 被超时强杀时统一语义：exit_code = 124（与 Unix timeout(1) 惯例一致）
        // 注：Windows 上 taskkill /F 会让子进程以 code=1 退出（Unix 为 null），需在此归一
        exit_code: killed ? 124 : (code ?? -1),
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        duration_ms: Date.now() - startedAt,
        truncated,
        killed,
      });
    };

    child.on('close', finish);
  });
}

/** 杀掉子进程及其所有后代。 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    // Windows: taskkill /T 递归杀进程树
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      /* 忽略 */
    }
  } else {
    // POSIX: 负 PID = 整个进程组
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
}
