import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';

type Args = Record<string, unknown>;

// ---------------- 安全开关（由注册表工厂注入） ----------------

export interface InputPolicy {
  /** 被控端是否允许输入控制；默认 false —— 高危能力必须显式开启 */
  allowInput: boolean;
}

let policy: InputPolicy = { allowInput: false };

export function setInputPolicy(p: InputPolicy): void {
  policy = p;
}

function assertAllowed(capability: string): void {
  if (!policy.allowInput) {
    throw new CapabilityError(
      ErrorCodes.CAPABILITY_DISABLED,
      `${capability} 已禁用：被控端未开启输入控制`,
      { hint: '在被控端 agent.json 中设置 "allow_input": true 后重启 Agent' },
    );
  }
}

function requireWindows(capability: string): void {
  if (!IS_WINDOWS) {
    throw new CapabilityError(ErrorCodes.UNSUPPORTED_PLATFORM, `${capability} 仅在 Windows 被控端可用`, {
      platform: process.platform,
    });
  }
}

// ---------------- PowerShell 侧的原生输入注入（SendInput） ----------------

/** C# P/Invoke 定义（经 here-string 注入，避免与 PowerShell 插值冲突）。 */
const CS_CODE = `using System;
using System.Runtime.InteropServices;

public static class NAInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int X, int Y);

    private static readonly int SIZE = Marshal.SizeOf(typeof(INPUT));

    public static void MoveTo(int x, int y) { SetCursorPos(x, y); }

    public static void Click(uint down, uint up) {
        var a = new INPUT[2];
        a[0].type = 0; a[0].U.mi.dwFlags = down;
        a[1].type = 0; a[1].U.mi.dwFlags = up;
        SendInput(2, a, SIZE);
    }

    public static void Wheel(int delta) {
        var a = new INPUT[1];
        a[0].type = 0; a[0].U.mi.mouseData = (uint)delta; a[0].U.mi.dwFlags = 0x0800;
        SendInput(1, a, SIZE);
    }

    /// <summary>
    /// 注入单个 Unicode 码元（KEYEVENTF_UNICODE）。
    ///
    /// 修正 2026-10-04：原实现用 char 逐字符注入，**BMP 外字符（代理对，如 emoji、
    /// 部分生僻字）被拆成两个孤立代理项**，目标应用收到的是非法序列 → 渲染为
    /// U+FFFD 或乱码。现改为按 UTF-16 码元成对注入。
    ///
    /// 注意：KEYEVENTF_UNICODE 的扫描码位只有 16 位，故代理对（两个 16 位码元）
    /// 必须**各自单独**发送，无法合并 —— 这是 Windows 输入 API 的固有限制。
    /// </summary>
    public static void UnicodeChar(char c) {
        var a = new INPUT[2];
        a[0].type = 1; a[0].U.ki.wScan = c; a[0].U.ki.dwFlags = 0x0004; // KEYEVENTF_UNICODE
        a[1].type = 1; a[1].U.ki.wScan = c; a[1].U.ki.dwFlags = 0x0006; // + KEYUP
        SendInput(2, a, SIZE);
    }

    /// <summary>注入完整字符串（按 UTF-16 码元，代理对自动成对处理）。</summary>
    public static void UnicodeString(string s, int intervalMs) {
        // 直接遍历 UTF-16 码元：代理对的两个码元会连续注入，效果等同输入该字符
        for (int i = 0; i < s.Length; i++) {
            UnicodeChar(s[i]);
            if (intervalMs > 0) System.Threading.Thread.Sleep(intervalMs);
        }
    }

    public static void Vk(ushort vk, bool up) {
        var a = new INPUT[1];
        a[0].type = 1; a[0].U.ki.wVk = vk; a[0].U.ki.dwFlags = up ? 2u : 0u;
        SendInput(1, a, SIZE);
    }

    /** v11：拖拽（按下 → 分步移动 → 抬起），全部在一次调用内完成，避免多次进程开销。 */
    public static void Drag(uint downFlag, uint upFlag, int x1, int y1, int x2, int y2, int steps, int stepDelayMs) {
        SetCursorPos(x1, y1);
        System.Threading.Thread.Sleep(60);
        var d = new INPUT[1]; d[0].type = 0; d[0].U.mi.dwFlags = downFlag;
        SendInput(1, d, SIZE);
        System.Threading.Thread.Sleep(60);
        if (steps < 1) steps = 1;
        for (int i = 1; i <= steps; i++) {
            int xi = x1 + (x2 - x1) * i / steps;
            int yi = y1 + (y2 - y1) * i / steps;
            SetCursorPos(xi, yi);
            if (stepDelayMs > 0) System.Threading.Thread.Sleep(stepDelayMs);
        }
        var u = new INPUT[1]; u[0].type = 0; u[0].U.mi.dwFlags = upFlag;
        SendInput(1, u, SIZE);
    }

    /// <summary>
    /// 媒体控制（2026-10-05 补）：经 WM_APPCOMMAND 广播到目标窗口。
    ///
    /// 为何不只靠 VK 注入：媒体键用 SendInput 打进去后，**并非所有播放器都接收**
    /// —— 只有当前获得媒体会话焦点的窗口才会响应。而 WM_APPCOMMAND 可直接
    /// 投递给指定 hwnd，绕开「谁是当前媒体会话焦点」这层不确定性。
    ///
    /// 用途：远程控制 QQ 音乐 / 网易云 / 浏览器视频，且**窗口最小化或被全屏游戏
    /// 遮挡时依然有效**（实测 QQ 音乐精简窗被 DNF 全屏压住时该通道可用）。
    /// </summary>
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc cb, IntPtr p);
    private delegate bool EnumProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    /// <summary>
    /// 向目标窗口（或其全部顶层窗口）发媒体控制命令。
    /// appCommand 取值：14=PLAY 15=STOP 12=PLAY_PAUSE 6=PREV 7=NEXT
    ///                  3=FFWD 4=REWIND 10=CLOSE 0=PLAY 1=PAUSE
    /// targetPid 非 0 时，自动找到该进程的所有顶层窗口并逐个投递
    /// （QQ 音乐等会创建 30+ 个辅助窗口，只投主窗口常常无效）。
    /// </summary>
    public static int MediaCommand(int appCommand, int targetPid) {
        int sent = 0;
        if (targetPid == 0) {
            // HWND_BROADCAST：广播给所有顶层窗口
            if (PostMessage((IntPtr)0xFFFF, 0x0319, IntPtr.Zero, (IntPtr)appCommand)) sent++;
            return sent;
        }
        var handles = new System.Collections.Generic.List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid == (uint)targetPid) handles.Add(h);
            return true;
        }, IntPtr.Zero);
        foreach (var h in handles) {
            if (PostMessage(h, 0x0319, IntPtr.Zero, (IntPtr)appCommand)) sent++;
        }
        return sent;
    }
}`;

/** 组装：加类型定义 + 具体操作。 */
function psScript(body: string[]): string {
  return [`$ErrorActionPreference = 'Stop'`, `$code = @'`, CS_CODE, `'@`, `Add-Type -TypeDefinition $code`, ...body].join(
    '\n',
  );
}

async function runPs(body: string[], timeoutMs = 30_000): Promise<void> {
  const r = await execCommand({ command: psScript(body), timeoutMs });
  if (r.exit_code !== 0) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '输入注入失败', {
      detail: (r.stderr || r.stdout).slice(0, 400),
    });
  }
}

// ---------------- 鼠标 ----------------

const MOUSE_FLAGS: Record<string, { down: number; up: number }> = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};

export async function mouseMove(args: Args): Promise<unknown> {
  assertAllowed('input.mouse.move');
  requireWindows('input.mouse.move');
  const x = args['x'] as number;
  const y = args['y'] as number;
  const duration = (args['duration_ms'] as number) ?? 0;

  if (duration > 0) {
    // 平滑移动：从当前位置插值到目标，分 20 步
    const steps = 20;
    const body: string[] = [`Add-Type -AssemblyName System.Windows.Forms`];
    body.push(`$sx = ([System.Windows.Forms.Cursor]::Position).X`);
    body.push(`$sy = ([System.Windows.Forms.Cursor]::Position).Y`);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      body.push(
        `[NAInput]::MoveTo([int]($sx + (${x} - $sx) * ${t.toFixed(3)}), [int]($sy + (${y} - $sy) * ${t.toFixed(3)}))`,
      );
      body.push(`Start-Sleep -Milliseconds ${Math.max(1, Math.round(duration / steps))}`);
    }
    await runPs(body, duration + 15_000);
  } else {
    await runPs([`[NAInput]::MoveTo(${x}, ${y})`]);
  }
  return { moved: true, x, y };
}

export async function mouseClick(args: Args): Promise<unknown> {
  assertAllowed('input.mouse.click');
  requireWindows('input.mouse.click');
  const button = (args['button'] as string) ?? 'left';
  const count = (args['count'] as number) ?? 1;
  const x = args['x'] as number | undefined;
  const y = args['y'] as number | undefined;
  const flags = MOUSE_FLAGS[button];
  if (!flags) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `不支持的按钮: ${button}`);
  }

  const body: string[] = [];
  if (x !== undefined && y !== undefined) body.push(`[NAInput]::MoveTo(${x}, ${y})`);
  for (let i = 0; i < count; i += 1) {
    body.push(`[NAInput]::Click(${flags.down}, ${flags.up})`);
    if (count > 1) body.push('Start-Sleep -Milliseconds 60');
  }
  await runPs(body);

  // 返回实际点击位置
  const pos = await execCommand({
    command: `Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.Cursor]::Position; "{0},{1}" -f $p.X, $p.Y`,
    timeoutMs: 20_000,
  });
  const [cx, cy] = pos.stdout.trim().split(',').map(Number);
  return { clicked: true, x: x ?? cx ?? 0, y: y ?? cy ?? 0, button };
}

export async function mouseScroll(args: Args): Promise<unknown> {
  assertAllowed('input.mouse.scroll');
  requireWindows('input.mouse.scroll');
  const delta = args['delta'] as number;
  const x = args['x'] as number | undefined;
  const y = args['y'] as number | undefined;

  const body: string[] = [];
  if (x !== undefined && y !== undefined) body.push(`[NAInput]::MoveTo(${x}, ${y})`);
  // Windows 滚轮单位固定为 120 的整数倍
  body.push(`[NAInput]::Wheel(${delta * 120})`);
  await runPs(body);
  return { scrolled: true, delta };
}

/**
 * 鼠标拖拽（v11）：从 (from_x,from_y) 拖到 (to_x,to_y)。
 * 用于拖文件、框选、拖动滑块/窗口。整段动作在一次进程内完成（避免多次 spawn 抖动）。
 */
export async function mouseDrag(args: Args): Promise<unknown> {
  assertAllowed('input.mouse.drag');
  requireWindows('input.mouse.drag');
  const x1 = args['from_x'] as number;
  const y1 = args['from_y'] as number;
  const x2 = args['to_x'] as number;
  const y2 = args['to_y'] as number;
  if ([x1, y1, x2, y2].some((v) => typeof v !== 'number')) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, '需要 from_x/from_y/to_x/to_y');
  }
  const button = (args['button'] as string) ?? 'left';
  const flags = MOUSE_FLAGS[button];
  if (!flags) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `不支持的按钮: ${button}`);
  }
  // 默认步数按距离自适应（保证拖动被系统识别为「拖」而不是瞬移）
  const distance = Math.hypot(x2 - x1, y2 - y1);
  const steps = (args['steps'] as number | undefined) ?? Math.max(8, Math.min(60, Math.round(distance / 25)));
  const stepDelay = (args['step_delay_ms'] as number | undefined) ?? 12;

  await runPs(
    [`[NAInput]::Drag(${flags.down}, ${flags.up}, ${x1}, ${y1}, ${x2}, ${y2}, ${steps}, ${stepDelay})`],
    Math.max(30_000, steps * stepDelay + 15_000),
  );
  return { dragged: true, from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, button, steps };
}

// ---------------- 键盘 ----------------
const VK_MAP: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  capslock: 0x14, printscreen: 0x2c,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  f13: 0x7c, f14: 0x7d, f15: 0x7e, f16: 0x7f, f17: 0x80, f18: 0x81,
  f19: 0x82, f20: 0x83, f21: 0x84, f22: 0x85, f23: 0x86, f24: 0x87,

  // 媒体键（0xA6-0xB7 区段）—— 2026-10-05 补
  //
  // 为何必要：远程控媒体播放器（QQ 音乐 / 网易云 / 浏览器视频）时，
  // 若软件热键不可用（精简模式常不注册全局热键），系统媒体键是唯一
  // 与「窗口是否可见/被遮挡」无关的通道 —— 窗口最小化、被游戏全屏盖住时
  // 依然有效。实测：QQ 音乐精简窗被 DNF 全屏遮挡时，媒体键仍能控���。
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

  // 系统/编辑键补充
  pause: 0x13, break: 0x13,
  apps: 0x5d, menu: 0x5d,
  browser_back: 0xa6, browser_forward: 0xa7, browser_refresh: 0xa8, browser_stop: 0xa9, browser_search: 0xaa,
  launch_mail: 0xb4, launch_media: 0xb5, launch_app1: 0xb6, launch_app2: 0xb7,
};

/**
 * 媒体键名 → APPCOMMAND 取值（2026-10-05 补）。
 *
 * 取值见 Windows `APPCOMMAND_*` 常量。keyPress 识别到整条序列都是媒体键时，
 * 改用 `WM_APPCOMMAND` 投递（而非 SendInput 注入 VK）—— 前者能定向到
 * 指定窗口/进程，且不受「窗口被遮挡 / 非当前媒体会话焦点」影响。
 *
 * ⚠️ 取值是**按位**传入 lParam 的（低 16 位为 command，位 12-15 为设备类型），
 * 因此不同 command 的裸值可能相同（如 VOLUME_DOWN=0x208 与 PAUSE=0x031 的
 * 设备位不同），不能简单复用。音量键走**真·虚拟键注入**（VK 0xAD-0xAF，
 * 见 VK_MAP）更可靠 —— 系统会自行映射为 APPCOMMAND_VOLUME_*，
 * 故此处**刻意不收录音量键**，避免 device-bit 歧义。
 */
const MEDIA_COMMANDS: Record<string, number> = {
  media_play: 14, play: 14,
  media_pause: 1, pause: 1,
  media_play_pause: 12, play_pause: 12,
  media_stop: 15, stop: 15,
  media_prev: 6, media_previous: 6, prev_track: 6, prev: 6,
  media_next: 7, next_track: 7, next: 7,
  media_fast_forward: 3, fast_forward: 3,
  media_rewind: 4, rewind: 4,
  media_close: 10, close: 10,
  // 注：volume_mute / volume_up / volume_down 不在此表 —— 它们只走 VK 注入
  //（VK 0xAD/0xAF/0xAE），由系统自行翻译为对应的 APPCOMMAND。
  // 这样 MediaCommand 不会与它们混淆（见上方 device-bit 说明）。
};

/** 键名 → 虚拟键码（字母/数字走 ASCII 映射，其余查表白名单）。 */
function toVk(key: string): number {
  const k = key.trim().toLowerCase();
  if (VK_MAP[k] !== undefined) return VK_MAP[k]!;
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  throw new CapabilityError(ErrorCodes.PARAM_INVALID, `不支持的按键: ${key}`, {
    supported: [...Object.keys(VK_MAP), 'a-z', '0-9'],
  });
}

export async function keyType(args: Args): Promise<unknown> {
  assertAllowed('input.key.type');
  requireWindows('input.key.type');
  const text = args['text'] as string;
  const interval = (args['interval_ms'] as number) ?? 10;

  // 文本经 Base64 传入，避免任何形式的内容注入
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  // 走 C# 的 UnicodeString：按 UTF-16 码元成对注入，代理对（emoji 等）不再被拆坏
  const body = [
    `$bytes = [Convert]::FromBase64String('${b64}')`,
    `$text = [System.Text.Encoding]::UTF8.GetString($bytes)`,
    `[NAInput]::UnicodeString($text, ${Math.max(0, Math.round(interval))})`,
  ];
  await runPs(body, 30_000 + text.length * (interval + 5));
  // 回显注入长度与码元数：中文 1 字 = 1 码元，emoji = 2 码元
  // （若将来发现错字，可用 codepoints 辅助定位是 IME 抖动还是注入截断）
  return { typed: true, length: text.length, code_points: [...text].length, utf16_units: text.length };
}

export async function keyPress(args: Args): Promise<unknown> {
  assertAllowed('input.key.press');
  requireWindows('input.key.press');

  // v10.2：支持三种语义
  //   1) keys      —— 单个和弦（如 ["ctrl","c"]）
  //   2) repeat    —— 和弦重复 N 次（解决「连按上键 3 次」这类需求）
  //   3) sequence  —— 任意和弦序列（如 [["ctrl","c"], ["ctrl","v"]]）
  const sequence = args['sequence'] as string[][] | undefined;
  const repeat = Math.max(1, Math.min(50, (args['repeat'] as number | undefined) ?? 1));
  const keys = args['keys'] as string[] | undefined;

  const chords: string[][] = sequence?.length
    ? sequence
    : keys?.length
      ? Array.from({ length: repeat }, () => keys)
      : [];
  if (chords.length === 0) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, '需提供 keys（可配 repeat）或 sequence');
  }

  const body: string[] = [];
  const gap = Math.max(0, Math.min(2000, (args['interval_ms'] as number) ?? 40));

  // 媒体键走 WM_APPCOMMAND 通道（2026-10-05 补）
  //
  // 仅当**整条序列都是媒体键**时启用。若混在普通按键里（如 ["ctrl","media_play_pause"]）
  // 则回退到 VK 注入 —— 那种组合场景本就罕见，SendInput 足够。
  const allMedia = chords.every((ch) => ch.length === 1 && MEDIA_COMMANDS[ch[0]!.trim().toLowerCase()] !== undefined);
  if (allMedia) {
    // target_pid 非 0 时定向投递到该进程的全部顶层窗口（QQ 音乐会建 30+ 辅助窗口，
    // 只投主窗口常常无效 —— 实测踩过）；否则广播。
    const pid = (args['target_pid'] as number) ?? 0;
    for (let i = 0; i < chords.length; i += 1) {
      const cmd = MEDIA_COMMANDS[chords[i]![0]!.trim().toLowerCase()]!;
      body.push(`[NAInput]::MediaCommand(${cmd}, ${Math.max(0, Math.trunc(pid))})`);
      if (i < chords.length - 1 && gap > 0) body.push(`Start-Sleep -Milliseconds ${gap}`);
    }
    await runPs(body);
    return {
      pressed: true,
      keys: chords.length === 1 ? chords[0] : undefined,
      chords,
      times: chords.length,
      via: 'appcommand',
      target_pid: pid || null,
    };
  }

  for (let i = 0; i < chords.length; i += 1) {
    const chord = chords[i]!;
    if (chord.length === 0) continue;
    const vks = chord.map(toVk);
    for (const vk of vks) body.push(`[NAInput]::Vk(${vk}, $false)`);
    // 逆序释放，保证组合键正确
    for (const vk of [...vks].reverse()) body.push(`[NAInput]::Vk(${vk}, $true)`);
    if (i < chords.length - 1 && gap > 0) body.push(`Start-Sleep -Milliseconds ${gap}`);
  }
  await runPs(body);
  // 同时回传 keys（单和弦时的回显）与 chords（完整序列）。
  // 修正 2026-10-04：此前只回 chords，控制端 CLI 读 keys.join() 直接崩溃。
  return {
    pressed: true,
    keys: chords.length === 1 ? chords[0] : undefined,
    chords,
    times: chords.length,
  };
}
