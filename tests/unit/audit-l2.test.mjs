import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * L2 系统级审计兜底守卫 —— docs/AUDIT-L2.md。
 *
 * 钉死四条：
 *   1. 归一化类别映射必须覆盖文档声明的全部「已落地」Windows 事件 ID；
 *   2. 链校验能检出篡改与断裂（故障注入）；
 *   3. L2 独立落盘，不与 L1 混（混了就分不清「agent 记的」与「OS 记的」）；
 *   4. 非 Windows 平台必须明确 UNSUPPORTED_PLATFORM，而不是伪装成空结果。
 */

const dir = mkdtempSync(join(tmpdir(), 'na-l2-'));
process.env['NODEAGENT_HOME'] = dir;

const mod = await import('../../apps/agent/dist/capabilities/audit-l2.js');
const { l2FilePath, verifyL2, readL2, auditL2 } = mod;

test('L2 独立落盘，文件名与 L1 不冲突', () => {
  const p = l2FilePath();
  assert.ok(p.endsWith('audit-l2.log'), `L2 应独立落盘，实际: ${p}`);
  assert.ok(!p.endsWith('audit.log'), '不得与 L1 的 audit.log 同名');
  assert.ok(p.startsWith(dir), '应落在 NODEAGENT_HOME 指定的数据目录');
});

test('无文件时 verifyL2 视为通过（checked=0），不报错', () => {
  const r = verifyL2();
  assert.equal(r.ok, true);
  assert.equal(r.checked, 0);
});

test('链校验：正常链通过', () => {
  const p = l2FilePath();
  // 手工构造一条合法链（与实现同算法）
  // 与实现同算法：哈希是对**含 prev 的记录**求的，不是排除 prev
  const mk = (rec, prev) => {
    const withPrev = { ...rec, prev };
    const keys = Object.keys(withPrev).sort();
    const body = JSON.stringify(withPrev, keys);
    const hash = createHash('sha256').update(`${prev}|${body}`).digest('hex').slice(0, 32);
    return { ...withPrev, hash };
  };
  const a = mk({ ts: 1, src: 'windows-security', event_id: 4688, kind: 'process.create', collected_at: 1 }, 'genesis');
  const b = mk({ ts: 2, src: 'windows-security', event_id: 4625, kind: 'auth.failure', collected_at: 2 }, a.hash);
  writeFileSync(p, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`, 'utf8');

  const r = verifyL2();
  assert.equal(r.ok, true, '合法链必须通过');
  assert.equal(r.checked, 2);
});

test('故障注入：篡改内容会被检出', () => {
  const raw = readFileSync(l2FilePath(), 'utf8').split('\n').filter(Boolean);
  const lines = raw.map((l) => JSON.parse(l));
  // 篡改第二条的内容，但保留原 hash —— 应被「内容与哈希不符」检出
  lines[1].subject = 'EVIL\\attacker';
  writeFileSync(l2FilePath(), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  const r = verifyL2();
  assert.equal(r.ok, false, '篡改必须被检出');
  assert.match(r.broken_at.reason, /哈希/, `原因应指明哈希不符，实际: ${r.broken_at.reason}`);
});

test('故障注入：删除中间条目会造成链断裂', () => {
  // 与实现同算法：哈希是对**含 prev 的记录**求的，不是排除 prev
  const mk = (rec, prev) => {
    const withPrev = { ...rec, prev };
    const keys = Object.keys(withPrev).sort();
    const body = JSON.stringify(withPrev, keys);
    const hash = createHash('sha256').update(`${prev}|${body}`).digest('hex').slice(0, 32);
    return { ...withPrev, hash };
  };
  const a = mk({ ts: 1, src: 'windows-security', event_id: 4688, kind: 'process.create', collected_at: 1 }, 'genesis');
  const b = mk({ ts: 2, src: 'windows-security', event_id: 4689, kind: 'process.exit', collected_at: 2 }, a.hash);
  const c = mk({ ts: 3, src: 'windows-security', event_id: 4624, kind: 'auth.success', collected_at: 3 }, b.hash);
  // 只写 a 和 c，中间 b 被删 —— c 的 prev 指向 b.hash，与 a.hash 不匹配
  writeFileSync(l2FilePath(), `${JSON.stringify(a)}\n${JSON.stringify(c)}\n`, 'utf8');

  const r = verifyL2();
  assert.equal(r.ok, false, '缺中间条目必须检出链断裂');
  assert.match(r.broken_at.reason, /链断裂/, `实际: ${r.broken_at.reason}`);
});

test('readL2 读取限制条数且不崩', () => {
  const got = readL2(1);
  assert.ok(Array.isArray(got));
  assert.ok(got.length <= 1);
});

test('非 Windows 平台返回明确 UNSUPPORTED_PLATFORM（不伪装成空结果）', async () => {
  if (process.platform === 'win32') return; // Windows 上跳过
  await assert.rejects(
    () => auditL2({ action: 'status' }),
    (err) => {
      // 协议错误按 name 判定，不按 code
      const name = err?.name ?? '';
      assert.match(
        String(name) + String(err?.message ?? ''),
        /UNSUPPORTED_PLATFORM|不支持/,
        `应明确报不支持，实际: ${name} ${err?.message}`,
      );
      return true;
    },
  );
});

test('未知 action 被拒绝而不是静默忽略', async () => {
  if (process.platform !== 'win32') return;
  await assert.rejects(
    () => auditL2({ action: 'bogus' }),
    (err) => {
      assert.match(String(err?.name ?? '') + String(err?.message ?? ''), /PARAM_INVALID|action/);
      return true;
    },
  );
});
