import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { agentDir } from './config.js';
import { buildInfo } from './capabilities/system.js';

/**
 * 最后已知可用版本（Last-Known-Good, LKG）—— 交付流水线 §6 的回滚锚点。
 *
 * ## 为什么需要（本项目特有风险，通用发布规范里没有）
 * 对 Web 服务，发布失败可以回滚、可以摘流量。对 nodeagent：
 * **回滚通道本身就是被更新的那个程序**。一次失败的更新会让一台物理不可达的
 * 远程设备永久脱管 —— 这是本项目最严重的上线失败形态。
 *
 * ## 记什么、什么时候记
 * 关键设计：**只在「本次启动确实起来了」之后才记**。
 *
 * 若在「更新刚写完」时就记 LKG，等于把还没验证的版本当成已知可用 ——
 * 那 LKG 就失去了意义。故由 `index.ts` 在服务器 listen 成功、打印完启动信息后
 * 调用 `recordLKG()`：此刻能走到这一行，说明脚本能被 Node 加载、配置能读、
 * 证书能签、端口能绑。**能启动 ≠ 功能全对，但能启动 = 至少不是「打死」状态。**
 *
 * ## 明确不做的事：自动回滚
 * 本文刻意**不实现**「启动失败自动回滚」。理由：
 *   - 远程设备上无法区分「更新本身坏了」与「网络抖动 / 端口被占 / 依赖服务没起」；
 *   - 自动回滚可能触发**回滚循环**（回滚→启动→又判定失败→再回滚），
 *     在无人值守设备上比「停在坏版本」更难恢复；
 *   - 被控端一旦自作主张改自己的程序，控制端将失去对「当前跑的是什么」的掌控。
 *
 * 因此 LKG 的定位是**给回滚提供确定的目标**，而不是替人做回滚决策：
 * 控制端 `nodeagent rollback` 读 LKG → 覆盖回入口文件 → 重启。
 */

export interface LkgRecord {
  /** 入口脚本（agent.mjs）的 sha256 前 12 位 —— 与 system.info 的 build.hash 同口径 */
  hash: string;
  bytes: number;
  script_path: string;
  /** 记录时刻（Unix ms） */
  recorded_at: number;
  /** 当时的 node 版本，便于判断「是不是 Node 运行时升级导致的」 */
  node_version: string;
  platform: string;
}

export function lkgFilePath(): string {
  return join(agentDir(), 'agent-lkg.json');
}

/**
 * 计算当前入口脚本指纹。
 * 与 `capabilities/system.ts` 的 buildInfo() 同口径（都是脚本内容的 sha256 前 12 位），
 * 故可与 `nodeagent info` 里的 `build.hash` 直接比对。
 */
function currentScriptHash(): { hash: string; bytes: number; path: string } | null {
  const p = process.argv[1] ?? '';
  if (!p) return null;
  try {
    const buf = readFileSync(p);
    return {
      hash: createHash('sha256').update(buf).digest('hex').slice(0, 12),
      bytes: buf.length,
      path: p,
    };
  } catch {
    return null;
  }
}

/**
 * 记录当前版本为 LKG。
 *
 * 任何失败都被吞掉 —— 写入失败不能影响启动。
 * @returns 写入的记录，失败返回 null
 */
export function recordLKG(): LkgRecord | null {
  const cur = currentScriptHash();
  if (!cur) return null;
  const rec: LkgRecord = {
    hash: cur.hash,
    bytes: cur.bytes,
    script_path: cur.path,
    recorded_at: Date.now(),
    node_version: process.version,
    platform: process.platform,
  };
  try {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(lkgFilePath(), `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
    return rec;
  } catch {
    return null;
  }
}

/** 读取 LKG 记录；不存在或损坏返回 null（不作任何猜测）。 */
export function readLKG(): LkgRecord | null {
  try {
    const raw = readFileSync(lkgFilePath(), 'utf8');
    const rec = JSON.parse(raw) as LkgRecord;
    if (!rec || typeof rec.hash !== 'string') return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * 当前版本与 LKG 是否一致。
 *
 * 用途：更新后复核 —— 若「当前 hash ≠ LKG」且刚做过更新，
 * 说明新版本**尚未被证明能启动**，控制端应暂缓放量到其余设备（交付流水线 §6 分批策略）。
 */
export function lkgStatus(): {
  lkg: LkgRecord | null;
  current_hash: string | null;
  matches: boolean;
  /** LKG 与当前版本的字节差，便于快速判断是「升级」还是「回退」 */
  byte_delta: number | null;
} {
  const lkg = readLKG();
  const cur = currentScriptHash();
  const current_hash = cur?.hash ?? null;
  return {
    lkg,
    current_hash,
    matches: !!lkg && lkg.hash === current_hash,
    byte_delta: lkg && cur ? cur.bytes - lkg.bytes : null,
  };
}

/** 供审计/排障：LKG 文件是否存在及其大小（不读内容，避免大文件 IO）。 */
export function lkgFileInfo(): { path: string; exists: boolean; bytes: number } {
  const p = lkgFilePath();
  try {
    return { path: p, exists: true, bytes: statSync(p).size };
  } catch {
    return { path: p, exists: false, bytes: 0 };
  }
}

/** 让 system.info 能顺带暴露构建指纹（与 buildInfo 同源，避免两处口径漂移）。 */
export { buildInfo };
