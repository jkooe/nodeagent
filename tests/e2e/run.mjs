/**
 * nodeagent 端到端测试
 *
 * 在 Mac 上启动一个被控端 Agent（临时配置、独立 HOME），
 * 用控制端客户端跑通：握手 → 能力调用 → 异常路径。
 *
 * 运行：node tests/e2e/run.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { NodeAgentClient } from '../../packages/client/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');

const PORT = 18765;
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
  const home = mkdtempSync(join(tmpdir(), 'nodeagent-e2e-'));
  mkdirSync(join(home, '.nodeagent'), { recursive: true });
  writeFileSync(
    join(home, '.nodeagent', 'agent.json'),
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
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[agent] ${d}`));
  return child;
}

/** 等待被控端可连接（重试）。 */
async function waitReady(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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

async function main() {
  console.log('\nnodeagent 端到端测试\n');
  const agent = startAgent();

  try {
    await waitReady();
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

    await test('平台不支持的能力返回 status=failed + E_UNSUPPORTED_PLATFORM', async () => {
      const c = await connect();
      const r = await c.invoke('system.service.list');
      c.close();
      assert.equal(r.status, 'failed');
      assert.equal(r.error.name, 'E_UNSUPPORTED_PLATFORM');
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
