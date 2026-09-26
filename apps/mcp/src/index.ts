import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { NodeAgentClient, ClientError, loadConfig, toWsUrl } from '@nodeagent/client';
import { CapabilityNames, type InvokeResult } from '@nodeagent/protocol';

/** stderr 日志（stdout 被 MCP 协议占用，禁止打印）。 */
function log(msg: string): void {
  console.error(`[nodeagent-mcp] ${msg}`);
}

// ---------- 被控端连接（懒加载 + 断线重置） ----------

let client: NodeAgentClient | null = null;

async function ensureClient(): Promise<NodeAgentClient> {
  if (client) return client;
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error('尚未配置被控端。请先在终端运行: nodeagent connect <host> --port 8765 --key <密钥>');
  }
  const c = new NodeAgentClient({
    url: toWsUrl(cfg),
    key: cfg.key,
    clientId: cfg.client_id,
    insecure: cfg.insecure,
  });
  await c.connect();
  log(`已连接被控端 ${cfg.host}:${cfg.port}`);
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
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as [] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const input = (request.params.arguments ?? {}) as Record<string, unknown>;

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
