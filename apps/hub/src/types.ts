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

export interface HubListResult {
  type: 'list.result';
  agents: Array<{ node_id: string; platform?: string; connected_at: number; paired: boolean }>;
}

export interface HubError {
  type: 'error';
  code: 'E_HUB_AUTH' | 'E_NODE_OFFLINE' | 'E_NODE_BUSY' | 'E_BAD_REQUEST';
  message: string;
}

export type HubInbound = HubAgentRegister | HubClientConnect | HubListRequest;
export type HubOutbound = HubRegistered | HubPaired | HubListResult | HubError;
