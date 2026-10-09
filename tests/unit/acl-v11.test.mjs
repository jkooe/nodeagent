import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ipMatchesCidr,
  ipAllowed,
  inTimeWindow,
  rateLimitFor,
  authorize,
  normalizeIp,
} from '../../packages/protocol/dist/index.js';

// ---------- B3：对端地址规范化（真机踩坑回归） ----------

test('normalizeIp：IPv4-mapped IPv6 归一为 IPv4（真机坑）', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.85'), '192.168.1.85');
  assert.equal(normalizeIp('::FFFF:192.168.1.85'), '192.168.1.85');
});

test('normalizeIp：IPv4:port 去端口；纯 IP 原样', () => {
  assert.equal(normalizeIp('192.168.1.85:51234'), '192.168.1.85');
  assert.equal(normalizeIp('192.168.1.85'), '192.168.1.85');
});

test('normalizeIp：真 IPv6 原样保留（不误当 IPv4）', () => {
  assert.equal(normalizeIp('fe80::1'), 'fe80::1');
  assert.equal(normalizeIp('[fe80::1]:8080'), 'fe80::1');
  assert.equal(normalizeIp(''), '');
  assert.equal(normalizeIp(undefined), '');
});

test('normalizeIp + deny_cidr：mapped 地址也能命中黑名单（端到端复现）', () => {
  const ip = normalizeIp('::ffff:192.168.1.85');
  const client = { client_id: 'mac_01', allow: [], deny_cidr: ['192.168.1.85'] };
  assert.equal(ipAllowed(client, ip).allowed, false);
});

// ---------- B3：CIDR ----------

test('CIDR：单 IP 精确匹配', () => {
  assert.equal(ipMatchesCidr('192.168.1.85', '192.168.1.85'), true);
  assert.equal(ipMatchesCidr('192.168.1.86', '192.168.1.85'), false);
});

test('CIDR：/24 网段匹配', () => {
  assert.equal(ipMatchesCidr('192.168.1.85', '192.168.1.0/24'), true);
  assert.equal(ipMatchesCidr('192.168.1.255', '192.168.1.0/24'), true);
  // ⚠️ 这条测的是「**跨网段不匹配**」—— 必须用不同网段的地址。
  // （2026-10-10 一次机械 IP 替换曾把它改成同段，导致断言必红 —— 语义测试别被批量替换破坏）
  assert.equal(ipMatchesCidr('192.168.2.1', '192.168.1.0/24'), false);
});

test('CIDR：/16 与 0.0.0.0/0', () => {
  assert.equal(ipMatchesCidr('10.0.1.2', '10.0.0.0/16'), true, '10.0.x.x 在 10.0.0.0/16 内');
  assert.equal(ipMatchesCidr('10.1.2.3', '10.0.0.0/16'), false, '10.1.x.x 不在 10.0.0.0/16 内');
  assert.equal(ipMatchesCidr('10.1.2.3', '10.1.0.0/16'), true);
  assert.equal(ipMatchesCidr('8.8.8.8', '0.0.0.0/0'), true);
});

test('CIDR：非法输入不误放行（IPv6/主机名/越界位）', () => {
  assert.equal(ipMatchesCidr('::1', '0.0.0.0/0'), false);
  assert.equal(ipMatchesCidr('localhost', '0.0.0.0/0'), false);
  assert.equal(ipMatchesCidr('192.168.1.1', '192.168.1.0/99'), false);
  assert.equal(ipMatchesCidr('192.168.1.999', '192.168.1.0/24'), false);
});

test('IP 白名单：deny 优先、白名单为空则放行', () => {
  assert.equal(ipAllowed({ client_id: 'a', allow: [] }, '1.2.3.4').allowed, true);
  assert.equal(
    ipAllowed({ client_id: 'a', allow: [], allow_cidr: ['192.168.1.0/24'] }, '192.168.1.5').allowed,
    true,
  );
  assert.equal(
    ipAllowed({ client_id: 'a', allow: [], allow_cidr: ['192.168.1.0/24'] }, '10.0.0.1').allowed,
    false,
  );
  const both = { client_id: 'a', allow: [], allow_cidr: ['192.168.1.0/24'], deny_cidr: ['192.168.1.85'] };
  assert.equal(ipAllowed(both, '192.168.1.85').allowed, false, '黑名单优先');
  assert.equal(ipAllowed(both, '192.168.1.86').allowed, true);
});

// ---------- B3：生效时段 ----------

test('时段：未配置即全天可用', () => {
  assert.equal(inTimeWindow(undefined, new Date('2026-09-29T03:00:00')).allowed, true);
});

test('时段：普通区间与跨零点区间', () => {
  const work = { from: '09:00', to: '18:00' };
  assert.equal(inTimeWindow(work, new Date('2026-09-29T10:30:00')).allowed, true);
  assert.equal(inTimeWindow(work, new Date('2026-09-29T20:00:00')).allowed, false);

  const night = { from: '22:00', to: '06:00' };
  assert.equal(inTimeWindow(night, new Date('2026-09-29T23:30:00')).allowed, true, '当天深夜');
  assert.equal(inTimeWindow(night, new Date('2026-09-29T02:00:00')).allowed, true, '次日凌晨');
  assert.equal(inTimeWindow(night, new Date('2026-09-29T12:00:00')).allowed, false);
});

test('时段：星期限制（1=周一…7=周日）', () => {
  const weekday = { days: [1, 2, 3, 4, 5] };
  assert.equal(inTimeWindow(weekday, new Date('2026-09-29T10:00:00')).allowed, true, '周二');
  assert.equal(inTimeWindow(weekday, new Date('2026-10-03T10:00:00')).allowed, false, '周六');
  assert.equal(inTimeWindow({ days: [7] }, new Date('2026-10-04T10:00:00')).allowed, true, '周日=7');
});

test('时段：非法格式拒绝（不静默放行）', () => {
  assert.equal(inTimeWindow({ from: '9am', to: '6pm' }, new Date()).allowed, false);
  assert.equal(inTimeWindow({ from: '25:00', to: '26:00' }, new Date()).allowed, false);
});

// ---------- B3：按能力限速 ----------

test('限速：精确匹配优先，其次 glob，最后回退全局', () => {
  const client = {
    client_id: 'mac_01',
    allow: ['*'],
    max_calls_per_min: 60,
    rate_limits: { 'fs.read': 10, 'fs.*': 30, 'system.shell.exec': 5 },
  };
  assert.equal(rateLimitFor(client, 'fs.read'), 10, '精确优先于 glob');
  assert.equal(rateLimitFor(client, 'fs.write'), 30, '继承 glob');
  assert.equal(rateLimitFor(client, 'system.shell.exec'), 5);
  assert.equal(rateLimitFor(client, 'system.info'), 60, '回退全局');
});

test('限速：无任何配置即不限速', () => {
  assert.equal(rateLimitFor({ client_id: 'a', allow: [] }, 'system.info'), undefined);
});

// ---------- 回归：CIDR/时段不影响原有授权语义 ----------

test('授权语义：deny 优先于 allow（与 v11 新字段共存）', () => {
  const policy = {
    default_effect: 'deny',
    clients: [
      {
        client_id: 'mac_01',
        allow: ['fs.*'],
        deny: ['fs.write'],
        allow_cidr: ['192.168.1.0/24'],
        rate_limits: { 'fs.*': 20 },
      },
    ],
  };
  assert.equal(authorize(policy, 'mac_01', 'fs.read').allowed, true);
  assert.equal(authorize(policy, 'mac_01', 'fs.write').allowed, false);
  assert.equal(authorize(policy, 'mac_01', 'system.info').allowed, false);
});
