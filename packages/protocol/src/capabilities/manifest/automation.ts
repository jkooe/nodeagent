import type { CapabilityDescriptor } from '../../messages.js';
import { CapabilityNames } from '../names.js';
import { filterSchema } from '../schemas.js';

/** automation 组能力清单 */
export const AUTOMATION_CAPABILITIES: CapabilityDescriptor[] = [
  {
    name: CapabilityNames.TaskList,
    version: '1.0',
    description: '列出当前后台异步任务（system.shell.exec 以 async:true 启动的命令）。',
    risk: 'low',
    params_schema: { type: 'object', properties: {}, additionalProperties: false },
    returns_schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task_id: { type: 'string' },
              command: { type: 'string', description: '命令（sha256 摘要后前 8 位）' },
              state: { type: 'string', description: 'running | done | killed | failed' },
              started_at: { type: 'integer' },
              duration_ms: { type: 'integer' },
              exit_code: { type: 'integer' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.TaskGet,
    version: '1.0',
    description:
      '查询异步任务状态与输出。任务结束后仍可查询（保留最近 N 条），输出支持增量读取（offset）。',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        stream: { type: 'string', enum: ['stdout', 'stderr'], default: 'stdout' },
        offset: {
          type: 'integer',
          description: '从输出的第 offset 字节开始读（增量拉取）',
          default: 0,
        },
        max_bytes: { type: 'integer', default: 262144 },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        state: { type: 'string' },
        exit_code: { type: 'integer' },
        started_at: { type: 'integer' },
        duration_ms: { type: 'integer' },
        data: { type: 'string', description: '本次读取到的输出片段' },
        offset: { type: 'integer', description: '已读到的字节位置（下次续读用）' },
        total_bytes: { type: 'integer' },
      },
    },
  },
  {
    name: CapabilityNames.TaskKill,
    version: '1.0',
    description: '强制终止一个后台异步任务（杀整棵进程树）。',
    risk: 'medium',
    params_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: { killed: { type: 'boolean' }, task_id: { type: 'string' } },
    },
  },
  {
    name: CapabilityNames.ClipGet,
    version: '1.1',
    description:
      '读取被控端剪贴板。format=auto（默认）优先取图片、无图则取文本；text 仅取文本；image 仅取图片。',
    risk: 'medium',
    params_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['auto', 'text', 'image'], default: 'auto' },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'text | image' },
        text: { type: 'string' },
        format: { type: 'string', description: '图片格式（png）' },
        image_base64: { type: 'string' },
        bytes: { type: 'integer' },
      },
    },
  },
  {
    name: CapabilityNames.ClipSet,
    version: '1.1',
    description:
      '向被控端剪贴板写入文本或图片（Windows: Set-Clipboard / SetImage；macOS: pbcopy）。' +
      '图片以 Base64 PNG 传入（image_base64），内部经临时文件传递以规避命令行长度限制。',
    risk: 'medium',
    params_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '文本（与 image_base64 二选一）' },
        image_base64: { type: 'string', description: 'PNG 图片的 Base64（与 text 二选一）' },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        written: { type: 'integer', description: '写入的字符数（文本）' },
        written_bytes: { type: 'integer', description: '写入的字节数（图片）' },
      },
    },
  },
  {
    name: CapabilityNames.NetApply,
    version: '1.0',
    description:
      '**网络变更两阶段提交**（commit-confirm）：备份当前网络配置 → 应用变更 → 注册一个 OS 级' +
      '一次性计划任务到点自动回滚（不依赖 agent 进程存活）→ 控制端调用 system.net.confirm 确认即提交。' +
      '用于远程改 IP / 切 DHCP 这类「改错就失联」的操作 —— 未确认则自动回滚，不会把自己关在门外。',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['static', 'dhcp', 'command'], description: '变更类型；command=自定义命令（POSIX 仅支持此项）' },
        interface: { type: 'string', description: '网卡别名（如「以太网」）；不填则自动取带默认网关的那块' },
        ip: { type: 'string', description: 'mode=static：新 IPv4' },
        mask: { type: 'string', description: 'mode=static：子网掩码（如 255.255.255.0）' },
        gateway: { type: 'string', description: 'mode=static：网关（可选）' },
        dns: { type: 'array', items: { type: 'string' }, description: 'mode=static：DNS 列表（可选）' },
        command: { type: 'string', description: 'mode=command：要执行的变更命令' },
        confirm_within_ms: {
          type: 'integer',
          minimum: 15000,
          maximum: 600000,
          default: 60000,
          description: '确认窗口；逾期自动回滚（默认 60 秒）',
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        applied: { type: 'boolean' },
        backup_path: { type: 'string', description: '变更前配置备份（netsh dump，可用 netsh -f 恢复）' },
        rollback_scheduled: { type: 'boolean' },
        task_name: { type: 'string' },
        rollback_at: { type: 'integer', description: '自动回滚时间戳（Unix 毫秒）' },
        confirm_within_ms: { type: 'integer' },
        before: { type: 'object', description: '变更前地址信息' },
        after: { type: 'object', description: '变更后地址信息' },
        hint: { type: 'string' },
      },
    },
  },
  {
    name: CapabilityNames.NetConfirm,
    version: '1.0',
    description:
      '确认（提交）网络变更：取消自动回滚任务。控制端通常在新地址上重连成功后调用。' +
      '不传 task_name 则取消全部待确认项。',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: { task_name: { type: 'string', description: 'net.apply 返回的任务名；省略则取消全部' } },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        confirmed: { type: 'integer' },
        cancelled: { type: 'array', items: { type: 'string' } },
        remaining: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: CapabilityNames.NetStatus,
    version: '1.0',
    description: '查看网络现状：各网卡地址、待确认的变更（含剩余秒数）、历史备份文件。',
    risk: 'low',
    params_schema: { type: 'object', properties: {}, additionalProperties: false },
    returns_schema: {
      type: 'object',
      properties: {
        interfaces: { type: 'array', items: { type: 'object' } },
        pending: { type: 'array', items: { type: 'object' } },
        pending_count: { type: 'integer' },
        backups: { type: 'array', items: { type: 'object' } },
        note: { type: 'string' },
      },
    },
  },
  {
    name: CapabilityNames.EventWatch,
    version: '1.0',
    description:
      '订阅被控端事件：file=文件变动（增删改）、process=进程启停、net=监听端口开闭。' +
      '被控端通过 event 通知主动推送（无需轮询）；事件同时进入环形缓冲，可用 event.poll 拉取。',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['file', 'process', 'net'] },
        path: { type: 'string', description: 'file 类型：监控的目录/文件路径' },
        pattern: { type: 'string', description: '可选：文件名 glob（如 *.log）或进程名子串' },
        recursive: { type: 'boolean', default: false, description: 'file 类型：是否递归子目录' },
        interval_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: 60000,
          default: 5000,
          description: 'process/net 类型的采样间隔',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        watch_id: { type: 'string' },
        kind: { type: 'string' },
        description: { type: 'string' },
      },
    },
  },
  {
    name: CapabilityNames.EventUnwatch,
    version: '1.0',
    description: '取消一个事件订阅（连接断开时也会自动清理）。',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: { watch_id: { type: 'string' } },
      required: ['watch_id'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: { removed: { type: 'boolean' } },
    },
  },
  {
    name: CapabilityNames.EventList,
    version: '1.0',
    description: '列出当前生效的事件订阅及其已产生事件数。',
    risk: 'low',
    params_schema: { type: 'object', properties: {}, additionalProperties: false },
    returns_schema: {
      type: 'object',
      properties: {
        watches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              watch_id: { type: 'string' },
              kind: { type: 'string' },
              description: { type: 'string' },
              events: { type: 'integer' },
              created_at: { type: 'integer' },
            },
          },
        },
        buffered: { type: 'integer', description: '环形缓冲中的事件总数' },
      },
    },
  },
  {
    name: CapabilityNames.EventPoll,
    version: '1.0',
    description:
      '拉取已缓冲的事件（适合无法接收推送的调用方，如 MCP：先 watch 再 poll）。' +
      'since 传入上次返回的 next_cursor 可增量拉取。',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        since: { type: 'integer', description: '游标（上次返回的 next_cursor）' },
        watch_id: { type: 'string', description: '可选：只看某订阅' },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              seq: { type: 'integer' },
              watch_id: { type: 'string' },
              kind: { type: 'string' },
              ts: { type: 'integer' },
              action: { type: 'string' },
              target: { type: 'string' },
              detail: { type: 'string' },
            },
          },
        },
        next_cursor: { type: 'integer' },
        dropped: { type: 'integer', description: '因缓冲上限被丢弃的事件数' },
      },
    },
  },
];
