import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, signNonce, verifyNonce, keyId } from '../../packages/protocol/dist/index.js';

test('ed25519：生成的密钥对格式正确', () => {
  const kp = generateKeyPair();
  assert.ok(kp.publicKey.length > 0);
  assert.ok(kp.privateKey.length > 0);
  assert.notEqual(kp.publicKey, kp.privateKey, '公私钥应不同');
});

test('ed25519：签名验签成功；错误输入一律拒绝且不抛异常', () => {
  const kp = generateKeyPair();
  const nonce = 'challenge-nonce-0123456789';
  const sig = signNonce(kp.privateKey, nonce);

  assert.equal(verifyNonce(kp.publicKey, nonce, sig), true, '正确应通过');
  assert.equal(verifyNonce(kp.publicKey, 'other-nonce', sig), false, '错误 nonce 应拒绝');

  const other = generateKeyPair();
  assert.equal(verifyNonce(other.publicKey, nonce, sig), false, '错误公钥应拒绝');
  assert.equal(verifyNonce(kp.publicKey, nonce, 'garbage'), false, '非法签名应拒绝');
  assert.equal(verifyNonce('garbage-key', nonce, sig), false, '非法公钥应拒绝（不抛异常）');
  assert.equal(verifyNonce(kp.publicKey, nonce, ''), false, '空签名应拒绝');
});

test('ed25519：keyId 稳定且不同密钥不同', () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  assert.equal(keyId(a.publicKey), keyId(a.publicKey), '同一公钥指纹应稳定');
  assert.notEqual(keyId(a.publicKey), keyId(b.publicKey), '不同公钥指纹应不同');
  assert.match(keyId(a.publicKey), /^[0-9a-f]{16}$/, '指纹应为 16 位小写 hex');
});
