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
// 具体清单见 tools/defs.ts（自 index.ts 抽出，顺序即对外呈现顺序）
import { TOOLS } from './tools/defs.js';


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
    case 'na_monitor': {
      const action = (input['action'] as string | undefined) ?? 'list';
      if (action === 'start') {
        if (!input['source']) return { error: 'start 需要 source' };
        const a: Record<string, unknown> = { source: input['source'] };
        for (const k of ['target', 'interval_ms', 'id']) if (input[k] !== undefined) a[k] = input[k];
        return { capability: CapabilityNames.MonitorStart, args: a };
      }
      if (action === 'report') {
        if (!input['id']) return { error: 'report 需要 id' };
        const a: Record<string, unknown> = { id: input['id'] };
        if (input['limit'] !== undefined) a['limit'] = input['limit'];
        return { capability: CapabilityNames.MonitorReport, args: a };
      }
      if (action === 'stop' || action === 'delete') {
        if (!input['id']) return { error: `${action} 需要 id` };
        return { capability: action === 'stop' ? CapabilityNames.MonitorStop : CapabilityNames.MonitorDelete, args: { id: input['id'] } };
      }
      if (action === 'list') return { capability: CapabilityNames.MonitorList, args: {} };
      return { error: `不支持的 action: ${String(action)}` };
    }
    case 'na_log': {
      if (!input['path']) return { error: 'na_log 需要 path' };
      const a: Record<string, unknown> = { path: input['path'] };
      for (const k of ['pattern', 'level', 'since', 'offset', 'limit', 'tail']) if (input[k] !== undefined) a[k] = input[k];
      return { capability: CapabilityNames.LogQuery, args: a };
    }
    case 'na_await': {
      const args: Record<string, unknown> = {};
      for (const k of ['condition', 'state', 'timeout_ms', 'interval_ms', 'text', 'title', 'process', 'path', 'where', 'any_of']) {
        if (input[k] !== undefined) args[k] = input[k];
      }
      if (!args['condition']) return { error: 'await 需要 condition' };
      return { capability: CapabilityNames.GuiAwait, args };
    }
    case 'na_key': {
      const action = input['action'];
      if (action === 'type') {
        if (!input['text']) return { error: 'type 需要 text' };
        return { capability: CapabilityNames.KeyType, args: { text: input['text'] } };
      }
      if (action === 'press') {
        // v1.5.0：四种形式一次只用一种（hotkeys > hotkey > presets > preset > keys），
        // 其余各端会做同样的校验与展开，这里只做薄校验后原样透传。
        const has = (k: string): boolean =>
          input[k] !== undefined && !(Array.isArray(input[k]) && (input[k] as unknown[]).length === 0);
        const forms = ['hotkeys', 'hotkey', 'presets', 'preset', 'keys'].filter(has);
        if (forms.length === 0) return { error: 'press 需要 hotkey / hotkeys / preset / presets / keys 之一' };
        if (forms.length > 1) return { error: `参数混用：${forms.join(' + ')}，一次请只用一种形式` };
        const args: Record<string, unknown> = { [forms[0]!]: input[forms[0]!] };
        for (const k of ['repeat', 'hold_ms', 'route', 'target_pid', 'interval_ms']) {
          if (input[k] !== undefined) args[k] = input[k];
        }
        return { capability: CapabilityNames.KeyPress, args };
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
