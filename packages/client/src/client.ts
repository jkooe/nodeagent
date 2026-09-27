import WebSocket from 'ws';
import {
  Methods,
  PROTOCOL_VERSION,
  ulid,
  computeHmac,
  signNonce,
  isErrorResponse,
  ErrorCodes,
  type RpcRequest,
  type RpcResponse,
  type RpcError,
  type CapabilityDescriptor,
  type InvokeResult,
  type ChallengeParams,
  type AuthParams,
  type AuthOkParams,
} from '@nodeagent/protocol';

/** 客户端错误（携带协议错误码）。 */
export class ClientError extends Error {
  constructor(
    public readonly code: number,
    public readonly rpcName: string,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = rpcName;
  }
}

export interface ClientOptions {
  /** ws:// 或 wss:// 地址 */
  url: string;
  /** 预共享密钥 */
  key: string;
  clientId: string;
  /** v1 简化：跳过自签证书校验 */
  insecure?: boolean;
  /** 握手超时（默认 10s） */
  handshakeTimeoutMs?: number;
  /** 单次调用默认超时（默认 60s） */
  defaultTimeoutMs?: number;
  /** v3：认证模式；默认 `psk` */
  authMode?: 'psk' | 'ed25519';
  /** v3：ed25519 模式的私钥（Base64 PKCS8 DER） */
  privateKey?: string;
  /** v4：断线后自动重连（默认 false，适合长驻进程如 MCP） */
  autoReconnect?: boolean;
  /** v4：重连退避上限（默认 30s） */
  maxReconnectDelayMs?: number;
  /** v4：连接状态变化回调 */
  onStateChange?: (state: 'connected' | 'reconnecting' | 'closed') => void;
  /** v6：经 Hub 中转（URL 需指向 `/hub/client`） */
  hub?: { token: string; nodeId: string };
  /** 日志回调 */
  onLog?: (msg: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * nodeagent 控制端客户端。
 * 负责：连接 → 握手(HMAC 挑战-应答) → 调用能力。
 */
export class NodeAgentClient {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private capabilities: CapabilityDescriptor[] = [];
  /** ed25519 模式：本次被授权的能力；psk 模式为 null */
  private authorized: string[] | null = null;
  private closed = false;
  /** v4：重连状态 */
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: ClientOptions) {}

  /** 建立连接并完成握手，成功后返回能力清单。 */
  async connect(): Promise<CapabilityDescriptor[]> {
    const { url, insecure, handshakeTimeoutMs = 10_000, onLog } = this.opts;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { rejectUnauthorized: !insecure });
      this.ws = ws;

      const timer = setTimeout(() => {
        ws.terminate();
        reject(new ClientError(ErrorCodes.TIMEOUT, 'E_TIMEOUT', `连接超时: ${url}`));
      }, handshakeTimeoutMs);

      ws.once('open', () => {
        clearTimeout(timer);
        onLog?.(`已连接 ${url}`);
        // Hub 模式下先完成配对，再挂 RPC 处理器（否则控制面消息会被误当响应）
        const ready: Promise<void> = this.opts.hub
          ? this.pairViaHub(ws, this.opts.hub, handshakeTimeoutMs)
          : Promise.resolve();
        ready
          .then(() => {
            ws.on('message', (raw: WebSocket.RawData) => this.handleMessage(raw.toString()));
            resolve();
          })
          .catch((err: unknown) => {
            ws.terminate();
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
      ws.once('error', (err: Error) => {
        clearTimeout(timer);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT') {
          reject(new ClientError(ErrorCodes.NODE_OFFLINE, 'E_NODE_OFFLINE', `无法连接被控端: ${err.message}`));
        } else {
          reject(new ClientError(ErrorCodes.INVALID_REQUEST, 'E_CONNECT_FAILED', err.message));
        }
      });

      ws.on('close', () => this.handleClose());
    });

    // 握手：hello → challenge → auth → auth_ok
    const challenge = await this.request<ChallengeParams>(
      Methods.Hello,
      { protocol: PROTOCOL_VERSION, client_id: this.opts.clientId },
      handshakeTimeoutMs,
    );

    const authParams: AuthParams = {
      client_id: this.opts.clientId,
      nonce: challenge.nonce,
    };
    if (this.opts.authMode === 'ed25519') {
      if (!this.opts.privateKey) {
        throw new ClientError(
          ErrorCodes.AUTH_FAILED,
          'E_AUTH_FAILED',
          'ed25519 模式需要私钥，请先运行: nodeagent keygen',
        );
      }
      authParams.signature = signNonce(this.opts.privateKey, challenge.nonce);
    } else {
      authParams.hmac = computeHmac(this.opts.key, challenge.nonce);
    }

    const authOk = await this.request<AuthOkParams>(Methods.Auth, authParams, handshakeTimeoutMs);

    this.capabilities = authOk.capabilities ?? [];
    this.authorized = authOk.authorized ?? null;
    const label =
      authOk.auth_mode === 'ed25519'
        ? `ed25519，授权 ${this.authorized?.length ?? 0}/${this.capabilities.length} 项能力`
        : `psk，被控端声明 ${this.capabilities.length} 项能力`;
    this.opts.onLog?.(`握手成功（${label}）`);
    this.opts.onStateChange?.('connected');
    return this.capabilities;
  }

  /** 调用一项能力。 */
  async invoke<T = unknown>(
    capability: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<InvokeResult<T>> {
    return this.request<InvokeResult<T>>(Methods.Invoke, { capability, args }, timeoutMs);
  }

  /** 已获取的能力清单。 */
  listCapabilities(): CapabilityDescriptor[] {
    return this.capabilities;
  }

  /** ed25519 模式下本次被授权的能力；psk 模式返回 null（不限制）。 */
  listAuthorized(): string[] | null {
    return this.authorized;
  }

  /** 底层请求（带超时与 id 匹配）。 */
  private request<R>(method: string, params: unknown, timeoutMs?: number): Promise<R> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ClientError(ErrorCodes.NODE_OFFLINE, 'E_NODE_OFFLINE', '连接未就绪'));
    }
    const id = ulid();
    const req: RpcRequest = { jsonrpc: '2.0', id, method, params };
    const timeout = timeoutMs ?? this.opts.defaultTimeoutMs ?? 60_000;

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ClientError(ErrorCodes.TIMEOUT, 'E_TIMEOUT', `调用超时 (${timeout}ms): ${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      ws.send(JSON.stringify(req));
    });
  }

  private handleMessage(text: string): void {
    let msg: RpcResponse | { error: RpcError; id: string | null };
    try {
      msg = JSON.parse(text);
    } catch {
      this.opts.onLog?.(`收到无法解析的消息: ${text.slice(0, 200)}`);
      return;
    }

    const id = (msg as { id?: string | null }).id;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (isErrorResponse(msg)) {
      pending.reject(new ClientError(msg.error.code, msg.error.name, msg.error.message, msg.error.data));
    } else {
      pending.resolve((msg as RpcResponse).result);
    }
  }

  /** v6：Hub 配对（控制面消息，非 JSON-RPC）。配对后该连接即为到被控端的透明通道。 */
  private pairViaHub(ws: WebSocket, hub: { token: string; nodeId: string }, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onMessage = (raw: WebSocket.RawData): void => {
        let msg: { type?: string; code?: string; message?: string };
        try {
          msg = JSON.parse(raw.toString()) as { type?: string; code?: string; message?: string };
        } catch {
          return;
        }
        if (msg.type === 'paired') {
          clearTimeout(timer);
          ws.off('message', onMessage);
          this.opts.onLog?.(`Hub 配对成功（node_id=${hub.nodeId}）`);
          resolve();
          return;
        }
        if (msg.type === 'error') {
          clearTimeout(timer);
          ws.off('message', onMessage);
          // Hub 令牌错误属鉴权问题，其余（离线/占用）归为不可达
          const code = msg.code === 'E_HUB_AUTH' ? ErrorCodes.AUTH_FAILED : ErrorCodes.NODE_OFFLINE;
          reject(new ClientError(code, msg.code ?? 'E_HUB', msg.message ?? 'Hub 拒绝接入'));
        }
      };

      const timer = setTimeout(() => {
        ws.off('message', onMessage);
        reject(new ClientError(ErrorCodes.TIMEOUT, 'E_TIMEOUT', 'Hub 配对超时'));
      }, timeoutMs);

      ws.on('message', onMessage);
      ws.send(JSON.stringify({ type: 'connect', node_id: hub.nodeId, token: hub.token }));
    });
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ClientError(ErrorCodes.NODE_OFFLINE, 'E_NODE_OFFLINE', '连接已断开'));
    }
    this.pending.clear();
    this.opts.onLog?.('连接已关闭');

    if (this.opts.autoReconnect && !this.stopped) {
      this.scheduleReconnect();
    } else {
      this.opts.onStateChange?.('closed');
    }
  }

  /** v4：指数退避 + 抖动重连。 */
  private scheduleReconnect(): void {
    const maxDelay = this.opts.maxReconnectDelayMs ?? 30_000;
    const base = Math.min(1000 * 2 ** this.reconnectAttempts, maxDelay);
    const delay = Math.round(base * (0.85 + Math.random() * 0.3)); // ±15% 抖动，避免惊群
    this.reconnectAttempts += 1;
    this.opts.onStateChange?.('reconnecting');
    this.opts.onLog?.(`将在 ${delay}ms 后重连（第 ${this.reconnectAttempts} 次）`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.closed = false;
      this.connect()
        .then(() => {
          this.reconnectAttempts = 0;
          this.opts.onStateChange?.('connected');
          this.opts.onLog?.('重连成功');
        })
        .catch((err: unknown) => {
          this.opts.onLog?.(`重连失败: ${err instanceof Error ? err.message : String(err)}`);
          if (!this.stopped) this.scheduleReconnect();
        });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** 主动关闭连接（会停止自动重连）。 */
  close(): void {
    this.stopped = true;
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
