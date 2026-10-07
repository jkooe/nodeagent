/**
 * 控制台契约守卫：`apps/console/src/types/index.ts` 里声明的字段名，
 * **必须**能在协议 manifest 的 `returns_schema` 里找到。
 *
 * ⚠️ 背景（2026-10-07 实测才发现）：M3 七个页面写完后，用 `examples/probe.rs`
 *    对真实被控端跑了一遍字段契约探针，抓到 4 处**界面恒空**的漂移：
 *      - 进程表读 `r.cpu` / `r.memory`，真源是 `cpu_pct` / `memory_bytes` → CPU、内存两列恒为 "-"
 *      - 磁盘读 `d.mount || d.name` / `d.used`，真源是 `drive`，且**没有 used**（只有 total/free）→ 盘名与已用量恒空
 *      - 服务表读 `r.status`，真源是 `state` → 状态列恒空
 *      - 软件表读 `a.id`，真源是 `publisher`（`app.list` 结果**没有 id**）→ 整列恒空
 *    这些都不是运行时异常，是**静默空列**——类型系统抓不到（TS 只是声明，没人跟契约比对），
 *    页面上也只是显示 "-"。所以必须由本用例把「声明 ⊆ 契约」这条铁律钉死。
 *
 * 反向也查（契约 ⊆ 声明）：只对 `returns_schema` **完整枚举**了属性的能力生效，
 * 避免"契约加了字段、前端没跟上"这种漏检。
 *
 * 数据源一律取 `packages/protocol/dist`（已构建），与 capabilities.test.mjs 保持一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findCapability } from '../../packages/protocol/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const CONSOLE_TYPES = join(repoRoot, 'apps', 'console', 'src', 'types', 'index.ts');
const CONN_STORE = join(repoRoot, 'apps', 'console', 'src', 'stores', 'conn.ts');

const source = readFileSync(CONSOLE_TYPES, 'utf8');

/**
 * 极简 TS interface 解析：只取**顶层**字段名（大括号深度 = 1），
 * 忽略注释、字符串与嵌套对象字面量。够用于本项目这些扁平接口。
 */
function fieldsOf(interfaceName) {
  const start = source.indexOf(`export interface ${interfaceName} {`);
  if (start < 0) throw new Error(`未找到 interface ${interfaceName}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let body = '';
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
      if (depth === 1) continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    body += ch;
  }

  const names = new Set();
  let nest = 0;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    // 只在最外层（nest === 0）收集 `key?: type` / `key: type`
    if (nest === 0) {
      const m = /^([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(line);
      if (m) names.add(m[1]);
      // 索引签名 `[k: string]: unknown` 跳过
    }
    nest += opens - closes;
  }
  return names;
}

/** 取某能力 `returns_schema.properties` 的键集合。 */
function contractTop(capName) {
  const cap = findCapability(capName);
  assert.ok(cap, `能力 ${capName} 不存在于 manifest`);
  return new Set(Object.keys(cap.returns_schema?.properties ?? {}));
}

/** 取某能力某个数组字段 `items.properties` 的键集合。 */
function contractItems(capName, arrayField) {
  const cap = findCapability(capName);
  const arr = cap?.returns_schema?.properties?.[arrayField];
  assert.ok(arr, `${capName}.returns_schema.${arrayField} 不存在`);
  return new Set(Object.keys(arr.items?.properties ?? {}));
}

/** 取某能力某对象字段（如 system.status.disks）的 items/自属性键集合。 */
function contractNested(capName, objField) {
  const cap = findCapability(capName);
  const node = cap?.returns_schema?.properties?.[objField];
  assert.ok(node, `${capName}.returns_schema.${objField} 不存在`);
  return new Set(Object.keys(node.items?.properties ?? node.properties ?? {}));
}

// ---------- 声明 ⊆ 契约（抓「声明了不存在的字段」） ----------

/** [ 控制台 interface, 能力名, 契约字段来源 ] */
const FORWARD_CASES = [
  ['SystemInfo', 'system.info', () => contractTop('system.info')],
  ['SystemStatus', 'system.status', () => contractTop('system.status')],
  ['DiskInfo', 'system.status', () => contractNested('system.status', 'disks')],
  ['NetInfo', 'system.status', () => contractNested('system.status', 'net')],
  ['ProcessEntry', 'system.process.list', () => contractItems('system.process.list', 'processes')],
  ['ServiceEntry', 'system.service.list', () => contractItems('system.service.list', 'services')],
  ['FsEntry', 'fs.list', () => contractItems('fs.list', 'entries')],
  ['FsListResult', 'fs.list', () => contractTop('fs.list')],
  ['FsReadResult', 'fs.read', () => contractTop('fs.read')],
  ['AppEntry', 'app.list', () => contractItems('app.list', 'apps')],
  ['AuditVerifyResult', 'system.audit.verify', () => contractTop('system.audit.verify')],
];

for (const [iface, capName, contract] of FORWARD_CASES) {
  test(`契约：${iface} 的字段都存在于 ${capName} 的 returns_schema`, () => {
    const declared = fieldsOf(iface);
    const allowed = contract();
    const missing = [...declared].filter((f) => !allowed.has(f));
    assert.deepEqual(
      missing,
      [],
      `${iface} 声明了 ${capName} 契约中不存在的字段：${missing.join(', ')}\n` +
        `（契约字段：${[...allowed].join(', ')}）\n` +
        `👉 这类漂移不会报错，只会让界面出现**静默空列**。`,
    );
  });
}

// ---------- 契约 ⊆ 声明（抓「契约加了字段、前端没跟上」） ----------

/**
 * 只对 returns_schema **完整枚举**属性的能力做反向校验，
 * 否则 `type: 'object'` 的空壳（如 system.audit.list 的 entries item）会误报。
 */
const REVERSE_CASES = [
  ['SystemInfo', 'system.info', () => contractTop('system.info')],
  ['SystemStatus', 'system.status', () => contractTop('system.status')],
  ['ProcessEntry', 'system.process.list', () => contractItems('system.process.list', 'processes')],
  ['ServiceEntry', 'system.service.list', () => contractItems('system.service.list', 'services')],
  ['FsEntry', 'fs.list', () => contractItems('fs.list', 'entries')],
  ['FsReadResult', 'fs.read', () => contractTop('fs.read')],
  ['AppEntry', 'app.list', () => contractItems('app.list', 'apps')],
];

for (const [iface, capName, contract] of REVERSE_CASES) {
  test(`契约：${capName} 的字段都被 ${iface} 覆盖`, () => {
    const declared = fieldsOf(iface);
    const required = contract();
    const missed = [...required].filter((f) => !declared.has(f));
    assert.deepEqual(
      missed,
      [],
      `${capName} 契约里有 ${missed.join(', ')}，但 ${iface} 未声明（前端拿不到这些字段）。`,
    );
  });
}

// ---------- 平台门控清单与 agent 实现一致 ----------

test('平台门控：控制台的 WINDOWS_ONLY_CAPS 与被控端抛 UNSUPPORTED_PLATFORM 的能力一致', () => {
  const storeSrc = readFileSync(CONN_STORE, 'utf8');
  const m = /WINDOWS_ONLY_CAPS\s*=\s*\[([^\]]*)\]/.exec(storeSrc);
  assert.ok(m, '未在 conn.ts 找到 WINDOWS_ONLY_CAPS');
  const declared = new Set(
    m[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean),
  );

  // 从被控端实现里找平台门控点：`UNSUPPORTED_PLATFORM` 出现处附近的能力名。
  const gated = new Set();
  for (const rel of [
    ['apps', 'agent', 'src', 'capabilities', 'app.ts'],
    ['apps', 'agent', 'src', 'capabilities', 'system.ts'],
  ]) {
    const src = readFileSync(join(repoRoot, ...rel), 'utf8');
    // requireWindows('app.xxx') 与 `${capability} 仅在被控端为 Windows 时可用` 两种写法
    for (const mm of src.matchAll(/requireWindows\(\s*['"]([\w.]+)['"]/g)) gated.add(mm[1]);
    for (const mm of src.matchAll(/['"]([\w.]+) 仅在被控端为 Windows 时可用['"]/g)) {
      // 该文件里 system.service.list 是以字面量写的；app.ts 是模板串（已由上面捕获）
      if (mm[1].includes('.')) gated.add(mm[1]);
    }
  }

  const declaredArr = [...declared].sort();
  const gatedArr = [...gated].sort();
  assert.deepEqual(
    declaredArr,
    gatedArr,
    '控制台的平台门控清单与被控端实际门控的能力不一致：\n' +
      `  控制台声明：${declaredArr.join(', ')}\n` +
      `  被控端实际：${gatedArr.join(', ')}`,
  );
});

// ---------- 审计事件类别与真源一致 ----------

test('审计：控制台的 AuditType 覆盖 audit.ts 的全部 AuditType 取值', () => {
  const auditSrc = readFileSync(
    join(repoRoot, 'apps', 'agent', 'src', 'audit.ts'),
    'utf8',
  );
  const union = /export type AuditType\s*=([\s\S]*?);/.exec(auditSrc);
  assert.ok(union, '未在 audit.ts 找到 AuditType 联合类型');
  const real = new Set(
    [...union[1].matchAll(/'([\w.]+)'/g)].map((mm) => mm[1]),
  );
  assert.ok(real.size >= 8, `AuditType 解析异常，仅取到 ${real.size} 个`);

  const declared = fieldsOf('AuditEntry');
  assert.ok(declared.size > 0, 'AuditEntry 解析失败');
  // union 类型不是 interface —— 直接正则取类型字面量
  const m = /export type AuditType\s*=([\s\S]*?);/.exec(
    readFileSync(CONSOLE_TYPES, 'utf8'),
  );
  assert.ok(m, '未在控制台 types/index.ts 找到 AuditType');
  const consoleTypes = new Set([...m[1].matchAll(/"([\w.]+)"/g)].map((mm) => mm[1]));

  const missed = [...real].filter((t) => !consoleTypes.has(t));
  assert.deepEqual(
    missed,
    [],
    `控制台 AuditType 缺少：${missed.join(', ')}（真源：${[...real].join(', ')}）`,
  );
});
