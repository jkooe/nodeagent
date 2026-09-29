import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMacro, loadMacroFile } from '../../packages/client/dist/index.js';

/**
 * 用一个「假客户端」驱动宏引擎 —— 不需要真实设备，只验证引擎自身的逻辑：
 * 变量替换、重试、可选步骤、失败中止、返回值透传。
 */
function fakeClient(handlers = {}) {
  const calls = [];
  return {
    calls,
    async invoke(capability, args) {
      calls.push({ capability, args });
      const h = handlers[capability];
      if (typeof h === 'function') {
        const r = h(args);
        if (r && r.__fail) return { status: 'failed', error: { name: r.name, message: r.message } };
        return { status: 'ok', data: r };
      }
      return { status: 'ok', data: {} };
    },
  };
}

test('宏：变量替换（含默认值与数组内替换）', async () => {
  const c = fakeClient({
    'input.key.type': (args) => ({ typed: true, text: args.text }),
  });
  const res = await runMacro(
    { client: c },
    {
      name: 'vars',
      steps: [
        { action: 'type', text: '你好 ${NAME}' },
        { action: 'type', text: '缺省 ${MISSING:-兜底}' },
      ],
    },
    { NAME: '世界' },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(c.calls[0].args.text, '你好 世界');
  assert.deepEqual(c.calls[1].args.text, '缺省 兜底');
});

test('宏：变量缺失且无默认值时该步失败', async () => {
  const c = fakeClient({ 'input.key.type': () => ({ typed: true }) });
  const res = await runMacro({ client: c }, { steps: [{ action: 'type', text: '${NOPE}' }] }, {});
  assert.equal(res.ok, false);
  assert.match(res.steps[0].detail, /变量未提供/);
});

test('宏：retry 生效（前两次失败、第三次成功）', async () => {
  let n = 0;
  const c = fakeClient({
    'window.focus': () => {
      n += 1;
      return n < 3 ? { __fail: true, name: 'E_NOT_FOUND', message: '窗口未出现' } : { focused: true, title: 'X', x: 0, y: 0, width: 10, height: 10 };
    },
  });
  const res = await runMacro(
    { client: c },
    { steps: [{ action: 'focus', title: 'X', retry: 3, interval_ms: 1 }] },
  );
  assert.equal(res.ok, true);
  assert.equal(n, 3, '应重试到第 3 次成功');
});

test('宏：optional 步骤失败不中断后续', async () => {
  const c = fakeClient({
    'window.focus': () => ({ __fail: true, name: 'E_NOT_FOUND', message: '没有' }),
    'exec': () => ({ exit_code: 0 }),
  });
  const res = await runMacro(
    { client: c },
    {
      steps: [
        { action: 'focus', title: '无关窗口', optional: true },
        { action: 'exec', command: 'echo ok' },
      ],
    },
  );
  assert.equal(res.ok, true, '整体应成功');
  assert.equal(res.steps[0].ok, false, '可选步骤标记为失败');
  assert.equal(res.steps[1].ok, true, '后续步骤仍执行');
});

test('宏：必需步骤失败即中止，并给出失败位置', async () => {
  const c = fakeClient({
    'exec': (args) => (String(args.command).includes('bad') ? { exit_code: 0, stdout: 'no' } : { exit_code: 0, stdout: 'yes' }),
  });
  const res = await runMacro(
    { client: c },
    {
      steps: [
        { action: 'exec', command: 'echo good' },
        { action: 'exec', command: 'echo bad', expect_stdout: '期望出现' },
        { action: 'exec', command: 'echo never' },
      ],
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.failed_at, 1, '应在第 1 步失败');
  assert.equal(res.steps.length, 2, '失败后不再执行第 2 步');
  assert.match(res.steps[1].detail, /未包含/);
  assert.equal(c.calls.length, 2, '后续命令不应被下发');
});

test('宏：exec 的 expect_exit 断言生效', async () => {
  const c = fakeClient({ 'exec': () => ({ exit_code: 1 }) });
  const res = await runMacro({ client: c }, { steps: [{ action: 'exec', command: 'x', expect_exit: 0 }] });
  assert.equal(res.ok, false);
  assert.match(res.steps[0].detail, /退出码不符/);
});

test('宏：clip 断言与 assert(kind=clip) 复用剪贴板内容', async () => {
  const c = fakeClient({ 'clip.get': () => ({ text: '包含关键字的内容' }) });
  const res = await runMacro(
    { client: c },
    {
      steps: [
        { action: 'clip', expect: '关键字' },
        { action: 'assert', kind: 'clip', text: '不存在的词', optional: true },
      ],
    },
  );
  assert.equal(res.steps[0].ok, true);
  assert.equal(res.steps[1].ok, false, '不含该词应失败（但 optional 不中止）');
  assert.equal(res.ok, true);
});

test('宏：未知步骤类型被明确拒绝', async () => {
  const c = fakeClient({});
  const res = await runMacro({ client: c }, { steps: [{ action: 'teleport' }] });
  assert.equal(res.ok, false);
  assert.match(res.steps[0].detail, /不支持的步骤/);
});

test('宏：loadMacroFile 拒绝缺少 steps 的文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'na-macro-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ name: 'x' }));
  assert.throws(() => loadMacroFile(bad), /steps/);
  rmSync(dir, { recursive: true, force: true });
});

test('宏：find 步骤命中后按需点击（坐标来自引擎返回值）', async () => {
  const c = fakeClient({
    'screen.find': () => ({ engine: 'uia', matches: [{ name: '保存', x: 123, y: 456 }] }),
    'input.mouse.click': (args) => ({ clicked: true, x: args.x, y: args.y }),
  });
  const res = await runMacro(
    { client: c },
    { steps: [{ action: 'find', text: '保存', click: true }] },
  );
  assert.equal(res.ok, true);
  const click = c.calls.find((x) => x.capability === 'input.mouse.click');
  assert.deepEqual({ x: click.args.x, y: click.args.y }, { x: 123, y: 456 });
});
