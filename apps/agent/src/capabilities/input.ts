import { CapabilityError, ErrorCodes, expandChords } from '@nodeagent/protocol';
import {
  isAllMedia,
  buildMediaBody,
  buildForegroundBody,
  buildPostBody,
} from './input-script.js';
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

    /// <summary>
    /// v1.5：向目标进程的**全部顶层窗口** PostMessage 键盘消息（后端定向快捷键投放）。
    ///
    /// 场景：目标窗口不在前台（被遮挡 / 最小化 / 聊天窗口在后台），又要给它发快捷键。
    /// WM_KEYDOWN=0x0100，WM_KEYUP=0x0101；修饰键按顺序投递，调用方负责释放顺序。
    ///
    /// ⚠️ 已知局限（务必告知调用方）：
    ///   - 部分程序不处理**后台**键盘消息（游戏、部分浏览器与输入型应用直接忽略）；
    ///   - PostMessage 不带 scancode，依赖 lParam 解码按键的程序可能取不到键。
    /// 该类目标请改用默认 route=foreground（前台注入，需目标可见）。
    /// </summary>
    public static int PostChord(ushort[] vks, int targetPid, bool up) {
        int sent = 0;
        if (vks == null || vks.Length == 0) return 0;
        var handles = new System.Collections.Generic.List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid == (uint)targetPid) handles.Add(h);
            return true;
        }, IntPtr.Zero);
        uint msg = up ? 0x0101u : 0x0100u;
        foreach (var h in handles) {
            foreach (var vk in vks) {
                if (PostMessage(h, msg, (IntPtr)vk, IntPtr.Zero)) sent++;
            }
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

async function runPs(body: string[], timeoutMs = 30_000): Promise<string> {
  const r = await execCommand({ command: psScript(body), timeoutMs });
  if (r.exit_code !== 0) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '输入注入失败', {
      detail: (r.stderr || r.stdout).slice(0, 400),
    });
  }
  return r.stdout ?? '';
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

  // v1.5：入参统一经 protocol 的 expandChords 展开 —— 字符串热键 / 预设名 / 老数组形式
  // 全部收敛成「归一化和弦序列」。混用多种形式会直接报错，避免"以谁为准"的歧义。
  let expanded;
  try {
    expanded = expandChords({
      hotkey: args['hotkey'] as string | undefined,
      hotkeys: args['hotkeys'] as string[] | undefined,
      preset: args['preset'] as string | undefined,
      presets: args['presets'] as string[] | undefined,
      keys: args['keys'] as string[] | undefined,
      sequence: args['sequence'] as string[][] | undefined,
      repeat: args['repeat'] as number | undefined,
    });
  } catch (err) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `快捷键参数错误: ${err instanceof Error ? err.message : String(err)}`);
  }
  const chords = expanded.chords;
  const presets = expanded.presets;

  const gap = Math.max(0, Math.min(2000, (args['interval_ms'] as number) ?? 40));
  // v1.5：长按（按下到释放的保持时长），用于"长按音量/持续按住方向键"等场景
  const holdMs = Math.max(0, Math.min(5000, Math.round((args['hold_ms'] as number | undefined) ?? 0)));
  // v1.5：投放路由。foreground = SendInput 注入当前焦点（默认，旧行为）；
  //       post = 向目标进程全部顶层窗口 PostMessage（窗口在后台时可用，但兼容性差）
  const route = (args['route'] as string | undefined) ?? 'foreground';
  if (route !== 'foreground' && route !== 'post') {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `不支持的 route: ${route}`, { allowed: ['foreground', 'post'] });
  }
  const pid = (args['target_pid'] as number) ?? 0;
  if (route === 'post' && pid <= 0) {
    throw new CapabilityError(
      ErrorCodes.PARAM_INVALID,
      'route=post 需要提供 target_pid（≥1）—— 后台投递必须知道投给哪个进程',
      { hint: '用 window.list 取目标进程 PID；无目标时请用默认 route=foreground' },
    );
  }

  // 媒体键走 WM_APPCOMMAND 通道（2026-10-05 补）
  //
  // 仅当**整条序列都是媒体键**时启用。若混在普通按键里（如 ["ctrl","media_play_pause"]）
  // 则回退到 VK 注入 —— 那种组合场景本就罕见，SendInput 足够。
  const allMedia = isAllMedia(chords);
  if (allMedia) {
    // target_pid 非 0 时定向投递到该进程的全部顶层窗口（QQ 音乐会建 30+ 辅助窗口，
    // 只投主窗口常常无效 —— 实测踩过）；否则广播。
    const mediaBody = buildMediaBody(chords, { gapMs: gap, holdMs, targetPid: pid, route });
    await runPs(mediaBody);
    return {
      pressed: true,
      keys: chords.length === 1 ? chords[0] : undefined,
      chords,
      times: chords.length,
      presets,
      via: expanded.via,
      channel: 'appcommand',
      target_pid: pid || null,
    };
  }

  // v1.5：后端定向投递（route=post）—— 目标窗口不在前台时使用
  if (route === 'post') {
    let sent = 0;
    const out = await runPs(buildPostBody(chords, { gapMs: gap, holdMs, targetPid: pid, route }));
    // 累计投递成功的窗口数（C# 侧每次 PostMessage 成功计数）
    let total = 0;
    for (const line of out.split('\n')) {
      const m = /(\d+)/.exec(line.trim());
      if (m) total += Number(m[1]);
    }
    sent = total;
    return {
      pressed: true,
      keys: chords.length === 1 ? chords[0] : undefined,
      chords,
      times: chords.length,
      presets,
      via: expanded.via,
      channel: 'postmessage',
      route,
      target_pid: pid,
      sent_windows: sent,
      note:
        sent === 0
          ? '未投递到任何窗口（进程可能已退出或没有任何顶层窗口）'
          : '后台投递兼容性有限：游戏/部分浏览器与输入型程序不响应后台键盘消息，' +
            '无效时改用 route=foreground 并确保目标窗口可见',
    };
  }

  await runPs(buildForegroundBody(chords, { gapMs: gap, holdMs, targetPid: pid, route }));
  // 同时回传 keys（单和弦时的回显）与 chords（完整序列）。
  // 修正 2026-10-04：此前只回 chords，控制端 CLI 读 keys.join() 直接崩溃。
  return {
    pressed: true,
    keys: chords.length === 1 ? chords[0] : undefined,
    chords,
    times: chords.length,
    presets,
    via: expanded.via,
    hold_ms: holdMs || undefined,
    route,
  };
}
