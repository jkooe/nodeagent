import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

/** Base64(DER) 编码的密钥对 —— 单行格式，便于写入配置。 */
export interface KeyPairB64 {
  /** Base64(SPKI DER) 公钥 */
  publicKey: string;
  /** Base64(PKCS8 DER) 私钥 */
  privateKey: string;
}

/** 生成 Ed25519 密钥对。 */
export function generateKeyPair(): KeyPairB64 {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/**
 * 对 nonce 原文签名（Ed25519 无需先做摘要），返回 Base64 签名。
 * 与消息级签名不同，这是握手专用的挑战-应答签名。
 */
export function signNonce(privateKeyB64: string, nonce: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return sign(null, Buffer.from(nonce, 'utf8'), key).toString('base64');
}

/** 验签；任何异常均视为失败（不抛出）。 */
export function verifyNonce(publicKeyB64: string, nonce: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(nonce, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** 公钥指纹（SHA-256 前 16 位 hex），用于标识与轮换追踪。 */
export function keyId(publicKeyB64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 16);
}
