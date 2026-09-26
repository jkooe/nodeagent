import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  Methods,
  PROTOCOL_VERSION,
  generateNonce,
  verifyHmac,
  ErrorCodes,
  ErrorNames,
  makeError,
  CapabilityError,
  CAPABILITY_MANIFEST,
  findCapability,
  validate,
  applyDefaults,
  type RpcRequest,
  type HelloParams,
  type AuthParams,
  type InvokeParams,
} from '@nodeagent/protocol';
import { capabilityRegistry } from './capabilities/index.js';
import type { AgentConfig } from './config.js';
import type { TlsMaterial } from './certs.js';

const NONCE_TTL_MS = 30_000;

interface ConnState {
  authenticated: boolean;
  nonce: string | null;
  nonceExpiresAt: number;
  clientId: string | null;
}

export interface AgentServer {
  close(): Promise<void>;
  url: string;
}

type LogLevel = 'debug' | 'info' | 'warn';

/** 创建并启动被控端 WebSocket 服务。 */
export function createAgentServer(cfg: AgentConfig, tls: TlsMaterial | null): Promise<AgentServer> {
  const levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2 };
  const log = (level: LogLevel, msg: string): void => {
    if (levelOrder[level] >= levelOrder[cfg.log_level]) {
      console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
    }
  };

  // TLS 必须由 https server 承载：ws 的 WebSocketServer 不识别 cert/key 选项，
  // 直接传入会被静默忽略，导致「自称 wss、实为明文」的降级。
  const httpServer = tls
    ? createHttpsServer({ cert: tls.cert, key: tls.key })
    : createHttpServer();
  const wss = new WebSocketServer({ server: httpServer });

  const states = new WeakMap<WebSocket, ConnState>();

  const send = (ws: WebSocket, msg: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const sendResult = (ws: WebSocket, id: string, result: unknown): void =>
    send(ws, { jsonrpc: '2.0', id, result });
  const sendError = (ws: WebSocket, id: string | null, code: number, message: string, data?: unknown): void =>
    send(ws, { jsonrpc: '2.0', id, error: makeError(code, message, data) });

  function handleHello(ws: WebSocket, state: ConnState, req: RpcRequest): void {
    const params = req.params as HelloParams | undefined;
    const proto = params?.protocol ?? '';
    if (proto.split('.')[0] !== PROTOCOL_VERSION.split('.')[0]) {
      sendError(ws, req.id, ErrorCodes.PROTOCOL_MISMATCH, `协议版本不兼容: 客户端 ${proto}，服务端 ${PROTOCOL_VERSION}`);
      return;
    }
    state.nonce = generateNonce();
    state.nonceExpiresAt = Date.now() + NONCE_TTL_MS;
    state.clientId = params?.client_id ?? null;
    sendResult(ws, req.id, { nonce: state.nonce, expires_at: state.nonceExpiresAt });
  }

  function handleAuth(ws: WebSocket, state: ConnState, req: RpcRequest): void {
    const params = req.params as AuthParams | undefined;
    if (!state.nonce || Date.now() > state.nonceExpiresAt) {
      sendError(ws, req.id, ErrorCodes.AUTH_FAILED, '挑战已过期，请重新握手');
      return;
    }
    if (params?.nonce !== state.nonce) {
      sendError(ws, req.id, ErrorCodes.AUTH_FAILED, 'nonce 不匹配');
      return;
    }
    if (!verifyHmac(cfg.key, state.nonce, params.hmac ?? '')) {
      log('warn', `鉴权失败 client_id=${params?.client_id ?? '?'}`);
      sendError(ws, req.id, ErrorCodes.AUTH_FAILED, '预共享密钥校验失败');
      // 稍作延迟再关闭，确保错误响应先送达控制端
      setTimeout(() => ws.close(), 100);
      return;
    }
    state.nonce = null; // 一次性，用后即废
    state.nonceExpiresAt = 0;
    state.authenticated = true;
    state.clientId = params.client_id ?? state.clientId;
    log('info', `鉴权通过 client_id=${state.clientId}`);
    sendResult(ws, req.id, { capabilities: CAPABILITY_MANIFEST });
  }

  async function handleInvoke(ws: WebSocket, state: ConnState, req: RpcRequest): Promise<void> {
    if (!state.authenticated) {
      sendError(ws, req.id, ErrorCodes.AUTH_REQUIRED, '未完成认证，请先握手');
      return;
    }
    const params = req.params as InvokeParams | undefined;
    const name = params?.capability ?? '';
    const cap = findCapability(name);
    const handler = capabilityRegistry[name];
    if (!cap || !handler) {
      sendError(ws, req.id, ErrorCodes.CAPABILITY_NOT_FOUND, `不支持的能力: ${name}`, { capability: name });
      return;
    }

    const args = (params?.args ?? {}) as Record<string, unknown>;
    const errors = validate(args, cap.params_schema);
    if (errors.length > 0) {
      sendError(ws, req.id, ErrorCodes.PARAM_INVALID, '参数校验失败', { errors });
      return;
    }

    const finalArgs = applyDefaults(args, cap.params_schema);
    const started = Date.now();
    try {
      const data = await handler(finalArgs);
      log('info', `invoke ${name} → ok (${Date.now() - started}ms)`);
      sendResult(ws, req.id, { status: 'ok', data });
    } catch (err) {
      if (err instanceof CapabilityError) {
        log('warn', `invoke ${name} → failed: ${err.name}`);
        sendResult(ws, req.id, {
          status: 'failed',
          error: { name: err.name, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) },
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        log('warn', `invoke ${name} → execution failed: ${msg}`);
        sendResult(ws, req.id, {
          status: 'failed',
          error: { name: ErrorNames[ErrorCodes.EXECUTION_FAILED], message: msg },
        });
      }
    }
  }

  async function handleMessage(ws: WebSocket, text: string): Promise<void> {
    let req: RpcRequest;
    try {
      req = JSON.parse(text) as RpcRequest;
    } catch {
      sendError(ws, null, ErrorCodes.PARSE_ERROR, '无法解析 JSON');
      return;
    }
    if (req?.jsonrpc !== '2.0' || typeof req.id !== 'string' || typeof req.method !== 'string') {
      sendError(ws, typeof req?.id === 'string' ? req.id : null, ErrorCodes.INVALID_REQUEST, '请求信封无效');
      return;
    }
    const state = states.get(ws);
    if (!state) return;

    switch (req.method) {
      case Methods.Hello:
        handleHello(ws, state, req);
        return;
      case Methods.Auth:
        handleAuth(ws, state, req);
        return;
      case Methods.Invoke:
        await handleInvoke(ws, state, req);
        return;
      case Methods.Capabilities:
        if (!state.authenticated) {
          sendError(ws, req.id, ErrorCodes.AUTH_REQUIRED, '未完成认证');
          return;
        }
        sendResult(ws, req.id, { capabilities: CAPABILITY_MANIFEST });
        return;
      case Methods.Ping:
        sendResult(ws, req.id, { pong: true, ts: Date.now() });
        return;
      default:
        sendError(ws, req.id, ErrorCodes.METHOD_NOT_FOUND, `未知方法: ${req.method}`);
    }
  }

  wss.on('connection', (ws, req) => {
    const remote = req.socket.remoteAddress ?? '?';
    log('info', `新连接: ${remote}`);
    states.set(ws, { authenticated: false, nonce: null, nonceExpiresAt: 0, clientId: null });
    ws.on('message', (raw: RawData) => {
      void handleMessage(ws, raw.toString());
    });
    ws.on('close', () => log('info', `连接关闭: ${remote}`));
    ws.on('error', (err: Error) => log('warn', `连接错误: ${err.message}`));
  });

  // WebSocket 层保活：30s ping，探测死连接
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  const scheme = tls ? 'wss' : 'ws';
  const url = `${scheme}://${cfg.host === '0.0.0.0' ? '<本机IP>' : cfg.host}:${cfg.port}`;

  return new Promise<AgentServer>((resolve, reject) => {
    httpServer.once('listening', () => {
      log('info', `Agent 已监听 ${scheme}://${cfg.host}:${cfg.port}`);
      resolve({
        url,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => httpServer.close(() => res()));
          }),
      });
    });
    httpServer.once('error', reject);
    httpServer.listen(cfg.port, cfg.host);
  });
}
