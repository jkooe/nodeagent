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
};

// ---------- 服务 ----------

const server = new Server(
  { name: 'nodeagent', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as [] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const capability = TOOL_TO_CAPABILITY[name];
  if (!capability) {
    return { isError: true, content: [{ type: 'text', text: `未知工具: ${name}` }] };
  }

  const input = (request.params.arguments ?? {}) as Record<string, unknown>;
  try {
    const result = await call(capability, toArgs(name, input));
    if (result.status === 'failed') {
      const err = result.error;
      return {
        isError: true,
        content: [{ type: 'text', text: `${err?.name ?? 'E_EXECUTION_FAILED'}: ${err?.message ?? '执行失败'}` }],
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
