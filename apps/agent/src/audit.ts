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
  | 'rate.limited';

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
