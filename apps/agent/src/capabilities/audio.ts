import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';
import { runPowerShellSmart } from '../util/ps-helper.js';

type Args = Record<string, unknown>;

/**
 * 音频控制（v17）：静音开关与主音量。
 *
 * ## 为什么需要
 * 远程接管一台机器时，「把它静音」是高频且刚需的小事（夜里吵、放视频要音量、
 * 排障时确认音频设备）。此前只能靠 exec 拼一段脚本，容易踩本项目已记录的
 * 各种坑（C# 转义 / 编码 / 引号），故做成正式能力。
 *
 * ## 平台实现
 * - Windows：**Core Audio COM**（IMMDeviceEnumerator → IAudioEndpointVolume）
 *   —— 可**读回真实状态**，因此是确定性的「设为静音」而非「切换」
 *   （切换在状态未知时可能反而打开声音）。不用 Add-Type -AssemblyName 那套，
 *   是因为音量不在 .NET BCL 里，只能用 COM 互操作。
 * - macOS：`osascript` 的 volume 设置（原生，无需互操作）。
 *
 * ## C# 互操作的两个硬约束（本项目踩过的坑，勿改）
 * 1. **槽位顺序即 vtable 顺序**：接口方法必须按 COM 定义顺序声明，
 *    不调用的方法也要占位（占位方法签名无所谓，但不能漏）。
 *    顺序错了不会编译报错，而是调用到错误的内存地址 → 进程崩溃。
 * 2. **C# 源码必须纯 ASCII**：Add-Type 按系统 ANSI(GBK) 落盘，非 ASCII 会乱码。
 */

// 不调用的方法只占槽位，签名随意；**顺序不可调整**（见文件头注释）
const AUDIO_PRELUDE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class NAAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  private class MMDeviceEnumerator { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceEnumerator {
    int m1();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  }

  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioEndpointVolume {
    int m1(); int m2(); int m3(); int m4();
    int SetMasterVolumeLevelScalar(float fLevel, IntPtr pguidEventContext);
    int m6();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int m8(); int m9(); int m10(); int m11();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, IntPtr pguidEventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
  }

  private const char SEP = (char)124;

  private static IAudioEndpointVolume Default() {
    IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 0, out dev));
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }

  private static string Snapshot(IAudioEndpointVolume v) {
    bool muted;
    Marshal.ThrowExceptionForHR(v.GetMute(out muted));
    float lvl;
    Marshal.ThrowExceptionForHR(v.GetMasterVolumeLevelScalar(out lvl));
    return (muted ? "1" : "0") + SEP + ((int)Math.Round(lvl * 100));
  }

  public static string Get() {
    return Snapshot(Default());
  }

  public static string Mute(string flag) {
    IAudioEndpointVolume v = Default();
    bool want = flag == "1";
    Marshal.ThrowExceptionForHR(v.SetMute(want, IntPtr.Zero));
    return Snapshot(v);
  }

  public static string Volume(int percent) {
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    IAudioEndpointVolume v = Default();
    Marshal.ThrowExceptionForHR(v.SetMasterVolumeLevelScalar(percent / 100f, IntPtr.Zero));
    return Snapshot(v);
  }

  public static string Apply(string flag, int percent) {
    IAudioEndpointVolume v = Default();
    if (percent >= 0) Marshal.ThrowExceptionForHR(v.SetMasterVolumeLevelScalar(percent / 100f, IntPtr.Zero));
    if (flag == "0" || flag == "1") Marshal.ThrowExceptionForHR(v.SetMute(flag == "1", IntPtr.Zero));
    return Snapshot(v);
  }
}
"@
`;

/** 解析 C# 回传的 `静音|音量` 紧凑串。 */
export function parseAudioState(raw: string): { muted: boolean; volume: number } {
  const line = raw.trim().split('\n').pop() ?? '';
  const m = line.match(/([01])\s*\|\s*(\d{1,3})/);
  if (!m) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '音频状态解析失败', { detail: raw.slice(0, 200) });
  }
  return { muted: m[1] === '1', volume: Number(m[2]) };
}

async function runWindows(body: string, timeoutMs = 30_000): Promise<string> {
  const { stdout } = await runPowerShellSmart({
    body,
    prelude: AUDIO_PRELUDE,
    timeoutMs,
    label: 'audio',
    log: (level, msg) => {
      if (level === 'warn') console.error(`[audio] ${msg}`);
    },
  });
  return stdout;
}

/** macOS：osascript 原生音量控制（静音用 `output muted`，音量用 `output volume`）。 */
async function runMac(script: string): Promise<string> {
  const r = await execCommand({ command: `osascript -e ${JSON.stringify(script)}`, timeoutMs: 15_000 });
  if (r.exit_code !== 0) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '音频控制失败（osascript）', {
      detail: (r.stderr || r.stdout).slice(0, 300),
    });
  }
  return r.stdout.trim();
}

async function macState(): Promise<{ muted: boolean; volume: number }> {
  const out = await runMac('get volume settings');
  // 形如: output volume:42, input volume:100, alert volume:100, output muted:false
  const vol = /output volume:(\d+)/.exec(out);
  const muted = /output muted:(true|false)/.exec(out);
  return { muted: muted?.[1] === 'true', volume: vol ? Number(vol[1]) : 0 };
}

// ---------------- system.audio.get ----------------

export async function audioGet(_args: Args): Promise<unknown> {
  if (IS_WINDOWS) {
    const state = parseAudioState(await runWindows('[NAAudio]::Get()'));
    return { ...state, platform: 'windows', backend: 'CoreAudio' };
  }
  if (process.platform === 'darwin') {
    return { ...(await macState()), platform: 'macos', backend: 'osascript' };
  }
  throw new CapabilityError(ErrorCodes.UNSUPPORTED_PLATFORM, '音频控制仅支持 Windows / macOS 被控端', {
    platform: process.platform,
  });
}

// ---------------- system.audio.set ----------------

export async function audioSet(args: Args): Promise<unknown> {
  const muteArg = args['mute'];
  const volumeArg = args['volume'];
  const hasMute = typeof muteArg === 'boolean';
  const hasVolume = typeof volumeArg === 'number';
  if (!hasMute && !hasVolume) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, '至少提供 mute（布尔）或 volume（0-100）之一');
  }
  const volume = hasVolume ? Math.max(0, Math.min(100, Math.round(volumeArg as number))) : -1;

  if (IS_WINDOWS) {
    const flag = hasMute ? ((muteArg as boolean) ? '1' : '0') : '';
    const body = `[NAAudio]::Apply('${flag}', ${volume})`;
    const state = parseAudioState(await runWindows(body));
    return { ...state, platform: 'windows', backend: 'CoreAudio', applied: { mute: hasMute ? muteArg : null, volume: hasVolume ? volume : null } };
  }

  if (process.platform === 'darwin') {
    if (hasMute) await runMac(`set volume output muted ${muteArg === true ? 'true' : 'false'}`);
    if (hasVolume) await runMac(`set volume output volume ${volume}`);
    const state = await macState();
    return { ...state, platform: 'macos', backend: 'osascript', applied: { mute: hasMute ? muteArg : null, volume: hasVolume ? volume : null } };
  }

  throw new CapabilityError(ErrorCodes.UNSUPPORTED_PLATFORM, '音频控制仅支持 Windows / macOS 被控端', {
    platform: process.platform,
  });
}
