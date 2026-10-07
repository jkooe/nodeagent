import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, buildLaunch, childEnv, killTree } from '../util/exec.js';

type Args = Record<string, unknown>;

export interface TaskRecord {
  id: string;
  /** 命令摘要（sha256 前 8 位）——不落原始命令，与审计脱敏策略一致 */
  commandHash: string;
  state: 'running' | 'done' | 'killed' | 'failed';
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
  child?: ChildProcess;
  timer?: ReturnType<typeof setTimeout>;
}

/** 任务表：agent 进程内存态；agent 退出时子进程随进程树清理（killTree 兜底）。 */
const tasks = new Map<string, TaskRecord>();
const MAX_TASKS = 50;
const MAX_OUTPUT = 10 * 1024 * 1024; // 10MB
const MAX_RETENTION_MS = 30 * 60 * 1000; // 完成态保留 30 分钟

function newId(): string {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function prune(): void {
  // 淘汰：超保留期的完成态任务；超上限时淘汰最旧完成态
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (t.state === 'running') continue;
    if (t.finishedAt && now - t.finishedAt > MAX_RETENTION_MS) tasks.delete(id);
  }
  const done = [...tasks.values()].filter((t) => t.state !== 'running');
  if (done.length > MAX_TASKS) {
    done.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const t of done.slice(0, done.length - MAX_TASKS)) tasks.delete(t.id);
  }
}

/** 启动一个异步任务（system.shell.exec async:true 时调用）。 */
export function startTask(opts: {
  command: string;
  shell?: 'powershell' | 'cmd' | 'bash' | 'zsh';
  cwd?: string;
  timeoutMs?: number;
}): TaskRecord {
  const { command, cwd, timeoutMs } = opts;
  const shell = opts.shell ?? (IS_WINDOWS ? 'powershell' : 'bash');
  const launch = buildLaunch(command, shell);
  const rec: TaskRecord = {
    id: newId(),
    commandHash: createHash('sha256').update(command).digest('hex').slice(0, 8),
    state: 'running',
    startedAt: Date.now(),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    truncated: false,
  };
  let child: ChildProcess;
  try {
    child = spawn(launch.file, launch.args, {
      cwd,
      detached: !IS_WINDOWS,
      windowsHide: true,
      env: childEnv(),
    });
  } catch (err) {
    rec.state = 'failed';
    rec.stderr = Buffer.from(String(err));
    rec.finishedAt = Date.now();
    tasks.set(rec.id, rec);
    return rec;
  }
  rec.child = child;
  const append = (buf: Buffer, isErr: boolean): void => {
    const target = isErr ? rec.stderr : rec.stdout;
    if (rec.truncated) return;
    if (target.length + buf.length > MAX_OUTPUT) {
      const room = MAX_OUTPUT - target.length;
      const merged = Buffer.concat([target, buf.subarray(0, Math.max(0, room))]);
      if (isErr) rec.stderr = merged;
      else rec.stdout = merged;
      rec.truncated = true;
      return;
    }
    const merged = Buffer.concat([target, buf]);
    if (isErr) rec.stderr = merged;
    else rec.stdout = merged;
  };
  child.stdout?.on('data', (c: Buffer) => append(c, false));
  child.stderr?.on('data', (c: Buffer) => append(c, true));
  if (timeoutMs && timeoutMs > 0) {
    rec.timer = setTimeout(() => {
      rec.state = 'killed';
      rec.finishedAt = Date.now();
      rec.exitCode = 124;
      killTree(child);
    }, timeoutMs);
  }
  child.on('error', (err) => {
    if (rec.state === 'running') {
      rec.state = 'failed';
      rec.exitCode = -1;
      rec.finishedAt = Date.now();
    }
    rec.stderr = Buffer.concat([rec.stderr, Buffer.from(String(err))]);
  });
  child.on('close', (code) => {
    if (rec.state !== 'running') return; // 超时标记过
    rec.state = code === 0 ? 'done' : 'done';
    rec.exitCode = code ?? -1;
    rec.finishedAt = Date.now();
    if (rec.timer) clearTimeout(rec.timer);
  });
  tasks.set(rec.id, rec);
  prune();
  return rec;
}

function getTask(id: string): TaskRecord {
  const t = tasks.get(id);
  if (!t) throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `任务不存在或已过期: ${id}`);
  return t;
}

// ---------------- system.task.list ----------------

/** v23：正在跑的任务数（连接层"有空闲断开但不动长任务"的判据）。 */
export function runningTaskCount(): number {
  let n = 0;
  for (const t of tasks.values()) if (t.state === 'running') n += 1;
  return n;
}

export async function taskList(_args: Args): Promise<unknown> {
  return {
    tasks: [...tasks.values()].map((t) => ({
      task_id: t.id,
      command: t.commandHash,
      state: t.state,
      started_at: t.startedAt,
      duration_ms: (t.finishedAt ?? Date.now()) - t.startedAt,
      exit_code: t.exitCode,
    })),
  };
}

// ---------------- system.task.get ----------------

export async function taskGet(args: Args): Promise<unknown> {
  const t = getTask(args['task_id'] as string);
  const stream = (args['stream'] as string | undefined) ?? 'stdout';
  const offset = (args['offset'] as number | undefined) ?? 0;
  const maxBytes = (args['max_bytes'] as number | undefined) ?? 256 * 1024;
  const buf = stream === 'stderr' ? t.stderr : t.stdout;
  const slice = buf.subarray(Math.min(offset, buf.length), Math.min(offset + maxBytes, buf.length));
  return {
    task_id: t.id,
    state: t.state,
    exit_code: t.exitCode,
    started_at: t.startedAt,
    duration_ms: (t.finishedAt ?? Date.now()) - t.startedAt,
    data: slice.toString('utf8'),
    offset: offset + slice.length,
    total_bytes: buf.length,
  };
}

// ---------------- system.task.kill ----------------

export async function taskKill(args: Args): Promise<unknown> {
  const t = getTask(args['task_id'] as string);
  if (t.state !== 'running') {
    return { killed: false, task_id: t.id };
  }
  if (t.timer) clearTimeout(t.timer);
  t.state = 'killed';
  t.finishedAt = Date.now();
  t.exitCode = 124;
  if (t.child?.pid) killTree(t.child);
  return { killed: true, task_id: t.id };
}
