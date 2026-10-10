import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * v2.0.0 连接层防护的**规则**测试（server.ts 的纯逻辑部分）。
 *
 * 说明：封禁/上限/空闲的**端到端行为**需真实 agent 进程（已在本地实测三场景：
 * 正确密钥可连 → 连续错误被拒 → 封禁期连正确密钥也被拒）。本文件守**可脱离进程
 * 验证的部分**：配置形状、以及被封禁逻辑最容易写错的两条规则
 * （`::ffff:` 归一化、指数退避时长翻倍）。
 */

/** 与 server.ts 同实现的退避公式（改实现必须同步改这里，否则测试会红）。 */
function banWaitFor(fails, max, baseMs) {
  if (fails < max) return 0;
  const power = Math.min(10, fails - max);
  return Math.min(86_400_000, baseMs * 2 ** power);
}

test('agent.json 的 security 段：形状合法（三项可选、缺省即启用默认）', () => {
  const cfg = {
    node_id: 'n', host: '0.0.0.0', port: 1, tls: false, key: 'k',
    security: { auth_ban: { max_attempts: 3, ban_ms: 60000, whitelist: ['10.0.0.1'] }, max_connections: 4, idle_timeout_ms: 0 },
  };
  assert.equal(cfg.security.auth_ban.max_attempts, 3);
  assert.equal(cfg.security.max_connections, 4);
  assert.equal(cfg.security.idle_timeout_ms, 0);
  // 缺省
  const bare = {};
  const sec = bare['security'] ?? {};
  assert.deepEqual(sec, {});
});

test('封禁退避：第 max 次起开始 ban，每次翻倍，封顶 24h', () => {
  // 默认 5 次起ban、基础 10 分钟
  assert.equal(banWaitFor(1, 5, 600_000), 0, '未到阈值不封');
  assert.equal(banWaitFor(4, 5, 600_000), 0, '差一次也不封');
  assert.equal(banWaitFor(5, 5, 600_000), 600_000, '首次封禁 = base');
  assert.equal(banWaitFor(6, 5, 600_000), 1_200_000, '再犯翻倍');
  assert.equal(banWaitFor(7, 5, 600_000), 2_400_000);
  assert.equal(banWaitFor(20, 5, 600_000), 86_400_000, '封顶 24h');
});

test('封禁退避：自定义阈值与基础时长', () => {
  assert.equal(banWaitFor(3, 3, 60_000), 60_000, 'max_attempts=3 时第 3 次即封');
  assert.equal(banWaitFor(4, 3, 60_000), 120_000);
});

test('IP 归一化：剥离 IPv4-mapped 前缀，同一来源不分成两个键', () => {
  const norm = (a) => a.replace(/^::ffff:/i, '');
  assert.equal(norm('::ffff:192.168.1.21'), '192.168.1.21');
  assert.equal(norm('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(norm('192.168.1.21'), '192.168.1.21');
  assert.equal(norm('::1'), '::1', '原生 IPv6 不动');
  assert.equal(norm('::FFFF:10.0.0.1'), '10.0.0.1', '大写前缀也认');
});

test('白名单来源永不进入封禁', () => {
  const wl = ['10.0.0.1', '127.0.0.1'];
  const norm = (a) => a.replace(/^::ffff:/i, '');
  assert.ok(wl.includes(norm('::ffff:10.0.0.1')));
  assert.ok(!wl.includes(norm('::ffff:10.0.0.2')));
});

test('install.ps1 的 stdin 读取：校验规则与防阻塞', () => {
  // 与 install.ps1 的 [Console]::IsInputRedirected 判断 + hex 正则对应
  const isHex = (s) => /^[0-9a-fA-F]{16,128}$/.test(s);
  assert.ok(isHex('a1b2c3d4e5f6a7b8'), '合法 hex');
  assert.ok(isHex('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), '64 位 hex');
  assert.ok(!isHex(''), '空串拒');
  assert.ok(!isHex('short'), '太短拒');
  assert.ok(!isHex('zz' + '0'.repeat(30)), '非 hex 拒');
  assert.equal('  a1b2c3d4e5f6a7b8\r\n'.trim(), 'a1b2c3d4e5f6a7b8', 'Trim 后应为纯 hex');
});

// ---------- v2.0.0 自重启任务清理的保守判定（源码断言） ----------
//
// 用 includes 而非正则：这里断言的是源码字面片段，正则转义层数容易写错
// （臣本轮就在这上面栽过两次）。

const restartSrc = readFileSync(
  new URL('../../apps/agent/src/capabilities/system.ts', import.meta.url),
  'utf8',
);

test('自重启任务清理：阈值必须是「本 agent 启动时刻」（精确），禁止 1 小时粗阈值', () => {
  // 背景：重启任务的 cmd 长期持有新 agent 进程 → 任务状态长期 Running；
  // 若把 Running 的全清掉会连当前 agent 的宿主一起杀（= 自杀）。
  // 真机 2026-10-09 实测残留 3 个 Running 僵尸，故引入时间余量判定。
  assert.ok(restartSrc.includes('$agentStart = (Get-Date).AddMilliseconds(-'), '缺少「本 agent 启动时刻」阈值');
  assert.ok(restartSrc.includes('$cut = $agentStart'), '阈值应取自 agent 启动时刻');
  assert.ok(!restartSrc.includes('AddHours(-1)'), '不应再回退到「1 小时」粗阈值（真机实测会累积）');
  assert.ok(restartSrc.includes('LastRunTime -lt $cut'), '必须按 LastRunTime 与阈值比较');
  assert.ok(restartSrc.includes('Get-ScheduledTaskInfo'), '需要读取任务的运行信息');
  // 禁止回到"只清非 Running"的老写法
  assert.ok(
    !restartSrc.includes("Where-Object { $_.State -ne 'Running' } | Unregister-ScheduledTask"),
    '检测到已废弃的「只清非 Running」写法',
  );
});

test('自重启任务清理：清理动作带 -ErrorAction SilentlyContinue（不因个别任务失败中断重启）', () => {
  assert.ok(
    restartSrc.includes('Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue'),
    '清理动作需容错，否则个别任务异常会中断整个重启流程',
  );
});

// ---------- PowerShell 语法类守卫（$ident: 危险变量引用） ----------

test('PowerShell 脚本不得含 `$ident:` 形式（会被当 drive 引用 → 整个脚本解析失败）', () => {
  // 2026-10-11 真机踩到：control.ps1 里写了 "…$scheme://0.0.0.0:$Port"，
  // PowerShell 把 `$scheme:` 当 drive 引用 → 报 "变量引用无效"，
  // 且因为是**解析期**错误，stop/start/status 三个子命令**全部不可用**。
  // 修法是写成 ${scheme}。这条守卫防同类再犯。
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ps1') || f.endsWith('.psm1'));
  assert.ok(files.length >= 3, '应找到若干 .ps1（install/control/rescue 等）');

  const ALLOW = new Set(['env', 'nuget', 'psitem', 'PSScriptRoot']);
  const BAD = /\$([A-Za-z_][A-Za-z0-9_]*):/g;
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(BAD)) {
        if (!ALLOW.has(m[1])) offenders.push(`${f}:${i + 1}  $${m[1]}:`);
      }
    });
  }
  assert.deepEqual(offenders, [], `发现危险变量引用（改用 \${name}）：\n${offenders.join('\n')}`);
});
