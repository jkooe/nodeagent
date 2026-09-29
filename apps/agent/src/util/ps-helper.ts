import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execCommand } from './exec.js';

/**
 * PowerShell 常驻助手（v14）。
 *
 * ## 为什么需要它
 * 现状：`window.list` / `window.focus` / `screen.find` 每次调用都 `powershell.exe -EncodedCommand`，
 * 而脚本开头是 `Add-Type @"..."@`（**现编译 C#**）+ `Add-Type -AssemblyName UIAutomationClient`。
 * 真机实测（agent 侧中位）：window.list **1267ms**、window.focus **1631ms** —— 大头就是
 * 「起进程 + 编译类型」这一次性开销，与每次任务的复杂度无关。
 *
 * ## 做法
 * 起一个**常驻** PowerShell 进程：启动时把 prelude（C# 类型 / UIA / WinRT 程序集）
 * 全部加载一次，之后每个请求只发「本次逻辑」（base64 一行），进程内直接执行并回传结果。
 * 进程内还有 UIA 的元数据缓存收益。
 *
 * ## 不变量（工程纪律）
 * - **可用性不倒退**：助手不可用/超时/连续失败 → 自动回退到原有「一次性脚本」路径，
 *   且熔断后本进程不再重试助手（避免每次调用都白等一次超时）。
 * - **不泄漏**：空闲 10 分钟自动退出；agent 关闭时统一回收。
 * - **可观测**：暴露 stats（调用次数/命中率/最近错误）供诊断。
 */

const IDLE_KILL_MS = 10 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;
/** 助手启动（含类型编译）允许的较长时间；只发生一次 */
const SPAWN_TIMEOUT_MS = 60_000;

/**
 * 解析助手输出的一行协议报文。
 * 协议：`@@R <base64>` 成功 / `@@E <base64>` 脚本异常；其他行（Add-Type 噪声等）返回 null。
 */
export function parseHelperLine(line: string): { isErr: boolean; payload: string } | null {
  const isResult = line.startsWith('@@R ');
  const isErr = line.startsWith('@@E ');
  if (!isResult && !isErr) return null;
  try {
    return { isErr, payload: Buffer.from(line.slice(4), 'base64').toString('utf8') };
  } catch {
    return null;
  }
}

export interface PsHelperStats {
  enabled: boolean;
  calls: number;
  hits: number;
  failures: number;
  consecutiveFailures: number;
  spawned: number;
  lastError?: string;
  avg_ms: number;
}

export function toEncodedCommand(script: string): string {
  // -EncodedCommand 要求 UTF-16LE base64，可彻底规避引号/换行/中文转义问题
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 把 prelude 与「读一行、执行、回结果」的循环拼成 bootstrap 脚本。 */
export function buildBootstrap(prelude: string): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    // 助手自己的诊断信息一律走 stderr，stdout 只留协议行（避免污染）
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
    `$ProgressPreference = 'SilentlyContinue'`,
    prelude,
    `[Console]::Error.WriteLine('@@READY')`,
    // 逐个处理请求：每行 = 一段 base64 编码的 PowerShell 片段
    `while ($true) {`,
    `  $line = [Console]::In.ReadLine()`,
    `  if ($null -eq $line) { break }`,
    `  if ($line -eq '@@EXIT') { break }`,
    `  try {`,
    `    $src = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))`,
    `    $out = & ([scriptblock]::Create($src))`,
    `    $txt = ($out | Out-String)`,
    `    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($txt))`,
    `    [Console]::Out.WriteLine('@@R ' + $b64)`,
    `  } catch {`,
    `    $msg = $_.Exception.Message`,
    `    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($msg))`,
    `    [Console]::Out.WriteLine('@@E ' + $b64)`,
    `  }`,
    `  [Console]::Out.Flush()`,
    `}`,
  ].join('\n');
}

/**
 * 一个常驻 PowerShell 进程（按 prelude 复用同一个实例 —— 同 prelude 视为同一环境）。
 * 请求串行化：单进程单 stdin，天然 FIFO；响应按顺序回，故只需匹配队首。
 */
export class PsShell {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private starting: Promise<void> | null = null;
  private queue: Array<{
    body: string;
    timer: NodeJS.Timeout;
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }> = [];
  private stdoutBuf = '';
  private stderrBuf = '';
  private idleTimer: NodeJS.Timeout | null = null;

  private stats: PsHelperStats = {
    enabled: true,
    calls: 0,
    hits: 0,
    failures: 0,
    consecutiveFailures: 0,
    spawned: 0,
    avg_ms: 0,
  };
  private totalMs = 0;

  constructor(
    private readonly prelude: string,
    private readonly label: string,
    private readonly log: (level: 'info' | 'warn', msg: string) => void,
  ) {}

  getStats(): PsHelperStats {
    return { ...this.stats, avg_ms: this.stats.hits > 0 ? Math.round(this.totalMs / this.stats.hits) : 0 };
  }

  /** 助手里执行一段脚本；返回 stdout。抛出异常表示「本次不可用」，调用方应降级。 */
  async run(body: string, timeoutMs = 30_000): Promise<string> {
    if (!this.stats.enabled) throw new Error(`PsShell[${this.label}] 已熔断`);
    await this.ensureStarted();
    const started = Date.now();
    try {
      const out = await this.enqueue(body, timeoutMs);
      this.stats.calls += 1;
      this.stats.hits += 1;
      this.stats.consecutiveFailures = 0;
      this.totalMs += Date.now() - started;
      this.touchIdle();
      return out;
    } catch (err) {
      this.stats.calls += 1;
      this.stats.failures += 1;
      this.stats.consecutiveFailures += 1;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      this.kill(); // 状态可疑，直接销毁，下次重建
      if (this.stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.stats.enabled = false;
        this.log(
          'warn',
          `PsShell[${this.label}] 连续失败 ${this.stats.consecutiveFailures} 次，熔断并回退到一次性脚本路径`,
        );
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private enqueue(body: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((q) => q.timer !== timer);
        reject(new Error(`PsShell[${this.label}] 请求超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.queue.push({ body, timer, resolve, reject });
      this.pump();
    });
  }

  /** 把队首请求写进 stdin（仅当没有在途请求时）。 */
  private pump(): void {
    const head = this.queue[0];
    if (!head || !this.ready) return;
    // 已在途：队列长度 > 1 说明队首已发出，等待响应即可
    if (this.queue.length > 1) return;
    const line = Buffer.from(head.body, 'utf8').toString('base64');
    this.proc?.stdin.write(`${line}\n`);
  }

  private ensureStarted(): Promise<void> {
    if (this.ready && this.proc) return Promise.resolve();
    if (this.starting) return this.starting;

    this.starting = new Promise<void>((resolve, reject) => {
      this.stats.spawned += 1;
      const bootstrap = buildBootstrap(this.prelude);
      const p = spawn(
        'powershell.exe',
        ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', toEncodedCommand(bootstrap)],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this.proc = p;
      const failTimer = setTimeout(() => {
        if (!this.ready) {
          this.kill();
          reject(new Error(`PsShell[${this.label}] 启动超时（${SPAWN_TIMEOUT_MS}ms）`));
        }
      }, SPAWN_TIMEOUT_MS);

      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (chunk: string) => this.onStdout(chunk));
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', (chunk: string) => {
        if (chunk.includes('@@READY')) {
          clearTimeout(failTimer);
          this.ready = true;
          this.log('info', `PsShell[${this.label}] 就绪（类型已预加载）`);
          this.pump();
          resolve();
          return;
        }
        this.stderrBuf = (this.stderrBuf + chunk).slice(-4000);
      });
      p.on('error', (err) => {
        clearTimeout(failTimer);
        this.log('warn', `PsShell[${this.label}] 进程错误: ${err.message}`);
        this.ready = false;
        reject(err);
      });
      p.on('exit', (code) => {
        clearTimeout(failTimer);
        const wasReady = this.ready;
        this.ready = false;
        this.proc = null;
        this.starting = null;
        if (wasReady) this.log('warn', `PsShell[${this.label}] 进程退出（code=${String(code)}）`);
        // 在途请求全部失败 -> 触发降级
        const pending = this.queue.splice(0);
        for (const q of pending) {
          clearTimeout(q.timer);
          q.reject(new Error(`PsShell[${this.label}] 进程退出`));
        }
        if (!wasReady) reject(new Error(`PsShell[${this.label}] 启动失败（code=${String(code)}）`));
      });
    }).finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      const parsed = parseHelperLine(line);
      if (!parsed) continue; // 非协议行（如 Add-Type 噪声）忽略
      const { isErr, payload } = parsed;
      const head = this.queue.shift();
      if (!head) continue;
      clearTimeout(head.timer);
      if (isErr) head.reject(new Error(`PsShell[${this.label}] 脚本异常: ${payload.slice(0, 300)}`));
      else head.resolve(payload);
      this.pump();
    }
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.queue.length === 0 && this.proc) {
        this.log('info', `PsShell[${this.label}] 空闲回收`);
        this.kill();
      }
    }, IDLE_KILL_MS);
    this.idleTimer.unref?.();
  }

  kill(): void {
    this.ready = false;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const p = this.proc;
    this.proc = null;
    if (p && !p.killed) {
      try {
        p.stdin.end();
        p.kill();
      } catch {
        /* 忽略 */
      }
    }
    const pending = this.queue.splice(0);
    for (const q of pending) {
      clearTimeout(q.timer);
      q.reject(new Error(`PsShell[${this.label}] 已回收`));
    }
  }
}

// ---------------- 对外：带降级的执行入口 ----------------

const shells = new Map<string, PsShell>();
/** 进程退出时统一回收（避免留下孤儿 PowerShell） */
let cleanupRegistered = false;

/**
 * 取（或创建）某 prelude 对应的助手。
 * key 含 prelude 指纹：**预加载段一旦变化，自动切换到新助手并回收旧的** ——
 * 否则进程内更新代码后仍会用到旧进程里已加载的类型定义（难查的幽灵问题）。
 */
export function getPsShell(
  prelude: string,
  label: string,
  log: (level: 'info' | 'warn', msg: string) => void,
): PsShell {
  const fingerprint = createHash('sha256').update(prelude).digest('hex').slice(0, 8);
  const key = `${label}#${fingerprint}`;

  // 同 label 但指纹不同的旧助手（预加载段已变更）直接回收
  for (const [k, old] of shells) {
    if (k.startsWith(`${label}#`) && k !== key) {
      log('info', `PsShell[${label}] 预加载段已变更，回收旧助手`);
      old.kill();
      shells.delete(k);
    }
  }

  let sh = shells.get(key);
  if (!sh) {
    sh = new PsShell(prelude, label, log);
    shells.set(key, sh);
    if (!cleanupRegistered) {
      cleanupRegistered = true;
      process.once('exit', () => {
        for (const s of shells.values()) s.kill();
      });
    }
  }
  return sh;
}

export function allPsShellStats(): Record<string, PsHelperStats> {
  const out: Record<string, PsHelperStats> = {};
  for (const [k, v] of shells) out[k] = v.getStats();
  return out;
}

export function disposeAllPsShells(): void {
  for (const s of shells.values()) s.kill();
  shells.clear();
}

export interface RunPsOptions {
  /** 本次逻辑（不含 prelude） */
  body: string;
  /** 类型/程序集预加载段（助手启动时执行一次；降级时与 body 拼成完整脚本） */
  prelude: string;
  /** 一次性路径的超时（降级用） */
  timeoutMs?: number;
  /** 助手可用性开关（便于测试与排障；默认 true） */
  useHelper?: boolean;
  log?: (level: 'info' | 'warn', msg: string) => void;
  label?: string;
}

/**
 * 执行 PowerShell：**优先常驻助手**，不可用时自动回退到一次性脚本。
 * 返回值始终是脚本 stdout（两条路径语义一致）。
 */
export async function runPowerShellSmart(opts: RunPsOptions): Promise<{ stdout: string; via: 'helper' | 'oneshot' }> {
  const { body, prelude, timeoutMs = 30_000, useHelper = true, log, label = 'win' } = opts;
  const noop = (): void => undefined;
  const logger = log ?? noop;

  if (useHelper && process.platform === 'win32' && !process.env['NODEAGENT_NO_PS_HELPER']) {
    try {
      const shell = getPsShell(prelude, label, logger);
      const stdout = await shell.run(body, timeoutMs);
      return { stdout: stdout.trim(), via: 'helper' };
    } catch (err) {
      logger('warn', `PsShell 不可用，回退一次性脚本：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const r = await execCommand({
    command: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${toEncodedCommand(`${prelude}\n${body}`)}`,
    timeoutMs,
  });
  if (r.exit_code !== 0) {
    const err = new Error((r.stderr || r.stdout).slice(0, 600)) as Error & { exitCode?: number };
    err.exitCode = r.exit_code;
    throw err;
  }
  return { stdout: r.stdout.trim(), via: 'oneshot' };
}
