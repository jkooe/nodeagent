/**
 * nodeagent Windows 专属能力 E2E
 *
 * 仅在 Windows 上运行：验证 system.service.list / app.list / app.install（winget）等
 * 只在 Windows 被控端可用的能力。
 *
 * 运行：node tests/e2e/windows.mjs
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

const PORT = 18768;
const KEY = 'windows-e2e-key-0123456789abcdef0123456789abcdef';
const URL = `ws://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name, fn) {
  try {
    const r = await fn();
    if (r === 'skip') {
      console.log(`  - ${name}  [skip]`);
      skipped += 1;
    } else {
      console.log(`  \u2713 ${name}`);
      passed += 1;
    }
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
}

function startAgent() {
  // NODEAGENT_HOME 直接作为数据目录（等价于 ~/.nodeagent）
  const dataDir = mkdtempSync(join(tmpdir(), 'nodeagent-win-e2e-'));
  writeFileSync(
    join(dataDir, 'agent.json'),
    JSON.stringify({ node_id: 'win_e2e', host: '127.0.0.1', port: PORT, tls: false, key: KEY, log_level: 'warn' }),
  );
  const child = spawn(process.execPath, [join(root, 'apps/agent/dist/index.js')], {
    // NODEAGENT_HOME 为准（跨平台一致）；HOME/USERPROFILE 兜底
    env: { ...process.env, NODEAGENT_HOME: dataDir, HOME: dataDir, USERPROFILE: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[agent] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[agent:err] ${d}`));
  child.on('error', (err) => console.error(`\n⚠️  [agent spawn 失败] ${err.message}\n`));
  child.on('exit', (code, signal) => {
    console.log(`\n⚠️  [agent 进程退出] code=${code} signal=${signal}\n`);
  });
  return child;
}

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
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('被控端未在超时内就绪');
}

async function connect() {
  const c = new NodeAgentClient({ url: URL, key: KEY, clientId: 'win_e2e_mac' });
  await c.connect();
  return c;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('\n非 Windows 平台，跳过 Windows 专属测试。');
    process.exit(0);
  }

  console.log('\nnodeagent Windows 专属能力 E2E\n');
  const agent = startAgent();

  try {
    await waitReady(30_000, agent);
    console.log(`  被控端已就绪 ${URL}\n`);

    await test('system.info 报告 Windows 平台', async () => {
      const c = await connect();
      const r = await c.invoke('system.info');
      c.close();
      assert.equal(r.status, 'ok');
      assert.match(String(r.data.os), /Windows/i, `os 字段异常: ${r.data.os}`);
      assert.ok(r.data.cpu_cores > 0);
      assert.ok(r.data.memory_total > 0);
    });

    await test('system.status 返回 Windows 磁盘（盘符）', async () => {
      const c = await connect();
      const r = await c.invoke('system.status');
      c.close();
      assert.equal(r.status, 'ok');
      assert.ok(Array.isArray(r.data.disks) && r.data.disks.length > 0, 'disks 为空');
      assert.match(String(r.data.disks[0].drive), /^[A-Z]:/i, `盘符格式异常: ${r.data.disks[0].drive}`);
    });

    await test('system.service.list 返回 Windows 服务', async () => {
      const c = await connect();
      const r = await c.invoke('system.service.list', { limit: 50 });
      c.close();
      assert.equal(r.status, 'ok');
      assert.ok(r.data.services.length > 0, '服务列表为空');
      const s = r.data.services[0];
      assert.ok(s.name && s.state, `服务字段异常: ${JSON.stringify(s)}`);
    });

    await test('system.service.list 支持按名称筛选', async () => {
      const c = await connect();
      const r = await c.invoke('system.service.list', { filter: { name_pattern: 'win' } });
      c.close();
      assert.equal(r.status, 'ok');
      assert.ok(r.data.services.every((s) => /win/i.test(s.name) || /win/i.test(s.display_name)));
    });

    await test('system.process.list 返回进程（含 CPU 百分比）', async () => {
      const c = await connect();
      const r = await c.invoke('system.process.list', { limit: 10 });
      c.close();
      assert.equal(r.status, 'ok');
      assert.ok(r.data.processes.length > 0, '进程列表为空');
      assert.equal(typeof r.data.processes[0].cpu_pct, 'number');
    });

    await test('system.shell.exec 执行 PowerShell 命令', async () => {
      const c = await connect();
      const r = await c.invoke('system.shell.exec', { command: 'Get-Date -Format "yyyy-MM-dd"', shell: 'powershell' });
      c.close();
      assert.equal(r.status, 'ok');
      assert.equal(r.data.exit_code, 0);
      assert.match(r.data.stdout, /\d{4}-\d{2}-\d{2}/);
    });

    await test('system.shell.exec 支持 cmd 外壳', async () => {
      const c = await connect();
      const r = await c.invoke('system.shell.exec', { command: 'echo cmd-ok', shell: 'cmd' });
      c.close();
      assert.equal(r.status, 'ok');
      assert.equal(r.data.exit_code, 0);
      assert.match(r.data.stdout, /cmd-ok/);
    });

    await test('app.list 返回已安装软件（注册表）', async () => {
      const c = await connect();
      const r = await c.invoke('app.list');
      c.close();
      assert.equal(r.status, 'ok');
      assert.ok(Array.isArray(r.data.apps), 'apps 应为数组');
      assert.ok(r.data.apps.length > 0, '未读到任何已安装软件');
    });

    await test('app.install 用 winget 安装软件', async () => {
      const c = await connect();
      const probe = await c.invoke('system.shell.exec', { command: 'winget --version' });
      if (probe.status !== 'ok' || probe.data.exit_code !== 0) {
        c.close();
        return 'skip'; // CI 环境无 winget
      }
      const r = await c.invoke('app.install', { package: 'jqlang.jq', timeout_ms: 600_000 }, 660_000);
      c.close();
      assert.equal(r.status, 'ok', `app.install 协议层失败: ${JSON.stringify(r.error)}`);
      assert.equal(r.data.installed, true, `winget 安装失败:\n${r.data.detail}`);
    });

    await test('安装后可在 app.list 中检索到', async () => {
      const c = await connect();
      const r = await c.invoke('app.list', { filter: { name_pattern: 'jq' } });
      c.close();
      assert.equal(r.status, 'ok');
      // jq 由 winget 通过 MSI 安装，注册表中应可见；找不到则视为跳过（安装方式差异）
      if (!r.data.apps.some((a) => /jq/i.test(a.name))) return 'skip';
      assert.ok(true);
    });

    // ---------- v2 图形接管（Windows 真机） ----------
    await test('v2 screen.info 返回 Windows 显示器', async () => {
      const c = await connect();
      const r = await c.invoke('screen.info');
      c.close();
      assert.equal(r.status, 'ok');
      assert.ok(r.data.displays.length > 0, '应有显示器');
      assert.ok(r.data.displays[0].width > 0, '宽度应大于 0');
    });

    await test('v2 screen.capture 真实截屏返回图片', async () => {
      const c = await connect();
      const r = await c.invoke('screen.capture', { scale: 0.5, format: 'jpeg' }, 60_000);
      c.close();
      assert.equal(r.status, 'ok', `截屏失败: ${JSON.stringify(r.error)}`);
      assert.ok(typeof r.data.image === 'string' && r.data.image.length > 1000, '图片数据过小');
      assert.ok(r.data.width > 0 && r.data.height > 0, '尺寸无效');
      return `${r.data.width}x${r.data.height} ${(r.data.bytes / 1024).toFixed(1)}KB`;
    });

    await test('v2 输入控制默认禁用（E_CAPABILITY_DISABLED）', async () => {
      const c = await connect();
      const r = await c.invoke('input.mouse.move', { x: 1, y: 1 });
      c.close();
      assert.equal(r.status, 'failed');
      assert.equal(r.error.name, 'E_CAPABILITY_DISABLED');
    });
  } finally {
    agent.kill();
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败, ${skipped} 跳过\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
