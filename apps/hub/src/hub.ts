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
  /** 该槽位当前配对的客户端；一个槽位同时只服务一个控制端 */
  paired: WebSocket | null;
}

export interface HubServer {
  url: string;
  agents(): AgentView[];
  close(): Promise<void>;
}

/** 聚合成「一节点一行」的对外视图。 */
function viewAgentsOf(agents: Map<string, AgentEntry[]>): Array<AgentView & { slots: number; paired_slots: number }> {
  const out: Array<AgentView & { slots: number; paired_slots: number }> = [];
  for (const [nodeId, pool] of agents) {
    const live = pool.filter((e) => e.ws.readyState === WebSocket.OPEN);
    if (live.length === 0) continue;
    const first = live[0]!;
    const pairedSlots = live.filter((e) => e.paired !== null).length;
    out.push({
      node_id: nodeId,
      platform: first.platform,
      version: first.version,
      connected_at: Math.min(...live.map((e) => e.connected_at)),
      paired: pairedSlots > 0,
      slots: live.length,
      paired_slots: pairedSlots,
    });
  }
  return out;
}

export function createHubServer(cfg: HubConfig): Promise<HubServer> {
  const levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2 };
  const log = (level: LogLevel, msg: string): void => {
    if (levelOrder[level] >= levelOrder[cfg.log_level]) {
      console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
    }
  };

  /**
   * v12 / E3：`node_id → 槽位池`。
   * 过去是「一个节点一条连接 → 同时只能一个控制端」（E_NODE_BUSY）。
   * 现在每个节点可持有多条连接（槽位），每条服务一个控制端，从而实现**并发多控制端**；
   * 槽位不足时向被控端发 need_slot 请它再开一条（有上限，超限仍回 E_NODE_BUSY）。
   */
  const agents = new Map<string, AgentEntry[]>();
  const maxSlots = Math.max(1, Math.min(10, cfg.max_slots_per_node ?? 3));
  /** 等待 need_slot 生效的等待者：node_id → 回调 */
  const slotWaiters = new Map<string, Array<(ok: boolean) => void>>();

  const poolOf = (nodeId: string): AgentEntry[] => agents.get(nodeId) ?? [];
  const idleOf = (nodeId: string): AgentEntry | undefined =>
    poolOf(nodeId).find((e) => e.paired === null && e.ws.readyState === WebSocket.OPEN);
  const liveCount = (nodeId: string): number =>
    poolOf(nodeId).filter((e) => e.ws.readyState === WebSocket.OPEN).length;

  function notifySlot(nodeId: string, ok: boolean): void {
    const waiters = slotWaiters.get(nodeId);
    if (!waiters) return;
    slotWaiters.delete(nodeId);
    for (const w of waiters) w(ok);
  }

  /** 请求被控端新开一个槽位，最多等 waitMs。 */
  function askForSlot(nodeId: string, waitMs = 3000): Promise<boolean> {
    const pool = poolOf(nodeId).filter((e) => e.ws.readyState === WebSocket.OPEN);
    if (pool.length === 0) return Promise.resolve(false);
    if (pool.length >= maxSlots) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const list = slotWaiters.get(nodeId) ?? [];
      list.push(resolve);
      slotWaiters.set(nodeId, list);
      const need: HubOutbound = { type: 'need_slot', slots: pool.length, max_slots: maxSlots };
      for (const e of pool) send(e.ws, need);
      log('info', `向被控端 ${nodeId} 请求新槽位（现有 ${pool.length}/${maxSlots}）`);
      setTimeout(() => {
        const w = slotWaiters.get(nodeId);
        if (!w) return;
        slotWaiters.delete(nodeId);
        for (const fn of w) fn(false);
      }, waitMs).unref?.();
    });
  }

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
      const pool = poolOf(nodeId).filter((e) => e.ws.readyState === WebSocket.OPEN);
      if (pool.length >= maxSlots) {
        log('warn', `节点 ${nodeId} 槽位已满（${pool.length}/${maxSlots}），拒绝新连接`);
        fail(ws, 'E_TOO_MANY_SLOTS', `节点 ${nodeId} 槽位已达上限 ${maxSlots}`);
        return;
      }

      const entry: AgentEntry = {
        node_id: nodeId,
        ws,
        platform: msg.meta?.platform,
        version: msg.meta?.version,
        connected_at: Date.now(),
        paired: null,
      };
      pool.push(entry);
      agents.set(nodeId, pool);
      registeredId = nodeId;
      send(ws, { type: 'registered', node_id: nodeId } satisfies HubRegistered);
      log('info', `被控端已注册 ${nodeId} from ${remote}（槽位 ${pool.length}/${maxSlots}，platform=${msg.meta?.platform ?? '?'}）`);
      notifySlot(nodeId, true);
    };

    ws.on('message', onMessage);
    ws.once('close', () => {
      if (!registeredId) return;
      const pool = poolOf(registeredId).filter((e) => e.ws !== ws);
      if (pool.length > 0) agents.set(registeredId, pool);
      else agents.delete(registeredId);
      log('info', `被控端槽位离线 ${registeredId}（剩余 ${pool.length}/${maxSlots}）`);
    });
  }

  // ---------------- 控制端接入 ----------------

  function handleClientSocket(ws: WebSocket, remote: string): void {
    const onMessage = (data: RawData): void => {
      const msg = readControl(ws, data.toString(), remote);
      if (!msg) return;

      if (msg.type === 'list') {
        send(ws, { type: 'list.result', agents: viewAgents() });
        return;
      }

      if (msg.type !== 'connect') {
        fail(ws, 'E_BAD_REQUEST', `控制端不应发送 ${msg.type}`);
        return;
      }

      const nodeId = (msg as HubClientConnect).node_id;
      if (liveCount(nodeId) === 0) {
        fail(ws, 'E_NODE_OFFLINE', `设备离线: ${nodeId}`);
        return;
      }
      void (async () => {
        log('info', `控制端请求接入 ${nodeId} from ${remote}`);
        // 1) 有空闲槽位直接配
        const idle = idleOf(nodeId);
        if (idle) {
          pair(ws, idle);
          return;
        }
        // 2) 无空闲：请被控端再开一条（有上限）
        if (liveCount(nodeId) < maxSlots) {
          const ok = await askForSlot(nodeId);
          if (ok) {
            const fresh = idleOf(nodeId);
            if (fresh) {
              pair(ws, fresh);
              return;
            }
          }
        }
        // 3) 仍无 → 真的满了
        fail(ws, 'E_NODE_BUSY', `设备并发槽位已满（${liveCount(nodeId)}/${maxSlots}）: ${nodeId}`);
      })();
    };

    ws.on('message', onMessage);
  }

  const viewAgents = (): Array<AgentView & { slots: number; paired_slots: number }> => viewAgentsOf(agents);

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
        agents: () => viewAgents(),
        close: () =>
          new Promise<void>((res) => {
            for (const pool of agents.values()) for (const a of pool) a.ws.terminate();
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => httpServer.close(() => res()));
          }),
      });
    });
    httpServer.listen(cfg.port, cfg.host);
  });
}
