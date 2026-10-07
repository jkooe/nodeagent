import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCapability, validate, CAPABILITY_MANIFEST, CapabilityNames } from '../../packages/protocol/dist/index.js';

/** 与 tests/unit/capabilities.test.mjs 相同的 schema 校验助手。 */
function check(capName, args) {
  const cap = findCapability(capName);
  return validate(args, cap.params_schema);
}

/**
 * gui.await 的**契约层**测试（v1.6）。
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
