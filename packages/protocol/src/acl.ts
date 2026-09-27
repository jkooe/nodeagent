/**
 * 能力级访问控制（ACL）。
 *
 * 规则匹配优先级：**deny 优先** → allow → default_effect（默认拒绝）。
 * 这是「零信任」的核心：不假设持密钥者可信，每个能力都要显式授权。
 */

/** 单个调用方的授权规则。 */
export interface AclClient {
  client_id: string;
  /** Base64(SPKI DER) 公钥；ed25519 模式必填 */
  pubkey?: string;
  /** 允许的能力（支持 glob，如 `system.*`） */
  allow: string[];
  /** 显式拒绝的能力（优先级高于 allow） */
  deny?: string[];
  /** 可选：每分钟调用上限 */
  max_calls_per_min?: number;
  /** 可选：备注 */
  note?: string;
}

/** 整机 ACL 策略。 */
export interface AclPolicy {
  /** 无规则匹配时的兜底策略 */
  default_effect: 'deny' | 'allow';
  clients: AclClient[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 极简 glob 匹配：`*` 匹配任意字符，其余精确匹配。 */
export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  const re = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
  return re.test(value);
}

export interface AuthzResult {
  allowed: boolean;
  reason: string;
  matched: 'deny' | 'allow' | 'default';
  pattern?: string;
}

/** 判定「调用方 clientId 能否调用 capability」。 */
export function authorize(policy: AclPolicy, clientId: string, capability: string): AuthzResult {
  const client = policy.clients.find((c) => c.client_id === clientId);
  if (!client) {
    return {
      allowed: policy.default_effect === 'allow',
      reason: `调用方未注册: ${clientId}`,
      matched: 'default',
    };
  }

  for (const d of client.deny ?? []) {
    if (matchPattern(d, capability)) {
      return { allowed: false, reason: `命中 deny 规则`, matched: 'deny', pattern: d };
    }
  }

  for (const a of client.allow) {
    if (matchPattern(a, capability)) {
      return { allowed: true, reason: `命中 allow 规则`, matched: 'allow', pattern: a };
    }
  }

  return {
    allowed: policy.default_effect === 'allow',
    reason: `无规则匹配，按默认策略(${policy.default_effect})处理`,
    matched: 'default',
  };
}

/** 解析能力清单中「被授权」的子集（用于 auth_ok 返回，让调用方知道自己的权限边界）。 */
export function authorizedCapabilities(policy: AclPolicy, clientId: string, all: string[]): string[] {
  return all.filter((cap) => authorize(policy, clientId, cap).allowed);
}
