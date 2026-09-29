/**
 * nodeagent 端到端测试
 *
 * 在 Mac 上启动一个被控端 Agent（临时配置、独立 HOME），
 * 用控制端客户端跑通：握手 → 能力调用 → 异常路径。
 *
 * 运行：node tests/e2e/run.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { NodeAgentClient } from '../../packages/client/dist/index.js';
import { generateKeyPair } from '../../packages/protocol/dist/index.js';

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
    JSON.stringify({ node_id: 'hub_e2e', host: '127.0.0.1', port: HUB_PORT, token: HUB_TOKEN, log_level: 'warn' }),
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
  } finally {
    hubProc.kill();
    agentProc.kill();
    await new Promise((r) => setTimeout(r, 400));
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
