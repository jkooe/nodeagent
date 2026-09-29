/**
 * nodeagentd —— CLI 常驻 daemon。
 *
 * 解决：CLI 每次命令重建 wss 连接（TLS 握手 + hello/challenge/auth 三步）开销 1~2s，
 * 批量操作浪费严重。daemon 持有与被控端的长连接池，CLI 经 Unix socket 一次往返转发。
 *
 * 协议（UDS，JSON lines）：
 *   → {"node":"win","capability":"system.info","args":{},"timeout_ms":60000}
 *   ← {"status":"ok","data":{...}} | {"status":"failed","error":{...}}
 *   ← {"status":"daemon_error","error":"..."}   // daemon 自身错误（回退直连）
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeAgentClient, ClientError, loadConfig, type NodeProfile } from '@nodeagent/client';
import { loadKeys } from '@nodeagent/client';

const SOCK = path.join(os.tmpdir(), 'nodeagentd.sock');
const POOL_IDLE_MS = 5 * 60 * 1000; // 空闲连接 5 分钟后关闭
const MAX_POOL = 8;

interface Pooled {
  client: NodeAgentClient;
  node: string;
  lastUsed: number;
  sweeper?: ReturnType<typeof setTimeout>;
}

const pool = new Map<string, Pooled>(); // key = nodeName

function profileKey(p: NodeProfile): string {
  return `${p.host}:${p.port}`;
}

async function getConnection(nodeName: string): Promise<NodeAgentClient> {
  const cfg = loadConfig();
  if (!cfg) throw new Error('尚未配置被控端');
  const profile = cfg.nodes[nodeName];
  if (!profile) throw new Error(`设备不存在: ${nodeName}`);

  const existing = pool.get(nodeName);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.client;
  }

  // 上限淘汰：关掉最久未用的
  if (pool.size >= MAX_POOL) {
    const oldest = [...pool.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest) {
      oldest[1].client.close();
      pool.delete(oldest[0]);
    }
  }

  const keys = profile.auth_mode === 'ed25519' ? loadKeys() : null;
  const client = new NodeAgentClient({
    url: `wss://${profileKey(profile)}`,
    key: profile.key ?? '',
    clientId: `daemon_${os.hostname()}`,
    insecure: profile.insecure,
    authMode: profile.auth_mode,
    privateKey: keys?.privateKey,
    hub: profile.hub ? { token: profile.hub.token, nodeId: profile.hub.node_id } : undefined,
    autoReconnect: true, // v4：断线自动重连（daemon 是长驻进程）
    onLog: (m) => console.error(`[${nodeName}] ${m}`),
  });
  await client.connect();
  const pooled: Pooled = { client, node: nodeName, lastUsed: Date.now() };
  pool.set(nodeName, pooled);
  return client;
}

function releaseIdle(): void {
  const now = Date.now();
  for (const [name, p] of pool) {
    if (now - p.lastUsed > POOL_IDLE_MS) {
      p.client.close();
      pool.delete(name);
      console.error(`[pool] 空闲释放 ${name}`);
    }
  }
  if (pool.size > 0) {
    setTimeout(releaseIdle, 60_000).unref();
  } else {
    setTimeout(releaseIdle, 60_000).unref();
  }
}

interface CliRequest {
  node: string;
  capability: string;
  args?: Record<string, unknown>;
  timeout_ms?: number;
}

export function main(): void {
  // 旧 socket 清理（daemon 崩溃残留）
  try {
    fs.unlinkSync(SOCK);
  } catch {
    /* 无残留 */
  }

  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        handle(JSON.parse(line) as CliRequest)
          .then((resp) => socket.write(JSON.stringify(resp) + '\n'))
          .catch((err) => {
            const resp =
              err instanceof ClientError
                ? { status: 'failed', error: { name: err.name, message: err.message } }
                : { status: 'daemon_error', error: String(err instanceof Error ? err.message : err) };
            socket.write(JSON.stringify(resp) + '\n');
          });
      }
    });
  });

  server.listen(SOCK, () => {
    console.error(`nodeagentd 已启动: ${SOCK}（连接池上限 ${MAX_POOL}，空闲 ${POOL_IDLE_MS / 1000}s 释放）`);
  });

  const sweep = setInterval(releaseIdle, 60_000);
  sweep.unref?.();

  // 优雅退出：关连接、删 socket
  const shutdown = (): void => {
    clearInterval(sweep);
    for (const p of pool.values()) p.client.close();
    try {
      fs.unlinkSync(SOCK);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handle(req: CliRequest): Promise<unknown> {
  if (!req.node) throw new Error('缺少 node');
  if (!req.capability) throw new Error('缺少 capability');
  const client = await getConnection(req.node);
  const result = await client.invoke(req.capability, req.args ?? {}, req.timeout_ms);
  pool.get(req.node)!.lastUsed = Date.now();
  if (result.status === 'failed') {
    return { status: 'failed', error: result.error };
  }
  return { status: 'ok', data: result.data };
}

// 支持 daemon 内直接列出池状态（调试用）
export function poolStatus(): Array<{ node: string; last_used_ago_ms: number }> {
  const now = Date.now();
  return [...pool.values()].map((p) => ({ node: p.node, last_used_ago_ms: now - p.lastUsed }));
}

if (process.argv[1] && process.argv[1].endsWith('nodeagentd')) {
  main();
}
