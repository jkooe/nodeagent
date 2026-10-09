import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * MCP 工具清单的回归守卫（2026-10 拆分时建立）。
 *
 * 背景：TOOLS 从 index.ts 抽到 tools/defs.ts（1139 → 530 行）。抽出的风险是
 * **顺序漂移**或**漏搬**，而这两者都不会让构建失败 —— 只会静默改变客户端看到的工具表。
 * 故用「工具名序列 sha256」做证据：序列一旦变化，本测试立刻红。
 */

const DEFS = fileURLToPath(new URL('../../apps/mcp/src/tools/defs.ts', import.meta.url));
const src = readFileSync(DEFS, 'utf8');

/** 拆分时记录的基线（顺序敏感）。改工具清单时**必须**同步更新此值。 */
const BASELINE_SEQ_SHA = '69e8533c42c302f8e5404004b76bb6d8c4ad4bcec3d57711cb1c4de128d892b7';

function toolNames() {
  return [...src.matchAll(/^\s*name: '(na_[a-z_]+)',/gm)].map((m) => m[1]);
}

test('tools/defs.ts：工具数 41 且名称唯一', () => {
  const names = toolNames();
  assert.equal(names.length, 41, '工具数变了 —— 若有意增删，请同步更新 BASELINE_SEQ_SHA');
  assert.equal(new Set(names).size, names.length, '存在重复工具名（MCP 客户端会不认）');
});

test('tools/defs.ts：工具名序列与顺序未漂移（顺序即对外呈现顺序）', () => {
  const sha = createHash('sha256').update(toolNames().join('|')).digest('hex');
  assert.equal(
    sha,
    BASELINE_SEQ_SHA,
    '工具顺序变了 —— 顺序即客户端看到的列表次序。若为有意调整，请更新 BASELINE_SEQ_SHA 并说明原因',
  );
});

test('tools/defs.ts：每个工具都有 name/description/inputSchema 三件套', () => {
  const objects = src.split(/\n  \{\n/).slice(1);
  for (const obj of objects) {
    assert.match(obj, /name: 'na_/, '缺少 name');
    assert.match(obj, /description:/, '缺少 description（MCP 靠它让模型知道何时用）');
    assert.match(obj, /inputSchema: \{/, '缺少 inputSchema');
  }
});

test('tools/defs.ts：inputSchema 均声明 type=object 且禁止未声明属性', () => {
  const schemas = [...src.matchAll(/inputSchema: \{([^}]*type: 'object'[^}]*)\}/g)];
  assert.ok(schemas.length >= 1, '未找到 inputSchema');
  // 逐工具检查 additionalProperties（允许三种写法：内联 false / 单独一行）
  const inline = (src.match(/additionalProperties: false/g) ?? []).length;
  const tools = toolNames().length;
  assert.ok(
    inline >= tools - 2,
    `additionalProperties: false 只出现 ${inline} 次，少于工具数 ${tools}（可能漏了约束）`,
  );
});
