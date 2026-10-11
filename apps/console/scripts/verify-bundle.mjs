#!/usr/bin/env node
/**
 * 验证「控制台的打包产物能否自举」—— 即打包内的 Node 运行时能否跑起打包内的 sidecar。
 *
 * 用法：
 *   node scripts/verify-bundle.mjs            # 自动定位打包产物（macOS）
 *   node scripts/verify-bundle.mjs --app <x.app>
 *   node scripts/verify-bundle.mjs --runtime  # 只用 prepare 出的 runtime + sidecar.dist
 *
 * 为什么需要它
 * ----------
 * `pnpm bundle` 成功、`tauri build` 报告 Finished，**不代表产物能跑**：
 * 2026-10-11 实测踩到 —— macOS 上 `strip` 会使 Mach-O 代码签名失效，
 * 内核对签名无效的可执行文件**直接 SIGKILL（exit 137）**，没有任何有用报错。
 * 这类问题只存在于「打包产物」中：源码与单测都正常，只有真跑一遍产物才会暴露。
 * 本脚本把那次人工排查固化成一条命令。
 *
 * 它同时覆盖三件事（缺一不可）：
 *   ① 打包内的 node 真能执行（签名 / strip / 可执行位都对）
 *   ② 打包内的 sidecar.mjs 真能被它加载（bundle 完整、无缺依赖）
 *   ③ 两者之间的行分隔 JSON-RPC 通道真的通
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // apps/console/scripts
const consoleDir = resolve(here, '..'); // apps/console
const isWin = process.platform === 'win32';
const NODE_NAME = isWin ? 'node.exe' : 'node';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : undefined;
};

/** 定位打包产物（macOS：bundle/macos/*.app；Windows：无 .app，回落到 runtime）。 */
function findApp() {
  const explicit = arg('app');
  if (explicit) return resolve(explicit);
  const dir = join(consoleDir, 'src-tauri/target/release/bundle/macos');
  if (existsSync(dir)) {
    const app = readdirSync(dir).find((f) => f.endsWith('.app'));
    if (app) return join(dir, app);
  }
  return undefined;
}

let nodeBin;
let sidecar;
let source;

const app = process.argv.includes('--runtime') ? undefined : findApp();
if (app) {
  // ⚠️ Tauri 的 resource 映射 `"runtime/node": "node"` 使产物落在 Contents/Resources/node
  //    —— 必须与 src-tauri/src/sidecar.rs 的 resolve_node/resolve_sidecar 保持一致。
  const res = join(app, 'Contents/Resources');
  nodeBin = join(res, NODE_NAME);
  sidecar = join(res, 'sidecar.mjs');
  source = `打包产物 ${app}`;
} else {
  nodeBin = join(consoleDir, `src-tauri/runtime/${NODE_NAME}`);
  sidecar = join(consoleDir, 'sidecar/dist/sidecar.mjs');
  source = '准备产物（runtime + sidecar/dist）';
}

console.log(`=== 验证控制台产物自举 ===`);
console.log(`  来源：${source}`);

for (const [label, p] of [
  ['Node 运行时', nodeBin],
  ['sidecar', sidecar],
]) {
  if (!existsSync(p)) {
    console.error(`✗ 缺少 ${label}：${p}`);
    console.error('  提示：先跑 `pnpm bundle`（含 prepare:node），或 `pnpm prepare:node`。');
    process.exit(1);
  }
  console.log(`  ✓ ${label}：${p}`);
}

// ---------- ①②③ 合一的实测：真 spawn，真握手 ----------
const child = spawn(nodeBin, [sidecar], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
let err = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (err += d));

// 用一个只读、无副作用的方法：未连接时应回 {"connected":false}
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'state', params: {} }) + '\n');

const done = (code) => {
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
  process.exit(code);
};

setTimeout(() => {
  let parsed = null;
  const line = out.split('\n').find((l) => l.trim().startsWith('{'));
  try {
    parsed = JSON.parse(line);
  } catch {
    /* 下面统一报错 */
  }

  if (err.trim()) {
    console.log('  sidecar stderr：' + err.trim().split('\n').slice(0, 3).join(' | '));
  }

  if (parsed && parsed.id === 1 && parsed.result && 'connected' in parsed.result) {
    console.log(
      `\n✓ 自举成功：打包内 node（${process.version} 级）真跑起打包内 sidecar` +
        `（connected=${parsed.result.connected}）`,
    );
    done(0);
  } else {
    console.error('\n✗ 未收到预期的 JSON-RPC 响应 —— 产物可能无法自举');
    console.error('  stdout：' + (out.trim().slice(0, 300) || '(空)'));
    console.error(
      '  若 node 直接运行即被 SIGKILL(137)：macOS 上 strip 破坏了代码签名，' +
        '需 adhoc 重签（见 scripts/prepare-console.mjs 的 ② 段注释）。',
    );
    done(1);
  }
}, 4000);
