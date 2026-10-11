#!/usr/bin/env node
/**
 * 为桌面控制台（apps/console）准备**随包分发的 Node 运行时**，并生成构建期注入的配置。
 *
 * 用法：
 *   node scripts/prepare-console.mjs [--node <路径>] [--out <目录>] [--no-strip]
 *
 * 背景
 * ----
 * 控制台的 sidecar（`apps/console/sidecar/dist/sidecar.mjs`，227KB）是 **.mjs**，
 * 需要 Node 解释器才能运行；而 sidecar 是 `.mjs` 而非可执行文件，
 * **不满足 Tauri `externalBin` 的要求**（externalBin 只接受可执行文件）。
 * 故采用与被控端 `scripts/pack.mjs` 一致的做法：**把 Node 运行时当作 Tauri resource 分发**。
 *
 * 为什么必须走 `--config` 注入、而不写进默认 `tauri.conf.json`
 * ------------------------------------------------------------
 * Tauri 的 `bundle.resources` 是**编译期契约**：`tauri-build`（build.rs）会校验
 * 声明的每个资源**必须存在**，否则 build.rs 直接失败（2026-10-10 真机踩过：
 * 声明了尚未下载的 node 与尚未生成的 sidecar.mjs → "failed to run custom build command"）。
 * 而本脚本的产物（Node 运行时）正是「运行期才需要、构建期未必存在」的东西，
 * 故一律由本脚本生成一份**注入片段**，打包时用 `tauri build --config` 合并，
 * 默认 conf 里**永远不出现** runtime 路径。
 *
 * 产物
 * ----
 *   1. `apps/console/src-tauri/runtime/<node|node.exe>`  Node 运行时（已 strip，见下）
 *   2. `apps/console/src-tauri/tauri.bundle.gen.json`    构建期注入片段（生成物，不入库）
 *
 * 体积
 * ----
 * Node 二进制约 100MB 级（macOS arm64 原始 108MB，`strip -x` 后 91MB）——
 * 这是「开箱即用、不要求用户预装 Node」的代价，已在 docs/console-plan.md 记明。
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_TAURI = join(root, 'apps/console/src-tauri');
const SIDECAR = join(root, 'apps/console/sidecar/dist/sidecar.mjs');

/** 极简参数解析（不引依赖）。 */
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : dflt;
}
const flag = (name) => process.argv.includes(`--${name}`);

const isWin = process.platform === 'win32';
const nodeName = isWin ? 'node.exe' : 'node';

const runtimeDir = resolve(arg('out', join(SRC_TAURI, 'runtime')));
const srcNode = resolve(arg('node', process.execPath));
const doStrip = !flag('no-strip') && !flag('noStrip') && process.platform === 'darwin';

const log = (m) => console.log(m);
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

// ---------- ⓪ 前置检查：sidecar 必须已构建（它才是随包分发的主体）----------
if (!existsSync(SIDECAR)) {
  fail(
    `未找到 ${SIDECAR}\n` +
      '  先构建 sidecar：pnpm --filter nodeagent-console sidecar:build',
  );
}
if (!existsSync(srcNode)) fail(`Node 可执行文件不存在：${srcNode}`);

log(`=== 准备控制台 Node 运行时（${process.platform}/${process.arch}）===`);
log(`  源：${srcNode}（${mb(statSync(srcNode).size)}）`);

// ---------- ① 复制到 runtime/（幂等：同尺寸同路径则跳过）----------
mkdirSync(runtimeDir, { recursive: true });
const dstNode = join(runtimeDir, nodeName);
const stamp = join(runtimeDir, '.source.json');
const fingerprint = { source: srcNode, size: statSync(srcNode).size, platform: process.platform, arch: process.arch };

let copied = false;
if (existsSync(dstNode) && existsSync(stamp)) {
  try {
    const prev = JSON.parse(readFileSync(stamp, 'utf8'));
    const same =
      prev.size === fingerprint.size &&
      prev.platform === fingerprint.platform &&
      prev.arch === fingerprint.arch;
    if (same) log(`  目标已存在且一致，跳过复制：${dstNode}`);
    else copied = true;
  } catch {
    copied = true;
  }
} else {
  copied = true;
}

if (copied) {
  if (existsSync(dstNode)) rmSync(dstNode);
  copyFileSync(srcNode, dstNode);
  chmodSync(dstNode, 0o755);
  log(`  已复制 → ${dstNode}`);
}

// ---------- ② strip（仅 macOS；Windows 无此步骤，且不得假设 unix 命令存在）----------
//
// ⚠️ 致命细节（2026-10-11 实测踩到）：strip 会**使 Mach-O 的代码签名失效**，
// 而 macOS 内核对签名无效的可执行文件直接 **SIGKILL（exit 137）**——
// 不是报错、不是警告，是静默无法运行（本地实测：strip 后 `./node -e ...` → 137）。
// 故 strip 之后**必须**重新 adhoc 签名（`codesign --force --sign -`）才能恢复可执行。
// 实测对照：未 strip（保持原签名）可运行 ✓；strip + 重签 可运行 ✓；strip 不重签 ✗(137)。
// 省 19% 体积（108MB → 87MB）值得，但重签这一步不能少。
if (doStrip && copied) {
  const before = statSync(dstNode).size;
  let stripped = false;
  try {
    execFileSync('strip', ['-x', dstNode], { stdio: 'pipe' });
    stripped = true;
  } catch (e) {
    // strip 不是必须的（只是省体积）；缺 Xcode CLT 时跳过，但不假装成功
    log(`  ⚠ 跳过 strip（${String(e.message).split('\n')[0]}）——不影响可用性，仅体积偏大`);
  }
  if (stripped) {
    // 重签是 strip 的**必要配套**，不是可选优化：不重签则产物无法运行。
    execFileSync('codesign', ['--force', '--sign', '-', dstNode], { stdio: 'pipe' });
    const after = statSync(dstNode).size;
    log(
      `  strip -x：${mb(before)} → ${mb(after)}（省 ${(((before - after) / before) * 100).toFixed(0)}%）` +
        '，已 adhoc 重签',
    );
  }
} else if (!doStrip && process.platform === 'darwin' && copied) {
  log('  按 --no-strip 跳过符号剥离（保留原签名）');
}

// ---------- ②′ 自检：产物必须真的能跑 ----------
// 「守卫不能是空转的」：strip / 重签任一步出问题，产物会静默变成一个 87MB 的**不可执行文件**，
// 直到用户在真机上双击应用才暴露（且报错信息毫无指向性）。故此处当场跑一次。
// 复用已有产物（跳过复制）时同样自检 —— 否则上一轮的坏产物会被一直沿用。
try {
  const ver = execFileSync(dstNode, ['-e', 'process.stdout.write(process.version)'], {
    stdio: 'pipe',
  })
    .toString()
    .trim();
  log(`  自检通过：${nodeName} 可执行（${ver}）`);
} catch (e) {
  rmSync(dstNode, { force: true });
  rmSync(stamp, { force: true });
  fail(
    `产出的 Node 运行时无法执行（已删除产物，请重跑本脚本）：${String(e.message).split('\n')[0]}\n` +
      '  提示：macOS 上 strip 会使代码签名失效，内核对签名无效的可执行文件直接 SIGKILL（exit 137），\n' +
      '        故 strip 之后必须 adhoc 重签（codesign --force --sign -）。',
  );
}

// ---------- ③ 生成构建期注入片段 ----------
// ⚠️ 两份资源都写明：既能保证「无论 Tauri 的 config 合并是深合并还是替换」都正确，
//    也让注入文件自解释（单看它就知道应用内会带哪些 resource）。
// key 相对 tauri.conf.json 所在目录（src-tauri）；value 相对应用内 Resources 目录。
const gen = {
  bundle: {
    resources: {
      '../sidecar/dist/sidecar.mjs': 'sidecar.mjs',
      [`runtime/${nodeName}`]: nodeName,
    },
  },
};
const genPath = join(SRC_TAURI, 'tauri.bundle.gen.json');
writeFileSync(genPath, JSON.stringify(gen, null, 2) + '\n');
log(`  注入片段 → ${genPath}`);
log(`    ${JSON.stringify(gen.bundle.resources)}`);

writeFileSync(stamp, JSON.stringify({ ...fingerprint, stripped: doStrip }, null, 2) + '\n');

// ---------- ④ 体积报告（让「代价」可见，而不是悄悄变大）----------
const nodeSize = statSync(dstNode).size;
const sidecarSize = statSync(SIDECAR).size;
log('');
log('=== 体积 ===');
log(`  Node 运行时   ${mb(nodeSize)}`);
log(`  sidecar      ${(sidecarSize / 1024).toFixed(0)} KB`);
log(`  合计          ${mb(nodeSize + sidecarSize)}（未压缩，即 .app 内的增量）`);
log('');
log('下一步：');
log('  pnpm --filter nodeagent-console bundle');
log('  （= sidecar:build + prepare-console + tauri build --config src-tauri/tauri.bundle.gen.json）');
