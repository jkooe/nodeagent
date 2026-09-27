import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateSharedKey, type AclPolicy } from '@nodeagent/protocol';

export interface AgentConfig {
  node_id: string;
  host: string;
  port: number;
  tls: boolean;
  /** v1 简化：预共享密钥存于 600 权限文件；v2 升级 DPAPI */
  key: string;
  log_level: 'debug' | 'info' | 'warn';
  /**
   * v2：是否允许输入控制（鼠标 / 键盘）。
   * 高危能力，默认 false —— 需被控端显式开启后才可被远程操作。
   */
  allow_input?: boolean;
  /**
   * v3：认证模式。
   * - `psk`（默认）：预共享密钥 + HMAC 挑战-应答，向后兼容
   * - `ed25519`：Ed25519 签名挑战-应答，每个调用方独立密钥，配合 ACL 精细授权
   */
  auth_mode?: 'psk' | 'ed25519';
  /** v3：ed25519 模式下的能力级授权策略（默认拒绝） */
  acl?: AclPolicy;
  /** v3+：审计日志配置 */
  audit?: {
    /** 是否启用（默认 true） */
    enabled?: boolean;
    /** 单文件上限字节（默认 10MB，超出即轮转） */
    max_bytes?: number;
    /** 保留的轮转文件数（默认 5） */
    max_files?: number;
    /** 是否记录参数预览（默认 false，仅记摘要；开启后自动脱敏） */
    log_args?: boolean;
  };
  /** v4：局域网发现（UDP 心跳广播） */
  discovery?: {
    /** 是否广播（默认 true） */
    enabled?: boolean;
    /** 广播目标端口（默认 8766，控制端监听同一端口） */
    port?: number;
    /** 广播地址（默认 255.255.255.255） */
    broadcast?: string;
    /** 广播间隔毫秒（默认 5000） */
    interval_ms?: number;
  };
  /**
   * v5：文件访问白名单（根目录列表）。
   * 为空或缺省 = 不限制（访问控制完全交给 v3 的能力级 ACL）；
   * 非空 = 只允许读写这些目录之下的路径。
   */
  fs_roots?: string[];
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
    auth_mode: 'psk',
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
