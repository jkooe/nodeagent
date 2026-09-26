#!/usr/bin/env node
/**
 * nodeagent 远程验收脚本
 *
 * 对一台可达的 Windows 被控端执行全套验收（对齐 PRD 的 FR-01 ~ FR-08），输出报告。
 *
 * 用法:
 *   node scripts/verify.mjs                                   # 使用本机已保存的配置
 *   node scripts/verify.mjs --host 192.168.1.100 --port 8765 --key <key> [--insecure]
 *   node scripts/verify.mjs --with-install jqlang.jq          # 额外执行装软件验收（会真实安装）
 *   node scripts/verify.mjs --report report.md                # 同时写出 Markdown 报告
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeAgentClient, loadConfig, toWsUrl } from '../packages/client/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- 参数 ----------

function parseArgs(argv) {
  const out = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out.values[key] = next;
      i += 1;
    } else {
      out.flags.add(key);
    }
  }
  return out;
}

const { flags, values } = parseArgs(process.argv.slice(2));

let conn;
if (values['host']) {
  conn = {
    host: values['host'],
    port: Number(values['port'] ?? 8765),
    key: values['key'] ?? '',
    client_id: values['id'] ?? 'verify',
    tls: !flags.has('no-tls'),
    insecure: flags.has('insecure') || flags.has('no-tls'),
  };
  if (!conn.key) {
    console.error('✗ 使用 --host 时必须同时提供 --key <预共享密钥>');
    process.exit(1);
  }
} else {
  const saved = loadConfig();
  if (!saved) {
    console.error('✗ 未找到本机配置。请先执行: nodeagent connect <host> --port 8765 --key <密钥>');
    process.exit(1);
  }
  conn = saved;
}

// ---------- 结果收集 ----------

const results = [];

async function check(id, name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    if (detail === 'skip') {
      results.push({ id, name, status: 'skip', detail: '不适用' });
      console.log(`  - ${id} ${name}  [跳过]`);
    } else {
      results.push({ id, name, status: 'pass', detail: detail ?? '' , ms: Date.now() - t0 });
      console.log(`  ✓ ${id} ${name}${detail ? `  — ${detail}` : ''}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ id, name, status: 'fail', detail: msg });
    console.log(`  ✗ ${id} ${name}\n      ${msg}`);
  }
}

async function connect(key = conn.key) {
  const c = new NodeAgentClient({
    url: toWsUrl(conn),
    key,
    clientId: conn.client_id ?? 'verify',
    insecure: conn.insecure,
  });
  await c.connect();
  return c;
}

// ---------- 验收主体 ----------

async function main() {
  const startedAt = new Date();
  console.log('\nnodeagent 验收报告');
  console.log('─'.repeat(52));
  console.log(`  目标    : ${toWsUrl(conn)}`);
  console.log(`  时间    : ${startedAt.toLocaleString('zh-CN')}`);
  console.log('─'.repeat(52));

  // 探测被控端平台
  let platform = 'unknown';
  {
    const c = await connect();
    const r = await c.invoke('system.info');
    if (r.status === 'ok') platform = String(r.data.os ?? 'unknown');
    c.close();
  }
  const isWindows = /windows/i.test(platform);
  console.log(`  被控端   : ${platform}${isWindows ? '' : '  ⚠️ 非 Windows，部分验收将跳过'}\n`);

  console.log('[FR-01] 连接与鉴权');
  await check('FR-01.1', '握手成功并获取能力清单', async () => {
    const c = await connect();
    const n = c.listCapabilities().length;
    c.close();
    if (n === 0) throw new Error('能力清单为空');
    return `${n} 项能力`;
  });
  await check('FR-01.2', '错误密钥被拒绝', async () => {
    try {
      const c = await connect('definitely-wrong-key');
      c.close();
      throw new Error('错误密钥竟然通过了鉴权');
    } catch (err) {
      if (err.message === '错误密钥竟然通过了鉴权') throw err;
      if (err.code !== -32401 && err.name !== 'E_AUTH_FAILED') {
        throw new Error(`期望 E_AUTH_FAILED，实际 ${err.name}: ${err.message}`);
      }
      return 'E_AUTH_FAILED';
    }
  });

  console.log('\n[FR-04] 状态查询');
  await check('FR-04.1', 'system.info 系统信息', async () => {
    const c = await connect();
    const r = await c.invoke('system.info');
    c.close();
    assertOk(r, 'system.info');
    return `${r.data.hostname} · ${r.data.os} · ${r.data.cpu_cores} 核`;
  });
  await check('FR-04.2', 'system.status 资源状态', async () => {
    const c = await connect();
    const r = await c.invoke('system.status');
    c.close();
    assertOk(r, 'system.status');
    if (typeof r.data.cpu_pct !== 'number') throw new Error('缺少 cpu_pct');
    if (!(r.data.memory_total > 0)) throw new Error('memory_total 无效');
    if (!Array.isArray(r.data.disks) || r.data.disks.length === 0) throw new Error('磁盘列表为空');
    return `CPU ${r.data.cpu_pct}% · 内存 ${r.data.memory_pct}% · ${r.data.disks.length} 个磁盘`;
  });
  await check('FR-04.3', 'system.process.list 进程列表', async () => {
    const c = await connect();
    const r = await c.invoke('system.process.list', { limit: 10 });
    c.close();
    assertOk(r, 'system.process.list');
    if (r.data.processes.length === 0) throw new Error('进程列表为空');
    return `${r.data.processes.length} 个进程`;
  });
  await check('FR-04.4', 'system.service.list 服务列表', async () => {
    if (!isWindows) return 'skip';
    const c = await connect();
    const r = await c.invoke('system.service.list', { limit: 20 });
    c.close();
    assertOk(r, 'system.service.list');
    if (r.data.services.length === 0) throw new Error('服务列表为空');
    return `${r.data.services.length} 个服务`;
  });

  console.log('\n[FR-02] 命令执行');
  await check('FR-02.1', '执行命令并返回退出码', async () => {
    const c = await connect();
    const cmd = isWindows ? 'Write-Output verify-ok' : 'echo verify-ok';
    const r = await c.invoke('system.shell.exec', { command: cmd });
    c.close();
    assertOk(r, 'system.shell.exec');
    if (r.data.exit_code !== 0) throw new Error(`退出码 ${r.data.exit_code}`);
    if (!/verify-ok/.test(r.data.stdout)) throw new Error(`输出异常: ${r.data.stdout}`);
    return `${r.data.duration_ms}ms`;
  });
  await check('FR-02.2', '非零退出码正确回传', async () => {
    const c = await connect();
    const r = await c.invoke('system.shell.exec', { command: 'exit 7' });
    c.close();
    assertOk(r, 'system.shell.exec');
    if (r.data.exit_code !== 7) throw new Error(`期望 7，实际 ${r.data.exit_code}`);
    return 'exit_code=7';
  });
  await check('FR-02.3', '超时命令被强制终止', async () => {
    const c = await connect();
    const r = await c.invoke('system.shell.exec', { command: 'sleep 60', timeout_ms: 1500 }, 30_000);
    c.close();
    assertOk(r, 'system.shell.exec');
    if (r.data.killed !== true) throw new Error('未标记 killed=true');
    return `killed=true, exit=${r.data.exit_code}`;
  });

  console.log('\n[FR-05] 错误反馈');
  await check('FR-05.1', '未知能力返回明确错误码', async () => {
    const c = await connect();
    try {
      await c.invoke('no.such.capability');
      c.close();
      throw new Error('未知能力未报错');
    } catch (err) {
      c.close();
      if (err.code !== -32403) throw new Error(`期望 -32403，实际 ${err.code}`);
      return 'E_CAPABILITY_NOT_FOUND';
    }
  });
  await check('FR-05.2', '参数校验拦截缺参调用', async () => {
    const c = await connect();
    try {
      await c.invoke('system.shell.exec', {});
      c.close();
      throw new Error('缺参未报错');
    } catch (err) {
      c.close();
      if (err.code !== -32602) throw new Error(`期望 -32602，实际 ${err.code}`);
      return 'E_PARAM_INVALID';
    }
  });

  console.log('\n[FR-03] 软件管理');
  await check('FR-03.1', 'app.list 列出已安装软件', async () => {
    if (!isWindows) return 'skip';
    const c = await connect();
    const r = await c.invoke('app.list');
    c.close();
    assertOk(r, 'app.list');
    return `${r.data.apps.length} 款软件`;
  });

  const installPkg = values['with-install'];
  if (installPkg) {
    await check('FR-03.2', `app.install 安装 ${installPkg}`, async () => {
      const c = await connect();
      const r = await c.invoke('app.install', { package: installPkg, timeout_ms: 600_000 }, 660_000);
      c.close();
      assertOk(r, 'app.install');
      if (!r.data.installed) throw new Error(`安装失败:\n${r.data.detail}`);
      return `${r.data.name} ${r.data.version || ''}`.trim();
    });
  } else {
    results.push({ id: 'FR-03.2', name: 'app.install 安装软件', status: 'skip', detail: '需 --with-install <包名>' });
    console.log('  - FR-03.2 app.install 安装软件  [跳过：需 --with-install <包名>]');
  }

  console.log('\n[v2] 图形接管');
  await check('v2.1', 'screen.info 显示器信息', async () => {
    const c = await connect();
    const r = await c.invoke('screen.info');
    c.close();
    assertOk(r, 'screen.info');
    if (!Array.isArray(r.data.displays) || r.data.displays.length === 0) throw new Error('未返回显示器');
    const d = r.data.displays[0];
    return `${r.data.displays.length} 个显示器，主屏 ${d.width}x${d.height}`;
  });
  await check('v2.2', 'screen.capture 截屏', async () => {
    const c = await connect();
    const r = await c.invoke('screen.capture', { scale: 0.4, format: 'jpeg' }, 60_000);
    c.close();
    if (r.status !== 'ok') {
      if (r.error?.name === 'E_UNSUPPORTED_PLATFORM') return 'skip';
      throw new Error(`截屏失败: ${r.error?.name}: ${r.error?.message}`);
    }
    if (!r.data.image || r.data.image.length < 1000) throw new Error('图片数据异常');
    return `${r.data.width}x${r.data.height} ${(r.data.bytes / 1024).toFixed(1)}KB`;
  });
  await check('v2.3', 'input.* 高危能力受开关管控', async () => {
    const c = await connect();
    const r = await c.invoke('input.mouse.move', { x: 1, y: 1 });
    c.close();
    if (r.status === 'ok') return '已开启输入控制';
    if (r.error?.name === 'E_CAPABILITY_DISABLED') return '默认禁用（安全）';
    throw new Error(`异常响应: ${JSON.stringify(r.error)}`);
  });

  // ---------- 汇总 ----------
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  const finishedAt = new Date();

  console.log('\n' + '─'.repeat(52));
  console.log(`  汇总: ${pass} 通过 / ${fail} 失败 / ${skip} 跳过   （耗时 ${((finishedAt - startedAt) / 1000).toFixed(1)}s）`);
  console.log('─'.repeat(52) + '\n');

  const reportPath = values['report'];
  if (reportPath) {
    const md = buildReport(conn, platform, results, startedAt, finishedAt);
    writeFileSync(reportPath, md);
    console.log(`报告已写入: ${reportPath}\n`);
  }

  process.exit(fail > 0 ? 1 : 0);
}

function assertOk(r, cap) {
  if (r.status !== 'ok') {
    throw new Error(`${cap} 执行失败: ${r.error?.name}: ${r.error?.message}`);
  }
}

function buildReport(conn, platform, results, startedAt, finishedAt) {
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  const icon = (s) => (s === 'pass' ? '✅' : s === 'fail' ? '❌' : '⏭️');

  return [
    '# nodeagent 验收报告',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 被控端 | \`${toWsUrl(conn)}\` |`,
    `| 平台 | ${platform} |`,
    `| 开始 | ${startedAt.toLocaleString('zh-CN')} |`,
    `| 结束 | ${finishedAt.toLocaleString('zh-CN')} |`,
    `| 结果 | **${pass} 通过 / ${fail} 失败 / ${skip} 跳过** |`,
    '',
    '## 明细',
    '',
    '| # | 验收项 | 结果 | 说明 |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.name} | ${icon(r.status)} ${r.status} | ${r.detail.replace(/\n/g, ' ')} |`),
    '',
    '> 本报告由 `scripts/verify.mjs` 自动生成，仅用于功能验收，不构成任何安全承诺。',
    '',
  ].join('\n');
}

main().catch((err) => {
  console.error(`\n✗ 验收中断: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
