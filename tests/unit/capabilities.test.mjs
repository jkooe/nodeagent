import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CapabilityNames,
  CAPABILITY_MANIFEST,
  findCapability,
  validate,
  applyDefaults,
} from '../../packages/protocol/dist/index.js';

// ---------- 清单完整性（v7~v10 新增能力纳入守护） ----------

test('清单：能力名与 manifest 一一对应，无重复', () => {
  const names = Object.values(CapabilityNames);
  assert.equal(new Set(names).size, names.length, '能力名不应重复');
  for (const n of names) {
    assert.ok(findCapability(n), `能力 ${n} 缺少 manifest 条目`);
  }
  assert.equal(CAPABILITY_MANIFEST.length, names.length, 'manifest 条目数应与能力名数一致');
});

test('清单：每条都有 version/description/risk 与封闭的 params_schema', () => {
  for (const c of CAPABILITY_MANIFEST) {
    assert.match(c.version, /^\d+\.\d+$/, `${c.name} 版本号格式`);
    assert.ok(c.description && c.description.length >= 8, `${c.name} 描述过短`);
    assert.ok(['low', 'medium', 'high'].includes(c.risk), `${c.name} risk 取值非法`);
    assert.equal(c.params_schema?.type, 'object', `${c.name} params_schema 应为 object`);
    assert.equal(
      c.params_schema?.additionalProperties,
      false,
      `${c.name} params_schema 应封闭（additionalProperties: false）`,
    );
  }
});

test('清单：v7~v11 新能力均已登记', () => {
  const expected = [
    'system.agent.restart',
    'window.list',
    'window.focus',
    'screen.find',
    'system.task.list',
    'system.task.get',
    'system.task.kill',
    'clip.get',
    'clip.set',
    'system.audit.verify',
    'input.mouse.drag',
    'screen.record',
    'event.watch',
    'event.unwatch',
    'event.list',
    'event.poll',
    'system.metrics',
  ];
  for (const name of expected) {
    assert.ok(findCapability(name), `缺少 ${name}`);
  }
  assert.equal(CAPABILITY_MANIFEST.length, 36, '当前应有 36 项能力');
});

// ---------- 参数校验（新能力） ----------

function check(capName, args) {
  const cap = findCapability(capName);
  return validate(args, cap.params_schema);
}

test('system.task.get：task_id 必填，offset 可选', () => {
  assert.equal(check('system.task.get', { task_id: 't_1' }).length, 0);
  assert.ok(check('system.task.get', {}).length > 0, '缺 task_id 应报错');
  assert.equal(check('system.task.get', { task_id: 't_1', offset: 1024 }).length, 0);
});

test('system.task.list：不接受多余参数', () => {
  assert.equal(check('system.task.list', {}).length, 0);
  assert.ok(check('system.task.list', { bogus: 1 }).length > 0, '多余参数应被拒');
});

test('clip.set：支持文本或图片，二者可选但 handler 会强制至少一个', () => {
  assert.equal(check('clip.set', { text: '中文 ✅' }).length, 0);
  assert.equal(check('clip.set', { text: '' }).length, 0, '空串合法（清空剪贴板）');
  assert.equal(check('clip.set', { image_base64: 'iVBORw0KGgo=' }).length, 0, '图片 Base64 合法');
  // schema 层允许空对象（text/image_base64 均为可选），由 handler 报错——避免 schema 过严导致组合校验困难
  assert.equal(check('clip.set', {}).length, 0, 'schema 层不拒绝空对象');
  assert.ok(check('clip.set', { bogus: 1 }).length > 0, '未知参数仍应被拒');
});

test('clip.get：format 枚举受控', () => {
  assert.equal(check('clip.get', {}).length, 0);
  assert.equal(check('clip.get', { format: 'image' }).length, 0);
  assert.ok(check('clip.get', { format: 'video' }).length > 0, '非法 format 应被拒');
});

test('input.mouse.drag：四个坐标必填，steps 有上下限', () => {
  assert.equal(
    check('input.mouse.drag', { from_x: 0, from_y: 0, to_x: 100, to_y: 100 }).length,
    0,
  );
  assert.ok(check('input.mouse.drag', { from_x: 0, from_y: 0 }).length > 0, '缺坐标应报错');
  assert.ok(
    check('input.mouse.drag', { from_x: 0, from_y: 0, to_x: 1, to_y: 1, steps: 0 }).length > 0,
    'steps 下限 1',
  );
});

test('screen.find：method 枚举受控，非法值被拒', () => {
  assert.equal(check('screen.find', { text: '确定' }).length, 0);
  assert.equal(check('screen.find', { text: 'x', method: 'ocr' }).length, 0);
  assert.ok(check('screen.find', { text: 'x', method: 'magic' }).length > 0, '非法 method 应被拒');
});

test('screen.find：v15 图像模板 —— method=image 与 template/threshold', () => {
  assert.equal(check('screen.find', { method: 'image', template: 'C:\\icon.png' }).length, 0);
  assert.equal(check('screen.find', { text: 'x', method: 'image', threshold: 0.9 }).length, 0);
  // text 改为可选（image 模式不需要），但 handler 仍会校验「非 image 模式必须有 text」
  assert.equal(check('screen.find', {}).length, 0, 'schema 层允许空对象（由 handler 判定 text/template）');
  assert.ok(check('screen.find', { text: 'x', threshold: 0.1 }).length > 0, 'threshold 下限 0.3');
  assert.ok(check('screen.find', { text: 'x', threshold: 1.5 }).length > 0, 'threshold 上限 0.999');
  assert.ok(check('screen.find', { text: 'x', bogus: 1 }).length > 0, '未知参数应被拒');
});

test('input.key.press：支持 repeat 与 sequence', () => {
  assert.equal(check('input.key.press', { keys: ['ctrl', 'c'] }).length, 0);
  assert.equal(check('input.key.press', { keys: ['up'], repeat: 3 }).length, 0);
  assert.equal(check('input.key.press', { sequence: [['up'], ['enter']] }).length, 0);
  assert.ok(check('input.key.press', { keys: ['up'], repeat: 0 }).length > 0, 'repeat 下限 1');
  assert.ok(check('input.key.press', { keys: ['up'], repeat: 99 }).length > 0, 'repeat 上限 50');
});

test('system.agent.restart：参数可省略', () => {
  assert.equal(check('system.agent.restart', {}).length, 0);
  assert.equal(check('system.agent.restart', { delay_ms: 3000, reason: 'cfg' }).length, 0);
  assert.ok(check('system.agent.restart', { delay_ms: 0 }).length > 0, 'delay_ms 下限 1');
});

test('system.shell.exec：async 与 wait_forever 为合法布尔', () => {
  assert.equal(check('system.shell.exec', { command: 'echo hi' }).length, 0);
  assert.equal(check('system.shell.exec', { command: 'sleep 1', async: true }).length, 0);
  assert.equal(
    check('system.shell.exec', { command: 'x', async: true, wait_forever: true }).length,
    0,
  );
  assert.ok(check('system.shell.exec', { command: 'x', async: 'yes' }).length > 0, '类型错误应被拒');
});

test('event.watch：kind 枚举受控，file 需 path，interval 有上下限', () => {
  assert.equal(check('event.watch', { kind: 'file', path: 'C:\\tmp' }).length, 0);
  assert.equal(check('event.watch', { kind: 'process', pattern: 'chrome*' }).length, 0);
  assert.equal(check('event.watch', { kind: 'net', interval_ms: 2000 }).length, 0);
  assert.ok(check('event.watch', { kind: 'disk' }).length > 0, '非法 kind 应被拒');
  assert.ok(check('event.watch', { kind: 'net', interval_ms: 100 }).length > 0, 'interval 下限 1s');
  assert.ok(check('event.watch', { kind: 'net', interval_ms: 99999 }).length > 0, 'interval 上限 60s');
});

test('event.poll：游标与条数可省略，且不接受未知参数', () => {
  assert.equal(check('event.poll', {}).length, 0);
  assert.equal(check('event.poll', { since: 12, limit: 100 }).length, 0);
  assert.ok(check('event.poll', { limit: 0 }).length > 0, 'limit 下限 1');
  assert.ok(check('event.poll', { limit: 999 }).length > 0, 'limit 上限 500');
  assert.ok(check('event.poll', { bogus: 1 }).length > 0, '未知参数应被拒');
});

// ---------- 默认值 ----------

test('applyDefaults：新能力默认值正确填充', () => {
  const screenFind = applyDefaults({ text: 'x' }, findCapability('screen.find').params_schema);
  assert.equal(screenFind.method, 'auto', 'screen.find 默认 auto');

  const taskGet = applyDefaults({ task_id: 't' }, findCapability('system.task.get').params_schema);
  assert.equal(taskGet.stream, 'stdout');
  assert.equal(taskGet.offset, 0);

  const exec = applyDefaults({ command: 'x' }, findCapability('system.shell.exec').params_schema);
  assert.equal(exec.async, false);
  assert.equal(exec.timeout_ms, 30000);
});
