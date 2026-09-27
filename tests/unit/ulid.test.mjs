import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '../../packages/protocol/dist/index.js';

test('ulid：格式为 26 字符 Crockford Base32', () => {
  const id = ulid();
  assert.equal(id.length, 26);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]+$/, '应只含 Crockford Base32 字符集');
});

test('ulid：大量生成无重复', () => {
  const set = new Set();
  for (let i = 0; i < 2000; i += 1) set.add(ulid());
  assert.equal(set.size, 2000, '2000 个 ULID 应全部唯一');
});

test('ulid：同毫秒与跨毫秒均单调递增', () => {
  const a = ulid(1000);
  const b = ulid(1000); // 同毫秒
  const c = ulid(1001);
  assert.ok(a < b, `同毫秒应递增 (${a} vs ${b})`);
  assert.ok(b < c, '跨毫秒应递增');
});

test('ulid：时间戳 0 编码为全 0', () => {
  const id = ulid(0);
  assert.equal(id.slice(0, 10), '0000000000');
});
