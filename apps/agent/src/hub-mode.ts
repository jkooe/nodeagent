import { WebSocket } from 'ws';
import type { AgentConfig } from './config.js';
import { createAgentCore } from './server.js';

export interface HubClientOptions {
  /** 例如 wss://hub.example.com/hub/agent */
  url: string;
  token: string;
  /** 跳过 Hub 证书校验（自签证书场景） */
  insecure?: boolean;
  /** 重连基础退避（默认 1s，指数增长至 30s） */
  reconnectBaseMs?: number;
}

export interface HubClient {
  isRegistered(): boolean;
  stop(): void;
}

/**
 * 被控端 Hub 模式：主动外连 Hub 注册，随后在该连接上提供 RPC 服务。
 * 出站连接使其可工作于 NAT / 无公网 IP 的环境。
 *
 * 注册成功后 Hub 不再解析内容 —— 该连接上跑的就是与控制端的端到端 RPC。
 */
export function startHubClient(
  cfg: AgentConfig,
  opts: HubClientOptions,
  log: (level: 'info' | 'warn', msg: string) => void,
): HubClient {
  const core = createAgentCore(cfg);
  const baseMs = opts.reconnectBaseMs ?? 1000;

  let sock: WebSocket | null = null;
  let registered = false;
  let stopped = false;
  let attempts = 0;
  let timer: NodeJS.Timeout | null = null;

  const scheduleReconnect = (reason: string): void => {
    registered = false;
    if (stopped) return;
    const delay = Math.min(baseMs * 2 ** attempts, 30_000);
    attempts += 1;
    log('warn', `${reason}，${delay}ms 后重连 Hub（第 ${attempts} 次）`);
    timer = setTimeout(connect, delay);
    timer.unref?.();
  };

  function connect(): void {
    if (stopped) return;
    log('info', `正在连接 Hub ${opts.url}`);
    const s = new WebSocket(opts.url, { rejectUnauthorized: opts.insecure !== true });
    sock = s;

    // 注册阶段的控制面处理；注册成功后即卸载，交由 core 接管 RPC
    const onHubMessage = (raw: { toString(): string }): void => {
      let msg: { type?: string; message?: string };
      try {
        msg = JSON.parse(raw.toString()) as { type?: string; message?: string };
      } catch {
        return;
      }
      if (msg.type === 'registered') {
        registered = true;
        attempts = 0;
        log('info', `已注册到 Hub（node_id=${cfg.node_id}），进入服务状态`);
        s.off('message', onHubMessage);
        core.attach(s, 'hub');
        return;
      }
      if (msg.type === 'error') {
        log('warn', `Hub 拒绝: ${msg.message ?? ''}`);
      }
    };

    s.on('open', () => {
      s.send(
        JSON.stringify({
          type: 'register',
          node_id: cfg.node_id,
          token: opts.token,
          meta: { platform: process.platform, auth_mode: cfg.auth_mode ?? 'psk' },
        }),
      );
    });
    s.on('message', onHubMessage);
    s.on('close', () => scheduleReconnect('Hub 连接已关闭'));
    s.on('error', (err: Error) => log('warn', `Hub 连接错误: ${err.message}`));
  }

  connect();

  return {
    isRegistered: () => registered,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        sock?.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}
