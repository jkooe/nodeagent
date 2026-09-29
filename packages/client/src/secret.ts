import { execFileSync } from 'node:child_process';

/**
 * 系统密钥库封装（v11 / B1）。
 *
 * 目标：私钥不再以明文落在磁盘上。
 *   - macOS：Keychain。私钥只存系统钥匙串，JSON 文件里**不出现任何私钥痕迹**
 *   - Windows：DPAPI（CurrentUser 作用域）。密文写进 JSON 文件的 `private_key_protected`
 *   - 其他平台或操作失败：回退明文 + 告警 —— **绝不因密钥保护导致不可用**
 *
 * 存储描述符（写进 JSON，便于跨平台识别与迁移）：
 *   { backend: 'keychain', label: '<账户名>' } | { backend: 'dpapi', protected: '<b64>' } | { backend: 'plain' }
 */

const SERVICE = 'nodeagent';

export type SecretBackend = 'keychain' | 'dpapi' | 'plain';

export interface SecretRef {
  backend: SecretBackend;
  /** keychain: 账户名；dpapi: 密文（Base64） */
  label?: string;
  protected?: string;
}

function psEncoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPS(script: string): string | null {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-EncodedCommand', psEncoded(script)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const v = out.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// ---------- macOS Keychain ----------

function keychainPut(label: string, plain: string): boolean {
  try {
    execFileSync('security', [
      'add-generic-password',
      '-a',
      label,
      '-s',
      SERVICE,
      '-w',
      plain,
      '-U',
    ]);
    return true;
  } catch {
    return false;
  }
}

function keychainGet(label: string): string | null {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', label, '-s', SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const v = out.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function keychainDelete(label: string): void {
  try {
    execFileSync('security', ['delete-generic-password', '-a', label, '-s', SERVICE], {
      stdio: 'ignore',
    });
  } catch {
    /* 不存在即忽略 */
  }
}

// ---------- Windows DPAPI ----------

export function dpapiProtect(plain: string): string | null {
  if (process.platform !== 'win32') return null;
  const b64 = Buffer.from(plain, 'utf8').toString('base64');
  return runPS(
    'Add-Type -AssemblyName System.Security;' +
      `$b=[Convert]::FromBase64String('${b64}');` +
      "$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
      'Write-Output ([Convert]::ToBase64String($p))',
  );
}

export function dpapiUnprotect(cipherB64: string): string | null {
  if (process.platform !== 'win32') return null;
  return runPS(
    'Add-Type -AssemblyName System.Security;' +
      `$b=[Convert]::FromBase64String('${cipherB64}');` +
      "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
      'Write-Output ([Text.Encoding]::UTF8.GetString($p))',
  );
}

// ---------- 统一接口 ----------

/**
 * 保存私钥：按平台选后端，返回存储描述符。
 * 失败时返回 { backend: 'plain' }（调用方据此写明文并告警）。
 */
export function savePrivateKey(label: string, plain: string): SecretRef {
  if (process.platform === 'darwin') {
    if (keychainPut(label, plain)) return { backend: 'keychain', label };
    return { backend: 'plain' };
  }
  if (process.platform === 'win32') {
    const cipher = dpapiProtect(plain);
    if (cipher) return { backend: 'dpapi', protected: cipher };
    return { backend: 'plain' };
  }
  return { backend: 'plain' };
}

/** 读取私钥：按描述符取回明文；任何失败返回 null（调用方决定如何处理）。 */
export function loadPrivateKey(ref: SecretRef): string | null {
  if (ref.backend === 'keychain' && ref.label) return keychainGet(ref.label);
  if (ref.backend === 'dpapi' && ref.protected) return dpapiUnprotect(ref.protected);
  return null;
}

/** 清理后端密文（密钥轮换用）。 */
export function deletePrivateKey(ref: SecretRef): void {
  if (ref.backend === 'keychain' && ref.label) keychainDelete(ref.label);
}
