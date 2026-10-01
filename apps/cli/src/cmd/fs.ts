import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path, { join } from 'node:path';
import {
  NodeAgentClient,
  loadMacroFile,
  runMacro,
  ClientError,
  loadConfig,
  saveConfig,
  configPath,
  toWsUrl,
  loadKeys,
  createKeys,
  keysFilePath,
  discoverOnce,
  resolveTarget,
  resolveNodeSelector,
  emptyConfig,
  type ClientConfig,
  type ResolvedTarget,
  type NodeProfile,
} from '@nodeagent/client';
import {
  CapabilityNames,
  matchPattern,
  DEFAULT_DISCOVERY_PORT,
  type CapabilityDescriptor,
  type InvokeResult,
} from '@nodeagent/protocol';
import {
  callAndPrint,
  fail,
  getClientConfig,
  humanSize,
  printJson,
  riskIcon,
  withClient,
  withClientDirect,
} from '../core.js';
import { CHUNK_BYTES, type Options } from '../types.js';

// CLI 命令组：cmd/fs.ts
export async function cmdLs(pathArg: string | undefined, opts: Options): Promise<void> {
  if (!pathArg) fail('用法: nodeagent ls <远端路径> [--recursive] [--pattern "*.log"]');
  const args: Record<string, unknown> = { path: pathArg };
  if (opts.recursive) args['recursive'] = true;
  if (opts.pattern) args['pattern'] = opts.pattern;

  await withClient((c) =>
    callAndPrint(c, CapabilityNames.FsList, args, opts.json, (data) => {
      const d = data as {
        entries: Array<{ name: string; type: string; size: number; mtime: number }>;
        total: number;
        truncated: boolean;
      };
      for (const e of d.entries) {
        const icon = e.type === 'dir' ? '📁' : '📄';
        const when = new Date(e.mtime).toLocaleString('zh-CN');
        console.log(`  ${icon} ${e.name.padEnd(34)} ${humanSize(e.size).padStart(10)}  ${when}`);
      }
      console.log(`\n共 ${d.total} 项${d.truncated ? '（已截断，可加 --pattern 过滤）' : ''}`);
    }),
  );
}

export async function cmdStat(pathArg: string | undefined, opts: Options): Promise<void> {
  if (!pathArg) fail('用法: nodeagent stat <远端路径>');
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.FsStat, { path: pathArg }, opts.json, (data) => {
      const d = data as { path: string; type: string; size: number; mtime: number; exists: boolean };
      if (!d.exists) {
        console.log(`✗ 不存在: ${d.path}`);
        return;
      }
      console.log(`  路径 : ${d.path}`);
      console.log(`  类型 : ${d.type}`);
      console.log(`  大小 : ${humanSize(d.size)}`);
      console.log(`  修改 : ${new Date(d.mtime).toLocaleString('zh-CN')}`);
    }),
  );
}

export async function cmdCat(pathArg: string | undefined, opts: Options): Promise<void> {
  if (!pathArg) fail('用法: nodeagent cat <远端路径> [--out 本地文件]');
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.FsRead, { path: pathArg, encoding: 'utf8' }, opts.json, (data) => {
      const d = data as { data: string; bytes: number; total_bytes: number; eof: boolean };
      if (opts.out) {
        writeFileSync(opts.out, d.data, 'utf8');
        console.log(`✓ 已保存 ${opts.out}（${d.bytes} 字节${d.eof ? '' : '，文件较大仅首块，请用 pull 下载完整文件'}）`);
        return;
      }
      process.stdout.write(d.data);
      if (!d.eof) console.log(`\n\n… 仅显示首 ${humanSize(d.bytes)}（共 ${humanSize(d.total_bytes)}），完整下载请用 pull`);
    }),
  );
}

export async function cmdPull(remote: string | undefined, opts: Options): Promise<void> {
  if (!remote) fail('用法: nodeagent pull <远端路径> [--out 本地文件]');
  const local = opts.out ?? remote.split(/[\\/]/).pop() ?? 'download.bin';

  await withClient(async (c) => {
    const statRes = await c.invoke(CapabilityNames.FsStat, { path: remote });
    if (statRes.status !== 'ok') fail(`读取远端信息失败: ${statRes.error?.message}`);
    const st = statRes.data as { exists: boolean; type: string; size: number };
    if (!st.exists) fail(`远端文件不存在: ${remote}`);
    if (st.type === 'dir') fail(`目标是目录，不是文件: ${remote}（先用 ls 查看）`);

    const tmp = `${local}.nodeagent-part`;
    const fd = openSync(tmp, 'w');
    let offset = 0;
    try {
      for (;;) {
        const r = await c.invoke(CapabilityNames.FsRead, {
          path: remote,
          encoding: 'base64',
          offset,
          max_bytes: CHUNK_BYTES,
        });
        if (r.status !== 'ok') fail(`下载失败: ${r.error?.name}: ${r.error?.message}`);
        const d = r.data as { data: string; bytes: number; eof: boolean };
        if (d.bytes > 0) writeSync(fd, Buffer.from(d.data, 'base64'));
        offset += d.bytes;
        if (d.eof || d.bytes === 0) break;
      }
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, local); // 原子落盘，避免半截文件
    console.log(`✓ 已下载 ${remote} → ${local}（${humanSize(offset)}）`);
  });
}

export async function cmdPush(local: string | undefined, remote: string | undefined, opts: Options): Promise<void> {
  if (!local || !remote) fail('用法: nodeagent push <本地文件> <远端路径> [--create-dirs]');
  let st;
  try {
    st = statSync(local);
  } catch {
    fail(`本地文件不存在: ${local}`);
  }
  if (!st.isFile()) fail(`不是文件: ${local}`);

  await withClient(async (c) => {
    const fd = openSync(local, 'r');
    let offset = 0;
    let first = true;
    try {
      while (offset < st.size) {
        const len = Math.min(CHUNK_BYTES, st.size - offset);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, offset);
        const r = await c.invoke(CapabilityNames.FsWrite, {
          path: remote,
          data: buf.toString('base64'),
          encoding: 'base64',
          append: !first,
          create_dirs: first && opts.createDirs === true,
        });
        if (r.status !== 'ok') fail(`上传失败: ${r.error?.name}: ${r.error?.message}`);
        offset += len;
        first = false;
      }
      if (st.size === 0) {
        const r = await c.invoke(CapabilityNames.FsWrite, {
          path: remote,
          data: '',
          create_dirs: opts.createDirs === true,
        });
        if (r.status !== 'ok') fail(`上传失败: ${r.error?.message}`);
      }
    } finally {
      closeSync(fd);
    }
    console.log(`✓ 已上传 ${local} → ${remote}（${humanSize(offset)}）`);
  });
}
