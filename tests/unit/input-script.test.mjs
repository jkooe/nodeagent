import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VK_MAP,
  MEDIA_COMMANDS,
  toVk,
  isAllMedia,
  buildMediaBody,
  buildForegroundBody,
  buildPostBody,
} from '../../apps/agent/dist/capabilities/input-script.js';

const OPTS = { gapMs: 40, holdMs: 0, targetPid: 0, route: 'foreground' };

// ---------- toVk / 按键映射 ----------

test('toVk：修饰键与扩展按键', () => {
  assert.equal(toVk('ctrl'), 0x11);
  assert.equal(toVk(' lalt '), 0xa4);
  assert.equal(toVk('rctrl'), 0xa3);
  assert.equal(toVk('rwin'), 0x5c);
  assert.equal(toVk('d'), 0x44, '字母走 ASCII 大写映射');
  assert.equal(toVk('7'), 0x37);
  assert.equal(toVk('numpad7'), 0x67, 'numpad7 与 7 必须不同 VK');
  assert.notEqual(toVk('numpad7'), toVk('7'));
  assert.equal(toVk('numpad_add'), 0x6b);
  assert.equal(toVk('oem_plus'), 0xbb);
  assert.equal(toVk('oem_comma'), 0xbc);
  assert.equal(toVk('oem_period'), 0xbe);
  assert.equal(toVk('f13'), 0x7c);
  assert.equal(toVk('convert'), 0x1c);
  assert.equal(toVk('sleep'), 0x5f);
});

test('toVk：未知键必须抛错', () => {
  assert.throws(() => toVk('nope'), /不支持的按键/);
});

// ---------- 前台注入脚本 ----------

test('buildForegroundBody：按下顺序 + 释放必须逆序（组合键生死线）', () => {
  const body = buildForegroundBody([['ctrl', 'c']], OPTS);
  assert.deepEqual(body, ['[NAInput]::Vk(17, $false)', '[NAInput]::Vk(67, $false)', '[NAInput]::Vk(67, $true)', '[NAInput]::Vk(17, $true)']);
  // 断言语义：第一个 down 是修饰键，第一个 up 是主键（即释放逆序）
  assert.ok(body[0].includes('Vk(17'), '按顺序按下：ctrl 先');
  assert.ok(body[2].includes('Vk(67'),'逆序释放：主键先起');
});

test('buildForegroundBody：hold_ms 插在"按完"与"释放"之间', () => {
  const body = buildForegroundBody([['ctrl', 'a']], { ...OPTS, holdMs: 500 });
  assert.ok(body.includes('Start-Sleep -Milliseconds 500'));
  const sleepAt = body.indexOf('Start-Sleep -Milliseconds 500');
  assert.ok(body[sleepAt - 1].includes('$false'), '长按前必须是按下动作');
  assert.ok(body[sleepAt + 1].includes('$true'), '长按后必须是释放动作');
});

test('buildForegroundBody：多和弦之间插 interval', () => {
  const body = buildForegroundBody([['ctrl', 'c'], ['ctrl', 'v']], { ...OPTS, gapMs: 100 });
  assert.ok(body.includes('Start-Sleep -Milliseconds 100'));
  // 间隔只出现在两个和弦之间（不应出现在和弦内部，hold=0 时）
  assert.equal(body.filter((l) => l.includes('-Milliseconds 100')).length, 1);
});

test('buildForegroundBody：hold=0 时不产生多余 sleep', () => {
  const body = buildForegroundBody([['ctrl', 'c']], { ...OPTS, holdMs: 0 });
  assert.equal(body.filter((l) => l.includes('Start-Sleep')).length, 0);
});

// ---------- 媒体键脚本 ----------

test('buildMediaBody：使用 APPCOMMAND 常量而非 VK', () => {
  const body = buildMediaBody([['media_next'], ['media_play_pause']], { ...OPTS, gapMs: 0 });
  assert.deepEqual(body, ['[NAInput]::MediaCommand(7, 0)', '[NAInput]::MediaCommand(12, 0)']);
});

test('buildMediaBody：target_pid 透传（定向该进程全窗口）', () => {
  const body = buildMediaBody([['media_next']], { ...OPTS, targetPid: 4242 });
  assert.deepEqual(body, ['[NAInput]::MediaCommand(7, 4242)']);
});

test('isAllMedia：混入普通键则整条不走 APPCOMMAND', () => {
  assert.ok(isAllMedia([['media_next'], ['media_stop']]));
  assert.ok(!isAllMedia([['media_next'], ['enter']]), '混入 enter 必须回退 VK 注入');
  assert.ok(!isAllMedia([['ctrl', 'c']]));
  assert.ok(!isAllMedia([]), '空序列不算全媒体（避免空走媒体通道）');
});

test('音量键不在 MEDIA_COMMANDS 表（避免 APPCOMMAND device 位歧义）', () => {
  assert.ok(!('volume_mute' in MEDIA_COMMANDS));
  assert.ok(!('volume_up' in MEDIA_COMMANDS));
  assert.ok(!('volume_down' in MEDIA_COMMANDS));
});

// ---------- 后台 PostMessage 脚本 ----------

test('buildPostBody：按下顺序 + 释放逆序，且带 PID', () => {
  const body = buildPostBody([['ctrl', 'c']], { gapMs: 0, holdMs: 0, targetPid: 777, route: 'post' });
  assert.deepEqual(body, [
    '[NAInput]::PostChord(@(17, 67), 777, $false)',
    '[NAInput]::PostChord(@(67, 17), 777, $true)',
  ]);
});

test('buildPostBody：hold 与 interval 与前台语义一致', () => {
  const body = buildPostBody([['alt', 'tab'], ['esc']], { gapMs: 50, holdMs: 300, targetPid: 9, route: 'post' });
  assert.deepEqual(body, [
    '[NAInput]::PostChord(@(18, 9), 9, $false)',
    'Start-Sleep -Milliseconds 300',
    '[NAInput]::PostChord(@(9, 18), 9, $true)',
    'Start-Sleep -Milliseconds 50',
    '[NAInput]::PostChord(@(27), 9, $false)',
    'Start-Sleep -Milliseconds 300',
    '[NAInput]::PostChord(@(27), 9, $true)',
  ]);
});

// ---------- 回归：real-world 快捷键展开后的脚本 ----------

test('端到端脚本样例：win+d 显示桌面（OEM 符号键链路）', () => {
  const body = buildForegroundBody([['win', 'd']], OPTS);
  assert.deepEqual(body, ['[NAInput]::Vk(91, $false)', '[NAInput]::Vk(68, $false)', '[NAInput]::Vk(68, $true)', '[NAInput]::Vk(91, $true)']);
});

test('VK_MAP 与 MEDIA_COMMANDS 存在且非空（防误清空）', () => {
  assert.ok(Object.keys(VK_MAP).length > 60, '按键表应已覆盖扩展键');
  assert.ok(Object.keys(MEDIA_COMMANDS).length >= 10);
});
