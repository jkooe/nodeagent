#!/usr/bin/env node
/**
 * 审计链外部锚定 —— **控制端**工具（v2.0.0）。
 *
 * ## 为什么判定要在控制端做
 * 被控端是**不可信方**：它若被 root，既会重写 audit.log，也会把自己的锚点一并改掉，
 * 并告诉你"一切正常"。所以"锚点存哪、和什么比"必须由**控制端**掌握。
 *
 * ## 两个子命令
 *   collect  拉被控端链头 → 生成一条锚点记录（JSONL 一行），供上传到链外
 *   verify   拉被控端链头 + 读指定锚点文件 → 给出判定结论（三方一致 / 被重写）
 *
 * ## 判定逻辑不在此处重写
 * 复用 `@nodeagent/protocol` 的 `judgeAnchors`（与 agent 端**同一份实现**）——
 * 若两端各写一份，同一份日志会出现"被控端说一致、控制端说被改"的荒谬局面。
 *
 * ## 为什么走 CLI 而不是直接连
 * CLI 已经装了连接管理（多设备配置、证书钉住、daemon 连接池），薄薄一层复用即可；
 * 自己再实现一遍连接与握手，就是又一次"两份实现"。
 *
 * 用法：
 *   node scripts/anchor-audit.mjs collect --node win [--out <文件>] [--note "每日"]
 *   node scripts/anchor-audit.mjs verify  --node win --anchors <锚点文件> [--head-file <链头 JSON>]
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeAnchors, parseAnchorsFromJsonl } from '../packages/protocol/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 极简参数解析（避免为两个子命令引依赖）。 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) out[k] = true;
      else {
        out[k] = v;
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
}

function die(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

/** 拉取被控端链头（走 CLI，复用其连接管理）。 */
/** 链头来源：优先 `--head-file`（便于离线验证/排查），否则走 CLI。 */
function fetchHead(node, headFile) {
  if (headFile && typeof headFile === 'string') {
    if (!existsSync(headFile)) die(`链头文件不存在：${headFile}`);
    const j = JSON.parse(readFileSync(headFile, 'utf8'));
    return j.data ?? j; // 兼容「CLI 信封」与「裸 data」两种写法
  }
  // ⚠️ CLI 没有 `audit head` 子命令（只有 `audit` 列表与 `audit verify`）——
  // system.audit.head 只能走通用 `invoke`。2026-10-11 在 Parallels VM 上真跑时才发现：
  // 不实际跑一次，这种"能力存在但 CLI 无子命令"的错配根本暴露不出来。
  const args = ['invoke', 'system.audit.head', '--json'];
  if (node) args.push('--node', node);
  let raw;
  try {
    raw = execFileSync('nodeagent', args, {
      encoding: 'utf8',
      cwd: root,
      timeout: 60_000,
      env: process.env,
    });
  } catch (err) {
    die(`调用 CLI 失败：${err?.message ?? err}（被控端可能离线）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    die(`CLI 输出非 JSON：${String(raw).slice(0, 200)}`);
  }
  if (parsed?.status !== 'ok' || !parsed.data) {
    die(`取链头失败：${parsed?.error?.message ?? '未知错误'}`);
  }
  return parsed.data;
}

/** 组一条锚点记录（字段与 protocol 的 AnchorRecord 一致）。 */
function toAnchorRecord(head, note) {
  return {
    ts: Date.now(),
    entries: head.entries,
    head_hash: head.head_hash ?? null,
    head_ts: head.head_ts ?? null,
    rotated_segments: head.rotated_segments ?? 0,
    ...(note ? { note } : {}),
  };
}

// ---------------- collect ----------------

function cmdCollect(args) {
  const node = args.node;
  const head = fetchHead(node, args['head-file']);
  const rec = toAnchorRecord(head, typeof args.note === 'string' ? args.note : undefined);

  const out = args.out
    ? String(args.out)
    : join(root, 'release', `audit-anchor-${new Date().toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(dirname(out), { recursive: true });
  if (existsSync(out)) appendFileSync(out, `${JSON.stringify(rec)}\n`, 'utf8');
  else writeFileSync(out, `${JSON.stringify(rec)}\n`, 'utf8');

  console.log(`✓ 已生成锚点：${rec.entries} 条，链头 ${String(rec.head_hash).slice(0, 16)}…（轮转 ${rec.rotated_segments} 段）`);
  console.log(`  文件：${out}`);
  console.log(`  ⤴ 请把该文件上传到**链外**（网盘/另一台机器）—— 留在本机或与被控端同机都等于没锚。`);
  // 便于 automation 直接取用（一行 JSON）
  console.log(`ANCHOR_JSON=${JSON.stringify(rec)}`);
  return 0;
}

// ---------------- verify ----------------

function cmdVerify(args) {
  const node = args.node;
  const file = args.anchors;
  if (!file || typeof file !== 'string') die('verify 需要 --anchors <锚点文件>（可从网盘下载后传入）');
  if (!existsSync(file)) die(`锚点文件不存在：${file}`);

  const anchors = parseAnchorsFromJsonl(readFileSync(file, 'utf8'));
  if (!anchors) die('锚点文件为空或全部不可解析');

  const head = fetchHead(node, args['head-file']);
  const cmp = judgeAnchors(head, anchors);

  const mark = cmp.ok ? '✓' : '✗';
  console.log(`${mark} 判定：${cmp.verdict}`);
  console.log(`  锚点条数：${cmp.anchors_checked}（最近一条：${new Date(cmp.latest?.ts ?? 0).toLocaleString()}）`);
  console.log(`  当前链：${head.entries} 条，链头 ${String(head.head_hash).slice(0, 16)}…，轮转 ${head.rotated_segments} 段`);
  if (cmp.detail) console.log(`  明细：${JSON.stringify(cmp.detail)}`);
  if (!cmp.ok) {
    console.error('');
    console.error('  ⚠️ 与链外锚点不一致 —— 需人工核查被控端审计日志是否被重写。');
    console.error('     注意：锚点本身也应有历史（多份），只比最近一条不足以定位被改的区间。');
  }
  return cmp.ok ? 0 : 2;
}

// ---------------- 入口 ----------------

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const code =
  cmd === 'collect' ? cmdCollect(args)
  : cmd === 'verify' ? cmdVerify(args)
  : (console.error('用法: node scripts/anchor-audit.mjs <collect|verify> --node <设备> [...]'), 1);
process.exit(code);
