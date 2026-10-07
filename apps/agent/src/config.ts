import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateSharedKey, type AclPolicy } from '@nodeagent/protocol';

export interface AgentConfig {
  node_id: string;
  host: string;
  port: number;
  tls: boolean;
  /** v1 简化：预共享密钥存于 600 权限文件；v2 升级 DPAPI。**所有调用方共用**，仅适合信任网络 */
  key: string;
  /**
   * v22：**每客户端一把**预共享密钥（`client_id` → key）。
   *
   * 为什么需要它：psk 模式下 `client_id` 由客户端自报，历史上「一把共享 key」等于
   * **持有者可冒充任意 client_id**，ACL 的身份维度形同虚设。
   * 改为每个 client_id 一把钥匙后，「知道 key A 就只能以 A 的身份进来」——
   * 身份才真正被绑定。未登记的 client_id 回落到上面的 `key`（旧部署行为不变）。
   */
  keys?: Record<string, string>;
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
  /**
   * v21：允许接入的来源网段（CIDR / 单 IP / `*`）。**未配置 = 放行全部**。
   *
   * ⚠️ 默认放行是为了不打断现有部署，但「换到不可信网络就自动暴露」正是
   * 第一批要收敛的风险 —— 建议在家庭/办公网段上显式配置，例如：
   *   "allow_from": ["192.168.0.0/16", "10.0.0.0/8"]
   */
  allow_from?: string[];

  /**
   * v23 连接层防护（三项，默认值见 server.ts）。
   * 单项缺省即启用默认策略；显式设 0 可关闭对应项。
   */
  security?: {
    /** 握手失败封禁：同来源连续失败 max_attempts 次起，ban = ban_ms × 2^(N-max)，封顶 24h */
    auth_ban?: { max_attempts?: number; ban_ms?: number; whitelist?: string[] };
    /** 最大并发连接数（默认 8） */
    max_connections?: number;
    /** 空闲断开（默认 30 分钟；0 = 关闭） */
    idle_timeout_ms?: number;
  };
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
    /**
     * v22：广播详情级别。
     * - `full`（默认，向后兼容）：携带地址/端口/认证方式/键鼠开关等全部信息
     * - `minimal`：只广播「存在 + node_id + 时间」，详情放进 `detail` 字段；
     *   配了 `secret` 时详情会被 **HMAC 认证**（控制端持钥才看得到、且能验证真伪）
     * ⚠️ 广播是**未认证**的：任何人收 UDP 都能看到内容。minimal 仍会暴露
     *   「这里有一台可被接管的机器」，但不再泄露地址、端口与认证方式。
     */
    detail?: 'full' | 'minimal';
    /** v22：详情认证密钥（配合 detail=minimal 使用；配了就会自动启用 minimal） */
    secret?: string;
  };
  /**
   * v5：文件访问白名单（根目录列表）。
   * 为空或缺省 = 不限制（访问控制完全交给 v3 的能力级 ACL）；
   * 非空 = 只允许读写这些目录之下的路径。
   */
  fs_roots?: string[];
  /**
   * v6：Hub 模式。启用后**不再监听本地端口**，改为主动外连 Hub 注册，
   * 适用于被控端位于 NAT / 无公网 IP 的环境。
   */
  hub?: {
    /** v12：最多维持的 Hub 槽位数（并发控制端上限），默认 2 */
    max_slots?: number;
    /** v12：常备（预热的）槽位数，默认 2；设为 1 可省一条空闲连接 */
    warm_slots?: number;
    enabled: boolean;
    /** Hub 地址，例如 wss://hub.example.com/hub/agent */
    url: string;
    /** Hub 令牌 */
    token: string;
    /** 跳过 Hub 证书校验（自签证书场景） */
    insecure?: boolean;
  };
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
    // 剥离 UTF-8 BOM：Windows 上由 PowerShell 写出的 JSON 可能带 BOM，
    // 直接 JSON.parse 会报 "Unexpected token ''"
    const text = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(text) as AgentConfig;
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
