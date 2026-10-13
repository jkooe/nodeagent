/**
 * 版本号写入 —— 发版脚本与测试**共用**的唯一实现。
 *
 * 为什么单独成模块（2026-10-13）：
 *   `scripts/release.mjs` 原先只覆盖 `package.json` + `tauri.conf.json`，
 *   但 `apps/console/src-tauri/Cargo.toml` 与 `Cargo.lock` 里**同样存着版本号**。
 *   发版后这两处会**滞留旧版本**，与 `tauri.conf.json` 悄悄分叉 ——
 *   而分叉不报错（Tauri 打包以 `tauri.conf.json` 为准），属于最难发现的那类漂移。
 *
 * 为什么把它从脚本里抽出来：
 *   铁律「守卫要落在**最终产物字节**上」。若版本写入逻辑埋在 `release.mjs` 里，
 *   单测只能断言「源码里出现过某个字符串」—— 那种守卫注入故障都不会变红。
 *   抽成纯函数后，测试可以对**临时目录里的真实文件**跑一遍再断言文件内容。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 拿 `git ls-files` 的结果（只认已入库文件 —— 未入库的构建产物不该被改版本号）。 */
function lsFiles(root, pattern) {
  try {
    return execFileSync('git', ['ls-files', pattern], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 枚举「存着版本号、需要一起改」的文件。
 * Cargo 相关文件用 `optional: true` 标记：没有 Rust 侧时不该让发版直接失败。
 */
export function versionTargets(root = process.cwd()) {
  const pkgFiles = ['package.json'];
  for (const f of lsFiles(root, '*package.json')) {
    if (f === 'package.json' || f.includes('node_modules')) continue;
    pkgFiles.push(f);
  }
  return {
    pkgFiles,
    tauriConfFiles: lsFiles(root, '*src-tauri/tauri.conf.json'),
    cargoTomlFiles: lsFiles(root, '*src-tauri/Cargo.toml'),
    cargoLockFiles: lsFiles(root, '*src-tauri/Cargo.lock'),
  };
}

/**
 * 改 `Cargo.toml` 的版本号 —— **只在 `[package]` 段内**改。
 *
 * 为什么要限定段落：`Cargo.toml` 里 `version = "..."` 这个形状还出现在别处
 * （例如 `[dependencies]` 里 `some-crate = { version = "1" }` 是行内的，
 * 但某些写法会把 `version = "..."` 单独成行）。不做限定就成了「全文盲替换」，
 * 会改坏依赖约束 —— 那比不改更糟。
 */
export function setCargoTomlVersion(text, version, label = 'Cargo.toml') {
  const lines = text.split('\n');
  let inPackage = false;
  let done = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[')) {
      inPackage = trimmed === '[package]';
      continue;
    }
    if (!inPackage || done) continue;
    if (/^version\s*=/.test(trimmed)) {
      lines[i] = lines[i].replace(/^(\s*version\s*=\s*")[^"]*(".*)$/, `$1${version}$2`);
      done = true;
    }
  }
  if (!done) throw new Error(`${label} 的 [package] 段里找不到 version 行`);
  return lines.join('\n');
}

/** 从 `Cargo.toml` 的 `[package]` 段读 crate 名（用于去 `Cargo.lock` 里定位同一个包）。 */
export function readCargoPackageName(text) {
  const lines = text.split('\n');
  let inPackage = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inPackage = trimmed === '[package]';
      continue;
    }
    if (!inPackage) continue;
    const m = /^name\s*=\s*"([^"]*)"$/.exec(trimmed);
    if (m) return m[1];
  }
  return null;
}

/**
 * 改 `Cargo.lock` 里**指定 crate** 的版本号。
 *
 * `Cargo.lock` 是「按 `[[package]]` 分块、块内 `name` 后跟 `version`」的结构，
 * 且全文散布着**大量同名依赖版本**（`thiserror 2.0.21`、`proc-macro-crate 2.0.2` …）。
 * 直接 `replace('2.0.2', ...)` 会把依赖版本一起改坏 —— 所以必须按块定位。
 * 找不到该包时返回原文本（未构建过的 checkout 里可能没有），不报错。
 */
export function setCargoLockVersion(text, pkgName, version) {
  const lines = text.split('\n');
  let currentName = null;
  let done = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '[[package]]') {
      currentName = null;
      continue;
    }
    const nameMatch = /^name\s*=\s*"([^"]*)"$/.exec(trimmed);
    if (nameMatch) {
      currentName = nameMatch[1];
      continue;
    }
    if (currentName === pkgName && !done && /^version\s*=/.test(trimmed)) {
      lines[i] = lines[i].replace(/^(\s*version\s*=\s*")[^"]*(".*)$/, `$1${version}$2`);
      done = true;
    }
  }
  return { text: lines.join('\n'), changed: done };
}

/**
 * 把版本号写到**全部**存放它的地方。
 *
 * @returns {{ changed: Array<{file:string, before:string, kind:string}>, skipped: string[] }}
 */
export function writeVersionEverywhere(root, version, { dryRun = false } = {}) {
  const targets = versionTargets(root);
  const changed = [];
  const skipped = [];

  // ---- JSON 类：package.json 与 tauri.conf.json 同构，写回时保持 2 空格缩进 ----
  for (const rel of [...targets.pkgFiles, ...targets.tauriConfFiles]) {
    const abs = join(root, rel);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch {
      skipped.push(`${rel}（读不出 JSON）`);
      continue;
    }
    if (!parsed.version) {
      skipped.push(`${rel}（无 version 字段）`);
      continue;
    }
    changed.push({ file: rel, before: parsed.version, kind: 'json' });
    if (dryRun) continue;
    parsed.version = version;
    writeFileSync(abs, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  // ---- Cargo.toml + Cargo.lock：成对处理（lock 里要按 crate 名定位） ----
  for (const rel of targets.cargoTomlFiles) {
    const abs = join(root, rel);
    const text = readFileSync(abs, 'utf8');
    const before = /\[package\][\s\S]*?^version\s*=\s*"([^"]*)"/m.exec(text)?.[1];
    const crateName = readCargoPackageName(text);
    changed.push({ file: rel, before: before ?? '?', kind: 'cargo-toml' });
    if (!dryRun) writeFileSync(abs, setCargoTomlVersion(text, version, rel));

    if (!crateName) continue;
    const lockRel = targets.cargoLockFiles.find((f) => f.startsWith(rel.slice(0, rel.length - 'Cargo.toml'.length)));
    if (!lockRel) continue;
    const lockAbs = join(root, lockRel);
    const lockText = readFileSync(lockAbs, 'utf8');
    const lockBefore = new RegExp(`name\\s*=\\s*"${crateName}"\\nversion\\s*=\\s*"([^"]*)"`).exec(lockText)?.[1];
    if (lockBefore === undefined) {
      skipped.push(`${lockRel}（未找到 crate ${crateName}，可能尚未构建）`);
      continue;
    }
    changed.push({ file: lockRel, before: lockBefore, kind: 'cargo-lock' });
    if (dryRun) continue;
    const result = setCargoLockVersion(lockText, crateName, version);
    if (result.changed) writeFileSync(lockAbs, result.text);
  }

  return { changed, skipped };
}
