import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHmac, verifyHmac, generateNonce, generateSharedKey } from '../../packages/protocol/dist/index.js';

test('hmac：正确密钥/nonce 校验通过，错误一律拒绝', () => {
  const key = 'test-key-0123456789abcdef';
  const nonce = generateNonce();
  const mac = computeHmac(key, nonce);

  assert.equal(typeof mac, 'string');
  assert.ok(mac.length > 0, 'HMAC 不应为空');

  assert.equal(verifyHmac(key, nonce, mac), true, '正确密钥应通过');
  assert.equal(verifyHmac('wrong-key', nonce, mac), false, '错误密钥应拒绝');
  assert.equal(verifyHmac(key, 'wrong-nonce', mac), false, '错误 nonce 应拒绝');
  assert.equal(verifyHmac(key, nonce, 'garbage'), false, '非法格式应拒绝');
  assert.equal(verifyHmac(key, nonce, ''), false, '空值应拒绝');
  assert.equal(verifyHmac(key, nonce, mac + 'x'), false, '长度不符应拒绝');
});

test('hmac：对同一输入结果确定（可重现）', () => {
  const key = 'k';
  const nonce = 'n';
  assert.equal(computeHmac(key, nonce), computeHmac(key, nonce), '同一输入应得到同一 HMAC');
});

test('generateNonce / generateSharedKey：随机且格式正确', () => {
  const n1 = generateNonce();
  const n2 = generateNonce();
  assert.notEqual(n1, n2, '两次 nonce 应不同');

  const k1 = generateSharedKey();
  const k2 = generateSharedKey();
  assert.notEqual(k1, k2);
  assert.equal(k1.length, 64, '32 字节 hex 应为 64 字符');
  assert.match(k1, /^[0-9a-f]+$/, '应为小写 hex');
});
