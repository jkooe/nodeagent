import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import selfsigned from 'selfsigned';
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
