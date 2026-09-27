import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, matchPattern, authorizedCapabilities } from '../../packages/protocol/dist/index.js';

const policy = {
  default_effect: 'deny',
  clients: [
    { client_id: 'alice', pubkey: 'x', allow: ['system.*', 'screen.*'], deny: ['input.*'] },
    { client_id: 'bob', pubkey: 'y', allow: ['*'] },
    { client_id: 'carol', pubkey: 'z', allow: [] },
  ],
};

test('acl：deny 优先于 allow', () => {
  const r = authorize(policy, 'alice', 'input.mouse.move');
  assert.equal(r.allowed, false);
  assert.equal(r.matched, 'deny');
});

test('acl：allow 命中即放行', () => {
  const r = authorize(policy, 'alice', 'system.info');
  assert.equal(r.allowed, true);
  assert.equal(r.matched, 'allow');
});

test('acl：未命中规则按默认策略（deny）', () => {
  const r = authorize(policy, 'alice', 'fs.read');
  assert.equal(r.allowed, false);
  assert.equal(r.matched, 'default');
});

test('acl：未注册调用方按默认策略', () => {
  assert.equal(authorize(policy, 'ghost', 'system.info').allowed, false);
});

test('acl：allow:["*"] 全量放行', () => {
  assert.equal(authorize(policy, 'bob', 'fs.write').allowed, true);
  assert.equal(authorize(policy, 'bob', 'input.key.press').allowed, true);
});

test('acl：allow:[] 空列表则全拒', () => {
  assert.equal(authorize(policy, 'carol', 'system.info').allowed, false);
});

test('matchPattern：精确 / 通配 / 全匹配 / 不匹配', () => {
  assert.equal(matchPattern('system.info', 'system.info'), true);
  assert.equal(matchPattern('system.*', 'system.info'), true);
  assert.equal(matchPattern('system.*', 'system.process.list'), true);
  assert.equal(matchPattern('*', 'anything'), true);
  assert.equal(matchPattern('system.*', 'fs.read'), false);
  assert.equal(matchPattern('system.info', 'system.status'), false);
});

test('authorizedCapabilities：只返回被授权的子集', () => {
  const all = ['system.info', 'system.status', 'fs.read', 'input.mouse.move', 'screen.capture'];
  const ok = authorizedCapabilities(policy, 'alice', all);
  assert.deepEqual(ok, ['system.info', 'system.status', 'screen.capture'], '应只含 allow 且未被 deny 的项');
});
