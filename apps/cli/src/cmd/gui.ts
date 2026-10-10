import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path, { join } from 'node:path';
import {
  NodeAgentClient,
  loadMacroFile,
  runMacro,
  ClientError,
  loadConfig,
  saveConfig,
  configPath,
  toWsUrl,
  loadKeys,
  createKeys,
  keysFilePath,
  discoverOnce,
  resolveTarget,
  resolveNodeSelector,
  emptyConfig,
  type ClientConfig,
  type ResolvedTarget,
  type NodeProfile,
} from '@nodeagent/client';
import {
  CapabilityNames,
  HOTKEY_PRESETS,
  matchPattern,
  DEFAULT_DISCOVERY_PORT,
  type CapabilityDescriptor,
  type InvokeResult,
} from '@nodeagent/protocol';
import {
  callAndPrint,
  fail,
  getClientConfig,
  humanSize,
  printJson,
  riskIcon,
  withClient,
  withClientDirect,
} from '../core.js';
import { CHUNK_BYTES, type Options } from '../types.js';

// CLI 命令组：cmd/gui.ts
export async function cmdScreen(opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ScreenInfo, {}, opts.json, (data) => {
      const rows = (
        data as { displays: Array<{ id: number; name: string; width: number; height: number; is_primary: boolean }> }
      ).displays;
      for (const d of rows) {
        console.log(
          `  #${d.id}  ${String(d.width).padStart(5)}x${String(d.height).padEnd(5)} ${d.is_primary ? '[主屏]' : '      '}  ${d.name}`,
        );
      }
    }),
  );
}

export async function cmdScreenshot(opts: Options): Promise<void> {
  const args: Record<string, unknown> = {};
  if (opts.format) args['format'] = opts.format;
  if (opts.scale) {
    const s = Number(opts.scale);
    // 协议限定 scale ∈ (0, 1]（缩小）。原先直接把非法值发出去，
    // 被控端只回一句「参数校验失败」，看不出是哪一项 —— 2026-10-05 实测踩过。
    if (!Number.isFinite(s) || s <= 0 || s > 1) {
      fail(`--scale 应在 0 到 1 之间（1=原尺寸，0.5=半尺寸），收到: ${opts.scale}`);
    }
    args['scale'] = s;
  }
  if (opts.region) {
    const nums = opts.region.split(',').map(Number);
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) fail('--region 格式应为 x,y,width,height');
    args['region'] = { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
  }
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ScreenCapture, args, opts.json, (data) => {
      const d = data as { image: string; format: string; width: number; height: number; bytes: number };
      const out = opts.out ?? `screenshot.${d.format === 'png' ? 'png' : 'jpg'}`;
      writeFileSync(out, Buffer.from(d.image, 'base64'));
      console.log(`✓ 已保存 ${out}  ${d.width}x${d.height}  ${humanSize(d.bytes)}`);
    }),
  );
}

export async function cmdMouse(action: string | undefined, positionals: string[], opts: Options): Promise<void> {
  const [a, b] = positionals;
  switch (action) {
    case 'move': {
      if (!a || !b) fail('用法: nodeagent mouse move <x> <y> [--duration 300]');
      const args: Record<string, unknown> = { x: Number(a), y: Number(b) };
      if (opts.duration) args['duration_ms'] = Number(opts.duration);
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MouseMove, args, opts.json, (d) => {
          const r = d as { x: number; y: number };
          console.log(`✓ 鼠标已移动到 (${r.x}, ${r.y})`);
        }),
      );
      return;
    }
    case 'click': {
      const args: Record<string, unknown> = {};
      if (a && b) {
        args['x'] = Number(a);
        args['y'] = Number(b);
      }
      if (opts.button) args['button'] = opts.button;
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MouseClick, args, opts.json, (d) => {
          const r = d as { x: number; y: number; button: string };
          console.log(`✓ 已${r.button}键点击 (${r.x}, ${r.y})`);
        }),
      );
      return;
    }
    case 'scroll': {
      if (!a) fail('用法: nodeagent mouse scroll <delta> [y]');
      const args: Record<string, unknown> = { delta: Number(a) };
      if (b) args['y'] = Number(b);
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MouseScroll, args, opts.json, (d) => {
          const r = d as { delta: number };
          console.log(`✓ 已滚动 ${r.delta} 格`);
        }),
      );
      return;
    }
    case 'drag': {
      const [x1, y1, x2, y2] = positionals;
      if (!x1 || !y1 || !x2 || !y2) {
        fail('用法: nodeagent mouse drag <x1> <y1> <x2> <y2> [--button left|right|middle]');
      }
      const args: Record<string, unknown> = {
        from_x: Number(x1),
        from_y: Number(y1),
        to_x: Number(x2),
        to_y: Number(y2),
      };
      if (opts.button) args['button'] = opts.button;
      if (opts.duration) args['step_delay_ms'] = Number(opts.duration);
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MouseDrag, args, opts.json, (d) => {
          const r = d as { from: { x: number; y: number }; to: { x: number; y: number }; steps: number };
          console.log(
            `✓ 已拖拽 (${r.from.x}, ${r.from.y}) → (${r.to.x}, ${r.to.y})，${r.steps} 步`,
          );
        }),
      );
      return;
    }
    default:
      fail('用法: nodeagent mouse <move|click|scroll> ...');
  }
}

export async function cmdKey(action: string | undefined, positionals: string[], opts: Options): Promise<void> {
  switch (action) {
    case 'type': {
      const text = positionals.join(' ');
      if (!text) fail('用法: nodeagent key type "<文本>"');
      const args: Record<string, unknown> = { text };
      if (opts.interval) args['interval_ms'] = Number(opts.interval);
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.KeyType, args, opts.json, (d) => {
          const r = d as { length: number };
          console.log(`✓ 已输入 ${r.length} 个字符`);
        }),
      );
      return;
    }
    case 'press': {
      // v1.5.0：三种用法（一次一种）
      //   nodeagent key press "ctrl+shift+esc"     字符串热键
      //   nodeagent key press copy                 预设名
      //   nodeagent key press ctrl c               老形式（空格分隔的各键）
      if (positionals.length === 0) fail('用法: nodeagent key press "<热键>" | <预设名> | <键1> [键2] ...（如 "ctrl+shift+esc" / copy / ctrl c）');
      const args: Record<string, unknown> = {};
      let positionalsEcho = positionals;
      if (positionals.length === 1) {
        const one = positionals[0]!;
        // 含分隔符 → 字符串热键；不含但命中预设表 → 预设；都不中 → 单键（也当热键交给被控端解析）
        const spec = HOTKEY_PRESETS[one.trim().toLowerCase()];
        if (spec) {
          args['preset'] = one.trim().toLowerCase();
        } else {
          args['hotkey'] = one;
        }
      } else {
        args['keys'] = positionals;
      }
      // 老形式说明：位置参数以空格分隔 → 兼容"ctrl c"（无 + 号）
      if (opts.interval) args['interval_ms'] = Number(opts.interval);
      // v1.5.0 新增可选参数
      if (opts.hold) args['hold_ms'] = Number(opts.hold);
      if (opts.route) args['route'] = opts.route;
      // 媒体键可定向到指定进程（播放器常建 30+ 辅助窗口，只投主窗口往往无效）
      if (opts.pid) args['target_pid'] = Number(opts.pid);
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.KeyPress, args, opts.json, (d) => {
          // 被控端返回 { pressed, chords, times }，**没有 keys 字段**
          // （真机 2026-10-04 实测：原先直接读 r.keys.join() 会抛
          //   "Cannot read properties of undefined (reading 'join')"）
          // 故优先用请求参数回显，缺失时再退回 chords 展开。
          const r = d as {
            keys?: string[]; chords?: string[][]; times?: number; via?: string;
            presets?: string[]; channel?: string; route?: string; sent_windows?: number;
            target_pid?: number | null; note?: string;
          };
          const shown = (r.chords ?? []).map((ch) => ch.join('+')).join(' → ');
          const label = r.keys?.length
            ? r.keys.join('+')
            : shown || positionalsEcho.join('+');
          const times = r.times && r.times > 1 ? `（重复 ${r.times} 次）` : '';
          const presetEcho = r.presets?.length ? `（预设 ${r.presets.join('→')} = ${shown}）` : '';
          const via =
            r.channel === 'appcommand'
              ? `（媒体通道${r.target_pid ? ` → pid ${r.target_pid}` : ' · 广播'}）`
              : r.channel === 'postmessage'
                ? `（后台投递 → pid ${r.target_pid}，命中 ${r.sent_windows ?? 0} 窗口）`
                : '';
          console.log(`✓ 已按下 ${label}${times}${presetEcho}${via}`);
          if (r.note) console.log(`  ℹ️ ${r.note}`);
        }),
      );
      return;
    }
    default:
      fail('用法: nodeagent key <type|press> ...');
  }
}

// ---------- v1.6.0 等待条件（gui.await） ----------

/**
 * 等待一个条件成立再返回（只读低危）。
 *
 *   nodeagent await --condition control --text "完成" --timeout 30000
 *   nodeagent await --condition window --title "安装程序"
 *   nodeagent await --condition process --process setup.exe
 *   nodeagent await --condition file --path "C:\\log.txt" --state absent
 *
 * 四类条件各自复用 window.list / screen.find / process.list / fs.stat，
 * 平台行为与那些能力一致。超时是**正常返回**（satisfied:false + note），不抛异常。
 */
export async function cmdAwait(opts: Options): Promise<void> {
  const condition = opts.condition as string | undefined;
  if (!condition) {
    fail('用法: nodeagent await --condition <window|control|process|file> --timeout <ms> [--text/--title/--process/--path] [--state absent]');
  }
  const args: Record<string, unknown> = { condition };
  // v2.0.0：where / any_of 是 JSON 字符串（属性谓词与组合条件不便用命令行开关表达）
  for (const k of ['where', 'any_of']) {
    const raw = (opts as unknown as Record<string, string | undefined>)[k];
    if (raw !== undefined) {
      try {
        args[k] = JSON.parse(raw);
      } catch {
        fail(`--${k} 不是合法 JSON: ${raw.slice(0, 60)}`);
      }
    }
  }
  if (opts.text !== undefined) args['text'] = opts.text;
  if (opts.title !== undefined) args['title'] = opts.title;
  if (opts.process !== undefined) args['process'] = opts.process;
  if (opts.path !== undefined) args['path'] = opts.path;
  if (opts.state !== undefined) args['state'] = opts.state;
  if (opts.timeoutMs !== undefined) args['timeout_ms'] = Number(opts.timeoutMs);
  if (opts.interval !== undefined) args['interval_ms'] = Number(opts.interval);
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.GuiAwait, args, opts.json, (d) => {
      const r = d as {
        satisfied: boolean; condition: string; state: string;
        elapsed_ms: number; attempts: number; last_seen: string; last_error?: string; note?: string;
      };
      const mark = r.satisfied ? '✓' : '✗';
      const label = r.condition === 'control' ? String(args['text'] ?? '')
        : r.condition === 'window' ? String(args['title'] ?? '')
        : r.condition === 'process' ? String(args['process'] ?? '')
        : String(args['path'] ?? '');
      console.log(
        `${mark} ${r.state === 'absent' ? '已消失' : '已出现'}: ${r.condition} ${label}` +
          `（${r.elapsed_ms}ms，${r.attempts} 次轮询，末次=${r.last_seen}）`,
      );
      if (r.note) console.log(`  ℹ️ ${r.note}`);
      if (r.last_error) console.log(`  ⚠️ 期间末次异常：${r.last_error.slice(0, 120)}`);
    }),
  );
}

// ---------- v3+ 审计 ----------

/** v11：审计链完整性校验。 */
