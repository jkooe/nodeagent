/**
 * 安全字面量（`util/quote.ts`）的行为守卫 + W-01 根因的**源码形态**守卫。
 *
 * ⚠️ 背景（P0，真机实测 2026-10-13）：`window.focus` 把 `JSON.stringify(title)` 插进
 *    PowerShell 双引号串，payload 直接执行了任意命令 —— 而接口**还返回「正常的业务错误」**，
 *    调用方完全看不出异常（最险的正是「静默」）。
 *    根因有两条：PS 里 `\` 不是转义符；PS 双引号串会插值 `$(...)`。
 *    所以本文件测两件事：
 *      ① `psLit`/`shLit` 的行为（唯一正确的字面量构造方式）；
 *      ② 全仓**不得**再把 `${JSON.stringify(…)}` 拼进命令串（形态守卫，防止回归）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  psLit,
  psLitArray,
  shLit,
  assertSingleQuotedLiteral,
  isSafeBareWindowsPathArg,
} from '../../apps/agent/dist/util/quote.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const AGENT_SRC = join(repoRoot, 'apps', 'agent', 'src');

// ---------------------------------------------------------------------------
// ① 行为
// ---------------------------------------------------------------------------

test('psLit：单引号翻倍，其余字符（$ / 反引号 / 反斜杠）一律原样保留', () => {
  assert.equal(psLit("a'b"), "'a''b'");
  // 关键：**不做**任何反斜杠转义（PS 里 `\` 不是转义符，转了反而是错的）
  assert.equal(psLit('C:\\tmp\\a'), "'C:\\tmp\\a'");
  // $ 与反引号在单引号串里不展开 —— 这是选择单引号的全部理由
  assert.equal(psLit('$env:PATH'), "'$env:PATH'");
  assert.equal(psLit('`n`t'), "'`n`t'");
  // 每个单引号都成对，形状自检通过
  assert.ok(assertSingleQuotedLiteral(psLit("x'; New-Item -Path /tmp/pwned; '")));
});

test('psLit：W-01 的原始 payload 不再能逃出字符串', () => {
  const payload = 'x"; New-Item -Path C:\\pwned -ItemType File; #';
  const lit = psLit(payload);
  // 形状：首尾单引号，且内部没有落单的单引号
  assert.ok(lit.startsWith("'") && lit.endsWith("'"));
  assert.ok(assertSingleQuotedLiteral(lit), `形状自检应通过：${lit}`);
  // 语义：把外层单引号剥掉，必须**一字不差**地还原原串 —— 说明没有任何字符被吞掉/被当语法
  assert.equal(lit.slice(1, -1), payload);
  // payload 里的 `"` 是被关在单引号里的普通字符；PS 单引号串不做插值与子表达式展开，
  // 所以 `$(…)` 这种形态也必须原样保留（这才是「逃不出去」的真正判据）
  const cmdSub = '$(touch /tmp/pwned)';
  assert.equal(psLit(cmdSub).slice(1, -1), cmdSub);
});

test('shLit：把单引号拆成 闭合→转义→重开，单引号内无任何展开', () => {
  assert.equal(shLit("a'b"), "'a'\\''b'");
  assert.equal(shLit('$(touch /tmp/pwned)'), "'$(touch /tmp/pwned)'");
  assert.equal(shLit('`id`'), "'`id`'");
});

test('psLitArray：数组字面量（空数组产出 @()）', () => {
  assert.equal(psLitArray(['a', "b'c"]), "@('a','b''c')");
  assert.equal(psLitArray([]), '@()');
});

test('assertSingleQuotedLiteral：未翻倍的单引号必须被判为不合法', () => {
  assert.ok(assertSingleQuotedLiteral("'a''b'"));
  // `'a'b'` 内部有一个落单的 `'` → 会把字符串提前闭合
  assert.equal(assertSingleQuotedLiteral("'a'b'"), false);
  assert.equal(assertSingleQuotedLiteral('a'), false);
  assert.equal(assertSingleQuotedLiteral("'a"), false);
});

test('isSafeBareWindowsPathArg：正常临时路径可裸拼，含元字符的必须被拒', () => {
  assert.ok(isSafeBareWindowsPathArg('C:\\Users\\u\\AppData\\Local\\Temp\\na-ps-x1\\run.ps1'));
  assert.ok(isSafeBareWindowsPathArg('/tmp/na-ps-x1/run.ps1'));
  for (const bad of [
    'C:\\a"b\\run.ps1',
    "C:\\a'b\\run.ps1",
    'C:\\a&b\\run.ps1',
    'C:\\a|b\\run.ps1',
    'C:\\a%b\\run.ps1',
    'C:\\a$b\\run.ps1',
    'C:\\a`b\\run.ps1',
    'C:\\a<b\\run.ps1',
    'C:\\dir\\',
    'C:\\a\nb\\run.ps1',
    '',
  ]) {
    assert.equal(isSafeBareWindowsPathArg(bad), false, `应判为不安全：${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// ② 形态守卫：全仓不得再把 JSON.stringify 拼进命令串
// ---------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 去掉注释后再扫。
 *
 * ⚠️ 必须去：本仓库大量注释在**讲解这个漏洞**，里面会原样出现 `replace(/'/g, "''")`
 *    这种形态。不去注释就会把「讲解」当成「犯案」——守卫自己错（铁律 3 的第 ② 类）。
 * 局限：只处理整行 `//` 与块注释；行尾 `//` 后面的内容仍会被扫到（宁可多报不漏报）。
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('W-01 根因守卫：源文件里不得出现 `${JSON.stringify(…)}` 拼进命令串', () => {
  // 命令串的判据词：出现任一，说明这一行在构造要交给 shell / PowerShell 的文本
  const SHELL_MARKERS = [
    'powershell',
    '-Command',
    '-File ',
    'osascript',
    'screencapture',
    'winget',
    'taskkill',
    'netstat',
    'tasklist',
    'cmd /c',
    'sh -c',
  ];
  const offenders = [];
  for (const file of walk(AGENT_SRC)) {
    const rel = file.slice(AGENT_SRC.length + 1);
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('${JSON.stringify(')) return;
      if (!SHELL_MARKERS.some((m) => line.includes(m))) return;
      offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `发现把 JSON.stringify 结果拼进命令串（W-01 同类，PS 里 \\ 不是转义符）：\n${offenders.join('\n')}`,
  );
});

test('W-01 根因守卫：PowerShell 单引号字面量必须来自 util/quote.ts（唯一真源）', () => {
  // 允许的实现文件（它们就是那份唯一真源 / 明确 re-export）
  const ALLOWED = new Set(['util/quote.ts', 'capabilities/network.ts']);
  const offenders = [];
  for (const file of walk(AGENT_SRC)) {
    const rel = file.slice(AGENT_SRC.length + 1);
    if (ALLOWED.has(rel)) continue;
    const text = stripComments(readFileSync(file, 'utf8'));
    // 手写 `replace(/'/g, "''")` 就是「又发明了一份 psLit」——两份实现必然漂移
    if (/replace\(\s*\/'\s*\/g\s*,\s*["'`]{1,2}''["'`]{1,2}\s*\)/.test(text)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `以下文件手写了 PS 单引号转义，应改用 util/quote.ts：\n${offenders.join('\n')}`);
});
