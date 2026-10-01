// 通用 schema 片段（从 capabilities.ts 拆出）
import type { JsonSchema } from '../messages.js';

/** 名称过滤片段（app.list 等复用） */
export const filterSchema: JsonSchema = {
  type: 'object',
  properties: {
    name_pattern: { type: 'string', description: '名称匹配（子串，不区分大小写）' },
  },
  additionalProperties: false,
};
