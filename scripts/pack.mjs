#!/usr/bin/env node
/**
 * 构建 Windows 便携安装包。
 *
 * 用法: node scripts/pack.mjs [--node v22.20.0] [--out release]
 *
 * 产物: <out>/nodeagent-win-x64.zip
 *   ├── node.exe      Node.js 运行时（免装 Node.js）
 *   ├── agent.mjs     esbuild 打包的被控端（含全部依赖）
 *   ├── install.ps1   一键安装
 *   └── uninstall.ps1 一键卸载
 */
import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const NODE_VERSION = getArg('--node', 'v22.20.0');
const OUT_DIR = getArg('--out', join(root, 'release'));
const PKG_DIR = join(OUT_DIR, 'nodeagent-win-x64');
const MIRROR = process.env.NODEAGENT_NODE_MIRROR ?? 'https://npmmirror.com/mirrors/node';
const NODE_ZIP_URL = `${MIRROR}/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`;

const log = (msg) => console.log(msg);
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

async function download(url, dest) {
  log(`  下载 ${url}`);
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 5) return reject(new Error('重定向过多'));
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function main() {
  log('=== ① 构建 workspace ===');
  execSync('pnpm -r build', { cwd: root, stdio: 'inherit' });

  log('\n=== ② esbuild 打包被控端 ===');
  mkdirSync(OUT_DIR, { recursive: true });
  const bundleOut = join(OUT_DIR, 'agent.mjs');
  const esbuild = join(root, 'node_modules', '.bin', 'esbuild');
  execFileSync(
    esbuild,
    [
      'apps/agent/dist/index.js',
      '--bundle',
      '--platform=node',
      '--target=node22',
      '--format=esm',
      '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      `--outfile=${bundleOut}`,
    ],
    { stdio: 'inherit' },
  );

  log('\n=== ③ 下载 Node.js Windows 运行时 ===');
  const tmpZip = join(OUT_DIR, 'node-runtime.zip');
  if (existsSync(tmpZip)) {
    log('  已缓存，跳过下载');
  } else {
    await download(NODE_ZIP_URL, tmpZip);
  }

  log('\n=== ④ 组装便携包 ===');
  rmSync(PKG_DIR, { recursive: true, force: true });
  mkdirSync(PKG_DIR, { recursive: true });
  execSync(`unzip -o -j "${tmpZip}" "*/node.exe" -d "${PKG_DIR}"`, { stdio: 'inherit' });
  copyFileSync(bundleOut, join(PKG_DIR, 'agent.mjs'));
  copyFileSync(join(root, 'scripts', 'install.ps1'), join(PKG_DIR, 'install.ps1'));
  copyFileSync(join(root, 'scripts', 'uninstall.ps1'), join(PKG_DIR, 'uninstall.ps1'));
  const files = execSync(`ls -la "${PKG_DIR}"`, { encoding: 'utf8' });
  log(files.split('\n').slice(0, 8).join('\n'));

  log('\n=== ⑤ 打 zip ===');
  const zipOut = join(OUT_DIR, 'nodeagent-win-x64.zip');
  rmSync(zipOut, { force: true });
  execSync(`cd "${PKG_DIR}" && zip -q -r "${zipOut}" .`, { stdio: 'inherit' });

  const size = execSync(`du -sh "${zipOut}"`, { encoding: 'utf8' }).split('\t')[0];
  log(`\n✓ 完成: ${zipOut}（${size.trim()}）`);
  log('  分发方式：解压后右键以管理员运行 install.ps1 即可');
}

try {
  await main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
