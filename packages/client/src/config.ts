import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 单台被控端的连接配置。 */
export interface NodeProfile {
  host: string;
  port: number;
  tls: boolean;
  /** 跳过自签证书校验（TLS 仍加密，另由 HMAC / 签名鉴权兜底） */
  insecure?: boolean;
  /** psk 模式的预共享密钥 */
  key?: string;
  /** 认证模式；默认 psk */
  auth_mode?: 'psk' | 'ed25519';
  /** 覆盖全局 client_id（同一控制端接入多台时可区分身份） */
  client_id?: string;
  /**
   * v6：经 Hub 中转接入。填写后连接走 `/hub/client`，
   * 并在握手前完成 Hub 配对（Hub 只透传，端到端安全不受影响）。
   */
  hub?: {
    /** Hub 令牌 */
    token: string;
    /** 目标被控端的 node_id */
    node_id: string;
  };
  /** 备注，便于识别 */
  note?: string;
}

/** 控制端配置（存于 ~/.nodeagent/config.json），支持多设备。 */
export interface ClientConfig {
  /** 控制端身份标识（对多台设备通用） */
  client_id: string;
  /** 当前默认设备名 */
  current: string;
  /** 设备表：设备名 → 连接配置 */
  nodes: Record<string, NodeProfile>;
  /**
   * v12 / E3：设备分组（组名 → 设备名数组）。
   * 便于按用途批量下发：`nodeagent fanout system.info --nodes @办公机`
   * 也支持在组名内引用其它组（最多展开 3 层，避免环）。
   */
  groups?: Record<string, string[]>;
}

/**
 * 展开设备选择器：`@组名` 展开为组内设备名（支持嵌套与去重），
 * 普通名字原样保留。未知名字保留原样，交由调用方报「设备不存在」。
 */
export function resolveNodeSelector(
  cfg: ClientConfig,
  selector: string[],
): { nodes: string[]; resolvedGroups: Record<string, string[]> } {
  const out: string[] = [];
  const resolvedGroups: Record<string, string[]> = {};
  const seen = new Set<string>();

  const expandGroup = (name: string, depth: number): string[] => {
    if (depth > 3) return [];
    const members = cfg.groups?.[name] ?? [];
    const acc: string[] = [];
    for (const m of members) {
      if (m.startsWith('@')) acc.push(...expandGroup(m.slice(1), depth + 1));
      else acc.push(m);
    }
    return acc;
  };

  for (const sel of selector) {
    if (sel.startsWith('@')) {
      const group = sel.slice(1);
      const members = expandGroup(group, 0);
      resolvedGroups[group] = members;
      for (const m of members) {
        if (!seen.has(m)) {
          seen.add(m);
          out.push(m);
        }
      }
    } else if (!seen.has(sel)) {
      seen.add(sel);
      out.push(sel);
    }
  }
  return { nodes: out, resolvedGroups };
}

export interface ResolvedTarget {
  name: string;
  profile: NodeProfile;
  clientId: string;
}

/** 数据目录：优先 NODEAGENT_HOME（跨平台一致），否则 ~/.nodeagent。 */
export function configDir(): string {
  return process.env['NODEAGENT_HOME'] ?? join(homedir(), '.nodeagent');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

/** 把 v1/v2 的单设备扁平配置迁移为多设备结构（幂等、零破坏）。 */
function migrate(raw: Record<string, unknown>): ClientConfig {
  const nodes = raw['nodes'];
  if (nodes && typeof nodes === 'object' && !Array.isArray(nodes)) {
    const cfg = raw as unknown as ClientConfig;
    if (!cfg.current || !cfg.nodes[cfg.current]) cfg.current = Object.keys(cfg.nodes)[0] ?? '';
    if (!cfg.client_id) cfg.client_id = 'mac_01';
    return cfg;
  }

  // 旧格式：{ client_id, host, port, tls, insecure, key, auth_mode }
  const name = typeof raw['node_name'] === 'string' ? raw['node_name'] : 'default';
  return {
    client_id: typeof raw['client_id'] === 'string' ? raw['client_id'] : 'mac_01',
    current: name,
    nodes: {
      [name]: {
        host: typeof raw['host'] === 'string' ? raw['host'] : '',
        port: typeof raw['port'] === 'number' ? raw['port'] : 8765,
        tls: raw['tls'] !== false,
        insecure: Boolean(raw['insecure']),
        key: typeof raw['key'] === 'string' ? raw['key'] : '',
        auth_mode: raw['auth_mode'] === 'ed25519' ? 'ed25519' : 'psk',
      },
    },
  };
}

export function loadConfig(): ClientConfig | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  // 剥离 UTF-8 BOM（跨平台健壮：某些编辑器 / PowerShell 会写入 BOM）
  const text = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  const raw = JSON.parse(text) as Record<string, unknown>;
  const cfg = migrate(raw);
  const envKey = process.env['NODEAGENT_KEY'];
  const cur = cfg.nodes[cfg.current];
  if (envKey && cur) cur.key = envKey;
  return cfg;
}

export function saveConfig(cfg: ClientConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows 上忽略 */
  }
}

/** 解析生效目标（未指定则取 current）。 */
export function resolveTarget(cfg: ClientConfig, name?: string): ResolvedTarget {
  const target = name ?? cfg.current;
  const profile = cfg.nodes[target];
  if (!profile) {
    const known = Object.keys(cfg.nodes).join(', ') || '（空）';
    throw new Error(`未配置的设备: ${target}；已配置：${known}`);
  }
  return { name: target, profile, clientId: profile.client_id ?? cfg.client_id };
}

/** 解析连接目标为 WebSocket URL（经 Hub 时附上 /hub/client 路径）。 */
export function toWsUrl(profile: { host: string; port: number; tls: boolean; hub?: unknown }): string {
  const scheme = profile.tls ? 'wss' : 'ws';
  const path = profile.hub ? '/hub/client' : '';
  return `${scheme}://${profile.host}:${profile.port}${path}`;
}

export function emptyConfig(clientId = 'mac_01'): ClientConfig {
  return { client_id: clientId, current: '', nodes: {} };
}
