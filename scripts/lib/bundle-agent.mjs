#!/usr/bin/env node
/**
 * 被控端单文件打包（esbuild）—— **单一实现**。
 *
 * 为什么抽出来：`agent.mjs` 现在有**两个消费方** ——
 *   1. `scripts/pack.mjs`             → Windows 便携包 / 自更新载荷（Release 资产）
 *   2. `scripts/prepare-console.mjs`  → 桌面控制台的随包资源（控制台要能托起本机被控端）
 *
 * 若各写一份 esbuild 配置，迟早漂移（本项目已多次吃过「两份真相」的亏：改了一处漏另一处，
 * 构建过、单测过，只在真机暴露）。故配置只此一份。
 *
 * ## 几个「不这么写就会错」的细节
 * - **用 esbuild 的 JS API，不 spawn `node_modules/.bin/esbuild`** —— pnpm 隔离布局下
 *   那个 shim 在 Windows 上不存在（真机 CI 踩过 `ENOENT`）；JS API 只依赖 `require('esbuild')`。
 * - **不注入构建时间** —— 注入后同一份代码每次打包字节都不同，「指纹是否最新」永远失真。
 * - `define` 的值按 **JS 表达式**解析，故用 `JSON.stringify` 得到纯双引号；写成单引号包裹
 *   会让引号成为值的一部分（真机踩过：版本号显示成 `v"1.4.0"`）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（本文件在 scripts/lib/ 下）。 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 被控端与协议包的版本源：**根** `package.json`（非 apps/agent 的）。 */
export function repoVersion(root = repoRoot) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

/** 当前 git 短 sha（取不到时返回 `unknown`，不抛）。 */
export function gitShortCommit(root = repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
  } catch {
    return 'unknown';
  }
}

/**
 * 把 `apps/agent/dist/index.js` 打包成自包含单文件。
 *
 * @param {object} opts
 * @param {string} opts.outfile  产物路径
 * @param {string} [opts.root]   仓库根
 * @param {string} [opts.logLevel]
 * @returns {Promise<{ outfile: string, version: string, commit: string, bytes: number }>}
 */
export async function bundleAgent({ outfile, root = repoRoot, logLevel = 'info' }) {
  const entry = join(root, 'apps', 'agent', 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(
      `未找到被控端构建产物：${entry}\n` +
        '  先构建：pnpm --filter nodeagent-agent build（或 pnpm -r build）',
    );
  }

  const version = repoVersion(root);
  const commit = gitShortCommit(root);

  // 动态 import：只有真正需要打包时才解析 esbuild（prepare-console 的其它分支不受影响）
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    define: {
      __AGENT_VERSION__: JSON.stringify(version),
      __BUILD_COMMIT__: JSON.stringify(commit),
    },
    outfile,
    logLevel,
  });

  const { statSync } = await import('node:fs');
  return { outfile, version, commit, bytes: statSync(outfile).size };
}
