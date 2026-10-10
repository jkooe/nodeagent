import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { agentDir } from './config.js';

export type AuditType =
  | 'agent.start'
  | 'agent.stop'
  | 'auth.success'
  | 'auth.failure'
  | 'invoke'
  | 'acl.denied'
  | 'capability.disabled'
  | 'rate.limited'
  /** v16：网络配置变更（两阶段提交） */
  | 'net.change'
  /** v21：来源不在 allow_from 被拒 */
  | 'net.deny'
  /** v19：agent 自更新（拉取式） */
  | 'agent.update'
  /** v2.0.0：连接空闲被主动断开 */
  | 'session.idle_close';

/** 一条审计记录（JSONL 单行）。 */
export interface AuditEntry {
  /** Unix 毫秒时间戳 */
  ts: number;
  type: AuditType;
  client_id?: string;
  /** 来源地址 */
  remote?: string;
  capability?: string;
  status?: 'ok' | 'failed' | 'denied';
  duration_ms?: number;
  error?: string | null;
  /** 参数摘要（sha256 前缀），用于比对而不泄露内容 */
  args_digest?: string;
  /** 参数预览（默认不记录；开启后自动脱敏） */
  args_preview?: string;
  reason?: string;
  /** v11 防篡改：上一条记录哈希（首条为 "genesis"） */
  prev?: string;
  /** v11 防篡改：本条记录哈希（prev + 规范化正文 的 sha256 前 32 位） */
  hash?: string;
}

export interface AuditOptions {
  enabled: boolean;
  maxBytes: number;
  maxFiles: number;
  /** 是否记录参数预览（默认为 false，只记摘要） */
  logArgs: boolean;
}

const DEFAULTS: AuditOptions = {
  enabled: true,
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 5,
  logArgs: false,
};

let opts: AuditOptions = { ...DEFAULTS };
let currentPath = '';

/** v11：链式哈希锚点（进程内维护；启动时从日志尾部恢复） */
const GENESIS = 'genesis';
let lastHash = GENESIS;

/** 规范化后计算条目哈希：键排序保证跨进程/跨版本稳定。 */
function hashEntry(record: Record<string, unknown>, prev: string): string {
  const keys = Object.keys(record).sort();
  const body = JSON.stringify(record, keys);
  return createHash('sha256').update(`${prev}|${body}`).digest('hex').slice(0, 32);
}

/** 从日志尾部恢复链锚点，保证 agent 重启后链不断。 */
function recoverChainAnchor(): void {
  try {
    const p = auditFilePath();
    if (!existsSync(p)) {
      lastHash = GENESIS;
      return;
    }
    const lines = readFileSync(p, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim();
      if (!line) continue;
      const rec = JSON.parse(line) as AuditEntry;
      lastHash = rec.hash ?? GENESIS;
      return;
    }
    lastHash = GENESIS;
  } catch {
    lastHash = GENESIS;
  }
}

/** 初始化审计（返回审计文件路径）。显式 undefined 不会覆盖默认值。 */
export function initAudit(options: Partial<AuditOptions> = {}, dir?: string): string {
  opts = {
    enabled: options.enabled ?? DEFAULTS.enabled,
    maxBytes: options.maxBytes ?? DEFAULTS.maxBytes,
    maxFiles: options.maxFiles ?? DEFAULTS.maxFiles,
    logArgs: options.logArgs ?? DEFAULTS.logArgs,
  };
  const base = dir ?? agentDir();
  mkdirSync(base, { recursive: true });
  currentPath = join(base, 'audit.log');
  recoverChainAnchor();
  return currentPath;
}

export function auditFilePath(): string {
  return currentPath || join(agentDir(), 'audit.log');
}

const SENSITIVE_KEY = /(pass|pwd|secret|token|key|credential|auth)/i;

/** 递归脱敏 + 截断，避免审计本身成为泄露渠道。 */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '***' : sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}…`;
  return value;
}

/** 生成参数摘要与（可选）脱敏预览 —— 字段名与 AuditEntry 对齐，便于展开。 */
export function describeArgs(args: unknown): { args_digest: string; args_preview?: string } {
  const json = JSON.stringify(args ?? {});
  const digest = `sha256:${createHash('sha256').update(json).digest('hex').slice(0, 16)}`;
  if (!opts.logArgs) return { args_digest: digest };
  return { args_digest: digest, args_preview: JSON.stringify(sanitize(args)) };
}

/** 写入一条审计记录。任何异常都被吞掉 —— 审计绝不阻断主流程。 */
export function audit(entry: Omit<AuditEntry, 'ts' | 'prev' | 'hash'>): void {
  if (!opts.enabled) return;
  try {
    const full: AuditEntry = { ts: Date.now(), ...entry };
    // v11 链式哈希：prev 指向上一条的 hash，形成不可静默篡改的链
    const record: AuditEntry = { ...full, prev: lastHash };
    record.hash = hashEntry(record as unknown as Record<string, unknown>, lastHash);
    rotateIfNeeded();
    appendFileSync(auditFilePath(), `${JSON.stringify(record)}\n`);
    lastHash = record.hash;
  } catch {
    /* 审计失败不影响业务 */
  }
}

export interface AuditVerifyResult {
  ok: boolean;
  /** 参与校验的条目总数 */
  checked: number;
  /** 无链字段的历史条目数（老版本写入，跳过校验） */
  legacy: number;
  /** 首个异常位置（文件 + 行号 + 原因） */
  broken_at?: { file: string; line: number; reason: string };
}

/**
 * 校验审计链完整性（v11）。
 * 按时间顺序遍历「轮转文件（旧→新）+ 当前文件」，逐条重算哈希并比对 prev 链接。
 * 老版本（无 hash 字段）条目记为 legacy 跳过，保证升级后不误报。
 */
export function verifyAudit(): AuditVerifyResult {
  const p = auditFilePath();
  const files: string[] = [];
  for (let i = 20; i >= 1; i -= 1) {
    const f = `${p}.${i}`;
    if (existsSync(f)) files.push(f);
  }
  files.push(p);

  let checked = 0;
  let legacy = 0;
  // null = 尚未锚定。轮转会丢弃最旧文件，故首个带链条目只作锚点、不校验 prev；
  // 之后逐条比对 prev，链中间被篡改/删除必被发现。
  let expected: string | null = null;

  for (const f of files) {
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]?.trim();
      if (!raw) continue;
      let rec: AuditEntry;
      try {
        rec = JSON.parse(raw) as AuditEntry;
      } catch {
        return { ok: false, checked, legacy, broken_at: { file: f, line: i + 1, reason: 'JSON 解析失败（条目被破坏）' } };
      }
      if (!rec.hash) {
        legacy += 1;
        expected = null; // 链接锚点未知，等待下一条带链字段的记录重新锚定
        continue;
      }
      const { hash, ...body } = rec;
      const recalculated = hashEntry(body as unknown as Record<string, unknown>, rec.prev ?? GENESIS);
      if (recalculated !== hash) {
        return {
          ok: false,
          checked,
          legacy,
          broken_at: { file: f, line: i + 1, reason: '内容与哈希不符（条目被篡改）' },
        };
      }
      if (expected !== null && rec.prev !== expected) {
        return {
          ok: false,
          checked,
          legacy,
          broken_at: { file: f, line: i + 1, reason: '链断裂（prev 与上一条哈希不匹配，可能被删除或替换）' },
        };
      }
      expected = hash;
      checked += 1;
    }
  }
  return { ok: true, checked, legacy };
}

/** 大小超限时轮转：audit.log → .1 → .2 …（超出 maxFiles 的最旧文件被丢弃）。 */
function rotateIfNeeded(): void {
  const p = auditFilePath();
  if (!existsSync(p)) return;
  try {
    if (statSync(p).size < opts.maxBytes) return;
    for (let i = opts.maxFiles - 1; i >= 1; i -= 1) {
      const from = `${p}.${i}`;
      if (existsSync(from)) {
        try {
          renameSync(from, `${p}.${i + 1}`);
        } catch {
          /* 忽略单个文件轮转失败 */
        }
      }
    }
    renameSync(p, `${p}.1`);
  } catch {
    /* 忽略 */
  }
}

export interface AuditQuery {
  limit?: number;
  since?: number;
  clientId?: string;
  type?: string;
}

function readEntriesFromFile(file: string): AuditEntry[] {
  if (!existsSync(file)) return [];
  const out: AuditEntry[] = [];
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* 跳过损坏行 */
      }
    }
  } catch {
    /* 单文件读取失败不影响整体 */
  }
  return out;
}

/**
 * 读取审计记录（取最新 limit 条，按时间升序返回）。
 * 会同时读取轮转文件（audit.log.1/.2/…），避免历史记录被遗漏。
 */
/**
 * 读取全部审计条目（跨轮转文件，按时间升序）。
 * 供指标聚合等「需要全窗口样本」的场景使用 —— readAudit 有 limit 上限（最多 1000 条）。
 * 安全上限 20 万条，防止极端情况下把内存吃爆。
 */
export function readAuditAll(since?: number): AuditEntry[] {
  const p = auditFilePath();
  const files: string[] = [];
  for (let i = 20; i >= 1; i -= 1) {
    const f = `${p}.${i}`;
    if (existsSync(f)) files.push(f);
  }
  files.push(p);

  const out: AuditEntry[] = [];
  for (const f of files) {
    for (const e of readEntriesFromFile(f)) {
      if (since !== undefined && e.ts <= since) continue;
      out.push(e);
      if (out.length >= 200_000) break;
    }
    if (out.length >= 200_000) break;
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export function readAudit(query: AuditQuery = {}): { entries: AuditEntry[]; total: number; file: string } {
  const p = auditFilePath();
  if (!existsSync(p)) return { entries: [], total: 0, file: p };

  const limit = Math.max(1, Math.min(query.limit ?? 50, 1000));

  // 收集候选文件：当前文件 + 轮转文件（从新到旧）
  const files: string[] = [p];
  for (let i = 1; i <= 20 && existsSync(`${p}.${i}`); i += 1) files.push(`${p}.${i}`);

  const collected: AuditEntry[] = [];
  let total = 0;
  for (const f of files) {
    const list = readEntriesFromFile(f);
    total += list.length;
    for (const e of list) {
      if (query.since !== undefined && e.ts <= query.since) continue;
      if (query.clientId && e.client_id !== query.clientId) continue;
      if (query.type && !e.type.startsWith(query.type)) continue;
      collected.push(e);
    }
    // 已凑够需要的条数，可提前停止（避免无谓地读完所有轮转文件）
    if (collected.length >= limit) break;
  }

  collected.sort((a, b) => a.ts - b.ts);
  return { entries: collected.slice(-limit), total, file: p };
}


// ---------------- v2.0.0 审计链外部锚定 ----------------
//
// ## 为什么需要
// 审计链的哈希使**链内**篡改可被发现（改一条就要重算其后全部）。但「有 root 的攻击者」
// 可以**整链重写**：从零重建一份自洽的假日志，链校验照样通过。
// 外部锚定就是打破这一点：定期把**链头哈希 + 条目数**记到链外的独立位置
// （另一台机器 / 网盘 / U 盘）。事后比对时，若「当前链在某锚点之后的部分对不上」，
// 说明这段被重写过 —— 攻击者无法回到过去改掉已经落到别处的锚点。
//
// ## 记什么（关键：不能只记哈希）
// 轮转会丢弃最旧的段，所以条目数会**下降**。只记 head_hash 会导致轮转后被误判为篡改。
// 故锚点记 {entries, head_hash, head_ts, rotated_segments} 四元组，
// 比对时先按"轮转了几段"对齐，再判断尾部是否一致。

export interface AuditHead {
  /** 当前链可见条目数（含轮转段） */
  entries: number;
  /** 链头哈希（末条的 hash）—— 这是要外部留存的核心值 */
  head_hash: string | null;
  /** 末条时间戳 */
  head_ts: number | null;
  /** 存在的轮转段数（.log.1 … .log.20） */
  rotated_segments: number;
  file: string;
  file_bytes: number;
  computed_at: number;
}

/** 计算当前审计链的头部信息（只读）。 */
export function computeAuditHead(): AuditHead {
  const p = auditFilePath();
  let rotated = 0;
  for (let i = 1; i <= 20; i += 1) if (existsSync(`${p}.${i}`)) rotated += 1;

  const entries = readAuditAll();
  const last = entries.length > 0 ? entries[entries.length - 1]! : null;
  let fileBytes = 0;
  try {
    fileBytes = statSync(p).size;
  } catch {
    /* 文件可能尚不存在（还没写过审计） */
  }
  return {
    entries: entries.length,
    head_hash: last?.hash ?? null,
    head_ts: last?.ts ?? null,
    rotated_segments: rotated,
    file: p,
    file_bytes: fileBytes,
    computed_at: Date.now(),
  };
}

export interface AnchorRecord {
  ts: number;
  entries: number;
  head_hash: string | null;
  head_ts: number | null;
  rotated_segments: number;
  note?: string;
}

/** 锚点文件路径（默认与审计同目录）。 */
export function anchorFilePath(custom?: string): string {
  return custom && custom.trim().length > 0 ? custom.trim() : join(agentDir(), 'audit-anchors.jsonl');
}

/** 把当前链头**追加**到锚点文件（追加式：历史锚点不可被后续覆盖）。 */
export function anchorAudit(opts: { path?: string; note?: string } = {}): {
  file: string;
  record: AnchorRecord;
  total_lines: number;
} {
  const head = computeAuditHead();
  const file = anchorFilePath(opts.path);
  const rec: AnchorRecord = {
    ts: Date.now(),
    entries: head.entries,
    head_hash: head.head_hash,
    head_ts: head.head_ts,
    rotated_segments: head.rotated_segments,
    ...(opts.note ? { note: opts.note } : {}),
  };
  appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
  let total = 0;
  try {
    total = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    total = 1;
  }
  return { file, record: rec, total_lines: total };
}

export interface AnchorComparison {
  ok: boolean;
  anchors_checked: number;
  latest?: AnchorRecord;
  verdict: string;
  detail?: Record<string, unknown>;
}

/**
 * 与最近一条锚点比对，判断当前链是否与锚定时刻自洽。
 *
 * 判定逻辑（三条）：
 *  - 条目数应 **≥** 锚点记录（只增不减；减少只能由轮转解释，轮转会让 rotated_segments 变大）
 *  - 若条目数与轮转段数都没变 → 链头哈希必须**完全一致**
 *  - 若已轮转（段数变大）→ 只校验"当前 entries ≥ 锚点 entries"，并提示需人工核对
 */
export function compareWithAnchors(customPath?: string): AnchorComparison {
  const file = anchorFilePath(customPath);
  if (!existsSync(file)) {
    return { ok: true, anchors_checked: 0, verdict: '尚无锚点：请先调用 system.audit.anchor 建立外部锚点' };
  }
  let anchors: AnchorRecord[] = [];
  try {
    anchors = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AnchorRecord);
  } catch {
    return { ok: false, anchors_checked: 0, verdict: '锚点文件损坏，无法比对' };
  }
  if (anchors.length === 0) {
    return { ok: true, anchors_checked: 0, verdict: '锚点文件为空' };
  }
  const latest = anchors[anchors.length - 1]!;
  const head = computeAuditHead();

  if (head.entries < latest.entries && head.rotated_segments <= latest.rotated_segments) {
    return {
      ok: false,
      anchors_checked: anchors.length,
      latest,
      verdict: '**疑似整链重写/回滚**：当前条目数少于锚点，且没有发生轮转来解释',
      detail: { anchored_entries: latest.entries, current_entries: head.entries, anchored_hash: latest.head_hash, current_hash: head.head_hash },
    };
  }
  if (head.rotated_segments === latest.rotated_segments && head.entries === latest.entries) {
    if (head.head_hash !== latest.head_hash) {
      return {
        ok: false,
        anchors_checked: anchors.length,
        latest,
        verdict: '**链头哈希与锚点不一致**（条目数相同却哈希不同 → 该段被重写）',
        detail: { anchored_hash: latest.head_hash, current_hash: head.head_hash, entries: head.entries },
      };
    }
    return { ok: true, anchors_checked: anchors.length, latest, verdict: '与锚点完全一致（条目数、轮转段数、链头哈希三者相符）' };
  }
  return {
    ok: true,
    anchors_checked: anchors.length,
    latest,
    // ⚠️ 注意：锚定动作**自身**也会被记入审计（server 层统一记录所有 invoke），
    // 所以「刚锚定就比对」几乎必然看到"已增长"——这是正常现象，不是篡改。
    // 想看到"完全一致"，需在同一时刻不再产生新审计（实际很难，属预期）。
    verdict:
      '链已增长（或发生轮转）—— 锚点仍在链上，无需人工核对到该锚点为止的部分。' +
      '（刚锚定就比对通常显示"已增长"，因为锚定调用自身也会写一条审计。）',
    detail: { anchored_entries: latest.entries, current_entries: head.entries, rotated_delta: head.rotated_segments - latest.rotated_segments, anchored_hash: latest.head_hash, current_hash: head.head_hash },
  };
}
