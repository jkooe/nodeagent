import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';
import { agentDir } from '../config.js';

type Args = Record<string, unknown>;

/**
 * macOS 端 GUI 语义（v12.3 / 跨平台对齐）。
 *
 * 与 Windows 的对照：
 *   | 能力            | Windows                  | macOS                                   |
 *   |-----------------|--------------------------|-----------------------------------------|
 *   | window.list     | Win32 EnumWindows        | AppleScript System Events（需辅助功能权限）|
 *   | window.focus    | SetForegroundWindow+兜底  | AppleScript frontmost + AXRaise          |
 *   | screen.find     | UIA → OCR(WinRT)         | 无 UIA 等价物 → 截图 + **Vision OCR**     |
 *
 * 权限说明（macOS 的硬门槛，无法绕过）：
 *   - 枚举/聚焦窗口：系统设置 → 隐私与安全性 → **辅助功能**里勾选运行 agent 的程序
 *   - 截屏做 OCR：**屏幕录制**权限
 * 未授权时给出明确指引，而不是笼统失败。
 */

const OSA = 'osascript';

function assertDarwin(capability: string): void {
  if (IS_WINDOWS) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `${capability} 的 macOS 实现不应在 Windows 上调用`);
  }
  if (process.platform !== 'darwin') {
    throw new CapabilityError(ErrorCodes.UNSUPPORTED_PLATFORM, `${capability} 暂不支持 ${process.platform}`, {
      platform: process.platform,
    });
  }
}

/** 跑 AppleScript：脚本经 stdin 传入，避免引号转义问题。 */
async function runOsa(script: string, timeoutMs = 30_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const r = await execCommand({
    // -e 接受多行；用 base64 传入再还原，彻底规避引号/换行问题
    command: `printf %s '${b64}' | base64 -d | ${OSA} -l AppleScript -`,
    timeoutMs,
  });
  return { ok: r.exit_code === 0, stdout: r.stdout.trim(), stderr: (r.stderr || '').trim() };
}

/**
 * 把 macOS 的权限类错误翻译成可执行指引。
 * 实测错误码/文案（真机）：
 *   -10004「发生权限违例 / privilege violation」→ 辅助功能（Accessibility）未授权
 *   -1743「Not authorized to send Apple events」→ 自动化授权
 *   -25211 / 「not allowed assistive access」→ 辅助功能
 * 未授权时 screencapture 通常仍成功但内容为纯黑/仅桌面 —— 由 OCR 结果为空体现。
 */
function permissionHint(raw: string): string {
  if (/10004|权限违例|privilege violation|not allowed assistive|不允许辅助访问|-25211|-1719/i.test(raw)) {
    return '（请到「系统设置 → 隐私与安全性 → 辅助功能」勾选运行 agent 的程序，然后重启它）';
  }
  if (/not authorized to send Apple events|-1743/i.test(raw)) {
    return '（请到「系统设置 → 隐私与安全性 → 自动化」允许控制 System Events）';
  }
  return '';
}

// ---------------- window.list ----------------

const LIST_SCRIPT = `
set out to ""
tell application "System Events"
  set fgProc to name of first application process whose frontmost is true
  repeat with p in (every application process whose visible is true)
    try
      set pname to name of p
      set ppid to unix id of p
      repeat with w in (every window of p)
        try
          set wname to name of w
          set wpos to position of w
          set wsz to size of w
          set isFg to (pname is fgProc)
          set out to out & pname & "\\t" & ppid & "\\t" & wname & "\\t" & (item 1 of wpos) & "\\t" & (item 2 of wpos) & "\\t" & (item 1 of wsz) & "\\t" & (item 2 of wsz) & "\\t" & isFg & "\\n"
        end try
      end repeat
    end try
  end repeat
end tell
return out
`;

interface MacWindow {
  title: string;
  process: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  is_foreground: boolean;
  is_minimized: boolean;
}

export async function macWindowList(args: Args): Promise<unknown> {
  assertDarwin('window.list');
  const r = await runOsa(LIST_SCRIPT, 40_000);
  if (!r.ok) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `枚举窗口失败${permissionHint(r.stderr)}`, {
      detail: r.stderr.slice(0, 300),
    });
  }
  const all: MacWindow[] = [];
  for (const line of r.stdout.split('\n')) {
    const f = line.split('\t');
    if (f.length < 8) continue;
    const [process, pidRaw, title, x, y, w, h, fg] = f as [
      string, string, string, string, string, string, string, string,
    ];
    const width = Number(w);
    const height = Number(h);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 40 || height <= 40) continue;
    all.push({
      title: title || process,
      process,
      pid: Number(pidRaw) || 0,
      x: Number(x),
      y: Number(y),
      width,
      height,
      is_foreground: fg.trim().toLowerCase() === 'true',
      is_minimized: false, // AppleScript 取「every window」通常已排除最小化窗口
    });
  }

  const pattern = args['title_pattern'] as string | undefined;
  let filtered = all;
  if (pattern) {
    const re = new RegExp(pattern, 'i');
    filtered = all.filter((w) => re.test(w.title) || re.test(w.process));
  }
  // 与 Windows 侧保持一致：前台窗口置顶，避免被 limit 截掉
  filtered.sort((a, b) => Number(b.is_foreground) - Number(a.is_foreground));
  const limit = (args['limit'] as number | undefined) ?? 50;
  return { windows: filtered.slice(0, limit), total: filtered.length };
}

// ---------------- window.focus ----------------

export async function macWindowFocus(args: Args): Promise<unknown> {
  assertDarwin('window.focus');
  const title = args['title'] as string | undefined;
  if (!title) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'macOS 端目前需提供 title（正则）；暂不支持句柄');
  }
  const waitMs = Math.max(0, Math.min(30_000, (args['wait_ms'] as number | undefined) ?? 0));
  const startedAt = Date.now();

  const script = `
set re to "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
set targetProc to ""
set targetTitle to ""
tell application "System Events"
  repeat with p in (every application process whose visible is true)
    try
      set pname to name of p
      repeat with w in (every window of p)
        try
          set wname to name of w
          if wname contains re or pname contains re then
            set targetProc to pname
            set targetTitle to wname
            exit repeat
          end if
        end try
      end repeat
      if targetProc is not "" then exit repeat
    end try
  end repeat
  if targetProc is "" then return "NOTFOUND"
  set frontmost of (first application process whose name is targetProc) to true
  try
    perform action "AXRaise" of (first window of (first application process whose name is targetProc))
  end try
  delay 0.3
end tell
set out to ""
tell application "System Events"
  set fg to name of first application process whose frontmost is true
  set p to first application process whose name is targetProc
  set wpos to position of first window of p
  set wsz to size of first window of p
  set out to targetTitle & "\\t" & (item 1 of wpos) & "\\t" & (item 2 of wpos) & "\\t" & (item 1 of wsz) & "\\t" & (item 2 of wsz) & "\\t" & (fg is targetProc)
end tell
return out
`;

  let lastErr = '';
  for (;;) {
    const r = await runOsa(script, 40_000);
    if (r.ok && r.stdout && r.stdout !== 'NOTFOUND') {
      const f = r.stdout.split('\t');
      if (f.length >= 6) {
        return {
          title: f[0],
          x: Number(f[1]),
          y: Number(f[2]),
          width: Number(f[3]),
          height: Number(f[4]),
          focused: (f[5] ?? '').trim().toLowerCase() === 'true',
          activated_by: 'applescript',
          waited_ms: Date.now() - startedAt,
        };
      }
    }
    lastErr = r.ok ? '未找到匹配的窗口' : r.stderr;
    if (Date.now() - startedAt >= waitMs) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `聚焦失败：${lastErr}${permissionHint(lastErr)}`, {
    detail: lastErr.slice(0, 300),
  });
}

// ---------------- screen.find（截图 + Vision OCR） ----------------

/** Vision OCR 助手：编译一次后缓存到数据目录，后续秒级复用。 */
const OCR_SWIFT = `
import Foundation
import Vision
import AppKit

// 用法: naocr <image.png> [searchText]
// 输出: JSON 数组 [{text,x,y,w,h,confidence}]（像素坐标，原点左上）
let args = CommandLine.arguments
guard args.count >= 2 else { FileHandle.standardError.write("usage: naocr <image> [text]\\n".data(using: .utf8)!); exit(2) }
let imagePath = args[1]
let search = args.count >= 3 ? args[2] : ""

guard let img = NSImage(contentsOfFile: imagePath),
      let tiff = img.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let cg = bitmap.cgImage else {
    FileHandle.standardError.write("cannot load image\\n".data(using: .utf8)!); exit(3)
}
let width = Double(cg.width), height = Double(cg.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["zh-Hans", "en-US"]

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch {
    FileHandle.standardError.write("ocr failed: \\(error)\\n".data(using: .utf8)!); exit(4)
}
let norm: (String) -> String = { $0.replacingOccurrences(of: " ", with: "") }
let want = norm(search)
var out: [[String: Any]] = []
for obs in (request.results ?? []) {
    guard let top = obs.topCandidates(1).first else { continue }
    let text = top.string
    if !want.isEmpty && !norm(text).lowercased().contains(want.lowercased()) { continue }
    let bb = obs.boundingBox
    let x = bb.minX * width
    let y = (1.0 - bb.maxY) * height
    let w = bb.width * width
    let h = bb.height * height
    out.append(["text": text, "x": x, "y": y, "w": w, "h": h, "confidence": Double(top.confidence)])
}
let data = try JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
`;

/**
 * 读取 PNG 的像素尺寸（解析 IHDR 头，不启动额外进程）。
 * 用途：Retina 屏上 `screencapture` 产出的是 **2x 像素**图，而窗口坐标是**逻辑点**，
 * 若不做换算，返回的坐标会让点击偏移一倍（真机踩到）。
 */
function pngSize(file: string): { width: number; height: number } | null {
  try {
    const buf = readFileSync(file);
    // IHDR 数据从第 16 字节开始：width(4) height(4)
    if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function ocrBinPath(): string {
  return join(agentDir(), 'bin', 'naocr');
}

/** 确保 OCR 助手已编译（源码变化或二进制缺失时重编）。 */
async function ensureOcrBin(): Promise<string> {
  const dir = join(agentDir(), 'bin');
  mkdirSync(dir, { recursive: true });
  const src = join(dir, 'naocr.swift');
  const bin = ocrBinPath();
  const needSrc = !existsSync(src) || readFileSync(src, 'utf8') !== OCR_SWIFT;
  if (needSrc) writeFileSync(src, OCR_SWIFT);
  const needBuild = needSrc || !existsSync(bin);
  if (needBuild) {
    const r = await execCommand({
      command: `swiftc -O -o '${bin}' '${src}'`,
      timeoutMs: 180_000,
    });
    if (r.exit_code !== 0) {
      throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '编译 OCR 助手失败（需要 Xcode 命令行工具）', {
        detail: (r.stderr || r.stdout).slice(0, 300),
      });
    }
  }
  return bin;
}

export async function macScreenFind(args: Args): Promise<unknown> {
  assertDarwin('screen.find');
  const text = args['text'] as string;
  if (!text) {
    // macOS 走 Vision OCR，**没有控件属性可读** —— where-only 无法满足，
    // 明确说清原因，别让调用方以为是参数写错。
    throw new CapabilityError(
      ErrorCodes.UNSUPPORTED_PLATFORM,
      'macOS 无 UIA 等价物：where 属性过滤不可用，请提供 text（OCR 按文字查找）',
      { platform: 'darwin', engine: 'ocr' },
    );
  }
  const limit = (args['limit'] as number | undefined) ?? 20;
  const waitMs = Math.max(0, Math.min(30_000, (args['wait_ms'] as number | undefined) ?? 0));
  const intervalMs = Math.max(100, Math.min(2000, (args['interval_ms'] as number | undefined) ?? 400));
  const region = args['region'] as { x: number; y: number; width: number; height: number } | undefined;

  const bin = await ensureOcrBin();
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'na-ocr-'));
  const shot = join(dir, 'shot.png');

  const captureRegion = region ?? (await fullVirtualScreen());
  const startedAt = Date.now();
  let matches: Array<Record<string, unknown>> = [];

  try {
    for (;;) {
      const cap = await execCommand({
        command: `screencapture -x -t png -R ${captureRegion.x},${captureRegion.y},${captureRegion.width},${captureRegion.height} ${JSON.stringify(shot)}`,
        timeoutMs: 30_000,
      });
      if (cap.exit_code !== 0) {
        throw new CapabilityError(
          ErrorCodes.EXECUTION_FAILED,
          '截屏失败（需「屏幕录制」权限）',
          { detail: (cap.stderr || '').slice(0, 200) },
        );
      }
      // Retina 换算：图片像素 / 请求区域点数 = 缩放比（通常 2）
      const img = pngSize(shot);
      const scale =
        img && captureRegion.width > 0 ? img.width / captureRegion.width : 1;

      const r = await execCommand({
        command: `${JSON.stringify(bin)} ${JSON.stringify(shot)} ${JSON.stringify(text)}`,
        timeoutMs: 60_000,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      if (r.exit_code !== 0) {
        throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, 'OCR 失败', {
          detail: (r.stderr || r.stdout).slice(0, 300),
        });
      }
      const start = r.stdout.indexOf('[');
      const end = r.stdout.lastIndexOf(']');
      const raw =
        start >= 0 && end > start
          ? (JSON.parse(r.stdout.slice(start, end + 1)) as Array<{
              text: string;
              x: number;
              y: number;
              w: number;
              h: number;
              confidence: number;
            }>)
          : [];
      matches = raw.slice(0, limit).map((m) => {
        // 先由像素换算回逻辑点，再叠加区域偏移 -> 得到可直接用于点击的屏幕坐标
        const px = m.x / scale;
        const py = m.y / scale;
        const pw = m.w / scale;
        const ph = m.h / scale;
        return {
          name: m.text,
          control_type: 'Text(ocr)',
          x: Math.round(px + pw / 2 + captureRegion.x),
          y: Math.round(py + ph / 2 + captureRegion.y),
          left: Math.round(px + captureRegion.x),
          top: Math.round(py + captureRegion.y),
          width: Math.round(pw),
          height: Math.round(ph),
        };
      });
      if (matches.length > 0 || Date.now() - startedAt >= waitMs) break;
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }

  return {
    matches,
    engine: 'ocr',
    waited_ms: Date.now() - startedAt,
    note: 'macOS 无 UIA 等价物，统一走 Vision OCR（只识别可见内容）；坐标已由 Retina 像素换算为逻辑点',
  };
}

/** 取整块虚拟屏的尺寸（多屏取并集）。 */
async function fullVirtualScreen(): Promise<{ x: number; y: number; width: number; height: number }> {
  const r = await runOsa(
    `tell application "Finder" to get bounds of window of desktop`,
    10_000,
  );
  if (r.ok) {
    const m = /(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/.exec(r.stdout);
    if (m) {
      const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }
  }
  return { x: 0, y: 0, width: 1920, height: 1080 };
}
