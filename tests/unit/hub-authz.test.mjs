import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nodeAllowed,
  nodeMatches,
  nodeMayRegister,
  resolveToken,
  visibleNodes,
} from '../../apps/hub/dist/authz.js';

const cfg = {
  node_id: 'hub_01',
  host: '0.0.0.0',
  port: 9443,
  token: 'master-token',
  log_level: 'warn',
  tokens: [
    { value: 'owner-token', name: 'owner', allow_nodes: ['*'] },
    { value: 'ci-token', name: 'ci', allow_nodes: ['win_build_*'] },
    { value: 'guest-token', name: 'guest', allow_nodes: ['*'], deny_nodes: ['win_prod'] },
    { value: 'roll-*', name: 'rolling', allow_nodes: ['win_a'] },
  ],
  node_allowlist: ['win_*', 'mac_a'],
};

test('令牌：顶层 token 视为主令牌（放行全部，向后兼容）', () => {
  const t = resolveToken(cfg, 'master-token');
  assert.ok(t);
  assert.equal(t.isMaster, true);
  assert.equal(nodeAllowed(t, '任意设备').allowed, true);
});

test('令牌：未知令牌解析失败', () => {
  assert.equal(resolveToken(cfg, 'nope'), null);
  assert.equal(resolveToken(cfg, undefined), null);
  assert.equal(resolveToken(cfg, ''), null);
});

test('令牌：前缀式滚动令牌按前缀匹配', () => {
  const t = resolveToken(cfg, 'roll-2026-09');
  assert.ok(t);
  assert.equal(t.name, 'rolling');
  assert.equal(nodeAllowed(t, 'win_a').allowed, true);
  assert.equal(nodeAllowed(t, 'win_b').allowed, false, '白名单外应拒绝');
});

test('设备授权：deny 优先于 allow', () => {
  const guest = resolveToken(cfg, 'guest-token');
  assert.equal(nodeAllowed(guest, 'win_prod').allowed, false, '黑名单优先');
  assert.equal(nodeAllowed(guest, 'win_other').allowed, true);
});

test('设备授权：glob 白名单 + 默认拒绝', () => {
  const ci = resolveToken(cfg, 'ci-token');
  assert.equal(nodeAllowed(ci, 'win_build_01').allowed, true);
  assert.equal(nodeAllowed(ci, 'win_build_99').allowed, true);
  assert.equal(nodeAllowed(ci, 'win_prod').allowed, false);
  const r = nodeAllowed(ci, 'win_prod');
  assert.match(r.reason, /未被授权/);
});

test('设备授权：未配置 allow_nodes 时默认放行全部', () => {
  const c2 = { ...cfg, tokens: [{ value: 'plain', name: 'plain' }] };
  const t = resolveToken(c2, 'plain');
  assert.equal(nodeAllowed(t, 'any_node').allowed, true);
});

test('注册准入：node_allowlist 非空时按 glob 过滤', () => {
  assert.equal(nodeMayRegister(cfg, 'win_x').allowed, true);
  assert.equal(nodeMayRegister(cfg, 'mac_a').allowed, true);
  assert.equal(nodeMayRegister(cfg, 'mac_b').allowed, false);
  assert.equal(nodeMayRegister(cfg, 'attacker_node').allowed, false);
});

test('注册准入：未配置白名单时放行（兼容旧配置）', () => {
  const legacy = { ...cfg, node_allowlist: undefined };
  assert.equal(nodeMayRegister(legacy, 'anything').allowed, true);
});

test('列表可见性：只展示被授权的设备', () => {
  const ci = resolveToken(cfg, 'ci-token');
  const all = [
    { node_id: 'win_build_01' },
    { node_id: 'win_prod' },
    { node_id: 'win_build_02' },
  ];
  assert.deepEqual(
    visibleNodes(ci, all).map((x) => x.node_id),
    ['win_build_01', 'win_build_02'],
  );
});

test('nodeMatches：glob 语义与转义（点号不被当通配）', () => {
  assert.equal(nodeMatches('*', 'x'), true);
  assert.equal(nodeMatches('win*', 'win_a'), true);
  assert.equal(nodeMatches('win_a', 'win_a'), true);
  assert.equal(nodeMatches('win_a', 'win_b'), false);
  // '.' 应被转义为字面量
  assert.equal(nodeMatches('a.b', 'axb'), false);
  assert.equal(nodeMatches('a.b', 'a.b'), true);
});
