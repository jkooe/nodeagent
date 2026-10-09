import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logQuery, parseLeadingTs } from '../../apps/agent/dist/capabilities/log.js';

/**
 * log.query 的纯逻辑测试（v1.8 方向二第一块）。
 * 文件级行为（流式读取/白名单）用真实临时文件验证，无需被控端进程。
 */

const dir = mkdtempSync(join(tmpdir(), 'logquery-'));
const sample = join(dir, 'app.log');
writeFileSync(
  sample,
  [
    '[2026-10-07 10:00:01] [INFO] agent started',
    '[2026-10-07 10:00:05] [DEBUG] connecting to relay',
    '[2026-10-07 10:00:09] [ERROR] handshake timeout after 5000ms',
    '[2026-10-07 10:00:12] [WARN] retrying (attempt 2)',
    '[2026-10-07 10:00:15] [INFO] handshake ok',
    'plain line without level',
    '[2026-10-07 10:00:20] [ERROR] proxy unreachable: ECONNREFUSED',
  ].join('\n') + '\n',
  'utf8',
);

test('log.query：无过滤时按行号顺序回全部', async () => {
  const r = await logQuery({ path: sample });
  assert.equal(r.matched.length, 7);
  assert.equal(r.matched[0].text.includes('agent started'), true);
  assert.equal(r.matched[0].n, 1, '行号从 1 开始');
  assert.equal(r.scanned, 7);
});

test('log.query：pattern 正则过滤（忽略大小写）', async () => {
  const r = await logQuery({ path: sample, pattern: 'handshake' });
  assert.equal(r.matched.length, 2, 'handshake timeout + handshake ok（pattern 忽略大小写）');
  assert.ok(r.matched.every((m) => /handshake/i.test(m.text)));
});

test('log.query：level 过滤只回该级别（含 WARNING→WARN 归一）', async () => {
  const errs = await logQuery({ path: sample, level: 'ERROR' });
  assert.equal(errs.matched.length, 2);
  assert.ok(errs.matched.every((m) => m.text.includes('[ERROR]')));
  const warns = await logQuery({ path: sample, level: 'WARN' });
  assert.equal(warns.matched.length, 1);
  // 无级别的行不会被 level 过滤命中
  assert.ok(!warns.matched.some((m) => m.text.includes('plain line')));
});

test('log.query：limit 与 offset 分页', async () => {
  const r = await logQuery({ path: sample, limit: 2, offset: 2 });
  assert.equal(r.matched.length, 2);
  assert.equal(r.matched[0].n, 3, 'offset=2 跳过前 2 条命中');
  assert.equal(r.matched[1].n, 4);
});

test('log.query：tail 取末尾 N 条', async () => {
  const r = await logQuery({ path: sample, tail: true, limit: 3 });
  assert.equal(r.matched.length, 3);
  assert.equal(r.matched[2].n, 7, '最后一条是第 7 行');
  assert.ok(r.matched[2].text.includes('ECONNREFUSED'));
});

test('log.query：since 按行首时间戳过滤', async () => {
  const since = Date.parse('2026-10-07T10:00:12');
  const r = await logQuery({ path: sample, since });
  // 10:00:12 及之后共 4 行（12/15/20 + plain 行无时间戳 → 放行）
  assert.equal(r.matched.length, 4);
  assert.ok(!r.matched.some((m) => m.text.includes('agent started')));
});

test('log.query：非法 pattern / level / 路径均被拒', async () => {
  await assert.rejects(() => logQuery({ path: sample, pattern: '[' }), /不是合法正则/);
  await assert.rejects(() => logQuery({ path: sample, level: 'TRACEY' }), /不支持的 level/);
  await assert.rejects(() => logQuery({ path: join(dir, 'nope.log') }), /不存在或不可读/);
  await assert.rejects(() => logQuery({ path: dir }), /不是普通文件/);
});

test('log.query：limit 上限裁剪（5000）', async () => {
  // limit=99999 应被裁剪到 5000，不报错
  const r = await logQuery({ path: sample, limit: 99999 });
  assert.equal(r.matched.length, 7);
});

test('parseLeadingTs：支持 ISO 与方括号形态', () => {
  assert.equal(parseLeadingTs('[2026-10-07 10:00:12] [WARN] x'), Date.parse('2026-10-07T10:00:12'));
  assert.equal(parseLeadingTs('2026-10-07T10:00:12Z hello'), Date.parse('2026-10-07T10:00:12Z'), 'Z 必须按 UTC 解析（曾被吃掉 → 偏 8 小时）');
  assert.equal(parseLeadingTs('2026-10-07T10:00:12+08:00 x'), Date.parse('2026-10-07T10:00:12+08:00'), '带偏移量同理');
  assert.equal(parseLeadingTs('[2026-10-07 10:00:12] x'), Date.parse('2026-10-07T10:00:12'), '无时区 → 本地时间');
  assert.equal(parseLeadingTs('2026/10/07 10:00:12 x'), Date.parse('2026-10-07T10:00:12'));
  assert.equal(parseLeadingTs('no timestamp here'), null);
});

process.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});
