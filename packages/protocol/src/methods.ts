/** 协议方法名（控制面）。 */
export const Methods = {
  /** 控制端 → 被控端：发起握手 */
  Hello: 'hello',
  /** 被控端 → 控制端：返回 nonce 挑战 */
  Challenge: 'challenge',
  /** 控制端 → 被控端：提交 HMAC 完成认证 */
  Auth: 'auth',
  /** 被控端 → 控制端：认证成功，返回能力清单 */
  AuthOk: 'auth_ok',
  /** 控制端 → 被控端：调用某项能力 */
  Invoke: 'invoke',
  /** 控制端 → 被控端：查询能力清单 */
  Capabilities: 'capabilities',
  /** 双向：心跳保活 */
  Ping: 'ping',
  /** 双向：心跳响应 */
  Pong: 'pong',
} as const;

export type MethodName = (typeof Methods)[keyof typeof Methods];

/** 协议版本（MAJOR.MINOR）。 */
export const PROTOCOL_VERSION = '1.0';

/** 局域网发现的默认 UDP 端口（被控端广播目标 = 控制端监听端口）。 */
export const DEFAULT_DISCOVERY_PORT = 8766;
