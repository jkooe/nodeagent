/**
 * 快捷键（hotkey）解析与预设（v1.5.0）。
 *
 * ## 为什么放在 protocol 包
 * 解析逻辑必须**两端一致 + 可单测**：控制端 CLI 先把字符串展开成和弦列表用于本地校验，
 * 被控端再展开一次用于执行。纯函数 + 无副作用，测试直接 import dist 即可。
 *
 * ## 支持的形式
 * 1. `hotkey: "ctrl+shift+esc"`      单个和弦（字符串）
 * 2. `hotkeys: ["ctrl+c","ctrl+v"]`  序列
 * 3. `preset: "copy"` / `presets: [...]` 别名 → 展开成热键字符串后按上两条走
 * 4. `keys: ["ctrl","c"]`            老形式（数组），保留兼容
 *
 * 分隔符支持 `+ - 空格`；大小写不敏感；`control/command/cmd` 等别名归一。
 */

/** 规范按键名（agent 侧 VK_MAP 必须全覆盖，单测有断言）。 */
export const HOTKEY_KEYS: ReadonlySet<string> = new Set([
  // 修饰键（含左右区分）
  'ctrl', 'lctrl', 'rctrl', 'shift', 'lshift', 'rshift',
  'alt', 'lalt', 'ralt', 'win', 'lwin', 'rwin',
  // 导航/编辑
  'enter', 'tab', 'esc', 'space', 'backspace', 'delete', 'insert',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'capslock', 'numlock', 'scrolllock', 'printscreen', 'pause', 'apps',
  // 功能键
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
  // 媒体键（音量键只走 VK 注入，见 agent 侧 MEDIA_COMMANDS 注释）
  'media_play', 'media_pause', 'media_play_pause', 'media_stop',
  'media_prev', 'media_next', 'media_fast_forward', 'media_rewind',
  'volume_mute', 'volume_down', 'volume_up',
  // 浏览器/系统启动
  'browser_back', 'browser_forward', 'browser_refresh', 'browser_stop',
  'browser_search', 'browser_favorites', 'browser_home',
  'launch_mail', 'launch_media', 'launch_app1', 'launch_app2',
  // OEM 符号键（美式布局 VK 码，覆盖 +1-9 之外最常用的符号）
  'oem_minus', 'oem_plus', 'oem_comma', 'oem_period',
  'oem_1', 'oem_2', 'oem_3', 'oem_4', 'oem_5', 'oem_6', 'oem_7', 'oem_8',
  // 系统/IME 杂项
  'sleep', 'help', 'select', 'execute', 'clear', 'separator', 'oem_clear',
  'kana', 'hangul', 'kanji', 'hanja', 'convert', 'nonconvert', 'accept', 'modechange',
]);

/** 键名别名 → 规范名。 */
export const HOTKEY_ALIASES: Readonly<Record<string, string>> = {
  control: 'ctrl', 'left_ctrl': 'lctrl', 'right_ctrl': 'rctrl',
  left_shift: 'lshift', right_shift: 'rshift',
  left_alt: 'alt', right_alt: 'ralt', menu: 'apps', context_menu: 'apps',
  cmd: 'win', 'command': 'win', super: 'win', meta: 'win',
  left_win: 'lwin', right_win: 'rwin', left_cmd: 'lwin', right_cmd: 'rwin',
  esc: 'esc', escape: 'esc', del: 'delete', ins: 'insert',
  ret: 'enter', return: 'enter', spacebar: 'space',
  pgup: 'pageup', pgdn: 'pagedown',
  caps: 'capslock', num: 'numlock', scroll: 'scrolllock',
  prtsc: 'printscreen', print: 'printscreen',
  break: 'pause',
  mute: 'volume_mute', volume: 'volume_mute',
  vol_up: 'volume_up', vol_up_key: 'volume_up',
  vol_down: 'volume_down',
  prev: 'media_prev', 'prev_track': 'media_prev', previous: 'media_prev',
  next: 'media_next', next_track: 'media_next',
  play: 'media_play', pause: 'media_pause',
  play_pause: 'media_play_pause', ff: 'media_fast_forward', rew: 'media_rewind',
  semi: 'oem_1', colon: 'oem_1', slash: 'oem_2', qmark: 'oem_2',
  backquote: 'oem_3', tilde: 'oem_3', grave: 'oem_3',
  lbrace: 'oem_4', lbracket: 'oem_4', bslash: 'oem_5', pipe: 'oem_5',
  rbrace: 'oem_6', rbracket: 'oem_6', quote: 'oem_7', apos: 'oem_7',
  minus: 'oem_minus', underscore: 'oem_minus',
  plus: 'oem_plus', equal: 'oem_plus', equals: 'oem_plus',
  comma: 'oem_comma', lt: 'oem_comma',
  period: 'oem_period', dot: 'oem_period', gt: 'oem_period',
  // 小键盘
  numpad_enter: 'enter', numpad_0: 'numpad0',
};

/**
 * 小键盘键名 → canonical 名（单独成组，便于校验覆盖）。
 * 注意：numpad enter 归一到 enter（多数程序不区分），其余 numpadN 与数字 N 分开
 * —— 部分应用（如 Excel）靠 NumLock 状态区分二者行为。
 */
export const NUMPAD_KEYS: readonly string[] = [
  'numpad0', 'numpad1', 'numpad2', 'numpad3', 'numpad4',
  'numpad5', 'numpad6', 'numpad7', 'numpad8', 'numpad9',
  'numpad_add', 'numpad_subtract', 'numpad_multiply', 'numpad_divide', 'numpad_decimal',
];

/** 常用快捷键预设：语义名 → 热键字符串。AI/MCP 直接用语义名，免记键位。 */
export const HOTKEY_PRESETS: Readonly<Record<string, string>> = {
  // 编辑
  copy: 'ctrl+c', paste: 'ctrl+v', paste_plain: 'ctrl+shift+v',
  cut: 'ctrl+x', undo: 'ctrl+z', redo: 'ctrl+y', select_all: 'ctrl+a',
  // 文件/窗口
  save: 'ctrl+s', save_as: 'ctrl+shift+s', new: 'ctrl+n', open: 'ctrl+o',
  close_tab: 'ctrl+w', close_window: 'alt+f4', print: 'ctrl+p',
  find: 'ctrl+f', replace: 'ctrl+h', find_next: 'f3',
  // 标签页
  new_tab: 'ctrl+t', next_tab: 'ctrl+tab', prev_tab: 'ctrl+shift+tab',
  reopen_tab: 'ctrl+shift+t',
  // 刷新/缩放/视图
  refresh: 'f5', hard_refresh: 'ctrl+f5',
  zoom_in: 'ctrl+oem_plus', zoom_out: 'ctrl+oem_minus', zoom_reset: 'ctrl+0',
  fullscreen: 'f11',
  // 窗口管理
  switch_app: 'alt+tab', switch_app_back: 'alt+shift+tab',
  task_view: 'win+tab', task_manager: 'ctrl+shift+esc',
  show_desktop: 'win+d', peek_desktop: 'win+oem_comma',
  minimize_all: 'win+m', maximize: 'win+up', minimize: 'win+down',
  snap_left: 'win+left', snap_right: 'win+right',
  rename: 'f2', properties: 'alt+enter', delete_permanent: 'shift+delete',
  // 系统
  lock_screen: 'win+l', run: 'win+r', run_dialog: 'win+r',
  explorer: 'win+e', search: 'win+s', settings: 'win+i',
  clipboard_history: 'win+v', emoji_picker: 'win+oem_period',
  notifications: 'win+a', widgets: 'win+w', dictation: 'win+h',
  screenshot: 'win+shift+s',
  // 虚拟桌面
  new_desktop: 'ctrl+win+d', close_desktop: 'ctrl+win+f4',
  desktop_left: 'ctrl+win+left', desktop_right: 'ctrl+win+right',
  // 媒体（映射到媒体键）
  music_play_pause: 'media_play_pause', music_next: 'media_next',
  music_prev: 'media_prev', music_stop: 'media_stop',
  volume_add: 'volume_up', volume_sub: 'volume_down', volume_mute_toggle: 'volume_mute',
};

const ALIAS_INVERSE: ReadonlyMap<string, string> = new Map(
  Object.entries(HOTKEY_ALIASES).map(([alias, canon]) => [alias, canon]),
);

/** 归一化单个键名（别名 → 规范名），大小写不敏感；非法键抛错。 */
export function normalizeKey(key: string): string {
  const k = key.trim().toLowerCase();
  if (!k) throw new Error(`空按键名`);
  const canon = ALIAS_INVERSE.get(k) ?? k;
  if (/^[a-z]$/.test(canon) || /^[0-9]$/.test(canon)) return canon;
  if (NUMPAD_KEYS.includes(canon)) return canon;
  if (HOTKEY_KEYS.has(canon)) return canon;
  throw new Error(`不支持的按键: ${key}`);
}

/**
 * 解析一条热键字符串为和弦数组（按键已归一化）。
 * 例：`"ctrl+shift+esc"` → `["ctrl","shift","esc"]`；`"win+d"` → `["win","d"]`。
 */
export function parseHotkey(input: string): string[] {
  const parts = input
    .trim()
    .split(/[+\-\s]+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error('空热键字符串');
  if (parts.length > 4) {
    throw new Error('单个和弦最多 4 个键（Windows 输入模型的实用上限）');
  }
  return parts.map(normalizeKey);
}

/** 展开一个预设名为和弦。 */
export function expandPreset(name: string): string[] {
  const spec = HOTKEY_PRESETS[name.trim().toLowerCase()];
  if (!spec) {
    throw new Error(
      `未知预设: ${name}（共 ${Object.keys(HOTKEY_PRESETS).length} 个可用，见 HOTKEY_PRESETS）`,
    );
  }
  return parseHotkey(spec);
}

export interface KeyPressInput {
  /** 单条热键字符串（如 "ctrl+shift+esc"），可与 repeat 配合 */
  hotkey?: string;
  /** 多条热键字符串 = 序列 */
  hotkeys?: string[];
  /** 预设名（单个） */
  preset?: string;
  /** 预设名（多个 = 序列） */
  presets?: string[];
  /** 老形式：和弦数组 */
  keys?: string[];
  /** 老形式：序列 */
  sequence?: string[][];
  repeat?: number;
}

export interface ExpandedChords {
  /** 归一化后的和弦序列 */
  chords: string[][];
  /** 命中的预设名（用于回显），非预设来源为空数组 */
  presets: string[];
  /** 来源形式，便于回显与排查 */
  via: 'hotkeys' | 'hotkey' | 'presets' | 'preset' | 'keys' | 'sequence';
}

/**
 * 把各种输入形式统一展开为**归一化和弦序列**。
 *
 * 优先级（只取其一，混用即报错——避免"到底以谁为准"的歧义）：
 * hotkeys > hotkey > presets > preset > sequence > keys
 */
export function expandChords(input: KeyPressInput): ExpandedChords {
  const provided: string[] = [];
  if (input.hotkeys && input.hotkeys.length > 0) provided.push('hotkeys');
  if (input.hotkey !== undefined) provided.push('hotkey');
  if (input.presets && input.presets.length > 0) provided.push('presets');
  if (input.preset !== undefined) provided.push('preset');
  if (input.sequence && input.sequence.length > 0) provided.push('sequence');
  if (input.keys && input.keys.length > 0) provided.push('keys');
  if (provided.length === 0) {
    throw new Error('需提供 hotkey / hotkeys / preset / presets / keys / sequence 之一');
  }
  if (provided.length > 1) {
    throw new Error(`参数混用：${provided.join(' + ')} —— 一次请只用一种形式`);
  }

  const presets: string[] = [];
  let chords: string[][];

  if (provided[0] === 'hotkeys') {
    chords = (input.hotkeys ?? []).map(parseHotkey);
  } else if (provided[0] === 'hotkey') {
    const chord = parseHotkey(input.hotkey as string);
    const repeat = Math.max(1, Math.min(50, input.repeat ?? 1));
    chords = Array.from({ length: repeat }, () => chord);
  } else if (provided[0] === 'presets') {
    chords = [];
    for (const p of input.presets ?? []) {
      presets.push(p.trim().toLowerCase());
      chords.push(expandPreset(p));
    }
  } else if (provided[0] === 'preset') {
    presets.push((input.preset as string).trim().toLowerCase());
    chords = [expandPreset(input.preset as string)];
  } else if (provided[0] === 'sequence') {
    chords = (input.sequence ?? []).map((ch) => ch.map(normalizeKey));
  } else {
    const chord = (input.keys ?? []).map(normalizeKey);
    const repeat = Math.max(1, Math.min(50, input.repeat ?? 1));
    chords = Array.from({ length: repeat }, () => chord);
  }

  // 合法性：每条非空、≤4 键、修饰键不重复（同一和弦里两个 ctrl 无意义且可能互相抵消）
  const seenModifier = new Set<string>();
  for (const chord of chords) {
    if (chord.length === 0) throw new Error('空和弦');
    if (chord.length > 4) throw new Error(`单和弦最多 4 键：${chord.join('+')}`);
    seenModifier.clear();
    for (const k of chord) {
      if (!isModifier(k)) continue;
      if (seenModifier.has(k)) throw new Error(`同一和弦中重复的修饰键: ${k}`);
      seenModifier.add(k);
    }
  }
  return { chords, presets, via: provided[0] as ExpandedChords['via'] };
}

function isModifier(k: string): boolean {
  return (
    k === 'ctrl' || k === 'lctrl' || k === 'rctrl' ||
    k === 'shift' || k === 'lshift' || k === 'rshift' ||
    k === 'alt' || k === 'lalt' || k === 'ralt' ||
    k === 'win' || k === 'lwin' || k === 'rwin'
  );
}
