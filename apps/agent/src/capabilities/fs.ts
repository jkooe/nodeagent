import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
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
  allowedRoots = (roots ?? []).map((r) => resolve(r));
}

export function guardPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'path 不能为空');
  }
  const abs = resolve(input);
  if (allowedRoots.length === 0) return abs;

  const ok = allowedRoots.some((root) => {
    if (abs === root) return true;
    const prefix = root.endsWith(sep) ? root : root + sep;
    return abs.startsWith(prefix);
  });
  if (!ok) {
    throw new CapabilityError(ErrorCodes.ACL_DENIED, `路径不在允许范围内: ${abs}`, {
      allowed_roots: allowedRoots,
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
      // 原子写：先写临时文件再重命名，避免中途失败留下半截文件
      const tmp = `${p}.nodeagent-tmp-${process.pid}`;
      writeFileSync(tmp, buf);
      renameSync(tmp, p);
    }
  } catch (err) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, `写入失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { written: buf.byteLength, total_bytes: statSync(p).size, path: p };
}
