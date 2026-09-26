import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 计算 HMAC-SHA256，返回 Base64。
 * @param key 预共享密钥
 * @param nonce 被控端下发的随机挑战值
 */
export function computeHmac(key: string, nonce: string): string {
  return createHmac('sha256', key).update(nonce, 'utf8').digest('base64');
}

/** 恒定时比较校验 HMAC，防时序侧信道。 */
export function verifyHmac(key: string, nonce: string, expected: string): boolean {
  const actual = Buffer.from(computeHmac(key, nonce), 'utf8');
  const given = Buffer.from(expected ?? '', 'utf8');
  if (actual.length !== given.length) return false;
  return timingSafeEqual(actual, given);
}

/** 生成随机 nonce（32 字节，Base64）。 */
export function generateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

/** 生成随机预共享密钥（32 字节，hex），用于初始化。 */
export function generateSharedKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex');
}
