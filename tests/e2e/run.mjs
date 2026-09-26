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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { NodeAgentClient } from '../../packages/client/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');

const PORT = 18765;
const TLS_PORT = 18772;
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
      assert.equal(caps.length, 7, `期望 7 项能力，实际 ${caps.length}`);
      assert.ok(caps.some((x) => x.name === 'system.shell.exec'));
      c.close();
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
