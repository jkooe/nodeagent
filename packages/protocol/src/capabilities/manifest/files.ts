import type { CapabilityDescriptor } from '../../messages.js';
import { CapabilityNames } from '../names.js';
import { filterSchema } from '../schemas.js';

/** files 组能力清单 */
export const FILES_CAPABILITIES: CapabilityDescriptor[] = [
  {
    name: CapabilityNames.FsList,
    version: '1.0',
    description: '列出目录内容（支持 glob 过滤与递归）',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        pattern: { type: 'string', description: 'glob 过滤，如 "*.log"' },
        recursive: { type: 'boolean', default: false },
        max_entries: { type: 'integer', default: 500, minimum: 1, maximum: 5000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              type: { type: 'string', enum: ['file', 'dir', 'other'] },
              size: { type: 'integer' },
              mtime: { type: 'integer' },
            },
          },
        },
        total: { type: 'integer' },
        truncated: { type: 'boolean' },
      },
    },
  },
  {
    name: CapabilityNames.FsStat,
    version: '1.0',
    description: '获取文件或目录的元信息',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        type: { type: 'string', enum: ['file', 'dir', 'other'] },
        size: { type: 'integer' },
        mtime: { type: 'integer' },
        exists: { type: 'boolean' },
      },
    },
  },
  {
    name: CapabilityNames.FsRead,
    version: '1.0',
    description: '读取文件内容（分块：用 offset/max_bytes 续读，eof 标识结束）',
    risk: 'medium',
    params_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
        offset: { type: 'integer', default: 0, minimum: 0, description: '起始字节偏移' },
        max_bytes: { type: 'integer', default: 1048576, minimum: 1, maximum: 8388608, description: '单次读取上限' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        data: { type: 'string' },
        encoding: { type: 'string' },
        offset: { type: 'integer' },
        bytes: { type: 'integer', description: '本次实际读取字节数' },
        total_bytes: { type: 'integer' },
        eof: { type: 'boolean' },
        sha256: { type: 'string', description: '整文件摘要（仅首次读取时返回）' },
      },
    },
  },
  {
    name: CapabilityNames.FsWrite,
    version: '1.0',
    description: '写入文件（分块：append=true 追加；写入走临时文件 + 原子重命名）',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        data: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
        append: { type: 'boolean', default: false },
        create_dirs: { type: 'boolean', default: false },
      },
      required: ['path', 'data'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        written: { type: 'integer', description: '本次写入字节数' },
        total_bytes: { type: 'integer', description: '写入后的文件总大小' },
        path: { type: 'string' },
      },
    },
  },
];
