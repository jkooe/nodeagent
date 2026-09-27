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
export function audit(entry: Omit<AuditEntry, 'ts'>): void {
  if (!opts.enabled) return;
  try {
    const full: AuditEntry = { ts: Date.now(), ...entry };
    rotateIfNeeded();
    appendFileSync(auditFilePath(), `${JSON.stringify(full)}\n`);
  } catch {
    /* 审计失败不影响业务 */
  }
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

/** 读取审计记录（取最新 limit 条，按时间升序返回）。 */
export function readAudit(query: AuditQuery = {}): { entries: AuditEntry[]; total: number; file: string } {
  const p = auditFilePath();
  if (!existsSync(p)) return { entries: [], total: 0, file: p };

  let entries: AuditEntry[] = [];
  try {
    const lines = readFileSync(p, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* 跳过损坏行 */
      }
    }
  } catch {
    return { entries: [], total: 0, file: p };
  }

  const total = entries.length;
  if (query.since !== undefined) entries = entries.filter((e) => e.ts > query.since!);
  if (query.clientId) entries = entries.filter((e) => e.client_id === query.clientId);
  if (query.type) entries = entries.filter((e) => e.type.startsWith(query.type!));

  const limit = Math.max(1, Math.min(query.limit ?? 50, 1000));
  return { entries: entries.slice(-limit), total, file: p };
}
