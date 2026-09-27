/** 协议错误码（对齐 DEVELOPMENT.md 附录 A）。 */
export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  PARAM_INVALID: -32602,
  AUTH_FAILED: -32401,
  AUTH_REQUIRED: -32402,
  CAPABILITY_NOT_FOUND: -32403,
  CAPABILITY_DISABLED: -32404,
  NODE_OFFLINE: -32405,
  ACL_DENIED: -32406,
  TIMEOUT: -32412,
  EXECUTION_FAILED: -32419,
  PROTOCOL_MISMATCH: -32420,
  UNSUPPORTED_PLATFORM: -32421,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** 错误码 → 名称。 */
export const ErrorNames: Record<number, string> = {
  [ErrorCodes.PARSE_ERROR]: 'E_PARSE_ERROR',
  [ErrorCodes.INVALID_REQUEST]: 'E_INVALID_REQUEST',
  [ErrorCodes.METHOD_NOT_FOUND]: 'E_METHOD_NOT_FOUND',
  [ErrorCodes.PARAM_INVALID]: 'E_PARAM_INVALID',
  [ErrorCodes.AUTH_FAILED]: 'E_AUTH_FAILED',
  [ErrorCodes.AUTH_REQUIRED]: 'E_AUTH_REQUIRED',
  [ErrorCodes.CAPABILITY_NOT_FOUND]: 'E_CAPABILITY_NOT_FOUND',
  [ErrorCodes.CAPABILITY_DISABLED]: 'E_CAPABILITY_DISABLED',
  [ErrorCodes.NODE_OFFLINE]: 'E_NODE_OFFLINE',
  [ErrorCodes.ACL_DENIED]: 'E_ACL_DENIED',
  [ErrorCodes.TIMEOUT]: 'E_TIMEOUT',
  [ErrorCodes.EXECUTION_FAILED]: 'E_EXECUTION_FAILED',
  [ErrorCodes.PROTOCOL_MISMATCH]: 'E_PROTOCOL_MISMATCH',
  [ErrorCodes.UNSUPPORTED_PLATFORM]: 'E_UNSUPPORTED_PLATFORM',
};

/** 协议错误对象。 */
export interface RpcError {
  code: number;
  name: string;
  message: string;
  data?: unknown;
}

/** 构造协议错误对象。 */
export function makeError(code: number, message: string, data?: unknown): RpcError {
  return { code, name: ErrorNames[code] ?? 'E_UNKNOWN', message, ...(data !== undefined ? { data } : {}) };
}

/** 业务异常：被控端能力执行层抛出的、需要转成 result.status='failed' 的错误。 */
export class CapabilityError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = ErrorNames[code] ?? 'E_UNKNOWN';
  }
}
