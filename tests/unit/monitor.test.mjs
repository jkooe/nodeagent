import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCapability, validate, CapabilityNames } from '../../packages/protocol/dist/index.js';

/**
 * monitor.* 的契约层测试（v2.0.0 方向二第二块）。
 * 运行时行为（真采样/落盘/摘要）在本地真机探针里验证：port 探测 + metric 采样 +
 * report 摘要 + stop 落盘。
 */

function check(capName, args) {
  return validate(args, findCapability(capName).params_schema);
}

test('monitor 五项能力均已登记且为低危只读/本地', () => {
  for (const n of [CapabilityNames.MonitorStart, CapabilityNames.MonitorReport, CapabilityNames.MonitorStop, CapabilityNames.MonitorList, CapabilityNames.MonitorDelete, CapabilityNames.LogQuery]) {
    const cap = findCapability(n);
    assert.ok(cap, `缺少 ${n}`);
    assert.equal(cap.risk, 'low', `${n} 应为 low risk`);
  }
});

test('monitor.start：四类 source 通过，非法 source 被拒', () => {
  for (const s of ['port', 'process', 'command', 'metric']) {
    assert.equal(check('monitor.start', { source: s, target: 'x:1' }).length, 0, `${s} 应通过`);
  }
  assert.ok(check('monitor.start', { source: 'bogus' }).length > 0, '非法 source 应拒');
  assert.ok(check('monitor.start', {}).length > 0, '缺 source 应拒');
});

test('monitor.start：interval_ms 有上下限（500~600000）', () => {
  assert.equal(check('monitor.start', { source: 'metric', interval_ms: 500 }).length, 0);
  assert.equal(check('monitor.start', { source: 'metric', interval_ms: 600000 }).length, 0);
  assert.ok(check('monitor.start', { source: 'metric', interval_ms: 10 }).length > 0, '过小应拒');
  assert.ok(check('monitor.start', { source: 'metric', interval_ms: 10 ** 7 }).length > 0, '过大应拒');
});

test('monitor.report/stop/delete：id 必填', () => {
  for (const n of ['monitor.report', 'monitor.stop', 'monitor.delete']) {
    assert.ok(check(n, {}).length > 0, `${n} 缺 id 应拒`);
    assert.equal(check(n, { id: 'm1' }).length, 0, `${n} 带 id 应通过`);
  }
  assert.equal(check('monitor.list', {}).length, 0, 'monitor.list 无参数');
});

test('log.query：path 必填，limit 上限 5000', () => {
  assert.ok(check('log.query', {}).length > 0, '缺 path 应拒');
  assert.equal(check('log.query', { path: '/var/log/x.log' }).length, 0);
  assert.equal(check('log.query', { path: 'x', limit: 5000 }).length, 0);
  assert.ok(check('log.query', { path: 'x', limit: 99999 }).length > 0, '超上限应拒');
  assert.ok(check('log.query', { path: 'x', level: 'FATAL' }).length > 0, '非法 level 应拒');
});

test('摘要算法：port 断线次数与最长中断（与 monitor.ts 的 summarize 同步）', () => {
  // 复刻 summarize 的核心逻辑，锁住"最长连续中断"的语义（最容易写错的一处）
  const samples = [
    { up: true }, { up: false }, { up: false }, { up: false },
    { up: true }, { up: false }, { up: true },
  ];
  let run = 0, worst = 0, downs = 0;
  for (const s of samples) {
    if (s.up === true) { run = 0; } else { run += 1; worst = Math.max(worst, run); downs += 1; }
  }
  assert.equal(downs, 4, 'down 计数');
  assert.equal(worst, 3, '最长连续中断应为 3 个样本（中间那段）');
  assert.equal(samples.filter((s) => s.up).length, 3, 'up 计数');
});

test('摘要算法：command 的成功/失败与出现过的退出码', () => {
  const codes = [0, 0, 1, 0, 127];
  assert.equal(codes.filter((c) => c === 0).length, 3);
  assert.deepEqual([...new Set(codes)], [0, 1, 127]);
});
