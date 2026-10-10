import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initAudit,
  audit,
  computeAuditHead,
  anchorAudit,
  compareWithAnchors,
  anchorFilePath,
} from '../../apps/agent/dist/audit.js';

/**
 * v2.0.0 审计链外部锚定的逻辑测试。
 *
 * 守的是三件最容易写错的事：
 *  1. 只记 head_hash 会把**轮转**误判成篡改（必须连 entries + rotated_segments 一起记）
 *  2. 整链重写（条目数变少且无轮转）必须被识别
 *  3. 条目数相同但哈希不同 = 该段被重写，必须被识别
 */

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'audit-anchor-'));
}

test('computeAuditHead：空链返回 null 链头而非报错', () => {
  const dir = freshDir();
  try {
    initAudit({}, dir);
    const h = computeAuditHead();
    assert.equal(h.entries, 0);
    assert.equal(h.head_hash, null);
    assert.equal(h.head_ts, null);
    assert.equal(h.rotated_segments, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anchorAudit：写出的锚点含四元组（entries + hash + ts + rotated）', () => {
  const dir = freshDir();
  try {
    initAudit({}, dir);
    audit({ type: 'agent.start' });
    audit({ type: 'auth.success', client_id: 'mac_01' });
    const file = join(dir, 'anchors.jsonl');
    const r = anchorAudit({ path: file, note: 'unit-test' });
    assert.equal(r.total_lines, 1);
    assert.equal(r.record.entries, 2);
    assert.ok(r.record.head_hash, '链头哈希应存在');
    assert.equal(r.record.rotated_segments, 0);
    assert.equal(r.record.note, 'unit-test');
    // 追加式：再锚一次应有两行
    anchorAudit({ path: file });
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compareWithAnchors：链未变化 → 三者相符', () => {
  const dir = freshDir();
  try {
    initAudit({}, dir);
    audit({ type: 'agent.start' });
    const file = join(dir, 'anchors.jsonl');
    anchorAudit({ path: file });
    const c = compareWithAnchors(file);
    assert.equal(c.ok, true);
    assert.match(c.verdict, /完全一致/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compareWithAnchors：链增长 → ok 且说明锚点仍在链上', () => {
  const dir = freshDir();
  try {
    initAudit({}, dir);
    audit({ type: 'agent.start' });
    const file = join(dir, 'anchors.jsonl');
    anchorAudit({ path: file });
    audit({ type: 'invoke', capability: 'system.info', status: 'ok' });
    const c = compareWithAnchors(file);
    assert.equal(c.ok, true);
    assert.match(c.verdict, /已增长|轮转/);
    assert.equal(c.detail.current_entries, 2);
    assert.equal(c.detail.anchored_entries, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compareWithAnchors：**整链重写**（条目数变少且无轮转）必须被抓', () => {
  const dir = freshDir();
  try {
    initAudit({}, dir);
    audit({ type: 'agent.start' });
    audit({ type: 'auth.success', client_id: 'mac_01' });
    audit({ type: 'invoke', capability: 'system.info', status: 'ok' });
    const file = join(dir, 'anchors.jsonl');
    anchorAudit({ path: file });

    // 模拟攻击者：把审计文件换成一份只有 1 条的自洽假链
    const auditFile = join(dir, 'audit.log');
    const one = readFileSync(auditFile, 'utf8').trim().split('\n')[0];
    writeFileSync(auditFile, `${one}\n`, 'utf8');

    const c = compareWithAnchors(file);
    assert.equal(c.ok, false, '整链重写必须判为不可信');
    assert.match(c.verdict, /整链重写|回滚/);
    assert.equal(c.detail.anchored_entries, 3);
    assert.equal(c.detail.current_entries, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compareWithAnchors：条目数相同但链头哈希不同 → 该段被重写', () => {
  const dir = freshDir();
  try {
    initAudit({}, dir);
    audit({ type: 'agent.start' });
    audit({ type: 'auth.success', client_id: 'mac_01' });
    const file = join(dir, 'anchors.jsonl');
    anchorAudit({ path: file });

    // 篡改末条内容但保持条目数不变（链内自洽性会被 verifyAudit 抓，这里测的是与锚点的比对）
    const auditFile = join(dir, 'audit.log');
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[1]);
    last.hash = 'deadbeefdeadbeef';
    lines[1] = JSON.stringify(last);
    writeFileSync(auditFile, `${lines.join('\n')}\n`, 'utf8');

    const c = compareWithAnchors(file);
    assert.equal(c.ok, false);
    assert.match(c.verdict, /链头哈希与锚点不一致/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compareWithAnchors：无锚点文件时明确提示先建锚点（不算失败）', () => {
  const dir = freshDir();
  try {
    initAudit({}, dir);
    const c = compareWithAnchors(join(dir, 'nope.jsonl'));
    assert.equal(c.ok, true);
    assert.equal(c.anchors_checked, 0);
    assert.match(c.verdict, /尚无锚点/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anchorFilePath：默认落在数据目录，可被 path 覆盖', () => {
  const def = anchorFilePath();
  assert.match(def, /audit-anchors\.jsonl$/);
  assert.equal(anchorFilePath(' /tmp/custom.jsonl '), '/tmp/custom.jsonl', '应 trim');
  assert.match(anchorFilePath(''), /audit-anchors\.jsonl$/, '空串回退默认');
});

test('锚点文件是追加式：历史锚点不会被后续覆盖（防"重写链后刷锚点"）', () => {
  const dir = freshDir();
  try {
    initAudit({}, dir);
    audit({ type: 'agent.start' });
    const file = join(dir, 'anchors.jsonl');
    anchorAudit({ path: file, note: 'first' });
    audit({ type: 'invoke', capability: 'x', status: 'ok' });
    anchorAudit({ path: file, note: 'second' });
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].note, 'first');
    assert.equal(lines[0].entries, 1, '第一条锚点必须保持原值');
    assert.equal(lines[1].entries, 2);
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
