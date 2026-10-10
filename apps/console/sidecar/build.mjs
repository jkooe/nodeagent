#!/usr/bin/env node
/**
 * 把 sidecar 打成**单文件**（供 Tauri 打包进应用）。
 *
 * 用法：node apps/console/sidecar/build.mjs [--out <dir>]
 *
 * 为什么用 esbuild 的 **JS API** 而不是 spawn `node_modules/.bin/esbuild`：
 * pnpm 的 `.bin` 布局下 spawn 该路径会 ENOENT（scripts/pack.mjs 真机踩过）。
 * 用 API 则从模块解析走，与包管理器布局无关。
 *
 * 依赖处理：`@nodeagent/client` 与 `@nodeagent/protocol` 是 workspace 包，
 * **一并 bundle 进去**（sidecar 要作为独立文件被 Tauri 拉起，不能依赖仓库 node_modules）。
 * `ws` 亦被打入（它是纯 JS）。Node 内置模块（readline/process）保持 external。
 */

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outFile = join(outIdx >= 0 ? argv[outIdx + 1] : join(here, 'dist'), 'sidecar.mjs');

mkdirSync(dirname(outFile), { recursive: true });

const result = await build({
  entryPoints: [join(here, 'main.mjs')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Node 内置模块保持外部引用；其余（含 ws / workspace 包）全部内联
  external: ['node:*'],
  // ⚠️ CJS 依赖（如 ws）里有**动态 require**（`require('events')`），esbuild 打成 ESM 后
  // 无法转换 → 运行时报 "Dynamic require of X is not supported"。注入 createRequire shim
  // 是标准解法：让 bundle 内的 `require(...)` 走真实的 CJS 解析。
  banner: {
    js:
      '// nodeagent console sidecar（由 apps/console/sidecar/build.mjs 生成，请勿手工编辑）\n' +
      "import { createRequire as __naCreateRequire } from 'node:module';\n" +
      'const require = __naCreateRequire(import.meta.url);',
  },
  legalComments: 'none',
  minify: false, // 保持可读：出问题时能直接看堆栈
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`✓ sidecar 已打包: ${outFile}  ${(bytes / 1024).toFixed(0)} KB`);
