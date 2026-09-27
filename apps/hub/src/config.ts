import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
