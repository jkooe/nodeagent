import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { CapabilityError, ErrorCodes, matchPattern } from '@nodeagent/protocol';

type Args = Record<string, unknown>;

/** 小文件读取时才计算 sha256，避免大文件额外扫一遍 */
const HASH_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * 路径白名单（v5）。为空表示不限制（此时访问控制完全交给 v3 的能力级 ACL）。
 * 非空时，只允许访问这些根目录之下的路径 —— 用于「只暴露某个工作目录」的场景。
 */
let allowedRoots: string[] = [];

export function setFsRoots(roots: string[] | undefined): void {
  // 白名单根也做一次 realpath 归一：否则「配置里写的是软链」会与后面 realpath 后的路径对不上
  allowedRoots = (roots ?? []).map((r) => realPathBestEffort(resolve(r)));
}

/**
 * 尽力取真实路径（解析符号链接）。
 *
 * - 路径存在 → 直接 `realpathSync`
 * - 不存在（写入场景很常见）→ 向上找到**最近的已存在祖先**做 realpath，再把剩余段拼回去
 *
 * 这样即便目标文件本身还不存在，也能正确判断「它最终会落在哪里」，
 * 从而拦住「用软链接把访问点引到白名单之外」这一类绕过。
 */
function realPathBestEffort(abs: string): string {
  try {
    return realpathSync.native(abs);
  } catch {
    /* 继续向上找 */
  }
  const parts: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) return abs; // 到根了仍不存在 → 原样返回
    parts.unshift(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    try {
      const base = realpathSync.native(parent);
      return parts.length > 0 ? join(base, ...parts) : base;
    } catch {
      cur = parent;
    }
  }
}

/**
 * 路径白名单守卫（v5）。
 *
 * ⚠️ 两道防线，缺一不可：
 *   1. **解析符号链接后的真实路径**再做包含判断 —— 只比较字面路径时，
 *      `白名单/a_软链 → /etc` 这样的路径能直接穿出去（绕过 `fs_roots`）。
 *   2. 前缀比较必须带上分隔符（`/root` 不得匹配 `/rootX`），且大小写按平台归一
 *      （Windows 文件系统不区分大小写）。
 */
export function guardPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'path 不能为空');
  }
  const abs = resolve(input);
  if (allowedRoots.length === 0) return abs;

  const real = realPathBestEffort(abs);
  const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const target = norm(real);

  const ok = allowedRoots.some((rootRaw) => {
    const root = norm(rootRaw);
    if (target === root) return true;
    const prefix = root.endsWith(sep) ? root : root + sep;
    return target.startsWith(prefix);
  });
  if (!ok) {
    throw new CapabilityError(ErrorCodes.ACL_DENIED, `路径不在允许范围内: ${abs}`, {
      allowed_roots: allowedRoots,
      resolved: real,
    });
  }
  return abs;
}

// ---------------- fs.list ----------------

export async function fsList(args: Args): Promise<unknown> {
  const dir = guardPath(args['path'] as string);
  const recursive = args['recursive'] === true;
  const pattern = args['pattern'] as string | undefined;
  const maxEntries = (args['max_entries'] as number) ?? 500;

  let rootStat;
  try {
    rootStat = statSync(dir);
  } catch {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `无法访问目录: ${dir}`);
  }
  if (!rootStat.isDirectory()) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `不是目录: ${dir}`);
  }

  const entries: Array<{ name: string; path: string; type: string; size: number; mtime: number }> = [];
  // 多取一些以便判断是否截断；同时设硬上限，防止递归失控
  const hardLimit = maxEntries * 3;

  const walk = (d: string): void => {
    if (entries.length >= hardLimit) return;
    let items;
    try {
      items = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // 单个子目录无权限时跳过，不影响整体
    }
    for (const item of items) {
      if (entries.length >= hardLimit) return;
      const full = join(d, item.name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const type = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
      if (!pattern || matchPattern(pattern, item.name)) {
        entries.push({ name: item.name, path: full, type, size: st.size, mtime: Math.floor(st.mtimeMs) });
      }
      if (recursive && type === 'dir') walk(full);
    }
  };
  walk(dir);

  return {
    entries: entries.slice(0, maxEntries),
    total: entries.length,
    truncated: entries.length > maxEntries,
  };
}

// ---------------- fs.stat ----------------

export async function fsStat(args: Args): Promise<unknown> {
  const p = guardPath(args['path'] as string);
  if (!existsSync(p)) {
    return { path: p, type: 'other', size: 0, mtime: 0, exists: false };
  }
  const st = statSync(p);
  return {
    path: p,
    type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
    size: st.size,
    mtime: Math.floor(st.mtimeMs),
    exists: true,
  };
}

// ---------------- fs.read（分块） ----------------

export async function fsRead(args: Args): Promise<unknown> {
  const p = guardPath(args['path'] as string);
  const encoding: BufferEncoding = args['encoding'] === 'base64' ? 'base64' : 'utf8';
  const offset = Math.max(0, (args['offset'] as number) ?? 0);
  const maxBytes = (args['max_bytes'] as number) ?? 1024 * 1024;

  let st;
  try {
    st = statSync(p);
  } catch {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `无法访问文件: ${p}`);
  }
  if (st.isDirectory()) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, `目标是目录而非文件: ${p}`);
  }

  const total = st.size;
  const len = Math.max(0, Math.min(maxBytes, total - offset));
  const buf = Buffer.alloc(len);
  if (len > 0) {
    const fd = openSync(p, 'r');
    try {
      readSync(fd, buf, 0, len, offset);
    } finally {
      closeSync(fd);
    }
  }

  const result: Record<string, unknown> = {
    data: buf.toString(encoding),
    encoding: encoding === 'base64' ? 'base64' : 'utf8',
    offset,
    bytes: len,
    total_bytes: total,
    eof: offset + len >= total,
  };

  // 小文件首次读取时附带摘要，便于调用方校验完整性
  if (offset === 0 && total <= HASH_LIMIT_BYTES) {
    try {
      const whole = Buffer.alloc(total);
      const fd = openSync(p, 'r');
      try {
        readSync(fd, whole, 0, total, 0);
      } finally {
        closeSync(fd);
      }
      result['sha256'] = createHash('sha256').update(whole).digest('hex');
    } catch {
      /* 摘要失败不影响主返回 */
    }
  }

  return result;
}

// ---------------- fs.write（原子写 / 追加） ----------------

export async function fsWrite(args: Args): Promise<unknown> {
  const p = guardPath(args['path'] as string);
  const data = args['data'] as string;
  const encoding = args['encoding'] === 'base64' ? 'base64' : 'utf8';
  const append = args['append'] === true;
  const createDirs = args['create_dirs'] === true;

  if (typeof data !== 'string') {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'data 必须是字符串');
  }
  const buf = Buffer.from(data, encoding);

  const dir = dirname(p);
  if (!existsSync(dir)) {
    if (!createDirs) {
      throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `目录不存在: ${dir}`, {
        hint: '设置 create_dirs: true 可自动创建',
      });
    }
    mkdirSync(dir, { recursive: true });
  }

  try {
    if (append) {
      appendFileSync(p, buf);
    } else {
      // 原子写：先写临时文件再重命名，避免中途失败留下半截文件。
      // ⚠️ 临时名必须**唯一**：原来只用 PID，同一进程内并发写同一路径（或两个会话同时写）
      //    会互相踩对方的 tmp（先完成的 rename 走后，后一个 renameSync 会 ENOENT 失败）。
      const tmp = `${p}.nodeagent-tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      writeFileSync(tmp, buf);
      renameSync(tmp, p);
    }
  } catch (err) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `写入失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { written: buf.byteLength, total_bytes: statSync(p).size, path: p };
}
