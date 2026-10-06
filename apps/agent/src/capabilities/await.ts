/**
 * gui.await —— 等待条件成立（v1.6）。
 *
 * ## 为什么需要它（复盘三大短板之「语义」）
 * 原来的 GUI 操作是**盲试**：按一下、截个图、看看有没有变化，不行再试。
 * 问题不是"找不到元素"（screen.find 已解决），而是**操作之后无法断言界面到了预期状态**。
 * 有了本能力，"点了安装 → 等待『完成』按钮出现" 从"睡 3 秒碰运气"变成**可验证的等待**：
 *
 *   await control(text:"完成", timeout:30s) → click(found) → await absent(text:"安装中")
 *
 * ## 实现要点
 * 不写任何新的平台探测代码 —— 四个条件全部**复用既有能力**（window.list /
 * screen.find / process.list / fs.stat），因此 Windows/macOS 行为与它们完全一致。
 * 轮询期间异常一律视为"尚未命中"并记录 last_error，避免单次抖动整句失败；
 * 但超时未命中时会把它带回，方便判断是"真的没有"还是"每次都在报错"。
 */

import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { windowList } from './window.js';
import { screenFind } from './window.js';
import { processList } from './system.js';
import { fsStat } from './fs.js';

type Args = Record<string, unknown>;

type Condition = 'window' | 'control' | 'process' | 'file';

const CONDITIONS: readonly Condition[] = ['window', 'control', 'process', 'file'];

/** 判断一次底层调用是否"命中"（兼容各能力不同的返回形态）。 */
function isHit(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result === 'boolean') return result;
  const r = result as Record<string, unknown>;
  if (r['found'] === true) return true;
  if (r['exists'] === true) return true;
  for (const key of ['windows', 'processes', 'matches', 'elements']) {
    const arr = r[key];
    if (Array.isArray(arr) && arr.length > 0) return true;
  }
  if (Array.isArray(result) && result.length > 0) return true;
  return false;
}

/** 按条件组装底层调用的参数（只透传该条件支持的字段）。 */
function buildInnerArgs(condition: Condition, args: Args): Args {
  const num = (k: string): number | undefined => {
    const v = args[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  switch (condition) {
    case 'window': {
      const inner: Args = {};
      const title = (args['title'] as string | undefined) ?? (args['pattern'] as string | undefined);
      if (title) inner['title_pattern'] = title;
      const limit = num('limit');
      if (limit !== undefined) inner['limit'] = limit;
      return inner;
    }
    case 'control': {
      // 透传 screen.find 的全部相关参数（method=image 时也一样走轮询）
      const inner: Args = {};
      for (const k of ['text', 'window', 'control_type', 'method', 'template', 'limit', 'timeout_ms']) {
        if (args[k] !== undefined) inner[k] = args[k];
      }
      return inner;
    }
    case 'process': {
      const inner: Args = {};
      const name = args['process'] as string | undefined;
      if (name) inner['filter'] = { name_pattern: name };
      const limit = num('limit');
      if (limit !== undefined) inner['limit'] = limit;
      return inner;
    }
    case 'file': {
      const p = args['path'] as string | undefined;
      if (!p) {
        throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'condition=file 需要 path', {
          hint: '如 {"condition":"file","path":"C:\\\\Windows\\\\Temp\\\\setup.log"}',
        });
      }
      return { path: p };
    }
  }
}

/** 条件 → 底层能力（本进程内直接调用，省去 RPC 往返开销）。 */
function innerProbe(condition: Condition): (args: Args) => Promise<unknown> {
  switch (condition) {
    case 'window':
      return (a) => windowList(a);
    case 'control':
      return (a) => screenFind(a);
    case 'process':
      return (a) => processList(a);
    case 'file':
      return (a) => fsStat(a);
  }
}

export async function guiAwait(args: Args): Promise<unknown> {
  const condition = args['condition'] as Condition | undefined;
  if (!condition || !CONDITIONS.includes(condition)) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `不支持的 condition: ${String(condition)}`, {
      allowed: CONDITIONS,
      hint: 'window=等窗口出现/消失；control=等界面元素；process=等进程；file=等文件',
    });
  }
  const state = (args['state'] as string | undefined) ?? 'present';
  if (state !== 'present' && state !== 'absent') {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `不支持的 state: ${state}`, {
      allowed: ['present', 'absent'],
    });
  }
  const timeoutMs = Math.max(0, Math.min(60_000, (args['timeout_ms'] as number | undefined) ?? 5000));
  const intervalMs = Math.max(50, Math.min(5000, (args['interval_ms'] as number | undefined) ?? 400));

  const innerArgs = buildInnerArgs(condition, args);
  const probe = innerProbe(condition);

  const startedAt = Date.now();
  let attempts = 0;
  let lastHit = false;
  let lastError: string | null = null;

  for (;;) {
    attempts += 1;
    try {
      const result = await probe(innerArgs);
      lastHit = isHit(result);
      lastError = null;
    } catch (err) {
      // 轮询期异常不代表条件不成立（可能正忙于启动）——记下再试
      lastError = err instanceof Error ? err.message : String(err);
      lastHit = false;
    }
    const satisfied = state === 'present' ? lastHit : !lastHit;
    if (satisfied) {
      return {
        satisfied: true,
        condition,
        state,
        elapsed_ms: Date.now() - startedAt,
        attempts,
        last_seen: state,
        note:
          state === 'absent'
            ? '条件已消失（连续一次未命中即视为消失；如需更稳可加大 interval_ms）'
            : undefined,
      };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return {
        satisfied: false,
        condition,
        state,
        elapsed_ms: Date.now() - startedAt,
        attempts,
        last_seen: lastHit ? 'present' : 'absent',
        last_error: lastError ?? undefined,
        note:
          state === 'present'
            ? `等待 ${timeoutMs}ms 仍未出现${lastError ? `，期间持续报错：${lastError.slice(0, 160)}` : ''}`
            : `等待 ${timeoutMs}ms 仍未消失${lastError ? `，期间持续报错：${lastError.slice(0, 160)}` : ''}`,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
