/**
 * 编码守卫：仓库里的手写 .ps1 **必须带 UTF-8 BOM**。
 *
 * ⚠️ 背景（真机踩过，2026-10-04）：`install.ps1` 一度是无 BOM 的 UTF-8，
 *    在被控端用 **Windows PowerShell 5.1** 执行时直接解析失败：
 *      所在位置 D:\Nodeagent\install.ps1:31 字符: 31
 *      +     [string]$ProjectRoot = "",
 *      “,”后面缺少表达式。
 *    原因：5.1 读**无 BOM** 的 .ps1 会按系统 ANSI（中文 Windows = GBK）解码，
 *    脚本里的中文注释/字符串被解成乱码，其中某些字节序列被误认成引号，
 *    于是整份脚本的字符串边界全乱 —— 报出的一串语法错误彼此无关，
 *    真正的病灶在文件靠前的位置。
 *
 *    **CI 之前全绿是因为冒烟步骤用 `shell: pwsh`（PowerShell 7，认无 BOM UTF-8）**，
 *    只有真机的 5.1 会炸。故此用例 + CI 的 5.1 解析冒烟一起守。
 *
 * 对照：运行时**动态生成**的 .ps1 走 `apps/agent/src/capabilities/network.ts`
 * 的 `withBom()`，已有同样约束。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const PS_DIR = join(ROOT, 'scripts');

/** 收集仓库里所有需要分发的 .ps1（含子目录） */
function collectPs1(dir) {
  return collectByExt(dir, '.ps1');
}

/** 收集仓库里所有 .cmd（双击入口） */
function collectCmd(dir) {
  return collectByExt(dir, '.cmd');
}

function collectByExt(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name.startsWith('.')) continue;
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...collectByExt(full, ext));
    else if (name.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const PS1_FILES = collectPs1(PS_DIR);

test('仓库中至少存在 3 个待分发的 .ps1（防止 glob 失效导致守卫空转）', () => {
  assert.ok(
    PS1_FILES.length >= 3,
    `只找到 ${PS1_FILES.length} 个 .ps1，守卫可能已失效（目录：${PS_DIR}）`,
  );
});

for (const file of PS1_FILES) {
  const rel = file.slice(ROOT.length);

  test(`${rel}：以 UTF-8 BOM 开头（PowerShell 5.1 兼容底线）`, () => {
    const buf = readFileSync(file);
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    assert.ok(
      hasBom,
      `${rel} 缺少 UTF-8 BOM。5.1 会按 ANSI/GBK 解析无 BOM 脚本，` +
        `中文注释将破坏字符串边界并导致 ParseError。` +
        `修法：把 U+FEFF 写进文件头（BOM 对 .ps1 是必需，对 JSON 则相反）。`,
    );
  });

  test(`${rel}：内容是合法 UTF-8（无 GBK 混入的二次编码痕迹）`, () => {
    const text = readFileSync(file, 'utf8');
    // U+FFFD = 解码失败替换符；出现即说明混入过非 UTF-8 字节
    assert.ok(!text.includes('\uFFFD'), `${rel} 含非法 UTF-8 字节`);
    // 去掉 BOM 再校验，避免把 BOM 当成正文
    assert.ok(text.replace(/^\uFEFF/, '').length > 0, `${rel} 去掉 BOM 后为空文件`);
  });
}

test('install.ps1：关键参数与提示文案完好（防打包时被截断/改写）', () => {
  const text = readFileSync(join(PS_DIR, 'install.ps1'), 'utf8');
  for (const token of [
    'param(',
    '$AllowInput',
    'New-ScheduledTask',
    'New-NetFirewallRule',
    'UTF8Encoding($false)', // 写 agent.json 必须无 BOM —— 与 .ps1 自身要 BOM 恰好相反
  ]) {
    assert.ok(text.includes(token), `install.ps1 丢失关键片段：${token}`);
  }
});

// ── .cmd 侧守卫 ───────────────────────────────────────────────────────────────
// 编码方向与 .ps1 **相反**：.cmd 必须纯 ASCII。
// CMD.exe 的代码页（中文 Windows = 936/GBK）无法可靠往返 UTF-8，
// .cmd 里的中文会变乱码，甚至把后续命令截断（真机 2026-10-04 的教训同源）。
// 中文提示一律交给带 BOM 的 .ps1 输出。

const CMD_FILES = collectCmd(PS_DIR);

test('仓库中至少存在 2 个 .cmd（防止 glob 失效导致守卫空转）', () => {
  assert.ok(CMD_FILES.length >= 2, `只找到 ${CMD_FILES.length} 个 .cmd，守卫可能已失效`);
});

for (const file of CMD_FILES) {
  const rel = file.slice(ROOT.length);
  test(`${rel}：纯 ASCII（CMD 代码页安全）`, () => {
    const buf = readFileSync(file);
    const idx = [...buf].findIndex((b) => b > 0x7f);
    assert.equal(
      idx, -1,
      `${rel} 第 ${idx} 字节起含非 ASCII —— CMD 代码页（936/GBK）无法可靠处理，` +
        `中文提示请交给 .ps1（它带 BOM，5.1 能正确读）。`,
    );
  });

  test(`${rel}：行尾是 CRLF（CMD 在部分环境下对 LF 行为不一致）`, () => {
    const text = readFileSync(file, 'latin1');
    // 允许文件内完全没有换行（极短脚本），但只要有换行就必须是 CRLF
    const lfOnly = text.replace(/\r\n/g, '').includes('\n');
    assert.equal(lfOnly, false, `${rel} 存在裸 LF 行尾，请统一为 CRLF`);
  });
}

test('install.cmd：自提权 + 读 PSK.txt + 调 install.ps1 三段齐全', () => {
  const text = readFileSync(join(PS_DIR, 'install.cmd'), 'latin1');
  for (const token of [
    'net session',            // 探测是否已管理员
    'Start-Process',          // 自提权（UAC）
    'PSK.txt',                // 读包内密钥
    'install.ps1',            // 调底层安装
    '-ExecutionPolicy Bypass',
    '-AllowInput',
  ]) {
    assert.ok(text.includes(token), `install.cmd 丢失关键片段：${token}`);
  }
  // 提权后必须 exit，不能继续用非管理员权限往下跑
  assert.ok(/Verb RunAs[\s\S]{0,200}exit \/b/.test(text), '提权后应立即退出本进程');
});

test('control.cmd：菜单项与 control.ps1 的 ValidateSet 一一对应', () => {
  const cmd = readFileSync(join(PS_DIR, 'control.cmd'), 'latin1');
  const ps1 = readFileSync(join(PS_DIR, 'control.ps1'), 'utf8');

  // 从 control.ps1 的 ValidateSet 里取出合法 action
  const m = ps1.match(/ValidateSet\(([^)]*)\)/);
  assert.ok(m, 'control.ps1 必须用 ValidateSet 约束 -Action');
  const actions = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

  // control.cmd 里 call :RUN <action> 的每个 action 都必须在 ValidateSet 内
  const called = [...cmd.matchAll(/call :RUN (\S+)/g)].map((x) => x[1]);
  assert.ok(called.length >= 5, `control.cmd 只发现 ${called.length} 个菜单项，可能正则失配`);
  for (const a of called) {
    assert.ok(actions.includes(a), `control.cmd 调用了 control.ps1 不支持的 action: ${a}`);
  }
  // 反向：ps1 支持的 action 都应在菜单里可达
  for (const a of actions) {
    assert.ok(called.includes(a), `control.ps1 支持的 ${a} 在 control.cmd 菜单里没有入口`);
  }
});

test('control.ps1：状态检查覆盖任务/进程/端口/配置四项', () => {
  const text = readFileSync(join(PS_DIR, 'control.ps1'), 'utf8');
  for (const token of [
    'Get-ScheduledTask',
    'Get-Process',
    'Get-NetTCPConnection',
    'agent.json',
  ]) {
    assert.ok(text.includes(token), `control.ps1 状态检查缺少：${token}`);
  }
  // 启动后必须轮询端口，而不是盲等固定秒数
  assert.ok(
    /for \(\$i = 0; \$i -lt 15/.test(text),
    '启动后应轮询端口真正监听（最多 15s），而非盲等',
  );
});

test('数据目录：install.ps1 与 control.ps1 都认 NODEAGENT_HOME（须与 agent 侧一致）', () => {
  // apps/agent/src/config.ts: agentDir() = NODEAGENT_HOME ?? ~/.nodeagent
  // 若 ps1 写死 USERPROFILE 而计划任务环境设了 NODEAGENT_HOME，
  // 就会「配置写 A、读取 B」→ 装完连不上（E_AUTH_FAILED）。
  for (const f of ['install.ps1', 'control.ps1']) {
    const text = readFileSync(join(PS_DIR, f), 'utf8');
    assert.ok(
      text.includes('NODEAGENT_HOME'),
      `${f} 未处理 NODEAGENT_HOME —— 必须与 apps/agent/src/config.ts 的 agentDir() 保持一致`,
    );
  }
});

test('控制台脚本：pause 均被 CI 守卫（否则 CI 会永久挂起）', () => {
  for (const f of ['install.cmd', 'control.cmd']) {
    const text = readFileSync(join(PS_DIR, f), 'latin1');
    const bare = text.split('\r\n').filter((l) => /^\s*pause\s*$/i.test(l));
    assert.equal(
      bare.length, 0,
      `${f} 有 ${bare.length} 处裸 pause，CI（CI=true）会卡死。统一用 "if not defined CI pause"。`,
    );
  }
});

test('install.cmd：管理员探测用 fltmc 而非 net session（不依赖 Server 服务）', () => {
  const text = readFileSync(join(PS_DIR, 'install.cmd'), 'latin1');
  // net session 依赖 Server 服务，部分 Windows 版本该服务停用 → 已提权却被判为未提权 → 死循环 UAC
  assert.ok(/^\s*fltmc\s*>nul/m.test(text), 'install.cmd 应用 fltmc 探测管理员权限');
  assert.ok(
    !/^\s*net\s+session\s*>nul/m.test(text),
    'install.cmd 不应再用 net session 探测（依赖 Server 服务，可能误判）',
  );
});
