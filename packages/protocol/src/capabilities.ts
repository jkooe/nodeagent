import type { CapabilityDescriptor, JsonSchema } from './messages.js';

/** nodeagent v1 标准能力名。 */
export const CapabilityNames = {
  SystemInfo: 'system.info',
  SystemStatus: 'system.status',
  ProcessList: 'system.process.list',
  ServiceList: 'system.service.list',
  ShellExec: 'system.shell.exec',
  AppList: 'app.list',
  AppInstall: 'app.install',
} as const;

export type CapabilityName = (typeof CapabilityNames)[keyof typeof CapabilityNames];

// ---------- 通用 schema 片段 ----------

const filterSchema: JsonSchema = {
  type: 'object',
  properties: {
    name_pattern: { type: 'string', description: '名称匹配（子串，不区分大小写）' },
  },
  additionalProperties: false,
};

// ---------- 能力清单 ----------

/**
 * v1 标准能力清单。
 * 被控端按此声明并在 auth_ok 中返回；控制端据此展示与校验。
 */
export const CAPABILITY_MANIFEST: CapabilityDescriptor[] = [
  {
    name: CapabilityNames.SystemInfo,
    version: '1.0',
    description: '获取 Windows 系统基本信息（主机名、OS、CPU、内存、开机时长）',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: '可选：只返回指定字段',
          items: { type: 'string' },
        },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        hostname: { type: 'string' },
        os: { type: 'string' },
        os_version: { type: 'string' },
        arch: { type: 'string' },
        cpu_model: { type: 'string' },
        cpu_cores: { type: 'integer' },
        memory_total: { type: 'integer', description: '字节' },
        uptime_sec: { type: 'integer' },
        is_admin: { type: 'boolean' },
      },
    },
  },
  {
    name: CapabilityNames.SystemStatus,
    version: '1.0',
    description: '获取资源状态：CPU 占用、内存、磁盘、网络适配器',
    risk: 'low',
    params_schema: { type: 'object', properties: {}, additionalProperties: false },
    returns_schema: {
      type: 'object',
      properties: {
        cpu_pct: { type: 'number' },
        memory_used: { type: 'integer' },
        memory_total: { type: 'integer' },
        memory_pct: { type: 'number' },
        disks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              drive: { type: 'string' },
              total: { type: 'integer' },
              free: { type: 'integer' },
              used_pct: { type: 'number' },
            },
          },
        },
        net: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              adapter: { type: 'string' },
              ip: { type: 'string' },
              up: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.ProcessList,
    version: '1.0',
    description: '列出运行中的进程，可按 CPU/内存/名称排序',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        sort_by: { type: 'string', enum: ['cpu', 'memory', 'pid', 'name'], default: 'cpu' },
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
        filter: filterSchema,
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        processes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pid: { type: 'integer' },
              name: { type: 'string' },
              cpu_pct: { type: 'number' },
              memory_bytes: { type: 'integer' },
              started_at: { type: 'integer' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.ServiceList,
    version: '1.0',
    description: '列出 Windows 服务及运行状态',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: {
            name_pattern: { type: 'string' },
            state: { type: 'string', enum: ['running', 'stopped', 'paused'] },
          },
          additionalProperties: false,
        },
        limit: { type: 'integer', default: 100, minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              display_name: { type: 'string' },
              state: { type: 'string' },
              start_type: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.ShellExec,
    version: '1.0',
    description: '执行 PowerShell / cmd 命令并返回退出码与输出',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, description: '要执行的命令' },
        shell: { type: 'string', enum: ['powershell', 'cmd'], default: 'powershell' },
        cwd: { type: 'string', description: '工作目录（可选）' },
        timeout_ms: { type: 'integer', default: 30000, minimum: 1000, maximum: 300000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        exit_code: { type: 'integer' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        duration_ms: { type: 'integer' },
        truncated: { type: 'boolean' },
        killed: { type: 'boolean' },
      },
    },
  },
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

/** 按名称查找能力描述。 */
export function findCapability(name: string): CapabilityDescriptor | undefined {
  return CAPABILITY_MANIFEST.find((c) => c.name === name);
}
