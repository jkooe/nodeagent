import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, applyDefaults } from '../../packages/protocol/dist/index.js';

test('validate：基本类型', () => {
  assert.deepEqual(validate('x', { type: 'string' }), []);
  assert.deepEqual(validate(1, { type: 'integer' }), []);
  assert.deepEqual(validate(1.5, { type: 'number' }), []);
  assert.deepEqual(validate(true, { type: 'boolean' }), []);
  assert.deepEqual(validate([], { type: 'array' }), []);
  assert.deepEqual(validate({}, { type: 'object' }), []);

  assert.ok(validate(1, { type: 'string' }).length > 0);
  assert.ok(validate('x', { type: 'integer' }).length > 0);
  assert.ok(validate(1.5, { type: 'integer' }).length > 0, '非整数应报错');
});

test('validate：enum', () => {
  const schema = { type: 'string', enum: ['a', 'b'] };
  assert.deepEqual(validate('a', schema), []);
  assert.ok(validate('c', schema).length > 0, '不在枚举内应报错');
});

test('validate：数值范围', () => {
  const schema = { type: 'number', minimum: 0, maximum: 10 };
  assert.deepEqual(validate(5, schema), []);
  assert.deepEqual(validate(0, schema), []);
  assert.ok(validate(-1, schema).length > 0);
  assert.ok(validate(11, schema).length > 0);
});

test('validate：字符串长度与 pattern', () => {
  const schema = { type: 'string', minLength: 2, maxLength: 5, pattern: '^[a-z]+$' };
  assert.deepEqual(validate('abc', schema), []);
  assert.ok(validate('a', schema).length > 0, '过短');
  assert.ok(validate('abcdef', schema).length > 0, '过长');
  assert.ok(validate('ab1', schema).length > 0, '不匹配 pattern');
});

test('validate：数组长度与 items 类型', () => {
  const schema = { type: 'array', minItems: 1, maxItems: 3, items: { type: 'integer' } };
  assert.deepEqual(validate([1, 2], schema), []);
  assert.ok(validate([], schema).length > 0, '空数组');
  assert.ok(validate([1, 2, 3, 4], schema).length > 0, '超长');
  assert.ok(validate([1, 'x'], schema).length > 0, 'item 类型错');
});

test('validate：required 与 additionalProperties', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'integer' } },
    required: ['name'],
    additionalProperties: false,
  };
  assert.deepEqual(validate({ name: 'x', age: 1 }, schema), []);
  assert.ok(validate({ age: 1 }, schema).length > 0, '缺 required');
  assert.ok(validate({ name: 'x', extra: 1 }, schema).length > 0, '多余字段');
});

test('validate：嵌套路径正确', () => {
  const schema = {
    type: 'object',
    properties: { filter: { type: 'object', properties: { pattern: { type: 'string' } } } },
  };
  assert.deepEqual(validate({ filter: { pattern: 'x' } }, schema), []);
  const errs = validate({ filter: { pattern: 1 } }, schema);
  assert.equal(errs.length, 1);
  assert.ok(errs[0].includes('$.filter.pattern'), '错误应带嵌套路径');
});

test('applyDefaults：填补缺失字段，不覆盖已有值', () => {
  const schema = {
    type: 'object',
    properties: {
      limit: { type: 'integer', default: 20 },
      recursive: { type: 'boolean', default: false },
    },
  };
  const out = applyDefaults({ limit: 5 }, schema);
  assert.equal(out.limit, 5, '已有值不被覆盖');
  assert.equal(out.recursive, false, '缺失字段填默认值');
});
