import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNodeSelector } from '../../packages/client/dist/index.js';

const cfg = {
  client_id: 'mac_01',
  current: 'win_a',
  nodes: {
    win_a: { host: '10.0.0.1', port: 8765 },
    win_b: { host: '10.0.0.2', port: 8765 },
    mac_b: { host: '10.0.0.3', port: 8765 },
  },
  groups: {
    办公: ['win_a', 'win_b'],
    全部: ['@办公', 'mac_b'],
  },
};

test('分组：@组名 展开为设备列表', () => {
  const r = resolveNodeSelector(cfg, ['@办公']);
  assert.deepEqual(r.nodes, ['win_a', 'win_b']);
  assert.deepEqual(r.resolvedGroups['办公'], ['win_a', 'win_b']);
});

test('分组：支持嵌套引用（@全部 含 @办公）', () => {
  const r = resolveNodeSelector(cfg, ['@全部']);
  assert.deepEqual(r.nodes, ['win_a', 'win_b', 'mac_b']);
});

test('分组：与设备名混用且去重', () => {
  const r = resolveNodeSelector(cfg, ['win_b', '@办公']);
  assert.deepEqual(r.nodes, ['win_b', 'win_a'], '先出现的先保留，重复项剔除');
});

test('分组：未知组展开为空（由调用方报错），未知设备名原样保留', () => {
  const r = resolveNodeSelector(cfg, ['@不存在']);
  assert.deepEqual(r.nodes, []);
  assert.deepEqual(r.resolvedGroups['不存在'], []);
  const r2 = resolveNodeSelector(cfg, ['ghost']);
  assert.deepEqual(r2.nodes, ['ghost']);
});

test('分组：无 groups 字段时退化为原样返回（向后兼容旧配置）', () => {
  const legacy = { client_id: 'c', current: 'win_a', nodes: { win_a: { host: 'h', port: 1 } } };
  const r = resolveNodeSelector(legacy, ['win_a']);
  assert.deepEqual(r.nodes, ['win_a']);
});

test('分组：环形引用不无限递归（深度上限 3）', () => {
  const cyc = {
    client_id: 'c',
    current: 'a',
    nodes: { a: { host: 'h', port: 1 } },
    groups: { X: ['@Y'], Y: ['@X', 'a'] },
  };
  const r = resolveNodeSelector(cyc, ['@X']);
  assert.ok(r.nodes.includes('a'), '应能收敛到真实设备');
  assert.ok(r.nodes.length < 50, '不应因环引用爆炸');
});
