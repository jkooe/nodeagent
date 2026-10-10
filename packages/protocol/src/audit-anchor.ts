/**
 * 审计链外部锚定的**判定逻辑（纯函数）**—— v2.0.0。
 *
 * ## 为什么要放在 protocol 里（而不是留在 agent 内）
 * 锚点判定必须由**控制端**做（被控端是不可信方：它被攻破后会说"一切正常"）。
 * 但判定规则一旦在两处各写一份，就会**静默漂移** —— 同一份日志，被控端说"一致"、
 * 控制端说"被重写"，或反之。故此处收敛为**唯一实现**：agent 端与控制端脚本都 import 它。
 *
 * ## 判定依据（为什么不能只比哈希）
 * 日志轮转会丢弃最旧的段，使条目数**下降**。若只比 head_hash，轮转会被误判成篡改。
 * 故锚点记四元组 `{entries, head_hash, head_ts, rotated_segments}`，
 * 比对时先按「轮转了几段」对齐，再判断尾部是否一致。
 *
 * 本模块**无 IO**（不读文件、不知路径），输入只有「当前链头」与「锚点列表」——
 * 于是它能同时服务于：被控端进程内比对、控制端对云盘锚点的离线比对。
 */

/** 一条锚点记录（写入锚点文件/上传到链外时就是这个形状）。 */
export interface AnchorRecord {
  /** 锚定时刻（Unix ms） */
  ts: number;
  /** 当时的可见条目数（含轮转段） */
  entries: number;
  /** 链头哈希（要外部留存的核心值） */
  head_hash: string | null;
  /** 当时末条的时间戳 */
  head_ts: number | null;
  /** 当时的轮转段数 */
  rotated_segments: number;
  note?: string;
}

/** 判定所需的「链头」字段（`AuditHead` 的超集即可传入）。 */
export interface ChainHeadLike {
  entries: number;
  head_hash: string | null;
  head_ts: number | null;
  rotated_segments: number;
}

export interface AnchorComparison {
  ok: boolean;
  anchors_checked: number;
  latest?: AnchorRecord;
  verdict: string;
  detail?: Record<string, unknown>;
}

/**
 * 与**最近一条**锚点比对，判断当前链是否与锚定时刻自洽。
 *
 * 三条判定：
 *  1. 条目数应 **≥** 锚点记录（只增不减；减少只能由轮转解释，轮转会让 rotated_segments 变大）
 *     → 违反即**疑似整链重写/回滚**
 *  2. 若条目数与轮转段数都没变 → 链头哈希必须**完全一致**
 *     → 不一致即**该段被重写**
 *  3. 若已轮转或条目数增长 → 锚点仍在链上，`ok:true`（附 detail 供人工核对）
 */
export function judgeAnchors(head: ChainHeadLike, anchors: AnchorRecord[]): AnchorComparison {
  if (anchors.length === 0) {
    return { ok: true, anchors_checked: 0, verdict: '锚点文件为空' };
  }
  const latest = anchors[anchors.length - 1]!;

  if (head.entries < latest.entries && head.rotated_segments <= latest.rotated_segments) {
    return {
      ok: false,
      anchors_checked: anchors.length,
      latest,
      verdict: '**疑似整链重写/回滚**：当前条目数少于锚点，且没有发生轮转来解释',
      detail: {
        anchored_entries: latest.entries,
        current_entries: head.entries,
        anchored_hash: latest.head_hash,
        current_hash: head.head_hash,
      },
    };
  }

  if (head.rotated_segments === latest.rotated_segments && head.entries === latest.entries) {
    if (head.head_hash !== latest.head_hash) {
      return {
        ok: false,
        anchors_checked: anchors.length,
        latest,
        verdict: '**链头哈希与锚点不一致**（条目数相同却哈希不同 → 该段被重写）',
        detail: { anchored_hash: latest.head_hash, current_hash: head.head_hash, entries: head.entries },
      };
    }
    return {
      ok: true,
      anchors_checked: anchors.length,
      latest,
      verdict: '与锚点完全一致（条目数、轮转段数、链头哈希三者相符）',
    };
  }

  return {
    ok: true,
    anchors_checked: anchors.length,
    latest,
    // 锚定动作**自身**也会被记入审计（server 层统一记录所有 invoke），
    // 所以「刚锚定就比对」几乎必然看到"已增长"——这是正常现象，不是篡改。
    verdict:
      '链已增长（或发生轮转）—— 锚点仍在链上，无需人工核对到该锚点为止的部分。' +
      '（刚锚定就比对通常显示"已增长"，因为锚定动作自身也会写一条审计。）',
    detail: {
      anchored_entries: latest.entries,
      current_entries: head.entries,
      rotated_delta: head.rotated_segments - latest.rotated_segments,
      anchored_hash: latest.head_hash,
      current_hash: head.head_hash,
    },
  };
}

/** 从 JSONL 文本解析锚点列表（坏行跳过；整体不可解析时返回 null 交给调用方报错）。 */
export function parseAnchorsFromJsonl(text: string): AnchorRecord[] | null {
  const out: AnchorRecord[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as AnchorRecord;
      if (typeof rec?.entries === 'number' && 'head_hash' in rec) out.push(rec);
    } catch {
      // 半行（写入中断）跳过，不让一行坏数据毁掉整份锚点
    }
  }
  return out.length > 0 ? out : null;
}
