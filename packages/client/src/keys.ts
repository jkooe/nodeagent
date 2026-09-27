import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateKeyPair, keyId, type KeyPairB64 } from '@nodeagent/protocol';
import { configDir } from './config.js';

/** 持久化的控制端密钥（含元信息）。 */
export interface StoredKeys extends KeyPairB64 {
  client_id: string;
  /** 公钥指纹（前 16 位 hex），便于在 ACL 中核对 */
  key_id: string;
  created_at: number;
}

export function keysFilePath(): string {
  return join(configDir(), 'keys', 'ed25519.json');
}

export function loadKeys(): StoredKeys | null {
  const p = keysFilePath();
  if (!existsSync(p)) return null;
  const keys = JSON.parse(readFileSync(p, 'utf8')) as StoredKeys;
  // 私钥优先取环境变量，便于 CI / 临时场景注入
  const envPriv = process.env['NODEAGENT_PRIVATE_KEY'];
  if (envPriv) keys.privateKey = envPriv;
  return keys;
}

/** 生成并落盘新密钥对（600 权限）。私钥永不外传。 */
export function createKeys(clientId: string): StoredKeys {
  const pair = generateKeyPair();
  const keys: StoredKeys = {
    ...pair,
    client_id: clientId,
    key_id: keyId(pair.publicKey),
    created_at: Date.now(),
  };
  const p = keysFilePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows 忽略 */
  }
  return keys;
}
