import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { verifyHmac } from '@nodeagent/protocol';

/** 发现到的被控端。 */
export interface DiscoveredNode {
  node_id: string;
  /** 可达地址：优先取报文来源 IP（一定可达），而非被控端自报的地址 */
  host: string;
  /** 被控端自报地址（多网卡时可能与来源不同，仅供参考） */
  advertised_host: string;
  port: number;
  tls: boolean;
  auth_mode: string;
  input_enabled: boolean;
  platform: string;
  /**
   * v22：详情是否**通过 HMAC 验签**（被控端配了 `discovery.secret` 且我方也持有）。
   * false/未定义 = 明文广播（任何人可伪造）→ 此时这些字段仅作展示，**不可当凭据**。
   */
  authenticated?: boolean;
  /** 最近一次收到广播的时间 */
  last_seen: number;
}

export interface DiscoveryOptions {
  /** 监听端口，需与被控端广播目标端口一致 */
  port: number;
  /** 超过该时长未收到广播即视为离线（默认 30s） */
  ttlMs?: number;
  /** 报文日志（调试用） */
  onLog?: (msg: string) => void;
  /**
   * v22：发现广播的**认证密钥**。与被控端 `discovery.secret` 一致时，
   * 最小化广播里的详情会带 HMAC 签名，我方验签通过才采信（`authenticated: true`）。
   */
  secret?: string;
}

interface RawBeacon {
  service?: string;
  node_id?: string;
  host?: string;
  port?: number;
  tls?: boolean;
  auth_mode?: string;
  input_enabled?: boolean;
  platform?: string;
  ts?: number;
  cert_sha256?: string | null;
  /** v22：最小化广播标记（顶层只剩存在性，详情在 detail 里） */
  minimal?: boolean;
  detail?: {
    host?: string;
    port?: number;
    tls?: boolean;
    auth_mode?: string;
    input_enabled?: boolean;
    cert_sha256?: string | null;
    platform?: string;
  };
  /** v22：详情签名（HMAC over `node_id|ts|JSON(detail)`） */
  sig?: string;
}

/**
 * 局域网发现：监听被控端 UDP 心跳广播。
 * 只读不写、不发送任何数据，因此不引入额外暴露面。
 */
export class Discovery {
  private socket: Socket | null = null;
  private readonly nodes = new Map<string, DiscoveredNode>();
  private readonly foundHandlers: Array<(node: DiscoveredNode) => void> = [];
  private readonly ttlMs: number;

  constructor(private readonly opts: DiscoveryOptions) {
    this.ttlMs = opts.ttlMs ?? 30_000;
  }

  /** 开始监听（幂等）。 */
  start(): Promise<void> {
    if (this.socket) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;

      socket.on('error', (err) => {
        this.opts.onLog?.(`发现监听错误: ${err.message}`);
        reject(err);
      });
      socket.on('message', (buf, rinfo) => this.handleMessage(buf, rinfo));
      socket.bind(this.opts.port, () => {
        this.opts.onLog?.(`发现服务已监听 UDP ${this.opts.port}`);
        resolve();
      });
    });
  }

  private handleMessage(buf: Buffer, rinfo: RemoteInfo): void {
    let raw: RawBeacon;
    try {
      raw = JSON.parse(buf.toString('utf8')) as RawBeacon;
    } catch {
      return; // 非 JSON，忽略
    }
    if (raw.service !== 'nodeagent' || !raw.node_id) return;

    // v22：最小化广播 —— 顶层只有存在性，真实信息在 detail 里。
    // 持有 secret 时**必须验签**通过才采信 detail；否则标记为未认证（仅作展示）。
    const detail = raw.minimal && raw.detail ? raw.detail : raw;
    let authenticated = false;
    if (raw.minimal && raw.detail) {
      if (this.opts.secret && raw.sig) {
        authenticated = verifyHmac(
          this.opts.secret,
          `${raw.node_id}|${raw.ts}|${JSON.stringify(raw.detail)}`,
          raw.sig,
        );
      }
    }

    const node: DiscoveredNode = {
      node_id: raw.node_id,
      // 地址永远取「报文来源 IP」—— 一定可达（自报地址仅作参考）
      host: rinfo.address,
      advertised_host: detail.host ?? rinfo.address,
      port: Number(detail.port ?? 8765),
      tls: detail.tls !== false,
      auth_mode: detail.auth_mode ?? 'psk',
      input_enabled: detail.input_enabled === true,
      platform: detail.platform ?? 'unknown',
      authenticated,
      last_seen: Date.now(),
    };

    const isNew = !this.nodes.has(node.node_id);
    this.nodes.set(node.node_id, node);
    if (isNew) this.foundHandlers.forEach((cb) => cb(node));
  }

  /** 当前在线设备（已过滤 TTL 过期项）。 */
  list(): DiscoveredNode[] {
    const now = Date.now();
    for (const [id, node] of this.nodes) {
      if (now - node.last_seen > this.ttlMs) this.nodes.delete(id);
    }
    return [...this.nodes.values()].sort((a, b) => b.last_seen - a.last_seen);
  }

  /** 新设备首次出现时回调。 */
  onFound(cb: (node: DiscoveredNode) => void): void {
    this.foundHandlers.push(cb);
  }

  /** 清空已知设备（测试用）。 */
  clear(): void {
    this.nodes.clear();
  }

  stop(): void {
    try {
      this.socket?.close();
    } catch {
      /* 忽略 */
    }
    this.socket = null;
  }
}

/**
 * 便捷函数：监听一段时间后返回发现的设备。
 * 若端口被占用（例如已有长驻监听），会直接抛错 —— 调用方自行处理。
 */
export async function discoverOnce(waitMs: number, opts: DiscoveryOptions): Promise<DiscoveredNode[]> {
  const d = new Discovery(opts);
  await d.start();
  await new Promise((r) => setTimeout(r, waitMs));
  const nodes = d.list();
  d.stop();
  return nodes;
}
