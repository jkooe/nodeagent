import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateSharedKey } from '@nodeagent/protocol';

export interface AgentConfig {
  node_id: string;
  host: string;
  port: number;
  tls: boolean;
  /** v1 简化：预共享密钥存于 600 权限文件；v2 升级 DPAPI */
  key: string;
  log_level: 'debug' | 'info' | 'warn';
}

/** 数据目录：优先 NODEAGENT_HOME（跨平台一致），否则 ~/.nodeagent。 */
export function agentDir(): string {
  return process.env['NODEAGENT_HOME'] ?? join(homedir(), '.nodeagent');
}

export function agentConfigPath(): string {
  return join(agentDir(), 'agent.json');
}

export function defaultAgentConfig(): AgentConfig {
  return {
    node_id: 'win_01',
    host: '0.0.0.0',
    port: 8765,
    tls: true,
    key: generateSharedKey(),
    log_level: 'info',
  };
}

/** 加载配置；不存在则生成默认配置并落盘（含随机密钥），返回 [config, isNew]。 */
export function loadAgentConfig(): { config: AgentConfig; isNew: boolean } {
  const p = agentConfigPath();
  if (existsSync(p)) {
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as AgentConfig;
    const envKey = process.env['NODEAGENT_KEY'];
    if (envKey) cfg.key = envKey;
    return { config: cfg, isNew: false };
  }
  const cfg = defaultAgentConfig();
  saveAgentConfig(cfg);
  return { config: cfg, isNew: true };
}

export function saveAgentConfig(cfg: AgentConfig): void {
  const p = agentConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows 上忽略 */
  }
}
