import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  NodeAgentClient,
  ClientError,
  loadConfig,
  loadKeys,
  toWsUrl,
  discoverOnce,
  resolveTarget,
} from '@nodeagent/client';
import { CapabilityNames, DEFAULT_DISCOVERY_PORT, type InvokeResult } from '@nodeagent/protocol';
import { runMacro } from '@nodeagent/client';

/** stderr 日志（stdout 被 MCP 协议占用，禁止打印）。 */
function log(msg: string): void {
  console.error(`[nodeagent-mcp] ${msg}`);
}

// ---------- 被控端连接（懒加载 + 断线重置） ----------

let client: NodeAgentClient | null = null;
/** 会话级目标设备（na_use 切换；不影响 CLI 的默认设备配置）。 */
let sessionNode: string | null = null;

/**
 * v12.4：被控端事件到 MCP 的两条通路
 *   1) **拉取**：事件已由被控端缓冲，用 na_event_poll 增量取（默认，最稳）
 *   2) **推送**：宿主支持时，经 MCP 标准日志通知（notifications/message）实时送达，
 *      由 na_event_watch 的 notify=true 开启（宿主若不展示日志，则退化为拉取，无副作用）
 */
let eventNotifyEnabled = false;
let eventNotifyCount = 0;

function forwardEventToHost(evt: Record<string, unknown>): void {
  if (!eventNotifyEnabled) return;
  eventNotifyCount += 1;
  const line = `${String(evt['kind'] ?? '')} ${String(evt['action'] ?? '')} ${String(evt['target'] ?? '')}${
    evt['detail'] ? ` (${String(evt['detail'])})` : ''
  }`;
  try {
    // 注意：notification() 返回 Promise —— 必须 catch，否则未处理拒绝会**崩掉整个 MCP 服务**
    // （真机踩过：宿主未声明/不支持 logging 时进程直接退出）
    Promise.resolve(
      server.notification({
        method: 'notifications/message',
        params: { level: 'info', logger: 'nodeagent.event', data: line },
      }),
    ).catch(() => {
      /* 推送失败时静默降级为拉取通路 */
    });
  } catch {
    /* 同步异常同样忽略 */
  }
}

async function ensureClient(): Promise<NodeAgentClient> {
  if (client) return client;
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error('尚未配置被控端。请先在终端运行: nodeagent connect <host> --port 8765 --key <密钥>');
  }
  let target;
  try {
    target = resolveTarget(cfg, sessionNode ?? undefined);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  const { profile, clientId } = target;
  const keys = profile.auth_mode === 'ed25519' ? loadKeys() : null;
  const c = new NodeAgentClient({
    onEvent: (evt) => forwardEventToHost(evt),
    url: toWsUrl(profile),
    key: profile.key ?? '',
    clientId,
    insecure: profile.insecure,
    authMode: profile.auth_mode,
    privateKey: keys?.privateKey,
    hub: profile.hub ? { token: profile.hub.token, nodeId: profile.hub.node_id } : undefined,
  });
  await c.connect();
  log(`已连接被控端 ${target.name} ${profile.host}:${profile.port}（${profile.auth_mode ?? 'psk'}）`);
  client = c;
  return c;
}

async function call(capability: string, args: Record<string, unknown>): Promise<InvokeResult> {
  const c = await ensureClient();
  try {
    return await c.invoke(capability, args);
  } catch (err) {
    client = null; // 连接类错误 → 重置，下次重连
    throw err;
  }
}

// ---------- 工具定义 ----------

const TOOLS = [
  {
    name: 'na_status',
    description:
      '查询被控端 Windows 的资源状态：CPU 占用率、内存使用、各磁盘容量、网络适配器。当用户问"Windows 卡不卡""内存够不够""磁盘满了吗"时使用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'na_system_info',
    description:
      '查询被控端 Windows 的系统基本信息：主机名、操作系统版本、CPU 型号、内存总量、开机时长、是否管理员。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'na_exec',
    description:
      '在被控端 Windows 上执行 PowerShell 命令并返回退出码与输出。用于查日志、查目录、重启服务、运行脚本等任意命令场景。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令' },
        timeout_ms: { type: 'integer', description: '超时毫秒数，默认 30000，最大 300000' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_install',
    description:
      '在被控端 Windows 上安装软件（winget 静默安装）。当用户说"在 Windows 上装个 XX""帮我装 VSCode"时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: '软件名或 winget 包 ID，如 Microsoft.VisualStudioCode' },
        id: { type: 'string', description: '精确 winget ID（可选，优先使用）' },
      },
      required: ['package'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_app_list',
    description: '列出被控端 Windows 上已安装的软件及其版本。',
    inputSchema: {
      type: 'object',
      properties: { name_pattern: { type: 'string', description: '可选：按名称筛选（不区分大小写）' } },
      additionalProperties: false,
    },
  },
  {
    name: 'na_process_list',
    description: '列出被控端 Windows 上运行的进程，可按 CPU 或内存排序。',
    inputSchema: {
      type: 'object',
      properties: {
        sort_by: { type: 'string', enum: ['cpu', 'memory', 'pid', 'name'], description: '排序字段，默认 cpu' },
        limit: { type: 'integer', description: '返回条数，默认 20' },
        name_pattern: { type: 'string', description: '可选：按进程名筛选' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_service_list',
    description: '列出被控端 Windows 的系统服务及其运行状态。',
    inputSchema: {
      type: 'object',
      properties: {
        name_pattern: { type: 'string', description: '可选：按服务名筛选' },
        state: { type: 'string', enum: ['running', 'stopped', 'paused'], description: '可选：按状态筛选' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_screenshot',
    description:
      '截取被控端 Windows 屏幕并直接返回图片。当用户问"Windows 现在画面是什么样""帮我看下屏幕"，或需要视觉确认操作结果时使用。屏幕较大时建议 scale 设 0.5 以减小体积。',
    inputSchema: {
      type: 'object',
      properties: {
        scale: { type: 'number', description: '缩放比例 0.1~1.0，默认 1' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: '默认 jpeg' },
        region: { type: 'string', description: '可选截取区域，格式 "x,y,width,height"' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_mouse',
    description:
      '控制被控端鼠标（需被控端已开启输入控制）。action: move 移动到 (x,y)；click 点击（给了 x/y 则先移动，否则点当前位置）；scroll 滚动 delta 格。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'click', 'scroll'], description: '操作类型' },
        x: { type: 'integer', description: 'X 坐标' },
        y: { type: 'integer', description: 'Y 坐标' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click 的按钮，默认 left' },
        delta: { type: 'integer', description: 'scroll 的滚动格数（正数向上）' },
        duration_ms: { type: 'integer', description: 'move 的平滑移动耗时（毫秒）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_key',
    description:
      '控制被控端键盘（需被控端已开启输入控制）。action: type 输入一段文本；press 按下组合键（如 ["ctrl","c"]）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['type', 'press'], description: '操作类型' },
        text: { type: 'string', description: 'type 时输入的文本' },
        keys: { type: 'array', items: { type: 'string' }, description: 'press 时的按键列表' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_audit',
    description:
      '查询被控端审计日志：谁在何时调用了什么能力、结果如何。用于安全审计与问题追溯，例如"最近谁在操作这台 Windows"。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回条数，默认 20' },
        since: { type: 'integer', description: '仅返回该 Unix 毫秒时间戳之后的记录' },
        client_id: { type: 'string', description: '按调用方筛选' },
        type: { type: 'string', enum: ['invoke', 'auth', 'acl', 'agent'], description: '按事件类别筛选' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_discover',
    description:
      '发现局域网内可用的 nodeagent 被控端设备（监听 UDP 广播）。当用户问"有哪些 Windows 机器可用"、或尚未配置被控端时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'number', description: '监听时长（秒），默认 3，上限 15' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_fs_list',
    description: '列出被控端某目录下的文件与子目录。用户问"Windows 上某目录有什么文件"时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录绝对路径，如 C:\\\\Users\\\\me\\\\Desktop' },
        pattern: { type: 'string', description: '可选 glob 过滤，如 "*.log"' },
        recursive: { type: 'boolean', description: '是否递归子目录' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_fs_read',
    description:
      '读取被控端文件内容（默认 UTF-8）。文件较大时会分块返回，用 offset 续读、看 eof 判断结束。适合读取日志、配置、脚本。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: '默认 utf8；二进制文件用 base64' },
        offset: { type: 'integer', description: '起始字节偏移，默认 0' },
        max_bytes: { type: 'integer', description: '单次读取上限，默认 1MB，最大 8MB' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_fs_write',
    description:
      '向被控端写入文件（自动原子写，不会留半截文件）。已有文件可用 append: true 追加；目录不存在时设 create_dirs: true。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        data: { type: 'string', description: '写入内容' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: '默认 utf8' },
        append: { type: 'boolean', description: '是否追加（默认覆盖）' },
        create_dirs: { type: 'boolean', description: '目录不存在时自动创建' },
      },
      required: ['path', 'data'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_fs_stat',
    description: '查看被控端文件或目录的元信息（类型 / 大小 / 修改时间），用于读文件前先判断类型与大小。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录绝对路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_nodes',
    description: '列出已配置的 nodeagent 被控端设备（● 为当前默认设备）。多台 Windows 时使用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'na_restart',
    description:
      '受控重启被控端（约 4 秒后生效，自动恢复原配置与端口）。配置变更后让 agent 自身生效时使用；' +
      '重启期间连接会短暂中断，等待约 5 秒后即可继续调用其他工具。',
    inputSchema: {
      type: 'object',
      properties: {
        delay_ms: { type: 'integer', description: '延时毫秒（默认 2000）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_window_list',
    description:
      '列出被控端当前可见的顶层窗口（标题 / 进程 / 精确矩形 / 是否前台）。' +
      'GUI 操作第一步：先拿到窗口矩形，再在其范围内定位，避免全屏猜坐标。',
    inputSchema: {
      type: 'object',
      properties: {
        title_pattern: { type: 'string', description: '可选：按标题正则过滤' },
        limit: { type: 'integer', description: '返回上限（默认 50）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_window_focus',
    description: '将被控端的指定窗口（按标题正则）置前并聚焦，返回其精确矩形。点击某窗口内容之前先调用。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '窗口标题（正则，匹配第一个）' },
        wait_ms: { type: 'integer', description: '等待窗口出现（应用刚启动时用）' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_screen_find',
    description:
      '在被控端界面中查找 UI 元素并返回其屏幕坐标（Windows UI Automation）。' +
      '返回中心点 (x,y)，可直接配合 na_mouse 的 click 使用。找不到时自动降级为 OCR 截图识别（支持自绘 UI）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要查找的文本（子串匹配，不区分大小写）' },
        window: { type: 'string', description: '可选：限定在该窗口标题（正则）内查找' },
        control_type: {
          type: 'string',
          description: '可选：控件类型，如 Button / MenuItem / Edit / ListItem（仅 UIA）',
        },
        method: {
          type: 'string',
          enum: ['auto', 'uia', 'ocr'],
          description: 'auto=UIA 优先+OCR 兜底；uia=仅 UIA；ocr=仅截图识别',
        },
        limit: { type: 'integer', description: '返回上限（默认 20）' },
        wait_ms: {
          type: 'integer',
          description: '等待元素出现的上限毫秒（0=只查一次）。界面有动画/加载时建议 3000~8000',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_bg',
    description:
      '在被控端后台执行长命令（如下载、安装、日志采样），立即返回 task_id 不阻塞。' +
      '之后用 na_task 查询输出或终止。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令' },
        timeout_ms: { type: 'integer', description: '超时毫秒（默认 300000，即 5 分钟）' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_task',
    description:
      '管理后台任务：action=list 列出；action=get 读取输出（offset 支持增量续读）；action=kill 终止。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'kill'], description: '默认 list' },
        task_id: { type: 'string', description: 'get/kill 时必填' },
        offset: { type: 'integer', description: 'get 时从第 N 字节续读（默认 0）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_macro_run',
    description:
      '回放一段 GUI 宏（步骤序列）：把一次成功操作固化后重复执行。' +
      '步骤支持 focus/find/click/type/key/drag/sleep/exec/clip/assert/capture，' +
      '可带 retry 重试、optional 可选、${VAR} 变量替换。返回每步结果（含失败定位）。',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '步骤数组',
          items: { type: 'object', additionalProperties: true },
        },
        vars: { type: 'object', description: '可选：变量表（供 ${NAME} 替换）' },
        default_delay_ms: { type: 'integer', description: '每步之间默认等待' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_net_status',
    description:
      '查看被控端网络现状：各网卡 IP/网关、**待确认的网络变更**（含剩余秒数）、历史配置备份。' +
      '改网络前后都应先看它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'na_net_apply',
    description:
      '**改被控端网络**（高危）：两阶段提交 —— 先备份当前配置，再应用变更，并注册 OS 级定时回滚任务；' +
      '你必须在 confirm_within_ms 内（可能要在新地址上重连后）用 na_net_confirm 确认，' +
      '否则自动回滚到变更前配置。用于远程改 IP / 切 DHCP 这类「改错就失联」的操作。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['static', 'dhcp', 'command'] },
        interface: { type: 'string', description: '网卡别名；省略则用带默认网关的那块' },
        ip: { type: 'string' },
        mask: { type: 'string' },
        gateway: { type: 'string' },
        dns: { type: 'array', items: { type: 'string' } },
        command: { type: 'string', description: 'mode=command 时执行的自定义变更命令' },
        confirm_within_ms: { type: 'integer', description: '确认窗口毫秒（默认 60000，最小 15000）' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_net_confirm',
    description: '确认（提交）网络变更，取消自动回滚。不传 task_name 则取消全部待确认项。',
    inputSchema: {
      type: 'object',
      properties: { task_name: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'na_agent_update',
    description:
      '**被控端自更新**：让它自己从 URL 下载新版本 agent 并替换自身（校验哈希 → 备份 → 原子替换 → 重启）。' +
      '用于控制端与被控端不可达、但被控端能上网的场景（跨网段/NAT/异地）。' +
      'sha256 必填（安全底线）；不确定时可先 dry_run=true 只校验不改动。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '更新包地址（http/https）' },
        sha256: { type: 'string', description: '期望哈希（12~64 位十六进制）' },
        restart: { type: 'boolean', description: '替换后是否重启（默认 true）' },
        dry_run: { type: 'boolean', description: '只下载校验，不改动文件' },
      },
      required: ['url', 'sha256'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_audio_get',
    description: '读取被控端默认播放设备的静音状态与主音量（Windows: Core Audio / macOS: osascript）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'na_audio_set',
    description:
      '设置被控端静音开关或主音量（可读回实际状态，故为确定性设置而非切换）。' +
      '常用于「把远端那台机器静音」。mute 与 volume 至少给一个。',
    inputSchema: {
      type: 'object',
      properties: {
        mute: { type: 'boolean', description: 'true=静音，false=取消静音' },
        volume: { type: 'integer', description: '主音量 0-100' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_metrics',
    description:
      '按 PRD 2.2 汇总被控端成功指标（闭环成功率 / 装软件成功率 / P95 时延 / 安全拦截率）' +
      '及达标判定与按能力细分。排查「成功率掉了没有／哪个能力最慢」时用。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: '可选：只统计该 Unix 毫秒之后的审计条目' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_event_watch',
    description:
      '订阅被控端事件：file=文件变动、process=进程启停、net=监听端口开闭。' +
      'MCP 无法接收推送，事件会进入服务端缓冲，用 na_event_poll 拉取。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['file', 'process', 'net'] },
        path: { type: 'string', description: 'file 类型：监控的目录/文件路径' },
        pattern: { type: 'string', description: '可选：文件名或进程名 glob（如 *.log、chrome*）' },
        recursive: { type: 'boolean', description: 'file 类型：是否递归子目录' },
        interval_ms: { type: 'integer', description: 'process/net 采样间隔（1000~60000，默认 5000）' },
        notify: {
          type: 'boolean',
          description:
            '开启实时推送（MCP 日志通知）；宿主若不展示日志则退化为 na_event_poll 拉取，无副作用',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_event_poll',
    description:
      '拉取已缓冲的被控端事件（增量：传上次返回的 next_cursor）。' +
      '典型用法：先 na_event_watch 订阅，稍后 na_event_poll 查看期间发生了什么。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回条数（默认 50）' },
        since: { type: 'integer', description: '游标：上次返回的 next_cursor' },
        watch_id: { type: 'string', description: '可选：只看某个订阅' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_event_list',
    description: '列出当前生效的事件订阅（含各自已产生的事件数）与缓冲区大小。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'na_event_unwatch',
    description: '取消一个事件订阅（长时间不用的订阅应主动取消，避免浪费被控端资源）。',
    inputSchema: {
      type: 'object',
      properties: { watch_id: { type: 'string' } },
      required: ['watch_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_record',
    description:
      '录制被控端屏幕为帧序列（JPEG），检测到 ffmpeg 时额外封装 mp4。' +
      '用于复现间歇性问题或记录 GUI 操作；产物在被控端目录，用 na_fs_read 取回。',
    inputSchema: {
      type: 'object',
      properties: {
        duration_ms: { type: 'integer', description: '时长毫秒（1000~60000，默认 5000）' },
        fps: { type: 'integer', description: '帧率 1~10（默认 2）' },
        scale: { type: 'number', description: '全屏缩放 0.1~1（默认 0.5）' },
        region: { type: 'string', description: '可选 "x,y,width,height" 只录该区域' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_clip',
    description:
      '读写被控端剪贴板：action=get 读取文本；action=set 写入文本。要粘贴到 GUI 输入框时先 set 再用 na_key 按 ctrl+v。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: '默认 get' },
        text: { type: 'string', description: 'set 时要写入的文本' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_use',
    description: '切换本次会话的目标设备（不影响 CLI 的默认设备）。用户说"切换到某台机器"时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '设备名（用 na_nodes 查看）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
] as const;

/** MCP 工具入参 → 能力 args。 */
function toArgs(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case 'na_process_list': {
      const args: Record<string, unknown> = {};
      if (input['sort_by']) args['sort_by'] = input['sort_by'];
      if (input['limit']) args['limit'] = input['limit'];
      if (input['name_pattern']) args['filter'] = { name_pattern: input['name_pattern'] };
      return args;
    }
    case 'na_service_list': {
      const args: Record<string, unknown> = {};
      const filter: Record<string, unknown> = {};
      if (input['name_pattern']) filter['name_pattern'] = input['name_pattern'];
      if (input['state']) filter['state'] = input['state'];
      if (Object.keys(filter).length > 0) args['filter'] = filter;
      return args;
    }
    case 'na_event_watch': {
      // notify 是 MCP 层开关（推送），能力侧不认识它 —— 必须剥离，否则被 additionalProperties 拒
      const args: Record<string, unknown> = { kind: input['kind'] };
      if (input['path'] !== undefined) args['path'] = input['path'];
      if (input['pattern'] !== undefined) args['pattern'] = input['pattern'];
      if (input['recursive'] !== undefined) args['recursive'] = input['recursive'];
      if (input['interval_ms'] !== undefined) args['interval_ms'] = input['interval_ms'];
      return args;
    }
    case 'na_app_list': {
      const args: Record<string, unknown> = {};
      if (input['name_pattern']) args['filter'] = { name_pattern: input['name_pattern'] };
      return args;
    }
    default:
      return { ...input };
  }
}

const TOOL_TO_CAPABILITY: Record<string, string> = {
  na_status: CapabilityNames.SystemStatus,
  na_system_info: CapabilityNames.SystemInfo,
  na_exec: CapabilityNames.ShellExec,
  na_install: CapabilityNames.AppInstall,
  na_app_list: CapabilityNames.AppList,
  na_process_list: CapabilityNames.ProcessList,
  na_service_list: CapabilityNames.ServiceList,
  na_screenshot: CapabilityNames.ScreenCapture,
  na_audit: CapabilityNames.AuditList,
  na_fs_list: CapabilityNames.FsList,
  na_fs_read: CapabilityNames.FsRead,
  na_fs_write: CapabilityNames.FsWrite,
  na_fs_stat: CapabilityNames.FsStat,
  na_restart: CapabilityNames.AgentRestart,
  na_metrics: CapabilityNames.Metrics,
  na_audio_get: CapabilityNames.AudioGet,
  na_agent_update: CapabilityNames.AgentUpdate,
  na_audio_set: CapabilityNames.AudioSet,
  na_net_status: CapabilityNames.NetStatus,
  na_net_apply: CapabilityNames.NetApply,
  na_net_confirm: CapabilityNames.NetConfirm,
  na_event_watch: CapabilityNames.EventWatch,
  na_event_poll: CapabilityNames.EventPoll,
  na_event_unwatch: CapabilityNames.EventUnwatch,
  na_window_list: CapabilityNames.WindowList,
  na_window_focus: CapabilityNames.WindowFocus,
  na_screen_find: CapabilityNames.ScreenFind,
};

type Resolved = { capability: string; args: Record<string, unknown> } | { error: string };

/** MCP 工具调用 → 能力名 + 参数（多动作工具在此分发）。 */
function resolveToolCall(toolName: string, input: Record<string, unknown>): Resolved {
  switch (toolName) {
    case 'na_screenshot': {
      const args: Record<string, unknown> = {};
      if (input['scale'] !== undefined) args['scale'] = input['scale'];
      if (input['format'] !== undefined) args['format'] = input['format'];
      if (input['region'] !== undefined) {
        const n = String(input['region']).split(',').map(Number);
        if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) {
          return { error: 'region 格式应为 "x,y,width,height"' };
        }
        args['region'] = { x: n[0], y: n[1], width: n[2], height: n[3] };
      }
      return { capability: CapabilityNames.ScreenCapture, args };
    }
    case 'na_mouse': {
      const action = input['action'];
      if (action === 'move') {
        if (input['x'] === undefined || input['y'] === undefined) return { error: 'move 需要 x 与 y' };
        const args: Record<string, unknown> = { x: input['x'], y: input['y'] };
        if (input['duration_ms'] !== undefined) args['duration_ms'] = input['duration_ms'];
        return { capability: CapabilityNames.MouseMove, args };
      }
      if (action === 'click') {
        const args: Record<string, unknown> = {};
        if (input['x'] !== undefined && input['y'] !== undefined) {
          args['x'] = input['x'];
          args['y'] = input['y'];
        }
        if (input['button'] !== undefined) args['button'] = input['button'];
        return { capability: CapabilityNames.MouseClick, args };
      }
      if (action === 'scroll') {
        if (input['delta'] === undefined) return { error: 'scroll 需要 delta' };
        return { capability: CapabilityNames.MouseScroll, args: { delta: input['delta'] } };
      }
      if (action === 'drag') {
        const need = ['from_x', 'from_y', 'to_x', 'to_y'];
        for (const k of need) {
          if (input[k] === undefined) return { error: `drag 需要 ${need.join('/')}` };
        }
        const args: Record<string, unknown> = {
          from_x: input['from_x'], from_y: input['from_y'],
          to_x: input['to_x'], to_y: input['to_y'],
        };
        if (input['button'] !== undefined) args['button'] = input['button'];
        return { capability: CapabilityNames.MouseDrag, args };
      }
      return { error: `不支持的 action: ${String(action)}` };
    }
    case 'na_key': {
      const action = input['action'];
      if (action === 'type') {
        if (!input['text']) return { error: 'type 需要 text' };
        return { capability: CapabilityNames.KeyType, args: { text: input['text'] } };
      }
      if (action === 'press') {
        if (!Array.isArray(input['keys']) || input['keys'].length === 0) {
          return { error: 'press 需要非空 keys 数组' };
        }
        return { capability: CapabilityNames.KeyPress, args: { keys: input['keys'] } };
      }
      return { error: `不支持的 action: ${String(action)}` };
    }
    case 'na_bg': {
      if (!input['command']) return { error: '需要 command' };
      const args: Record<string, unknown> = { command: input['command'], async: true };
      if (input['timeout_ms'] !== undefined) args['timeout_ms'] = input['timeout_ms'];
      return { capability: CapabilityNames.ShellExec, args };
    }
    case 'na_task': {
      const action = input['action'] ?? 'list';
      if (action === 'list') return { capability: CapabilityNames.TaskList, args: {} };
      if (action === 'get') {
        if (!input['task_id']) return { error: 'get 需要 task_id' };
        const args: Record<string, unknown> = { task_id: input['task_id'] };
        if (input['offset'] !== undefined) args['offset'] = input['offset'];
        return { capability: CapabilityNames.TaskGet, args };
      }
      if (action === 'kill') {
        if (!input['task_id']) return { error: 'kill 需要 task_id' };
        return { capability: CapabilityNames.TaskKill, args: { task_id: input['task_id'] } };
      }
      return { error: `不支持的 action: ${String(action)}` };
    }
    case 'na_record': {
      const args: Record<string, unknown> = {};
      if (input['duration_ms'] !== undefined) args['duration_ms'] = input['duration_ms'];
      if (input['fps'] !== undefined) args['fps'] = input['fps'];
      if (input['scale'] !== undefined) args['scale'] = input['scale'];
      if (input['region'] !== undefined) {
        const n = String(input['region']).split(',').map(Number);
        if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) {
          return { error: 'region 格式应为 "x,y,width,height"' };
        }
        args['region'] = { x: n[0], y: n[1], width: n[2], height: n[3] };
      }
      return { capability: CapabilityNames.ScreenRecord, args };
    }
    case 'na_clip': {
      const action = input['action'] ?? 'get';
      if (action === 'get') {
        const args: Record<string, unknown> = {};
        if (input['format'] !== undefined) args['format'] = input['format'];
        return { capability: CapabilityNames.ClipGet, args };
      }
      if (action === 'set') {
        if (input['text'] === undefined && input['image_base64'] === undefined) {
          return { error: 'set 需要 text 或 image_base64' };
        }
        const args: Record<string, unknown> = {};
        if (input['text'] !== undefined) args['text'] = input['text'];
        if (input['image_base64'] !== undefined) args['image_base64'] = input['image_base64'];
        return { capability: CapabilityNames.ClipSet, args };
      }
      return { error: `不支持的 action: ${String(action)}` };
    }
    default: {
      const capability = TOOL_TO_CAPABILITY[toolName];
      if (!capability) return { error: `未知工具: ${toolName}` };
      return { capability, args: toArgs(toolName, input) };
    }
  }
}

// ---------- 服务 ----------

const server = new Server(
  { name: 'nodeagent', version: '0.1.0' },
  {
    // v12.4：声明 logging —— 事件推送走 MCP 标准日志通知（notifications/message）。
    // 不声明时 SDK 会断言失败并**崩掉进程**（真机踩过），故必须显式声明。
    capabilities: { tools: {}, logging: {} },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as [] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const input = (request.params.arguments ?? {}) as Record<string, unknown>;

  // na_nodes：列出已配置设备（不经过被控端连接）
  if (name === 'na_nodes') {
    const cfg = loadConfig();
    if (!cfg || Object.keys(cfg.nodes).length === 0) {
      return { content: [{ type: 'text', text: '尚未配置任何设备。请先用 nodeagent connect 添加。' }] };
    }
    const lines = Object.entries(cfg.nodes).map(([n, p]) => {
      const mark = n === (sessionNode ?? cfg.current) ? '●' : ' ';
      const via = p.hub ? `经 Hub ${p.host}:${p.port}` : `${p.host}:${p.port}`;
      return `${mark} ${n} — ${via}（${p.auth_mode ?? 'psk'}）${p.note ? `  ${p.note}` : ''}`;
    });
    return {
      content: [{ type: 'text', text: `已配置 ${lines.length} 台设备（● = 当前目标）：\n${lines.join('\n')}` }],
    };
  }

  // na_event_watch：notify 开关是会话级设置，在入口处处理
  if (name === 'na_event_watch' && input['notify'] === true) {
    eventNotifyEnabled = true;
  }

  // na_event_list：附带推送状态（便于判断是否需要改用拉取）
  if (name === 'na_event_list') {
    try {
      const client = await ensureClient();
      const r = await client.invoke(CapabilityNames.EventList, {});
      const d = r.status === 'ok' ? (r.data as Record<string, unknown>) : {};
      const watches = (d['watches'] as unknown[]) ?? [];
      const lines = (watches as Array<Record<string, unknown>>).map(
        (w) => `  ${String(w['watch_id'])}  ${String(w['kind']).padEnd(8)} 事件 ${String(w['events'])}  ${String(w['description'])}`,
      );
      const head = watches.length
        ? `当前 ${watches.length} 个订阅（被控端缓冲 ${String(d['buffered'] ?? 0)} 条）：`
        : '当前没有事件订阅';
      const push = eventNotifyEnabled
        ? `推送：已开启（已转发 ${eventNotifyCount} 条；宿主不展示日志时请改用 na_event_poll）`
        : '推送：未开启（用 na_event_watch 的 notify=true 可开启；否则用 na_event_poll 拉取）';
      return { content: [{ type: 'text', text: `${head}\n${lines.join('\n')}\n${push}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `✗ ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }

  // na_macro_run：需要直接驱动一个长连接完成多步操作，故在执行入口单独处理
  if (name === 'na_macro_run') {
    const steps = input['steps'];
    if (!Array.isArray(steps) || steps.length === 0) {
      return { content: [{ type: 'text', text: '✗ steps 不能为空' }] };
    }
    try {
      const client = await ensureClient();
      const res = await runMacro(
        { client: client as unknown as NodeAgentClient },
        {
          name: (input['name'] as string) ?? 'macro',
          steps: steps as never,
          ...(input['default_delay_ms'] !== undefined
            ? { default_delay_ms: Number(input['default_delay_ms']) }
            : {}),
        },
        (input['vars'] ?? {}) as Record<string, string>,
      );
      const lines = res.steps.map(
        (s) => `${s.ok ? '✓' : '✗'} [${String(s.index).padStart(2)}] ${s.action.padEnd(8)} ${String(s.ms + 'ms').padStart(7)}  ${s.detail ?? ''}`,
      );
      const head = res.ok
        ? `宏「${res.name}」全部 ${res.steps.length} 步通过：`
        : `宏「${res.name}」在第 ${res.failed_at} 步失败：`;
      return { content: [{ type: 'text', text: `${head}\n${lines.join('\n')}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `✗ 宏执行异常: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }

  // na_use：会话级切换目标设备（下次调用生效，不影响 CLI 的默认设备）
  if (name === 'na_use') {
    const targetName = String(input['name'] ?? '');
    const cfg = loadConfig();
    if (!cfg?.nodes[targetName]) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `未配置的设备: ${targetName}；已配置：${Object.keys(cfg?.nodes ?? {}).join(', ') || '（空）'}`,
          },
        ],
      };
    }
    sessionNode = targetName;
    client = null; // 下次调用时按新设备重连
    const p = cfg.nodes[targetName]!;
    return {
      content: [{ type: 'text', text: `已切换目标设备为「${targetName}」→ ${p.host}:${p.port}` }],
    };
  }

  // na_discover：本地 UDP 监听，不经过被控端连接
  if (name === 'na_discover') {
    const waitSec = Math.min(Math.max(Number(input['wait_seconds'] ?? 3), 1), 15);
    try {
      const nodes = await discoverOnce(waitSec * 1000, { port: DEFAULT_DISCOVERY_PORT });
      if (nodes.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: '未发现设备。请确认被控端已启动、与本机在同一局域网，且防火墙未拦截 UDP 广播。',
            },
          ],
        };
      }
      const lines = nodes.map(
        (n) =>
          `- ${n.node_id} @ ${n.host}:${n.port}（${n.tls ? 'wss' : 'ws'}，${n.auth_mode}）${n.platform}${
            n.input_enabled ? ' [输入控制已开]' : ''
          }`,
      );
      return { content: [{ type: 'text', text: `发现 ${nodes.length} 台被控端：\n${lines.join('\n')}` }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `发现失败: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }

  const resolved = resolveToolCall(name, input);
  if ('error' in resolved) {
    return { isError: true, content: [{ type: 'text', text: resolved.error }] };
  }

  try {
    const result = await call(resolved.capability, resolved.args);
    if (result.status === 'failed') {
      const err = result.error;
      return {
        isError: true,
        content: [{ type: 'text', text: `${err?.name ?? 'E_EXECUTION_FAILED'}: ${err?.message ?? '执行失败'}` }],
      };
    }

    // 截屏：直接返回图像内容，便于 AI 观察
    if (name === 'na_screenshot') {
      const d = result.data as { image: string; format: string; width: number; height: number; bytes: number };
      return {
        content: [
          { type: 'image', data: d.image, mimeType: d.format === 'png' ? 'image/png' : 'image/jpeg' },
          { type: 'text', text: `截图 ${d.width}x${d.height}（${(d.bytes / 1024).toFixed(1)} KB，${d.format}）` },
        ],
      };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
  } catch (err) {
    if (err instanceof ClientError) {
      return { isError: true, content: [{ type: 'text', text: `${err.name}: ${err.message}` }] };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `调用失败: ${msg}` }] };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server 已启动（stdio）');
}

main().catch((err: unknown) => {
  log(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
