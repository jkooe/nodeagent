import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateKeyPair, keyId, type KeyPairB64 } from '@nodeagent/protocol';
import { configDir } from './config.js';
import { loadPrivateKey, savePrivateKey, type SecretRef } from './secret.js';

/** 持久化的控制端密钥（含元信息）。 */
export interface StoredKeys extends KeyPairB64 {
  client_id: string;
  /** 公钥指纹（前 16 位 hex），便于在 ACL 中核对 */
  key_id: string;
  created_at: number;
  /**
   * v11：私钥存储描述符。存在时落盘文件里**不含** privateKey
   * （macOS 在钥匙串 / Windows 为 DPAPI 密文）。老文件无此字段 → 明文，加载后自动迁移。
   */
  secret?: SecretRef;
}

export function keysFilePath(): string {
  return join(configDir(), 'keys', 'ed25519.json');
}

/** 迁移/降级告警只打一次，避免每条命令刷屏。 */
let warned = false;

function warnOnce(msg: string): void {
  if (warned) return;
  warned = true;
  console.error(msg);
}

function writeKeysFile(keys: StoredKeys): void {
  const p = keysFilePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows 忽略 */
  }
}

export function loadKeys(): StoredKeys | null {
  const p = keysFilePath();
  if (!existsSync(p)) return null;
  const keys = JSON.parse(readFileSync(p, 'utf8')) as StoredKeys;

  // 私钥优先取环境变量，便于 CI / 临时场景注入
  const envPriv = process.env['NODEAGENT_PRIVATE_KEY'];
  if (envPriv) {
    keys.privateKey = envPriv;
    return keys;
  }

  if (keys.secret && keys.secret.backend !== 'plain') {
    const plain = loadPrivateKey(keys.secret);
    if (plain) {
      keys.privateKey = plain;
      return keys;
    }
    // 后端不可用（换机/换用户/SYSTEM 上下文）→ 明确报错，不静默降级为「无密钥」
    throw new Error(
      `私钥后端不可用（${keys.secret.backend}）：可能是换了用户或加密上下文不匹配。` +
        '请重新运行: nodeagent keygen',
    );
  }

  // 兼容老版本：明文私钥 → 顺手迁移进系统密钥库
  if (keys.privateKey) {
    const ref = savePrivateKey(`ed25519:${keys.client_id}`, keys.privateKey);
    if (ref.backend === 'plain') {
      warnOnce('⚠️  本机密钥库不可用，私钥仍以明文保存（600 权限），可接受但不推荐');
    } else {
      const onDisk: StoredKeys = { ...keys, secret: ref };
      delete (onDisk as Partial<StoredKeys>).privateKey;
      writeKeysFile(onDisk);
      warnOnce(`✓ 私钥已迁移到系统密钥库（${ref.backend}），文件中不再保留明文`);
    }
  }
  return keys;
}

/** 生成并落盘新密钥对（600 权限）。私钥只进系统密钥库，文件不留明文。 */
export function createKeys(clientId: string): StoredKeys {
  const pair = generateKeyPair();
  const ref = savePrivateKey(`ed25519:${clientId}`, pair.privateKey);
  const memory: StoredKeys = {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey, // 本次进程内仍需使用
    client_id: clientId,
    key_id: keyId(pair.publicKey),
    created_at: Date.now(),
    secret: ref,
  };
  const onDisk: StoredKeys = { ...memory };
  if (ref.backend === 'plain') {
    warnOnce('⚠️  本机密钥库不可用，私钥将以明文保存（600 权限）');
  } else {
    delete (onDisk as Partial<StoredKeys>).privateKey;
    warnOnce(`✓ 私钥已存入系统密钥库（${ref.backend}）`);
  }
  writeKeysFile(onDisk);
  return memory;
}
