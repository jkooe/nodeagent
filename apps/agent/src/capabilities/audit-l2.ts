import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';
import { agentDir } from '../config.js';
import { audit } from '../audit.js';

/**
 * L2 系统级审计兜底（2026-10-17）。
 *
 * ## 它补的是 L1 结构上记不到的那块
 * L1 是「agent 自己记的」：只看得见经过自己 RPC 的调用。
 * 攻击者绕过 agent 直接跑系统命令、或干脆把 agent 停掉 —— L1 全都看不到。
 * L2 采集**操作系统**的审计事件，补的正是这块。
 *
 * ## ⚠️ 信任边界（不要夸大它的作用）
 * 采集器与被审计对象**同进程同权限** —— 攻击者能停 agent 就能停采集器。
 * 故本地 `audit-l2.log` 只是一份**归一化副本**，防篡改价值有限。
 * 真正的独立性来自**把记录转发出机**（与 SECURITY.md §4.8 的锚定同一思路）。
 * 本模块不实现自动转发，只提供导出接口。
 *
 * ## 为什么 Windows 侧选内置 auditpol 而不是 Sysmon
 *   - Sysmon 是第三方驱动：需单独分发、需重启生效、版本行为有差异；
 *   - 内置高级审计策略是 Windows 自带的，零依赖即可立起来；
 *   - 策略：检测到装了 Sysmon 就并用，没装也不尝试下载（不在本仓库职责内）。
 *
 * ## 平台现状
 *   - Windows：**已落地**（status / enable / collect / verify）
 *   - Linux：仅设计（auditd，需预装）—— 见 docs/AUDIT-L2.md
 *   - macOS：仅设计，**ESF 需 Apple entitlement，个人自签无法启用** —— 不写假装能用的代码
 */

type Args = Record<string, unknown>;

/** 归一化后的事件类别（跨平台枚举，详见 docs/AUDIT-L2.md §4）。 */
export type L2Kind =
  | 'process.create'
  | 'process.exit'
  | 'auth.success'
  | 'auth.failure'
  | 'file.access';

export interface L2Entry {
  /** 事件发生时间（来自 OS，不是采集时刻） */
  ts: number;
  src: 'windows-security' | 'sysmon' | 'linux-auditd' | 'macos-esf';
  /** OS 原始事件 ID —— 保留原始值以便人工核对 */
  event_id: number | string;
  kind: L2Kind;
  subject?: string;
  object?: string;
  detail?: Record<string, unknown>;
  /** 采集时刻。与 ts 相差过大说明期间离线或 agent 未运行 */
  collected_at: number;
  prev?: string;
  hash?: string;
}

const GENESIS = 'genesis';

/** L2 独立落盘，不与 L1 混 —— 混了就无法区分「agent 记的」与「OS 记的」。 */
export function l2FilePath(): string {
  return join(agentDir(), 'audit-l2.log');
}

function hashEntry(record: Record<string, unknown>, prev: string): string {
  const keys = Object.keys(record).sort();
  const body = JSON.stringify(record, keys);
  return createHash('sha256').update(`${prev}|${body}`).digest('hex').slice(0, 32);
}

function lastHashOf(): string {
  try {
    const p = l2FilePath();
    if (!existsSync(p)) return GENESIS;
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1];
    if (!last) return GENESIS;
    return (JSON.parse(last) as L2Entry).hash ?? GENESIS;
  } catch {
    return GENESIS;
  }
}

/** 追加一批 L2 记录（带独立哈希链）。 */
function appendL2(entries: Omit<L2Entry, 'prev' | 'hash' | 'collected_at'>[]): number {
  const p = l2FilePath();
  mkdirSync(agentDir(), { recursive: true });
  let prev = lastHashOf();
  const now = Date.now();
  let n = 0;
  for (const e of entries) {
    const full = { ...e, collected_at: now, prev } as unknown as Record<string, unknown>;
    const hash = hashEntry(full, prev);
    (full as Record<string, unknown>)['hash'] = hash;
    appendFileSync(p, `${JSON.stringify(full)}\n`, 'utf8');
    prev = hash;
    n += 1;
  }
  return n;
}

// ---------------- Windows：Security 事件 → 归一化 ----------------

/** Windows 事件 ID → 归一化类别。 */
const WIN_EVENT_KIND: Record<number, L2Kind> = {
  4688: 'process.create',
  4689: 'process.exit',
  4624: 'auth.success',
  4625: 'auth.failure',
  4663: 'file.access',
};

const WIN_WATCHED_IDS = Object.keys(WIN_EVENT_KIND).map(Number);

/**
 * 采集 Windows Security 日志。
 *
 * 只用 PowerShell 内置 cmdlet（Get-WinEvent），不引外部依赖。
 * @param sinceMs 起始时间（Unix ms）；默认 24 小时内
 * @param limit 上限，防止一次拉爆（Security 日志可能极多）
 */
async function collectWindows(sinceMs: number, limit: number): Promise<Omit<L2Entry, 'prev' | 'hash' | 'collected_at'>[]> {
  // 用 ISO8601 传时间，避免区域设置导致的日期解析差异
  const sinceIso = new Date(sinceMs).toISOString();
  const idList = WIN_WATCHED_IDS.join(',');
  const ps = [
    `$ErrorActionPreference = 'Stop'`,
    `$ids = @(${idList})`,
    `$since = (Get-Date '${sinceIso}').ToUniversalTime()`,
    `$evs = Get-WinEvent -FilterHashtable @{LogName='Security'; Id=$ids; StartTime=$since} -MaxEvents ${limit} -ErrorAction SilentlyContinue`,
    `if ($null -eq $evs) { Write-Output '[]'; exit 0 }`,
    `$out = foreach ($e in $evs) {`,
    `  $x = @{ id = $e.Id; t = $e.TimeCreated.ToUniversalTime().ToString('o'); msg = $e.Message }`,
    `  try { $x.sub = $e.Properties[0].Value.ToString() } catch { $x.sub = '' }`,
    `  $x | ConvertTo-Json -Compress -Depth 3`,
    `}`,
    `Write-Output ($out -join "\`n")`,
  ].join('\n');

  const r = await execCommand({ command: ps, timeoutMs: 60_000 });
  if (r.exit_code !== 0) {
    // 常见：权限不足（非管理员读不了 Security 日志）
    throw new CapabilityError(
      ErrorCodes.EXECUTION_FAILED,
      '读取 Windows Security 日志失败（常见原因：未以管理员运行，或审计策略未启用）',
      { detail: (r.stderr || r.stdout).slice(0, 300) },
    );
  }
  const text = r.stdout.trim();
  if (!text || text === '[]') return [];

  const out: Omit<L2Entry, 'prev' | 'hash' | 'collected_at'>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as { id?: number; t?: string; msg?: string; sub?: string };
      const id = Number(o.id);
      const kind = WIN_EVENT_KIND[id];
      if (!kind) continue;
      const ts = o.t ? Date.parse(o.t) : Date.now();
      // 从 Message 里抠进程名（4688 的「新进程名称」），拿不到就留空 —— 不猜
      // 括号不可省：TS 不允许 ?? 与 || 无括号混用
      const obj =
        (/新进程名称:\s*(.+)/.exec(o.msg ?? '')?.[1]?.trim() ??
          /进程名称:\s*(.+)/.exec(o.msg ?? '')?.[1]?.trim()) ||
        undefined;
      out.push({
        ts: Number.isFinite(ts) ? ts : Date.now(),
        src: 'windows-security',
        event_id: id,
        kind,
        subject: o.sub || undefined,
        object: obj,
        detail: { raw_message_head: (o.msg ?? '').slice(0, 300) },
      });
    } catch {
      /* 跳过解析失败的单条，不影响整体 */
    }
  }
  return out;
}

// ---------------- 对外能力 ----------------

export async function auditL2(args: Args): Promise<unknown> {
  const action = (args['action'] as string | undefined) ?? 'status';

  if (!IS_WINDOWS) {
    // 明确区分「平台不支持」与「失败」—— 避免调用方误以为是权限问题
    throw new CapabilityError(
      ErrorCodes.UNSUPPORTED_PLATFORM,
      'L2 采集当前仅落地 Windows。Linux（auditd）与 macOS（ESF）见 docs/AUDIT-L2.md —— ' +
        'macOS 侧受 Apple entitlement 限制，个人自签无法启用，故未实现。',
      { platform: process.platform },
    );
  }

  if (action === 'status') return l2Status();
  if (action === 'enable') return await l2Enable();
  if (action === 'collect') {
    const since = typeof args['since'] === 'number' ? args['since'] : Date.now() - 24 * 3600 * 1000;
    const limit = Math.max(1, Math.min(5000, (args['limit'] as number | undefined) ?? 1000));
    const entries = await collectWindows(since, limit);
    const written = appendL2(entries);
    audit({ type: 'agent.start', status: 'ok', reason: `l2.collect written=${written} since=${new Date(since).toISOString()}` });
    return {
      collected: entries.length,
      written,
      since,
      limit,
      file: l2FilePath(),
      note:
        '本地 audit-l2.log 只是归一化副本；真正防篡改依赖把记录转发出机（见 docs/AUDIT-L2.md §2）',
    };
  }
  if (action === 'verify') return verifyL2();

  throw new CapabilityError(ErrorCodes.PARAM_INVALID, `action 只支持 status|enable|collect|verify，收到 ${action}`);
}

/** 检查 Windows 审计策略是否已启用（并提示命令行记录开关）。 */
async function l2Status(): Promise<unknown> {
  const ps = [
    `$ErrorActionPreference='Stop'`,
    `$o = auditpol /get /category:* /r`,
    // /r 输出 CSV：Machine Name,Policy Target,Subcategory,Subcategory GUID,Inclusion Setting,Exclusion Setting
    `$rows = $o | ConvertFrom-Csv`,
    `$want = @('Process Creation','Logon','Process Termination')`,
    `$got = @()`,
    `foreach ($w in $want) {`,
    `  $m = $rows | Where-Object { $_.Subcategory -eq $w } | Select-Object -First 1`,
    `  if ($m) { $got += ($w + '=' + $m.'Inclusion Setting') } else { $got += ($w + '=not found') }`,
    `}`,
    `Write-Output ($got -join '; ')`,
    `$legacy = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa' -Name SCENoApplyLegacyAuditPolicy -ErrorAction SilentlyContinue).SCENoApplyLegacyAuditPolicy`,
    `Write-Output ("SCENoApplyLegacyAuditPolicy=" + $(if ($null -eq $legacy) { 'not set' } else { $legacy }))`,
    `$cmdline = (Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit' -Name ProcessCreationIncludeCmdLine_Enabled -ErrorAction SilentlyContinue).ProcessCreationIncludeCmdLine_Enabled`,
    `Write-Output ("ProcessCreationIncludeCmdLine_Enabled=" + $(if ($null -eq $cmdline) { 'not set' } else { $cmdline }))`,
  ].join('\n');

  const r = await execCommand({ command: ps, timeoutMs: 60_000 });
  const out = r.stdout || '';
  const sysmon = await detectSysmon();

  return {
    platform: 'windows',
    supported: true,
    auditpol: out.trim(),
    // 不设它，组策略的旧式类别策略会盖掉 subcategory 设置 ——
    // 表现为「auditpol 显示已启用，但事件日志里没有 4688」
    legacy_policy_disabled: /SCENoApplyLegacyAuditPolicy=1/.test(out),
    cmdline_logging: /ProcessCreationIncludeCmdLine_Enabled=1/.test(out),
    sysmon_installed: sysmon,
    file: l2FilePath(),
    file_exists: existsSync(l2FilePath()),
    note: r.exit_code !== 0 ? 'auditpol 查询未成功返回（可能需要管理员权限）' : undefined,
  };
}

/** 启用 Windows 高级审计策略（需管理员）。 */
async function l2Enable(): Promise<unknown> {
  const ps = [
    `$ErrorActionPreference='Stop'`,
    // ① 让「高级审计策略」生效，覆盖旧式类别策略
    `New-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa' -Name SCENoApplyLegacyAuditPolicy -Value 1 -PropertyType DWORD -Force | Out-Null`,
    // ② 命令行记录：不开的话 4688 只有进程名，看不到参数
    `New-Item -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit' -Force | Out-Null`,
    `New-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit' -Name ProcessCreationIncludeCmdLine_Enabled -Value 1 -PropertyType DWORD -Force | Out-Null`,
    // ③ 开启关注的 subcategory
    `auditpol /set /subcategory:"进程创建" /success:enable /failure:enable`,
    `auditpol /set /subcategory:"登录" /success:enable /failure:enable`,
    `auditpol /set /subcategory:"进程终止" /success:enable`,
    `Write-Output 'enabled'`,
  ].join('\n');

  const r = await execCommand({ command: ps, timeoutMs: 90_000 });
  if (r.exit_code !== 0) {
    throw new CapabilityError(
      ErrorCodes.EXECUTION_FAILED,
      '启用审计策略失败（需要管理员权限）。未提权时请先用管理员身份运行。',
      { detail: (r.stderr || r.stdout).slice(0, 300) },
    );
  }
  audit({ type: 'agent.start', status: 'ok', reason: 'l2.enable windows audit policy' });
  return {
    enabled: true,
    platform: 'windows',
    policies: ['进程创建 4688', '登录 4624/4625', '进程终止 4689'],
    cmdline_logging: true,
    hint: '策略生效后需要一段时间才会产生事件；用 action=collect 拉取',
  };
}

/** 检测 Sysmon 是否安装（装了就并用其日志，没装不尝试下载）。 */
async function detectSysmon(): Promise<boolean> {
  const r = await execCommand({
    command: `$ErrorActionPreference='SilentlyContinue'; (Get-Service Sysmon -ErrorAction SilentlyContinue).Name`,
    timeoutMs: 20_000,
  });
  return r.stdout.trim() === 'Sysmon';
}

// ---------------- L2 链校验 ----------------

export interface L2VerifyResult {
  ok: boolean;
  checked: number;
  broken_at?: { line: number; reason: string };
}

/** 校验 L2 链完整性（与 L1 同构算法，独立文件独立链）。 */
export function verifyL2(): L2VerifyResult {
  const p = l2FilePath();
  if (!existsSync(p)) return { ok: true, checked: 0 };
  let expected: string | null = null;
  let checked = 0;
  let line = 0;
  try {
    for (const raw of readFileSync(p, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      line += 1;
      let rec: L2Entry;
      try {
        rec = JSON.parse(raw) as L2Entry;
      } catch {
        return { ok: false, checked, broken_at: { line, reason: 'JSON 解析失败（条目被破坏）' } };
      }
      const { hash, ...body } = rec;
      if (!hash) continue;
      const recalc = hashEntry(body as unknown as Record<string, unknown>, rec.prev ?? GENESIS);
      if (recalc !== hash) {
        return { ok: false, checked, broken_at: { line, reason: '内容与哈希不符（条目被篡改）' } };
      }
      if (expected !== null && rec.prev !== expected) {
        return { ok: false, checked, broken_at: { line, reason: '链断裂（prev 与上一条哈希不匹配）' } };
      }
      expected = hash;
      checked += 1;
    }
  } catch {
    return { ok: false, checked, broken_at: { line, reason: '读取 L2 文件失败' } };
  }
  return { ok: true, checked };
}

/** 读取 L2 记录（供导出转发 —— 真正的独立性来自这里，而非本地副本）。 */
export function readL2(limit = 200): L2Entry[] {
  const p = l2FilePath();
  if (!existsSync(p)) return [];
  const out: L2Entry[] = [];
  try {
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    for (const l of lines.slice(-Math.max(1, limit))) {
      try {
        out.push(JSON.parse(l) as L2Entry);
      } catch {
        /* 跳过损坏行 */
      }
    }
  } catch {
    /* 读失败返回已有部分 */
  }
  return out;
}
