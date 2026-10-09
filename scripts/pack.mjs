#!/usr/bin/env node
/**
 * 构建 Windows 便携安装包。
 *
 * 用法: node scripts/pack.mjs [--node v22.20.0] [--out release]
 *
 * 产物: <out>/nodeagent-win-x64.zip
 *   ├── node.exe      Node.js 运行时（免装 Node.js）
 *   ├── agent.mjs     esbuild 打包的被控端（含全部依赖）
 *   ├── install.cmd   一键安装（双击即用，自提权 + 自动生成 PSK）
 *   ├── control.cmd   控制台菜单（启动/停止/状态/日志/卸载）
 *   ├── install.ps1   底层安装脚本（由 install.cmd 调用）
 *   ├── control.ps1   底层控制脚本（由 control.cmd 调用）
 *   └── uninstall.ps1 底层卸载脚本
 *
 * 注意：PSK.txt **不打进 zip**（zip 会作为公开 Release 资产发布，含密钥=公开密钥）；
 *      它在被控端首次运行 install.cmd 时生成，只留在本机安装目录。
 */
import { execFileSync, execSync } from 'node:child_process';
import {
  copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync,
  readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { get } from 'node:https';
import { randomBytes } from 'node:crypto';
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
  // 单一版本源：根 package.json 的 version + git sha + 构建时间，
  // 经 esbuild --define 注入，避免「版本号写在多处必然不同步」。
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const commit = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    } catch {
      return 'unknown';
    }
  })();
  const builtAt = new Date().toISOString();
  log(`  版本 ${pkg.version} @ ${commit}（${builtAt}）`);
  mkdirSync(OUT_DIR, { recursive: true });
  const bundleOut = join(OUT_DIR, 'agent.mjs');
  // 用 esbuild 的 **JS API** 而非 spawn node_modules/.bin/esbuild —— pnpm 的隔离布局下
  // 那个 shim 在 Windows 上不存在（真机 CI 踩过：spawnSync ...\.bin\esbuild ENOENT），
  // 而 JS API 只依赖 require('esbuild') 解析，跨平台一致。
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [join(root, 'apps', 'agent', 'dist', 'index.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    // 刻意**不注入构建时间**：注入后同一份代码每次打包字节都不同，
    // 「指纹比对是否最新」就永远失真（真机踩过：明明同版本却报不一致）。
    // 构建时间改由入口文件的 mtime 反映（见 system.ts 的 build.built_at）。
    // 注意：define 的值按 **JS 表达式** 解析，故用 JSON.stringify 得到纯双引号；
    // 写成单引号包裹会让引号成为值的一部分（真机踩过：版本显示成 v"1.4.0"）。
    define: {
      __AGENT_VERSION__: JSON.stringify(pkg.version),
      __BUILD_COMMIT__: JSON.stringify(commit),
    },
    outfile: bundleOut,
    logLevel: 'info',
  });

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
  copyFileSync(join(root, 'scripts', 'control.ps1'), join(PKG_DIR, 'control.ps1'));
  copyFileSync(join(root, 'scripts', 'uninstall.ps1'), join(PKG_DIR, 'uninstall.ps1'));

  // 一键入口：.cmd 必须**纯 ASCII**。CMD 的代码页（中文 Windows = 936/GBK）
  // 无法可靠往返 UTF-8，中文提示一律交给带 BOM 的 .ps1 去输出。
  for (const cmd of ['install.cmd', 'control.cmd', 'run-temp.cmd']) {
    copyFileSync(join(root, 'scripts', cmd), join(PKG_DIR, cmd));
  }

  // 防呆 A：产物里的 .ps1 必须带 UTF-8 BOM，否则被控端的 **Windows PowerShell 5.1**
  // 会按 ANSI/GBK 解析无 BOM 脚本，中文注释破坏字符串边界 → 整份脚本 ParseError。
  // 真机踩过（2026-10-04）：CI 全绿（冒烟用 pwsh/PS7），5.1 真机直接报
  // 「","后面缺少表达式」。此处宁可在打包阶段失败，也不要把坏包发出去。
  for (const ps1 of ['install.ps1', 'control.ps1', 'uninstall.ps1']) {
    const p = join(PKG_DIR, ps1);
    const head = readFileSync(p).subarray(0, 3);
    if (!(head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)) {
      fail(`${ps1} 缺少 UTF-8 BOM —— Windows PowerShell 5.1 会解析失败。` +
        `请先给 scripts/${ps1} 加上 BOM 再打包。`);
    }
  }
  log('  .ps1 BOM 检查通过（兼容 Windows PowerShell 5.1）');

  // 防呆 B：.cmd 里出现非 ASCII 字节 = 中文乱码/命令截断的隐患。
  for (const cmd of ['install.cmd', 'control.cmd', 'run-temp.cmd']) {
    const buf = readFileSync(join(PKG_DIR, cmd));
    const bad = [...buf].findIndex((b) => b > 0x7f);
    if (bad >= 0) {
      fail(`${cmd} 含非 ASCII 字节（偏移 ${bad}）—— CMD 代码页无法可靠处理，` +
        `请把该文件改为纯 ASCII，中文提示交给 .ps1。`);
    }
    // 行尾必须是 CRLF：LF-only 的 .cmd 在部分 Windows 环境会解析异常
    const lf = buf.filter((b) => b === 0x0a).length;
    const crlf = buf.filter((b, i) => b === 0x0a && buf[i - 1] === 0x0d).length;
    if (lf !== crlf) {
      fail(`${cmd} 含 ${lf - crlf} 处 LF-only 行尾 —— 打包前须统一为 CRLF。`);
    }
  }
  log('  .cmd 纯 ASCII 检查通过（CMD 代码页安全）');

  // PSK.txt：预置一把随机密钥，让 install.cmd 真正「零输入」。
  // 用 --psk 传入指定密钥；不传则随机生成 32 字节 hex。
  // 文件是纯 hex 文本，无需 BOM（install.cmd 用 `set /p` 读）。
  const pskArg = getArg('--psk', '');
  const psk = pskArg || randomBytes(32).toString('hex');
  if (!/^[0-9a-fA-F]{32,128}$/.test(psk)) {
    fail(`--psk 格式非法（需 32-128 位十六进制）: ${psk}`);
  }
  writeFileSync(join(PKG_DIR, 'PSK.txt'), `${psk}\n`, 'utf8');
  log(`  PSK.txt 已生成（${psk.length} 位${pskArg ? '，来自 --psk' : '，随机'}）`);

  // README：给第一次上手的人看一眼该双击哪个文件
  writeFileSync(join(PKG_DIR, 'README.txt'), [
    'nodeagent - Windows 被控端',
    '==========================',
    '',
    '【怎么装】双击  install.cmd',
    '   1) 会弹一次「用户账户控制」→ 点「是」（必须管理员，装计划任务要用）',
    '   2) 等它跑完，最后会打印连接信息',
    '   3) 把那行 nodeagent connect ... 拿到 Mac 上执行',
    '',
    '【日常管理】双击  control.cmd',
    '   1 状态 / 2 启动 / 3 停止 / 4 重启 / 5 日志 / 6 卸载 / 7 彻底卸载',
    '',
    '【临时试用，不装也行】双击  run-temp.cmd',
    '   * 不需要管理员、不写计划任务、Ctrl+C 即停',
    '   * 首次运行自动生成配置与密钥（agent.json），并在控制台打印连接命令',
    '   * run-temp.cmd background = 最小化后台启动；stop = 结束；status = 看状态',
    '   * 适合临时测一下；长期用请走 install.cmd（有开机自启与进程守护）',
    '',
    '【密钥】PSK.txt 里是预共享密钥（= Mac 端 --key 的值）',
    '   丢了可以删掉 PSK.txt 重装，会自动生成新的',
    '',
    '【注意】',
    '   * 整个文件夹可以固定放在 D:\\nodeagent，但**装完不要移动或改名**',
    '   * agent 每次开机登录后自动启动，无需再双击任何东西',
    '   * 首次运行若被杀软拦截，把本文件夹加入信任区后重试',
    '',
  ].join('\n'), 'utf8');

  const entries = readdirSync(PKG_DIR, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const st = statSync(join(PKG_DIR, e.name));
      return `${e.name.padEnd(22)} ${(st.size / 1024).toFixed(0).padStart(8)} KB`;
    });
  log(entries.join('\n'));

  log('\n=== ⑤ 打 zip ===');
  const zipOut = join(OUT_DIR, 'nodeagent-win-x64.zip');
  rmSync(zipOut, { force: true });
  // ⚠️ 必须排除 PSK.txt：本 zip 会作为**公开的 GitHub Release 资产**发布，
  //    把预共享密钥打进包里等于公开密钥。install.cmd 在文件缺失时会自动生成新密钥
  //    （生成在安装目录，只留在被控端本机），所以排除它不影响安装。
  if (process.platform === 'win32') {
    // Windows：GitHub runner / 多数 Windows 没有 Info-ZIP，改用 PowerShell 的 Compress-Archive。
    // 先删掉 PSK.txt（若存在）再压 —— Compress-Archive 无 -x 排除参数。
    const psk = join(PKG_DIR, 'PSK.txt');
    if (existsSync(psk)) rmSync(psk, { force: true });
    execFileSync(
      'powershell',
      [
        '-NoProfile', '-Command',
        `Compress-Archive -Path '${PKG_DIR}\*' -DestinationPath '${zipOut}' -Force`,
      ],
      { stdio: 'inherit' },
    );
  } else {
    execSync(`cd "${PKG_DIR}" && zip -q -r "${zipOut}" . -x "PSK.txt"`, { stdio: 'inherit' });
  }

  const kb = statSync(zipOut).size / 1024;
  const size = kb > 1024 ? `${(kb / 1024).toFixed(0)}M` : `${kb.toFixed(0)}K`;
  log(`\n✓ 完成: ${zipOut}（${size}）`);
  log('  分发方式：解压到固定目录 → 双击 install.cmd（自提权，零命令行知识）');
  log('  日后管理：双击 control.cmd');
}

try {
  await main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
