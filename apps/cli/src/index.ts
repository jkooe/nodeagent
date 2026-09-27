import { writeFileSync } from 'node:fs';
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
  type ClientConfig,
} from '@nodeagent/client';
import { CapabilityNames, matchPattern, type CapabilityDescriptor, type InvokeResult } from '@nodeagent/protocol';

const HELP = `nodeagent —— 跨机 AI 接管框架（控制端 CLI）

用法:
  nodeagent connect <host> [--port 8765] [--key <key>] [--insecure] [--id mac_01] [--auth-mode ed25519]
      配置并连接被控端（握手成功后打印能力清单）

  nodeagent keygen [--id mac_01]      生成 Ed25519 密钥对并输出被控端 ACL 配置片段 (v3 零信任)

  nodeagent info                      查看系统信息 (system.info)
  nodeagent status                    查看资源状态 (system.status)
  nodeagent ps [--limit 20]           查看进程 (system.process.list)
  nodeagent services [--limit 20]     查看服务 (system.service.list)
  nodeagent exec "<命令>"              执行命令 (system.shell.exec)
  nodeagent apps                      列出已安装软件 (app.list)
  nodeagent install <包名|ID>          安装软件 (app.install)
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
}

function getClientConfig(): ClientConfig {
  const cfg = loadConfig();
  if (!cfg) {
    fail('尚未配置被控端。请先运行:\n  nodeagent connect <host> --port 8765 --key <密钥>');
  }
  return cfg;
}

async function withClient<T>(fn: (client: NodeAgentClient) => Promise<T>): Promise<T> {
  const cfg = getClientConfig();
  const keys = cfg.auth_mode === 'ed25519' ? loadKeys() : null;
  const client = new NodeAgentClient({
    url: toWsUrl(cfg),
    key: cfg.key,
    clientId: cfg.client_id,
    insecure: cfg.insecure,
    authMode: cfg.auth_mode,
    privateKey: keys?.privateKey,
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

  const cfg: ClientConfig = {
    client_id: opts.id ?? 'mac_01',
    host,
    port,
    tls: !process.argv.includes('--no-tls'),
    insecure: opts.insecure,
    key: opts.key ?? '',
    auth_mode: authMode,
  };

  const keys = authMode === 'ed25519' ? loadKeys() : null;
  if (authMode === 'ed25519' && !keys) {
    fail(`零信任模式需要本机密钥，请先运行: nodeagent keygen --id ${cfg.client_id}`);
  }

  const client = new NodeAgentClient({
    url: toWsUrl(cfg),
    key: cfg.key,
    clientId: cfg.client_id,
    insecure: cfg.insecure,
    authMode,
    privateKey: keys?.privateKey,
  });
  try {
    const caps = await client.connect();
    const authorized = client.listAuthorized();
    saveConfig(cfg);
    console.log(
      `✓ 已连接 ${cfg.host}:${cfg.port}（${cfg.tls ? 'wss' : 'ws'}，${authMode}），配置已保存到 ${configPath()}`,
    );
    const isOk = (name: string): boolean => !authorized || authorized.some((p) => matchPattern(p, name));
    console.log(
      `\n被控端声明 ${caps.length} 项能力${authorized ? `，其中 ${authorized.length} 项已授权` : ''}:`,
    );
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
      if (d.stdout) console.log(d.stdout);
      if (d.stderr) console.error(d.stderr);
      console.log(`\n[退出码 ${d.exit_code} · ${d.duration_ms}ms${d.truncated ? ' · 输出已截断' : ''}]`);
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
    },
    positionals,
  };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { opts, positionals } = parseOptions(rest);

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
