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

/** 按平台与 shell 类型构造可执行文件与参数（数组传参，不拼 shell 字符串）。 */
function buildLaunch(command: string, shell: ShellKind): Launch {
  if (IS_WINDOWS) {
    if (shell === 'cmd') {
      return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
    }
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
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
        env: process.env,
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
        exit_code: code ?? (killed ? 124 : -1),
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
