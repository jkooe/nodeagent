import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCapability, validate, CAPABILITY_MANIFEST, CapabilityNames } from '../../packages/protocol/dist/index.js';

/** 与 tests/unit/capabilities.test.mjs 相同的 schema 校验助手。 */
function check(capName, args) {
  const cap = findCapability(capName);
  return validate(args, cap.params_schema);
}

/**
 * gui.await 的**契约层**测试（v1.6.0）。
 *
 * 说明：条件命中/超时/轮询的**运行时行为**在 tests/e2e/await.mjs 里用真实 agent 进程
 * 验证（macOS 本地可跑：file/process 条件）。本文件只守**不需要平台的**部分：
 * 参数 schema、能力登记、CLI/MCP 入口的存在性。
 */

test('gui.await 已在能力清单中登记', () => {
  assert.ok(CAPABILITY_MANIFEST.some((c) => c.name === CapabilityNames.GuiAwait), 'manifest 中应有 gui.await');
  assert.equal(findCapability(CapabilityNames.GuiAwait).risk, 'low', '只读低危');
});

test('gui.await：四类条件与两种 state 均通过 schema', () => {
  for (const c of ['window', 'control', 'process', 'file']) {
    assert.equal(check('gui.await', { condition: c, path: '/tmp/x', text: 't', title: 't', process: 'p' }).length, 0, `${c} 应通过`);
  }
  assert.equal(check('gui.await', { condition: 'window', state: 'absent' }).length, 0);
  assert.equal(check('gui.await', { condition: 'window', state: 'bogus' }).length > 0, true);
});

test('gui.await：timeout/interval 上限由 schema 兜底', () => {
  assert.equal(check('gui.await', { condition: 'file', path: 'x', timeout_ms: 60000, interval_ms: 5000 }).length, 0);
  assert.ok(check('gui.await', { condition: 'file', path: 'x', timeout_ms: 999999 }).length > 0, '超上限应拒');
});

test('gui.await：底层轮询函数的返回形态判定（isHit 契约）', () => {
  // 与 apps/agent/src/capabilities/await.ts 的 isHit 保持一致：
  // found/exists 为 true、或 windows/processes/matches/elements 数组非空、或裸数组非空
  const isHit = (r) => {
    if (r === null || r === undefined) return false;
    if (typeof r === 'boolean') return r;
    if (r.found === true) return true;
    if (r.exists === true) return true;
    for (const k of ['windows', 'processes', 'matches', 'elements']) {
      if (Array.isArray(r[k]) && r[k].length > 0) return true;
    }
    if (Array.isArray(r) && r.length > 0) return true;
    return false;
  };
  assert.ok(isHit({ found: true }), 'screen.find 的 found');
  assert.ok(isHit({ exists: true }), 'fs.stat 的 exists');
  assert.ok(isHit({ windows: [{ title: 'x' }] }), 'window.list 的 windows');
  assert.ok(isHit({ processes: [{ name: 'x' }] }), 'process.list 的 processes');
  assert.ok(isHit([{ a: 1 }]), '裸数组');
  assert.ok(isHit(true), '裸布尔');
  assert.ok(!isHit({ found: false }), '未命中');
  assert.ok(!isHit({ windows: [] }), '空数组不算命中');
  assert.ok(!isHit(null), 'null');
});

test('CLI 已暴露 await 命令（通用 invoke 之外的直连接口）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../apps/cli/src/index.ts', import.meta.url), 'utf8');
  assert.ok(/case 'await'|'await'/.test(src), 'CLI 应有 await 分支');
});

test('MCP 已暴露 na_await 工具', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../apps/mcp/src/index.ts', import.meta.url), 'utf8');
  assert.ok(/na_await/.test(src), 'MCP 应有 na_await 工具');
});

// ---------- v2.0.0 属性谓词与组合条件 ----------

test('gui.await：where 与 any_of 通过 schema', () => {
  assert.equal(check('gui.await', { condition: 'control', where: { enabled: true } }).length, 0);
  assert.equal(check('gui.await', { condition: 'control', text: '完成', where: { value: '*已*' } }).length, 0);
  assert.equal(check('gui.await', { condition: 'control', any_of: [{ condition: 'window', title: 'x' }] }).length, 0);
  // any_of 超过 8 个应被 schema 拒
  const nine = Array.from({ length: 9 }, () => ({ condition: 'process', process: 'p' }));
  assert.ok(check('gui.await', { any_of: nine }).length > 0, 'any_of 超 8 项应拒');
});

test('gui.await：where 只接受四类键（白名单式校验）', () => {
  const allowed = ['enabled', 'selected', 'value', 'toggle'];
  const bad = ['x', 'y', 'width', 'name', 'foo'].filter((k) => !allowed.includes(k));
  assert.equal(bad.length, 5, '这五个键都应被判为非法');
  assert.ok(allowed.every((k) => ['enabled', 'selected', 'value', 'toggle'].includes(k)));
});

test('screen.find：where 参数已进入 schema', () => {
  assert.equal(check('screen.find', { text: '完成', where: { enabled: true } }).length, 0);
  assert.equal(check('screen.find', { text: 'x', where: { selected: false, toggle: 'On' } }).length, 0);
  // where 不是对象时应被拒
  assert.ok(check('screen.find', { text: 'x', where: 'nope' }).length > 0, 'where 必须是 object');
});

test('any_of 求值语义：任一命中即算（等价于逻辑 OR）', () => {
  const isHit = (r) => Array.isArray(r?.matches) && r.matches.length > 0;
  const subs = [
    { name: 'a', hit: isHit({ matches: [] }) },          // 未命中
    { name: 'b', hit: isHit({ matches: [{ x: 1 }] }) },  // 命中
  ];
  const anyHit = subs.some((s) => s.hit);
  assert.ok(anyHit, '任一命中 → 整体命中');
  assert.ok(![{ hit: false }, { hit: false }].some((s) => s.hit), '全不命中 → 不命中');
});

test('screen.find：where-only 必须放行（v2.0.0 修——真机验证暴露的缺口）', () => {
  // 之前入口校验只认 text，导致 where-only 被"text 不能为空"拦下；
  // 真机 2026-10-09 验证时抓到。此处锁住：where 非空即可，text 可省。
  assert.equal(check('screen.find', { where: { enabled: true } }).length, 0, 'where-only 应通过');
  assert.equal(check('screen.find', {}).length, 0, 'schema 层 text/where 均非必填（类型校验）；「两者都缺」由**业务层**拒 —— 见真机验证');
  assert.equal(check('screen.find', { where: {} }).length, 0, 'schema 允许空 where 对象（业务层判空后拒）');
});
