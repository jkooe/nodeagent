import { closeSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { existsSync } from 'node:fs';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path, { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  NodeAgentClient,
  loadMacroFile,
  runMacro,
  ClientError,
  loadConfig,
  saveConfig,
  configPath,
  toWsUrl,
  loadKeys,
  createKeys,
  keysFilePath,
  discoverOnce,
  resolveTarget,
  resolveNodeSelector,
  emptyConfig,
  type ClientConfig,
  type ResolvedTarget,
  type NodeProfile,
} from '@nodeagent/client';
import {
  CapabilityNames,
  matchPattern,
  DEFAULT_DISCOVERY_PORT,
  type CapabilityDescriptor,
  type InvokeResult,
} from '@nodeagent/protocol';

const HELP = `nodeagent —— 跨机 AI 接管框架（控制端 CLI）

用法:
  nodeagent connect <host> [--port 8765] [--key <key>] [--insecure] [--id mac_01] [--auth-mode ed25519]
      配置并连接被控端（握手成功后打印能力清单）
      经 Hub 中转: 追加 --hub-token <Hub 令牌> --hub-node <被控端 node_id> (v6)

  nodeagent keygen [--id mac_01]      生成 Ed25519 密钥对并输出被控端 ACL 配置片段 (v3 零信任)
  nodeagent nodes                     列出已配置的被控端设备 (v5 多设备)
  nodeagent use <设备名>               切换当前默认设备
  nodeagent remove <设备名>            移除设备
  nodeagent audit [--limit 20] [--type invoke|auth|acl|agent] [--client-id X] [--since <ms>]
                                      查询被控端审计日志 (v3+)
  nodeagent audit verify              校验审计链完整性（防篡改检测）(v11)
  nodeagent discover [--wait 5]       发现局域网内的被控端（UDP 广播，免手抄 IP）(v4)

文件传输 (v5):
  nodeagent ls <远端路径> [--recursive] [--pattern "*.log"]     列目录
  nodeagent stat <远端路径>                                      看元信息
  nodeagent cat <远端路径> [--out 本地文件]                       读文本（首块）
  nodeagent pull <远端路径> [--out 本地文件]                      下载（自动分块，支持大文件）
  nodeagent push <本地文件> <远端路径> [--create-dirs]            上传（自动分块）

  nodeagent info                      查看系统信息 (system.info)
  nodeagent status                    查看资源状态 (system.status)
  nodeagent ps [--limit 20]           查看进程 (system.process.list)
  nodeagent services [--limit 20]     查看服务 (system.service.list)
  nodeagent exec "<命令>"              执行命令 (system.shell.exec)
  nodeagent apps                      列出已安装软件 (app.list)
  nodeagent install <包名|ID>          安装软件 (app.install)
  nodeagent restart [--delay 2000]    受控重启被控端（配置变更后让自身生效）(v7)
  nodeagent bg "<命令>" [--timeout-ms N]  后台执行长命令，立即返回 task_id (v10)
  nodeagent tasks                    列出后台任务
  nodeagent task <id> [--offset N] [--kill]  读取/终止后台任务（支持增量续读）
  nodeagent clip [--set "文本"] [--out <路径>] [--image-file <路径>]
                                      读/写剪贴板文本或图片（--out 保存图片）(v11)
  nodeagent macro run <file.json> [--var k=v] [--out <目录>]
                                      回放 GUI 宏（步骤序列，逐步校验）(v12)
  nodeagent macro validate <file.json> | macro init [文件]
  nodeagent events [--kind file|process|net] [--path <路径>] [--pattern G] [--seconds 15]
                                      订阅事件并实时接收推送（无 --kind 则列出订阅）(v12)
  nodeagent record [--duration 5000] [--fps 2] [--scale 0.5] [--region x,y,w,h]
                                      录屏为帧序列（有 ffmpeg 则封装 mp4）(v11)
  nodeagent deploy <agent.mjs> [--path <远端路径>]
                                      一键升级被控端（备份 → 上传 → 重启 → 复验）(v11)
  nodeagent group [add <组名> <设备...> | remove <组名>]  设备分组管理 (v12)
  nodeagent fanout <能力名> [--nodes a,b|@组名] [--args JSON]
                                      多设备并发调用并汇总 (v11)
  nodeagent daemon [start|stop|status] 常驻连接池（批量操作提速 5~10 倍）(v10)
  nodeagent list                      列出被控端可用能力
  nodeagent invoke <capability> [--args '<json>']   通用调用

图形操作 (v2，输入控制需被控端开启 allow_input):
  nodeagent screen                    显示器信息 (screen.info)
  nodeagent screenshot [--out f.jpg] [--scale 0.5] [--region x,y,w,h] [--format jpeg]
                                      截屏并保存 (screen.capture)
  nodeagent mouse move <x> <y> [--duration 300]
  nodeagent mouse click [<x> <y>] [--button left|right|middle]
  nodeagent mouse drag <x1> <y1> <x2> <y2> 鼠标拖拽（拖文件/框选）(v11)
  nodeagent mouse scroll <delta>
  nodeagent key type "<文本>" [--interval 10]
  nodeagent key press <键1> [键2] ...  （组合键，如 ctrl c）

通用选项:
  --node <设备名>  本次命令临时指定目标设备（不改变 current）
                   可放命令后（nodeagent info --node win_b）或前置（nodeagent --node=win_b info）
  --json      以原始 JSON 输出
  --config    显示当前配置路径
`;

/** 已解析的常用选项。 */
interface Options {
  json: boolean;
  insecure: boolean;
  port?: string;
  key?: string;
  id?: string;
  limit?: string;
  args?: string;
  // v2 图形操作
  out?: string;
  format?: string;
  scale?: string;
  region?: string;
  button?: string;
  duration?: string;
  interval?: string;
  /** v3：认证模式 psk | ed25519 */
  authMode?: string;
  /** v3+ 审计查询 */
  since?: string;
  type?: string;
  clientId?: string;
  /** v4 发现 */
  wait?: string;
  discoveryPort?: string;
  /** v5 多设备 */
  node?: string;
  name?: string;
  note?: string;
  /** v5 文件 */
  recursive?: boolean;
  pattern?: string;
  createDirs?: boolean;
  /** v6 Hub */
  hubToken?: string;
  hubNode?: string;
  /** v7 受控重启：延时毫秒 */
  delay?: string;
  /** v10 后台任务 / 剪贴板 */
  timeoutMs?: string;
  kill?: boolean;
  offset?: string;
  set?: string;
  /** v11 剪贴板图片 */
  imageFile?: string;
  /** v11 录屏 */
  fps?: string;
  /** v11 多设备并发 */
  nodes?: string;
  /** v11 部署目标路径 */
  path?: string;
  /** v12 事件订阅 */
  kind?: string;
  /** v12 宏变量 */
  vars?: string[];
  seconds?: string;
  intervalMs?: string;
}

function getClientConfig(): ClientConfig {
  const cfg = loadConfig();
  if (!cfg) {
    fail('尚未配置被控端。请先运行:\n  nodeagent connect <host> --port 8765 --key <密钥>');
  }
  return cfg;
}

/** 本次命令的临时目标设备（来自全局 --node）。 */
let currentNodeOverride: string | undefined;

// ---------- v10 daemon 转发 ----------

const DAEMON_SOCK = path.join(os.tmpdir(), 'nodeagentd.sock');

interface DaemonResponse {
  status: 'ok' | 'failed' | 'daemon_error';
  data?: unknown;
  error?: { name: string; message: string } | string;
}

/** 经 daemon 转发一次能力调用（JSON lines over UDS）。 */
function viaDaemon(node: string, capability: string, args: Record<string, unknown>, timeoutMs?: number): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const s = net.connect(DAEMON_SOCK);
    s.setTimeout(timeoutMs ?? 60_000);
    let buf = '';
    const failOnce = (err: Error): void => {
      s.destroy();
      reject(err);
    };
    s.once('error', failOnce);
    s.once('timeout', () => failOnce(new Error('daemon 转发超时')));
    s.once('connect', () => {
      s.write(JSON.stringify({ node, capability, args, timeout_ms: timeoutMs }) + '\n');
    });
    s.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        try {
          resolve(JSON.parse(buf.slice(0, idx)) as DaemonResponse);
        } catch (err) {
          failOnce(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        s.end();
      }
    });
  });
}

/** 「虚拟客户端」：invoke 转发给 daemon，业务错误原样返回、daemon 自身错误抛异常触发回退。 */
function daemonProxyClient(nodeName: string): { invoke: NodeAgentClient['invoke'] } {
  return {
    async invoke<T>(capability: string, args: Record<string, unknown>, timeoutMs?: number) {
      const resp = await viaDaemon(nodeName, capability, args, timeoutMs);
      if (resp.status === 'daemon_error') {
        throw new Error(typeof resp.error === 'string' ? resp.error : resp.error?.message);
      }
      if (resp.status === 'failed') {
        const e = resp.error;
        return {
          status: 'failed' as const,
          error: typeof e === 'string' ? { name: 'E_EXECUTION_FAILED', message: e } : e,
        } as never;
      }
      return { status: 'ok' as const, data: resp.data } as never;
    },
  };
}

async function withClient<T>(fn: (client: NodeAgentClient) => Promise<T>, nodeName?: string): Promise<T> {
  const cfg = getClientConfig();
  let target: ResolvedTarget;
  try {
    target = resolveTarget(cfg, nodeName ?? currentNodeOverride);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const node = nodeName ?? currentNodeOverride ?? cfg.current;
  // v10 daemon 快路径：socket 存活则经 daemon 复用长连接（省 1~2s TLS+握手）
  if (node && existsSync(DAEMON_SOCK)) {
    try {
      return await fn(daemonProxyClient(node) as unknown as NodeAgentClient);
    } catch (err) {
      // daemon 自身错误（转发失败/超时）→ 静默回退直连；业务错误原样抛出
      if (!(err instanceof ClientError)) {
        return withClientDirect(fn, nodeName);
      }
      throw err;
    }
  }
  return withClientDirect(fn, nodeName);
}

async function withClientDirect<T>(fn: (client: NodeAgentClient) => Promise<T>, nodeName?: string): Promise<T> {
  const cfg = getClientConfig();
  let target: ResolvedTarget;
  try {
    target = resolveTarget(cfg, nodeName ?? currentNodeOverride);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const { profile, clientId } = target;
  const keys = profile.auth_mode === 'ed25519' ? loadKeys() : null;
  const client = new NodeAgentClient({
    url: toWsUrl(profile),
    key: profile.key ?? '',
    clientId,
    insecure: profile.insecure,
    authMode: profile.auth_mode,
    privateKey: keys?.privateKey,
    hub: profile.hub ? { token: profile.hub.token, nodeId: profile.hub.node_id } : undefined,
  });
  try {
    await client.connect();
    return await fn(client);
  } catch (err) {
    if (err instanceof ClientError) {
      fail(`${err.name}: ${err.message}`);
    }
    throw err;
  } finally {
    client.close();
  }
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** 调用能力并处理 status === 'failed' 的业务失败。 */
async function callAndPrint(
  client: NodeAgentClient,
  capability: string,
  args: Record<string, unknown>,
  json: boolean,
  render: (data: unknown) => void,
): Promise<void> {
  const result = await client.invoke(capability, args);
  if (result.status === 'failed') {
    fail(`${result.error?.name ?? 'E_EXECUTION_FAILED'}: ${result.error?.message ?? '执行失败'}`);
  }
  if (json) printJson(result.data);
  else render(result.data);
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return String(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function cmdConnect(host: string, opts: Options): Promise<void> {
  const port = Number(opts.port ?? 8765);
  const authMode: 'psk' | 'ed25519' = opts.authMode === 'ed25519' ? 'ed25519' : 'psk';
  if (authMode === 'psk' && !opts.key) {
    fail('缺少 --key <预共享密钥>（零信任模式请用 --auth-mode ed25519）');
  }

  const name = opts.name ?? host;
  const clientId = opts.id ?? 'mac_01';
  const profile: NodeProfile = {
    host,
    port,
    tls: !process.argv.includes('--no-tls'),
    insecure: opts.insecure,
    key: opts.key ?? '',
    auth_mode: authMode,
  };
  if (opts.note) profile.note = opts.note;
  // v6：经 Hub 中转
  if (opts.hubToken) profile.hub = { token: opts.hubToken, node_id: opts.hubNode ?? name };

  const keys = authMode === 'ed25519' ? loadKeys() : null;
  if (authMode === 'ed25519' && !keys) {
    fail(`零信任模式需要本机密钥，请先运行: nodeagent keygen --id ${clientId}`);
  }

  const client = new NodeAgentClient({
    url: toWsUrl(profile),
    key: profile.key ?? '',
    clientId,
    insecure: profile.insecure,
    authMode,
    privateKey: keys?.privateKey,
    hub: profile.hub ? { token: profile.hub.token, nodeId: profile.hub.node_id } : undefined,
  });
  try {
    const caps = await client.connect();
    const authorized = client.listAuthorized();

    // 连接成功才落盘，避免把错配置写进设备表
    const cfg = loadConfig() ?? emptyConfig(clientId);
    cfg.client_id = clientId;
    cfg.nodes[name] = profile;
    cfg.current = name;
    saveConfig(cfg);

    const via = profile.hub ? `经 Hub ${profile.host}:${profile.port}` : `${profile.host}:${profile.port}`;
    console.log(
      `✓ 已连接并保存设备「${name}」${via}（${profile.tls ? 'wss' : 'ws'}，${authMode}）`,
    );
    console.log(`  配置: ${configPath()}（当前设备 ${name}，共 ${Object.keys(cfg.nodes).length} 台）`);

    const isOk = (n: string): boolean => !authorized || authorized.some((p) => matchPattern(p, n));
    console.log(`\n被控端声明 ${caps.length} 项能力${authorized ? `，其中 ${authorized.length} 项已授权` : ''}:`);
    for (const c of caps) {
      console.log(`  ${isOk(c.name) ? riskIcon(c.risk) : '🚫'} ${c.name.padEnd(24)} ${c.description}`);
    }
  } catch (err) {
    if (err instanceof ClientError) fail(`连接失败 ${err.name}: ${err.message}`);
    throw err;
  } finally {
    client.close();
  }
}

// ---------- v5 多设备管理 ----------

async function cmdNodes(opts: Options): Promise<void> {
  const cfg = loadConfig();
  if (!cfg || Object.keys(cfg.nodes).length === 0) {
    console.log('尚未配置任何设备。用 nodeagent connect <host> --key <密钥> 添加，或 nodeagent discover 先发现。');
    return;
  }
  const names = Object.keys(cfg.nodes);
  if (opts.json) {
    return printJson({ current: cfg.current, client_id: cfg.client_id, nodes: cfg.nodes });
  }
  console.log(`控制端身份: ${cfg.client_id}    共 ${names.length} 台设备\n`);
  console.log(`  ${'名称'.padEnd(16)} ${'地址'.padEnd(22)} ${'协议'.padEnd(6)} ${'认证'.padEnd(9)} 备注`);
  for (const n of names) {
    const p = cfg.nodes[n]!;
    const mark = n === cfg.current ? '●' : ' ';
    const auth = `${p.auth_mode ?? 'psk'}${p.insecure ? '*' : ''}`;
    console.log(
      `${mark} ${n.padEnd(16)} ${`${p.host}:${p.port}`.padEnd(22)} ${(p.tls ? 'wss' : 'ws').padEnd(6)} ${auth.padEnd(9)} ${p.note ?? ''}`,
    );
  }
  console.log('\n（● = 当前设备；认证列 * = 跳过证书校验）');
}

async function cmdUse(name: string | undefined, opts: Options): Promise<void> {
  if (!name) fail('用法: nodeagent use <设备名>');
  const cfg = loadConfig();
  if (!cfg) fail('尚未配置任何设备。请先运行: nodeagent connect <host> --key <密钥>');
  if (!cfg.nodes[name]) {
    fail(`未配置的设备: ${name}；已配置：${Object.keys(cfg.nodes).join(', ') || '（空）'}`);
  }
  cfg.current = name;
  saveConfig(cfg);
  if (opts.json) return printJson({ current: cfg.current });
  const p = cfg.nodes[name]!;
  console.log(`✓ 当前设备已切换为「${name}」 → ${p.host}:${p.port}`);
}

async function cmdRemove(name: string | undefined, opts: Options): Promise<void> {
  if (!name) fail('用法: nodeagent remove <设备名>');
  const cfg = loadConfig();
  if (!cfg || !cfg.nodes[name]) fail(`未配置的设备: ${name}`);
  delete cfg.nodes[name];
  if (cfg.current === name) cfg.current = Object.keys(cfg.nodes)[0] ?? '';
  saveConfig(cfg);
  if (opts.json) return printJson({ removed: name, current: cfg.current });
  console.log(`✓ 已移除设备「${name}」${cfg.current ? `，当前设备: ${cfg.current}` : ''}`);
}

/** v3：生成 Ed25519 密钥对，并输出可直接粘贴的被控端 ACL 配置片段。 */
async function cmdKeygen(opts: Options): Promise<void> {
  const clientId = opts.id ?? 'mac_01';
  const keys = createKeys(clientId);
  console.log('✓ 已生成 Ed25519 密钥对');
  console.log(`  client_id : ${keys.client_id}`);
  console.log(`  key_id    : ${keys.key_id}`);
  console.log(`  私钥      : ${keysFilePath()}   （600 权限，永不外传）`);
  console.log('\n请把下面这段加入被控端 agent.json 的 acl.clients 数组：\n');
  console.log(
    JSON.stringify(
      {
        client_id: keys.client_id,
        pubkey: keys.publicKey,
        allow: ['system.*', 'app.list', 'screen.*'],
        deny: ['input.*'],
        note: 'generated by nodeagent keygen',
      },
      null,
      2,
    ),
  );
  console.log('\n然后让被控端启用零信任模式：agent.json 设 "auth_mode": "ed25519" 并重启 Agent。');
}

function riskIcon(risk: string): string {
  return risk === 'high' ? '🔴' : risk === 'medium' ? '🟡' : '🟢';
}

async function cmdList(opts: Options): Promise<void> {
  const caps = await withClient(async (c) => {
    return c.listCapabilities();
  });
  if (opts.json) return printJson(caps);
  console.log(`被控端可用能力（${caps.length}）:`);
  for (const c of caps as CapabilityDescriptor[]) {
    console.log(`  ${riskIcon(c.risk)} ${c.name.padEnd(24)} ${c.description}`);
  }
}

async function cmdStatus(opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.SystemStatus, {}, opts.json, (data) => {
      const d = data as {
        cpu_pct: number;
        memory_used: number;
        memory_total: number;
        memory_pct: number;
        disks: Array<{ drive: string; total: number; free: number; used_pct: number }>;
        net: Array<{ adapter: string; ip: string }>;
      };
      console.log(`CPU 占用 : ${d.cpu_pct}%`);
      console.log(`内存     : ${humanSize(d.memory_used)} / ${humanSize(d.memory_total)} (${d.memory_pct}%)`);
      console.log('磁盘     :');
      for (const disk of d.disks) {
        console.log(`  ${disk.drive.padEnd(12)} ${humanSize(disk.total - disk.free)} / ${humanSize(disk.total)} 已用 ${disk.used_pct}%`);
      }
      console.log('网络     :');
      for (const n of d.net) console.log(`  ${n.adapter.padEnd(16)} ${n.ip}`);
    }),
  );
}

async function cmdInfo(opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.SystemInfo, {}, opts.json, (data) => {
      const d = data as Record<string, unknown>;
      for (const [k, v] of Object.entries(d)) {
        const val = k === 'memory_total' && typeof v === 'number' ? humanSize(v) : String(v);
        console.log(`${k.padEnd(14)}: ${val}`);
      }
    }),
  );
}

async function cmdPs(opts: Options): Promise<void> {
  const limit = Number(opts.limit ?? 20);
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ProcessList, { limit }, opts.json, (data) => {
      const rows = (data as { processes: Array<{ pid: number; name: string; cpu_pct: number; memory_bytes: number }> }).processes;
      console.log(`${'PID'.padStart(7)}  ${'CPU%'.padStart(7)}  ${'内存'.padStart(9)}  名称`);
      for (const p of rows) {
        console.log(`${String(p.pid).padStart(7)}  ${String(p.cpu_pct).padStart(7)}  ${humanSize(p.memory_bytes).padStart(9)}  ${p.name}`);
      }
    }),
  );
}

async function cmdServices(opts: Options): Promise<void> {
  const limit = Number(opts.limit ?? 20);
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ServiceList, { limit }, opts.json, (data) => {
      const rows = (data as { services: Array<{ name: string; display_name: string; state: string }> }).services;
      console.log(`${'状态'.padEnd(10)} ${'服务名'.padEnd(28)} 显示名`);
      for (const s of rows) console.log(`${s.state.padEnd(10)} ${s.name.padEnd(28)} ${s.display_name}`);
    }),
  );
}

async function cmdExec(command: string, opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ShellExec, { command }, opts.json, (data) => {
      const d = data as { exit_code: number; stdout: string; stderr: string; duration_ms: number; truncated: boolean };
      // 命令自身的输出原样打到 stdout —— 保证 `nodeagent exec "..." | jq` 不被污染
      if (d.stdout) console.log(d.stdout);
      if (d.stderr) console.error(d.stderr);
      // 诊断信息（退出码/耗时）走 stderr：终端下照常可见，管道里不干扰数据
      console.error(
        `[退出码 ${d.exit_code} · ${d.duration_ms}ms${d.truncated ? ' · 输出已截断' : ''}]`,
      );
    }),
  );
}

async function cmdRestart(opts: Options): Promise<void> {
  const delayMs = opts.delay ? Number(opts.delay) : 2000;
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.AgentRestart, { delay_ms: delayMs, reason: 'cli' }, opts.json, (data) => {
      const d = data as { scheduled: boolean; delay_ms: number; mechanism: string; message: string };
      console.log(`✓ ${d.message}`);
      console.log(`  机制: ${d.mechanism}`);
      console.log('  提示: 约 3~4 秒后重连，可执行 `nodeagent info` 验证是否已恢复');
    }),
  );
}

async function cmdBg(command: string, opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(
      c,
      CapabilityNames.ShellExec,
      { command, async: true, timeout_ms: opts.timeoutMs ? Number(opts.timeoutMs) : undefined },
      opts.json,
      (data) => {
        const d = data as { task_id: string; state: string };
        console.log(`✓ 后台任务已启动: ${d.task_id}（${d.state}）`);
        console.log('  查询: nodeagent task ' + d.task_id);
        console.log('  终止: nodeagent task ' + d.task_id + ' --kill');
      },
    ),
  );
}

async function cmdTasks(opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.TaskList, {}, opts.json, (data) => {
      const rows = (data as { tasks: Array<{ task_id: string; state: string; duration_ms: number; exit_code?: number }> }).tasks;
      if (rows.length === 0) {
        console.log('当前没有后台任务');
        return;
      }
      console.log(`${'任务ID'.padEnd(26)} ${'状态'.padEnd(9)} ${'耗时'.padStart(9)}  退出码`);
      for (const t of rows) {
        console.log(
          `${t.task_id.padEnd(26)} ${t.state.padEnd(9)} ${String(t.duration_ms + 'ms').padStart(9)}  ${t.exit_code ?? '-'}`,
        );
      }
    }),
  );
}

async function cmdTask(taskId: string, opts: Options): Promise<void> {
  if (opts.kill) {
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.TaskKill, { task_id: taskId }, opts.json, (data) => {
        const d = data as { killed: boolean };
        console.log(d.killed ? `✓ 已终止 ${taskId}` : `任务 ${taskId} 已不在运行`);
      }),
    );
    return;
  }
  const offset = opts.offset ? Number(opts.offset) : 0;
  await withClient((c) =>
    callAndPrint(
      c,
      CapabilityNames.TaskGet,
      { task_id: taskId, offset },
      opts.json,
      (data) => {
        const d = data as {
          state: string;
          exit_code: number | null;
          duration_ms: number;
          data: string;
          offset: number;
          total_bytes: number;
        };
        if (d.data) console.log(d.data);
        console.error(
          `[${d.state} · ${d.duration_ms}ms · 已读 ${d.offset}/${d.total_bytes} 字节${d.exit_code !== null && d.state !== 'running' ? ` · 退出码 ${d.exit_code}` : ''}]`,
        );
        if (d.state === 'running' && d.offset < d.total_bytes) {
          console.error('  续读: nodeagent task ' + taskId + ' --offset ' + d.offset);
        }
      },
    ),
  );
}

/**
 * v11 / C5：把一个能力并发下发到多台设备并汇总结果。
 * 每台设备独立连接、互不阻塞（allSettled），任一失败不影响其他。
 */
async function cmdFanout(capability: string, opts: Options): Promise<void> {
  const cfg = getClientConfig();
  const names = (opts.nodes ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const selector = names.length > 0 ? names : Object.keys(cfg.nodes);
  // v12：支持 @组名（组内可嵌套引用其它组）
  const { nodes: targets, resolvedGroups } = resolveNodeSelector(cfg, selector);
  if (targets.length === 0) fail('没有可用的设备，请先 nodeagent connect 或检查分组定义');
  for (const [g, members] of Object.entries(resolvedGroups)) {
    if (members.length === 0) fail(`分组「${g}」为空或不存在（可用: ${Object.keys(cfg.groups ?? {}).join(', ') || '无'}）`);
  }

  let args: Record<string, unknown> = {};
  if (opts.args) {
    try {
      args = JSON.parse(opts.args) as Record<string, unknown>;
    } catch {
      fail('--args 需为合法 JSON，例如 --args {"limit":5}');
    }
  }

  const started = Date.now();
  const results = await Promise.allSettled(
    targets.map(async (n) => {
      const t0 = Date.now();
      const data = await withClient(async (c) => {
        const r = await c.invoke(capability, args, Number(opts.timeoutMs ?? 60_000));
        if (r.status === 'failed') throw new Error(`${r.error?.name}: ${r.error?.message}`);
        return r.data;
      }, n);
      return { node: n, ms: Date.now() - t0, data };
    }),
  );

  if (opts.json) {
    printJson(
      results.map((r, i) =>
        r.status === 'fulfilled'
          ? { node: r.value.node, ok: true, ms: r.value.ms, data: r.value.data }
          : { node: targets[i], ok: false, error: String(r.reason) },
      ),
    );
    return;
  }

  console.log(`并发下发 ${capability} → ${targets.length} 台设备（总耗时 ${Date.now() - started}ms）\n`);
  results.forEach((r, i) => {
    const name = (targets[i] ?? '?').padEnd(16);
    if (r.status === 'fulfilled') {
      const preview = JSON.stringify(r.value.data);
      console.log(`  ✓ ${name} ${String(r.value.ms + 'ms').padStart(7)}  ${preview.slice(0, 150)}`);
    } else {
      console.log(`  ✗ ${name} ${'—'.padStart(7)}  ${String(r.reason).slice(0, 150)}`);
    }
  });
}

async function cmdRecord(opts: Options): Promise<void> {
  const args: Record<string, unknown> = {};
  if (opts.duration) args['duration_ms'] = Number(opts.duration);
  if (opts.fps) args['fps'] = Number(opts.fps);
  if (opts.scale) args['scale'] = Number(opts.scale);
  if (opts.region) {
    const n = opts.region.split(',').map(Number);
    if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) fail('region 格式应为 "x,y,width,height"');
    args['region'] = { x: n[0], y: n[1], width: n[2], height: n[3] };
  }
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ScreenRecord, args, opts.json, (data) => {
      const d = data as { dir: string; frames: number; fps: number; elapsed_ms: number; video_path?: string; frames_only: boolean };
      console.log(`✓ 录制完成：${d.frames} 帧 @ ${d.fps}fps（${d.elapsed_ms}ms）`);
      console.log(`  目录: ${d.dir}`);
      if (d.video_path) console.log(`  视频: ${d.video_path}`);
      else if (d.frames_only) console.log('  提示: 无 ffmpeg，用 `nodeagent pull` 或 `nodeagent ls` 取回帧');
    }),
  );
}

/**
 * v11 / D2：一键部署 / 升级被控端 agent。
 * 流程：被控端自报入口路径（system.info）→ 上传新 agent.mjs → 受控重启 → 复验能力数。
 * 全程无需手工拷文件或起计划任务。
 */
async function cmdDeploy(localFile: string, opts: Options): Promise<void> {
  if (!existsSync(localFile)) fail(`本地文件不存在: ${localFile}`);
  const buf = readFileSync(localFile);
  if (buf.length < 10_000) fail(`文件过小，疑似不是 agent 包: ${localFile}`);

  await withClient(async (c) => {
    const info = await c.invoke<Record<string, unknown>>(CapabilityNames.SystemInfo, {});
    if (info.status === 'failed') fail('无法读取被控端信息');
    const d = info.data as {
      agent_script?: string;
      pid?: number;
      node_path?: string;
      agent_home?: string;
    };
    const target = opts.path ?? d.agent_script;
    if (!target) fail('被控端未上报入口路径，请用 --path <远端路径> 指定');
    console.log(`目标: ${target}（当前 PID ${d.pid ?? '?'}）`);

    // 备份现有文件（便于回滚）
    const backup = `${target}.bak-${Date.now()}`;
    if (d.node_path) {
      const cp = await c.invoke(CapabilityNames.ShellExec, {
        command: `Copy-Item '${target}' '${backup}' -Force -ErrorAction SilentlyContinue; Write-Output 'ok'`,
        timeout_ms: 15_000,
      });
      if (cp.status === 'ok') console.log(`已备份: ${backup}`);
    }

    // 上传（fs.write 分块；由 agent 内部处理，无需本地→远端路径映射）
    const CHUNK = 512 * 1024;
    let offset = 0;
    while (offset < buf.length) {
      const part = buf.subarray(offset, Math.min(offset + CHUNK, buf.length));
      const w = await c.invoke(CapabilityNames.FsWrite, {
        path: target,
        data: part.toString('base64'),
        encoding: 'base64',
        append: offset > 0,
      });
      if (w.status === 'failed') fail(`上传失败于 offset ${offset}: ${w.error?.message}`);
      offset += part.length;
    }
    console.log(`✓ 已上传 ${(buf.length / 1024).toFixed(0)} KB`);

    // 受控重启（复用 v7 能力，无需外部计划任务）
    const r = await c.invoke(CapabilityNames.AgentRestart, { delay_ms: 1500, reason: 'deploy' });
    if (r.status === 'failed') fail(`重启失败: ${r.error?.message}`);
    console.log('✓ 已触发重启，等待恢复…');
  });

  // 等待新版本上线并复验
  await new Promise((t) => setTimeout(t, 9000));
  await withClient(async (c) => {
    const info = await c.invoke<{ capabilities?: unknown[] }>(CapabilityNames.SystemInfo, {});
    const caps = c.listCapabilities();
    console.log(`✓ 新版本已上线：PID ${(info.data as { pid?: number })?.pid ?? '?'}，能力 ${caps.length} 项`);
  });
}

/**
 * v12 / E1+E2：订阅被控端事件并实时接收推送。
 * 与普通命令不同，它需要**保持连接**一段时间（长连接 + 推送），因此不走 withClient 的「用完即关」。
 */
async function cmdEvents(opts: Options): Promise<void> {
  const cfg = getClientConfig();
  let target: ResolvedTarget;
  try {
    target = resolveTarget(cfg, currentNodeOverride);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  // 无 --kind 时列出当前订阅
  if (!opts.kind) {
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.EventList, {}, opts.json, (data) => {
        const d = data as {
          watches: Array<{ watch_id: string; kind: string; description: string; events: number }>;
          buffered: number;
        };
        if (d.watches.length === 0) {
          console.log(`当前没有事件订阅（缓冲 ${d.buffered} 条）`);
          console.log('用法: nodeagent events --kind file --path <路径> [--seconds 20]');
          return;
        }
        console.log(`${'订阅ID'.padEnd(24)} ${'类型'.padEnd(8)} 事件数  说明`);
        for (const w of d.watches) {
          console.log(`${w.watch_id.padEnd(24)} ${w.kind.padEnd(8)} ${String(w.events).padStart(6)}  ${w.description}`);
        }
      }),
    );
    return;
  }

  const seconds = Math.max(1, Math.min(600, Number(opts.seconds ?? 15)));
  const { profile, clientId } = target;
  const keys = profile.auth_mode === 'ed25519' ? loadKeys() : null;
  const received: Array<Record<string, unknown>> = [];

  const client = new NodeAgentClient({
    url: toWsUrl(profile),
    key: profile.key ?? '',
    clientId,
    insecure: profile.insecure,
    authMode: profile.auth_mode,
    privateKey: keys?.privateKey,
    hub: profile.hub ? { token: profile.hub.token, nodeId: profile.hub.node_id } : undefined,
    onEvent: (evt) => {
      received.push(evt);
      const ts = new Date(Number(evt['ts'] ?? Date.now())).toLocaleTimeString('zh-CN');
      const line = `${ts}  ${String(evt['action'] ?? '').padEnd(20)} ${String(evt['target'] ?? '')}${evt['detail'] ? `  (${evt['detail']})` : ''}`;
      if (opts.json) console.log(JSON.stringify(evt));
      else console.log(`  ${line}`);
    },
  });

  try {
    await client.connect();
    const args: Record<string, unknown> = { kind: opts.kind };
    if (opts.path) args['path'] = opts.path;
    if (opts.pattern) args['pattern'] = opts.pattern;
    if (opts.recursive) args['recursive'] = true;
    if (opts.intervalMs) args['interval_ms'] = Number(opts.intervalMs);

    const r = await client.invoke<{ watch_id: string; description: string }>(
      CapabilityNames.EventWatch,
      args,
    );
    if (r.status === 'failed') fail(`${r.error?.name}: ${r.error?.message}`);
    const watchId = (r.data as { watch_id: string }).watch_id;
    if (!opts.json) {
      console.log(`已订阅：${(r.data as { description: string }).description}`);
      console.log(`订阅 ID: ${watchId}    监听 ${seconds}s（Ctrl+C 可提前结束）\n`);
    }

    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, seconds * 1000);
      process.once('SIGINT', () => {
        clearTimeout(t);
        resolve();
      });
    });

    await client.invoke(CapabilityNames.EventUnwatch, { watch_id: watchId });
    if (!opts.json) {
      console.log(`\n共收到 ${received.length} 个事件（订阅已取消）`);
    }
  } catch (err) {
    if (err instanceof ClientError) fail(`${err.name}: ${err.message}`);
    throw err;
  } finally {
    client.close();
  }
}

/**
 * v12 / E4：GUI 宏 —— 把一次成功操作固化为可重放的步骤序列。
 * 子命令：run（回放）/ validate（仅校验文件）/ init（生成示例）
 */
async function cmdMacro(sub: string | undefined, file: string | undefined, opts: Options): Promise<void> {
  if (sub === 'init') {
    const target = file ?? 'macro.json';
    if (existsSync(target)) fail(`文件已存在: ${target}`);
    const sample = {
      name: '示例：在记事本里打字并复制',
      description: '演示 focus / find / type / key / clip / assert 组合；坐标与文本请按实际调整',
      default_delay_ms: 300,
      steps: [
        { action: 'focus', title: 'Notepad', retry: 3, interval_ms: 800 },
        { action: 'key', keys: ['ctrl', 'a'] },
        { action: 'key', keys: ['delete'] },
        { action: 'type', text: '宏回放演示 ${STAMP:-demo}' },
        { action: 'sleep', ms: 300 },
        { action: 'key', keys: ['ctrl', 'a'] },
        { action: 'key', keys: ['ctrl', 'c'] },
        { action: 'clip', expect: '宏回放演示' },
        { action: 'assert', kind: 'window', text: 'Notepad' },
      ],
    };
    writeFileSync(target, JSON.stringify(sample, null, 2) + '\n');
    console.log(`✓ 已生成示例宏: ${target}`);
    console.log('  试用: nodeagent --node=<设备> macro run ' + target + ' --var STAMP=hello');
    return;
  }

  if (!file) fail('用法: nodeagent macro run <文件.json> [--var k=v] / macro validate <文件.json> / macro init [文件.json]');
  if (!existsSync(file)) fail(`宏文件不存在: ${file}`);

  const macro = loadMacroFile(file);

  if (sub === 'validate') {
    const actions = macro.steps.map((s) => String(s['action'] ?? '?'));
    console.log(`✓ 语法有效：${macro.steps.length} 个步骤`);
    console.log(`  名称: ${macro.name ?? '(未命名)'}`);
    console.log(`  步骤: ${actions.join(' → ')}`);
    return;
  }

  // 解析 --var k=v
  const vars: Record<string, string> = {};
  for (const kv of opts.vars ?? []) {
    const i = kv.indexOf('=');
    if (i <= 0) fail(`--var 需为 k=v 形式: ${kv}`);
    vars[kv.slice(0, i)] = kv.slice(i + 1);
  }

  await withClient(async (c) => {
    const outDir = opts.out ?? '.';
    const t0 = Date.now();
    const res = await runMacro(
      {
        client: c,
        saveCapture: opts.out
          ? (name, b64) => {
              const p = join(outDir, name);
              writeFileSync(p, Buffer.from(b64, 'base64'));
              return p;
            }
          : undefined,
        log: (m) => console.error(m),
      },
      macro,
      vars,
    );

    if (opts.json) {
      printJson(res);
      if (!res.ok) process.exitCode = 1;
      return;
    }
    console.log(`宏「${res.name}」共 ${macro.steps.length} 步，耗时 ${Date.now() - t0}ms\n`);
    for (const s of res.steps) {
      const mark = s.ok ? '✓' : '✗';
      console.log(`  ${mark} [${String(s.index).padStart(2)}] ${s.action.padEnd(8)} ${String(s.ms + 'ms').padStart(7)}  ${s.detail ?? ''}`);
    }
    if (res.ok) {
      console.log('\n✓ 全部步骤通过');
    } else {
      console.error(`\n✗ 在第 ${res.failed_at} 步失败，宏已中止`);
      process.exitCode = 1;
    }
  });
}

async function cmdClip(opts: Options): Promise<void> {
  // 图片上传：从本地文件读入（避免超长命令行参数）
  if (opts.imageFile) {
    const p = opts.imageFile;
    if (!existsSync(p)) fail(`文件不存在: ${p}`);
    const b64 = readFileSync(p).toString('base64');
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.ClipSet, { image_base64: b64 }, opts.json, (data) => {
        const d = data as { written_bytes: number };
        console.log(`✓ 图片已写入剪贴板（${d.written_bytes} 字节）`);
      }),
    );
    return;
  }
  if (opts.set !== undefined) {
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.ClipSet, { text: opts.set }, opts.json, (data) => {
        const d = data as { written: number };
        console.log(`✓ 已写入剪贴板 ${d.written} 字符`);
      }),
    );
    return;
  }
  // 图片下载：--out 指定保存路径
  if (opts.out) {
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.ClipGet, { format: 'image' }, opts.json, (data) => {
        const d = data as { image_base64: string; bytes: number; format: string };
        writeFileSync(opts.out!, Buffer.from(d.image_base64, 'base64'));
        console.log(`✓ 剪贴板图片已保存 ${opts.out}（${d.bytes} 字节，${d.format}）`);
      }),
    );
    return;
  }
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ClipGet, { format: opts.format ?? 'auto' }, opts.json, (data) => {
      const d = data as {
        type?: string;
        text?: string;
        bytes?: number;
        image_base64?: string;
      };
      if (d.type === 'image') {
        console.log(`(剪贴板为图片，${d.bytes} 字节；用 --out <路径> 保存)`);
        return;
      }
      if (d.text) console.log(d.text);
      else console.log('(剪贴板为空或非文本)');
    }),
  );
}

async function cmdApps(opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.AppList, {}, opts.json, (data) => {
      const rows = (data as { apps: Array<{ name: string; version: string; publisher: string }> }).apps;
      console.log(`已安装软件（${rows.length}）:`);
      for (const a of rows) console.log(`  ${a.name.padEnd(40)} ${(a.version || '-').padEnd(14)} ${a.publisher}`);
    }),
  );
}

async function cmdInstall(pkg: string, opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.AppInstall, { package: pkg, id: opts.id }, opts.json, (data) => {
      const d = data as { installed: boolean; name: string; version: string; detail: string };
      console.log(d.installed ? `✓ 安装成功: ${d.name} ${d.version}` : `✗ 安装失败: ${d.name}`);
      if (d.detail) console.log(`\n${d.detail}`);
    }),
  );
}

async function cmdInvoke(capability: string, opts: Options): Promise<void> {
  let args: Record<string, unknown> = {};
  if (opts.args) {
    try {
      args = JSON.parse(opts.args) as Record<string, unknown>;
    } catch {
      fail('--args 必须是合法 JSON');
    }
  }
  await withClient(async (c) => {
    const result: InvokeResult = await c.invoke(capability, args);
    printJson(result);
    if (result.status === 'failed') process.exitCode = 2;
  });
}

// ---------- v2 图形操作 ----------

async function cmdScreen(opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ScreenInfo, {}, opts.json, (data) => {
      const rows = (
        data as { displays: Array<{ id: number; name: string; width: number; height: number; is_primary: boolean }> }
      ).displays;
      for (const d of rows) {
        console.log(
          `  #${d.id}  ${String(d.width).padStart(5)}x${String(d.height).padEnd(5)} ${d.is_primary ? '[主屏]' : '      '}  ${d.name}`,
        );
      }
    }),
  );
}

async function cmdScreenshot(opts: Options): Promise<void> {
  const args: Record<string, unknown> = {};
  if (opts.format) args['format'] = opts.format;
  if (opts.scale) args['scale'] = Number(opts.scale);
  if (opts.region) {
    const nums = opts.region.split(',').map(Number);
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) fail('--region 格式应为 x,y,width,height');
    args['region'] = { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
  }
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ScreenCapture, args, opts.json, (data) => {
      const d = data as { image: string; format: string; width: number; height: number; bytes: number };
      const out = opts.out ?? `screenshot.${d.format === 'png' ? 'png' : 'jpg'}`;
      writeFileSync(out, Buffer.from(d.image, 'base64'));
      console.log(`✓ 已保存 ${out}  ${d.width}x${d.height}  ${humanSize(d.bytes)}`);
    }),
  );
}

async function cmdMouse(action: string | undefined, positionals: string[], opts: Options): Promise<void> {
  const [a, b] = positionals;
  switch (action) {
    case 'move': {
      if (!a || !b) fail('用法: nodeagent mouse move <x> <y> [--duration 300]');
      const args: Record<string, unknown> = { x: Number(a), y: Number(b) };
      if (opts.duration) args['duration_ms'] = Number(opts.duration);
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MouseMove, args, opts.json, (d) => {
          const r = d as { x: number; y: number };
          console.log(`✓ 鼠标已移动到 (${r.x}, ${r.y})`);
        }),
      );
      return;
    }
    case 'click': {
      const args: Record<string, unknown> = {};
      if (a && b) {
        args['x'] = Number(a);
        args['y'] = Number(b);
      }
      if (opts.button) args['button'] = opts.button;
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MouseClick, args, opts.json, (d) => {
          const r = d as { x: number; y: number; button: string };
          console.log(`✓ 已${r.button}键点击 (${r.x}, ${r.y})`);
        }),
      );
      return;
    }
    case 'scroll': {
      if (!a) fail('用法: nodeagent mouse scroll <delta> [y]');
      const args: Record<string, unknown> = { delta: Number(a) };
      if (b) args['y'] = Number(b);
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MouseScroll, args, opts.json, (d) => {
          const r = d as { delta: number };
          console.log(`✓ 已滚动 ${r.delta} 格`);
        }),
      );
      return;
    }
    case 'drag': {
      const [x1, y1, x2, y2] = positionals;
      if (!x1 || !y1 || !x2 || !y2) {
        fail('用法: nodeagent mouse drag <x1> <y1> <x2> <y2> [--button left|right|middle]');
      }
      const args: Record<string, unknown> = {
        from_x: Number(x1),
        from_y: Number(y1),
        to_x: Number(x2),
        to_y: Number(y2),
      };
      if (opts.button) args['button'] = opts.button;
      if (opts.duration) args['step_delay_ms'] = Number(opts.duration);
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MouseDrag, args, opts.json, (d) => {
          const r = d as { from: { x: number; y: number }; to: { x: number; y: number }; steps: number };
          console.log(
            `✓ 已拖拽 (${r.from.x}, ${r.from.y}) → (${r.to.x}, ${r.to.y})，${r.steps} 步`,
          );
        }),
      );
      return;
    }
    default:
      fail('用法: nodeagent mouse <move|click|scroll> ...');
  }
}

async function cmdKey(action: string | undefined, positionals: string[], opts: Options): Promise<void> {
  switch (action) {
    case 'type': {
      const text = positionals.join(' ');
      if (!text) fail('用法: nodeagent key type "<文本>"');
      const args: Record<string, unknown> = { text };
      if (opts.interval) args['interval_ms'] = Number(opts.interval);
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.KeyType, args, opts.json, (d) => {
          const r = d as { length: number };
          console.log(`✓ 已输入 ${r.length} 个字符`);
        }),
      );
      return;
    }
    case 'press': {
      if (positionals.length === 0) fail('用法: nodeagent key press <键1> [键2] ...（如 ctrl c）');
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.KeyPress, { keys: positionals }, opts.json, (d) => {
          const r = d as { keys: string[] };
          console.log(`✓ 已按下 ${r.keys.join('+')}`);
        }),
      );
      return;
    }
    default:
      fail('用法: nodeagent key <type|press> ...');
  }
}

// ---------- v3+ 审计 ----------

/** v11：审计链完整性校验。 */
async function cmdAuditVerify(opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.AuditVerify, {}, opts.json, (data) => {
      const d = data as {
        ok: boolean;
        checked: number;
        legacy: number;
        broken_at?: { file: string; line: number; reason: string };
      };
      if (d.ok) {
        console.log(`✓ 审计链完整（校验 ${d.checked} 条${d.legacy ? `，跳过历史条目 ${d.legacy} 条` : ''}）`);
        return;
      }
      console.error(`✗ 审计链已损坏：${d.broken_at?.reason ?? '未知原因'}`);
      if (d.broken_at) console.error(`  位置: ${d.broken_at.file}:${d.broken_at.line}`);
      console.error(`  已校验 ${d.checked} 条`);
      process.exitCode = 1;
    }),
  );
}

async function cmdAudit(opts: Options): Promise<void> {
  const args: Record<string, unknown> = {};
  if (opts.limit) args['limit'] = Number(opts.limit);
  if (opts.since) args['since'] = Number(opts.since);
  if (opts.type) args['type'] = opts.type;
  if (opts.clientId) args['client_id'] = opts.clientId;

  await withClient((c) =>
    callAndPrint(c, CapabilityNames.AuditList, args, opts.json, (data) => {
      const d = data as { entries: Array<Record<string, unknown>>; total: number; file: string };
      console.log(`审计文件: ${d.file}`);
      console.log(`读取 ${d.total} 条，展示最新 ${d.entries.length} 条：\n`);
      for (const e of d.entries) {
        const ts = new Date(Number(e['ts'])).toLocaleString('zh-CN');
        const cols = [
          ts.padEnd(20),
          String(e['type'] ?? '').padEnd(17),
          String(e['client_id'] ?? '-').padEnd(10),
          String(e['capability'] ?? '-').padEnd(20),
          String(e['status'] ?? '-').padEnd(7),
          e['duration_ms'] !== undefined ? `${e['duration_ms']}ms` : '',
          e['error'] ? `err=${e['error']}` : '',
          e['reason'] ? String(e['reason']) : '',
        ];
        console.log('  ' + cols.filter((x) => x !== '').join('  '));
      }
    }),
  );
}

// ---------- v4 局域网发现 ----------

async function cmdDiscover(opts: Options): Promise<void> {
  const waitMs = (opts.wait ? Number(opts.wait) : 5) * 1000;
  const port = opts.discoveryPort ? Number(opts.discoveryPort) : DEFAULT_DISCOVERY_PORT;

  console.log(`正在监听局域网广播（UDP ${port}，最多 ${waitMs / 1000}s）...\n`);

  let nodes: Awaited<ReturnType<typeof discoverOnce>>;
  try {
    nodes = await discoverOnce(waitMs, { port });
  } catch (err) {
    fail(`监听失败：${err instanceof Error ? err.message : String(err)}`);
  }

  if (nodes.length === 0) {
    console.log('未发现设备。请检查：');
    console.log('  1) 被控端与本机在同一局域网（跨网段广播通常不通）');
    console.log('  2) 被控端配置未关闭 discovery.enabled');
    console.log(`  3) 防火墙未拦截 UDP ${port}`);
    return;
  }

  if (opts.json) return printJson(nodes);

  console.log(`发现 ${nodes.length} 台被控端：\n`);
  console.log(`  ${'节点 ID'.padEnd(16)} ${'地址'.padEnd(20)} ${'协议'.padEnd(6)} ${'认证'.padEnd(8)} 平台`);
  for (const n of nodes) {
    const ctl = n.input_enabled ? '  [输入控制已开]' : '';
    console.log(
      `  ${n.node_id.padEnd(16)} ${`${n.host}:${n.port}`.padEnd(20)} ${(n.tls ? 'wss' : 'ws').padEnd(6)} ${n.auth_mode.padEnd(8)} ${n.platform}${ctl}`,
    );
  }
  const first = nodes[0]!;
  console.log('\n连接示例：');
  console.log(`  nodeagent connect ${first.host} --port ${first.port} --key <密钥>${first.tls ? ' --insecure' : ''}`);
}

// ---------- v5 文件传输 ----------

/** 分块大小：1MB（与被控端 max_bytes 默认值配合） */
const CHUNK_BYTES = 1024 * 1024;

async function cmdLs(pathArg: string | undefined, opts: Options): Promise<void> {
  if (!pathArg) fail('用法: nodeagent ls <远端路径> [--recursive] [--pattern "*.log"]');
  const args: Record<string, unknown> = { path: pathArg };
  if (opts.recursive) args['recursive'] = true;
  if (opts.pattern) args['pattern'] = opts.pattern;

  await withClient((c) =>
    callAndPrint(c, CapabilityNames.FsList, args, opts.json, (data) => {
      const d = data as {
        entries: Array<{ name: string; type: string; size: number; mtime: number }>;
        total: number;
        truncated: boolean;
      };
      for (const e of d.entries) {
        const icon = e.type === 'dir' ? '📁' : '📄';
        const when = new Date(e.mtime).toLocaleString('zh-CN');
        console.log(`  ${icon} ${e.name.padEnd(34)} ${humanSize(e.size).padStart(10)}  ${when}`);
      }
      console.log(`\n共 ${d.total} 项${d.truncated ? '（已截断，可加 --pattern 过滤）' : ''}`);
    }),
  );
}

async function cmdStat(pathArg: string | undefined, opts: Options): Promise<void> {
  if (!pathArg) fail('用法: nodeagent stat <远端路径>');
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.FsStat, { path: pathArg }, opts.json, (data) => {
      const d = data as { path: string; type: string; size: number; mtime: number; exists: boolean };
      if (!d.exists) {
        console.log(`✗ 不存在: ${d.path}`);
        return;
      }
      console.log(`  路径 : ${d.path}`);
      console.log(`  类型 : ${d.type}`);
      console.log(`  大小 : ${humanSize(d.size)}`);
      console.log(`  修改 : ${new Date(d.mtime).toLocaleString('zh-CN')}`);
    }),
  );
}

async function cmdCat(pathArg: string | undefined, opts: Options): Promise<void> {
  if (!pathArg) fail('用法: nodeagent cat <远端路径> [--out 本地文件]');
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.FsRead, { path: pathArg, encoding: 'utf8' }, opts.json, (data) => {
      const d = data as { data: string; bytes: number; total_bytes: number; eof: boolean };
      if (opts.out) {
        writeFileSync(opts.out, d.data, 'utf8');
        console.log(`✓ 已保存 ${opts.out}（${d.bytes} 字节${d.eof ? '' : '，文件较大仅首块，请用 pull 下载完整文件'}）`);
        return;
      }
      process.stdout.write(d.data);
      if (!d.eof) console.log(`\n\n… 仅显示首 ${humanSize(d.bytes)}（共 ${humanSize(d.total_bytes)}），完整下载请用 pull`);
    }),
  );
}

async function cmdPull(remote: string | undefined, opts: Options): Promise<void> {
  if (!remote) fail('用法: nodeagent pull <远端路径> [--out 本地文件]');
  const local = opts.out ?? remote.split(/[\\/]/).pop() ?? 'download.bin';

  await withClient(async (c) => {
    const statRes = await c.invoke(CapabilityNames.FsStat, { path: remote });
    if (statRes.status !== 'ok') fail(`读取远端信息失败: ${statRes.error?.message}`);
    const st = statRes.data as { exists: boolean; type: string; size: number };
    if (!st.exists) fail(`远端文件不存在: ${remote}`);
    if (st.type === 'dir') fail(`目标是目录，不是文件: ${remote}（先用 ls 查看）`);

    const tmp = `${local}.nodeagent-part`;
    const fd = openSync(tmp, 'w');
    let offset = 0;
    try {
      for (;;) {
        const r = await c.invoke(CapabilityNames.FsRead, {
          path: remote,
          encoding: 'base64',
          offset,
          max_bytes: CHUNK_BYTES,
        });
        if (r.status !== 'ok') fail(`下载失败: ${r.error?.name}: ${r.error?.message}`);
        const d = r.data as { data: string; bytes: number; eof: boolean };
        if (d.bytes > 0) writeSync(fd, Buffer.from(d.data, 'base64'));
        offset += d.bytes;
        if (d.eof || d.bytes === 0) break;
      }
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, local); // 原子落盘，避免半截文件
    console.log(`✓ 已下载 ${remote} → ${local}（${humanSize(offset)}）`);
  });
}

async function cmdPush(local: string | undefined, remote: string | undefined, opts: Options): Promise<void> {
  if (!local || !remote) fail('用法: nodeagent push <本地文件> <远端路径> [--create-dirs]');
  let st;
  try {
    st = statSync(local);
  } catch {
    fail(`本地文件不存在: ${local}`);
  }
  if (!st.isFile()) fail(`不是文件: ${local}`);

  await withClient(async (c) => {
    const fd = openSync(local, 'r');
    let offset = 0;
    let first = true;
    try {
      while (offset < st.size) {
        const len = Math.min(CHUNK_BYTES, st.size - offset);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, offset);
        const r = await c.invoke(CapabilityNames.FsWrite, {
          path: remote,
          data: buf.toString('base64'),
          encoding: 'base64',
          append: !first,
          create_dirs: first && opts.createDirs === true,
        });
        if (r.status !== 'ok') fail(`上传失败: ${r.error?.name}: ${r.error?.message}`);
        offset += len;
        first = false;
      }
      if (st.size === 0) {
        const r = await c.invoke(CapabilityNames.FsWrite, {
          path: remote,
          data: '',
          create_dirs: opts.createDirs === true,
        });
        if (r.status !== 'ok') fail(`上传失败: ${r.error?.message}`);
      }
    } finally {
      closeSync(fd);
    }
    console.log(`✓ 已上传 ${local} → ${remote}（${humanSize(offset)}）`);
  });
}

function parseOptions(rest: string[]): { opts: Options; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      json: { type: 'boolean', default: false },
      insecure: { type: 'boolean', default: false },
      port: { type: 'string' },
      key: { type: 'string' },
      id: { type: 'string' },
      limit: { type: 'string' },
      args: { type: 'string' },
      config: { type: 'boolean', default: false },
      // v2 图形操作
      out: { type: 'string' },
      format: { type: 'string' },
      scale: { type: 'string' },
      region: { type: 'string' },
      button: { type: 'string' },
      duration: { type: 'string' },
      interval: { type: 'string' },
      'auth-mode': { type: 'string' },
      since: { type: 'string' },
      type: { type: 'string' },
      'client-id': { type: 'string' },
      wait: { type: 'string' },
      'discovery-port': { type: 'string' },
      node: { type: 'string' },
      name: { type: 'string' },
      note: { type: 'string' },
      recursive: { type: 'boolean', default: false },
      pattern: { type: 'string' },
      'create-dirs': { type: 'boolean', default: false },
      'hub-token': { type: 'string' },
      'hub-node': { type: 'string' },
      // v7 受控重启
      delay: { type: 'string' },
      // v10 后台任务 / 剪贴板
      'timeout-ms': { type: 'string' },
      kill: { type: 'boolean', default: false },
      offset: { type: 'string' },
      set: { type: 'string' },
      'image-file': { type: 'string' },
      fps: { type: 'string' },
      nodes: { type: 'string' },
      path: { type: 'string' },
      kind: { type: 'string' },
      var: { type: 'string', multiple: true },
      seconds: { type: 'string' },
      'interval-ms': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });
  return {
    opts: {
      json: Boolean(values['json']),
      insecure: Boolean(values['insecure']),
      port: values['port'] as string | undefined,
      key: values['key'] as string | undefined,
      id: values['id'] as string | undefined,
      limit: values['limit'] as string | undefined,
      args: values['args'] as string | undefined,
      out: values['out'] as string | undefined,
      format: values['format'] as string | undefined,
      scale: values['scale'] as string | undefined,
      region: values['region'] as string | undefined,
      button: values['button'] as string | undefined,
      duration: values['duration'] as string | undefined,
      interval: values['interval'] as string | undefined,
      authMode: values['auth-mode'] as string | undefined,
      since: values['since'] as string | undefined,
      type: values['type'] as string | undefined,
      clientId: values['client-id'] as string | undefined,
      wait: values['wait'] as string | undefined,
      discoveryPort: values['discovery-port'] as string | undefined,
      node: values['node'] as string | undefined,
      delay: values['delay'] as string | undefined,
      timeoutMs: values['timeout-ms'] as string | undefined,
      kill: Boolean(values['kill']),
      offset: values['offset'] as string | undefined,
      set: values['set'] as string | undefined,
      imageFile: values['image-file'] as string | undefined,
      fps: values['fps'] as string | undefined,
      nodes: values['nodes'] as string | undefined,
      path: values['path'] as string | undefined,
      kind: values['kind'] as string | undefined,
      vars: (values['var'] as string[] | undefined) ?? [],
      seconds: values['seconds'] as string | undefined,
      intervalMs: values['interval-ms'] as string | undefined,
      name: values['name'] as string | undefined,
      note: values['note'] as string | undefined,
      recursive: Boolean(values['recursive']),
      pattern: values['pattern'] as string | undefined,
      createDirs: Boolean(values['create-dirs']),
      hubToken: values['hub-token'] as string | undefined,
      hubNode: values['hub-node'] as string | undefined,
    },
    positionals,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // 命令 = 第一个非选项 token，故全局选项可前置（--node=win_b info）
  const cmdIdx = argv.findIndex((a) => !a.startsWith('-'));
  const command = cmdIdx >= 0 ? argv[cmdIdx] : undefined;
  const rest = cmdIdx >= 0 ? [...argv.slice(0, cmdIdx), ...argv.slice(cmdIdx + 1)] : argv;
  const { opts, positionals } = parseOptions(rest);
  currentNodeOverride = opts.node; // 全局 --node 生效于本次命令

  if (rest.includes('--config')) {
    console.log(configPath());
    return;
  }

  switch (command) {
    case 'connect': {
      const host = positionals[0];
      if (!host) fail('用法: nodeagent connect <host> --port 8765 --key <密钥>');
      await cmdConnect(host, opts);
      return;
    }
    case 'list':
      await cmdList(opts);
      return;
    case 'info':
      await cmdInfo(opts);
      return;
    case 'status':
      await cmdStatus(opts);
      return;
    case 'ps':
      await cmdPs(opts);
      return;
    case 'services':
      await cmdServices(opts);
      return;
    case 'exec': {
      const cmd = positionals.join(' ');
      if (!cmd) fail('用法: nodeagent exec "<命令>"');
      await cmdExec(cmd, opts);
      return;
    }
    case 'apps':
      await cmdApps(opts);
      return;
    case 'restart':
      await cmdRestart(opts);
      return;
    case 'bg': {
      const cmd = positionals.join(' ');
      if (!cmd) fail('用法: nodeagent bg "<命令>" [--timeout-ms 300000]');
      await cmdBg(cmd, opts);
      return;
    }
    case 'tasks':
      await cmdTasks(opts);
      return;
    case 'task': {
      const id = positionals[0];
      if (!id) fail('用法: nodeagent task <task_id> [--offset N] [--kill]');
      await cmdTask(id, opts);
      return;
    }
    case 'daemon': {
      // start | stop | status（无参默认 status）
      const sub = positionals[0] ?? 'status';
      if (sub === 'start') {
        // 找 nodeagentd：优先 PATH 上的同名二进制（esbuild 单文件模式下与 CLI 同目录）
        const { spawn: spawnDetached } = await import('node:child_process');
        const binDir = path.dirname(process.argv[1] ?? 'nodeagent');
        const candidates = [path.join(binDir, 'nodeagentd'), 'nodeagentd'];
        let entry = '';
        for (const c of candidates) {
          if (existsSync(c)) {
            entry = c;
            break;
          }
        }
        if (!entry) {
          // 兜底：dev 模式 dist/daemon.js
          const devEntry = path.join(binDir, 'daemon.js');
          if (existsSync(devEntry)) entry = devEntry;
        }
        if (!entry) {
          fail('未找到 nodeagentd（请运行: bash scripts/install-macos.sh）');
        }
        const child = spawnDetached(process.execPath, [entry], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        });
        child.unref();
        await new Promise((r) => setTimeout(r, 800));
        console.log(existsSync(DAEMON_SOCK) ? `✓ nodeagentd 已启动（${DAEMON_SOCK}）` : '✗ daemon 未能启动');
        return;
      }
      if (sub === 'stop') {
        if (!existsSync(DAEMON_SOCK)) {
          console.log('daemon 未在运行');
          return;
        }
        const { spawn: sp } = await import('node:child_process');
        sp('pkill', ['-f', 'nodeagentd.sock'], { stdio: 'ignore' });
        await new Promise((r) => setTimeout(r, 500));
        try {
          fsSync.unlinkSync(DAEMON_SOCK);
        } catch {
          /* ignore */
        }
        console.log('✓ nodeagentd 已停止');
        return;
      }
      // status
      if (!existsSync(DAEMON_SOCK)) {
        console.log('daemon: 未运行（启动: nodeagent daemon start）');
      } else {
        console.log(`daemon: 运行中（${DAEMON_SOCK}）`);
      }
      return;
    }
    case 'clip':
      await cmdClip(opts);
      return;
    case 'record':
      await cmdRecord(opts);
      return;
    case 'events':
      await cmdEvents(opts);
      return;
    case 'macro': {
      const sub = positionals[0];
      await cmdMacro(sub, positionals[1], opts);
      return;
    }
    case 'group': {
      const sub = positionals[0];
      const cfg = getClientConfig();
      if (sub === 'add') {
        const name = positionals[1];
        const members = positionals.slice(2).join(',').split(',').map((x) => x.trim()).filter(Boolean);
        if (!name || members.length === 0) fail('用法: nodeagent group add <组名> <设备1,设备2,...>');
        for (const m of members) {
          if (!m.startsWith('@') && !cfg.nodes[m]) fail(`设备不存在: ${m}（先 nodeagent connect 添加，或写 @另一组名）`);
        }
        cfg.groups = { ...(cfg.groups ?? {}), [name]: members };
        saveConfig(cfg);
        console.log(`✓ 分组「${name}」已保存：${members.join(', ')}`);
        return;
      }
      if (sub === 'remove' || sub === 'rm') {
        const name = positionals[1];
        if (!name) fail('用法: nodeagent group remove <组名>');
        if (!cfg.groups?.[name]) fail(`分组不存在: ${name}`);
        delete cfg.groups[name];
        saveConfig(cfg);
        console.log(`✓ 已删除分组「${name}」`);
        return;
      }
      // 默认：列出分组
      const groups = cfg.groups ?? {};
      const names2 = Object.keys(groups);
      if (names2.length === 0) {
        console.log('尚未定义设备分组');
        console.log('用法: nodeagent group add <组名> <设备1,设备2,...>   （成员可写 @其它组名）');
        return;
      }
      for (const g of names2) {
        const { nodes } = resolveNodeSelector(cfg, [`@${g}`]);
        console.log(`  @${g.padEnd(14)} → ${nodes.join(', ')}   （${nodes.length} 台）`);
      }
      return;
    }
    case 'fanout': {
      const cap = positionals[0];
      if (!cap) fail('用法: nodeagent fanout <能力名> [--nodes a,b] [--args JSON]');
      await cmdFanout(cap, opts);
      return;
    }
    case 'deploy': {
      const f = positionals[0];
      if (!f) fail('用法: nodeagent deploy <agent.mjs 路径> [--path <远端路径>]');
      await cmdDeploy(f, opts);
      return;
    }
    case 'install': {
      const pkg = positionals[0];
      if (!pkg) fail('用法: nodeagent install <包名|ID>');
      await cmdInstall(pkg, opts);
      return;
    }
    case 'invoke': {
      const cap = positionals[0];
      if (!cap) fail('用法: nodeagent invoke <capability> [--args \'<json>\']');
      await cmdInvoke(cap, opts);
      return;
    }
    case 'keygen':
      await cmdKeygen(opts);
      return;
    case 'nodes':
      await cmdNodes(opts);
      return;
    case 'use':
      await cmdUse(positionals[0], opts);
      return;
    case 'remove':
      await cmdRemove(positionals[0], opts);
      return;
    case 'audit':
      if (positionals[0] === 'verify') await cmdAuditVerify(opts);
      else await cmdAudit(opts);
      return;
    case 'discover':
      await cmdDiscover(opts);
      return;
    case 'ls':
      await cmdLs(positionals[0], opts);
      return;
    case 'stat':
      await cmdStat(positionals[0], opts);
      return;
    case 'cat':
      await cmdCat(positionals[0], opts);
      return;
    case 'pull':
      await cmdPull(positionals[0], opts);
      return;
    case 'push':
      await cmdPush(positionals[0], positionals[1], opts);
      return;
    case 'screen':
      await cmdScreen(opts);
      return;
    case 'screenshot':
      await cmdScreenshot(opts);
      return;
    case 'mouse': {
      const [action, ...rest2] = positionals;
      await cmdMouse(action, rest2, opts);
      return;
    }
    case 'key': {
      const [action, ...rest2] = positionals;
      await cmdKey(action, rest2, opts);
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      fail(`未知命令: ${command}\n\n${HELP}`);
  }
}

main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
