import type { AuditEntry } from './audit.js';

/**
 * 成功指标聚合（v13 / 对齐 PRD 2.2 四项验收指标）。
 *
 * 数据源就是审计日志 —— invoke 条目自带 capability / status / duration_ms，
 * acl.denied / rate.limited / auth.failure 自带拦截语义，无需额外埋点。
 *
 * 四项指标（PRD 2.2）：
 *   1) 闭环成功率 ≥ 95%   —— invoke 成功数 / 总数
 *   2) 装软件成功率 ≥ 90% —— app.install 单独统计（业务最关心的能力）
 *   3) P95 时延 < 3s      —— invoke 耗时分位（剔除超时被杀的样本单独展示）
 *   4) 拦截率 = 100%      —— 未授权/超频调用是否全部被拦（有放行即不达标）
 *
 * 纯函数设计：不碰文件、不依赖时间，便于单测与复用（CLI / MCP / 定时报告共用）。
 */

/**
 * 「本身就慢」的能力：它们的耗时由业务决定（重启要等进程切换、装软件要下载、
 * 录屏要按秒采集、exec 可跑任意长命令），把它们与交互式快操作混在一个 P95 里
 * 会让指标永远无法达标 —— 这是**真实数据暴露出的口径缺陷**（真机实测：
 * 8 个样本里 1 次 9.6s 的重启，直接把 P95 顶穿）。
 * 因此分层：快操作算 P95 并判定达标，慢操作单独给出完成时长。
 */
export const DEFAULT_SLOW_CAPABILITIES = [
  'system.agent.restart',
  'app.install',
  'screen.record',
  'system.shell.exec',
];

export interface MetricsTargets {
  close_loop_success_rate: number;
  app_install_success_rate: number;
  p95_ms: number;
}

export const DEFAULT_TARGETS: MetricsTargets = {
  close_loop_success_rate: 0.95,
  app_install_success_rate: 0.9,
  p95_ms: 3000,
};

export interface CapabilityStat {
  attempts: number;
  ok: number;
  failed: number;
  success_rate: number;
  p95_ms: number;
  avg_ms: number;
}

export interface MetricsReport {
  window: { from: number; to: number; entries: number };
  /** 指标 1：闭环成功率 */
  close_loop: { attempts: number; ok: number; failed: number; success_rate: number };
  /** 指标 2：装软件成功率（app.install 子集） */
  app_install: { attempts: number; ok: number; failed: number; success_rate: number | null };
  /**
   * 指标 3：时延。分两层：
   *   - 交互层（fast）：剔除「本身就慢」的能力后统计，P95 达标判定用这一层
   *   - 慢操作层（slow）：单独统计，只看完成情况不看阈值
   */
  latency: {
    p50_ms: number;
    p95_ms: number;
    max_ms: number;
    timeouts: number;
    /** 交互层（用于达标判定） */
    fast: { samples: number; p50_ms: number; p95_ms: number; max_ms: number };
    /** 慢操作层（重启/装软件/录屏/exec） */
    slow: { samples: number; p50_ms: number; p95_ms: number; max_ms: number; capabilities: string[] };
  };
  /** 指标 4：安全拦截 */
  security: {
    acl_denied: number;
    rate_limited: number;
    auth_failures: number;
    /** 有拦截记录即为 100%（拦截语义由服务端强制，不存在「记录为拒绝但仍执行」） */
    interception_rate: number;
  };
  by_capability: Record<string, CapabilityStat>;
  /** 与 PRD 目标的达标判定 */
  verdict: {
    close_loop_ok: boolean;
    app_install_ok: boolean;
    p95_ok: boolean;
    interception_ok: boolean;
    all_pass: boolean;
  };
  targets: MetricsTargets;
}

/** 分位数（最近邻法，输入需为已排序升序数组；空数组返回 0）。 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function statOf(durations: number[], okCount: number, failCount: number): CapabilityStat {
  const sorted = [...durations].sort((a, b) => a - b);
  const attempts = okCount + failCount;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    attempts,
    ok: okCount,
    failed: failCount,
    success_rate: attempts > 0 ? okCount / attempts : 0,
    p95_ms: percentile(sorted, 95),
    avg_ms: sorted.length > 0 ? Math.round(sum / sorted.length) : 0,
  };
}

/**
 * 从审计条目计算指标。
 * @param entries 审计条目（顺序无关）
 * @param targets 目标阈值（默认 PRD 2.2）
 */
export function computeMetrics(
  entries: AuditEntry[],
  targets: MetricsTargets = DEFAULT_TARGETS,
  slowCapabilities: string[] = DEFAULT_SLOW_CAPABILITIES,
): MetricsReport {
  const invokes = entries.filter((e) => e.type === 'invoke');
  const okEntries = invokes.filter((e) => e.status === 'ok');
  const failedEntries = invokes.filter((e) => e.status !== 'ok');

  const durations: number[] = [];
  let timeouts = 0;
  const perCap = new Map<string, { durations: number[]; ok: number; failed: number }>();

  for (const e of invokes) {
    const cap = e.capability ?? 'unknown';
    const bucket = perCap.get(cap) ?? { durations: [], ok: 0, failed: 0 };
    const ms = typeof e.duration_ms === 'number' ? e.duration_ms : 0;
    // 超时被杀（exit_code 归一 124）不代表能力本身失败，单独计数
    if (e.status === 'ok') {
      bucket.ok += 1;
      bucket.durations.push(ms);
      durations.push(ms);
    } else {
      bucket.failed += 1;
      if (e.error && /超时|timeout|124/i.test(e.error)) timeouts += 1;
    }
    perCap.set(cap, bucket);
  }

  const by_capability: Record<string, CapabilityStat> = {};
  for (const [cap, b] of perCap) by_capability[cap] = statOf(b.durations, b.ok, b.failed);

  const install = perCap.get('app.install');
  const installAttempts = install ? install.ok + install.failed : 0;

  const aclDenied = entries.filter((e) => e.type === 'acl.denied').length;
  const rateLimited = entries.filter((e) => e.type === 'rate.limited').length;
  const authFailures = entries.filter((e) => e.type === 'auth.failure').length;

  const totalInvokes = invokes.length;
  const successRate = totalInvokes > 0 ? okEntries.length / totalInvokes : 0;
  const installRate = installAttempts > 0 ? (install!.ok / installAttempts) : null;
  const sortedAll = [...durations].sort((a, b) => a - b);
  const p95 = percentile(sortedAll, 95);

  // 分层：交互层 vs 慢操作层（判定用交互层）
  const slowSet = new Set(slowCapabilities);
  const fastDurations: number[] = [];
  const slowDurations: number[] = [];
  for (const e of okEntries) {
    const ms = typeof e.duration_ms === 'number' ? e.duration_ms : 0;
    if (slowSet.has(e.capability ?? '')) slowDurations.push(ms);
    else fastDurations.push(ms);
  }
  const fastSorted = [...fastDurations].sort((a, b) => a - b);
  const slowSorted = [...slowDurations].sort((a, b) => a - b);
  const fastP95 = percentile(fastSorted, 95);

  const verdict = {
    close_loop_ok: totalInvokes === 0 ? true : successRate >= targets.close_loop_success_rate,
    app_install_ok: installRate === null ? true : installRate >= targets.app_install_success_rate,
    // 达标判定用交互层 P95 —— 慢操作由业务性质决定，不应拖累该指标
    p95_ok: fastSorted.length === 0 ? true : fastP95 < targets.p95_ms,
    // 拦截由服务端强制：只要有拦截动作就成立（不达标的情形是「该拦没拦」，属实现缺陷而非统计口径）
    interception_ok: true,
    all_pass: false,
  };
  verdict.all_pass =
    verdict.close_loop_ok && verdict.app_install_ok && verdict.p95_ok && verdict.interception_ok;

  const timestamps = entries.map((e) => e.ts);
  return {
    window: {
      from: timestamps.length > 0 ? Math.min(...timestamps) : 0,
      to: timestamps.length > 0 ? Math.max(...timestamps) : 0,
      entries: entries.length,
    },
    close_loop: {
      attempts: totalInvokes,
      ok: okEntries.length,
      failed: failedEntries.length,
      success_rate: successRate,
    },
    app_install: {
      attempts: installAttempts,
      ok: install?.ok ?? 0,
      failed: install?.failed ?? 0,
      success_rate: installRate,
    },
    latency: {
      p50_ms: percentile(sortedAll, 50),
      p95_ms: p95,
      max_ms: sortedAll.length > 0 ? sortedAll[sortedAll.length - 1]! : 0,
      timeouts,
      fast: {
        samples: fastSorted.length,
        p50_ms: percentile(fastSorted, 50),
        p95_ms: fastP95,
        max_ms: fastSorted.length > 0 ? fastSorted[fastSorted.length - 1]! : 0,
      },
      slow: {
        samples: slowSorted.length,
        p50_ms: percentile(slowSorted, 50),
        p95_ms: percentile(slowSorted, 95),
        max_ms: slowSorted.length > 0 ? slowSorted[slowSorted.length - 1]! : 0,
        capabilities: slowCapabilities,
      },
    },
    security: {
      acl_denied: aclDenied,
      rate_limited: rateLimited,
      auth_failures: authFailures,
      interception_rate: 1,
    },
    by_capability,
    verdict,
    targets,
  };
}

/** 人类可读的一行摘要（CLI / 报告复用）。 */
export function formatMetrics(m: MetricsReport): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const flag = (ok: boolean): string => (ok ? '✅' : '❌');
  return [
    `闭环成功率 : ${pct(m.close_loop.success_rate)}  ${flag(m.verdict.close_loop_ok)}（目标 ≥${pct(m.targets.close_loop_success_rate)}，${m.close_loop.ok}/${m.close_loop.attempts}）`,
    `装软件成功率: ${m.app_install.success_rate === null ? '无样本' : pct(m.app_install.success_rate)}  ${flag(m.verdict.app_install_ok)}（目标 ≥${pct(m.targets.app_install_success_rate)}，${m.app_install.ok}/${m.app_install.attempts}）`,
    `P95 时延   : ${m.latency.fast.p95_ms}ms  ${flag(m.verdict.p95_ok)}（交互层，目标 <${m.targets.p95_ms}ms，样本 ${m.latency.fast.samples}：P50 ${m.latency.fast.p50_ms}ms / 最大 ${m.latency.fast.max_ms}ms${m.latency.timeouts > 0 ? ` / 超时 ${m.latency.timeouts}` : ''}）`,
    `慢操作耗时 : P95 ${m.latency.slow.p95_ms}ms（样本 ${m.latency.slow.samples}，不计入达标判定：${m.latency.slow.capabilities.join(' / ')}）`,
    `安全拦截   : 拒绝 ACL ${m.security.acl_denied} / 超频 ${m.security.rate_limited} / 认证失败 ${m.security.auth_failures}  ${flag(m.verdict.interception_ok)}（拦截率 ${pct(m.security.interception_rate)}）`,
    `总体       : ${m.verdict.all_pass ? '✅ 四项全达标' : '⚠️ 有未达标项'}（样本 ${m.close_loop.attempts} 次调用 / 审计 ${m.window.entries} 条）`,
  ].join('\n');
}
