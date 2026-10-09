/**
 * monitor.*（v1.8，方向二「状态」第二块）—— 定时采样落盘与回看。
 *
 * ## 为什么需要（复盘 §四）
 * 代理不通、杀软拦截、端口时开时闭都是**间歇性**的，而 `system.status` 只能看当下快照。
 * `event.watch` 解决「有事件时通知」，没解决「**持续记录，事后能查**」。
 *
 * ## 设计
 * - 四类采样源：`port`（连通性 + 延迟）/ `process`（存活 + PID 列表）/
 *   `command`（退出码 + 首行输出）/ `metric`（CPU/内存）
 * - 落盘 `<数据目录>/monitors/<id>.jsonl`（一行一样本，追加写 + 立即 flush 语义）
 * - `monitor.report` 读回并给摘要：min/max/均值、断线次数、最长中断 —— 直接回答
 *   「5 分钟里断过几次、最长断了多久」
 * - 并发上限 8 个；单文件 10 万行封顶（防写满磁盘）
 * - 采样循环 `unref()`，不阻止 agent 退出；`monitor.stop` 或进程退出即停
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { exec } from 'node:child_process';
import { join } from 'node:path';
import { homedir, totalmem, freemem, cpus } from 'node:os';
import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { logQuery, type LogLine } from './log.js';

type Args = Record<string, unknown>;

export type MonitorSource = 'port' | 'process' | 'command' | 'metric';

interface Sample {
  ts: number;
  /** 各源自定义字段 */
  [k: string]: unknown;
}

interface MonitorRecord {
  id: string;
  source: MonitorSource;
  target: string;
  intervalMs: number;
  createdAt: number;
  samples: number;
  file: string;
  timer: ReturnType<typeof setInterval>;
  /** 首次采样失败时记下，避免每次 tick 都刷错误 */
  lastError: string | null;
}

const monitors = new Map<string, MonitorRecord>();
const MAX_MONITORS = 8;
const MAX_SAMPLES_PER_FILE = 100_000;

function dataDir(): string {
  return process.env['NODEAGENT_HOME'] ?? join(homedir(), '.nodeagent');
}

function monitorDir(): string {
  const d = join(dataDir(), 'monitors');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

// ---------------- 采样器 ----------------

/** port：TCP 连通性 + 握手耗时（跨平台，无额外依赖）。 */
function samplePort(host: string, port: number, timeoutMs: number): Promise<Sample> {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = connect({ host, port });
    const done = (up: boolean, err?: string): void => {
      sock.destroy();
      resolve({ ts: Date.now(), up, ms: Date.now() - started, ...(err ? { error: err } : {}) });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (e) => done(false, String(e.message ?? e)));
  });
}

/** process：按名判断存活（Windows tasklist / POSIX ps，与 events.ts 同策略）。 */
function sampleProcess(name: string): Promise<Sample> {
  return new Promise((resolve) => {
    const cmd =
      process.platform === 'win32'
        ? `tasklist /FI "IMAGENAME eq ${name}" /NH`
        : `ps -axo pid=,comm= | grep -i "${name}" | grep -v grep`;
    exec(cmd, { timeout: 8000 }, (err, stdout) => {
      const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !/^INFO:/i.test(l));
      const pids = lines
        .map((l) => {
          const m = /^(\d+)/.exec(l);
          return m ? Number(m[1]) : null;
        })
        .filter((x): x is number => x !== null);
      resolve({ ts: Date.now(), alive: pids.length > 0, pids, ...(err && pids.length === 0 ? { error: String(err.message) } : {}) });
    });
  });
}

/** command：退出码 + 输出首行（用于"跑个探针命令"这类自定义采样）。 */
function sampleCommand(command: string, timeoutMs: number): Promise<Sample> {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const first = (stdout || stderr || '').split('\n')[0]?.slice(0, 500) ?? '';
      resolve({
        ts: Date.now(),
        exit_code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        first_line: first,
      });
    });
  });
}

/** metric：CPU（两次采样差分）+ 内存。 */
async function sampleMetric(): Promise<Sample> {
  const a = cpus();
  await new Promise((r) => setTimeout(r, 200));
  const b = cpus();
  const idle = (c: typeof a): number =>
    c.reduce((s, x) => s + x.times.idle + x.times.irq, 0) / c.length;
  const total = (c: typeof a): number =>
    c.reduce((s, x) => s + Object.values(x.times).reduce((p, q) => p + q, 0), 0) / c.length;
  const idleDiff = idle(b) - idle(a);
  const totalDiff = total(b) - total(a);
  const cpu = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 10000) / 100 : 0;
  const mem = totalmem();
  const free = freemem();
  return { ts: Date.now(), cpu_pct: cpu, mem_pct: Math.round(((mem - free) / mem) * 10000) / 100 };
}

async function takeSample(rec: MonitorRecord): Promise<Sample> {
  switch (rec.source) {
    case 'port': {
      const [host, portStr] = rec.target.split(':');
      return samplePort(host || '127.0.0.1', Number(portStr), Math.min(rec.intervalMs, 5000));
    }
    case 'process':
      return sampleProcess(rec.target);
    case 'command':
      return sampleCommand(rec.target, Math.min(rec.intervalMs * 2, 20_000));
    case 'metric':
      return sampleMetric();
  }
}

// ---------------- 能力实现 ----------------

export async function monitorStart(args: Args): Promise<unknown> {
  const source = args['source'] as MonitorSource | undefined;
  if (!source || !['port', 'process', 'command', 'metric'].includes(source)) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `不支持的 source: ${String(source)}`, {
      allowed: ['port', 'process', 'command', 'metric'],
      hint: 'port 需 target="host:port"；process 需 target=进程名；command 需 target=命令；metric 不需要 target',
    });
  }
  const intervalMs = Math.max(500, Math.min(600_000, (args['interval_ms'] as number | undefined) ?? 2000));
  const target = (args['target'] as string | undefined) ?? '';
  if (source !== 'metric' && !target) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `source=${source} 需要 target`);
  }
  if (source === 'port' && !/^.+:\d+$/.test(target)) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'port 采样的 target 应为 "host:port"', { got: target });
  }
  if (monitors.size >= MAX_MONITORS) {
    throw new CapabilityError(ErrorCodes.RATE_LIMITED, `并发监控上限 ${MAX_MONITORS} 个`, {
      running: [...monitors.keys()],
    });
  }

  const id = (args['id'] as string | undefined)?.trim() || `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  if (monitors.has(id)) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `监控 id 已存在: ${id}`, { hint: '换个 id，或先 monitor.stop' });
  }
  if (!/^[\w.-]{1,64}$/.test(id)) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'id 只允许字母数字与 . _ -（≤64 字符）', { got: id });
  }

  const file = join(monitorDir(), `${id}.jsonl`);
  const rec: MonitorRecord = {
    id, source, target, intervalMs, createdAt: Date.now(), samples: 0, file,
    timer: setInterval(() => { void tick(rec); }, intervalMs),
    lastError: null,
  };
  monitors.set(id, rec);
  // 立即采第一针（调用方往往想马上知道"现在通不通"），不额外等一个 interval
  void tick(rec);
  return { id, source, target, interval_ms: intervalMs, file, started_at: rec.createdAt };
}

async function tick(rec: MonitorRecord): Promise<void> {
  try {
    const s = await takeSample(rec);
    rec.lastError = null;
    appendFileSync(rec.file, `${JSON.stringify(s)}\n`, 'utf8');
    rec.samples += 1;
    // 行数封顶：超过就从头截断（保留后半），防止磁盘写满
    if (rec.samples > MAX_SAMPLES_PER_FILE) {
      const lines = readFileSync(rec.file, 'utf8').trim().split('\n');
      writeFileSync(rec.file, `${lines.slice(-MAX_SAMPLES_PER_FILE).join('\n')}\n`, 'utf8');
      rec.samples = MAX_SAMPLES_PER_FILE;
    }
  } catch (err) {
    rec.lastError = err instanceof Error ? err.message : String(err);
    // 采样失败也记一行（"查不到"本身也是信息），但不无限刷盘
    if (rec.samples < MAX_SAMPLES_PER_FILE) {
      appendFileSync(rec.file, `${JSON.stringify({ ts: Date.now(), error: rec.lastError })}\n`, 'utf8');
      rec.samples += 1;
    }
  }
}

export async function monitorReport(args: Args): Promise<unknown> {
  const id = args['id'] as string;
  if (!id) throw new CapabilityError(ErrorCodes.PARAM_INVALID, '需要 id');
  const rec = monitors.get(id);
  const file = join(monitorDir(), `${id}.jsonl`);
  if (!rec && !existsSync(file)) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `没有这个监控: ${id}`, { running: [...monitors.keys()] });
  }
  const since = args['since'] as number | undefined;
  const limit = Math.max(1, Math.min(20_000, (args['limit'] as number | undefined) ?? 5000));

  const samples: Sample[] = [];
  let truncated = false;
  if (existsSync(file)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as Sample;
        if (since !== undefined && s.ts < since) continue;
        samples.push(s);
      } catch {
        /* 半行（写入中断）跳过 */
      }
    }
    if (samples.length > limit) {
      samples.splice(0, samples.length - limit);
      truncated = true;
    }
  }

  return {
    id,
    running: rec !== undefined,
    source: rec?.source ?? 'unknown',
    target: rec?.target ?? '',
    interval_ms: rec?.intervalMs,
    file,
    samples: samples.length,
    truncated,
    last_error: rec?.lastError ?? undefined,
    summary: summarize(samples, rec?.source ?? 'port'),
    series: samples,
  };
}

/** 摘要：把样本压成"人话"—— 断几次、最长多久、值域。 */
function summarize(samples: Sample[], source: MonitorSource): Record<string, unknown> {
  if (samples.length === 0) return { n: 0 };
  const base: Record<string, unknown> = { n: samples.length };
  const ts = samples.map((s) => s.ts);
  base.window_ms = Math.max(...ts) - Math.min(...ts);

  if (source === 'port') {
    const ups = samples.filter((s) => s.up === true);
    base.up_count = ups.length;
    base.down_count = samples.length - ups.length;
    const lat = samples.map((s) => Number(s.ms ?? 0)).filter((x) => Number.isFinite(x));
    if (lat.length) {
      base.ms_min = Math.min(...lat);
      base.ms_max = Math.max(...lat);
      base.ms_avg = Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 100) / 100;
    }
    // 最长连续中断
    let run = 0;
    let worst = 0;
    for (const s of samples) {
      if (s.up === true) { run = 0; } else { run += 1; worst = Math.max(worst, run); }
    }
    base.longest_outage_samples = worst;
  } else if (source === 'process') {
    base.alive_count = samples.filter((s) => s.alive === true).length;
    base.dead_count = samples.filter((s) => s.alive !== true).length;
    let run = 0;
    let worst = 0;
    for (const s of samples) {
      if (s.alive === true) { run = 0; } else { run += 1; worst = Math.max(worst, run); }
    }
    base.longest_dead_samples = worst;
  } else if (source === 'command') {
    const codes = samples.map((s) => Number(s.exit_code ?? -1));
    base.ok_count = codes.filter((c) => c === 0).length;
    base.fail_count = codes.filter((c) => c !== 0).length;
    base.exit_codes_seen = [...new Set(codes)];
  } else {
    const cpu = samples.map((s) => Number(s.cpu_pct ?? 0));
    const mem = samples.map((s) => Number(s.mem_pct ?? 0));
    if (cpu.length) {
      base.cpu_min = Math.min(...cpu); base.cpu_max = Math.max(...cpu);
      base.cpu_avg = Math.round((cpu.reduce((a, b) => a + b, 0) / cpu.length) * 100) / 100;
    }
    if (mem.length) {
      base.mem_min = Math.min(...mem); base.mem_max = Math.max(...mem);
      base.mem_avg = Math.round((mem.reduce((a, b) => a + b, 0) / mem.length) * 100) / 100;
    }
  }
  return base;
}

export async function monitorStop(args: Args): Promise<unknown> {
  const id = args['id'] as string;
  if (!id) throw new CapabilityError(ErrorCodes.PARAM_INVALID, '需要 id');
  const rec = monitors.get(id);
  if (!rec) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `没有正在运行的监控: ${id}`, { running: [...monitors.keys()] });
  }
  clearInterval(rec.timer);
  monitors.delete(id);
  const report = (await monitorReport({ id })) as { samples: number; summary: Record<string, unknown> };
  return { id, stopped: true, samples: report.samples, summary: report.summary, file: rec.file };
}

export async function monitorList(_args: Args): Promise<unknown> {
  const running = [...monitors.values()].map((r) => ({
    id: r.id, source: r.source, target: r.target, interval_ms: r.intervalMs,
    samples: r.samples, started_at: r.createdAt, file: r.file, last_error: r.lastError ?? undefined,
  }));
  const dir = monitorDir();
  let files: string[] = [];
  try {
    files = (await import('node:fs')).readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    /* 目录不存在即无历史 */
  }
  return {
    running,
    running_count: running.length,
    history_files: files.map((f) => f.replace(/\.jsonl$/, '')),
  };
}

/** 供 monitor.delete：删除历史文件（不影响运行中的实例）。 */
export async function monitorDelete(args: Args): Promise<unknown> {
  const id = args['id'] as string;
  if (!id) throw new CapabilityError(ErrorCodes.PARAM_INVALID, '需要 id');
  if (monitors.has(id)) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, '该监控仍在运行，请先 stop', { hint: `monitor.stop {"id":"${id}"}` });
  }
  const file = join(monitorDir(), `${id}.jsonl`);
  if (!existsSync(file)) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `没有历史文件: ${id}`);
  }
  rmSync(file, { force: true });
  return { id, deleted: true, file };
}

// log.query 与 monitor 同属"状态"方向，放在同一能力文件里导出
export { logQuery };
export type { LogLine };
