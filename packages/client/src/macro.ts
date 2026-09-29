import { readFileSync } from 'node:fs';
import { CapabilityNames } from '@nodeagent/protocol';
import type { NodeAgentClient } from './client.js';

/**
 * GUI 宏引擎（v12 / E4）。
 *
 * 设计取向：**“录制”由 AI 来完成** —— 它把一次成功的人工/自动操作固化成步骤列表，
 * 之后任何人（或定时任务）都能按同一步骤重放。这样比 hook 全局输入更可控、可读、可审。
 *
 * 步骤类型（step.action）：
 *   focus    —— 聚焦窗口（title 正则），失败可重试
 *   find     —— 定位元素（text + method），拿到坐标；可选 click/双击
 *   click    —— 直接按坐标点击（需 x/y）
 *   type     —— 输入文本
 *   key      —— 按键/组合键/序列（keys 或 sequence，可 repeat）
 *   drag     —— 拖拽（from/to）
 *   sleep    —— 等待毫秒
 *   exec     —— 在被控端执行命令（结果可断言 exit_code/包含文本）
 *   clip     —— 读写剪贴板（set/get）
 *   capture  —— 截屏存到本地（用于每步留证）
 *   assert   —— 断言：屏幕/窗口/剪贴板包含某文本（按 kind 选择）
 *
 * 通用字段：retry（失败重试次数，默认 0）、interval_ms（重试间隔）、optional（失败不中断）、
 *          continue_on_error（同 optional，语义更直白）。
 */

export interface MacroStep {
  action: string;
  [key: string]: unknown;
}

export interface MacroFile {
  name?: string;
  description?: string;
  /** 每步之间默认等待（可被 step.sleep 或 step.delay_ms 覆盖） */
  default_delay_ms?: number;
  steps: MacroStep[];
}

export interface StepResult {
  index: number;
  action: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface MacroRunResult {
  ok: boolean;
  name: string;
  steps: StepResult[];
  failed_at?: number;
}

export function loadMacroFile(path: string): MacroFile {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as MacroFile;
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('宏文件缺少 steps 数组');
  }
  return parsed;
}

/** 变量替换：${name} 或 ${name:-默认值}。 */
function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, key: string, def?: string) => {
      const v = vars[key];
      if (v !== undefined) return v;
      if (def !== undefined) return def;
      throw new Error(`变量未提供: ${key}`);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v, vars);
    return out;
  }
  return value;
}

export interface MacroContext {
  client: NodeAgentClient;
  /** 截屏落盘回调（由 CLI 提供，MCP 可省略） */
  saveCapture?: (name: string, base64: string) => string;
  log?: (msg: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function invoke(client: NodeAgentClient, capability: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  const r = await client.invoke(capability, args, timeoutMs);
  if (r.status === 'failed') {
    throw new Error(`${r.error?.name ?? 'E_EXECUTION_FAILED'}: ${r.error?.message ?? '调用失败'}`);
  }
  return r.data;
}

/** 执行单步（不含重试逻辑）。 */
async function runStep(ctx: MacroContext, step: MacroStep): Promise<string> {
  const c = ctx.client;
  const action = String(step['action'] ?? '');
  switch (action) {
    case 'focus': {
      const title = String(step['title'] ?? '');
      if (!title) throw new Error('focus 需要 title');
      const d = (await invoke(c, CapabilityNames.WindowFocus, {
        title,
        ...(step['wait_ms'] !== undefined ? { wait_ms: step['wait_ms'] } : {}),
      }, Number(step['timeout_ms'] ?? 60_000))) as { title?: string; x: number; y: number; width: number; height: number; activated_by?: string };
      return `已聚焦「${d.title ?? title}」(${d.x},${d.y} ${d.width}x${d.height})`;
    }
    case 'find': {
      const text = String(step['text'] ?? '');
      if (!text) throw new Error('find 需要 text');
      const args: Record<string, unknown> = { text, limit: Number(step['limit'] ?? 5) };
      if (step['method']) args['method'] = step['method'];
      if (step['window']) args['window'] = step['window'];
      if (step['control_type']) args['control_type'] = step['control_type'];
      // v12.2：等待语义（界面有加载/动画时必备，避免假失败）
      if (step['wait_ms'] !== undefined) args['wait_ms'] = step['wait_ms'];
      if (step['interval_ms'] !== undefined) args['interval_ms'] = step['interval_ms'];
      const d = (await invoke(c, CapabilityNames.ScreenFind, args, 120_000)) as {
        engine: string;
        matches: Array<{ name: string; x: number; y: number }>;
        waited_ms?: number;
      };
      if (d.matches.length === 0) throw new Error(`未找到「${text}」（引擎 ${d.engine}）`);
      const m = d.matches[0]!;
      const waited = d.waited_ms && d.waited_ms > 800 ? `（等待 ${d.waited_ms}ms）` : '';
      const detail = `命中「${m.name}」@(${m.x},${m.y}) via ${d.engine}${waited}`;
      if (step['click'] === true || step['dblclick'] === true) {
        await invoke(c, CapabilityNames.MouseClick, {
          x: m.x,
          y: m.y,
          ...(step['dblclick'] === true ? { count: 2 } : {}),
        });
        return `${detail} → 已点击`;
      }
      return detail;
    }
    case 'click': {
      const x = Number(step['x']);
      const y = Number(step['y']);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click 需要 x/y');
      await invoke(c, CapabilityNames.MouseClick, {
        x,
        y,
        ...(step['count'] ? { count: step['count'] } : {}),
        ...(step['button'] ? { button: step['button'] } : {}),
      });
      return `已点击 (${x},${y})`;
    }
    case 'type': {
      const text = String(step['text'] ?? '');
      await invoke(c, CapabilityNames.KeyType, { text, ...(step['interval_ms'] ? { interval_ms: step['interval_ms'] } : {}) });
      return `已输入 ${text.length} 字符`;
    }
    case 'key': {
      const args: Record<string, unknown> = {};
      if (Array.isArray(step['keys'])) args['keys'] = step['keys'];
      if (Array.isArray(step['sequence'])) args['sequence'] = step['sequence'];
      if (step['repeat']) args['repeat'] = step['repeat'];
      if (step['interval_ms']) args['interval_ms'] = step['interval_ms'];
      if (!args['keys'] && !args['sequence']) throw new Error('key 需要 keys 或 sequence');
      const d = (await invoke(c, CapabilityNames.KeyPress, args)) as { times?: number };
      return `已按键 ×${d.times ?? 1}`;
    }
    case 'drag': {
      const need = ['from_x', 'from_y', 'to_x', 'to_y'] as const;
      const args: Record<string, unknown> = {};
      for (const k of need) {
        if (step[k] === undefined) throw new Error(`drag 需要 ${need.join('/')}`);
        args[k] = Number(step[k]);
      }
      if (step['button']) args['button'] = step['button'];
      await invoke(c, CapabilityNames.MouseDrag, args, 120_000);
      return `已拖拽 (${args['from_x']},${args['from_y']}) → (${args['to_x']},${args['to_y']})`;
    }
    case 'sleep': {
      const ms = Math.max(0, Math.min(600_000, Number(step['ms'] ?? 500)));
      await sleep(ms);
      return `等待 ${ms}ms`;
    }
    case 'exec': {
      const command = String(step['command'] ?? '');
      if (!command) throw new Error('exec 需要 command');
      const d = (await invoke(c, CapabilityNames.ShellExec, {
        command,
        ...(step['timeout_ms'] ? { timeout_ms: step['timeout_ms'] } : {}),
        ...(step['async'] === true ? { async: true } : {}),
      })) as { exit_code?: number; stdout?: string; task_id?: string };
      if (step['expect_exit'] !== undefined && d.exit_code !== Number(step['expect_exit'])) {
        throw new Error(`退出码不符：期望 ${String(step['expect_exit'])}，实际 ${String(d.exit_code)}`);
      }
      if (step['expect_stdout'] !== undefined && !String(d.stdout ?? '').includes(String(step['expect_stdout']))) {
        throw new Error(`输出中未包含「${String(step['expect_stdout'])}」`);
      }
      return d.task_id ? `已启动后台任务 ${d.task_id}` : `退出码 ${String(d.exit_code)}`;
    }
    case 'clip': {
      if (step['set'] !== undefined) {
        await invoke(c, CapabilityNames.ClipSet, { text: String(step['set']) });
        return `已写入剪贴板 ${String(step['set']).length} 字符`;
      }
      const d = (await invoke(c, CapabilityNames.ClipGet, {})) as { text?: string };
      const text = d.text ?? '';
      if (step['expect'] !== undefined && !text.includes(String(step['expect']))) {
        throw new Error(`剪贴板内容不符：期望包含「${String(step['expect'])}」，实际「${text.slice(0, 80)}」`);
      }
      return `剪贴板：${text.slice(0, 60)}`;
    }
    case 'assert': {
      const kind = String(step['kind'] ?? 'screen');
      const expect = String(step['text'] ?? '');
      if (!expect) throw new Error('assert 需要 text');
      if (kind === 'clip') {
        const d = (await invoke(c, CapabilityNames.ClipGet, {})) as { text?: string };
        if (!(d.text ?? '').includes(expect)) throw new Error(`剪贴板不含「${expect}」`);
        return '剪贴板断言通过';
      }
      if (kind === 'window') {
        const d = (await invoke(c, CapabilityNames.WindowList, {
          title_pattern: expect,
          limit: 5,
        })) as { windows: unknown[] };
        if (d.windows.length === 0) throw new Error(`未找到标题匹配「${expect}」的窗口`);
        return `窗口断言通过（${d.windows.length} 个）`;
      }
      // screen：用 screen.find 判定元素是否存在（支持 wait_ms 等待出现）
      const d = (await invoke(c, CapabilityNames.ScreenFind, {
        text: expect,
        method: step['method'] ?? 'auto',
        limit: 1,
        ...(step['wait_ms'] !== undefined ? { wait_ms: step['wait_ms'] } : {}),
        ...(step['interval_ms'] !== undefined ? { interval_ms: step['interval_ms'] } : {}),
      }, 120_000)) as { engine: string; matches: unknown[] };
      if (d.matches.length === 0) throw new Error(`屏幕上未找到「${expect}」（引擎 ${d.engine}）`);
      return `屏幕断言通过（via ${d.engine}）`;
    }
    case 'capture': {
      const d = (await invoke(c, CapabilityNames.ScreenCapture, {
        format: 'jpeg',
        ...(step['scale'] ? { scale: step['scale'] } : {}),
        ...(step['region'] ? { region: step['region'] } : {}),
      })) as { image: string; bytes: number };
      const name = String(step['name'] ?? `step-${Date.now()}.jpg`);
      if (ctx.saveCapture) {
        const p = ctx.saveCapture(name, d.image);
        return `已保存 ${p}（${d.bytes} 字节）`;
      }
      return `已截屏 ${d.bytes} 字节（未落盘）`;
    }
    default:
      throw new Error(`不支持的步骤: ${action}`);
  }
}

/** 执行整个宏（含重试与可选步骤）。 */
export async function runMacro(
  ctx: MacroContext,
  macro: MacroFile,
  vars: Record<string, string> = {},
): Promise<MacroRunResult> {
  const results: StepResult[] = [];
  const defaultDelay = Number(macro.default_delay_ms ?? 0);
  let ok = true;
  let failedAt: number | undefined;

  for (let i = 0; i < macro.steps.length; i += 1) {
    const raw = macro.steps[i]!;
    const action = String(raw['action'] ?? '');
    const optional = raw['optional'] === true || raw['continue_on_error'] === true;

    // 变量替换也要在步骤级容错内：缺变量属于「这一步失败」，不该让整个宏崩掉
    let step: MacroStep;
    try {
      step = substitute(raw, vars) as MacroStep;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        index: i,
        action,
        ok: false,
        ms: 0,
        detail: msg + (optional ? '（optional，继续）' : ''),
      });
      if (!optional) {
        ok = false;
        failedAt = i;
        break;
      }
      continue;
    }

    const retry = Math.max(0, Math.min(10, Number(step['retry'] ?? 0)));
    const interval = Math.max(0, Number(step['interval_ms'] ?? 500));
    const started = Date.now();
    let lastErr = '';

    let attempt = 0;
    let done = false;
    while (attempt <= retry && !done) {
      try {
        const detail = await runStep(ctx, step);
        results.push({ index: i, action, ok: true, ms: Date.now() - started, detail });
        done = true;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        attempt += 1;
        if (attempt <= retry) {
          ctx.log?.(`  步骤 ${i} (${action}) 第 ${attempt} 次失败：${lastErr}，${interval}ms 后重试`);
          await sleep(interval);
        }
      }
    }

    if (!done) {
      results.push({
        index: i,
        action,
        ok: false,
        ms: Date.now() - started,
        detail: lastErr + (optional ? '（optional，继续）' : ''),
      });
      if (!optional) {
        ok = false;
        failedAt = i;
        break;
      }
    }

    if (defaultDelay > 0 && i < macro.steps.length - 1) await sleep(defaultDelay);
  }

  return { ok, name: macro.name ?? 'macro', steps: results, ...(failedAt !== undefined ? { failed_at: failedAt } : {}) };
}
