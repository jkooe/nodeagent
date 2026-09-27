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
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
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

/** 解析连接目标为 WebSocket URL。 */
export function toWsUrl(profile: { host: string; port: number; tls: boolean }): string {
  const scheme = profile.tls ? 'wss' : 'ws';
  return `${scheme}://${profile.host}:${profile.port}`;
}

export function emptyConfig(clientId = 'mac_01'): ClientConfig {
  return { client_id: clientId, current: '', nodes: {} };
}
