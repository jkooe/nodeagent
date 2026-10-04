import type { CapabilityDescriptor } from '../../messages.js';
import { CapabilityNames } from '../names.js';
import { filterSchema } from '../schemas.js';

/** system 组能力清单 */
export const SYSTEM_CAPABILITIES: CapabilityDescriptor[] = [
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
        pid: { type: 'integer', description: '被控端进程 PID（v11）' },
        agent_script: { type: 'string', description: '被控端入口脚本路径，供一键升级定位（v11）' },
        agent_home: { type: 'string', description: '被控端数据目录 NODEAGENT_HOME（v11）' },
        node_path: { type: 'string', description: '被控端 Node 可执行文件路径（v11）' },
        ps_helper: {
          type: 'object',
          description: 'PowerShell 常驻助手状态（v15）：spawned/hits/failures/consecutiveFailures/avg_ms 等',
        },
        build: {
          type: 'object',
          description:
            'v18 构建指纹：hash（运行中 agent 脚本的 sha256 前 12 位，部署校验用）、bytes、mtime_ms、' +
            'node（运行时版本）、started_at、uptime_ms',
        },
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
    version: '1.1',
    description: '执行 PowerShell / cmd 命令并返回退出码与输出；async:true 时转后台任务立即返回 task_id',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, description: '要执行的命令' },
        shell: { type: 'string', enum: ['powershell', 'cmd'], default: 'powershell' },
        cwd: { type: 'string', description: '工作目录（可选）' },
        timeout_ms: { type: 'integer', default: 30000, minimum: 1000, maximum: 300000 },
        async: { type: 'boolean', default: false, description: '后台执行，立即返回 task_id（用 system.task.* 管理）' },
        wait_forever: { type: 'boolean', default: false, description: '仅 async 模式：不设超时（timeout_ms 失效）' },
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
    name: CapabilityNames.AuditList,
    version: '1.0',
    description: '查询被控端审计日志：谁在何时调用了什么能力、结果如何',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 1000 },
        since: { type: 'integer', description: '仅返回该时间戳（Unix 毫秒）之后的记录' },
        client_id: { type: 'string', description: '按调用方筛选' },
        type: { type: 'string', enum: ['invoke', 'auth', 'acl', 'agent'], description: '按事件类别筛选' },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        entries: { type: 'array', items: { type: 'object' } },
        total: { type: 'integer', description: '本次读取的总条数（未截断前）' },
        file: { type: 'string', description: '审计文件路径' },
      },
    },
  },
  {
    name: CapabilityNames.AgentRestart,
    version: '1.0',
    description:
      '受控重启被控端自身（延时后由独立进程/计划任务拉起，重启后自动沿用原配置）。' +
      '解决「配置变更后无法让自身生效」的问题——不会因进程树清理而中断。',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        delay_ms: {
          type: 'integer',
          minimum: 1,
          maximum: 3600000,
          description: '延时多少毫秒后重启（默认 2000，给调用方留出返回结果的时间）',
          default: 2000,
        },
        reason: { type: 'string', description: '可选：重启原因（写入审计日志）' },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        scheduled: { type: 'boolean', description: '重启任务是否已排入' },
        delay_ms: { type: 'integer' },
        mechanism: { type: 'string', description: '使用的机制：scheduled-task / detached-spawn' },
        message: { type: 'string' },
      },
    },
  },
  {
    name: CapabilityNames.AuditVerify,
    version: '1.0',
    description:
      '校验审计日志链完整性（v11 链式哈希）：逐条重算哈希并比对 prev 链接，' +
      '可发现条目被篡改、删除或替换。轮转跨文件连续校验。',
    risk: 'low',
    params_schema: { type: 'object', properties: {}, additionalProperties: false },
    returns_schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        checked: { type: 'integer', description: '参与校验的条目数' },
        legacy: { type: 'integer', description: '无链字段的历史条目数（跳过校验）' },
        broken_at: {
          type: 'object',
          description: '首个异常位置（ok=false 时存在）',
          properties: {
            file: { type: 'string' },
            line: { type: 'integer' },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.Metrics,
    version: '1.0',
    description:
      '按 PRD 2.2 汇总成功指标（数据源为审计日志）：闭环成功率、装软件成功率、P95 时延、安全拦截率，' +
      '并给出与目标阈值的达标判定；同时返回按能力细分统计。',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: '可选：只统计该时间戳（Unix 毫秒）之后的审计条目' },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        close_loop: {
          type: 'object',
          properties: {
            attempts: { type: 'integer' },
            ok: { type: 'integer' },
            failed: { type: 'integer' },
            success_rate: { type: 'number' },
          },
        },
        app_install: { type: 'object' },
        latency: { type: 'object' },
        security: { type: 'object' },
        verdict: { type: 'object', description: '四项指标的达标判定' },
        targets: { type: 'object' },
        by_capability: { type: 'object' },
        window: { type: 'object' },
      },
    },
  },
  {
    name: CapabilityNames.AudioGet,
    version: '1.0',
    description:
      '读取被控端默认播放设备的**静音状态与主音量**。Windows 走 Core Audio COM，macOS 走 osascript。',
    risk: 'low',
    params_schema: { type: 'object', properties: {}, additionalProperties: false },
    returns_schema: {
      type: 'object',
      properties: {
        muted: { type: 'boolean', description: '是否静音' },
        volume: { type: 'integer', description: '主音量 0-100' },
        platform: { type: 'string' },
        backend: { type: 'string', description: '实现后端（CoreAudio / osascript）' },
      },
    },
  },
  {
    name: CapabilityNames.AudioSet,
    version: '1.0',
    description:
      '设置被控端**静音开关或主音量**。返回设置后的实际状态（可读回，故为确定性设置而非切换）。' +
      '常用于「远程把那台机器静音」或配合宏播放媒体时控制音量。',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        mute: { type: 'boolean', description: 'true=静音，false=取消静音' },
        volume: { type: 'integer', minimum: 0, maximum: 100, description: '主音量 0-100' },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        muted: { type: 'boolean' },
        volume: { type: 'integer' },
        applied: { type: 'object', description: '本次实际应用的值（未提供的为 null）' },
      },
    },
  },
  {
    name: CapabilityNames.AgentUpdate,
    version: '1.0',
    description:
      '**拉取式自更新**：被控端自己从 URL 下载新版本 agent 并替换自身（下载 → 校验哈希 → 备份 → ' +
      '原子替换 → 受控重启）。用于控制端与被控端**不可达但被控端能上网**的场景（跨网段/NAT、异地）。' +
      '⚠️ sha256 必填：不校验哈希等于开放远程代码执行。',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '更新包地址（http/https；GitHub Release/自建镜像均可）' },
        sha256: {
          type: 'string',
          description: '期望哈希（12~64 位十六进制，可比对前 12 位）——**安全底线，必填**',
        },
        restart: { type: 'boolean', description: '替换后是否自动重启（默认 true）' },
        dry_run: { type: 'boolean', description: '只下载并校验，不改动任何文件（默认 false）' },
        timeout_ms: { type: 'integer', minimum: 5000, maximum: 600000, description: '下载超时（默认 120000）' },
      },
      required: ['url', 'sha256'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        updated: { type: 'boolean' },
        dry_run: { type: 'boolean' },
        bytes: { type: 'integer' },
        previous: { type: 'object', description: '替换前 { hash, bytes }' },
        current_hash: { type: 'string' },
        incoming_hash: { type: 'string' },
        backup_path: { type: 'string', description: '回滚点：覆盖回入口路径即可' },
        restarted: { type: 'boolean' },
      },
    },
  },
];
