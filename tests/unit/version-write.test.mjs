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
// ③ 编排：对临时目录里的**真实文件**跑一遍
// ---------------------------------------------------------------------------

function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), 'na-version-'));
  const tauriDir = join(dir, 'apps', 'console', 'src-tauri');
  mkdirSync(tauriDir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'nodeagent', version: '2.0.2' }, null, 2)}\n`);
  writeFileSync(join(tauriDir, 'tauri.conf.json'), `${JSON.stringify({ productName: 'x', version: '2.0.2' }, null, 2)}\n`);
  writeFileSync(
    join(tauriDir, 'Cargo.toml'),
    ['[package]', 'name = "nodeagent-console"', 'version = "2.0.2"', 'edition = "2021"', ''].join('\n'),
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
    ].join('\n'),
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
  for (const f of t.cargoTomlFiles) {
    const m = /\[package\][\s\S]*?^version\s*=\s*"([^"]*)"/m.exec(readFileSync(join(repoRoot, f), 'utf8'));
    versions.set(f, m?.[1]);
  }
  for (const f of t.cargoLockFiles) {
    const m = /name\s*=\s*"nodeagent-console"\nversion\s*=\s*"([^"]*)"/.exec(readFileSync(join(repoRoot, f), 'utf8'));
    versions.set(f, m?.[1]);
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
