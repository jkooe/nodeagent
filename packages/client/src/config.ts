import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 控制端配置（存于 ~/.nodeagent/config.json）。 */
export interface ClientConfig {
  client_id: string;
  host: string;
  port: number;
  tls: boolean;
  /** v1 简化：跳过自签证书校验（TLS 仍加密，另由 HMAC/签名鉴权兜底） */
  insecure?: boolean;
  /** v1 简化：预共享密钥存于 600 权限文件；v2 升级 OS 密钥链 */
  key: string;
  /** v3：认证模式；`psk`（默认）或 `ed25519`（私钥存于 keys/ed25519.json） */
  auth_mode?: 'psk' | 'ed25519';
}

/** 数据目录：优先 NODEAGENT_HOME（跨平台一致），否则 ~/.nodeagent。 */
export function configDir(): string {
  return process.env['NODEAGENT_HOME'] ?? join(homedir(), '.nodeagent');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function loadConfig(): ClientConfig | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  const cfg = JSON.parse(readFileSync(p, 'utf8')) as ClientConfig;
  const envKey = process.env['NODEAGENT_KEY'];
  if (envKey) cfg.key = envKey;
  return cfg;
}

export function saveConfig(cfg: ClientConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows 上忽略 */
  }
}

/** 解析连接目标为 WebSocket URL。 */
export function toWsUrl(cfg: Pick<ClientConfig, 'host' | 'port' | 'tls'>): string {
  const scheme = cfg.tls ? 'wss' : 'ws';
  return `${scheme}://${cfg.host}:${cfg.port}`;
}
