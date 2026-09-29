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
  /** v11：来源 IP 白名单（CIDR 或单 IP；非空即生效，不匹配则拒绝） */
  allow_cidr?: string[];
  /** v11：来源 IP 黑名单 */
  deny_cidr?: string[];
  /** v11：生效时段（本地时间；不配置即全天可用） */
  allow_window?: TimeWindow;
  /** v11：按能力覆盖限速，如 { "fs.*": 30, "system.shell.exec": 5 } */
  rate_limits?: Record<string, number>;
  /** 可选：备注 */
  note?: string;
}

/** 生效时段：星期（1=周一…7=周日）+ 时间区间（跨零点自动识别，如 22:00→06:00） */
export interface TimeWindow {
  days?: number[];
  from?: string;
  to?: string;
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

// ---------- v11：来源 IP 管控 ----------

/**
 * 规范化对端地址。
 * 实测坑：Node 的 `socket.remoteAddress` 在双栈监听下给出 **IPv4-mapped IPv6**
 * （`::ffff:192.168.1.100`），直接 `split(':')[0]` 会得到空串导致 CIDR 判断永远不匹配。
 */
export function normalizeIp(remote: string | undefined | null): string {
  if (!remote) return '';
  let ip = remote.trim();
  // IPv4-mapped IPv6 → IPv4
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  // [IPv6]:port 或 IPv6（含冒号）保持原样
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1]!;
  // 纯 IPv4:port → 去掉端口
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (v4port) ip = v4port[1]!;
  return ip;
}

/** 单 IP 或 CIDR 匹配（支持 IPv4；`0.0.0.0/0` 匹配全部）。 */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const target = cidr.includes('/') ? cidr : `${cidr}/32`;
  const [net, bitsRaw] = target.split('/');
  const bits = Number(bitsRaw);
  if (!net || !Number.isFinite(bits)) return false;
  // 仅处理 IPv4（IPv6 或主机名直接不匹配，避免误放行）
  const toInt = (s: string): number | null => {
    const parts = s.split('.');
    if (parts.length !== 4) return null;
    let v = 0;
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      v = v * 256 + n;
    }
    return v;
  };
  const a = toInt(ip);
  const b = toInt(net);
  if (a === null || b === null) return false;
  if (bits <= 0) return true;
  if (bits > 32) return false;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** 判断来源 IP 是否被允许（deny 优先）。未配置任何 CIDR 规则时放行。 */
export function ipAllowed(client: AclClient, ip: string): { allowed: boolean; reason: string } {
  for (const c of client.deny_cidr ?? []) {
    if (ipMatchesCidr(ip, c)) return { allowed: false, reason: `来源 IP ${ip} 命中黑名单 ${c}` };
  }
  const allow = client.allow_cidr ?? [];
  if (allow.length === 0) return { allowed: true, reason: '未配置 IP 白名单' };
  for (const c of allow) {
    if (ipMatchesCidr(ip, c)) return { allowed: true, reason: `来源 IP ${ip} 命中白名单 ${c}` };
  }
  return { allowed: false, reason: `来源 IP ${ip} 不在白名单内` };
}

// ---------- v11：生效时段 ----------

const MINUTES_OF_DAY = 24 * 60;

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 判断当前时刻是否在生效时段内。未配置则始终生效；跨零点区间（如 22:00→06:00）正确识别。 */
export function inTimeWindow(win: TimeWindow | undefined, at: Date): { allowed: boolean; reason: string } {
  if (!win) return { allowed: true, reason: '未配置生效时段' };
  const days = win.days ?? [];
  if (days.length > 0) {
    const isoDay = at.getDay() === 0 ? 7 : at.getDay(); // 1=周一 … 7=周日
    if (!days.includes(isoDay)) {
      return { allowed: false, reason: `当前星期(${isoDay})不在允许范围 ${days.join(',')}` };
    }
  }
  if (win.from && win.to) {
    const from = parseHHMM(win.from);
    const to = parseHHMM(win.to);
    if (from === null || to === null) return { allowed: false, reason: '生效时段格式非法（应为 HH:MM）' };
    const now = at.getHours() * 60 + at.getMinutes();
    const inRange =
      from <= to
        ? now >= from && now <= to
        : now >= from || now <= to; // 跨零点
    if (!inRange) {
      return { allowed: false, reason: `当前时间 ${win.from}→${win.to} 之外` };
    }
  }
  void MINUTES_OF_DAY;
  return { allowed: true, reason: '在生效时段内' };
}

// ---------- v11：按能力限速 ----------

/**
 * 计算某能力的限速上限：
 * rate_limits 中按「精确匹配优先、其次 glob」取第一条命中的值；未命中则回退 max_calls_per_min。
 * 返回 0/undefined 表示不限速。
 */
export function rateLimitFor(client: AclClient, capability: string): number | undefined {
  const rules = client.rate_limits ?? {};
  if (rules[capability] !== undefined) return rules[capability];
  for (const [pattern, limit] of Object.entries(rules)) {
    if (pattern.includes('*') && matchPattern(pattern, capability)) return limit;
  }
  return client.max_calls_per_min;
}

