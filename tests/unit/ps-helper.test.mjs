import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBootstrap,
  parseHelperLine,
  toEncodedCommand,
} from '../../apps/agent/dist/util/ps-helper.js';

test('编码：UTF-16LE base64 可逆（规避引号/换行/中文转义）', () => {
  const script = '$x = "中文 \'引号\'"\nWrite-Output $x';
  const b64 = toEncodedCommand(script);
  assert.equal(b64, Buffer.from(script, 'utf16le').toString('base64'));
  assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), script);
});

test('bootstrap：包含 prelude、READY 标记、请求循环与退出信号', () => {
  const prelude = 'Add-Type -AssemblyName UIAutomationClient\nfunction Foo { 1 }';
  const boot = buildBootstrap(prelude);
  assert.ok(boot.includes(prelude), '必须内联 prelude（类型只加载一次）');
  assert.ok(boot.includes("'@@READY'"), '必须发出就绪信号（通过 stderr，不污染协议 stdout）');
  assert.ok(boot.includes('@@EXIT'), '必须支持退出信号');
  assert.ok(boot.includes('[Console]::In.ReadLine()'), '必须逐行读取请求');
  assert.ok(boot.includes('FromBase64String'), '请求应为 base64 解码');
  assert.ok(boot.includes("'@@R '"), '成功响应前缀');
  assert.ok(boot.includes("'@@E '"), '异常响应前缀');
  // 关键：异常必须被 catch 住，否则一次脚本报错就会带走整个常驻进程
  assert.ok(/catch\s*\{/.test(boot), '必须有 try/catch 兜住单次脚本异常');
});

test('协议行：正确解析成功/异常，噪声行为 null', () => {
  const ok = parseHelperLine(`@@R ${Buffer.from('{"a":1}', 'utf8').toString('base64')}`);
  assert.deepEqual(ok, { isErr: false, payload: '{"a":1}' });

  const bad = parseHelperLine(`@@E ${Buffer.from('未找到窗口', 'utf8').toString('base64')}`);
  assert.deepEqual(bad, { isErr: true, payload: '未找到窗口' });

  // Add-Type / 程序集加载会往 stdout 夹杂质，必须被忽略而不是误当响应
  assert.equal(parseHelperLine('Add-Type: 已加载程序集'), null);
  assert.equal(parseHelperLine(''), null);
  assert.equal(parseHelperLine('@@X abc'), null);
});

test('协议行：中文与多行输出往返无损', () => {
  const text = '窗口「记事本」\n第二行\t制表';
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const parsed = parseHelperLine(`@@R ${b64}`);
  assert.equal(parsed.payload, text);
});
