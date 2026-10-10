import { createHash } from 'node:crypto';
import { guardPath } from './fs.js';
import { readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';
import { currentCertFingerprint } from '../certs.js';
import { loadAgentConfig } from '../config.js';
import { readAudit, readAuditAll, verifyAudit, computeAuditHead, anchorAudit, compareWithAnchors } from '../audit.js';
import { computeMetrics } from '../metrics.js';
import { allPsShellStats } from '../util/ps-helper.js';
import { startTask } from './task.js';

type Args = Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 归一化 PowerShell 的 ConvertTo-Json 输出（单对象 → 数组）。 */
function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function platformName(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return process.platform;
  }
}

async function isAdmin(): Promise<boolean> {
  if (IS_WINDOWS) {
    try {
      const r = await execCommand({ command: 'whoami /groups', timeoutMs: 5000 });
      return /S-1-16-12288/.test(r.stdout);
    } catch {
      return false;
    }
  }
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// ---------------- system.info ----------------


// ---------- 构建指纹（v18 / v20）----------

// 构建时由 esbuild --define 注入（见 scripts/pack.mjs）；开发态（直接跑 dist）下未定义，
// 故一律用 typeof 探测，绝不能直接引用（否则 dev 启动就 ReferenceError）。
declare const __AGENT_VERSION__: string | undefined;
declare const __BUILD_COMMIT__: string | undefined;

/** v21：读取当前生效的来源白名单（用于 system.info 上报）。 */
function configAllowFrom(): string[] | null {
  try {
    const cfg = loadAgentConfig().config;
    return cfg.allow_from && cfg.allow_from.length > 0 ? cfg.allow_from : null;
  } catch {
    return null;
  }
}

function injected(name: 'version' | 'commit'): string {
  if (name === 'version') return typeof __AGENT_VERSION__ === 'undefined' ? 'dev' : __AGENT_VERSION__;
  return typeof __BUILD_COMMIT__ === 'undefined' ? 'dev' : __BUILD_COMMIT__;
}

const STARTED_AT = Date.now();
let buildCache: { hash: string; bytes: number; mtime_ms: number } | null = null;

/**
 * 计算「正在运行的这一份 agent 脚本」的指纹（sha256 前 12 位）。
 *
 * 用途：部署后**校验远端真的换成了新代码**。仅靠「PID 变了 / 能力数对了」证明不了这点
 * （旧版可能恰好也是同样的能力数）；内容哈希是唯一可靠的判据。
 * 懒计算 + 缓存：文件约 1MB，只在首次 system.info 时读一次。
 */
export function buildInfo(): {
  hash: string;
  bytes: number;
  mtime_ms: number;
  node: string;
  started_at: number;
  uptime_ms: number;
  version: string;
  commit: string;
  built_at: string;
  cert_sha256: string | null;
} {
  if (!buildCache) {
    let hash = 'unknown';
    let bytes = 0;
    let mtime = 0;
    try {
      const scriptPath = process.argv[1] ?? '';
      const buf = readFileSync(scriptPath);
      bytes = buf.length;
      mtime = statSync(scriptPath).mtimeMs;
      hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    } catch {
      /* 读不到脚本（如被内联启动）时保持 unknown，不影响其他功能 */
    }
    buildCache = { hash, bytes, mtime_ms: Math.round(mtime) };
  }
  return {
    ...buildCache,
    node: process.version,
    started_at: STARTED_AT,
    uptime_ms: Date.now() - STARTED_AT,
    // v20：语义化版本 + 提交 + 构建时间（来自构建期注入）
    version: injected('version'),
    commit: injected('commit'),
    // 构建时间取入口文件的 mtime（而非构建期注入）—— 注入会让每次打包字节不同，
    // 破坏「指纹 = 构建身份」的确定性（v22 真机踩过）
    built_at: buildCache.mtime_ms ? new Date(buildCache.mtime_ms).toISOString() : 'unknown',
    // v21：TLS 证书指纹（控制端据此钉住被控端身份）
    cert_sha256: currentCertFingerprint(),
  };
}

export async function systemInfo(args: Args): Promise<unknown> {
  const fields = args['fields'] as string[] | undefined;
  const info: Record<string, unknown> = {
    hostname: os.hostname(),
    os: platformName(),
    os_version: os.release(),
    arch: os.arch(),
    cpu_model: os.cpus()[0]?.model?.trim() ?? 'unknown',
    cpu_cores: os.cpus().length,
    memory_total: os.totalmem(),
    uptime_sec: Math.round(os.uptime()),
    is_admin: await isAdmin(),
    // v11：自描述信息，供控制端「一键部署/升级」定位目标文件与数据目录
    pid: process.pid,
    agent_script: process.argv[1] ?? '',
    agent_home: process.env['NODEAGENT_HOME'] ?? '',
    node_path: process.execPath,
    // v15：PowerShell 常驻助手状态（排查 GUI 能力性能/降级时用）
    ps_helper: allPsShellStats(),
    // v18/v21：构建指纹（部署校验用）+ 证书指纹（身份钉定用）
    build: buildInfo(),
    // v21：来源网段访问控制（null = 未配置 = 放行全部，属于应尽快收敛的风险）
    network: {
      allow_from: configAllowFrom(),
    },
  };

  if (fields && fields.length > 0) {
    const picked: Record<string, unknown> = {};
    for (const f of fields) if (f in info) picked[f] = info[f];
    return picked;
  }
  return info;
}

// ---------------- system.status ----------------

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

async function cpuPercent(intervalMs = 200): Promise<number> {
  const a = cpuTimes();
  await sleep(intervalMs);
  const b = cpuTimes();
  const idleDiff = b.idle - a.idle;
  const totalDiff = b.total - a.total;
  if (totalDiff <= 0) return 0;
  return Math.round((1 - idleDiff / totalDiff) * 10000) / 100;
}

interface Disk {
  drive: string;
  total: number;
  free: number;
  used_pct: number;
}

async function listDisks(): Promise<Disk[]> {
  if (IS_WINDOWS) {
    const r = await execCommand({
      command:
        'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress',
      timeoutMs: 15_000,
    });
    const rows = toArray<{ DeviceID?: string; Size?: number; FreeSpace?: number }>(
      r.stdout ? JSON.parse(r.stdout) : [],
    );
    return rows.map((d) => {
      const total = Number(d.Size ?? 0);
      const free = Number(d.FreeSpace ?? 0);
      return {
        drive: d.DeviceID ?? '?',
        total,
        free,
        used_pct: total > 0 ? Math.round(((total - free) / total) * 10000) / 100 : 0,
      };
    });
  }
  const r = await execCommand({ command: 'df -kP', timeoutMs: 15_000 });
  const skipFs = new Set(['devfs', 'map', 'none', 'tmpfs', 'overlay', 'autofs']);
  const disks: Disk[] = [];
  for (const line of r.stdout.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const fs = parts[0]!;
    const mount = parts[5]!;
    // 跳过虚拟文件系统与系统卷（macOS 特有噪音）
    if (skipFs.has(fs) || mount.startsWith('/System/Volumes/')) continue;
    const totalKb = Number(parts[1]);
    const availKb = Number(parts[3]);
    if (!Number.isFinite(totalKb) || !Number.isFinite(availKb)) continue;
    const total = totalKb * 1024;
    const free = availKb * 1024;
    if (total === 0) continue;
    disks.push({
      drive: mount,
      total,
      free,
      used_pct: Math.round(((total - free) / total) * 10000) / 100,
    });
  }
  return disks;
}

function listNet(): Array<{ adapter: string; ip: string; up: boolean }> {
  const out: Array<{ adapter: string; ip: string; up: boolean }> = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        out.push({ adapter: name, ip: a.address, up: !a.internal });
      }
    }
  }
  return out;
}

export async function systemStatus(_args: Args): Promise<unknown> {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const [cpu, disks] = await Promise.all([cpuPercent(), listDisks()]);
  return {
    cpu_pct: cpu,
    memory_used: used,
    memory_total: total,
    memory_pct: Math.round((used / total) * 10000) / 100,
    disks,
    net: listNet(),
  };
}

// ---------------- system.process.list ----------------

interface Proc {
  pid: number;
  name: string;
  cpu_pct: number;
  memory_bytes: number;
  started_at: number;
}

function parseEtime(etime: string): number {
  // 支持 dd-hh:mm:ss / hh:mm:ss / mm:ss
  const days = /^(\d+)-/.exec(etime);
  const rest = days ? etime.slice(days[0].length) : etime;
  const parts = rest.split(':').map(Number);
  let sec = 0;
  if (parts.length === 3) sec = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  else if (parts.length === 2) sec = parts[0]! * 60 + parts[1]!;
  else sec = parts[0] ?? 0;
  if (days) sec += Number(days[1]) * 86_400;
  return Date.now() - sec * 1000;
}

/** 解析 POSIX `ps -axo pid=,%cpu=,rss=,comm=,etime=` 输出。 */
function parsePosixPs(stdout: string): Proc[] {
  const out: Proc[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const tail = m[4]!.trim().split(/\s+/);
    const etime = tail.length > 1 ? tail.pop()! : '0:00';
    const name = tail.join(' ').split('/').pop() ?? m[4]!;
    out.push({
      pid: Number(m[1]),
      cpu_pct: Number(m[2]),
      memory_bytes: Number(m[3]) * 1024, // rss 单位为 KB
      name,
      started_at: parseEtime(etime),
    });
  }
  return out;
}

/** 降级：ps 不可用时用 pgrep 枚举（仅有 PID 与名称）。 */
async function pgrepFallback(): Promise<Proc[]> {
  const g = await execCommand({ command: 'pgrep -l .', timeoutMs: 15_000 });
  return g.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(\d+)\s+(.*)$/.exec(l);
      if (!m) return null;
      return { pid: Number(m[1]), name: m[2]!.trim(), cpu_pct: 0, memory_bytes: 0, started_at: 0 } satisfies Proc;
    })
    .filter((p): p is Proc => p !== null);
}

export async function processList(args: Args): Promise<unknown> {
  const limit = (args['limit'] as number | undefined) ?? 50;
  const sortBy = (args['sort_by'] as string | undefined) ?? 'cpu';
  const pattern = (args['filter'] as { name_pattern?: string } | undefined)?.name_pattern;

  let procs: Proc[] = [];
  if (IS_WINDOWS) {
    const script =
      '$a=@{};foreach($p in Get-Process){$a[$p.Id]=if($p.CPU){$p.CPU}else{0}};' +
      'Start-Sleep -Milliseconds 500;$r=foreach($p in Get-Process){' +
      '$prev=if($a.ContainsKey($p.Id)){$a[$p.Id]}else{0};$cur=if($p.CPU){$p.CPU}else{0};' +
      '$st=0;if($p.StartTime){$st=[int][double]::Parse($p.StartTime.ToUniversalTime().Subtract([datetime]"1970-01-01").TotalMilliseconds)};' +
      '[pscustomobject]@{pid=$p.Id;name=$p.ProcessName;cpu_pct=[math]::Round((($cur-$prev)/0.5)*100,2);memory_bytes=$p.WorkingSet64;started_at=$st}};' +
      '$r|ConvertTo-Json -Compress';
    const r = await execCommand({ command: script, timeoutMs: 30_000 });
    procs = toArray<Proc>(r.stdout ? JSON.parse(r.stdout) : []);
  } else {
    const r = await execCommand({ command: 'ps -axo pid=,%cpu=,rss=,comm=,etime=', timeoutMs: 15_000 });
    procs = r.exit_code === 0 && r.stdout.trim().length > 0 ? parsePosixPs(r.stdout) : await pgrepFallback();
  }

  let filtered = procs;
  if (pattern) {
    const re = new RegExp(pattern, 'i');
    filtered = filtered.filter((p) => re.test(p.name));
  }

  const keymap: Record<string, (p: Proc) => number | string> = {
    cpu: (p) => -p.cpu_pct,
    memory: (p) => -p.memory_bytes,
    pid: (p) => p.pid,
    name: (p) => p.name.toLowerCase(),
  };
  const key = keymap[sortBy] ?? keymap['cpu']!;
  filtered = [...filtered].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (typeof ka === 'string' && typeof kb === 'string') return ka < kb ? -1 : ka > kb ? 1 : 0;
    return (ka as number) - (kb as number);
  });

  return { processes: filtered.slice(0, limit) };
}

// ---------------- system.service.list ----------------

export async function serviceList(args: Args): Promise<unknown> {
  if (!IS_WINDOWS) {
    throw new CapabilityError(
      ErrorCodes.UNSUPPORTED_PLATFORM,
      'system.service.list 仅在被控端为 Windows 时可用',
      { platform: process.platform },
    );
  }
  const limit = (args['limit'] as number | undefined) ?? 100;
  const filter = args['filter'] as { name_pattern?: string; state?: string } | undefined;

  const r = await execCommand({
    // 注意：Get-Service 的 Status/StartType 是 .NET 枚举，直接 ConvertTo-Json 会退化为
    // 数字（如 4=Running、1=Stopped），必须显式 ToString() 才能得到可读状态。
    command:
      'Get-Service | Select-Object Name,DisplayName,' +
      "@{n='Status';e={$_.Status.ToString()}},@{n='StartType';e={$_.StartType.ToString()}} | " +
      'ConvertTo-Json -Compress',
    timeoutMs: 30_000,
  });
  let services = toArray<{ Name?: string; DisplayName?: string; Status?: string | number; StartType?: string | number }>(
    r.stdout ? JSON.parse(r.stdout) : [],
  ).map((s) => ({
    name: s.Name ?? '',
    display_name: s.DisplayName ?? '',
    state: String(s.Status ?? '').toLowerCase() || 'unknown',
    start_type: String(s.StartType ?? '').toLowerCase() || 'unknown',
  }));

  if (filter?.name_pattern) {
    const re = new RegExp(filter.name_pattern, 'i');
    services = services.filter((s) => re.test(s.name) || re.test(s.display_name));
  }
  if (filter?.state) {
    services = services.filter((s) => s.state === filter.state);
  }
  return { services: services.slice(0, limit) };
}

// ---------------- system.shell.exec ----------------

export async function shellExec(args: Args): Promise<unknown> {
  const command = args['command'] as string;
  if (typeof command !== 'string' || command.length === 0) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'command 不能为空');
  }
  const timeoutMs = (args['timeout_ms'] as number | undefined) ?? 30_000;

  // 异步模式：立即返回 task_id，长命令用 system.task.* 查询/续读/终止
  if (args['async'] === true) {
    const rec = startTask({
      command,
      shell: args['shell'] as never,
      cwd: args['cwd'] as string | undefined,
      timeoutMs: args['wait_forever'] === true ? 0 : timeoutMs,
    });
    return {
      async: true,
      task_id: rec.id,
      state: rec.state,
      hint: '用 system.task.get 增量读取输出，system.task.kill 终止',
    };
  }

  const r = await execCommand({
    command,
    shell: args['shell'] as never,
    cwd: args['cwd'] as string | undefined,
    timeoutMs,
  });
  return r;
}

// ---------------- system.agent.restart ----------------

interface RestartParams {
  nodeExe: string;
  agentJs: string;
  home: string;
  pid: number;
  delayMs: number;
  reason: string;
}

/**
 * 受控重启：延时后由「脱离当前进程组」的机制拉起新的 agent 进程。
 *
 * 背景（真实教训）：此前用 `Start-Process` 起的"分离进程"，会被本项目的
 * killTree（超时强杀整棵进程树）连带清理 —— 导致重启失败、端口僵死、控制端彻底失联。
 * 因此这里改用**计划任务**（Windows）/ detached+unref（POSIX），
 * 二者均不属于当前进程树，可安全地在自身退出后继续执行。
 */
export async function agentRestart(args: Args): Promise<unknown> {
  const delayMs = (args['delay_ms'] as number | undefined) ?? 2000;
  const reason = (args['reason'] as string | undefined) ?? '';

  const nodeExe = process.execPath;
  const agentJs = process.argv[1] ?? '';
  if (!agentJs) {
    throw new CapabilityError(
      ErrorCodes.EXECUTION_FAILED,
      '无法定位 agent 入口（process.argv[1] 为空），拒绝重启以免进程无法拉起',
    );
  }
  const params: RestartParams = {
    nodeExe,
    agentJs,
    home: process.env['NODEAGENT_HOME'] ?? '',
    pid: process.pid,
    delayMs,
    reason,
  };

  return IS_WINDOWS ? scheduleWindowsRestart(params) : detachedPosixRestart(params);
}

/** 把 PowerShell 脚本编码为 UTF-16LE base64，彻底规避引号/中文/换行的转义问题。 */
function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function scheduleWindowsRestart(p: RestartParams): Promise<unknown> {
  // 方案演进（均为真机实测后的结论）：
  //   1) 计划任务 + `start "" node.exe`  → 失败：Session 0 无桌面，start 拉不起进程
  //   2) detached spawn + `start /B`     → 失败：cmd 退出即带走子进程
  //   3) detached spawn + 直接跑 node    → 失败：detached cmd 随 agent 一起消失（日志文件都没生成）
  //   4) 【本方案】计划任务，action = cmd /c「延时 → 杀旧 → 直接跑 node」
  //      —— Task Scheduler 会持有 cmd 进程，cmd 再持有 node 进程，
  //         整条链与旧 agent 完全无关，且不依赖桌面会话。
  // ⚠️ 日志文件必须唯一（带时间戳）：重启任务用 `>> LOG` 启动新 agent，
  //    新 agent 会**长期持有该文件的 stdout 句柄**。若下次重启仍写同一文件，
  //    所有带该重定向的命令会因句柄冲突被整体跳过（包括 taskkill！）——
  //    表现为「restart 返回 ok 但实际什么都没发生」（真机实证：Result=1、
  //    无日志写入、旧进程幸存）。
  const LOG = `C:\\Windows\\Temp\\nodeagent-restart-${Date.now()}.log`;
  const steps = [
    // 清理历史重启日志：仅保留最近 5 个（正被运行中 agent 持有的删除会静默失败，无妨）
    'powershell -NoProfile -Command "Get-ChildItem \'C:\\Windows\\Temp\\nodeagent-restart-*.log\' -EA SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 5 | Remove-Item -Force -EA SilentlyContinue"',
    `echo [%TIME%] begin > "${LOG}" 2>&1`,
    'ping -n 3 127.0.0.1 >nul',
    `echo [%TIME%] killing ${p.pid} >> "${LOG}" 2>&1`,
    `taskkill /F /PID ${p.pid} >> "${LOG}" 2>&1`,
    'ping -n 2 127.0.0.1 >nul',
    `echo [%TIME%] launching >> "${LOG}" 2>&1`,
    `"${p.nodeExe}" "${p.agentJs}" >> "${LOG}" 2>&1`,
    `echo [%TIME%] exited code=%ERRORLEVEL% >> "${LOG}" 2>&1`,
  ];
  // 注意：`set X=Y & cmd` 中 `&` 前的空格会被算进变量值（变成 "Y "），
  // 导致 agent 读不到配置而回退到默认端口 → EADDRINUSE。故此处不加空格。
  const cmdLine = '/c ' + (p.home ? `set NODEAGENT_HOME=${p.home}& ` : '') + steps.join(' & ');

  // ⚠️ 任务名必须唯一（带时间戳）：重启任务的 cmd 会一直持有新 agent 进程，
  //    任务因此长期处于 Running 状态；若沿用固定名，下次 restart 的
  //    Unregister/Register 会静默失败（任务无法覆盖正在运行的实例），
  //    导致「restart 返回成功但实际没有重启」（真机踩过）。
  const TASK = `nodeagent-selfrestart-${Date.now()}`;
  const ps = [
    `$ErrorActionPreference='SilentlyContinue'`,
    // 清理历史 selfrestart 任务。
    //
    // ⚠️ 为什么不能简单清所有非 Running 的：重启任务的 cmd 会**一直持有新 agent 进程**，
    // 所以任务长期处于 Running；若把 Running 的全清掉，会连当前 agent 的宿主一起杀
    // （= 自杀，表现为"restart 成功但 agent 消失"）。原实现只清非 Running，
    // 代价是真机累积了 3 个 Running 僵尸（2026-10-09 实测）。
    //
    // 现策略：非 Running **或** LastRunTime 早于 1 小时 → 清。
    // 1 小时余量远大于一次重启的耗时，因此"当前宿主"绝不会被误判（它刚刚才运行）。
    `$cut = (Get-Date).AddHours(-1)`,
    `Get-ScheduledTask -TaskName 'nodeagent-selfrestart*' -ErrorAction SilentlyContinue | Where-Object { if ($_.State -ne 'Running') { return $true }; $ti = ($_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue); if ($ti -and $ti.LastRunTime -and $ti.LastRunTime -lt $cut) { return $true }; return $false } | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue`,
    `$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '${cmdLine.replace(/'/g, "''")}'`,
    // 不限时（默认 72h 后强制结束），保证 node 能长期运行
    `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0)`,
    // ① 先试「最高权限」：agent 通常以管理员运行，普通权限的 taskkill 杀不掉它，
    //    否则会出现「新进程起来了但端口被占（EADDRINUSE）」。
    `$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest -LogonType Interactive`,
    `Register-ScheduledTask -TaskName '${TASK}' -Action $a -Settings $s -Principal $p -Force | Out-Null`,
    // ② 降级：**非管理员身份下 Highest 会被系统拒绝**（真机 2026-10-09 坐实：
    //    agent 以普通用户运行时，deploy/restart 一律报"注册重启任务失败 exit=1"）。
    //    此时不指定 -Principal —— 默认继承当前用户权限级别（Limited），
    //    注册能成功，且同权限下 taskkill 自己完全够用。
    `if ((Get-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue) -eq $null) { Register-ScheduledTask -TaskName '${TASK}' -Action $a -Settings $s -Force | Out-Null }`,
    // 校验注册真的成功（SilentlyContinue 会吞错，必须显式确认）
    `if ((Get-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue) -eq $null) { Write-Output 'register-failed'; exit 1 }`,
    `Start-ScheduledTask -TaskName '${TASK}'`,
    `Write-Output 'ok'`,
  ].join('; ');

  const r = await execCommand({
    command: `powershell.exe -NoProfile -EncodedCommand ${encodePowerShell(ps)}`,
    timeoutMs: 25_000,
  });
  if (r.exit_code !== 0) {
    throw new CapabilityError(
      ErrorCodes.EXECUTION_FAILED,
      `注册重启任务失败（exit=${r.exit_code}）：${r.stderr || r.stdout}`,
    );
  }
  return {
    scheduled: true,
    delay_ms: p.delayMs,
    mechanism: 'scheduled-task',
    message: `已排入计划任务 ${TASK}（约 ${Math.ceil(p.delayMs / 1000) + 2}s 后重启）`,
  };
}

async function detachedPosixRestart(p: RestartParams): Promise<unknown> {
  const cmd = [
    'sleep 2',
    `kill -9 ${p.pid} 2>/dev/null || true`,
    'sleep 1',
    p.home ? `NODEAGENT_HOME='${p.home}' nohup '${p.nodeExe}' '${p.agentJs}' >/dev/null 2>&1 &` : `nohup '${p.nodeExe}' '${p.agentJs}' >/dev/null 2>&1 &`,
  ].join('; ');

  // detached + unref：脱离当前进程组，父进程退出后仍继续
  const child = spawn('/bin/sh', ['-c', cmd], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  return {
    scheduled: true,
    delay_ms: p.delayMs,
    mechanism: 'detached-spawn',
    message: `已启动分离的重启进程（约 ${Math.ceil(p.delayMs / 1000) + 2}s 后重启）`,
  };
}

// ---------------- system.audit.list ----------------

export async function auditList(args: Args): Promise<unknown> {
  const result = readAudit({
    limit: args['limit'] as number | undefined,
    since: args['since'] as number | undefined,
    clientId: args['client_id'] as string | undefined,
    type: args['type'] as string | undefined,
  });
  return result;
}

/** v11：审计链完整性校验（防篡改）。 */
export async function auditVerify(_args: Args): Promise<unknown> {
  return verifyAudit();
}

/**
 * v2.0.0：返回审计链的链头（只读）。
 *
 * 用途：控制端定期拉取并存到**链外**（Mac 本地 / 另一台机器）—— 这是"外部锚定"的一半。
 * compare=true 时附带与最近一条锚点的比对结论（另一半）。
 */
export async function auditHead(args: Args): Promise<unknown> {
  const head = computeAuditHead();
  if (args['compare'] !== true) return head;
  return { ...head, comparison: compareWithAnchors(args['anchor_path'] as string | undefined) };
}

/**
 * v2.0.0：把当前链头**追加**写到锚点文件（默认 <数据目录>/audit-anchors.jsonl）。
 *
 * 为什么是追加而不是覆盖：历史锚点一旦写成就不可被后续覆盖，否则攻击者重写链后
 * 再"刷新"锚点即可抹掉痕迹。追加式让每次锚定都留痕。
 * path 若指定，仍受 fs_roots 白名单约束（不新开写入面）。
 */
export async function auditAnchor(args: Args): Promise<unknown> {
  const raw = args['path'] as string | undefined;
  const path = raw ? guardPath(raw) : undefined;
  return anchorAudit({ ...(path ? { path } : {}), ...(args['note'] ? { note: String(args['note']) } : {}) });
}

/** v13：成功指标聚合（对齐 PRD 2.2）—— 数据源为审计日志，无需额外埋点。 */
export async function metricsReport(args: Args): Promise<unknown> {
  const since = args['since'] as number | undefined;
  const entries = readAuditAll(since);
  return computeMetrics(entries);
}
