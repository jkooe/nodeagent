#!/usr/bin/env node
/**
 * 覆盖率门禁（交付流水线 §2 / §8）。
 *
 * ## 为什么自己解析 lcov 而不装 c8/nyc
 * 单测用的是 Node 内置 `node --test --experimental-test-coverage`，它原生出 lcov。
 * 再引一套覆盖率工具只为「读一下阈值」属于重复建设 —— 本项目铁律之一就是
 * 「重复功能优先引用已有模块，不新建冗余内容」。
 *
 * ## 口径（重要，别照搬通用 80%）
 * 原方案（面向 Web 新项目）要求全量 ≥80%。本项目存量 341 个单测集中在
 * 协议/编码/安全守卫，而 GUI 注入、平台脚本等模块**无法在 CI 上无头验证**。
 * 直接套 80% 全量阈值只会逼出两种结果：长期 `--skip`，或为 GUI 代码写假断言。
 *
 * 故采用：
 *   - **全量：只观测，不阻断**（出数字，建基线）
 *   - **变更文件：行覆盖率 ≥ THRESHOLD 才阻断**（默认 70）
 *
 * ## 一个必须说清的映射
 * 单测 import 的是 `dist/*.js`（编译产物），不是 `src/*.ts`。
 * 所以「本次改了哪个源文件」要映射成「dist 里的哪个文件」才能查到覆盖率：
 *      apps/agent/src/audit.ts  →  apps/agent/dist/audit.js
 * 规则：`/src/` → `/dist/`，`.ts` → `.js`。
 *
 * ## 无覆盖数据怎么办
 * 改动的源文件若在 lcov 里查不到对应条目（例如纯类型改动、文档、或压根没被测试碰过），
 * **不阻断**，只列进「无覆盖数据」清单。理由：把它算作 0% 会让任何重构都无法合入；
 * 而如实列出来，比一个会被绕过的门禁更有用。
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const REPO = resolve(process.cwd());

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// ---------------- 参数 ----------------

function parseArgs(argv) {
  const out = {
    lcov: 'coverage/lcov.info',
    threshold: 70,
    base: '',
    // 全量不达标是否阻断（默认否：只观测）
    enforceTotal: false,
    totalThreshold: 80,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--lcov') out.lcov = argv[++i];
    else if (a === '--threshold') out.threshold = Number(argv[++i]);
    else if (a === '--total-threshold') out.totalThreshold = Number(argv[++i]);
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--enforce-total') out.enforceTotal = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        `用法: node scripts/ci/check-coverage.mjs [选项]\n` +
          `  --lcov <path>           lcov 路径（默认 coverage/lcov.info）\n` +
          `  --threshold <n>         变更文件行覆盖率阈值（默认 70）\n` +
          `  --base <git-ref>        比对基线（如 origin/main）；为空则只看全量\n` +
          `  --enforce-total         全量不达标也阻断（默认只观测）\n` +
          `  --total-threshold <n>   全量阈值（默认 80，仅在 --enforce-total 时生效）`,
      );
      process.exit(0);
    }
  }
  return out;
}

// ---------------- lcov 解析 ----------------

/**
 * 解析 lcov，返回「项目自有文件」的覆盖率。
 *
 * 过滤掉三类噪声：
 *   1. node_modules
 *   2. 仓库外路径（运行时注入的 shim，实测会混进 WorkBuddy/Application 路径）
 *   3. .test.mjs 自身（测试文件不该计入被测代码）
 */
function parseLcov(text) {
  const out = new Map(); // repoRelPath -> {found, hit}
  let cur = null;
  let found = 0;
  let hit = 0;

  const flush = () => {
    if (!cur) return;
    const rel = toRepoRelative(cur);
    if (rel && isProjectFile(rel)) {
      const prev = out.get(rel);
      if (prev) {
        prev.found += found;
        prev.hit += hit;
      } else {
        out.set(rel, { found, hit });
      }
    }
    cur = null;
    found = 0;
    hit = 0;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('SF:')) {
      flush();
      cur = line.slice(3).trim();
    } else if (line === 'end_of_record') {
      flush();
    } else if (cur) {
      if (line.startsWith('LF:')) found = Number(line.slice(3)) || 0;
      else if (line.startsWith('LH:')) hit = Number(line.slice(3)) || 0;
    }
  }
  flush();
  return out;
}

function toRepoRelative(absPath) {
  const p = resolve(absPath);
  if (!p.startsWith(REPO)) return null;
  const rel = relative(REPO, p);
  if (rel.startsWith('..')) return null;
  return rel;
}

function isProjectFile(rel) {
  if (rel.includes('node_modules/')) return false;
  if (rel.startsWith('node_modules/')) return false;
  // 只统计本仓库的 apps / packages / scripts
  if (!/^(apps|packages|scripts)\//.test(rel)) return false;
  // 测试自身不计入
  if (/\.test\.mjs$/.test(rel)) return false;
  return true;
}

/** 源文件（src/*.ts）→ 单测实际 import 的产物路径（dist/*.js）。 */
function mapSourceToArtifact(srcRel) {
  if (srcRel.includes('/src/')) return srcRel.replace('/src/', '/dist/').replace(/\.ts$/, '.js');
  return srcRel;
}

// ---------------- 变更文件 ----------------

function changedFiles(base) {
  if (!base) return [];
  const range = `${base}...HEAD`;
  let out = '';
  try {
    out = execFileSync('git', ['diff', '--name-only', range], { encoding: 'utf8' });
  } catch {
    // 基线不可达（例如浅克隆）→ 退化为与 HEAD~1 比对
    try {
      out = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { encoding: 'utf8' });
    } catch {
      return [];
    }
  }
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------- 主流程 ----------------

const args = parseArgs(process.argv.slice(2));

if (!existsSync(args.lcov)) {
  fail(`找不到 lcov 文件: ${args.lcov}\n  请先跑：node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=${args.lcov} "tests/unit/**/*.test.mjs"`);
}

const cov = parseLcov(readFileSync(args.lcov, 'utf8'));

if (cov.size === 0) {
  fail(`lcov 里没有任何项目文件（${args.lcov}）—— 覆盖率采集可能失败，请检查是否加了 --experimental-test-coverage`);
}

// --- 全量 ---
let totalFound = 0;
let totalHit = 0;
for (const v of cov.values()) {
  totalFound += v.found;
  totalHit += v.hit;
}
const totalPct = totalFound > 0 ? (totalHit / totalFound) * 100 : 0;
console.log(`全量覆盖率（观测）  : ${totalPct.toFixed(1)}%  (${totalHit}/${totalFound} 行, ${cov.size} 个文件)`);

// --- 变更文件 ---
const changed = changedFiles(args.base);
let blocked = false;
const noData = [];

if (changed.length > 0) {
  const candidates = new Map(); // artifactRel -> srcRel
  for (const f of changed) {
    if (!/^(apps|packages|scripts)\//.test(f)) continue;
    if (/\.(md|json|ya?ml|txt)$/.test(f)) continue; // 文档/配置不参与
    const art = mapSourceToArtifact(f);
    candidates.set(art, f);
  }

  const rows = [];
  for (const [art, src] of candidates) {
    const v = cov.get(art);
    if (!v) {
      noData.push(src);
      continue;
    }
    const pct = v.found > 0 ? (v.hit / v.found) * 100 : 100;
    rows.push({ src, art, pct, hit: v.hit, found: v.found });
  }

  rows.sort((a, b) => a.pct - b.pct);

  console.log(`\n变更文件覆盖率（阈值 ${args.threshold}%，阻断）:`);
  if (rows.length === 0) console.log('  （无具备覆盖数据的变更文件）');
  for (const r of rows) {
    const mark = r.pct < args.threshold ? '✗' : '✓';
    console.log(`  ${mark} ${r.pct.toFixed(1).padStart(5)}%  ${r.src}   (${r.hit}/${r.found} 行)`);
    if (r.pct < args.threshold) blocked = true;
  }

  if (noData.length > 0) {
    console.log(`\n无覆盖数据的变更文件（不阻断，供人工判断）:`);
    for (const f of noData) console.log(`  - ${f}`);
  }
} else {
  console.log('\n（未提供 --base，跳过变更文件判定）');
}

if (args.enforceTotal && totalPct < args.totalThreshold) {
  console.error(`\n✗ 全量覆盖率 ${totalPct.toFixed(1)}% < 阈值 ${args.totalThreshold}%`);
  blocked = true;
}

if (blocked) {
  console.error('\n✗ 覆盖率门禁未通过');
  process.exit(1);
}
console.log('\n✓ 覆盖率门禁通过');
