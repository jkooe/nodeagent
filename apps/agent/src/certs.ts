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
export async function ensureCert(): Promise<TlsMaterial> {
  const dir = join(agentDir(), 'certs');
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');

  if (existsSync(certPath) && existsSync(keyPath)) {
    return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
  }

  mkdirSync(dir, { recursive: true });
  // selfsigned 5.x：`generate` 改为**异步**（旧版同步返回）。
  // 升级动因不是追新，而是安全：2.x 依赖 node-forge 1.4.0，
  // 该版本有 high 级 advisory 且**上游无修复版本**（patched_versions: None）；
  // 5.x 已整体换成 @peculiar/x509 + pkijs，node-forge 被彻底移除。
  // v5 把 `days` 换成了 `notAfterDate`（绝对时间），语义相同但必须换算 ——
  // 这是升级时的**静默不兼容点**：老写法编译期报 TS2353，能拦住；
  // 但若只改类型不改值，就会签出一个有效期不对的证书，运行期才暴露。
  const notAfterDate = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'nodeagent' }], {
    notAfterDate,
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
