#!/usr/bin/env node
/**
 * 构建 macOS 控制端（免 node_modules 的单文件）。
 *
 * 用法: node scripts/pack-macos.mjs [--out release]
 *
 * 产物: <out>/nodeagent-macos/
 *   ├── nodeagent      控制端 CLI（可执行，含 shebang）
 *   └── nodeagent-mcp  MCP server（可执行，含 shebang）
 *
 * 说明: Mac 作为控制端，通常本机已装 Node.js，故不打运行时（体积从 ~50MB 降到 ~1MB）。
 */
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const OUT_DIR = getArg('--out', join(root, 'release'));
const PKG_DIR = join(OUT_DIR, 'nodeagent-macos');
const esbuild = join(root, 'node_modules', '.bin', 'esbuild');

const SHEBANG = '#!/usr/bin/env node';
// MCP server 经 stdio 通信，日志必须走 stderr；banner 同时补 createRequire 兼容 CJS 依赖
const BANNER = 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);';

function bundle(entry, outfile) {
  execFileSync(
    esbuild,
    [
      join(root, entry),
      '--bundle',
      '--platform=node',
      '--target=node22',
      '--format=esm',
      `--banner:js=${SHEBANG}\n${BANNER}`,
      `--outfile=${outfile}`,
    ],
    { stdio: 'inherit' },
  );
  chmodSync(outfile, 0o755);
  const kb = (statSync(outfile).size / 1024).toFixed(0);
  console.log(`  ✓ ${outfile.replace(`${root}/`, '')}  (${kb}KB)`);
}

console.log('=== ① 构建 workspace ===');
execSync('pnpm -r build', { cwd: root, stdio: 'inherit' });

console.log('\n=== ② 打包控制端 ===');
rmSync(PKG_DIR, { recursive: true, force: true });
mkdirSync(PKG_DIR, { recursive: true });
bundle('apps/cli/dist/index.js', join(PKG_DIR, 'nodeagent'));
bundle('apps/cli/dist/daemon.js', join(PKG_DIR, 'nodeagentd'));
bundle('apps/mcp/dist/index.js', join(PKG_DIR, 'nodeagent-mcp'));

console.log(`\n✓ 完成: ${PKG_DIR}`);
console.log('  下一步: bash scripts/install-macos.sh（安装到 ~/.local/bin）');
