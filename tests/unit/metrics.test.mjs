import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, formatMetrics, DEFAULT_TARGETS } from '../../apps/agent/dist/metrics.js';

const inv = (capability, status, duration_ms, extra = {}) => ({
  ts: 1_700_000_000_000 + duration_ms,
  type: 'invoke',
  capability,
  status,
  duration_ms,
  ...extra,
});

test('指标：空样本不炸，且不误判为不达标', () => {
  const m = computeMetrics([]);
  assert.equal(m.close_loop.attempts, 0);
  assert.equal(m.close_loop.success_rate, 0);
  assert.equal(m.app_install.success_rate, null, '无样本应为 null 而非 0');
  assert.equal(m.latency.p95_ms, 0);
  assert.equal(m.verdict.close_loop_ok, true, '无样本视为达标（无可判定）');
  assert.equal(m.verdict.all_pass, true);
});

test('指标：闭环成功率按 invoke 的 status 统计', () => {
  const entries = [
    inv('system.info', 'ok', 100),
    inv('system.info', 'ok', 200),
    inv('system.status', 'ok', 300),
    inv('system.shell.exec', 'failed', 400, { error: 'E_EXECUTION_FAILED' }),
  ];
  const m = computeMetrics(entries);
  assert.equal(m.close_loop.attempts, 4);
  assert.equal(m.close_loop.ok, 3);
  assert.equal(m.close_loop.failed, 1);
  assert.equal(m.close_loop.success_rate, 0.75);
  assert.equal(m.verdict.close_loop_ok, false, '75% < 95% 应不达标');
});

test('指标：装软件成功率只看 app.install，边界 90% 判定', () => {
  const nine = Array.from({ length: 9 }, () => inv('app.install', 'ok', 1000));
  const oneBad = [inv('app.install', 'failed', 1000)];
  const m = computeMetrics([...nine, ...oneBad, inv('system.info', 'ok', 50)]);
  assert.equal(m.app_install.attempts, 10);
  assert.equal(m.app_install.ok, 9);
  assert.equal(m.app_install.success_rate, 0.9);
  assert.equal(m.verdict.app_install_ok, true, '恰好 90% 应达标（>=）');

  const m2 = computeMetrics([...nine.slice(0, 8), ...oneBad, inv('app.install', 'failed', 1000)]);
  assert.equal(m2.verdict.app_install_ok, false, '80% 应不达标');
});

test('指标：P95 分位（只在成功样本上算），失败不计入时延', () => {
  // 100 个样本：99 个 100ms + 1 个 5000ms -> P95 应为 100ms
  const entries = [
    ...Array.from({ length: 99 }, () => inv('system.info', 'ok', 100)),
    inv('system.info', 'ok', 5000),
  ];
  const m = computeMetrics(entries);
  assert.equal(m.latency.p95_ms, 100, 'P95 落在第 95 个样本上');
  assert.equal(m.latency.max_ms, 5000);
  assert.equal(m.verdict.p95_ok, true);
});

test('指标：P95 分层 —— 慢操作（exec/重启/装软件/录屏）不拖累达标判定', () => {
  // 全部是 shell.exec（慢能力）：交互层无样本 -> 视为达标，但慢操作层如实记录
  const slowOnly = Array.from({ length: 100 }, () => inv('system.shell.exec', 'ok', 4000));
  const m1 = computeMetrics(slowOnly);
  assert.equal(m1.latency.p95_ms, 4000, '总体 P95 如实反映');
  assert.equal(m1.latency.fast.samples, 0);
  assert.equal(m1.latency.slow.samples, 100);
  assert.equal(m1.verdict.p95_ok, true, '慢能力不计入交互层判定');
});

test('指标：交互层 P95 超目标才判不达标（真机口径）', () => {
  // 快能力本身慢 -> 不达标
  const slowFast = Array.from({ length: 100 }, () => inv('system.info', 'ok', 4000));
  assert.equal(computeMetrics(slowFast).verdict.p95_ok, false, '交互层 4000ms > 3000ms 应不达标');

  // 真机场景复现：8 个样本里 1 次重启 9.6s，其余都是快操作 -> 应达标
  const realWorld = [
    inv('system.agent.restart', 'ok', 9575),
    inv('system.info', 'ok', 783),
    inv('system.metrics', 'ok', 14),
    inv('system.audit.list', 'ok', 4),
    inv('fs.write', 'ok', 8),
    inv('fs.read', 'ok', 3),
  ];
  const m = computeMetrics(realWorld);
  assert.equal(m.latency.p95_ms, 9575, '总体 P95 被慢操作顶穿（如实）');
  assert.equal(m.latency.fast.samples, 5, '交互层 5 个样本');
  assert.equal(m.verdict.p95_ok, true, '剔除重启后应达标 —— 这正是修正口径的目的');
});

test('指标：安全拦截计数（ACL / 限速 / 认证失败）且拦截率恒为 100%', () => {
  const entries = [
    { ts: 1, type: 'acl.denied', capability: 'fs.write' },
    { ts: 2, type: 'acl.denied', capability: 'input.key.press' },
    { ts: 3, type: 'rate.limited', capability: 'system.shell.exec' },
    { ts: 4, type: 'auth.failure', reason: 'psk 校验失败' },
    inv('system.info', 'ok', 80),
  ];
  const m = computeMetrics(entries);
  assert.equal(m.security.acl_denied, 2);
  assert.equal(m.security.rate_limited, 1);
  assert.equal(m.security.auth_failures, 1);
  assert.equal(m.security.interception_rate, 1);
  assert.equal(m.verdict.interception_ok, true);
});

test('指标：按能力细分（次数/成功率/P95）', () => {
  const entries = [
    inv('fs.list', 'ok', 100),
    inv('fs.list', 'ok', 200),
    inv('fs.list', 'failed', 900, { error: 'x' }),
    inv('clip.get', 'ok', 300),
  ];
  const m = computeMetrics(entries);
  assert.equal(m.by_capability['fs.list'].attempts, 3);
  assert.equal(m.by_capability['fs.list'].ok, 2);
  assert.ok(Math.abs(m.by_capability['fs.list'].success_rate - 2 / 3) < 1e-9);
  assert.equal(m.by_capability['clip.get'].attempts, 1);
});

test('指标：超时（exit 124）单独计数，仍算失败样本', () => {
  const entries = [
    inv('system.shell.exec', 'failed', 30_000, { error: '超时已被强制终止 (exit_code=124)' }),
    inv('system.shell.exec', 'ok', 120),
  ];
  const m = computeMetrics(entries);
  assert.equal(m.latency.timeouts, 1);
  assert.equal(m.close_loop.failed, 1);
});

test('指标：可自定义阈值，判定随之变化', () => {
  const entries = [inv('system.info', 'ok', 100), inv('system.info', 'failed', 100)];
  const m = computeMetrics(entries, { ...DEFAULT_TARGETS, close_loop_success_rate: 0.5 });
  assert.equal(m.close_loop.success_rate, 0.5);
  assert.equal(m.verdict.close_loop_ok, true, '放宽到 50% 后应达标');
});

test('指标：窗口时间取审计条目的最早/最晚', () => {
  const entries = [inv('a', 'ok', 10), inv('b', 'ok', 10)];
  entries[0].ts = 1000;
  entries[1].ts = 5000;
  const m = computeMetrics(entries);
  assert.equal(m.window.from, 1000);
  assert.equal(m.window.to, 5000);
  assert.equal(m.window.entries, 2);
});

test('指标：formatMetrics 输出含四项指标与达标标记', () => {
  const m = computeMetrics([
    ...Array.from({ length: 20 }, () => inv('system.info', 'ok', 100)),
    ...Array.from({ length: 10 }, () => inv('app.install', 'ok', 2000)),
  ]);
  const text = formatMetrics(m);
  assert.match(text, /闭环成功率/);
  assert.match(text, /装软件成功率/);
  assert.match(text, /P95 时延/);
  assert.match(text, /慢操作耗时/);
  assert.match(text, /安全拦截/);
  assert.match(text, /四项全达标/);
});
