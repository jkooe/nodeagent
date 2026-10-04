import { createSocket, type Socket } from 'node:dgram';
import { DEFAULT_DISCOVERY_PORT, computeHmac } from '@nodeagent/protocol';
import { currentCertFingerprint } from './certs.js';

export { DEFAULT_DISCOVERY_PORT };

/** 广播报文（局域网内任何人可读 —— 因此绝不含任何凭据）。 */
export interface BeaconPayload {
  /** 固定标识，用于过滤无关 UDP 流量 */
  service: 'nodeagent';
  version: string;
  node_id: string;
  /**
   * 以下字段在 `full` 模式下直给在顶层；在 `minimal` 模式下收在 `detail` 里
   * （顶层只留「存在性 + node_id + 时间」）。故为可选。
   */
  /** 被控端可达地址（由被控端自行判定） */
  host?: string;
  port?: number;
  tls?: boolean;
  auth_mode?: string;
  /** 需要输入控制开关的状态，便于控制端提示 */
  input_enabled?: boolean;
  /**
   * v21：TLS 证书指纹（sha256 hex）。
   * ⚠️ 这是**未认证**广播，可被伪造 —— 只用于「看起来像不像」，不能作为身份凭据；
   *    真正的身份确认发生在握手后（auth_ok 里带指纹，且控制端会严格比对）。
   */
  cert_sha256?: string | null;
  platform?: string;
  /**
   * v22：`true` 表示这是**最小化**广播 —— 顶层只有存在性信息，
   * 真实地址/端口/认证方式等在 `detail` 里（有 secret 时带 `sig` 认证）。
   */
  minimal?: boolean;
  /** v22：最小化广播里的详情（可能带 `sig`，由持有 secret 的控制端验证） */
  detail?: {
    host: string;
    port: number;
    tls: boolean;
    auth_mode: string;
    input_enabled: boolean;
    cert_sha256?: string | null;
    platform: string;
  };
  /** v22：详情签名（HMAC-SHA256 over `node_id|ts|JSON(detail)`），由持有 secret 的控制端验证 */
  sig?: string;
  ts: number;
}

export interface BeaconOptions {
  enabled: boolean;
  /** 广播目标端口（控制端监听同一端口） */
  port: number;
  /** 广播地址；局域网内通常为 255.255.255.255 */
  broadcast: string;
  intervalMs: number;
  /** 报文中除 ts 外的固定字段（full 模式直给顶层的那组） */
  base: Required<
    Pick<BeaconPayload, 'node_id' | 'host' | 'port' | 'tls' | 'auth_mode' | 'input_enabled' | 'platform'>
  >;
  /** v22：详情级别；配了 secret 也会自动启用 minimal */
  detail?: 'full' | 'minimal';
  /** v22：详情认证密钥（HMAC-SHA256 over node_id|ts|detail） */
  secret?: string;
}

export interface Beacon {
  stop(): void;
  /** 立即广播一次（用于启动时快速被发现） */
  announce(): void;
}

const SERVICE_TAG = 'nodeagent';
const PROTOCOL_VERSION = '1.0';

/** 启动 UDP 心跳广播；失败不抛异常（发现是锦上添花，不应影响主服务）。 */
export function startBeacon(opts: BeaconOptions, onError?: (msg: string) => void): Beacon | null {
  if (!opts.enabled) return null;

  let socket: Socket;
  try {
    socket = createSocket({ type: 'udp4', reuseAddr: true });
  } catch (err) {
    onError?.(`发现广播初始化失败: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  let ready = false;

  const send = (): void => {
    if (!ready) return;
    const ts = Date.now();
    // v22 详情分级：minimal 模式只广播「存在性」，详情移入 detail{} 并用 secret 做 HMAC。
    // 未配 secret 时 detail 仍然明文（此时 sig 缺省，控制端会标为「未认证」）。
    const full = {
      host: opts.base.host,
      port: opts.base.port,
      tls: opts.base.tls,
      auth_mode: opts.base.auth_mode,
      input_enabled: opts.base.input_enabled,
      cert_sha256: currentCertFingerprint(),
      platform: opts.base.platform,
    };
    const minimal = opts.detail === 'minimal' || !!opts.secret;
    const payload: BeaconPayload = minimal
      ? {
          service: SERVICE_TAG,
          version: PROTOCOL_VERSION,
          node_id: opts.base.node_id,
          minimal: true,
          detail: full,
          sig: opts.secret
            ? computeHmac(opts.secret, `${opts.base.node_id}|${ts}|${JSON.stringify(full)}`)
            : undefined,
          ts,
        }
      : {
          service: SERVICE_TAG,
          version: PROTOCOL_VERSION,
          cert_sha256: currentCertFingerprint(),
          ...opts.base,
          ts,
        };
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');
    try {
      socket.send(buf, 0, buf.length, opts.port, opts.broadcast, (err) => {
        if (err) onError?.(`广播失败: ${err.message}`);
      });
    } catch (err) {
      onError?.(`广播异常: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  socket.on('error', (err) => onError?.(`广播 socket 错误: ${err.message}`));

  // 必须先 bind 再 setBroadcast —— 未绑定的 socket 调用会报 EBADF
  socket.bind(0, () => {
    try {
      socket.setBroadcast(true);
      ready = true;
      send(); // 启动即广播一次，便于控制端快速发现
    } catch (err) {
      onError?.(`开启广播失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const timer = setInterval(send, Math.max(1000, opts.intervalMs));
  timer.unref();

  return {
    announce: send,
    stop: () => {
      clearInterval(timer);
      try {
        socket.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}
