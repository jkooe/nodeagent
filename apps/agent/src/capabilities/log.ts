/**
 * log.query（v2.0.0，方向二「状态」第一块）。
 *
 * ## 为什么必须有
 * 治间歇性问题（代理不通、杀软拦截、端口时开时闭）要看**历史**，而被控端日志常在
 * 几万行以上。`fs.read` 虽有 8MB 上限，但"整份拉回再筛"既慢又占带宽 ——
 * 过滤必须发生在 **Windows 侧**。
 *
 * ## 实现要点
 * - 流式逐行读（readline），**不全量载入内存**；扫到 limit 条即停
 * - 三级过滤：`pattern`（正则，大小写不敏感）/ `level`（ERROR|WARN|INFO|DEBUG，
 *   命中行内含 `[LEVEL]` 或 `LEVEL:` 即算）/ `since`（Unix ms，按行首时间戳或
 *   文件 mtime 粗筛）
 * - 路径仍走 `fs.guardPath` 的白名单（fs_roots 非空即受限）—— 不新开安全面
 * - 单行超长保护：超过 4KB 的行截断后再匹配，避免一行巨型 JSON 拖垮内存
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { statSync } from 'node:fs';
import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { guardPath } from './fs.js';

type Args = Record<string, unknown>;

const MAX_LINE = 4096;
const MAX_SCAN = 2_000_000; // 单次查询最多扫 200 万行，防失控文件拖死 agent

export interface LogLine {
  /** 行号（从 1 开始）—— 回看时便于对照原文件 */
  n: number;
  text: string;
}

export interface LogQueryResult {
  path: string;
  matched: LogLine[];
  /** 实际扫描过的行数（用于判断"是扫完了还是被 limit 截住"） */
  scanned: number;
  /** 是否因达到 MAX_SCAN 提前结束 */
  truncated: boolean;
  note?: string;
}

/** 从行里推断日志级别（找不到返回 null，不猜）。 */
function detectLevel(line: string): string | null {
  const m = /\[(ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\]|\b(ERROR|WARN|INFO|DEBUG|TRACE):/i.exec(line);
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? '').toUpperCase();
  return raw === 'WARNING' ? 'WARN' : raw;
}

export async function logQuery(args: Args): Promise<LogQueryResult> {
  const p = guardPath(args['path'] as string);
  const limit = Math.max(1, Math.min(5000, (args['limit'] as number | undefined) ?? 100));
  const offset = Math.max(0, (args['offset'] as number | undefined) ?? 0);
  const patternStr = args['pattern'] as string | undefined;
  const level = (args['level'] as string | undefined)?.toUpperCase();
  const since = args['since'] as number | undefined;
  const tail = (args['tail'] as boolean | undefined) ?? false;

  let re: RegExp | null = null;
  if (patternStr) {
    try {
      re = new RegExp(patternStr, 'i');
    } catch (err) {
      throw new CapabilityError(ErrorCodes.PARAM_INVALID, `pattern 不是合法正则: ${patternStr}`, {
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (level && !['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'].includes(level)) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `不支持的 level: ${level}`, {
      allowed: ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'],
    });
  }

  let st;
  try {
    st = statSync(p);
  } catch {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `文件不存在或不可读: ${p}`);
  }
  if (!st.isFile()) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `不是普通文件: ${p}`);
  }
  // since 粗筛：文件在 since 之前就没改过，必然没有更新的行 —— 省一次全扫
  if (since !== undefined && st.mtimeMs < since) {
    return { path: p, matched: [], scanned: 0, truncated: false, note: '文件 mtime 早于 since，未扫描' };
  }

  // tail 模式：保留最后 limit 条命中的环形缓冲（边扫边丢旧的）
  const ring: LogLine[] = [];
  let matched = 0;
  let scanned = 0;
  let truncated = false;

  const rl = createInterface({
    input: createReadStream(p, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const rawLine of rl) {
    scanned += 1;
    if (scanned > MAX_SCAN) {
      truncated = true;
      break;
    }
    let line = rawLine;
    if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}…[截断]`;
    if (re && !re.test(line)) continue;
    if (level && detectLevel(line) !== level) continue;
    // since 精确筛：只在行首能解出时间戳时才按时间比（解不出就放行，交由调用方判断）
    if (since !== undefined) {
      const ts = parseLeadingTs(line);
      if (ts !== null && ts < since) continue;
    }
    matched += 1;
    if (tail) {
      ring.push({ n: scanned, text: line });
      if (ring.length > limit) ring.shift();
    } else {
      if (matched > offset && matched <= offset + limit) ring.push({ n: scanned, text: line });
      if (matched > offset + limit) break; // 已取够，提前收工
    }
  }

  return {
    path: p,
    matched: ring,
    scanned,
    truncated,
    ...(truncated ? { note: `扫描超过 ${MAX_SCAN} 行上限，结果可能不完整` } : {}),
  };
}

/**
 * 行首时间戳 → Unix ms（支持 ISO 与常见 `[2026-10-07 12:34:56]` 形态；解不出返回 null）。
 *
 * ⚠️ 必须**连同时区后缀一起解析**：只截取到秒会丢掉 `Z` / `+08:00`，
 * 让 UTC 时间被当本地时间读 —— 实测会整体偏 8 小时（真机日志跨时区时判断"何时断的"就错了）。
 */
export function parseLeadingTs(line: string): number | null {
  const m = /^\[?(\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(line);
  if (!m) return null;
  // 无时区信息时按本地时间解析（与 `[2026-10-07 10:00:12]` 这类本地日志的语义一致）；
  // 带 Z / ±hh:mm 时 Date.parse 自行按该时区处理 —— 关键是**别把后缀截掉**。
  const iso = m[1]!.replace(/\//g, '-').replace(' ', 'T');
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
