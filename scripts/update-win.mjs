#!/usr/bin/env node
/**
 * 一条命令更新被控端（Windows）：打包 → 部署 → 校验。
 *
 * 用法：
 *   node scripts/update-win.mjs [设备名] [--check] [--force]
 *   设备名省略时用控制端配置里的 current
 *
 * 等价于：
 *   pnpm pack:win
 *   nodeagent --node <设备名> deploy release/nodeagent-win-x64/agent.mjs
 *
 * 为什么要有它：手动流程要记住「先 pack、产物在 release/nodeagent-win-x64/、再 deploy」
 * 三个知识点，容易出错（尤其 pack 失败时 deploy 的是旧包 —— 真机踩过）。
 * 本脚本在 pack 之后**校验产物确已更新**，再部署。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const node = args.find((a) => !a.startsWith('--')) ?? '';

const bundle = join(root, 'release', 'nodeagent-win-x64', 'agent.mjs');
const before = existsSync(bundle) ? statSync(bundle).mtimeMs : 0;

console.log('=== ① 打包（pnpm pack:win）===');
execFileSync('pnpm', ['pack:win'], { cwd: root, stdio: 'inherit' });

if (!existsSync(bundle)) {
  console.error('✗ 打包后仍找不到产物:', bundle);
  process.exit(1);
}
const after = statSync(bundle).mtimeMs;
if (after === before) {
  console.error('✗ 产物时间戳未变化 —— 打包可能失败，拒绝部署旧包（这是刻意的保护）');
  process.exit(1);
}
console.log(`✓ 产物已更新：${bundle}`);

console.log('=== ② 部署到被控端 ===');
const target = node ? ['--node', node] : [];
execFileSync('nodeagent', [...target, 'deploy', bundle, ...flags], { cwd: root, stdio: 'inherit' });
