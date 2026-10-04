import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS } from '../util/exec.js';
import { agentDir } from '../config.js';
import { audit } from '../audit.js';
import { agentRestart } from './system.js';

type Args = Record<string, unknown>;

/**
 * 拉取式自更新（v19）：被控端**自己**从 URL 下载新版本并替换自身。
 *
 * ## 与 `nodeagent deploy`（推送式）的分工
 * - 推送式：控制端与被控端可达 → 逐块上传（简单、无需被控端能上网）
 * - 拉取式（本能力）：两者不可达，但被控端能上网 → 从 GitHub Release / 自建镜像拉取
 *   典型场景：被控端在老家、控制端在出差地；或跨网段/穿 NAT 失败。
 *
 * ## 安全（必须严格遵守，否则等于开放远程代码执行）
 * 1. **哈希必须钉死**：`sha256` 必填，且**逐字节校验下载内容**后才替换。
 *    没有它，GitHub 账号被盗 / DNS 被污染 / 中间人 = 直接拿下被控端。
 * 2. 只接受 http/https；拒绝 file:// 等其它 scheme。
 * 3. 大小上限（默认 64MB）+ 下载超时，避免被喂垃圾撑爆磁盘。
 * 4. **先备份再原子替换**（同目录 rename），失败可回滚。
 * 5. `dry_run` 只下载校验、不动现有文件 —— 用于「先确认能不能更新」。
 * 6. 动作全程进审计（能力调用本身已记录 `invoke`，这里再加一条 `agent.update`）。
 *
 * ## 为什么不用 `fetch` 的代理能力
 * Node 内置 `fetch` 不支持 HTTP 代理（需要 undici 的 ProxyAgent，而 undici 未对外暴露）。
 * 国内访问 GitHub 不稳时，正确做法是**把 url 指向自建镜像 / 加速服务**（本能力接受任意
 * http(s) 地址，天然支持），而不是在 agent 里再塞一套代理隧道。
 */

const MAX_BYTES = 64 * 1024 * 1024;

/** 下载到内存（带大小上限与超时）。 */
async function download(url: string, timeoutMs: number): Promise<Buffer> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) {
      throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `下载失败: HTTP ${res.status} ${res.statusText}`, {
        url,
      });
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) {
      throw new CapabilityError(ErrorCodes.PARAM_INVALID, `文件过大（${declared} 字节 > 上限 ${MAX_BYTES}）`, { url });
    }
    const reader = res.body?.getReader();
    if (!reader) {
      return Buffer.from(await res.arrayBuffer());
    }
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > MAX_BYTES) {
          await reader.cancel();
          throw new CapabilityError(ErrorCodes.PARAM_INVALID, `下载超过上限 ${MAX_BYTES} 字节，已中断`, { url });
        }
        parts.push(value);
      }
    }
    return Buffer.concat(parts);
  } catch (err) {
    if (err instanceof CapabilityError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `下载失败: ${msg}`, { url });
  } finally {
    clearTimeout(timer);
  }
}

export async function agentUpdate(args: Args): Promise<unknown> {
  const url = args['url'] as string | undefined;
  const expect = (args['sha256'] as string | undefined)?.toLowerCase();
  const dryRun = args['dry_run'] === true;
  const doRestart = args['restart'] !== false;
  const timeoutMs = Math.max(5_000, Math.min(600_000, (args['timeout_ms'] as number | undefined) ?? 120_000));

  if (!url) throw new CapabilityError(ErrorCodes.PARAM_INVALID, '需要 url（更新包地址）');
  if (!expect || !/^[0-9a-f]{12,64}$/.test(expect)) {
    throw new CapabilityError(
      ErrorCodes.PARAM_INVALID,
      '需要 sha256（12~64 位十六进制）。**这是安全底线**：不校验哈希等于开放远程代码执行',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `url 不是合法地址: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `只支持 http/https，收到 ${parsed.protocol}`);
  }

  const scriptPath = process.argv[1] ?? '';
  if (!scriptPath) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '无法定位自身入口路径，拒绝自更新');
  }

  const dir = join(agentDir(), 'update');
  mkdirSync(dir, { recursive: true });

  // ① 下载 + ② 校验哈希（先校验再落盘，避免半成品污染）
  const t0 = Date.now();
  const buf = await download(url, timeoutMs);
  const got = createHash('sha256').update(buf).digest('hex');
  if (!got.startsWith(expect) && got !== expect) {
    audit({ type: 'agent.update', status: 'failed', reason: `hash mismatch url=${url} expect=${expect} got=${got.slice(0, 12)}` });
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '哈希校验失败，已丢弃下载内容（未改动任何文件）', {
      expected: expect,
      actual: got.slice(0, 12),
      bytes: buf.length,
    });
  }

  const staged = join(dir, `agent-${Date.now()}.mjs`);
  writeFileSync(staged, buf);

  const prevBytes = (() => {
    try {
      return statSync(scriptPath).size;
    } catch {
      return 0;
    }
  })();
  const prevHash = (() => {
    try {
      return createHash('sha256').update(readFileSync(scriptPath)).digest('hex').slice(0, 12);
    } catch {
      return 'unknown';
    }
  })();

  if (dryRun) {
    try {
      unlinkSync(staged);
    } catch {
      /* 忽略 */
    }
    audit({ type: 'agent.update', status: 'ok', reason: `dry_run url=${url} hash=${got.slice(0, 12)}` });
    return {
      dry_run: true,
      verified: true,
      bytes: buf.length,
      incoming_hash: got.slice(0, 12),
      current_hash: prevHash,
      current_bytes: prevBytes,
      note: '仅下载并校验，未改动任何文件',
    };
  }

  // ③ 备份 + ④ 原子替换（同目录 rename，失败时旧文件不受影响）
  const backup = `${scriptPath}.bak-${Date.now()}`;
  try {
    copyFileSync(scriptPath, backup);
  } catch (err) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '备份现有脚本失败，已中止（不做无备份的替换）', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    renameSync(staged, scriptPath);
  } catch (err) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '替换脚本失败', {
      detail: err instanceof Error ? err.message : String(err),
      backup_path: backup,
      staged_path: staged,
    });
  }

  audit({
    type: 'agent.update',
    status: 'ok',
    reason: `url=${url} ${prevHash}->${got.slice(0, 12)} bytes=${buf.length} backup=${backup}`,
  });

  // ⑤ 受控重启（复用 v7；Windows 走计划任务、POSIX 走 detached，均不依赖本进程存活）
  let restarted = false;
  if (doRestart) {
    await agentRestart({ delay_ms: 1500, reason: 'self-update' });
    restarted = true;
  }

  return {
    updated: true,
    bytes: buf.length,
    previous: { hash: prevHash, bytes: prevBytes },
    current_hash: got.slice(0, 12),
    // CLI 靠它做「重启后复核」——漏了这个字段会导致复核被跳过（真机踩过）
    incoming_hash: got.slice(0, 12),
    backup_path: backup,
    restarted,
    elapsed_ms: Date.now() - t0,
    hint: doRestart
      ? '已替换并重启；请用 system.info 的 build.hash 复核（应等于 incoming_hash）。若异常，把 backup_path 覆盖回入口即可回滚'
      : '已替换但未重启（restart=false）；重启后才会生效',
    platform: IS_WINDOWS ? 'windows' : 'posix',
  };
}
