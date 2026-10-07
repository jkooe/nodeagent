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
      // v1.7：属性谓词（仅 UIA 引擎生效）。有 where 时允许不传 text ——
      // 「等一个 enabled 的按钮」比「等一个叫某名字的按钮」更贴近真实意图。
      const where = args['where'];
      if (where !== undefined) {
        if (typeof where !== 'object' || where === null || Array.isArray(where)) {
          throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'where 必须是对象，如 {"enabled":true}');
        }
        const allowed = ['enabled', 'selected', 'value', 'toggle'];
        const bad = Object.keys(where as Record<string, unknown>).filter((k) => !allowed.includes(k));
        if (bad.length > 0) {
          throw new CapabilityError(ErrorCodes.PARAM_INVALID, `where 只支持 ${allowed.join('/')}`, { got: bad });
        }
        inner['where'] = where;
      }
      if (inner['text'] === undefined && where === undefined) {
        throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'control 条件需要 text 或 where 之一');
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

/**
 * v1.7 组合条件：`any_of: [ {...}, {...} ]`，任一命中原句即算命中。
 *
 * 为什么只做 any_of 不做 and/or/not  generalize：真实场景里"弹窗出现 **且**
 * 其中某按钮 enabled"用 any_of(弹窗) + where(按钮 enabled) 两步就能表达，
 * 而通用布尔表达式会把 schema 与求值都复杂化，收益不成比例。
 * 若真需要"两个都必须成立"，上层连调两次 await 更直白。
 */
function buildAnyOf(args: Args): Array<{ condition: Condition; inner: Args; label: string }> {
  const raw = args['any_of'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'any_of 需为非空数组，每项为一个条件对象');
  }
  if (raw.length > 8) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'any_of 最多 8 个条件', { got: raw.length });
  }
  return raw.map((item, i) => {
    const obj = item as Record<string, unknown>;
    const condition = obj['condition'] as Condition | undefined;
    if (!condition || !CONDITIONS.includes(condition)) {
      throw new CapabilityError(ErrorCodes.PARAM_INVALID, `any_of[${i}].condition 不支持: ${String(condition)}`, {
        allowed: CONDITIONS,
      });
    }
    // 每项复用主条件的构造逻辑（同等校验），顶层键名直接透传
    const inner = buildInnerArgs(condition, obj);
    const label =
      condition === 'control' ? String(obj['text'] ?? JSON.stringify(obj['where'] ?? ''))
      : condition === 'window' ? String(obj['title'] ?? obj['pattern'] ?? '')
      : condition === 'process' ? String(obj['process'] ?? '')
      : String(obj['path'] ?? '');
    return { condition, inner, label };
  });
}

export async function guiAwait(args: Args): Promise<unknown> {
  // v1.7：有 any_of 时**不要求**顶层 condition（语义就是"这组条件任一命中"），
  // 校验顺序也因此调整为 any_of 先行 —— 否则会先撞上"condition 缺失"的报错。
  const condition = args['condition'] as Condition | undefined;
  if (!args['any_of'] && (!condition || !CONDITIONS.includes(condition))) {
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

  const startedAt = Date.now();
  let attempts = 0;
  let lastHit = false;
  let lastError: string | null = null;

  // v1.7：组合条件走单独路径（任一命中即算），失败语义与单条完全一致
  const anyOf = args['any_of'] !== undefined ? buildAnyOf(args) : null;
  if (anyOf) {
    for (;;) {
      attempts += 1;
      let hitLabel: string | null = null;
      lastError = null;
      for (const c of anyOf) {
        try {
          const r = await innerProbe(c.condition)(c.inner);
          if (isHit(r)) { hitLabel = c.label; break; }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      const satisfied = (state === 'present' ? hitLabel !== null : hitLabel === null) as boolean;
      if (satisfied) {
        return {
          satisfied: true,
          condition: 'any_of',
          state,
          elapsed_ms: Date.now() - startedAt,
          attempts,
          last_seen: state,
          hit: hitLabel ?? undefined,
          note: hitLabel ? `命中：${hitLabel}` : '所有子条件均已消失',
        };
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return {
          satisfied: false,
          condition: 'any_of',
          state,
          elapsed_ms: Date.now() - startedAt,
          attempts,
          last_seen: lastHit ? 'present' : 'absent',
          last_error: lastError ?? undefined,
          note: `等待 ${timeoutMs}ms，${anyOf.length} 个条件均未${state === 'present' ? '命中' : '消失'}`,
        };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // 能走到这里说明没走 any_of 分支，而进入函数时的校验已保证 condition 合法；
  // TS 无法跨分支收窄，这里显式断言一次（buildInnerArgs / innerProbe 内部还会各自校验）。
  const single = condition as Condition;
  const innerArgs = buildInnerArgs(single, args);
  const probe = innerProbe(single);

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
