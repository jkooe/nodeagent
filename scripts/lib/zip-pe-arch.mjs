#!/usr/bin/env node
/**
 * 交付物级断言：直读 zip 内的可执行文件、取 PE 头判断目标架构。
 *
 * 为什么单独成模块（2026-10-11 事故复盘）：
 *   `nodeagent-win-arm64.zip` 里曾装进 x64 的 `node.exe`，而该包在 ARM Windows 上
 *   **能启动、能 listen，只是 TLS 握手不完成**（控制端只见 E_TIMEOUT）——
 *   单测、CI、macOS 侧全都抓不到，两个公开包内 `node.exe` 的 sha256 还完全相同。
 *   打包流程内部（pack.mjs）已有断言，但那仍是「中间逻辑」的断言；
 *   真正该钉死的是**交付物本身**。故这里只做一件事：解出最终 zip 里的 exe，读 PE 头。
 *
 * 实现约束：只用 Node 内置能力（`node:zlib` 手解 zip）。
 * 不依赖 `unzip` / `Expand-Archive` —— Windows runner 上没有 unzip，
 * 而发版与 CI 都要在 Windows 上跑。
 *
 * 自检用法：
 *   node scripts/lib/zip-pe-arch.mjs <zip路径> <x64|arm64>
 *   （退出码 0 = 架构相符；1 = 不符；2 = 读不了文件/不是有效 zip）
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

/** PE `Machine` 字段 → 人类可读名 */
export const PE_MACHINE = { 0x8664: 'x86-64', 0xaa64: 'ARM64', 0x14c: 'i386' };
/** 本项目的架构标识 → 期望的 PE Machine */
export const ARCH_MACHINE = { x64: 0x8664, arm64: 0xaa64 };

/** 从 zip 中取出指定条目的内容（支持 stored / deflate；zip64 不适用本仓产物） */
export function readZipEntry(zipPath, entryName) {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`未找到 EOCD（不是有效 zip？）: ${zipPath}`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`中央目录签名异常: ${zipPath}`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === entryName) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip 内未找到条目 ${entryName}: ${zipPath}`);
}

/** 读 PE 头的 Machine 字段 */
export function peMachine(buf) {
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('不是有效的 PE 文件');
  return buf.readUInt16LE(peOff + 4);
}

/**
 * 校验 zip 内条目的架构。
 * @returns {{ok:boolean, got:number, want:number, gotName:string, wantName:string}}
 */
export function checkZipArch(zipPath, arch, entryName = 'node.exe') {
  const want = ARCH_MACHINE[arch];
  if (!want) throw new Error(`未知架构标识: ${arch}（可选 ${Object.keys(ARCH_MACHINE).join('/')}）`);
  const got = peMachine(readZipEntry(zipPath, entryName));
  return {
    ok: got === want,
    got,
    want,
    gotName: PE_MACHINE[got] ?? `0x${got.toString(16)}`,
    wantName: PE_MACHINE[want],
  };
}

// ---------- CLI 自检：可被人工/CI 直接调用 ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , zipPath, arch] = process.argv;
  if (!zipPath || !arch) {
    console.error('用法: node scripts/lib/zip-pe-arch.mjs <zip路径> <x64|arm64>');
    process.exit(2);
  }
  try {
    const r = checkZipArch(zipPath, arch);
    if (r.ok) {
      console.log(`✓ ${zipPath} → node.exe = ${r.gotName}（期望 ${arch}）`);
      process.exit(0);
    }
    console.error(`✗ ${zipPath} → node.exe = ${r.gotName}，但期望 ${arch}（${r.wantName}）`);
    process.exit(1);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(2);
  }
}
