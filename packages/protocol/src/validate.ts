import type { JsonSchema } from './messages.js';

/**
 * JSON Schema 子集校验器（见 DEVELOPMENT.md 4.3）。
 * 支持：type / properties / required / additionalProperties / enum /
 *      minimum / maximum / minLength / maxLength / pattern / items / minItems / maxItems
 *
 * 不依赖外部库，返回错误信息数组（空数组 = 校验通过）。
 */
export function validate(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = [];

  if (!matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return errors; // 类型不符时后续校验无意义
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`);
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: length must be >= ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: length must be <= ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: must match pattern ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: at least ${schema.minItems} items required`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: at most ${schema.maxItems} items allowed`);
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validate(item, schema.items!, `${path}[${i}]`)));
    }
  }

  if (isPlainObject(value) && schema.properties) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined || value[key] === null) {
        errors.push(`${path}.${key}: required`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      const propValue = value[key];
      if (propValue !== undefined) {
        errors.push(...validate(propValue, sub, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          errors.push(`${path}.${key}: additional property not allowed`);
        }
      }
    }
  }

  return errors;
}

/** 用 schema 的 default 填补缺失字段。 */
export function applyDefaults(
  value: Record<string, unknown>,
  schema: JsonSchema,
): Record<string, unknown> {
  if (!schema.properties) return value;
  const out = { ...value };
  for (const [key, sub] of Object.entries(schema.properties)) {
    if (out[key] === undefined && sub.default !== undefined) {
      out[key] = sub.default;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(v: unknown, type: JsonSchema['type']): boolean {
  if (!type) return true;
  switch (type) {
    case 'object':
      return isPlainObject(v);
    case 'array':
      return Array.isArray(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number';
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    default:
      return true;
  }
}
