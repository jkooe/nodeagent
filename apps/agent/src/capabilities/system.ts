import os from 'node:os';
import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';
import { readAudit } from '../audit.js';

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
    command:
      'Get-Service | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress',
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
  const r = await execCommand({
    command,
    shell: args['shell'] as never,
    cwd: args['cwd'] as string | undefined,
    timeoutMs: (args['timeout_ms'] as number | undefined) ?? 30_000,
  });
  return r;
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
