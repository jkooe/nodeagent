import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import selfsigned from 'selfsigned';
import { certFingerprint } from '@nodeagent/protocol';
import { agentDir } from './config.js';

export interface TlsMaterial {
  cert: string;
  key: string;
}

/**
 * 确保自签证书存在（首次生成并缓存到 ~/.nodeagent/certs/）。
 * v1 用自签证书做传输加密；控制端可校验证书指纹或临时跳过校验。
 */
export function ensureCert(): TlsMaterial {
  const dir = join(agentDir(), 'certs');
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');

  if (existsSync(certPath) && existsSync(keyPath)) {
    return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
  }

  mkdirSync(dir, { recursive: true });
  const pems = selfsigned.generate([{ name: 'commonName', value: 'nodeagent' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
  });
  writeFileSync(certPath, pems.cert);
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private };
}

/**
 * 当前证书的 SHA256 指纹（hex，64 位）。
 *
 * 用途：控制端**钉住**这个指纹（v21 第一批加固）—— 自签证书没有 CA 可信链，
 * 唯一能证明"还是那台被控端"的办法就是指纹比对。install.ps1 会用 .NET 算同一值
 * 印给操作者带外核对。
 */
export function currentCertFingerprint(): string | null {
  const certPath = join(agentDir(), 'certs', 'cert.pem');
  try {
    if (!existsSync(certPath)) return null;
    return certFingerprint(readFileSync(certPath, 'utf8'));
  } catch {
    return null;
  }
}
