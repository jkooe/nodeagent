/**
 * Hub 控制面消息。
 *
 * 配对成功后即进入**透传**模式 —— Hub 不再解析内容，
 * 控制端与被控端之间的鉴权/加密由各自的 v3 握手保证（端到端）。
 */

export interface HubAgentRegister {
  type: 'register';
  node_id: string;
  token: string;
  meta?: {
    platform?: string;
    version?: string;
    auth_mode?: string;
  };
}

export interface HubClientConnect {
  type: 'connect';
  node_id: string;
  token: string;
}

export interface HubListRequest {
  type: 'list';
  token: string;
}

export interface HubRegistered {
  type: 'registered';
  node_id: string;
}

export interface HubPaired {
  type: 'paired';
  node_id: string;
}

/**
 * Hub → 被控端：需要再开一条槽位（已有控制端占用全部现有连接）。
 * 被控端收到后应新增一条到 Hub 的连接并重新注册（同 node_id），
 * 使一名被控端可**并发服务多个控制端**（v12 / E3）。
 */
export interface HubNeedSlot {
  type: 'need_slot';
  /** 当前池中该节点的连接数（供被控端判断是否已达上限） */
  slots: number;
  /** 建议上限（被控端自行再兜一层） */
  max_slots: number;
}

export interface HubListResult {
  type: 'list.result';
  agents: Array<{
    node_id: string;
    platform?: string;
    connected_at: number;
    /** 是否已被某个控制端占用（兼容字段：任一槽位被占用即为 true） */
    paired: boolean;
    /** v12：槽位总数与已占用数 */
    slots?: number;
    paired_slots?: number;
  }>;
}

export interface HubError {
  type: 'error';
  code: 'E_HUB_AUTH' | 'E_NODE_OFFLINE' | 'E_NODE_BUSY' | 'E_BAD_REQUEST' | 'E_TOO_MANY_SLOTS';
  message: string;
}

export type HubInbound = HubAgentRegister | HubClientConnect | HubListRequest;
export type HubOutbound = HubRegistered | HubPaired | HubNeedSlot | HubListResult | HubError;
