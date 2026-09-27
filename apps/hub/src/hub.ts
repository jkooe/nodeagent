import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { HubConfig } from './config.js';
import type {
  HubClientConnect,
  HubError,
  HubInbound,
  HubListRequest,
  HubOutbound,
  HubPaired,
  HubRegistered,
} from './types.js';

type LogLevel = 'debug' | 'info' | 'warn';

export interface AgentView {
  node_id: string;
  platform?: string;
  version?: string;
  connected_at: number;
  paired: boolean;
}

interface AgentEntry {
  node_id: string;
  ws: WebSocket;
  platform?: string;
  version?: string;
  connected_at: number;
  /** 当前配对的客户端；同一时刻仅允许一个，避免多路复用复杂度 */
  paired: WebSocket | null;
}

export interface HubServer {
  url: string;
  agents(): AgentView[];
  close(): Promise<void>;
}

export function createHubServer(cfg: HubConfig): Promise<HubServer> {
  const levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2 };
  const log = (level: LogLevel, msg: string): void => {
    if (levelOrder[level] >= levelOrder[cfg.log_level]) {
      console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
    }
  };

  const agents = new Map<string, AgentEntry>();

  const httpServer = cfg.tls
    ? createHttpsServer({ cert: readFileSync(cfg.tls.cert_file), key: readFileSync(cfg.tls.key_file) })
    : createHttpServer();
  const wss = new WebSocketServer({ server: httpServer });

  const send = (ws: WebSocket, msg: HubOutbound): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (ws: WebSocket, code: HubError['code'], message: string): void => {
    send(ws, { type: 'error', code, message });
    setTimeout(() => ws.close(), 50);
  };

  /** 配对后双向透传；Hub 不再解析内容，端到端安全由双方自身的握手保证。 */
  function pair(clientWs: WebSocket, entry: AgentEntry): void {
    const agentWs = entry.ws;
    entry.paired = clientWs;

    const onClientMsg = (data: RawData, isBinary: boolean): void => {
      if (agentWs.readyState === WebSocket.OPEN) agentWs.send(data, { binary: isBinary });
    };
    const onAgentMsg = (data: RawData, isBinary: boolean): void => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
    };
    const detach = (): void => {
      clientWs.off('message', onClientMsg);
      agentWs.off('message', onAgentMsg);
      if (entry.paired === clientWs) entry.paired = null;
    };

    clientWs.removeAllListeners('message');
    agentWs.removeAllListeners('message');
    clientWs.on('message', onClientMsg);
    agentWs.on('message', onAgentMsg);

    // 控制端断开：仅解绑，被控端保持在线等待下一个控制端
    clientWs.once('close', detach);
    // 被控端掉线：连带关闭控制端，让控制端及时感知
    agentWs.once('close', () => {
      detach();
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });

    send(clientWs, { type: 'paired', node_id: entry.node_id } satisfies HubPaired);
    log('info', `配对成功 ${entry.node_id} ↔ 控制端`);
  }

  /** 解析 + 令牌校验；失败时已回错误消息并关闭连接。 */
  function readControl(ws: WebSocket, raw: string, remote: string): HubInbound | null {
    let msg: HubInbound;
    try {
      msg = JSON.parse(raw) as HubInbound;
    } catch {
      fail(ws, 'E_BAD_REQUEST', '消息不是合法 JSON');
      return null;
    }
    if (msg.token !== cfg.token) {
      log('warn', `鉴权失败（令牌不匹配）from ${remote}`);
      fail(ws, 'E_HUB_AUTH', 'Hub 令牌错误');
      return null;
    }
    return msg;
  }

  // ---------------- 被控端接入 ----------------

  function handleAgentSocket(ws: WebSocket, remote: string): void {
    let registeredId: string | null = null;

    const onMessage = (data: RawData): void => {
      if (registeredId) return; // 注册后不再受理控制面消息
      const msg = readControl(ws, data.toString(), remote);
      if (!msg) return;
      if (msg.type !== 'register') {
        fail(ws, 'E_BAD_REQUEST', `被控端不应发送 ${msg.type}`);
        return;
      }

      const nodeId = msg.node_id;
      const existing = agents.get(nodeId);
      if (existing && existing.ws.readyState === WebSocket.OPEN) {
        log('warn', `节点 ${nodeId} 重复注册，踢掉旧连接`);
        existing.ws.close();
      }

      const entry: AgentEntry = {
        node_id: nodeId,
        ws,
        platform: msg.meta?.platform,
        version: msg.meta?.version,
        connected_at: Date.now(),
        paired: null,
      };
      agents.set(nodeId, entry);
      registeredId = nodeId;
      send(ws, { type: 'registered', node_id: nodeId } satisfies HubRegistered);
      log('info', `被控端已注册 ${nodeId} from ${remote}（platform=${msg.meta?.platform ?? '?'}）`);
    };

    ws.on('message', onMessage);
    ws.once('close', () => {
      if (registeredId && agents.get(registeredId)?.ws === ws) {
        agents.delete(registeredId);
        log('info', `被控端已离线 ${registeredId}`);
      }
    });
  }

  // ---------------- 控制端接入 ----------------

  function handleClientSocket(ws: WebSocket, remote: string): void {
    const onMessage = (data: RawData): void => {
      const msg = readControl(ws, data.toString(), remote);
      if (!msg) return;

      if (msg.type === 'list') {
        send(ws, {
          type: 'list.result',
          agents: [...agents.values()].map((a) => ({
            node_id: a.node_id,
            platform: a.platform,
            connected_at: a.connected_at,
            paired: a.paired !== null,
          })),
        });
        return;
      }

      if (msg.type !== 'connect') {
        fail(ws, 'E_BAD_REQUEST', `控制端不应发送 ${msg.type}`);
        return;
      }

      const entry = agents.get((msg as HubClientConnect).node_id);
      if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
        fail(ws, 'E_NODE_OFFLINE', `设备离线: ${msg.node_id}`);
        return;
      }
      if (entry.paired) {
        fail(ws, 'E_NODE_BUSY', `设备正被其他控制端占用: ${msg.node_id}`);
        return;
      }
      log('info', `控制端请求接入 ${msg.node_id} from ${remote}`);
      pair(ws, entry);
    };

    ws.on('message', onMessage);
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');
    const remote = req.socket.remoteAddress ?? '?';

    if (path === '/hub/agent') handleAgentSocket(ws, remote);
    else if (path === '/hub/client') handleClientSocket(ws, remote);
    else fail(ws, 'E_BAD_REQUEST', `未知路径: ${path}（应使用 /hub/agent 或 /hub/client）`);
  });

  return new Promise<HubServer>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.once('listening', () => {
      const scheme = cfg.tls ? 'wss' : 'ws';
      log('info', `Hub 已监听 ${scheme}://${cfg.host}:${cfg.port}`);
      resolve({
        url: `${scheme}://${cfg.host}:${cfg.port}`,
        agents: () =>
          [...agents.values()].map((a) => ({
            node_id: a.node_id,
            platform: a.platform,
            version: a.version,
            connected_at: a.connected_at,
            paired: a.paired !== null,
          })),
        close: () =>
          new Promise<void>((res) => {
            for (const a of agents.values()) a.ws.terminate();
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => httpServer.close(() => res()));
          }),
      });
    });
    httpServer.listen(cfg.port, cfg.host);
  });
}
