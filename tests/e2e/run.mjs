/**
 * nodeagent 端到端测试
 *
 * 在 Mac 上启动一个被控端 Agent（临时配置、独立 HOME），
 * 用控制端客户端跑通：握手 → 能力调用 → 异常路径。
 *
 * 运行：node tests/e2e/run.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { NodeAgentClient, runMacro } from '../../packages/client/dist/index.js';
import { generateKeyPair, findCapability } from '../../packages/protocol/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');

const PORT = 18765;
const TLS_PORT = 18772;
const ED25519_PORT = 18781;
const DISCOVERY_PORT = 18796;
const DISCOVERY_AGENT_PORT = 18797;
const RECONNECT_PORT = 18798;
const RECONNECT_KEY = 'reconnect-key-0123456789abcdef0123456789';
const FS_PORT = 18799;
const FS_KEY = 'fs-key-0123456789abcdef0123456789abcdef';
const HUB_PORT = 18800;
const HUB_AGENT_PORT = 18801;
const HUB_TOKEN = 'hub-e2e-token-0123456789abcdef';
const HUB_AGENT_KEY = 'hub-agent-key-0123456789abcdef0123';
const KEY = 'e2e-test-key-0123456789abcdef0123456789abcdef';
const URL = `ws://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
}

/** 启动被控端 Agent（独立 HOME，避免污染真实配置）。 */
function startAgent() {
  // NODEAGENT_HOME 直接作为数据目录（等价于 ~/.nodeagent）
  const dataDir = mkdtempSync(join(tmpdir(), 'nodeagent-e2e-'));
  writeFileSync(
    join(dataDir, 'agent.json'),
    JSON.stringify({
      node_id: 'e2e_win',
      host: '127.0.0.1',
      port: PORT,
      tls: false,
      key: KEY,
      log_level: 'info',
    }),
  );
  const child = spawn(process.execPath, [join(root, 'apps/agent/dist/index.js')], {
    // NODEAGENT_HOME 为准（跨平台一致）；HOME/USERPROFILE 兜底
    // 注：Windows 的 os.homedir() 认 USERPROFILE 不认 HOME，漏设会导致被控端回落到默认端口
    env: { ...process.env, NODEAGENT_HOME: dataDir, HOME: dataDir, USERPROFILE: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 完整转发被控端输出，便于定位启动问题
  child.stdout.on('data', (d) => process.stdout.write(`[agent] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[agent:err] ${d}`));
  child.on('error', (err) => console.error(`\n⚠️  [agent spawn 失败] ${err.message}\n`));
  child.on('exit', (code, signal) => {
    console.log(`\n⚠️  [agent 进程退出] code=${code} signal=${signal}\n`);
  });
  return child;
}

/** 等待被控端可连接（重试）；被控端若提前退出则立即失败。 */
async function waitReady(timeoutMs = 30_000, child = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`被控端进程已退出 (code=${child.exitCode})，请查看上方 agent 输出`);
    }
    try {
      const c = new NodeAgentClient({ url: URL, key: KEY, clientId: 'probe' });
      await c.connect();
      c.close();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('被控端未在超时内就绪');
}

async function connect(key = KEY) {
  const c = new NodeAgentClient({ url: URL, key, clientId: 'e2e_mac' });
  await c.connect();
  return c;
}

/** TLS 场景：被控端以 wss 启动，控制端以自签证书 + insecure 连接。 */
async function testTlsMode() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nodeagent-tls-'));
  writeFileSync(
    join(dataDir, 'agent.json'),
    JSON.stringify({ node_id: 'tls_probe', host: '127.0.0.1', port: TLS_PORT, tls: true, key: KEY, log_level: 'info' }),
  );
  const child = spawn(process.execPath, [join(root, 'apps/agent/dist/index.js')], {
    env: { ...process.env, NODEAGENT_HOME: dataDir, HOME: dataDir, USERPROFILE: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[tls-agent] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[tls-agent:err] ${d}`));

  const url = `wss://127.0.0.1:${TLS_PORT}`;
  try {
    const deadline = Date.now() + 25_000;
    let lastErr = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`TLS 被控端已退出 (code=${child.exitCode})`);
      try {
        const c = new NodeAgentClient({ url, key: KEY, clientId: 'tls_probe', insecure: true });
        await c.connect();
        const r = await c.invoke('system.info');
        c.close();
        assert.equal(r.status, 'ok', 'TLS 模式下 system.info 应成功');
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw new Error(`TLS 模式下无法连接 ${url}：${lastErr?.message ?? '未知错误'}`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** v3 零信任场景：Ed25519 身份认证 + 能力级 ACL。 */
async function testEd25519Acl() {
  const kp = generateKeyPair();
  const other = generateKeyPair();

  const dataDir = mkdtempSync(join(tmpdir(), 'nodeagent-ed-'));
  writeFileSync(
    join(dataDir, 'agent.json'),
    JSON.stringify({
      node_id: 'ed_test',
      host: '127.0.0.1',
      port: ED25519_PORT,
      tls: false,
      key: '',
      log_level: 'warn',
      auth_mode: 'ed25519',
      audit: { enabled: true, log_args: true },
      acl: {
        default_effect: 'deny',
        clients: [
          {
            client_id: 'ed_client',
            pubkey: kp.publicKey,
            allow: ['system.info', 'system.audit.list'],
            deny: [],
          },
          {
            // 用于验证限速：每分钟仅 2 次
            client_id: 'limited',
            pubkey: kp.publicKey,
            allow: ['system.info'],
            max_calls_per_min: 2,
          },
        ],
      },
    }),
  );

  const child = spawn(process.execPath, [join(root, 'apps/agent/dist/index.js')], {
    env: { ...process.env, NODEAGENT_HOME: dataDir, HOME: dataDir, USERPROFILE: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[ed-agent] ${d}`));
  child.on('exit', (code) => console.log(`\n⚠️  [ed-agent 退出] code=${code}\n`));

  const url = `ws://127.0.0.1:${ED25519_PORT}`;
  const mk = (clientId, privateKey) =>
    new NodeAgentClient({ url, key: '', clientId, authMode: 'ed25519', privateKey });

  try {
    // 等待就绪（用合法身份探测）
    const deadline = Date.now() + 25_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`ed25519 被控端已退出 (code=${child.exitCode})`);
      try {
        const probe = mk('ed_client', kp.privateKey);
        await probe.connect();
        probe.close();
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (!ready) throw new Error('ed25519 被控端未就绪');

    // 1. 合法身份：握手成功，且只授权 system.info / system.audit.list
    const c = mk('ed_client', kp.privateKey);
    const caps = await c.connect();
    assert.ok(caps.length >= 15, `能力清单应完整返回，实际 ${caps.length}`);
    assert.deepEqual(c.listAuthorized(), ['system.info', 'system.audit.list'], '授权清单应与 ACL 一致');
    const allowed = await c.invoke('system.info');
    assert.equal(allowed.status, 'ok', '已授权能力应可调用');

    // 2. 未授权能力 → E_ACL_DENIED
    await assert.rejects(
      () => c.invoke('system.shell.exec'),
      (e) => {
        assert.equal(e.code, -32406, `期望 -32406，实际 ${e.code}`);
        return true;
      },
    );

    // 3. 审计：前述调用应被记录，且 ACL 拒绝也在册
    const auditRes = await c.invoke('system.audit.list', { limit: 50 });
    assert.equal(auditRes.status, 'ok', '审计查询应可用');
    const entries = auditRes.data.entries;
    assert.ok(entries.some((e) => e.type === 'auth.success'), '应记录 auth.success');
    assert.ok(
      entries.some((e) => e.type === 'invoke' && e.capability === 'system.info' && e.status === 'ok'),
      '应记录成功的 invoke',
    );
    assert.ok(entries.some((e) => e.type === 'acl.denied' && e.capability === 'system.shell.exec'), '应记录 ACL 拒绝');
    // 脱敏：log_args 开启时记录预览，且敏感键被替换
    const withPreview = entries.find((e) => e.args_preview);
    assert.ok(withPreview, '开启 log_args 后应有参数预览');
    c.close();

    // 4. 限速：limited 配额 2/分钟，第 3 次应被拒
    const lim = mk('limited', kp.privateKey);
    await lim.connect();
    const r1 = await lim.invoke('system.info');
    const r2 = await lim.invoke('system.info');
    assert.equal(r1.status, 'ok');
    assert.equal(r2.status, 'ok');
    await assert.rejects(
      () => lim.invoke('system.info'),
      (e) => {
        assert.equal(e.code, -32407, `期望 -32407（限速），实际 ${e.code}`);
        return true;
      },
    );
    lim.close();

    // 5. 未注册的调用方 → 握手失败
    await assert.rejects(
      () => mk('ghost', kp.privateKey).connect(),
      (e) => {
        assert.equal(e.code, -32401, `期望 -32401，实际 ${e.code}`);
        return true;
      },
    );

    // 6. 私钥与登记公钥不匹配（验签失败）→ 握手失败
    await assert.rejects(
      () => mk('ed_client', other.privateKey).connect(),
      (e) => {
        assert.equal(e.code, -32401, `期望 -32401，实际 ${e.code}`);
        return true;
      },
    );
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** v4 场景：局域网自动发现（UDP 广播）。 */
async function testDiscovery() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nodeagent-disco-'));
  writeFileSync(
    join(dataDir, 'agent.json'),
    JSON.stringify({
      node_id: 'disco_node',
      host: '127.0.0.1',
      port: DISCOVERY_AGENT_PORT,
      tls: false,
      key: 'discokey',
      log_level: 'warn',
      discovery: { enabled: true, broadcast: '127.0.0.1', port: DISCOVERY_PORT, interval_ms: 800 },
    }),
  );
  const child = spawn(process.execPath, [join(root, 'apps/agent/dist/index.js')], {
    env: { ...process.env, NODEAGENT_HOME: dataDir, HOME: dataDir, USERPROFILE: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[disco-agent] ${d}`));

  const { discoverOnce } = await import('../../packages/client/dist/index.js');
  try {
    await new Promise((r) => setTimeout(r, 1500)); // 等被控端完成首次广播
    const nodes = await discoverOnce(2500, { port: DISCOVERY_PORT });
    assert.equal(nodes.length, 1, `应发现 1 台设备，实际 ${nodes.length}`);
    const n = nodes[0];
    assert.equal(n.node_id, 'disco_node');
    assert.equal(n.host, '127.0.0.1', 'host 应取报文来源 IP');
    assert.equal(n.port, DISCOVERY_AGENT_PORT);
    assert.equal(n.auth_mode, 'psk');
    assert.equal(n.input_enabled, false, '未开启输入控制应如实报告');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** v4 场景：断线自动重连。 */
async function testAutoReconnect() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nodeagent-rc-'));
  writeFileSync(
    join(dataDir, 'agent.json'),
    JSON.stringify({
      node_id: 'rc_node',
      host: '127.0.0.1',
      port: RECONNECT_PORT,
      tls: false,
      key: RECONNECT_KEY,
      log_level: 'warn',
      discovery: { enabled: false },
    }),
  );
  const spawnAgent = () =>
    spawn(process.execPath, [join(root, 'apps/agent/dist/index.js')], {
      env: { ...process.env, NODEAGENT_HOME: dataDir, HOME: dataDir, USERPROFILE: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  const url = `ws://127.0.0.1:${RECONNECT_PORT}`;
  let agent = spawnAgent();
  let client = null;

  try {
    // 等首台就绪
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const probe = new NodeAgentClient({ url, key: RECONNECT_KEY, clientId: 'rc' });
        await probe.connect();
        probe.close();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const states = [];
    client = new NodeAgentClient({
      url,
      key: RECONNECT_KEY,
      clientId: 'rc',
      autoReconnect: true,
      maxReconnectDelayMs: 800,
      onStateChange: (s) => states.push(s),
    });
    await client.connect();
    assert.equal((await client.invoke('system.info')).status, 'ok', '首连应可调用');

    // 杀掉被控端 → 触发断线
    agent.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(
      states.includes('reconnecting'),
      `断线后应进入重连态，实际状态序列: ${states.join(',')}`,
    );

    // 重启被控端 → 应自动恢复
    agent = spawnAgent();
    const recoverDeadline = Date.now() + 25_000;
    let recovered = false;
    while (Date.now() < recoverDeadline) {
      if (states.includes('connected')) {
        const r = await client.invoke('system.info').catch(() => null);
        if (r?.status === 'ok') {
          recovered = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(recovered, `应自动重连成功，状态序列: ${states.join(',')}`);
  } finally {
    client?.close();
    agent.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** v5 场景：文件传输（分块读写 + 列表 + append + 白名单）。 */
async function testFileTransfer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nodeagent-fs-'));
  const fsRoot = mkdtempSync(join(tmpdir(), 'nodeagent-fsroot-'));
  writeFileSync(
    join(dataDir, 'agent.json'),
    JSON.stringify({
      node_id: 'fs_node',
      host: '127.0.0.1',
      port: FS_PORT,
      tls: false,
      key: FS_KEY,
      log_level: 'warn',
      discovery: { enabled: false },
      fs_roots: [fsRoot],
    }),
  );

  const child = spawn(process.execPath, [join(root, 'apps/agent/dist/index.js')], {
    env: { ...process.env, NODEAGENT_HOME: dataDir, HOME: dataDir, USERPROFILE: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[fs-agent] ${d}`));

  const url = `ws://127.0.0.1:${FS_PORT}`;
  const mk = () => new NodeAgentClient({ url, key: FS_KEY, clientId: 'fs_test' });

  try {
    // 等待就绪
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`fs 被控端已退出 (code=${child.exitCode})`);
      try {
        const p = mk();
        await p.connect();
        p.close();
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!ready) throw new Error('fs 被控端未就绪');

    const c = mk();
    await c.connect();

    // 1. 写入（自动建目录）
    const nested = join(fsRoot, 'sub', 'hello.txt');
    const w = await c.invoke('fs.write', { path: nested, data: '你好 nodeagent', create_dirs: true });
    assert.equal(w.status, 'ok', `写入失败: ${JSON.stringify(w.error)}`);
    assert.equal(w.data.written, Buffer.byteLength('你好 nodeagent'), 'written 应为 UTF-8 字节数');

    // 2. 读回 + sha256
    const r = await c.invoke('fs.read', { path: nested });
    assert.equal(r.status, 'ok');
    assert.equal(r.data.data, '你好 nodeagent');
    assert.equal(r.data.eof, true, '小文件应一次读完');
    assert.ok(typeof r.data.sha256 === 'string' && r.data.sha256.length === 64, '小文件应返回 sha256');

    // 3. stat + 递归 list
    const s = await c.invoke('fs.stat', { path: nested });
    assert.equal(s.data.type, 'file');
    assert.ok(s.data.size > 0, 'size 应大于 0');
    const l = await c.invoke('fs.list', { path: fsRoot, recursive: true });
    assert.equal(l.status, 'ok');
    assert.ok(
      l.data.entries.some((e) => e.name === 'hello.txt'),
      '递归列表应包含刚写入的文件',
    );

    // 4. 大文件分块：写 1.5MB → 按 512KB 分块读 → 重组校验
    const chunk = 512 * 1024;
    const payload = Buffer.alloc(1_500_000);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    const bigPath = join(fsRoot, 'big.bin');
    const wBig = await c.invoke(
      'fs.write',
      { path: bigPath, data: payload.toString('base64'), encoding: 'base64' },
      60_000,
    );
    assert.equal(wBig.status, 'ok', `大文件写入失败: ${JSON.stringify(wBig.error)}`);
    assert.equal(wBig.data.total_bytes, payload.length);

    const parts = [];
    let offset = 0;
    for (;;) {
      const rr = await c.invoke(
        'fs.read',
        { path: bigPath, encoding: 'base64', offset, max_bytes: chunk },
        60_000,
      );
      assert.equal(rr.status, 'ok');
      parts.push(Buffer.from(rr.data.data, 'base64'));
      offset += rr.data.bytes;
      if (rr.data.eof || rr.data.bytes === 0) break;
    }
    const reassembled = Buffer.concat(parts);
    assert.equal(reassembled.length, payload.length, `分块重组长度应一致 (${reassembled.length} vs ${payload.length})`);
    assert.equal(
      createHash('sha256').update(reassembled).digest('hex'),
      createHash('sha256').update(payload).digest('hex'),
      '分块重组内容应与原文件完全一致',
    );

    // 5. append 追加（而非覆盖）
    const appendedPath = join(fsRoot, 'lines.txt');
    await c.invoke('fs.write', { path: appendedPath, data: 'line1\n' });
    await c.invoke('fs.write', { path: appendedPath, data: 'line2\n', append: true });
    const appended = await c.invoke('fs.read', { path: appendedPath });
    assert.equal(appended.data.data, 'line1\nline2\n', 'append 应追加');

    // 6. 白名单越界 → E_ACL_DENIED
    const outsidePath = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
    const outside = await c.invoke('fs.stat', { path: outsidePath });
    assert.equal(outside.status, 'failed', '越界路径应被拒绝');
    assert.equal(outside.error.name, 'E_ACL_DENIED', `期望 E_ACL_DENIED，实际 ${outside.error.name}`);

    c.close();
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** v6 场景：Hub 中转 —— 被控端主动注册，控制端经 Hub 配对后跑端到端握手。 */
async function testHubMode() {
  const hubHome = mkdtempSync(join(tmpdir(), 'nodeagent-hub-'));
  const agentHome = mkdtempSync(join(tmpdir(), 'nodeagent-hubagent-'));
  const spawnWith = (home, script) =>
    spawn(process.execPath, [join(root, script)], {
      env: { ...process.env, NODEAGENT_HOME: home, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  writeFileSync(
    join(hubHome, 'hub.json'),
    JSON.stringify({
      node_id: 'hub_e2e',
      host: '127.0.0.1',
      port: HUB_PORT,
      token: HUB_TOKEN,
      log_level: 'warn',
      // v12 / E3c：受限令牌（只允许访问 other_node，用于验证设备级授权）
      tokens: [{ value: 'limited-token', name: 'limited', allow_nodes: ['other_node'] }],
      node_allowlist: ['hub_*'],
    }),
  );
  writeFileSync(
    join(agentHome, 'agent.json'),
    JSON.stringify({
      node_id: 'hub_node',
      host: '127.0.0.1',
      port: HUB_AGENT_PORT,
      tls: false,
      key: HUB_AGENT_KEY,
      log_level: 'warn',
      discovery: { enabled: false },
      hub: { enabled: true, url: `ws://127.0.0.1:${HUB_PORT}/hub/agent`, token: HUB_TOKEN },
    }),
  );

  const hubProc = spawnWith(hubHome, 'apps/hub/dist/index.js');
  const agentProc = spawnWith(agentHome, 'apps/agent/dist/index.js');
  hubProc.stderr.on('data', (d) => process.stderr.write(`[hub] ${d}`));
  agentProc.stderr.on('data', (d) => process.stderr.write(`[hub-agent] ${d}`));

  const url = `ws://127.0.0.1:${HUB_PORT}/hub/client`;
  const mk = (token, nodeId) =>
    new NodeAgentClient({ url, key: HUB_AGENT_KEY, clientId: 'hub_test', hub: { token, nodeId } });

  try {
    // 等被控端注册到 Hub
    await new Promise((r) => setTimeout(r, 2500));

    // 1. 正常链路：经 Hub 握手并调用
    const c = mk(HUB_TOKEN, 'hub_node');
    const caps = await c.connect();
    assert.ok(caps.length >= 19, `经 Hub 应拿到完整能力清单，实际 ${caps.length}`);
    const info = await c.invoke('system.info');
    assert.equal(info.status, 'ok', '经 Hub 的调用应成功');
    c.close();

    // 2. Hub 令牌错误 → 鉴权失败
    await assert.rejects(
      () => mk('wrong-token', 'hub_node').connect(),
      (e) => {
        assert.equal(e.code, -32401, `期望 -32401（鉴权失败），实际 ${e.code}`);
        return true;
      },
    );

    // 3. 目标设备不存在 → 不可达
    await assert.rejects(
      () => mk(HUB_TOKEN, 'ghost_node').connect(),
      (e) => {
        assert.equal(e.code, -32405, `期望 -32405（设备离线），实际 ${e.code}`);
        return true;
      },
    );

    // 4. 被控端应保持在线（前一次控制端断开不应把它踢下线）
    const c2 = mk(HUB_TOKEN, 'hub_node');
    await c2.connect();
    const st = await c2.invoke('system.status');
    assert.equal(st.status, 'ok', '被控端应仍在线可再次接入');
    c2.close();

    // 5. v12 并发多控制端：两个控制端**同时**在线，各自都能调用（旧版会 E_NODE_BUSY）
    //    等常备槽位就绪（预热到 2 条约 150ms）
    await new Promise((r) => setTimeout(r, 600));
    const cc1 = mk(HUB_TOKEN, 'hub_node');
    const cc2 = mk(HUB_TOKEN, 'hub_node');
    const caps1 = await cc1.connect();
    const caps2 = await cc2.connect();
    assert.ok(caps1.length >= 19 && caps2.length >= 19, '两个控制端都应完成握手');
    const [r1, r2] = await Promise.all([
      cc1.invoke('system.info'),
      cc2.invoke('system.status'),
    ]);
    assert.equal(r1.status, 'ok', '控制端 1 的调用应成功');
    assert.equal(r2.status, 'ok', '控制端 2 的调用应成功');
    // 交替再调一次，确认两条链路互不干扰
    const [r3, r4] = await Promise.all([
      cc1.invoke('system.status'),
      cc2.invoke('system.info'),
    ]);
    assert.equal(r3.status, 'ok', '控制端 1 第二次调用应成功');
    assert.equal(r4.status, 'ok', '控制端 2 第二次调用应成功');
    cc1.close();
    cc2.close();

    // 6. v12 设备级授权：受限令牌访问未授权设备 -> E_NODE_FORBIDDEN
    await assert.rejects(
      () => mk('limited-token', 'hub_node').connect(),
      (e) => {
        assert.equal(e.name, 'E_NODE_FORBIDDEN', `期望 E_NODE_FORBIDDEN，实际 ${e.name}`);
        assert.match(e.message, /未被授权|白名单/, '错误信息应说明授权原因');
        return true;
      },
    );
  } finally {
    hubProc.kill();
    agentProc.kill();
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ============================================================================
// v7~v13 新增能力的 e2e 覆盖（审查报告 §5.1-3：新能力此前只有手工真机验证）
// ============================================================================

/**
 * v7+ GUI 语义契约。
 * 不断言「屏幕上一定有什么」（CI 无桌面会话时不可靠），而断言**对外契约**：
 *   - window.list 结构正确且前台窗口排最前
 *   - window.focus 目标不存在时是干净错误（不崩溃、不挂起）
 *   - screen.find 无命中时返回空数组 + engine + waited_ms（而非报错）
 *   - 参数校验（wait_ms 越界）必须拒绝
 */
/**
 * 断言「协议层错误」。
 *
 * ⚠️ 契约差异（e2e 实测踩到的）：
 *   - **能力层**失败（如输入未开启、窗口未找到）→ 正常返回 `{ status:'failed', error:{name} }`
 *   - **协议层**失败（参数校验 / 鉴权 / ACL / 限速）→ 让 invoke() **抛 ClientError**（err.name = 错误码）
 * 两种都不能少：前者是「调用成功但业务失败」，后者是「请求根本没被受理」。
 */
async function expectProtocolError(fn, expectedName) {
  try {
    await fn();
  } catch (err) {
    assert.equal(err.name, expectedName, `期望 ${expectedName}，实际 ${err.name}`);
    return;
  }
  assert.fail(`期望抛出 ${expectedName}，但调用居然成功了`);
}

async function testGuiSemantics() {
  const c = await connect();
  try {
    const wl = await c.invoke('window.list', { limit: 5 });
    if (wl.status === 'ok') {
      assert.ok(Array.isArray(wl.data.windows), 'windows 应为数组');
      assert.equal(typeof wl.data.total, 'number', 'total 应为数字');
      assert.ok(wl.data.windows.length <= 5, 'limit 应生效');
      const hasFg = wl.data.windows.some((w) => w.is_foreground);
      if (hasFg) assert.ok(wl.data.windows[0].is_foreground, '前台窗口应排在最前（避免被 limit 截掉）');
    } else {
      // macOS 未授予辅助功能权限时走这里：必须是可执行的提示，而不是笼统失败
      assert.ok(
        ['E_EXECUTION_FAILED', 'E_UNSUPPORTED_PLATFORM'].includes(wl.error.name),
        `非预期错误: ${wl.error.name}`,
      );
      assert.match(wl.error.message, /权限|辅助功能|不支持/);
    }

    const wf = await c.invoke('window.focus', { title: '绝不存在的窗口_ZZZ9' });
    assert.equal(wf.status, 'failed', '目标不存在应失败');
    assert.ok(
      ['E_EXECUTION_FAILED', 'E_UNSUPPORTED_PLATFORM'].includes(wf.error.name),
      `非预期错误: ${wf.error.name}`,
    );

    if (process.platform === 'win32') {
      const sf = await c.invoke('screen.find', { text: '绝不存在_ZZZ9', method: 'uia', limit: 3 });
      assert.equal(sf.status, 'ok', '无命中不是错误，应返回空结果');
      assert.deepEqual(sf.data.matches, [], '无命中时 matches 应为空数组');
      assert.equal(sf.data.engine, 'uia', '应如实报告使用的引擎');
      assert.equal(typeof sf.data.waited_ms, 'number', '应回报实际等待时长');
    }

    await expectProtocolError(
      () => c.invoke('screen.find', { text: 'x', wait_ms: 999999 }),
      'E_PARAM_INVALID',
    );
  } finally {
    c.close();
  }
}

/** v10：剪贴板读写 + 后台任务全生命周期（启动→读取→列表→终止）。 */
async function testClipAndTasks() {
  const c = await connect();
  try {
    const marker = `e2e-clip-${Date.now()}`;
    const set = await c.invoke('clip.set', { text: marker });
    assert.equal(set.status, 'ok');
    const got = await c.invoke('clip.get', { format: 'text' });
    assert.equal(got.status, 'ok');
    assert.equal(String(got.data.text ?? '').trim(), marker, '剪贴板往返应一致');

    const bg = await c.invoke('system.shell.exec', {
      command: 'echo e2e-async-marker',
      async: true,
    });
    assert.equal(bg.status, 'ok');
    assert.ok(bg.data.task_id, '异步执行应返回 task_id');
    const taskId = bg.data.task_id;

    await new Promise((r) => setTimeout(r, 1500));
    const g = await c.invoke('system.task.get', { task_id: taskId });
    assert.equal(g.status, 'ok');
    assert.match(String(g.data.data ?? ''), /e2e-async-marker/, '应能续读到任务输出');
    // 任务终态为 done / killed / failed，运行中为 running
    assert.ok(['done', 'running'].includes(g.data.state), `状态应合法: ${g.data.state}`);

    const list = await c.invoke('system.task.list', {});
    assert.ok(Array.isArray(list.data.tasks), 'tasks 应为数组');
    assert.ok(list.data.tasks.some((t) => t.task_id === taskId), '列表中应能看到该任务');

    // 终止：起一个长任务再杀掉，并确认状态已终结
    const longCmd = process.platform === 'win32' ? 'Start-Sleep 30' : 'sleep 30';
    const long = await c.invoke('system.shell.exec', { command: longCmd, async: true });
    const longId = long.data.task_id;
    await new Promise((r) => setTimeout(r, 1000));
    const killed = await c.invoke('system.task.kill', { task_id: longId });
    assert.equal(killed.data.killed, true, '运行中的任务应可终止');
    const after = await c.invoke('system.task.get', { task_id: longId });
    assert.equal(after.data.state, 'killed', '终止后状态应为 killed');
    assert.equal(after.data.exit_code, 124, '被强杀的任务退出码应归一为 124');
  } finally {
    c.close();
  }
}

/** v12：事件订阅 —— 推送与拉取两条通路都要通。 */
async function testEventWatch() {
  const dir = mkdtempSync(join(tmpdir(), 'na-e2e-watch-'));
  const pushed = [];
  const c = new NodeAgentClient({
    url: URL,
    key: KEY,
    clientId: 'e2e_mac',
    onEvent: (e) => pushed.push(e),
  });
  try {
    await c.connect();
    const w = await c.invoke('event.watch', { kind: 'file', path: dir });
    assert.equal(w.status, 'ok');
    const watchId = w.data.watch_id;
    assert.ok(watchId, '应返回 watch_id');

    // 制造变动（创建 + 修改）
    writeFileSync(join(dir, 'watched.txt'), 'v1');
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(join(dir, 'watched.txt'), 'v2');
    await new Promise((r) => setTimeout(r, 1200));

    assert.ok(pushed.length > 0, '应通过 event 通知收到推送（无需轮询）');
    assert.ok(
      pushed.some((e) => String(e.target ?? '').includes('watched.txt')),
      `推送应包含目标文件名: ${JSON.stringify(pushed.slice(0, 2))}`,
    );

    const poll = await c.invoke('event.poll', { limit: 20 });
    assert.equal(poll.status, 'ok');
    assert.ok(poll.data.events.length > 0, '拉取通路也应能读到事件');
    assert.equal(typeof poll.data.next_cursor, 'number', '应返回游标供增量拉取');
    const firstCursor = poll.data.next_cursor;
    const again = await c.invoke('event.poll', { since: firstCursor });
    assert.equal(again.data.events.length, 0, '同一游标再拉应无新事件');

    const listed = await c.invoke('event.list', {});
    assert.ok(
      listed.data.watches.some((x) => x.watch_id === watchId),
      '订阅列表应包含该订阅',
    );

    const un = await c.invoke('event.unwatch', { watch_id: watchId });
    assert.equal(un.data.removed, true);
    const after = await c.invoke('event.list', {});
    assert.ok(!after.data.watches.some((x) => x.watch_id === watchId), '取消后不应再出现');

    // 参数校验（协议层错误 -> 抛 ClientError）
    await expectProtocolError(() => c.invoke('event.watch', { kind: 'disk' }), 'E_PARAM_INVALID');
  } finally {
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** v12：GUI 宏引擎 —— 用不依赖 GUI 的步骤组合验证回放与断言。 */
async function testMacroReplay() {
  const c = await connect();
  try {
    const ok = await runMacro(
      { client: c },
      {
        name: 'e2e-macro',
        steps: [
          { action: 'exec', command: 'echo macro-step-1', expect_stdout: 'macro-step-1' },
          { action: 'clip', set: 'macro-clip-value' },
          { action: 'clip', expect: 'macro-clip-value' },
          { action: 'sleep', ms: 50 },
          { action: 'exec', command: 'echo macro-step-2', expect_stdout: 'macro-step-2' },
        ],
      },
      { STAMP: 'e2e' },
    );
    assert.equal(ok.ok, true, `宏应全通过: ${JSON.stringify(ok.steps)}`);
    assert.equal(ok.steps.length, 5);
    assert.ok(ok.steps.every((s) => s.ok));

    // 断言失败必须中止并给出定位
    const fail = await runMacro(
      { client: c },
      {
        steps: [
          { action: 'exec', command: 'echo only-this' },
          { action: 'exec', command: 'echo other', expect_stdout: '不存在的输出' },
          { action: 'exec', command: 'echo never-runs' },
        ],
      },
    );
    assert.equal(fail.ok, false);
    assert.equal(fail.failed_at, 1, '应定位到第 1 步');
    assert.equal(fail.steps.length, 2, '失败后不应继续执行');

    // optional 步骤失败不中断
    const opt = await runMacro(
      { client: c },
      {
        steps: [
          { action: 'clip', expect: '绝不在剪贴板里的内容', optional: true },
          { action: 'exec', command: 'echo still-runs' },
        ],
      },
    );
    assert.equal(opt.ok, true, 'optional 失败不应让整体失败');
  } finally {
    c.close();
  }
}


/**
 * v21 第一批加固：来源网段白名单 + 证书指纹钉住。
 * 自起一个 TLS agent（主 e2e agent 是明文 ws 且无白名单，不适合这两项）。
 */
async function testNetworkSecurity() {
  const { spawn } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const { createConnection } = await import('node:net');
  // 自建等待：主 e2e 的 waitReady 只认它那台 agent（硬编码 URL/KEY），这里用不上
  const waitPort = async (p, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const up = await new Promise((res) => {
        const sock = createConnection({ host: '127.0.0.1', port: p });
        sock.once('connect', () => { sock.destroy(); res(true); });
        sock.once('error', () => { sock.destroy(); res(false); });
      });
      if (up) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`端口 ${p} 未在超时内就绪`);
  };
  const dataDir = mkdtempSync(join(tmpdir(), 'nodeagent-sec-'));
  const port = PORT + 7;
  const key = 'sec-e2e-key-0123456789abcdef0123456789';
  writeFileSync(
    join(dataDir, 'agent.json'),
    JSON.stringify({
      node_id: 'sec_win',
      host: '127.0.0.1',
      port,
      tls: true,
      key,
      log_level: 'info',
      // 故意只放行本机 —— 前一步会先改成不放行来验证拦截
      allow_from: ['10.0.0.0/8'],
    }),
  );
  const child = spawn(process.execPath, [join(root, 'apps/agent/dist/index.js')], {
    env: { ...process.env, NODEAGENT_HOME: dataDir, HOME: dataDir, USERPROFILE: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  const cleanup = () => {
    try { child.kill(); } catch { /* 已退出 */ }
  };
  try {
    await waitPort(port, 20_000);

    // ① 白名单不含本机 → 连接被拒（E_NODE_OFFLINE 形态：握手被服务端掐断）
    await assert.rejects(
      () => new NodeAgentClient({ url: `wss://127.0.0.1:${port}`, key, clientId: 'sec', insecure: true }).connect(),
      /E_NODE_OFFLINE|E_CONNECT_FAILED|ECONNRESET|ECONNREFUSED|连接已断开/,
      '白名单外的来源应被拒绝',
    );

    // ② 放行本机 → 连上，并拿到证书指纹
    const cfgPath = join(dataDir, 'agent.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.allow_from = ['127.0.0.0/8'];
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    cleanup();
    await new Promise((r) => setTimeout(r, 800));
    const child2 = spawn(process.execPath, [join(root, 'apps/agent/dist/index.js')], {
      env: { ...process.env, NODEAGENT_HOME: dataDir, HOME: dataDir, USERPROFILE: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child2.stderr.on('data', () => {});
    try {
      await waitPort(port, 20_000);
      const good = new NodeAgentClient({ url: `wss://127.0.0.1:${port}`, key, clientId: 'sec', insecure: true });
      await good.connect();
      const fp = good.getPeerCertFingerprint();
      assert.ok(fp && /^[0-9a-f]{64}$/.test(fp), '应能观测到 64 位证书指纹');
      const info = await good.invoke('system.info', { fields: ['build'] });
      assert.equal(info.data.build.cert_sha256, fp, 'agent 自报指纹应与实际握手证书一致');
      good.close();

      // ③ 钉住错误指纹 → 必须拒绝（E_CERT_MISMATCH）
      await assert.rejects(
        () =>
          new NodeAgentClient({
            url: `wss://127.0.0.1:${port}`,
            key,
            clientId: 'sec',
            insecure: true,
            certSha256: 'deadbeef'.repeat(8),
          }).connect(),
        /E_CERT_MISMATCH/,
        '指纹不符必须拒绝连接',
      );

      // ④ 钉住正确指纹 → 放行
      const ok = new NodeAgentClient({
        url: `wss://127.0.0.1:${port}`,
        key,
        clientId: 'sec',
        insecure: true,
        certSha256: fp,
      });
      await ok.connect();
      ok.close();
    } finally {
      try { child2.kill(); } catch { /* 已退出 */ }
    }
  } finally {
    cleanup();
  }
}

/**
 * v19：拉取式自更新。
 * 用本地 HTTP 服务真跑「下载 + 哈希校验」路径；**一律 dry_run**，绝不改动测试 agent 自身文件。
 */
async function testSelfUpdate() {
  const http = await import('node:http');
  const { createHash } = await import('node:crypto');
  const payload = Buffer.from('// fake agent payload for self-update test\n'.repeat(200));
  const good = createHash('sha256').update(payload).digest('hex');

  const srv = http.createServer((req, res) => {
    if (req.url === '/agent.mjs') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
      res.end(payload);
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}/agent.mjs`;

  const c = await connect();
  try {
    // ① dry_run + 正确哈希 → 校验通过，且不改动任何文件
    const ok = await c.invoke('system.agent.update', { url, sha256: good, dry_run: true });
    assert.equal(ok.status, 'ok', `dry-run 应成功: ${JSON.stringify(ok.error)}`);
    assert.equal(ok.data.verified, true);
    assert.equal(ok.data.bytes, payload.length);
    assert.equal(ok.data.incoming_hash, good.slice(0, 12));
    assert.equal(ok.data.dry_run, true);

    // ② dry_run + 错误哈希 → 必须拒绝（哈希是安全底线）
    const bad = await c.invoke('system.agent.update', { url, sha256: 'deadbeefcafe', dry_run: true });
    assert.equal(bad.status, 'failed', '哈希不符应拒绝');
    assert.match(String(bad.error?.message ?? ''), /哈希校验失败/);

    // ③ 404 → 明确报错而非静默
    const notFound = await c.invoke('system.agent.update', { url: `http://127.0.0.1:${port}/nope`, sha256: good, dry_run: true });
    assert.equal(notFound.status, 'failed');
    assert.match(String(notFound.error?.message ?? ''), /HTTP 404/);

    // ④ 非 http(s) scheme → 拒绝（能力层）
    const scheme = await c.invoke('system.agent.update', { url: 'file:///etc/passwd', sha256: good, dry_run: true });
    assert.equal(scheme.status, 'failed');
    assert.match(String(scheme.error?.message ?? ''), /只支持 http\/https/);

    // ⑤ 缺 sha256 → 协议层拒绝（schema required）
    await expectProtocolError(() => c.invoke('system.agent.update', { url }), 'E_PARAM_INVALID');
  } finally {
    c.close();
    srv.close();
  }
}

/**
 * v17：音频控制。
 * 注意：本机（CI/macOS）也会跑这条用例，故**只把音量设为当前值**，
 * 走通写入路径但不改变实际音量（避免测试把机器静音了）。
 */
async function testAudio() {
  const c = await connect();
  try {
    const g = await c.invoke('system.audio.get', {});
    if (g.status === 'failed') {
      // 无音频设备的环境（部分 CI 容器）允许明确报错，但不能是崩溃
      assert.ok(
        ['E_EXECUTION_FAILED', 'E_UNSUPPORTED_PLATFORM'].includes(g.error.name),
        `非预期错误: ${g.error.name}`,
      );
      return;
    }
    assert.equal(typeof g.data.muted, 'boolean', 'muted 应为布尔');
    assert.equal(typeof g.data.volume, 'number', 'volume 应为数字');
    assert.ok(g.data.volume >= 0 && g.data.volume <= 100, 'volume 应在 0-100');

    // 写回原值：验证写入路径，但不产生可感知变化
    const s1 = await c.invoke('system.audio.set', { volume: g.data.volume, mute: g.data.muted });
    assert.equal(s1.status, 'ok');
    assert.equal(s1.data.volume, g.data.volume, '设置后音量应与原值一致');
    assert.equal(s1.data.muted, g.data.muted, '设置后静音态应与原值一致');
    assert.ok(s1.data.applied, '应回报本次实际应用的值');

    // 空参数：schema 允许（无必填项），由 handler 判定 → **能力层失败**（返回 failed，不抛异常）
    const empty = await c.invoke('system.audio.set', {});
    assert.equal(empty.status, 'failed', '两者都不给应失败');
    assert.equal(empty.error.name, 'E_PARAM_INVALID');

    // 越界：schema 有 minimum/maximum → **协议层**拒绝（抛 ClientError）
    await expectProtocolError(() => c.invoke('system.audio.set', { volume: 999 }), 'E_PARAM_INVALID');
    await expectProtocolError(() => c.invoke('system.audio.set', { volume: -1 }), 'E_PARAM_INVALID');
  } finally {
    c.close();
  }
}

/** v13：成功指标形状与达标判定 + 审计链完整性（防篡改）。 */
async function testMetricsAndAudit() {
  const c = await connect();
  try {
    const m = await c.invoke('system.metrics', {});
    assert.equal(m.status, 'ok');
    const d = m.data;
    for (const k of ['close_loop', 'app_install', 'latency', 'security', 'verdict', 'targets', 'window']) {
      assert.ok(k in d, `指标缺少字段 ${k}`);
    }
    assert.ok(d.close_loop.attempts >= 1, '至少应统计到本次会话的调用');
    assert.ok(d.close_loop.success_rate > 0 && d.close_loop.success_rate <= 1);
    assert.equal(d.security.interception_rate, 1, '拦截率恒为 100%（拦截由服务端强制）');
    assert.equal(typeof d.verdict.all_pass, 'boolean');
    // 时延分层：交互层参与判定，慢操作单列
    assert.equal(typeof d.latency.fast.p95_ms, 'number');
    assert.equal(typeof d.latency.slow.p95_ms, 'number');
    assert.ok(Array.isArray(d.latency.slow.capabilities) && d.latency.slow.capabilities.length > 0);
    // 装软件无样本时应为 null（而非 0，否则会误判为不达标）
    if (d.app_install.attempts === 0) assert.equal(d.app_install.success_rate, null);

    const v = await c.invoke('system.audit.verify', {});
    assert.equal(v.status, 'ok');
    assert.equal(v.data.ok, true, '审计链应完整');
    assert.ok(v.data.checked >= 1, '应校验到链条目');
  } finally {
    c.close();
  }
}

/**
 * 契约形状守卫（v-contract）：对**真实被控端**调用只读能力，
 * 断言返回字段 **⊆** manifest `returns_schema` 声明的字段。
 *
 * 补上「agent 实现 ↔ 协议契约」这一环。与控制台类型守卫
 * （tests/unit/console-contract.test.mjs）合起来，构成
 *   agent 实现 ↔ 协议契约 ↔ 前端类型
 * 的三段闭环 —— 任一段漂移都会红。
 *
 * ⚠️ 只调用**无副作用**的只读能力（不写文件、不装软件、不动输入），
 *    避免 e2e 产生难以回收的变更。
 */
async function testContractShapes() {
  const c = await connect();
  try {
    const info0 = await c.invoke('system.info', {});
    assert.equal(info0.status, 'ok');
    const home = info0.data.agent_home;
    assert.ok(home, 'system.info 应返回 agent_home');

    const cases = [
      ['system.info', {}],
      ['system.status', {}],
      ['system.process.list', { limit: 3 }],
      ['fs.list', { path: home }],
      ['fs.read', { path: join(home, 'agent.json'), max_bytes: 512 }],
      ['system.audit.list', { limit: 2 }],
      ['system.audit.verify', {}],
    ];

    for (const [cap, args] of cases) {
      const meta = findCapability(cap);
      assert.ok(meta, `${cap} 不在 manifest 清单中`);

      const declared = new Set(Object.keys(meta.returns_schema?.properties ?? {}));
      assert.ok(declared.size > 0, `${cap} 的 returns_schema 未枚举字段，无法校验`);

      const res = await c.invoke(cap, args);
      assert.equal(res.status, 'ok', `${cap} 调用失败：${JSON.stringify(res.error)}`);

      // 顶层字段 ⊆ 契约
      const extraTop = Object.keys(res.data ?? {}).filter((k) => !declared.has(k));
      assert.deepEqual(
        extraTop,
        [],
        `${cap} 返回了契约外的顶层字段：${extraTop.join(', ')}（契约：${[...declared].join(', ')}）`,
      );

      // 数组字段：首元素字段 ⊆ 契约 items.properties
      for (const [field, schema] of Object.entries(meta.returns_schema.properties)) {
        const actual = res.data?.[field];
        if (!Array.isArray(actual) || actual.length === 0) continue;
        const itemProps = new Set(Object.keys(schema.items?.properties ?? {}));
        if (itemProps.size === 0) continue; // 契约是空壳（type:'object'），无法校验
        const extraItem = Object.keys(actual[0]).filter((k) => !itemProps.has(k));
        assert.deepEqual(
          extraItem,
          [],
          `${cap}.${field}[0] 返回了契约外字段：${extraItem.join(', ')}（契约：${[...itemProps].join(', ')}）`,
        );
      }
    }
  } finally {
    c.close();
  }
}

async function main() {
  console.log('\nnodeagent 端到端测试\n');
  const agent = startAgent();

  try {
    await waitReady(30_000, agent);
    console.log(`  被控端已就绪 ${URL}\n`);

    // ---------- 握手 ----------
    await test('FR-01 正确密钥可完成握手并拿到能力清单', async () => {
      const c = await connect();
      const caps = c.listCapabilities();
      c.close();
      assert.ok(caps.length >= 15, `期望至少 15 项能力，实际 ${caps.length}`);
      for (const name of ['system.shell.exec', 'app.install', 'screen.capture', 'input.mouse.click']) {
        assert.ok(
          caps.some((x) => x.name === name),
          `能力清单缺少: ${name}`,
        );
      }
    });

    await test('FR-01 错误密钥被拒绝（E_AUTH_FAILED）', async () => {
      await assert.rejects(
        () => connect('wrong-key'),
        (err) => {
          assert.equal(err.code, -32401, `期望 -32401，实际 ${err.code}`);
          return true;
        },
      );
    });

    // ---------- 能力调用 ----------
    await test('FR-04 system.info 返回系统信息', async () => {
      const c = await connect();
      const r = await c.invoke('system.info');
      c.close();
      assert.equal(r.status, 'ok');
      const d = r.data;
      assert.ok(d.hostname, 'hostname 缺失');
      assert.ok(typeof d.cpu_cores === 'number');
    });

    await test('FR-04 system.status 返回 CPU/内存/磁盘/网络', async () => {
      const c = await connect();
      const r = await c.invoke('system.status');
      c.close();
      assert.equal(r.status, 'ok');
      const d = r.data;
      assert.ok(typeof d.cpu_pct === 'number', 'cpu_pct 缺失');
      assert.ok(d.memory_total > 0, 'memory_total 无效');
      assert.ok(Array.isArray(d.disks) && d.disks.length > 0, 'disks 为空');
      assert.ok(Array.isArray(d.net));
    });

    await test('FR-02 system.shell.exec 执行命令并返回退出码', async () => {
      const c = await connect();
      const r = await c.invoke('system.shell.exec', { command: 'echo nodeagent-ok' });
      c.close();
      assert.equal(r.status, 'ok');
      assert.equal(r.data.exit_code, 0);
      assert.match(r.data.stdout, /nodeagent-ok/);
    });

    await test('FR-02 system.shell.exec 非零退出码正确回传', async () => {
      const c = await connect();
      const r = await c.invoke('system.shell.exec', { command: 'exit 3' });
      c.close();
      assert.equal(r.status, 'ok');
      assert.equal(r.data.exit_code, 3);
    });

    await test('system.process.list 返回进程列表', async () => {
      const c = await connect();
      const r = await c.invoke('system.process.list', { limit: 5 });
      c.close();
      assert.equal(r.status, 'ok');
      assert.ok(Array.isArray(r.data.processes));
      assert.ok(r.data.processes.length > 0);
    });

    // ---------- 异常路径 ----------
    await test('超时命令被强制终止（killed=true）', async () => {
      const c = await connect();
      const r = await c.invoke('system.shell.exec', { command: 'sleep 30', timeout_ms: 1000 }, 20_000);
      c.close();
      assert.equal(r.status, 'ok');
      assert.equal(r.data.killed, true, '未标记 killed');
      assert.equal(r.data.exit_code, 124);
    });

    await test('未知能力返回 E_CAPABILITY_NOT_FOUND', async () => {
      const c = await connect();
      await assert.rejects(
        () => c.invoke('no.such.capability'),
        (err) => {
          assert.equal(err.code, -32403);
          return true;
        },
      );
      c.close();
    });

    await test('参数校验失败返回 E_PARAM_INVALID', async () => {
      const c = await connect();
      await assert.rejects(
        () => c.invoke('system.shell.exec', {}),
        (err) => {
          assert.equal(err.code, -32602);
          return true;
        },
      );
      c.close();
    });

    await test('多传参数被拒绝（additionalProperties: false）', async () => {
      const c = await connect();
      await assert.rejects(
        () => c.invoke('system.info', { bogus: 1 }),
        (err) => {
          assert.equal(err.code, -32602);
          return true;
        },
      );
      c.close();
    });

    await test('平台相关能力：Windows 成功 / 非 Windows 报 E_UNSUPPORTED_PLATFORM', async () => {
      const c = await connect();
      const r = await c.invoke('system.service.list');
      c.close();
      if (process.platform === 'win32') {
        assert.equal(r.status, 'ok', 'Windows 上 service.list 应成功');
        assert.ok(Array.isArray(r.data.services), 'services 应为数组');
        assert.ok(r.data.services.length > 0, 'Windows 上应有服务');
      } else {
        assert.equal(r.status, 'failed');
        assert.equal(r.error.name, 'E_UNSUPPORTED_PLATFORM');
      }
    });

    await test('未认证调用返回 E_AUTH_REQUIRED', async () => {
      // 跳过握手，直连后立即 invoke
      const ws = new WebSocket(URL);
      await new Promise((res, rej) => {
        ws.addEventListener('open', () => res());
        ws.addEventListener('error', () => rej(new Error('websocket error')));
      });
      const resp = await new Promise((resolve) => {
        ws.addEventListener('message', (ev) => resolve(JSON.parse(ev.data)));
        ws.send(
          JSON.stringify({ jsonrpc: '2.0', id: '01TEST', method: 'invoke', params: { capability: 'system.info' } }),
        );
      });
      ws.close();
      assert.equal(resp.error.code, -32402);
    });

    await test('TLS 模式：被控端以 wss 启动并可连接（自签证书 + insecure）', testTlsMode);

    // ---------- v2 图形接管 ----------
    await test('v2 screen.info 返回显示器列表', async () => {
      const c = await connect();
      const r = await c.invoke('screen.info');
      c.close();
      assert.equal(r.status, 'ok');
      assert.ok(Array.isArray(r.data.displays), 'displays 应为数组');
      assert.ok(r.data.displays.length > 0, '至少应有一个显示器');
    });

    await test('v2 input.* 默认禁用并返回 E_CAPABILITY_DISABLED', async () => {
      const c = await connect();
      const [move, type] = await Promise.all([
        c.invoke('input.mouse.move', { x: 1, y: 1 }),
        c.invoke('input.key.type', { text: 'x' }),
      ]);
      c.close();
      for (const r of [move, type]) {
        assert.equal(r.status, 'failed', '未开启输入控制时应为 failed');
        assert.equal(r.error.name, 'E_CAPABILITY_DISABLED');
      }
    });

    // ---------- v3 零信任 ----------
    await test('v3 零信任：Ed25519 认证 + ACL 授权/拒绝 + 审计留痕 + 限速', testEd25519Acl);

    // ---------- v4 无感体验 ----------
    await test('v4 局域网发现：UDP 广播可被发现', testDiscovery);
    await test('v4 断线自动重连：被控端重启后自动恢复', testAutoReconnect);

    // ---------- v5 文件传输 ----------
    await test('v5 文件传输：写入→读回→列表→分块重组→append→白名单', testFileTransfer);

    // ---------- v6 Hub 中转 ----------
    await test('v6 Hub 中转：注册→配对→端到端握手→多次接入→v12 并发双控制端', testHubMode);

    // ---------- v7~v13 新增能力（含 v14 常驻助手路径）----------
    await test('v8 GUI 语义契约：window.list 结构 / focus 干净报错 / find 空命中与参数校验', testGuiSemantics);
    await test('v10 剪贴板与后台任务：往返 / 异步执行→续读→列表→终止(exit 124)', testClipAndTasks);
    await test('v12 事件订阅：文件监控 → 推送 + 拉取双通路 → 取消', testEventWatch);
    await test('v12 GUI 宏引擎：步骤回放 / 断言中止定位 / optional 继续', testMacroReplay);
    await test('v13 成功指标与审计链：形状 + 分层时延 + 达标判定 + 链完整', testMetricsAndAudit);
    await test('v17 音频控制：读状态 / 写回原值 / 参数校验', testAudio);
    await test('v19 拉取式自更新：HTTP 下载 + 哈希校验（dry-run）', testSelfUpdate);
    await test('v21 网络安全：网段白名单 + 证书指纹钉住（TOFU 与拒绝）', testNetworkSecurity);

    // ---------- 契约形状（agent 实现 ↔ 协议契约）----------
    await test('契约形状：只读能力返回字段与 manifest returns_schema 一致', testContractShapes);
  } finally {
    agent.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
