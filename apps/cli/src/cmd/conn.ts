import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path, { join } from 'node:path';
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
  DEFAULT_DISCOVERY_PORT,
  generateSharedKey,
  matchPattern,
  type CapabilityDescriptor,
  type InvokeResult,
} from '@nodeagent/protocol';
import {
  callAndPrint,
  reportCompat,
  fail,
  getClientConfig,
  humanSize,
  printJson,
  riskIcon,
  withClient,
  withClientDirect,
} from '../core.js';
import { CHUNK_BYTES, type Options } from '../types.js';

// CLI 命令组：cmd/conn.ts
export async function cmdConnect(host: string, opts: Options): Promise<void> {
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
    // v21：TOFU 钉住证书指纹 —— 首次连接记录，之后每次连接都严格比对。
    // 已有钉住值时**不覆盖**（除非 --forget-cert），否则冒充者可借重连刷新钉住值。
    const fp = client.getPeerCertFingerprint();
    if (opts.forgetCert === true) {
      delete profile.cert_sha256;
      console.log('已清除旧指纹，将按本次连接重新钉住');
    }
    if (fp && !profile.cert_sha256) {
      profile.cert_sha256 = fp;
      console.log(`\n🔐 已钉住被控端证书指纹（TOFU）：${fp}`);
      console.log('   请与被控端安装时打印的指纹核对；不一致说明连的可能不是那台机器');
    }

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

export async function cmdNodes(opts: Options): Promise<void> {
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

export async function cmdUse(name: string | undefined, opts: Options): Promise<void> {
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

export async function cmdRemove(name: string | undefined, opts: Options): Promise<void> {
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

export async function cmdKeygen(opts: Options): Promise<void> {
  const clientId = opts.id ?? 'mac_01';

  // v22：`--psk` 生成**每客户端专属**的预共享密钥（配合被控端 agent.json 的 keys{}）。
  // 与 ed25519 的区别：这是「对称」方案 —— 实现简单、不用管公钥，但同样是**一把一个身份**
  // （知道 A 的 key 就冒充不了 B），适合不方便管理公钥的场景。
  if (opts.psk === true) {
    const psk = generateSharedKey();
    console.log('✓ 已生成该 client_id 的专属预共享密钥（psk 模式）');
    console.log(`  client_id : ${clientId}`);
    console.log(`  密钥      : ${psk}`);
    console.log('\n请把下面这段加入被控端 agent.json（可与其它 client_id 并列）：\n');
    console.log(
      JSON.stringify(
        { keys: { [clientId]: psk } },
        null,
        2,
      ),
    );
    console.log('\n然后控制端这样连（key 即上面的密钥）：');
    console.log(`  nodeagent connect <被控端IP> --port 8765 --key ${psk} --id ${clientId} --insecure`);
    console.log(
      '\n提示：登记了 keys{} 之后，未登记的 client_id 会回落到共享 key（若被控端仍配有 key）。',
    );
    return;
  }

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

export async function cmdDiscover(opts: Options): Promise<void> {
  const waitMs = (opts.wait ? Number(opts.wait) : 5) * 1000;
  const port = opts.discoveryPort ? Number(opts.discoveryPort) : DEFAULT_DISCOVERY_PORT;

  console.log(`正在监听局域网广播（UDP ${port}，最多 ${waitMs / 1000}s）...\n`);

  let nodes: Awaited<ReturnType<typeof discoverOnce>>;
  try {
    nodes = await discoverOnce(waitMs, { port, secret: opts.discoverSecret });
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
  console.log(
    `  ${'节点 ID'.padEnd(16)} ${'地址'.padEnd(20)} ${'协议'.padEnd(6)} ${'认证'.padEnd(8)} ${'来源'.padEnd(10)} 平台`,
  );
  for (const n of nodes) {
    const ctl = n.input_enabled ? '  [输入控制已开]' : '';
    // v22：广播本身是未认证的，只有验签通过的才标 🔒
    const trust = n.authenticated ? '🔒 已认证' : '⚠️ 明文';
    console.log(
      `  ${n.node_id.padEnd(16)} ${`${n.host}:${n.port}`.padEnd(20)} ${(n.tls ? 'wss' : 'ws').padEnd(6)} ${n.auth_mode.padEnd(8)} ${trust.padEnd(10)} ${n.platform}${ctl}`,
    );
  }
  if (nodes.some((n) => !n.authenticated) && !opts.discoverSecret) {
    console.log(
      '\n  ℹ️ 标「⚠️ 明文」的条目：广播可被同网段任意伪造，其地址/认证方式仅作参考。' +
        '\n     要可信发现，请给被控端 discovery.secret，并在此用 --discover-secret <同一密钥>。',
    );
  }
  const first = nodes[0]!;
  console.log('\n连接示例：');
  console.log(`  nodeagent connect ${first.host} --port ${first.port} --key <密钥>${first.tls ? ' --insecure' : ''}`);
}

// ---------- v5 文件传输 ----------

/** 分块大小：1MB（与被控端 max_bytes 默认值配合） */
