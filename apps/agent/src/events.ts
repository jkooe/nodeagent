import { watch, type FSWatcher } from 'node:fs';
import { exec } from 'node:child_process';
import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
// ⚠️ E-03：file watcher 必须与 fs.* 用**同一套**路径白名单守卫（否则 fs_roots 形同虚设）
import { guardPath } from './capabilities/fs.js';

type Args = Record<string, unknown>;

/**
 * 被控端事件订阅（v12 / E1+E2）。
 *
 * 三类 watcher：
 *   file    —— fs.watch 文件变动（增/删/改），支持递归
 *   process —— 轮询进程列表做差分，报「启动/退出」
 *   net     —— 轮询监听端口做差分，报「端口开/关」
 *
 * 两条出口（同时提供）：
 *   1) **推送**：通过 event 通知发给创建订阅的那条连接（低延迟、无需轮询）
 *   2) **环形缓冲 + 游标**：供无法接收推送的调用方（MCP）拉取
 */
export interface WatchEvent {
  seq: number;
  watch_id: string;
  kind: 'file' | 'process' | 'net';
  ts: number;
  action: string;
  target: string;
  detail?: string;
}

interface WatchRecord {
  id: string;
  kind: 'file' | 'process' | 'net';
  owner: string; // 连接标识，断开时清理
  /** 创建者的 client_id —— 跨控制端隔离的依据（E-01/E-02） */
  clientId: string;
  description: string;
  createdAt: number;
  count: number;
  /** 推送出口（由 server 注入） */
  emit: (evt: WatchEvent) => void;
  dispose: () => void;
}

const watches = new Map<string, WatchRecord>();
const buffer: WatchEvent[] = [];
const MAX_BUFFER = 500;
let seq = 0;
let dropped = 0;

function nextId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function push(rec: WatchRecord, action: string, target: string, detail?: string): void {
  seq += 1;
  const evt: WatchEvent = {
    seq,
    watch_id: rec.id,
    kind: rec.kind,
    ts: Date.now(),
    action,
    target,
    ...(detail ? { detail } : {}),
  };
  rec.count += 1;
  buffer.push(evt);
  if (buffer.length > MAX_BUFFER) {
    const overflow = buffer.length - MAX_BUFFER;
    buffer.splice(0, overflow);
    dropped += overflow;
  }
  try {
    rec.emit(evt);
  } catch {
    /* 推送失败不影响缓冲 */
  }
}

/** 简易 glob（仅支持 * 与 ?），用于文件名/进程名过滤。 */
function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    'i',
  );
  return re.test(value);
}

// ---------------- 各类型 watcher ----------------

function startFileWatch(
  rec: WatchRecord,
  path: string,
  recursive: boolean,
  pattern?: string,
): () => void {
  let watcher: FSWatcher;
  try {
    watcher = watch(path, { recursive, persistent: true });
  } catch (err) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `无法监控路径: ${path}`, {
      detail: String(err),
    });
  }
  watcher.on('change', (eventType, filename) => {
    const name = filename ? String(filename) : '';
    if (pattern && name && !globMatch(pattern, name)) return;
    push(rec, eventType === 'rename' ? 'created_or_removed' : 'modified', name || path);
  });
  watcher.on('error', (err) => {
    push(rec, 'watch_error', path, String(err));
  });
  return () => watcher.close();
}

function startProcessWatch(rec: WatchRecord, intervalMs: number, pattern?: string): () => void {
  let previous = new Set<string>();
  let first = true;
  const tick = (): void => {
    // Windows: tasklist / POSIX: ps（避免依赖额外包）
    const cmd =
      process.platform === 'win32'
        ? 'tasklist /fo csv /nh'
        : 'ps -eo comm= 2>/dev/null || ps -axo comm=';
    exec(cmd, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return;
      const names = new Set<string>();
      for (const line of stdout.split('\n')) {
        const raw = process.platform === 'win32' ? (line.split(',')[0] ?? '').replace(/"/g, '') : line.trim();
        const name = raw.trim();
        if (!name || name.toLowerCase() === 'image name') continue;
        if (pattern && !globMatch(pattern, name)) continue;
        names.add(name);
      }
      if (first) {
        previous = names;
        first = false;
        push(rec, 'baseline', `${names.size} 个进程`, '首次采样，仅建立基线不报差异');
        return;
      }
      for (const n of names) if (!previous.has(n)) push(rec, 'process_started', n);
      for (const n of previous) if (!names.has(n)) push(rec, 'process_exited', n);
      previous = names;
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function startNetWatch(rec: WatchRecord, intervalMs: number): () => void {
  let previous = new Set<string>();
  let first = true;
  const cmd =
    process.platform === 'win32'
      ? 'netstat -an'
      : 'netstat -an 2>/dev/null || ss -ltn';
  const tick = (): void => {
    exec(cmd, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return;
      const listening = new Set<string>();
      for (const line of stdout.split('\n')) {
        const m = /[:.](\d{2,5})\s+(LISTEN|LISTENING|ESTABLISHED)?/i.exec(line);
        const isListen = /LISTEN/i.test(line);
        if (m && isListen) listening.add(m[1]!);
      }
      if (first) {
        previous = listening;
        first = false;
        push(rec, 'baseline', `${listening.size} 个监听端口`, '首次采样，仅建立基线');
        return;
      }
      for (const p of listening) if (!previous.has(p)) push(rec, 'port_opened', `:${p}`);
      for (const p of previous) if (!listening.has(p)) push(rec, 'port_closed', `:${p}`);
      previous = listening;
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------------- 对外能力 ----------------

export interface WatchContext {
  /** 连接标识（用于断开时清理） */
  owner: string;
  /** 调用方 client_id（跨控制端隔离；缺省视为匿名，彼此可见） */
  clientId?: string;
  /** 该连接的推送出口 */
  emit: (evt: WatchEvent) => void;
}

/**
 * 该 watcher 是否属于 caller。
 *
 * 兼容性：`clientId` 为空（匿名 / 老客户端）时**不做隔离** —— 但只要有 client_id，
 * 隔离就必须生效：否则 B 控制端能看到甚至 `event.unwatch` 掉 A 的订阅（E-01/E-02 实测）。
 */
function ownedBy(rec: WatchRecord, callerId: string): boolean {
  if (!callerId) return true;
  return !rec.clientId || rec.clientId === callerId;
}

export async function eventWatch(args: Args, ctx: WatchContext): Promise<unknown> {
  const kind = args['kind'] as 'file' | 'process' | 'net';
  if (!['file', 'process', 'net'].includes(kind)) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `不支持的 kind: ${String(kind)}`);
  }
  const intervalMs = Math.max(1000, Math.min(60_000, (args['interval_ms'] as number | undefined) ?? 5000));
  const pattern = args['pattern'] as string | undefined;
  const id = nextId();
  const rec: WatchRecord = {
    id,
    kind,
    owner: ctx.owner,
    clientId: ctx.clientId ?? '',
    description: '',
    createdAt: Date.now(),
    count: 0,
    emit: ctx.emit,
    dispose: () => undefined,
  };

  if (kind === 'file') {
    const raw = args['path'] as string | undefined;
    if (!raw) throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'file 类型需要 path');
    // ⚠️ E-03（实测复现）：file watcher **必须**过 `guardPath`。
    //    原来 `fs.read` 会被 `fs_roots` 正确拦下，而 `event.watch` 用同一路径却畅通无阻
    //    —— 白名单形同虚设（可通过事件流观察白名单外的目录变动）。
    const path = guardPath(raw);
    const recursive = args['recursive'] === true;
    rec.dispose = startFileWatch(rec, path, recursive, pattern);
    rec.description = `文件变动 ${path}${recursive ? '（递归）' : ''}${pattern ? ` pattern=${pattern}` : ''}`;
  } else if (kind === 'process') {
    rec.dispose = startProcessWatch(rec, intervalMs, pattern);
    rec.description = `进程启停${pattern ? ` pattern=${pattern}` : ''} 每 ${intervalMs}ms`;
  } else {
    rec.dispose = startNetWatch(rec, intervalMs);
    rec.description = `监听端口开闭 每 ${intervalMs}ms`;
  }

  watches.set(id, rec);
  return { watch_id: id, kind, description: rec.description };
}

/** 取消订阅。**只有创建者（同 client_id）能取消** —— 否则任意控制端可掐掉别人的监控。 */
export async function eventUnwatch(args: Args, ctx?: WatchContext): Promise<unknown> {
  const id = args['watch_id'] as string;
  const rec = watches.get(id);
  if (!rec) return { removed: false };
  const callerId = ctx?.clientId ?? '';
  if (!ownedBy(rec, callerId)) {
    // 明确回报，而不是假装成功（也便于审计追查越权尝试）
    return { removed: false, reason: `订阅 ${id} 属于其他控制端，无权取消` };
  }
  rec.dispose();
  watches.delete(id);
  return { removed: true };
}

/** 列出订阅：**只列自己的**（含匿名创建的）。 */
export async function eventList(_args: Args, ctx?: WatchContext): Promise<unknown> {
  const callerId = ctx?.clientId ?? '';
  const mine = [...watches.values()].filter((w) => ownedBy(w, callerId));
  return {
    watches: mine.map((w) => ({
      watch_id: w.id,
      kind: w.kind,
      description: w.description,
      events: w.count,
      created_at: w.createdAt,
    })),
    buffered: buffer.length,
  };
}

/** 拉取事件：只回「属于本 client_id 的订阅」产生的事件。 */
export async function eventPoll(args: Args, ctx?: WatchContext): Promise<unknown> {
  const limit = Math.max(1, Math.min(500, (args['limit'] as number | undefined) ?? 50));
  const since = (args['since'] as number | undefined) ?? 0;
  const watchId = args['watch_id'] as string | undefined;
  const callerId = ctx?.clientId ?? '';
  // watch_id 显式指定时先验归属，避免「猜 id 就能读别人事件」
  if (watchId) {
    const rec = watches.get(watchId);
    if (rec && !ownedBy(rec, callerId)) {
      throw new CapabilityError(ErrorCodes.ACL_DENIED, `订阅 ${watchId} 属于其他控制端`, { watch_id: watchId });
    }
  }
  let list = buffer.filter((e) => e.seq > since);
  if (watchId) {
    list = list.filter((e) => e.watch_id === watchId);
  } else if (callerId) {
    const allowed = new Set(
      [...watches.values()].filter((w) => ownedBy(w, callerId)).map((w) => w.id),
    );
    list = list.filter((e) => allowed.has(e.watch_id));
  }
  const sliced = list.slice(0, limit);
  const nextCursor = sliced.length > 0 ? sliced[sliced.length - 1]!.seq : since;
  return { events: sliced, next_cursor: nextCursor, dropped };
}

/** 连接断开时清理该连接创建的所有订阅（避免 watcher 泄漏）。 */
/** v2.0.0：当前事件订阅数（空闲断开的豁免判据之一）。 */
export function watchCount(): number {
  return watches.size;
}

export function disposeWatchesByOwner(owner: string): number {
  let n = 0;
  for (const [id, rec] of watches) {
    if (rec.owner === owner) {
      rec.dispose();
      watches.delete(id);
      n += 1;
    }
  }
  return n;
}
