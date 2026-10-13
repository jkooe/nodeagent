/**
 * 版本号写入（`scripts/lib/version-write.mjs`）的行为守卫 + 发版漂移守卫。
 *
 * ⚠️ 背景（2026-10-13）：`scripts/release.mjs` 原先只改 `package.json` + `tauri.conf.json`，
 *    于是 `apps/console/src-tauri/{Cargo.toml,Cargo.lock}` 里的版本号**发版后会滞留**。
 *    `release.mjs patch --dry-run` 实证：报「8 个 package.json + 1 个 tauri.conf.json」，
 *    Cargo 两处**完全不在视野里** —— 而它们同样写着 2.0.2，会与 tauri.conf.json 悄悄分叉。
 *    分叉不报错（Tauri 打包以 tauri.conf.json 为准）→ 属最难发现的漂移。
 *
 * 为什么这样测（铁律「守卫要落在最终产物字节上」）：
 *    首版若断言「release.mjs 源码里出现过 Cargo.toml 字样」，注入故障都不会变红。
 *    本文件改为：在临时目录里铺**真实文件**（含 git init + git add，让 `git ls-files` 真的工作），
 *    跑一遍写入，再**读回文件内容**断言 —— 这是能被注入故障打红的守卫。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCargoPackageName,
  readCargoTomlVersion,
  setCargoLockVersion,
  setCargoTomlVersion,
  versionTargets,
  writeVersionEverywhere,
} from '../../scripts/lib/version-write.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

// ---------------------------------------------------------------------------
// ① 纯函数：Cargo.toml
// ---------------------------------------------------------------------------

test('Cargo.toml：只改 [package] 段的 version', () => {
  const src = [
    '[package]',
    'name = "nodeagent-console"',
    'version = "2.0.2"',
    'edition = "2021"',
    '',
    '[build-dependencies]',
    'tauri-build = { version = "2", features = [] }',
    '',
    // 关键陷阱：非 [package] 段里**同样存在** `version = "2.0.2"` 这种独占一行的写法。
    // 不做段落限定的话，全文盲替换会把它一起改坏（TOML 合法，改完不报错）。
    '[package.metadata.deb]',
    'version = "2.0.2"',
    '',
  ].join('\n');
  const out = setCargoTomlVersion(src, '9.9.9', 'Cargo.toml');
  assert.match(out, /\[package\]\nname = "nodeagent-console"\nversion = "9\.9\.9"\n/);
  assert.equal(out.match(/version = "2\.0\.2"/g)?.length, 1, '非 [package] 段的那处必须原样保留');
  assert.equal(out.match(/version = "9\.9\.9"/g)?.length, 1, '被改的只能有一处');
});

test('Cargo.toml：缺 [package] version 时大声失败，不静默跳过', () => {
  assert.throws(() => setCargoTomlVersion('[package]\nname = "x"\n', '9.9.9', 'Cargo.toml'), /找不到 version 行/);
});

test('Cargo.toml：读到 crate 名（用于去 Cargo.lock 里定位同名包）', () => {
  assert.equal(readCargoPackageName('[package]\nname = "nodeagent-console"\nversion = "2.0.2"\n'), 'nodeagent-console');
  assert.equal(readCargoPackageName('[dependencies]\nname = "not-this"\n'), null);
});

// ---------------------------------------------------------------------------
// ② 纯函数：Cargo.lock
// ---------------------------------------------------------------------------

test('Cargo.lock：只改指定 crate 的版本，同名依赖版本一律不动', () => {
  const src = [
    'version = 4',
    '',
    '[[package]]',
    'name = "nodeagent-console"',
    'version = "2.0.2"',
    'dependencies = [',
    ' "thiserror",',
    ']',
    '',
    '[[package]]',
    'name = "proc-macro-crate"',
    'version = "2.0.2"',
    '',
    '[[package]]',
    'name = "statuses"',
    'version = "2.0.2"',
    '',
  ].join('\n');
  const { text, changed } = setCargoLockVersion(src, 'nodeagent-console', '9.9.9');
  assert.equal(changed, true);
  assert.match(text, /name = "nodeagent-console"\nversion = "9\.9\.9"/);
  assert.equal(
    text.match(/version = "2\.0\.2"/g)?.length,
    2,
    '两个同名版本的依赖（proc-macro-crate / statuses）必须原样保留',
  );
  // 顶部那个 `version = 4`（lock 格式版本）也不能被动
  assert.match(text, /^version = 4\n/);
});

test('Cargo.lock：找不到该 crate 时返回原文并报 changed=false（未构建的 checkout）', () => {
  const { text, changed } = setCargoLockVersion('[[package]]\nname = "other"\nversion = "1.0.0"\n', 'nodeagent-console', '9.9.9');
  assert.equal(changed, false);
  assert.match(text, /name = "other"\nversion = "1\.0\.0"/);
});

// ---------------------------------------------------------------------------
// ②' 换行符无关性（CRLF）—— 2026-10-13 Windows CI 实证后补
//
// 为什么必须单列：Windows 上 `actions/checkout` 默认 `core.autocrlf=true`，
// 工作区文本是 CRLF。把 `\n` 写死进正则会在 CRLF 上**静默失配**，
// 而调用方普遍把 `undefined` 当成「没这个字段」→ **不报错、只是悄悄没改**。
// CI 报错原文：`undefined  apps/console/src-tauri/Cargo.lock`（其余 10 处均为 2.0.3）。
// ---------------------------------------------------------------------------

test('Cargo.lock：CRLF 检出下同样读出旧值、改对目标 crate、换行符逐字节保真', () => {
  const lf = 'version = 4\n\n[[package]]\nname = "nodeagent-console"\nversion = "2.0.3"\n\n[[package]]\nname = "statuses"\nversion = "2.0.2"\n';
  const crlf = lf.replaceAll('\n', '\r\n');

  // 读旧值：LF / CRLF 必须给出**同一个**结果（这正是 Windows 上失效的那一步）
  assert.equal(setCargoLockVersion(lf, 'nodeagent-console', '9.9.9').before, '2.0.3');
  assert.equal(
    setCargoLockVersion(crlf, 'nodeagent-console', '9.9.9').before,
    '2.0.3',
    'CRLF 下读不出旧值 → 发版会静默跳过 Cargo.lock（Windows CI 实证失败点）',
  );

  const r = setCargoLockVersion(crlf, 'nodeagent-console', '9.9.9');
  assert.equal(r.changed, true);
  assert.match(r.text, /name = "nodeagent-console"\r\nversion = "9\.9\.9"\r\n/);
  assert.match(r.text, /name = "statuses"\r\nversion = "2\.0\.2"/, '依赖版本不得被连带改掉');
  assert.ok(!/[^\r]\n/.test(r.text), '换行符必须保持 CRLF —— 悄悄转成 LF 会污染整个文件的 diff');
});

test('Cargo.toml：CRLF 检出下 version 读写一致，且不碰非 [package] 段', () => {
  const lf = [
    '[package]',
    'name = "nodeagent-console"',
    'version = "2.0.3"',
    'edition = "2021"',
    '',
    '[package.metadata.deb]',
    'version = "2.0.3"',
    '',
  ].join('\n');
  const crlf = lf.replaceAll('\n', '\r\n');

  assert.equal(readCargoTomlVersion(crlf), '2.0.3', 'CRLF 下必须读得出 [package] 的 version');
  assert.equal(readCargoPackageName(crlf), 'nodeagent-console');

  const out = setCargoTomlVersion(crlf, '9.9.9', 'Cargo.toml');
  assert.match(out, /\[package\]\r\nname = "nodeagent-console"\r\nversion = "9\.9\.9"\r\n/);
  assert.equal(out.match(/version = "2\.0\.3"/g)?.length, 1, '非 [package] 段那处必须原样保留');
  assert.ok(!/[^\r]\n/.test(out), '换行符必须保持 CRLF');
});

// ---------------------------------------------------------------------------
// ③ 编排：对临时目录里的**真实文件**跑一遍
// ---------------------------------------------------------------------------

/**
 * 铺一份「真实文件」的临时仓库。
 *
 * `crlf: true` 模拟 **Windows 检出**（`actions/checkout` 默认 `core.autocrlf=true`
 * 会让工作区文本变成 CRLF）。2026-10-13 CI 实证：CRLF 下 Cargo.lock 的版本号
 * 曾读出 `undefined`，生产代码据此**静默跳过**该文件 —— 必须能被本地复现（铁律 4）。
 */
function scaffold({ crlf = false } = {}) {
  const eol = crlf ? '\r\n' : '\n';
  const dir = mkdtempSync(join(tmpdir(), 'na-version-'));
  const tauriDir = join(dir, 'apps', 'console', 'src-tauri');
  mkdirSync(tauriDir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'nodeagent', version: '2.0.2' }, null, 2)}${eol}`);
  writeFileSync(join(tauriDir, 'tauri.conf.json'), `${JSON.stringify({ productName: 'x', version: '2.0.2' }, null, 2)}${eol}`);
  writeFileSync(
    join(tauriDir, 'Cargo.toml'),
    ['[package]', 'name = "nodeagent-console"', 'version = "2.0.2"', 'edition = "2021"', ''].join(eol),
  );
  writeFileSync(
    join(tauriDir, 'Cargo.lock'),
    [
      'version = 4',
      '',
      '[[package]]',
      'name = "nodeagent-console"',
      'version = "2.0.2"',
      '',
      '[[package]]',
      'name = "statuses"',
      'version = "2.0.2"',
      '',
    ].join(eol),
  );
  // 必须真的进一次 git 索引 —— `versionTargets` 走 `git ls-files`，
  // 只认「已入库文件」，否则临时目录里它会返回空集，测试就会假绿。
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

test('四处版本号一起改：package.json + tauri.conf.json + Cargo.toml + Cargo.lock', () => {
  const dir = scaffold();
  const res = writeVersionEverywhere(dir, '9.9.9');

  const files = res.changed.map((c) => c.file);
  assert.deepEqual(files.sort(), [
    'apps/console/src-tauri/Cargo.lock',
    'apps/console/src-tauri/Cargo.toml',
    'apps/console/src-tauri/tauri.conf.json',
    'package.json',
  ].sort());
  assert.equal(res.skipped.length, 0, `不该有跳过项：${res.skipped.join(', ')}`);

  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '9.9.9');
  assert.equal(JSON.parse(readFileSync(join(dir, 'apps/console/src-tauri/tauri.conf.json'), 'utf8')).version, '9.9.9');
  assert.match(readFileSync(join(dir, 'apps/console/src-tauri/Cargo.toml'), 'utf8'), /version = "9\.9\.9"/);
  const lock = readFileSync(join(dir, 'apps/console/src-tauri/Cargo.lock'), 'utf8');
  assert.match(lock, /name = "nodeagent-console"\nversion = "9\.9\.9"/);
  assert.match(lock, /name = "statuses"\nversion = "2\.0\.2"/, '依赖版本不得被连带改掉');

  // JSON 写回后仍要是「2 空格缩进 + 尾换行」（否则会污染 diff）
  const rawPkg = readFileSync(join(dir, 'package.json'), 'utf8');
  assert.ok(rawPkg.endsWith('}\n') && rawPkg.includes('\n  "version"'), 'JSON 格式应与既有文件一致');
});

test('dry-run 一个字节都不改', () => {
  const dir = scaffold();
  const before = readFileSync(join(dir, 'apps/console/src-tauri/Cargo.toml'), 'utf8');
  const res = writeVersionEverywhere(dir, '9.9.9', { dryRun: true });
  assert.equal(res.changed.length, 4);
  assert.equal(readFileSync(join(dir, 'apps/console/src-tauri/Cargo.toml'), 'utf8'), before);
  assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /"version": "2\.0\.2"/);
});

// ---------------------------------------------------------------------------
// ③' 编排层 + CRLF：这是**能打红生产缺陷**的那条守卫
//
// 前一条 CRLF 测试只证「纯函数对 CRLF 免疫」；但 Windows 上翻车的是**编排层**
// ——它曾另写一条正则读旧值，失配后把 Cargo.lock 记进 `skipped` 直接跳过。
// 所以必须在 CRLF 工作区上真跑一遍 `writeVersionEverywhere`，再读回文件断言。
// ---------------------------------------------------------------------------

test('CRLF 工作区（Windows 检出）：四处版本号照样全改，且 skipped 必须为空', () => {
  const dir = scaffold({ crlf: true });
  const res = writeVersionEverywhere(dir, '9.9.9');

  assert.deepEqual(
    res.changed.map((c) => c.file).sort(),
    [
      'apps/console/src-tauri/Cargo.lock',
      'apps/console/src-tauri/Cargo.toml',
      'apps/console/src-tauri/tauri.conf.json',
      'package.json',
    ].sort(),
  );
  assert.equal(
    res.skipped.length,
    0,
    `CRLF 下不得有跳过项（Windows CI 上 Cargo.lock 曾被静默跳过）：${res.skipped.join(', ')}`,
  );

  const lock = readFileSync(join(dir, 'apps/console/src-tauri/Cargo.lock'), 'utf8');
  assert.match(lock, /name = "nodeagent-console"\r\nversion = "9\.9\.9"/, 'Cargo.lock 必须真的被改到');
  assert.match(lock, /name = "statuses"\r\nversion = "2\.0\.2"/, '依赖版本不得被连带改掉');
  assert.ok(!/[^\r]\n/.test(lock), 'Cargo.lock 的换行符必须保持 CRLF');

  const toml = readFileSync(join(dir, 'apps/console/src-tauri/Cargo.toml'), 'utf8');
  assert.match(toml, /version = "9\.9\.9"/);
  assert.ok(!/[^\r]\n/.test(toml), 'Cargo.toml 的换行符必须保持 CRLF');
});

// ---------------------------------------------------------------------------
// ④ 发版漂移守卫：真实仓库里 11 处版本号必须互一致
// ---------------------------------------------------------------------------

test('仓库内全部版本号互一致（发版漏项会在这里变红）', () => {
  const t = versionTargets(repoRoot);

  // 防「枚举失效 → 空集通过」的假绿：数量不对就直接失败
  assert.equal(t.pkgFiles.length, 8, `package.json 应枚举到 8 个，实际 ${t.pkgFiles.length}`);
  assert.equal(t.tauriConfFiles.length, 1, 'tauri.conf.json 应枚举到 1 个');
  assert.equal(t.cargoTomlFiles.length, 1, 'Cargo.toml 应枚举到 1 个');
  assert.equal(t.cargoLockFiles.length, 1, 'Cargo.lock 应枚举到 1 个');

  const versions = new Map();
  for (const f of [...t.pkgFiles, ...t.tauriConfFiles]) {
    versions.set(f, JSON.parse(readFileSync(join(repoRoot, f), 'utf8')).version);
  }
  // ⚠️ 读旧值一律走**生产函数**，不在这里另写一条正则。
  //    2026-10-13 Windows CI 实证：本文件曾自己写 `name…\nversion…` 的正则，
  //    CRLF 检出上返回 undefined → 报「版本号分叉」；而**生产代码里有同一条正则**，
  //    真实后果是发版时静默跳过 Cargo.lock（比测试变红严重得多）。
  //    守卫与生产必须共用同一份解析，否则守卫只能验证「两份实现是否一致」。
  for (const f of t.cargoTomlFiles) {
    versions.set(f, readCargoTomlVersion(readFileSync(join(repoRoot, f), 'utf8')));
  }
  for (const f of t.cargoLockFiles) {
    const { before } = setCargoLockVersion(
      readFileSync(join(repoRoot, f), 'utf8'),
      'nodeagent-console',
      '__probe__',
    );
    versions.set(f, before);
  }

  const distinct = new Set(versions.values());
  const dump = [...versions].map(([f, v]) => `  ${v}  ${f}`).join('\n');
  assert.equal(distinct.size, 1, `版本号出现分叉（发版时漏改了某个清单）：\n${dump}`);
  assert.ok(!distinct.has(undefined), `有清单读不出版本号：\n${dump}`);
});

test('发版脚本用「实际改写清单」做脏文件白名单，不得回退成手写文件名列表', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'release.mjs'), 'utf8');
  assert.match(src, /writeVersionEverywhere/, 'release.mjs 必须走 lib/version-write.mjs');
  assert.match(
    src,
    /const allowedDirty = new Set\(changed\.map/,
    '白名单必须取自写入结果（手写列表会与写入逻辑漂移）',
  );
  assert.doesNotMatch(
    src,
    /allowedDirty = new Set\(\[\.\.\.pkgFiles/,
    '不得再引用已删除的 pkgFiles/tauriConfFiles 变量',
  );
});
