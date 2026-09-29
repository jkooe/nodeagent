import type { HubConfig, HubTokenRule } from './config.js';

/**
 * Hub 侧授权（v12 / E3c）。
 *
 * 背景：Hub 原先只有**一个**令牌，任何持有者都能接入任意设备 —— 无法区分
 * 「谁在控制哪台机器」。这里引入**多令牌 + 按设备白/黑名单**：
 *
 *   tokens: [
 *     { value: "master-xxx", name: "owner", allow_nodes: ["*"] },
 *     { value: "ci-xxx",     name: "ci",    allow_nodes: ["win_build_*"] },
 *     { value: "guest-xxx",  name: "guest", allow_nodes: ["*"], deny_nodes: ["win_prod"] }
 *   ]
 *
 * 兼容：顶层 `token` 依旧有效，视为「主令牌」（放行全部设备）。
 *
 * 注意职责边界：Hub 只做**接入过滤**（能否连到某设备）；连上之后的**能力级**授权
 * 仍由被控端 ACL 按 client_id 裁决 —— 两层各自独立，Hub 不参与能力决策。
 */

export interface ResolvedToken {
  name: string;
  allowNodes: string[];
  denyNodes: string[];
  isMaster: boolean;
}

/** 简易 glob（支持 `*`），与协议侧 matchPattern 语义一致但独立实现，避免跨包耦合。 */
export function nodeMatches(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  const escaped = pattern
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

/** 用呈现的令牌解析出身份；不匹配返回 null。 */
export function resolveToken(cfg: HubConfig, presented: string | undefined): ResolvedToken | null {
  if (!presented) return null;

  for (const rule of cfg.tokens ?? []) {
    // 支持前缀式「滚动令牌」：配置值以 * 结尾时按前缀匹配（便于轮换期间的灰度）
    const hit = rule.value.endsWith('*')
      ? presented.startsWith(rule.value.slice(0, -1))
      : presented === rule.value;
    if (hit) return normalizeRule(rule);
  }

  // 向后兼容：顶层 token 视为主令牌
  if (presented === cfg.token) {
    return { name: 'master', allowNodes: ['*'], denyNodes: [], isMaster: true };
  }
  return null;
}

function normalizeRule(rule: HubTokenRule): ResolvedToken {
  return {
    name: rule.name ?? 'unnamed',
    allowNodes: rule.allow_nodes ?? ['*'],
    denyNodes: rule.deny_nodes ?? [],
    isMaster: false,
  };
}

/** 该身份能否访问指定设备（deny 优先 → allow → 默认拒绝）。 */
export function nodeAllowed(token: ResolvedToken, nodeId: string): { allowed: boolean; reason: string } {
  for (const d of token.denyNodes) {
    if (nodeMatches(d, nodeId)) {
      return { allowed: false, reason: `命中设备黑名单 ${d}（令牌 ${token.name}）` };
    }
  }
  for (const a of token.allowNodes) {
    if (nodeMatches(a, nodeId)) {
      return { allowed: true, reason: `命中设备白名单 ${a}` };
    }
  }
  return {
    allowed: false,
    reason: `令牌 ${token.name} 未被授权访问设备 ${nodeId}（白名单: ${token.allowNodes.join(', ') || '空'}）`,
  };
}

/**
 * 被控端注册准入：`node_allowlist` 非空时，只有匹配的 node_id 才能注册。
 * 用于防止他人拿（可能泄露的）令牌把自家节点挂到你的 Hub 上。
 */
export function nodeMayRegister(cfg: HubConfig, nodeId: string): { allowed: boolean; reason: string } {
  const list = cfg.node_allowlist ?? [];
  if (list.length === 0) return { allowed: true, reason: '未配置注册白名单' };
  for (const p of list) {
    if (nodeMatches(p, nodeId)) return { allowed: true, reason: `命中注册白名单 ${p}` };
  }
  return { allowed: false, reason: `设备 ${nodeId} 不在 Hub 注册白名单内` };
}

/** 过滤列表可见性：控制端只应看到自己被授权的设备。 */
export function visibleNodes<T extends { node_id: string }>(token: ResolvedToken, all: T[]): T[] {
  return all.filter((a) => nodeAllowed(token, a.node_id).allowed);
}
