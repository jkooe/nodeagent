import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Hub 侧访问规则（v12 / E3c）：一个令牌 = 一个控制端身份。
 * `value` 以 `*` 结尾时按**前缀**匹配（便于令牌轮换期间灰度）。
 */
export interface HubTokenRule {
  /** 令牌值（前缀式轮换：以 * 结尾表示前缀匹配） */
  value: string;
  /** 身份名（日志/审计可读） */
  name?: string;
  /** 可访问设备（glob，默认 ["*"]） */
  allow_nodes?: string[];
  /** 禁止访问设备（优先级高于 allow） */
  deny_nodes?: string[];
}

export interface HubConfig {
  node_id: string;
  host: string;
  port: number;
  /** 鉴权令牌：被控端注册、控制端接入均需携带 */
  token: string;
  /**
   * 可选 TLS。生产环境通常由反向代理（Caddy/Nginx）终止 TLS，
   * 故此项默认关闭；如需 Hub 直接提供 TLS，给出 PEM 文件路径即可。
   */
  tls?: { cert_file: string; key_file: string };
  log_level: 'debug' | 'info' | 'warn';
  /**
   * v12 / E3：同一被控端允许的**并发槽位数**（= 可同时接入的控制端数量）。
   * 默认 3：够 AI + 人 + 备用同时在线；设为 1 即退回旧的「独占」语义。
   */
  max_slots_per_node?: number;
  /**
   * v12 / E3c：多控制端令牌（各自独立的设备白/黑名单）。
   * 未配置时退回顶层 `token`（视为主令牌，放行全部设备）。
   */
  tokens?: HubTokenRule[];
  /**
   * v12 / E3c：允许注册的设备白名单（glob）。非空时，未匹配的 node_id 无法注册，
   * 防止他人用泄露的令牌把自家节点挂到你的 Hub 上。
   */
  node_allowlist?: string[];
}

export function hubDir(): string {
  return process.env['NODEAGENT_HOME'] ?? join(homedir(), '.nodeagent');
}

export function hubConfigPath(): string {
  return join(hubDir(), 'hub.json');
}

export function defaultHubConfig(): HubConfig {
  return {
    node_id: 'hub_01',
    host: '0.0.0.0',
    port: 9443,
    token: randomBytes(24).toString('hex'),
    log_level: 'info',
  };
}

export function loadHubConfig(): { config: HubConfig; isNew: boolean } {
  const p = hubConfigPath();
  if (existsSync(p)) {
    return { config: JSON.parse(readFileSync(p, 'utf8')) as HubConfig, isNew: false };
  }
  const config = defaultHubConfig();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { config, isNew: true };
}
