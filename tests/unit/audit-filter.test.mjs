/**
 * C-01 守卫：审计筛选项不得与协议 enum 漂移。
 *
 * ⚠️ 背景（真机实测 2026-10-13，P1）：控制台下拉框列了 11 个**细粒度**取值
 *    （`auth.success` / `acl.denied` / …），而 manifest 的 `enum` 只有
 *    `['invoke','auth','acl','agent']` → 被控端 schema 校验把**除 `invoke` 外**的取值
 *    全部判成 `E_PARAM_INVALID`。下拉框形同虚设，而且**不报类型错**
 *    （和「静默空列」同一类病：类型系统抓不到，只有把真源钉死才防得住）。
 *
 * 真源：`packages/protocol/src/audit-types.ts` 的 `AUDIT_TYPES` / `AUDIT_TYPE_PREFIXES`。
 * 本文件把三处一致性都钉住：真源 ↔ manifest enum ↔ 控制台下拉框；
 * 另外用真实 `readAudit()` 验证「过滤是按前缀匹配」这一被依赖的语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  AUDIT_TYPES,
  AUDIT_TYPE_PREFIXES,
  AUDIT_FILTER_TYPES,
  findCapability,
} from '../../packages/protocol/dist/index.js';
import { initAudit, audit, readAudit } from '../../apps/agent/dist/audit.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const AUDIT_VIEW = join(repoRoot, 'apps', 'console', 'src', 'views', 'AuditView.vue');

/** 从 AuditView.vue 的 `typeOptions` 里取出全部非空 `value:` 字面量。 */
function consoleTypeOptions() {
  const text = readFileSync(AUDIT_VIEW, 'utf8');
  const start = text.indexOf('const typeOptions');
  assert.ok(start >= 0, 'AuditView.vue 里找不到 typeOptions');
  const end = text.indexOf('];', start);
  assert.ok(end > start, 'typeOptions 数组未正常结束');
  const block = text.slice(start, end);
  return [...block.matchAll(/value:\s*"([^"]*)"/g)].map((m) => m[1]).filter((v) => v !== '');
}

test('C-01：协议真源自洽（精确类型 ∪ 粗粒度前缀，去重）', () => {
  assert.equal(new Set(AUDIT_TYPES).size, AUDIT_TYPES.length, 'AUDIT_TYPES 不得有重复项');
  const expect = Array.from(new Set([...AUDIT_TYPES, ...AUDIT_TYPE_PREFIXES]));
  assert.deepEqual([...AUDIT_FILTER_TYPES].sort(), expect.sort());
});

test('C-01：manifest 的 enum 与真源完全一致', () => {
  const cap = findCapability('system.audit.list');
  assert.ok(cap, '找不到 system.audit.list');
  const enumVals = cap.params_schema.properties.type.enum;
  assert.deepEqual(
    [...enumVals].sort(),
    [...AUDIT_FILTER_TYPES].sort(),
    'manifest enum 与 AUDIT_FILTER_TYPES 漂移 —— 曾经手写成 4 个值，导致控制台筛选静默失效',
  );
});

test('C-01：每个审计类型都必须能被至少一个合法筛选值命中（没有筛不到的事件）', () => {
  for (const t of AUDIT_TYPES) {
    const hit = AUDIT_FILTER_TYPES.some((f) => t.startsWith(f));
    assert.ok(hit, `审计类型 ${t} 无法被任何合法筛选值命中 —— 用户会以为它从未发生`);
  }
});

test('C-01：每个粗粒度前缀都必须真能命中至少一个类型（不得有「永远为空」的选项）', () => {
  for (const p of AUDIT_TYPE_PREFIXES) {
    const hits = AUDIT_TYPES.filter((t) => t.startsWith(p));
    assert.ok(hits.length > 0, `前缀 ${p} 命中不了任何审计类型 —— 下拉框里会是个永远为空的选项`);
  }
});

test('C-01：控制台下拉框取值 ⊆ 真源，且覆盖全部粗粒度前缀', () => {
  const values = consoleTypeOptions();
  assert.ok(values.length > 0, '未能从 AuditView.vue 解析出 typeOptions（解析规则需同步更新）');
  for (const v of values) {
    assert.ok(
      AUDIT_FILTER_TYPES.includes(v),
      `控制台选项 ${v} 不在 AUDIT_FILTER_TYPES 里 —— 会被判 E_PARAM_INVALID（C-01 复发）`,
    );
  }
  for (const p of AUDIT_TYPE_PREFIXES) {
    assert.ok(values.includes(p), `控制台下拉框缺少粗粒度前缀 ${p}`);
  }
});

test('C-01：readAudit 的 type 过滤确实是前缀匹配（控制台粗粒度分组依赖它）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'na-audit-filter-'));
  initAudit({ enabled: true, logArgs: false }, dir);

  audit({ type: 'auth.success', client_id: 'a' });
  audit({ type: 'auth.failure', client_id: 'a' });
  audit({ type: 'invoke', capability: 'system.info' });
  audit({ type: 'acl.denied', capability: 'fs.read' });
  audit({ type: 'request.rejected', reason: '畸形报文' });
  audit({ type: 'agent.start' });

  const auth = readAudit({ type: 'auth', limit: 100 });
  assert.equal(auth.entries.length, 2, `auth 应命中 auth.success + auth.failure，实际 ${auth.entries.length}`);
  assert.ok(auth.entries.every((e) => e.type.startsWith('auth')));

  const agent = readAudit({ type: 'agent', limit: 100 });
  assert.ok(
    agent.entries.some((e) => e.type === 'agent.start'),
    'agent 前缀应命中 agent.start',
  );

  const exact = readAudit({ type: 'acl.denied', limit: 100 });
  assert.equal(exact.entries.length, 1, '精确类型也应可用（真实类型本身就是自己的前缀）');

  const rejected = readAudit({ type: 'request', limit: 100 });
  assert.equal(rejected.entries.length, 1, 'request 前缀应命中 request.rejected（U-01 新增类型必须可筛）');

  const all = readAudit({ limit: 100 });
  assert.equal(all.entries.length, 6, '不带 type 时应返回全部');
});

test('C-01：U-01 的 request.rejected 与兜底的 agent.error 都在真源里', () => {
  assert.ok(AUDIT_TYPES.includes('request.rejected'), '被拒请求必须可被筛选（否则 U-01 等于白修）');
  assert.ok(AUDIT_TYPES.includes('agent.error'), '进程级兜底错误必须可被筛选');
  for (const t of ['request.rejected', 'agent.error']) {
    assert.ok(AUDIT_FILTER_TYPES.includes(t));
  }
});
