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
import { type Options } from './types.js';

// CLI 共享运行时（客户端/守护进程代理/输出工具）
export function getClientConfig(): ClientConfig {
  const cfg = loadConfig();
  if (!cfg) {
    fail('尚未配置被控端。请先运行:\n  nodeagent connect <host> --port 8765 --key <密钥>');
  }
  return cfg;
}

/** 本次命令的临时目标设备（来自全局 --node）。 */
// v16：全局 --node 的临时覆盖。跨模块共享可变状态：ESM 的 import 绑定只读，
// 故一律经访问器读写（直接 import 变量再赋值会编译不过）。
let currentNodeOverride: string | undefined;

/** 设置本次命令的 --node 覆盖（由入口在解析参数后调用）。 */
export function setNodeOverride(v: string | undefined): void {
  currentNodeOverride = v;
}

/** 读取当前生效的 --node 覆盖。 */
export function getNodeOverride(): string | undefined {
  return currentNodeOverride;
}

// ---------- v10 daemon 转发 ----------

export const DAEMON_SOCK = path.join(os.tmpdir(), 'nodeagentd.sock');

interface DaemonResponse {
  status: 'ok' | 'failed' | 'daemon_error';
  data?: unknown;
  error?: { name: string; message: string } | string;
}

/** 经 daemon 转发一次能力调用（JSON lines over UDS）。 */


export function viaDaemon(node: string, capability: string, args: Record<string, unknown>, timeoutMs?: number): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const s = net.connect(DAEMON_SOCK);
    s.setTimeout(timeoutMs ?? 60_000);
    let buf = '';
    const failOnce = (err: Error): void => {
      s.destroy();
      reject(err);
    };
    s.once('error', failOnce);
    s.once('timeout', () => failOnce(new Error('daemon 转发超时')));
    s.once('connect', () => {
      s.write(JSON.stringify({ node, capability, args, timeout_ms: timeoutMs }) + '\n');
    });
    s.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        try {
          resolve(JSON.parse(buf.slice(0, idx)) as DaemonResponse);
        } catch (err) {
          failOnce(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        s.end();
      }
    });
  });
}

/** 「虚拟客户端」：invoke 转发给 daemon，业务错误原样返回、daemon 自身错误抛异常触发回退。 */

export function daemonProxyClient(nodeName: string): { invoke: NodeAgentClient['invoke'] } {
  return {
    async invoke<T>(capability: string, args: Record<string, unknown>, timeoutMs?: number) {
      const resp = await viaDaemon(nodeName, capability, args, timeoutMs);
      if (resp.status === 'daemon_error') {
        throw new Error(typeof resp.error === 'string' ? resp.error : resp.error?.message);
      }
      if (resp.status === 'failed') {
        const e = resp.error;
        return {
          status: 'failed' as const,
          error: typeof e === 'string' ? { name: 'E_EXECUTION_FAILED', message: e } : e,
        } as never;
      }
      return { status: 'ok' as const, data: resp.data } as never;
    },
  };
}

export async function withClient<T>(fn: (client: NodeAgentClient) => Promise<T>, nodeName?: string): Promise<T> {
  const cfg = getClientConfig();
  let target: ResolvedTarget;
  try {
    target = resolveTarget(cfg, nodeName ?? getNodeOverride());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const node = nodeName ?? getNodeOverride() ?? cfg.current;
  // v10 daemon 快路径：socket 存活则经 daemon 复用长连接（省 1~2s TLS+握手）
  if (node && existsSync(DAEMON_SOCK)) {
    try {
      return await fn(daemonProxyClient(node) as unknown as NodeAgentClient);
    } catch (err) {
      // daemon 自身错误（转发失败/超时）→ 静默回退直连；业务错误原样抛出
      if (!(err instanceof ClientError)) {
        return withClientDirect(fn, nodeName);
      }
      throw err;
    }
  }
  return withClientDirect(fn, nodeName);
}

export async function withClientDirect<T>(fn: (client: NodeAgentClient) => Promise<T>, nodeName?: string): Promise<T> {
  const cfg = getClientConfig();
  let target: ResolvedTarget;
  try {
    target = resolveTarget(cfg, nodeName ?? getNodeOverride());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const { profile, clientId } = target;
  const keys = profile.auth_mode === 'ed25519' ? loadKeys() : null;
  const client = new NodeAgentClient({
    url: toWsUrl(profile),
    key: profile.key ?? '',
    clientId,
    insecure: profile.insecure,
    authMode: profile.auth_mode,
    privateKey: keys?.privateKey,
    hub: profile.hub ? { token: profile.hub.token, nodeId: profile.hub.node_id } : undefined,
  });
  try {
    await client.connect();
    return await fn(client);
  } catch (err) {
    if (err instanceof ClientError) {
      fail(`${err.name}: ${err.message}`);
    }
    throw err;
  } finally {
    client.close();
  }
}

export function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** 调用能力并处理 status === 'failed' 的业务失败。 */

export async function callAndPrint(
  client: NodeAgentClient,
  capability: string,
  args: Record<string, unknown>,
  json: boolean,
  render: (data: unknown) => void,
  timeoutMs?: number,
): Promise<void> {
  const result = await client.invoke(capability, args, timeoutMs);
  if (result.status === 'failed') {
    fail(`${result.error?.name ?? 'E_EXECUTION_FAILED'}: ${result.error?.message ?? '执行失败'}`);
  }
  if (json) printJson(result.data);
  else render(result.data);
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return String(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function riskIcon(risk: string): string {
  return risk === 'high' ? '🔴' : risk === 'medium' ? '🟡' : '🟢';
}
