import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHmac, verifyHmac } from '../../packages/protocol/dist/index.js';

/**
 * v22：发现广播的详情签名。
 * 被控端与控制端必须**逐字节同构**，否则「🔒 已认证」永远不亮 —— 故这里做往返一致性测试。
 */
const detail = {
  host: '192.168.1.100',
  port: 8765,
  tls: true,
  auth_mode: 'psk',
  input_enabled: false,
  cert_sha256: null,
  platform: 'win32',
};
const nodeId = 'win_01';
const ts = 1790000000000;
const SECRET = 'S3CRET-DISCOVERY-KEY';

test('详情签名：同一输入两端算出同一值并验签通过', () => {
  const payload = `${nodeId}|${ts}|${JSON.stringify(detail)}`;
  const sig = computeHmac(SECRET, payload);
  assert.ok(verifyHmac(SECRET, payload, sig), '控制端应验签通过');
});

test('详情签名：错误密钥 / 篡改详情 / 改时间戳 都必须验签失败', () => {
  const payload = `${nodeId}|${ts}|${JSON.stringify(detail)}`;
  const sig = computeHmac(SECRET, payload);
  assert.ok(!verifyHmac('wrong-key', payload, sig), '错误密钥应失败');
  const tampered = `${nodeId}|${ts}|${JSON.stringify({ ...detail, port: 9999 })}`;
  assert.ok(!verifyHmac(SECRET, tampered, sig), '篡改详情应失败');
  assert.ok(!verifyHmac(SECRET, `${nodeId}|${ts + 1}|${JSON.stringify(detail)}`, sig), '改时间戳应失败');
});

test('详情签名：字段顺序变化会改变签名（提醒：两侧都按对象字面量顺序拼）', () => {
  const a = computeHmac(SECRET, JSON.stringify({ x: 1, y: 2 }));
  const b = computeHmac(SECRET, JSON.stringify({ y: 2, x: 1 }));
  assert.notEqual(a, b);
});
