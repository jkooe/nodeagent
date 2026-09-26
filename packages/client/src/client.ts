import WebSocket from 'ws';
import {
  Methods,
  PROTOCOL_VERSION,
  ulid,
  computeHmac,
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
  private closed = false;

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
        resolve();
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

      ws.on('message', (raw: WebSocket.RawData) => this.handleMessage(raw.toString()));
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
      hmac: computeHmac(this.opts.key, challenge.nonce),
    };
    const authOk = await this.request<AuthOkParams>(Methods.Auth, authParams, handshakeTimeoutMs);

    this.capabilities = authOk.capabilities ?? [];
    this.opts.onLog?.(`握手成功，被控端声明 ${this.capabilities.length} 项能力`);
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

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ClientError(ErrorCodes.NODE_OFFLINE, 'E_NODE_OFFLINE', '连接已断开'));
    }
    this.pending.clear();
    this.opts.onLog?.('连接已关闭');
  }

  /** 主动关闭连接。 */
  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}
