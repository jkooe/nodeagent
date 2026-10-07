#!/usr/bin/env node
/**
 * 发版脚本：一条命令完成「改版本 → 构建 → 打包 → 生成校验和与清单 → 提交打标签 → 发布 GitHub Release」。
 *
 * 用法：
 *   node scripts/release.mjs 1.0.0              # 指定版本
 *   node scripts/release.mjs patch|minor|major  # 按当前版本自增
 *   node scripts/release.mjs 1.0.0 --dry-run    # 只演练：构建+生成资产，不改 git、不发布
 *   node scripts/release.mjs 1.0.0 --no-publish # 提交打标签，但不发 GitHub Release
 *
 * 为什么要有它（对齐皇上的要求「每次更新，GitHub 上也要同步资产」）：
 *   手工发版要记住「改几处 package.json、打哪个包、算哪些哈希、传什么资产」——
 *   必然漏项（尤其是给人用的 zip 与给自更新用的 agent.mjs 是**两个不同的东西**）。
 *   本脚本把两者都产出，并把 sha256 写进 latest.json，供被控端 `system.agent.update` 直接使用。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const arg = argv.find((a) => !a.startsWith('--'));

const dryRun = flags.has('--dry-run');
const publish = !flags.has('--no-publish');

// ⚠️ stdio:'inherit' 时 execFileSync 返回 null（不捕获输出）→ 必须容错，
//    否则 build/pack 这类「继承输出」的调用会直接 TypeError（真机踩过）
const sh = (cmd, args, opts = {}) => {
  const out = execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
  return out === null || out === undefined ? '' : String(out).trim();
};

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/**
 * 带重试的网络型 git 操作。
 * 本机到 GitHub 的连接会间歇性 SSL_ERROR_SYSCALL / SSL timeout（已实测多次），
 * 发版卡在这里会留下半成品状态 —— 所以 fetch 与 push 都必须重试。
 */
function netRetry(label, fn, tries = 4) {
  for (let i = 1; i <= tries; i += 1) {
    try {
      fn();
      return;
    } catch (err) {
      if (i === tries) throw err;
      console.warn(`（${label} 第 ${i} 次失败，2s 后重试…）`);
      execFileSync('sleep', ['2']);
    }
  }
}

function bump(cur, kind) {
  const [a, b, c] = cur.split('.').map((n) => Number.parseInt(n, 10));
  if ([a, b, c].some((n) => Number.isNaN(n))) fail(`现有版本号无法解析: ${cur}`);
  if (kind === 'patch') return `${a}.${b}.${c + 1}`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  if (kind === 'major') return `${a + 1}.0.0`;
  return null;
}

const pkgPath = join(root, 'package.json');
const cur = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
const version = ['patch', 'minor', 'major'].includes(arg) ? bump(cur, arg) : (arg ?? '');
if (!version) fail('用法: node scripts/release.mjs <1.2.3|patch|minor|major> [--dry-run] [--no-publish]');
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`版本号格式应为 x.y.z，收到 ${version}`);

console.log(`=== nodeagent 发版 v${version}（当前 ${cur}）${dryRun ? ' [dry-run]' : ''} ===`);

// ---------- ① 前置检查 ----------
if (!dryRun) {
  // 刻意排除 .github/：其改动需要 workflow 权限才能推送，
  // 若把它算进「干净检查」会让发版永远卡住（见 docs/VERSIONING.md §6）
  const dirty = sh('git', ['status', '--porcelain', '--', '.', ':(exclude).github'])
    .split('\n')
    .filter(Boolean)
    .join('\n');
  if (dirty) fail(`工作区不干净（已忽略 .github/），请先提交：\n${dirty}`);
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') fail(`当前分支是 ${branch}，发版请在 main 上`);
  netRetry('fetch', () => sh('git', ['fetch', 'origin', 'main']));
  if (sh('git', ['rev-parse', 'HEAD']) !== sh('git', ['rev-parse', 'origin/main'])) {
    fail('本地 main 与远端不一致，请先 pull/push（避免发版后才发现分叉）');
  }
}

const remote = sh('git', ['remote', 'get-url', 'origin'])
  .replace(/^git@github\.com:/, 'https://github.com/')
  .replace(/\.git$/, '');
const repoPath = remote.replace(/^https:\/\/github\.com\//, '');
if (!/^[\w.-]+\/[\w.-]+$/.test(repoPath)) fail(`无法从 remote 推断 GitHub 仓库: ${remote}`);

// ---------- ② 改版本（单一版本源：根 + 各 workspace + Tauri 清单）----------
const pkgFiles = ['package.json'];
for (const f of sh('git', ['ls-files', '*package.json']).split('\n').filter(Boolean)) {
  if (f === 'package.json' || f.includes('node_modules')) continue;
  pkgFiles.push(f);
}
// Tauri 的版本号不在 package.json 里，另存于 src-tauri/tauri.conf.json，
// 且它才是最终打进 .app / 安装包的版本。漏掉会「包里是旧版本号」，故一并纳入。
const tauriConfFiles = sh('git', ['ls-files', '*src-tauri/tauri.conf.json'])
  .split('\n')
  .filter(Boolean);
if (dryRun) {
  // dry-run 绝不改文件 —— 演练就该是无副作用的
  console.log(`（dry-run）将把 ${pkgFiles.length} 个 package.json 的 version 改为 ${version}`);
  if (tauriConfFiles.length) {
    console.log(`（dry-run）以及 ${tauriConfFiles.length} 个 tauri.conf.json：${tauriConfFiles.join(', ')}`);
  }
  console.log('（dry-run）将执行：构建 → pack:win → pack:mac → 生成资产 → 提交打标签 → gh release create');
  process.exit(0);
}
for (const f of pkgFiles) {
  const p = join(root, f);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  if (!j.version) continue;
  j.version = version;
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
}
for (const f of tauriConfFiles) {
  const p = join(root, f);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  if (!j.version) continue;
  j.version = version;
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
}
console.log(`✓ 版本号已写入 ${pkgFiles.length} 个 package.json + ${tauriConfFiles.length} 个 tauri.conf.json`);

// ---------- ③ 构建 + 打包 ----------
console.log('=== 构建 ===');
sh('pnpm', ['-r', 'build'], { stdio: 'inherit' });
console.log('=== 打包 ===');
sh('pnpm', ['pack:win'], { stdio: 'inherit' });
try {
  sh('pnpm', ['pack:mac'], { stdio: 'inherit' });
} catch {
  console.warn('（pack:mac 跳过：非 macOS 或未安装依赖）');
}

const agentPath = join(root, 'release', 'nodeagent-win-x64', 'agent.mjs');
const zipPath = join(root, 'release', 'nodeagent-win-x64.zip');
if (!existsSync(agentPath)) fail(`找不到 agent 产物: ${agentPath}`);
if (!existsSync(zipPath)) fail(`找不到 zip 产物: ${zipPath}`);

// ---------- ④ 生成资产（校验和 + latest.json）----------
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const distDir = join(root, 'release', 'dist');
mkdirSync(distDir, { recursive: true });

const assets = [
  { name: 'agent.mjs', path: agentPath, purpose: '自更新载荷（被控端 system.agent.update 直接使用）' },
  { name: 'nodeagent-win-x64.zip', path: zipPath, purpose: '人工安装包（自包含 node.exe，免装 Node.js）' },
];
for (const a of assets) {
  copyFileSync(a.path, join(distDir, a.name));
  a.bytes = readFileSync(a.path).length;
  a.sha256 = sha256(a.path);
}

const commit = sh('git', ['rev-parse', '--short', 'HEAD']);
const builtAt = new Date().toISOString();
// 能力数从清单动态取，避免写死后漂移
let capabilityCount = 0;
try {
  const mod = await import(join(root, 'packages', 'protocol', 'dist', 'index.js'));
  capabilityCount = mod.CAPABILITY_MANIFEST?.length ?? 0;
} catch {
  console.warn('（未能从 dist 读取能力数，latest.json 里记为 0）');
}
const base = `https://github.com/${repoPath}/releases/download/v${version}`;
const latest = {
  version,
  commit,
  built_at: builtAt,
  protocol: '1.0',
  capabilities: capabilityCount,
  agent: {
    url: `${base}/agent.mjs`,
    sha256: assets[0].sha256,
    bytes: assets[0].bytes,
    note: '自更新用：nodeagent update --url <url> --sha256 <sha256>',
  },
  zip: { url: `${base}/nodeagent-win-x64.zip`, sha256: assets[1].sha256, bytes: assets[1].bytes },
};
writeFileSync(join(distDir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');

const sums = assets.map((a) => `${a.sha256}  ${a.name}`).join('\n') + `\n`;
writeFileSync(join(distDir, 'SHA256SUMS'), sums);

console.log('=== 资产 ===');
for (const a of assets) {
  console.log(`  ${a.name.padEnd(26)} ${(a.bytes / 1024 / 1024).toFixed(1)}MB  sha256=${a.sha256.slice(0, 12)}…`);
}
console.log(`  latest.json / SHA256SUMS`);

// ---------- ⑤ 提交 + 标签 + 推送 ----------
// ⚠️ 安全闸（两层）：发版会把工作区**整体**提交并推到公开仓库，故提交前必须确认
// 「将要提交的内容」正好等于「想提交的内容」。历史上两种偏差都真发生过，
// 且都不报错、只是静默推走不想要的东西，故分两层拦。
//
// 第一层：未跟踪文件。2026-10-07 真机教训：工作区里有用户在建工程，
// 发版脚本的 add -A 把它们连同版本号变更一起提交并推到了公开仓库。
const untracked = sh('git', ['ls-files', '--others', '--exclude-standard'])
  .split('\n')
  .filter((f) => f && !f.startsWith('.github/') && f !== '.github');
if (untracked.length > 0) {
  fail(
    '发现未跟踪文件，发版已中止（避免把无关文件带入提交）：\n' +
      untracked.map((f) => `  ${f}`).join('\n') +
      '\n请确认：这些文件是否应纳入版本库？若要，先 git add 并单独提交；' +
      '若不要，加入 .gitignore 后重试。',
  );
}
// 第二层：已修改的**跟踪**文件。只拦未跟踪文件是不够的 —— 下面的 `git add -A`
// 同样会提交已修改的跟踪文件，而它们不在第一层的视野里。
// 真例：`pnpm install` 把某个应用的依赖写进了跟踪中的根 pnpm-lock.yaml
// （+1401 行），发版时静默推走，第一层闸门完全不响。
// 故此处用「脏文件白名单」：除脚本自己改的 package.json 外，一律不许有别处改动。
// 正常发版应在**干净工作区**上开始，所以这条不该有例外。
const allowedDirty = new Set([...pkgFiles, ...tauriConfFiles]);
const dirty = sh('git', ['diff', '--name-only', 'HEAD'])
  .split('\n')
  .filter(Boolean);
const unexpectedDirty = dirty.filter((f) => !allowedDirty.has(f));
if (unexpectedDirty.length > 0) {
  fail(
    '发现**版本号变更之外**的已修改文件，发版已中止（避免误提交）：\n' +
      unexpectedDirty.map((f) => `  ${f}`).join('\n') +
      '\n这些文件本不该在发版时变动。请 `git checkout -- <文件>` 还原，或先单独提交后重试。\n' +
      '若其中有 pnpm-lock.yaml，说明依赖图发生了计划外的变化 ——\n' +
      '应查清是哪个 workspace 成员引入的，而不是让 lock 带着它发版。',
  );
}

sh('git', ['add', '-A', '--', '.', ':(exclude).github']);
sh('git', ['commit', '-m', `chore(release): v${version}`]);
sh('git', ['tag', '-a', `v${version}`, '-m', `nodeagent v${version}`]);
netRetry('push main', () => sh('git', ['push', 'origin', 'main']));
netRetry('push tag', () => sh('git', ['push', 'origin', `v${version}`]));
console.log(`✓ 已提交并推送标签 v${version}`);

// ---------- ⑥ 发布 GitHub Release ----------
if (!publish) {
  console.log('（--no-publish：已跳过 GitHub Release）');
  process.exit(0);
}
const notes = join(distDir, 'RELEASE_NOTES.md');
writeFileSync(
  notes,
  [
    `# nodeagent v${version}`,
    ``,
    `- 构建: \`${commit}\` @ ${builtAt}`,
    `- 能力: ${latest.capabilities} 项`,
    ``,
    `## 资产`,
    ...assets.map((a) => `- \`${a.name}\` — ${a.purpose}`),
    `- \`latest.json\` — 版本清单（含 sha256），供被控端自更新校验`,
    `- \`SHA256SUMS\` — 校验和`,
    ``,
    `## 更新被控端（拉取式，只需它能上网）`,
    '```bash',
    `nodeagent --node <设备名> update \\`,
    `  --url ${latest.agent.url} \\`,
    `  --sha256 ${latest.agent.sha256}`,
    '```',
    ``,
    `## 人工安装（首次）`,
    `\`\`\`powershell`,
    `Expand-Archive nodeagent-win-x64.zip C:\\nodeagent -Force`,
    `# 先把 C:\\nodeagent 加入杀软信任区（主流杀软/杀软）`,
    `powershell -ExecutionPolicy Bypass -File C:\\nodeagent\\install.ps1 -NodeId win -AllowInput`,
    '```',
  ].join('\n') + '\n',
);

sh('gh', [
  'release',
  'create',
  `v${version}`,
  '--title',
  `nodeagent v${version}`,
  '--notes-file',
  notes,
  join(distDir, 'agent.mjs'),
  join(distDir, 'nodeagent-win-x64.zip'),
  join(distDir, 'latest.json'),
  join(distDir, 'SHA256SUMS'),
]);
console.log(`✓ GitHub Release v${version} 已发布`);
console.log('');
console.log('被控端更新命令：');
console.log(`  nodeagent --node <设备名> update --url ${latest.agent.url} --sha256 ${latest.agent.sha256}`);
