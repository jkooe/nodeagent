import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseHotkey,
  normalizeKey,
  expandChords,
  expandPreset,
  HOTKEY_PRESETS,
  HOTKEY_KEYS,
  NUMPAD_KEYS,
} from '../../packages/protocol/dist/index.js';

const ROOT = join(import.meta.dirname, '..', '..');

// ---------- parseHotkey ----------

test('parseHotkey：基本分隔符与大小写', () => {
  assert.deepEqual(parseHotkey('ctrl+shift+esc'), ['ctrl', 'shift', 'esc']);
  assert.deepEqual(parseHotkey('Ctrl+Shift+Esc'), ['ctrl', 'shift', 'esc']);
  assert.deepEqual(parseHotkey('win - d'), ['win', 'd'], '分隔符支持 - 与空格');
  assert.deepEqual(parseHotkey('alt + tab'), ['alt', 'tab']);
  assert.deepEqual(parseHotkey('ctrl  c'), ['ctrl', 'c'], '空格也可作分隔符');
});

test('parseHotkey：别名归一', () => {
  assert.deepEqual(parseHotkey('command+space'), ['win', 'space']);
  assert.deepEqual(parseHotkey('control+a'), ['ctrl', 'a']);
  assert.deepEqual(parseHotkey('del'), ['delete']);
  assert.deepEqual(parseHotkey('pgup'), ['pageup']);
  assert.deepEqual(parseHotkey('numpad_enter+c'), ['enter', 'c']);
});

test('parseHotkey：符号键（快捷键覆盖的关键增量）', () => {
  assert.deepEqual(parseHotkey('win+d'), ['win', 'd']);
  assert.deepEqual(parseHotkey('win+oem_comma'), ['win', 'oem_comma']);
  assert.deepEqual(parseHotkey('ctrl+oem_plus'), ['ctrl', 'oem_plus']);
  assert.deepEqual(parseHotkey('ctrl+oem_minus'), ['ctrl', 'oem_minus']);
  assert.deepEqual(parseHotkey('ctrl+0'), ['ctrl', '0']);
});

test('parseHotkey：小键盘与左右修饰键', () => {
  assert.deepEqual(parseHotkey('numpad5'), ['numpad5']);
  assert.deepEqual(parseHotkey('lalt+tab'), ['lalt', 'tab']);
  assert.deepEqual(parseHotkey('rwin+d'), ['rwin', 'd']);
});

test('parseHotkey：非法输入必须报错（不静默吞掉）', () => {
  assert.throws(() => parseHotkey(''), /空热键|不支持/);
  assert.throws(() => parseHotkey('ctrl+nope'), /不支持的按键: nope/);
  assert.throws(() => parseHotkey('a+b+c+d+e'), /最多 4 个键/, '单和弦超限必须拒');
});

// ---------- expandChords ----------

test('expandChords：hotkey + repeat 连按', () => {
  const r = expandChords({ hotkey: 'up', repeat: 3 });
  assert.deepEqual(r.chords, [['up'], ['up'], ['up']]);
  assert.equal(r.via, 'hotkey');
});

test('expandChords：hotkeys 序列与 presets 序列', () => {
  assert.deepEqual(expandChords({ hotkeys: ['ctrl+c', 'ctrl+v'] }).chords, [['ctrl', 'c'], ['ctrl', 'v']]);
  const p = expandChords({ presets: ['copy', 'paste'] });
  assert.deepEqual(p.chords, [['ctrl', 'c'], ['ctrl', 'v']]);
  assert.deepEqual(p.presets, ['copy', 'paste']);
  assert.equal(p.via, 'presets');
});

test('expandChords：老形式 keys/sequence 仍然可用（向后兼容）', () => {
  assert.deepEqual(expandChords({ keys: ['ctrl', 'shift', 'esc'] }).chords, [['ctrl', 'shift', 'esc']]);
  assert.deepEqual(expandChords({ sequence: [['up'], ['enter']] }).chords, [['up'], ['enter']]);
  assert.equal(expandChords({ keys: ['ctrl'], repeat: 2 }).chords.length, 2);
});

test('expandChords：参数混用必须报错（消除"以谁为准"歧义）', () => {
  assert.throws(() => expandChords({ hotkey: 'ctrl+a', keys: ['ctrl', 'a'] }), /混用/);
  assert.throws(() => expandChords({}), /需提供/);
});

test('expandChords：同一和弦重复修饰键必须报错', () => {
  assert.throws(() => expandChords({ keys: ['ctrl', 'ctrl', 'a'] }), /重复的修饰键/);
});

// ---------- 预设表 ----------

test('HOTKEY_PRESETS：每个预设都可展开且合法', () => {
  for (const [name, spec] of Object.entries(HOTKEY_PRESETS)) {
    const chord = parseHotkey(spec);
    assert.ok(chord.length >= 1 && chord.length <= 4, `${name} → ${spec} 键数越界`);
    assert.deepEqual(expandPreset(name), chord, `${name} 展开不一致`);
  }
});

test('HOTKEY_PRESETS：媒体类预设映射到媒体键（可走 APPCOMMAND 通道）', () => {
  assert.deepEqual(expandPreset('music_play_pause'), ['media_play_pause']);
  assert.deepEqual(expandPreset('volume_mute_toggle'), ['volume_mute']);
  assert.deepEqual(expandPreset('volume_add'), ['volume_up']);
});

test('HOTKEY_PRESETS：符号键类预设可展开（证明 oem 链路可用）', () => {
  assert.deepEqual(expandPreset('show_desktop'), ['win', 'd']);
  assert.deepEqual(expandPreset('emoji_picker'), ['win', 'oem_period']);
  assert.deepEqual(expandPreset('zoom_in'), ['ctrl', 'oem_plus']);
});

test('expandPreset：未知预设必须报错', () => {
  assert.throws(() => expandPreset('nope'), /未知预设/);
});

// ---------- 覆盖断言：protocol 声明的键 agent 必须能映射 ----------

test('覆盖断言：HOTKEY_KEYS + NUMPAD_KEYS 全部存在于 agent 侧 VK_MAP', () => {
  const src = readFileSync(join(ROOT, 'apps/agent/src/capabilities/input-script.ts'), 'utf8');
  // 抓 VK_MAP 对象体的键名（到 "媒体键名 → APPCOMMAND" 注释前为止）
  const m = /const VK_MAP: Record<string, number> = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(m, '未找到 VK_MAP 定义');
  const declared = new Set(
    [...String(m[1]).matchAll(/(?:^|[\s,])([a-z_][a-z0-9_]*)\s*:/gm)].map((x) => String(x[1])),
  );
  const missing = [];
  for (const k of HOTKEY_KEYS) if (!declared.has(k)) missing.push(k);
  for (const k of NUMPAD_KEYS) if (!declared.has(k)) missing.push(`numpad:${k}`);
  assert.deepEqual(missing, [], `protocol 声明的按键在 agent 侧未映射: ${missing.join(', ')}`);
});

test('覆盖断言：每个预设只用已知键（防止表与实现漂移）', () => {
  const known = new Set([...HOTKEY_KEYS, ...NUMPAD_KEYS]);
  const bad = [];
  for (const [name, spec] of Object.entries(HOTKEY_PRESETS)) {
    for (const k of parseHotkey(spec)) {
      if (!known.has(k) && !/^[a-z0-9]$/.test(k)) bad.push(`${name}→${k}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('normalizeKey：单键归一化', () => {
  assert.equal(normalizeKey('CTRL'), 'ctrl');
  assert.equal(normalizeKey(' command '), 'win');
  assert.equal(normalizeKey('F12'), 'f12');
  assert.equal(normalizeKey('a'), 'a');
  assert.throws(() => normalizeKey(''), /空按键名/);
});
