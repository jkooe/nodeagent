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
  /**
   * 常备槽位数（默认 2）：注册后立即预热到这个数量，避免「两个控制端同时接入」
   * 时的一方要等扩容（会有竞态窗口）。设为 1 可省一条空闲连接。
   */
  warmSlots?: number;
  /**
   * v12 / E3：最多同时维持的 Hub 槽位数（= 可并发服务的控制端数量上限）。
   * 默认 2，与 Hub 侧 max_slots_per_node 相互制约，取两者较小者生效。
   */
  maxSlots?: number;
}

export interface HubClient {
  isRegistered(): boolean;
  /** 当前槽位状态（调试/状态展示用） */
  slots(): Array<{ id: number; registered: boolean; serving: boolean }>;
  stop(): void;
}

interface Slot {
  id: number;
  ws: WebSocket | null;
  registered: boolean;
  /** 该槽位是否已有控制端在使用（收到过 hello） */
  serving: boolean;
  attempts: number;
  timer: NodeJS.Timeout | null;
}

/**
 * 被控端 Hub 模式（多槽位，v12 / E3）。
 *
 * 出站连接使其可工作于 NAT / 无公网 IP 的环境；Hub 注册后即进入端到端 RPC。
 *
 * **并发控制端**：一条 Hub 连接同时只服务一个控制端。为了支持「AI + 人同时在线」
 * 这类场景，本模块维护一个**槽位池**：
 *   - 启动时开 1 条；每当某个槽位被控制端占用（收到 hello），立即预热下一条
 *     —— 复用既有协议信号，无需新增控制消息，也不会白白占用空闲连接。
 *   - 槽位数不超过 maxSlots。
 *   - 每条槽位独立重连、独立退避，互不影响。
 */
export function startHubClient(
  cfg: AgentConfig,
  opts: HubClientOptions,
  log: (level: 'info' | 'warn', msg: string) => void,
): HubClient {
  const core = createAgentCore(cfg);
  const baseMs = opts.reconnectBaseMs ?? 1000;
  const maxSlots = Math.max(1, Math.min(10, opts.maxSlots ?? 2));
  const warmTarget = Math.max(1, Math.min(maxSlots, opts.warmSlots ?? 2));
  const status = (e: Error): void => log('warn', `Hub 连接错误: ${e.message}`);

  let stopped = false;
  let nextId = 1;
  const slots = new Map<number, Slot>();

  /** 预热到 target 条空闲槽位（默认常备 2 条，避免并发接入时的竞态窗口）。 */
  function ensureWarm(target = 2): void {
    if (stopped) return;
    const live = [...slots.values()].filter((s) => s.ws && s.ws.readyState === WebSocket.OPEN).length;
    const want = Math.max(warmTarget, Math.min(maxSlots, target));
    if (live >= want) return;
    openSlot();
  }

  function openSlot(): void {
    const slot: Slot = {
      id: nextId++,
      ws: null,
      registered: false,
      serving: false,
      attempts: 0,
      timer: null,
    };
    slots.set(slot.id, slot);
    connect(slot);
  }

  function connect(slot: Slot): void {
    if (stopped) return;
    if (slot.ws && slot.ws.readyState === WebSocket.OPEN) return;
    log('info', `正在连接 Hub ${opts.url}（槽位 ${slot.id}）`);
    const s = new WebSocket(opts.url, { rejectUnauthorized: opts.insecure !== true });
    slot.ws = s;

    // 注册阶段的控制面处理；注册成功后卸载，交由 core 接管 RPC
    const onHubMessage = (raw: { toString(): string }): void => {
      let msg: { type?: string; message?: string };
      try {
        msg = JSON.parse(raw.toString()) as { type?: string; message?: string };
      } catch {
        return;
      }
      if (msg.type === 'registered') {
        slot.registered = true;
        slot.attempts = 0;
        log('info', `槽位 ${slot.id} 已注册到 Hub（node_id=${cfg.node_id}）`);
        s.off('message', onHubMessage);
        // 用包装后的 core 接管：拦截该槽位上的首个 hello 作为「已被占用」信号
        attachWithDemandTracking(s);
        // 注册成功即补足常备槽位（并发接入零等待）
        setTimeout(() => ensureWarm(), 150).unref?.();
        return;
      }
      if (msg.type === 'error') {
        log('warn', `Hub 拒绝（槽位 ${slot.id}）: ${msg.message ?? ''}`);
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
    s.on('close', () => {
      slot.registered = false;
      slot.serving = false;
      slots.delete(slot.id);
      if (stopped) return;
      const delay = Math.min(baseMs * 2 ** slot.attempts, 30_000);
      slot.attempts += 1;
      log('warn', `槽位 ${slot.id} 连接已关闭，${delay}ms 后重连（第 ${slot.attempts} 次）`);
      slot.timer = setTimeout(() => {
        const fresh: Slot = { ...slot, ws: null, registered: false, serving: false };
        slots.set(fresh.id, fresh);
        connect(fresh);
      }, delay);
      slot.timer.unref?.();
    });
    s.on('error', status);
  }

  /**
   * 接管为 RPC 服务，同时旁听首个 hello。
   * 收到 hello 说明该槽位已被某个控制端占用 → 预热下一条，保证下个控制端无需等待。
   * （hello 由 core 正常处理，这里只是旁听，不干预协议。）
   */
  function attachWithDemandTracking(s: WebSocket): void {
    const slot = [...slots.values()].find((x) => x.ws === s);
    const listener = (raw: { toString(): string }): void => {
      if (slot?.serving) return;
      let msg: { method?: string };
      try {
        msg = JSON.parse(raw.toString()) as { method?: string };
      } catch {
        return;
      }
      if (msg.method === 'hello') {
        if (slot) slot.serving = true;
        log('info', `槽位 ${slot?.id ?? '?'} 已被控制端占用，预热下一条`);
        s.off('message', listener);
        ensureWarm(maxSlots);
      }
    };
    s.on('message', listener);
    core.attach(s, 'hub');
  }

  ensureWarm();

  return {
    isRegistered: () => [...slots.values()].some((s) => s.registered),
    slots: () =>
      [...slots.values()].map((s) => ({ id: s.id, registered: s.registered, serving: s.serving })),
    stop: () => {
      stopped = true;
      for (const slot of slots.values()) {
        if (slot.timer) clearTimeout(slot.timer);
        try {
          slot.ws?.close();
        } catch {
          /* 忽略 */
        }
      }
      slots.clear();
    },
  };
}
