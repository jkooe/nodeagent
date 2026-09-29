import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initAudit, audit, verifyAudit } from '../../apps/agent/dist/audit.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'na-audit-'));
}

test('审计链：正常写入后可校验通过，且条目带 prev/hash', () => {
  const dir = freshDir();
  initAudit({ enabled: true }, dir);
  for (let i = 0; i < 5; i += 1) {
    audit({ type: 'invoke', capability: 'system.info', status: 'ok', duration_ms: i });
  }
  const first = JSON.parse(readFileSync(join(dir, 'audit.log'), 'utf8').split('\n')[0]);
  assert.equal(first.prev, 'genesis', '首条 prev 应为 genesis');
  assert.equal(typeof first.hash, 'string');
  assert.equal(first.hash.length, 32);

  const r = verifyAudit();
  assert.equal(r.ok, true, `应校验通过，实际: ${JSON.stringify(r.broken_at)}`);
  assert.equal(r.checked, 5);
  assert.equal(r.legacy, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('审计链：链式相连（第二条 prev = 第一条 hash）', () => {
  const dir = freshDir();
  initAudit({ enabled: true }, dir);
  audit({ type: 'agent.start' });
  audit({ type: 'auth.success', client_id: 'mac_01' });
  const lines = readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n');
  const a = JSON.parse(lines[0]);
  const b = JSON.parse(lines[1]);
  assert.equal(b.prev, a.hash, '第二条 prev 应指向第一条 hash');
  rmSync(dir, { recursive: true, force: true });
});

test('审计链：内容被篡改会被检出', () => {
  const dir = freshDir();
  initAudit({ enabled: true }, dir);
  audit({ type: 'invoke', capability: 'fs.write', status: 'ok' });
  audit({ type: 'invoke', capability: 'system.info', status: 'ok' });
  audit({ type: 'auth.success', client_id: 'mac_01' });

  // 篡改第二条的 capability（保持 JSON 合法，仅改内容）
  const p = join(dir, 'audit.log');
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[1]);
  rec.capability = 'fs.read';
  lines[1] = JSON.stringify(rec);
  writeFileSync(p, lines.join('\n') + '\n');

  const r = verifyAudit();
  assert.equal(r.ok, false, '篡改后应校验失败');
  assert.equal(r.broken_at.line, 2);
  assert.match(r.broken_at.reason, /哈希/);
  rmSync(dir, { recursive: true, force: true });
});

test('审计链：删除中间条目会被检出（链断裂）', () => {
  const dir = freshDir();
  initAudit({ enabled: true }, dir);
  audit({ type: 'agent.start' });
  audit({ type: 'invoke', capability: 'system.info', status: 'ok' });
  audit({ type: 'auth.success', client_id: 'mac_01' });

  const p = join(dir, 'audit.log');
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  // 删掉中间一条
  writeFileSync(p, [lines[0], lines[2]].join('\n') + '\n');

  const r = verifyAudit();
  assert.equal(r.ok, false, '删除中间条目后应校验失败');
  assert.match(r.broken_at.reason, /链断裂/);
  rmSync(dir, { recursive: true, force: true });
});

test('审计链：历史无链字段条目记为 legacy 且不误报', () => {
  const dir = freshDir();
  // 手写两条「老版本」条目（无 prev/hash）
  const legacy = [
    { ts: Date.now() - 2000, type: 'agent.start' },
    { ts: Date.now() - 1000, type: 'invoke', capability: 'system.info', status: 'ok' },
  ];
  writeFileSync(join(dir, 'audit.log'), legacy.map((e) => JSON.stringify(e)).join('\n') + '\n');

  initAudit({ enabled: true }, dir);
  audit({ type: 'auth.success', client_id: 'mac_01' }); // 新条目带链字段

  const r = verifyAudit();
  assert.equal(r.ok, true, '老条目应跳过校验而非报错');
  assert.equal(r.legacy, 2);
  assert.equal(r.checked, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('审计链：agent 重启后链仍连续（从尾部恢复锚点）', () => {
  const dir = freshDir();
  initAudit({ enabled: true }, dir);
  audit({ type: 'agent.start' });
  const firstHash = JSON.parse(readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n')[0]).hash;

  // 模拟重启：重新 initAudit（会从文件尾部恢复 lastHash）
  initAudit({ enabled: true }, dir);
  audit({ type: 'agent.stop' });

  const lines = readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n');
  const second = JSON.parse(lines[1]);
  assert.equal(second.prev, firstHash, '重启后新条目应接续原链');
  assert.equal(verifyAudit().ok, true);
  rmSync(dir, { recursive: true, force: true });
});
