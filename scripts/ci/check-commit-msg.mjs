#!/usr/bin/env node
/**
 * 提交信息规范校验（交付流水线 §8 / 附录 B）。
 *
 * ## 背景
 * 项目**实际早已在用** Conventional Commits（`git log` 可验证：feat(linux): / fix(console): …），
 * 但一直没有强制 —— 靠自觉。本次把它变成会红的门禁。
 *
 * ## 为什么不引 commitlint + husky
 *   - husky 依赖 git hooks，CI 上不生效，还得额外装依赖；
 *   - commitlint 需要配置文件与 `@commitlint/config-conventional` 一整套；
 *   - 本项目只需「类型白名单 + 有 subject」这两条，几十行即可，且 CI 与本地都能跑。
 * 与覆盖率门禁同理：不引冗余依赖。
 *
 * ## 用法
 *   node scripts/ci/check-commit-msg.mjs                 # 校验 HEAD 这一条
 *   node scripts/ci/check-commit-msg.mjs --base origin/main   # 校验该区间所有提交
 *   echo "feat(x): y" | node scripts/ci/check-commit-msg.mjs --stdin
 */

import { execFileSync } from 'node:child_process';

const TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'ci'];

/** 允许 Revert / Merge / 版本提交等自动化形态，但类型必须合规。 */
const HEADER_RE = new RegExp(`^(${TYPES.join('|')})(\\([^)]+\\))?!?: .+`);

const ALLOWED_EXEMPT = [
  /^Merge (branch|pull request|remote-tracking branch)/i,
  /^Revert "/,
];

function parseArgs(argv) {
  const out = { base: '', stdin: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') out.base = argv[++i];
    else if (argv[i] === '--stdin') out.stdin = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(
        `用法: node scripts/ci/check-commit-msg.mjs [--base <git-ref>] [--stdin]\n` +
          `  类型白名单: ${TYPES.join(', ')}\n` +
          `  格式: <type>(<scope>): <subject>`,
      );
      process.exit(0);
    }
  }
  return out;
}

function readStdin() {
  try {
    return execFileSync('cat', [], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

function commitsInRange(base) {
  const range = base ? `${base}..HEAD` : 'HEAD~1..HEAD';
  try {
    return execFileSync('git', ['log', '--format=%H%x09%s', range], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        const idx = l.indexOf('\t');
        return { sha: l.slice(0, idx), subject: l.slice(idx + 1) };
      });
  } catch {
    return [];
  }
}

const args = parseArgs(process.argv.slice(2));

let items = [];
if (args.stdin) {
  const msg = readStdin().trim();
  if (!msg) {
    console.error('\n✗ stdin 为空，没有可校验的提交信息');
    process.exit(1);
  }
  items = [{ sha: '(stdin)', subject: msg.split('\n')[0] }];
} else {
  items = commitsInRange(args.base);
  if (items.length === 0) {
    console.log(`（区间内没有提交，跳过）${args.base ? `base=${args.base}` : ''}`);
    process.exit(0);
  }
}

const bad = [];
for (const it of items) {
  const s = it.subject.trim();
  if (ALLOWED_EXEMPT.some((re) => re.test(s))) continue;
  if (!HEADER_RE.test(s)) bad.push(it);
}

if (bad.length > 0) {
  console.error(`\n✗ ${bad.length} 条提交信息不符合 Conventional Commits：`);
  for (const b of bad) console.error(`  ${b.sha.slice(0, 8)}  ${b.subject}`);
  console.error(`\n要求格式: <type>(<scope>): <subject>`);
  console.error(`type 取值: ${TYPES.join(', ')}`);
  console.error(`示例: fix(console): sidecar 补 CREATE_NO_WINDOW（不再弹常驻黑窗）`);
  process.exit(1);
}

console.log(`✓ 提交信息规范校验通过（${items.length} 条）`);
