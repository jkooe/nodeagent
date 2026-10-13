/**
 * L-01 守卫：CLI 的 `--timeout` 曾经**静默失效**。
 *
 * ⚠️ 背景（真机实测 2026-10-13，P2）：`--timeout` 没在 `parseArgs` 的 `options` 里声明，
 *    而解析器开了 `strict: false` → 未声明选项被当成 **boolean**（`values.timeout = true`），
 *    它的值 `30000` 掉进 **positionals**。双重后果：
 *      ① 超时静默不生效（命令按默认超时跑）；
 *      ② **位置参数被污染** —— 可能把子命令 / 主机名解析错。
 *    而帮助文本与 `await` 命令用的正是 `--timeout`，所以这是「文档让你用、实际不管用」。
 *
 * 本文件钉两件事：① 两个写法都生效且不污染 positionals；
 * ② **帮助文本里出现的每个 `--flag` 都必须在 options 里声明**（这一类病的总闸）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fsMod from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions } from '../../apps/cli/dist/options.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const OPTIONS_TS = join(repoRoot, 'apps', 'cli', 'src', 'options.ts');
const CLI_SRC = join(repoRoot, 'apps', 'cli', 'src');

test('L-01：`--timeout 30000` 生效，且不污染位置参数', () => {
  const { opts, positionals } = parseOptions(['--timeout', '30000']);
  assert.equal(opts.timeoutMs, '30000', '--timeout 的值必须落到 timeoutMs（原来是静默丢弃）');
  assert.deepEqual(positionals, [], `--timeout 的值不得掉进 positionals：${JSON.stringify(positionals)}`);
});

test('L-01：与子命令混用时位置参数仍正确', () => {
  const { opts, positionals } = parseOptions(['await', '--condition', 'window', '--timeout', '30000']);
  assert.equal(opts.timeoutMs, '30000');
  assert.deepEqual(positionals, ['await'], '只有子命令应留在 positionals');
  assert.equal(opts.condition, 'window');
});

test('L-01：`--timeout-ms`（bg 命令的别名）仍然生效', () => {
  const { opts, positionals } = parseOptions(['bg', 'echo hi', '--timeout-ms', '5000']);
  assert.equal(opts.timeoutMs, '5000');
  assert.deepEqual(positionals, ['bg', 'echo hi']);
});

test('L-01：两个写法同时给出时以 `--timeout` 为准（文档写法优先）', () => {
  const { opts } = parseOptions(['--timeout-ms', '1111', '--timeout', '2222']);
  assert.equal(opts.timeoutMs, '2222');
});

/** 从 options.ts 的 `options: {…}` 块里取出声明过的选项名。 */
function declaredOptionNames() {
  // ⚠️ 必须**先去注释**：本仓库的注释里常引用被删掉的旧声明（例如
  //    `// timeout: { type: 'string' },` 这种「曾经漏了、现已补上」的说明）。
  //    不去注释就会把「注释里的声明」当成真的声明 → 守卫假阴性。
  //    （注入故障实测：不去注释时，把声明注释掉守卫仍然全绿。）
  const src = readFileSync(OPTIONS_TS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const start = src.indexOf('options: {');
  assert.ok(start >= 0, 'options.ts 里找不到 options: {');
  const end = src.indexOf('allowPositionals', start);
  assert.ok(end > start, '找不到 options 块的结束位置');
  const block = src.slice(start, end);
  const names = new Set();
  for (const m of block.matchAll(/(?:'([\w-]+)'|"([\w-]+)"|([A-Za-z_][\w-]*))\s*:\s*\{\s*type\s*:/g)) {
    names.add(m[1] ?? m[2] ?? m[3]);
  }
  assert.ok(names.size > 30, `只解析出 ${names.size} 个选项，正则可能失配（需同步更新）`);
  return names;
}

/**
 * 取出 CLI 里**承诺过的**所有 `--flag`。
 *
 * ⚠️ 必须扫**全部** src，不能只扫 `help.ts`：L-01 的那条 `--timeout` 根本不在 `help.ts` 里，
 *    它只出现在 `cmd/gui.ts` 的 `fail('用法: … --timeout <ms> …')` 提示里。
 *    只扫 help.ts 的守卫**放过**了真缺陷（注入故障实测：把 timeout 声明注释掉，守卫仍全绿）。
 *    凡是「会出现在用户眼前的用法提示」都算承诺，故扫全目录。
 */
function promisedFlags() {
  const flags = new Set();
  for (const file of walkTs(CLI_SRC)) {
    // 去注释：注释里会讲「曾经漏了某某选项」，那不是承诺
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const m of text.matchAll(/--([A-Za-z][\w-]*)/g)) flags.add(m[1]);
  }
  return flags;
}

function walkTs(dir) {
  const { readdirSync, statSync } = fsMod;
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('L-01 总闸：用户可见的用法提示里每个 `--flag` 都必须在 parseArgs 里声明', () => {
  const declared = declaredOptionNames();
  const promised = promisedFlags();
  assert.ok(promised.size > 30, `只从 CLI 源码里取到 ${promised.size} 个选项名，正则可能失配`);
  const missing = [...promised].filter((f) => !declared.has(f)).sort();
  assert.deepEqual(
    missing,
    [],
    `用法提示承诺了但 parseArgs 未声明的选项（会静默失效 + 污染 positionals）：\n  ${missing.join('\n  ')}`,
  );
});
