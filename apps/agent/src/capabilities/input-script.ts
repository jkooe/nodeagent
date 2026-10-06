/**
 * 输入注入的 **PowerShell 脚本生成**（纯函数，无副作用 —— 便于单测）。
 *
 * 独立成模块的原因：脚本生成逻辑（顺序、逆序释放、hold 插入、PostMessage 路由）
 * 以往只能靠真机验证；而它恰好是最容易写错（一行顺序错 → 组合键失效）的部分。
 * 现在由单测逐行断言，真机只需验证"最终是否生效"。
 */

import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';

/** 键名 → 虚拟键码（字母/数字走 ASCII 映射，其余查表白名单）。 */
export const VK_MAP: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  capslock: 0x14, printscreen: 0x2c,
  // 系统/编辑键补充
  pause: 0x13, break: 0x13,
  apps: 0x5d, menu: 0x5d,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  f13: 0x7c, f14: 0x7d, f15: 0x7e, f16: 0x7f, f17: 0x80, f18: 0x81,
  f19: 0x82, f20: 0x83, f21: 0x84, f22: 0x85, f23: 0x86, f24: 0x87,

  // 媒体键（0xA6-0xB7 区段）—— 2026-10-05 补
  //
  // 为何必要：远程控媒体播放器（QQ 音乐 / 网易云 / 浏览器视频）时，
  // 若软件热键不可用（精简模式常不注册全局热键），系统媒体键是唯一
  // 与「窗口是否可见/被遮挡」无关的通道 —— 窗口最小化、被游戏全屏盖住时
  // 依然有效。实测：QQ 音乐精简窗被 DNF 全屏遮挡时，媒体键仍能控制。
  media_play: 0xb3, media_pause: 0xb3, media_play_pause: 0xb3, play_pause: 0xb3,
  media_stop: 0xb2, stop: 0xb2,
  media_prev: 0xb1, media_previous: 0xb1, prev_track: 0xb1, prev: 0xb1,
  media_next: 0xb0, next_track: 0xb0, next: 0xb0,
  media_fast_forward: 0xb4, fast_forward: 0xb4,
  media_rewind: 0xb7, rewind: 0xb7,
  media_eject: 0xb2,
  volume_mute: 0xad, mute: 0xad,
  volume_down: 0xae,
  volume_up: 0xaf,

  browser_back: 0xa6, browser_forward: 0xa7, browser_refresh: 0xa8, browser_stop: 0xa9, browser_search: 0xaa,
  launch_mail: 0xb4, launch_media: 0xb5, launch_app1: 0xb6, launch_app2: 0xb7,
  browser_favorites: 0xab, browser_home: 0xac,

  // ---- 左右侧修饰键（v1.5）----
  // 游戏/部分应用区分左右（如游戏中把 LAlt 设为跑步、RAlt 设为瞄准），故不能只给一个 alt。
  lctrl: 0xa2, rctrl: 0xa3, lshift: 0xa0, rshift: 0xa1,
  lalt: 0xa4, ralt: 0xa5, lwin: 0x5b, rwin: 0x5c,
  super: 0x5b, cmd: 0x5b, left_cmd: 0x5b, right_cmd: 0x5c,

  // ---- 小键盘（v1.5）----
  // numpadN 与数字 N 分开：Excel 等程序靠 NumLock 状态区分二者行为，合成一个会坏掉快捷键。
  numpad0: 0x60, numpad1: 0x61, numpad2: 0x62, numpad3: 0x63, numpad4: 0x64,
  numpad5: 0x65, numpad6: 0x66, numpad7: 0x67, numpad8: 0x68, numpad9: 0x69,
  numpad_multiply: 0x6a, numpad_add: 0x6b, numpad_subtract: 0x6d, numpad_decimal: 0x6e, numpad_divide: 0x6f,
  numlock: 0x90, scrolllock: 0x91,
  numpad_enter: 0x0d,

  // ---- OEM 符号键（v1.5，美式布局 VK 码）----
  // 必备理由：大量系统/应用快捷键就是"修饰键 + 符号键"（win+d 显示桌面、win+, 速览、
  // ctrl++ 放大、ctrl+- 缩小、win+. 表情面板），此前只能靠字母数字，覆盖不到。
  oem_1: 0xba,   // : ;
  oem_2: 0xbf,   // / ?
  oem_3: 0xc0,   // ` ~
  oem_4: 0xdb,   // [ {
  oem_5: 0xdc,   // \ |
  oem_6: 0xdd,   // ] }
  oem_7: 0xde,   // ' "
  oem_8: 0xdf,
  oem_minus: 0xbd, // - _
  oem_plus: 0xbb,  // + =
  oem_comma: 0xbc, // , <
  oem_period: 0xbe,// . >

  // ---- 系统/IME 杂项（v1.5）----
  sleep: 0x5f, help: 0x2f, select: 0x29, execute: 0x2b, clear: 0x0c,
  separator: 0x6c, oem_clear: 0xfe,
  kana: 0x15, hangul: 0x15, kanji: 0x19, hanja: 0x19,
  convert: 0x1c, nonconvert: 0x1d, accept: 0x1e, modechange: 0x1f,
};

/** 键名 → 虚拟键码。 */
export function toVk(key: string): number {
  const k = key.trim().toLowerCase();
  if (VK_MAP[k] !== undefined) return VK_MAP[k]!;
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  throw new CapabilityError(ErrorCodes.PARAM_INVALID, `不支持的按键: ${key}`, {
    supported: [...Object.keys(VK_MAP), 'a-z', '0-9'],
  });
}

/**
 * 媒体键名 → APPCOMMAND 取值。
 *
 * 取值见 Windows `APPCOMMAND_*` 常量。整条序列都是媒体键时改走 WM_APPCOMMAND
 * 投递（而非 SendInput 注入 VK）—— 前者能定向到指定进程且不受窗口遮挡影响。
 *
 * ⚠️ 音量键（volume_mute / volume_up / volume_down）**不在此表**：
 * WM_APPCOMMAND 的 lParam 低 16 位按 device 段解释，VOLUME_DOWN 与 PAUSE 的裸值相同（都是 1），
 * 放进表里会与 PAUSE 撞车。音量键走 VK 注入（0xAD-0xAF）更可靠 —— 系统会自行映射为
 * APPCOMMAND_VOLUME_*，故此处刻意不收录音量键，避免 device-bit 歧义。
 */
export const MEDIA_COMMANDS: Record<string, number> = {
  media_play: 14, play: 14,
  media_pause: 1, pause: 1,
  media_play_pause: 12, play_pause: 12,
  media_stop: 15, stop: 15,
  media_prev: 6, media_previous: 6, prev_track: 6, prev: 6,
  media_next: 7, next_track: 7, next: 7,
  media_fast_forward: 3, fast_forward: 3,
  media_rewind: 4, rewind: 4,
  media_close: 10, close: 10,
};

export interface PressBodyOptions {
  /** 序列中相邻和弦之间的间隔毫秒 */
  gapMs: number;
  /** 按下后保持毫秒数（长按） */
  holdMs: number;
  /** route=post 时的目标进程 PID */
  targetPid: number;
  /** 投放路由 */
  route: 'foreground' | 'post';
}

/** 判断整条序列是否都是媒体键。 */
export function isAllMedia(chords: string[][]): boolean {
  return (
    chords.length > 0 &&
    chords.every((ch) => ch.length === 1 && MEDIA_COMMANDS[ch[0]!.trim().toLowerCase()] !== undefined)
  );
}

/**
 * 生成媒体键（WM_APPCOMMAND）投放脚本。
 * targetPid=0 → HWND_BROADCAST 广播；否则定向该进程全部顶层窗口。
 */
export function buildMediaBody(chords: string[][], opts: PressBodyOptions): string[] {
  const body: string[] = [];
  const pid = Math.max(0, Math.trunc(opts.targetPid));
  for (let i = 0; i < chords.length; i += 1) {
    const cmd = MEDIA_COMMANDS[chords[i]![0]!.trim().toLowerCase()]!;
    body.push(`[NAInput]::MediaCommand(${cmd}, ${pid})`);
    if (i < chords.length - 1 && opts.gapMs > 0) {
      body.push(`Start-Sleep -Milliseconds ${opts.gapMs}`);
    }
  }
  return body;
}

/**
 * 生成前台注入（SendInput Vk）脚本。
 *
 * 顺序至关重要：按下按给定顺序、**释放逆序** —— 否则 Windows 组合键状态机会淆
 * （例如 ctrl+c 若先释放 ctrl，绝大多数程序收不到"带 ctrl 的 c"）。
 */
export function buildForegroundBody(chords: string[][], opts: PressBodyOptions): string[] {
  const body: string[] = [];
  for (let i = 0; i < chords.length; i += 1) {
    const chord = chords[i]!;
    if (chord.length === 0) continue;
    const vks = chord.map(toVk);
    for (const vk of vks) body.push(`[NAInput]::Vk(${vk}, $false)`);
    if (opts.holdMs > 0) body.push(`Start-Sleep -Milliseconds ${opts.holdMs}`);
    // 逆序释放，保证组合键正确
    for (const vk of [...vks].reverse()) body.push(`[NAInput]::Vk(${vk}, $true)`);
    if (i < chords.length - 1 && opts.gapMs > 0) {
      body.push(`Start-Sleep -Milliseconds ${opts.gapMs}`);
    }
  }
  return body;
}

/**
 * 生成后台定向投递（PostMessage）脚本。
 *
 * 与前台注入同样遵守"按下顺序 / 释放逆序"；每和弦投递给目标进程全部顶层窗口。
 * C# 侧 PostChord(vks, targetPid, up)：up=false → WM_KEYDOWN，up=true → WM_KEYUP。
 */
export function buildPostBody(chords: string[][], opts: PressBodyOptions): string[] {
  const body: string[] = [];
  const pid = Math.max(1, Math.trunc(opts.targetPid));
  for (let i = 0; i < chords.length; i += 1) {
    const vks = chords[i]!.map(toVk);
    if (vks.length === 0) continue;
    body.push(`[NAInput]::PostChord(@(${vks.join(', ')}), ${pid}, $false)`);
    if (opts.holdMs > 0) body.push(`Start-Sleep -Milliseconds ${opts.holdMs}`);
    // 逆序释放
    const rel = [...vks].reverse().join(', ');
    body.push(`[NAInput]::PostChord(@(${rel}), ${pid}, $true)`);
    if (i < chords.length - 1 && opts.gapMs > 0) {
      body.push(`Start-Sleep -Milliseconds ${opts.gapMs}`);
    }
  }
  return body;
}
