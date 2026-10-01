import type { CapabilityDescriptor } from '../../messages.js';
import { CapabilityNames } from '../names.js';
import { filterSchema } from '../schemas.js';

/** software 组能力清单 */
export const SOFTWARE_CAPABILITIES: CapabilityDescriptor[] = [
  {
    name: CapabilityNames.AppList,
    version: '1.0',
    description: '列出已安装软件（读取注册表卸载项 + winget list）',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: { filter: filterSchema },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        apps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              version: { type: 'string' },
              publisher: { type: 'string' },
              source: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.AppInstall,
    version: '1.0',
    description: '安装软件（优先 winget 静默安装）',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        package: { type: 'string', minLength: 1, description: 'winget 包 ID 或软件名' },
        id: { type: 'string', description: '精确 winget ID（优先使用）' },
        silent: { type: 'boolean', default: true },
        timeout_ms: { type: 'integer', default: 600000, minimum: 10000, maximum: 1800000 },
      },
      required: ['package'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        installed: { type: 'boolean' },
        name: { type: 'string' },
        version: { type: 'string' },
        source: { type: 'string' },
        detail: { type: 'string' },
      },
    },
  },
];
