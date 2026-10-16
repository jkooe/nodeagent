import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * LKG（最后已知可用版本）守卫 —— 交付流水线 §6。
 *
 * 为什么需要守卫：LKG 是回滚的**目标**。若它记错了（记成尚未验证的版本），
 * 回滚就会回到一个坏版本 —— 比没有 LKG 更糟，因为它给人虚假的安全感。
 * 故这里钉死三条：
 *   1. 记录内容必须与当前入口脚本真实一致；
 *   2. 文件不存在/损坏时**返回 null，不做任何猜测**；
 *   3. matches 的判定必须用同一套 hash 口径（与 system.info 的 build.hash 同）。
 */

// 通过 NODEAGENT_HOME 指向临时目录，避免污染真实数据目录
const dir = mkdtempSync(join(tmpdir(), 'na-lkg-'));
process.env['NODEAGENT_HOME'] = dir;

const { recordLKG, readLKG, lkgStatus, lkgFilePath } = await import('../../apps/agent/dist/lkg.js');

test('LKG 落在 NODEAGENT_HOME 指定的数据目录', () => {
  assert.ok(lkgFilePath().startsWith(dir), `LKG 路径应在临时目录内，实际: ${lkgFilePath()}`);
});

test('未记录时 readLKG 返回 null（不猜测）', () => {
  assert.equal(readLKG(), null);
});

test('记录后可读回，且 hash 与当前入口脚本真实一致', () => {
  const rec = recordLKG();
  assert.ok(rec, 'recordLKG 应返回记录');
  const back = readLKG();
  assert.ok(back, '应能读回');
  assert.equal(back.hash, rec.hash);
  assert.equal(back.bytes, rec.bytes);

  // 独立重算：与直接对 argv[1] 求 sha256 前 12 位比对
  const p = process.argv[1];
  const expect = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);
  assert.equal(back.hash, expect, 'LKG hash 必须等于入口脚本真实 sha256 前 12 位');
});

test('lkgStatus.matches 在记录后为 true，byte_delta 为 0', () => {
  recordLKG();
  const s = lkgStatus();
  assert.equal(s.matches, true);
  assert.equal(s.byte_delta, 0);
  assert.equal(s.current_hash, s.lkg.hash);
});

test('LKG 文件损坏时 readLKG 返回 null 而非抛错', () => {
  recordLKG();
  writeFileSync(lkgFilePath(), '{ this is not json', 'utf8');
  assert.equal(readLKG(), null, '损坏的 LKG 必须返回 null，不得抛错或猜值');
});

test('LKG 记录缺少 hash 字段时视为无效', () => {
  writeFileSync(lkgFilePath(), JSON.stringify({ bytes: 1 }), 'utf8');
  assert.equal(readLKG(), null);
});

test('故障注入：篡改 LKG 的 hash 会被 matches=false 检出', () => {
  recordLKG();
  const good = readLKG();
  // 模拟「更新后还没起来」：LKG 仍是旧值，而当前脚本已被替换成别的 hash
  writeFileSync(
    lkgFilePath(),
    JSON.stringify({ ...good, hash: 'deadbeefcafe' }, null, 2),
    'utf8',
  );
  const s = lkgStatus();
  assert.equal(s.matches, false, 'hash 不一致必须检出 matches=false（这是「暂缓放量」的判据）');
  assert.ok(s.lkg, 'LKG 记录本身仍应可读，供控制端定位回滚目标');
});

test('LKG 记录含回滚所需的全部字段', () => {
  recordLKG();
  const r = readLKG();
  for (const k of ['hash', 'bytes', 'script_path', 'recorded_at', 'node_version', 'platform']) {
    assert.ok(k in r, `LKG 缺少回滚所需字段: ${k}`);
  }
  assert.ok(existsSync(lkgFilePath()), 'LKG 文件应真实落盘');
});
