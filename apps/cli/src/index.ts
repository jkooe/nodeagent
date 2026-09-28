import { closeSync, openSync, readSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  NodeAgentClient,
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
  nodeagent list                      列出被控端可用能力
  nodeagent invoke <capability> [--args '<json>']   通用调用

图形操作 (v2，输入控制需被控端开启 allow_input):
  nodeagent screen                    显示器信息 (screen.info)
  nodeagent screenshot [--out f.jpg] [--scale 0.5] [--region x,y,w,h] [--format jpeg]
                                      截屏并保存 (screen.capture)
  nodeagent mouse move <x> <y> [--duration 300]
  nodeagent mouse click [<x> <y>] [--button left|right|middle]
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

async function withClient<T>(fn: (client: NodeAgentClient) => Promise<T>, nodeName?: string): Promise<T> {
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
      await cmdAudit(opts);
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
