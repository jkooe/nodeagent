#!/usr/bin/env node
/**
 * console sidecar —— 把 `@nodeagent/client`（TS 客户端）暴露成 **JSON-RPC 2.0 over stdio**。
 *
 * ## 为什么需要它（选项 D：Tauri + Node sidecar）
 * console 的 Rust 壳若自己实现一份 client，就出现「Rust client 与 TS client 两套协议实现」——
 * 二者会静默漂移（改了一处漏另一处，且构建、单测都不报错）。sidecar 让 Rust 壳退化为
 * **进程管理者 + 消息转发者**，协议实现只剩 TS 一份。
 *
 * ## 协议（行分隔 JSON，每条消息一行）
 * 请求（Rust → 本进程）：
 *   {"jsonrpc":"2.0","id":1,"method":"connect","params":{url,key,client_id,insecure,...}}
 *   {"jsonrpc":"2.0","id":2,"method":"disconnect"}
 *   {"jsonrpc":"2.0","id":3,"method":"invoke","params":{capability,args,timeout_ms}}
 *   {"jsonrpc":"2.0","id":4,"method":"state"}
 * 响应（本进程 → Rust）：{"jsonrpc":"2.0","id":N,"result":{...}} 或 {"...","error":{code,message,data}}
 * 通知（无 id，本进程主动推）：
 *   {"jsonrpc":"2.0","method":"event","params":{"kind":"state","state":"connected"}}
 *   {"jsonrpc":"2.0","method":"event","params":{"kind":"log","message":"..."}}
 *   {"jsonrpc":"2.0","method":"event","params":{"kind":"agent_event","event":{...}}}
 *
 * ## 纪律
 * - **stdout 只写协议消息**（一行一条）；日志一律走 stderr —— 混入任何非 JSON 行都会让 Rust 侧解析失败。
 * - 任何异常都转成 error 响应，**绝不因单个请求崩掉进程**（Rust 侧会当成"连接断了"）。
 */

import { createInterface } from 'node:readline';
import { NodeAgentClient } from '@nodeagent/client';

/** @type {NodeAgentClient | null} */
let client = null;
/** 最近一次连接参数（重连/状态查询用）。 */
let lastOptions = null;

// ---------------- 输出（唯一写 stdout 的地方） ----------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result: result ?? null });
}

function fail(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

function notify(kind, payload) {
  send({ jsonrpc: '2.0', method: 'event', params: { kind, ...payload } });
}

/** 日志走 stderr（stdout 归协议专用）。 */
function log(level, message) {
  process.stderr.write(`[sidecar] ${level} ${message}\n`);
}

// ---------------- 状态快照 ----------------

function stateSnapshot() {
  if (!client) return { connected: false };
  return {
    connected: true,
    capabilities: client.listCapabilities(),
    authorized: client.listAuthorized(),
    agent_version: client.getAgentVersion() ?? null,
    agent_build: client.getAgentBuild() ?? null,
    peer_cert_fp: client.getPeerCertFingerprint(),
    client_id: lastOptions?.clientId ?? null,
    auth_mode: lastOptions?.authMode ?? 'psk',
  };
}

// ---------------- 方法实现 ----------------

const methods = {
  /** 建立连接并完成握手。返回与旧 Rust client 的 ConnectInfo 同构的元信息。 */
  async connect(params) {
    if (!params?.url || !params?.key) {
      throw Object.assign(new Error('connect 需要 url 与 key'), { code: -32602 });
    }
    // 已有连接先干净关闭，避免两条 ws 并存
    if (client) {
      try {
        client.close();
      } catch {
        /* 关不掉也无妨，下面会覆盖 */
      }
    }
    lastOptions = {
      url: String(params.url),
      clientId: String(params.client_id ?? 'console'),
      authMode: params.auth_mode === 'ed25519' ? 'ed25519' : 'psk',
    };

    client = new NodeAgentClient({
      url: lastOptions.url,
      key: String(params.key),
      clientId: lastOptions.clientId,
      insecure: params.insecure !== false,
      ...(params.cert_sha256 ? { certSha256: String(params.cert_sha256) } : {}),
      ...(params.auth_mode === 'ed25519' ? { authMode: 'ed25519' } : {}),
      ...(params.private_key ? { privateKey: String(params.private_key) } : {}),
      ...(params.hub ? { hub: params.hub } : {}),
      autoReconnect: params.auto_reconnect !== false,

      // 三个回调 → 三条通知（Rust 侧再桥接成 Tauri event）
      onStateChange: (state) => notify('state', { state }),
      onLog: (message) => notify('log', { message }),
      onEvent: (event) => notify('agent_event', { event }),
    });

    await client.connect();
    log('info', `已连接 ${lastOptions.url}（${lastOptions.clientId}）`);
    return stateSnapshot();
  },

  disconnect() {
    if (client) {
      try {
        client.close();
      } catch (err) {
        log('warn', `关闭连接时异常：${String(err)}`);
      }
      client = null;
    }
    return { connected: false };
  },

  async invoke(params) {
    // 「调用方式不对」（未连接 / 缺参数）→ 协议错误，Rust 侧能看到明确的 code
    if (!client) throw Object.assign(new Error('尚未连接（先调 connect）'), { code: -32005 });
    if (!params?.capability) {
      throw Object.assign(new Error('invoke 需要 capability'), { code: -32602 });
    }
    try {
      // 正常路径：被控端返回 InvokeResult（status: ok|failed）
      return await client.invoke(
        String(params.capability),
        (params.args ?? {}),
        typeof params.timeout_ms === 'number' ? params.timeout_ms : undefined,
      );
    } catch (err) {
      // ⚠️ 被控端对**未知能力 / ACL 拒绝 / 超时**是回 JSON-RPC error，client 会**抛异常**。
      // 若原样往上扔，前端就得处理两种形态（result.status 与 error），调用面不统一。
      // 故归一成 InvokeResult 的 failed 形态 —— 前端只判 status 即可。
      return {
        status: 'failed',
        error: {
          name: err?.rpcName ?? err?.name ?? 'E_INVOKE_FAILED',
          message: err instanceof Error ? err.message : String(err),
          ...(err?.data !== undefined ? { data: err.data } : {}),
        },
      };
    }
  },

  state: () => stateSnapshot(),
};

// ---------------- 主循环 ----------------

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;

  let req;
  try {
    req = JSON.parse(text);
  } catch {
    fail(null, -32700, 'JSON 解析失败');
    return;
  }

  const { id = null, method, params } = req ?? {};
  const fn = methods[method];
  if (typeof fn !== 'function') {
    fail(id, -32601, `未知方法: ${String(method)}`);
    return;
  }

  // 统一包裹：任何异常都变成 error 响应，绝不冒泡崩进程
  Promise.resolve()
    .then(() => fn(params ?? {}))
    .then((result) => ok(id, result))
    .catch((err) => {
      const code = typeof err?.code === 'number' ? err.code : -32603;
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `${String(method)} 失败：${msg}`);
      fail(id, code, msg, err?.data);
    });
});

rl.on('close', () => {
  // Rust 侧关闭 stdin（进程退出/窗口关闭）→ 干净收尾后退出
  methods.disconnect();
  log('info', 'stdin 关闭，sidecar 退出');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log('error', `未捕获异常：${err?.stack ?? String(err)}`);
});
process.on('unhandledRejection', (err) => {
  log('error', `未处理的 rejection：${String(err)}`);
});

log('info', `sidecar 就绪（pid=${process.pid}，node=${process.version}）`);
