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
 *   {"jsonrpc":"2.0","id":5,"method":"check_update","params":{console_version,url?}}
 *   {"jsonrpc":"2.0","id":6,"method":"download","params":{url,sha256,dest}}
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
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
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

/**
 * 比较两个 `x.y.z` 版本号：a > b 返回正、相等返回 0、a < b 返回负。
 *
 * 按**数值**逐段比较，不做字符串比较 —— 否则 `"2.0.10" < "2.0.9"`（字符串序），
 * 到两位数的补丁号时会误判「无更新」。
 */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

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

  /**
   * 检查更新：拉项目最新 Release 的 `latest.json`，与本应用版本比对。
   *
   * ## 为什么放在 sidecar 而不是 Rust 壳
   * 本壳的既定分工是「**进程管理 + 消息转发**，协议与 IO 逻辑集中在 Node 一侧」
   * （见文件头注释）。更新检查要做 HTTPS + JSON + 后续大概率还要下载文件校验哈希，
   * 在 Rust 侧等于再引一套 HTTP 栈；而 Node 有内置 `fetch`，一行到位。**单一实现**优先。
   *
   * `latest.json` 由发版脚本产出（含 version / commit / agent.url / agent.sha256），
   * 走 `releases/latest/download/` 这个**稳定别名**，无需调 GitHub API、不占速率配额。
   */
  async check_update(params) {
    const consoleVersion = String(params?.console_version ?? '0.0.0');
    const url =
      params?.url ??
      'https://github.com/jkooe/nodeagent/releases/latest/download/latest.json';

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    let meta;
    try {
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok) {
        throw new Error(`拉取 latest.json 失败：HTTP ${res.status} ${res.statusText}`);
      }
      meta = await res.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(new Error(`检查更新失败：${msg}（地址 ${url}）`), {
        data: { url, hint: '若本机网络无法直连 GitHub，可在被控端配置里改用镜像地址' },
      });
    } finally {
      clearTimeout(timer);
    }

    const latest = String(meta?.version ?? '');
    if (!latest) {
      throw new Error('latest.json 缺少 version 字段（发版产物异常）');
    }
    const agent = meta?.agent ?? {};
    return {
      console_version: consoleVersion,
      latest_version: latest,
      has_update: cmpVersion(latest, consoleVersion) > 0,
      published_at: meta?.built_at ?? null,
      commit: meta?.commit ?? null,
      capabilities: meta?.capabilities ?? null,
      agent: {
        url: agent.url ?? null,
        sha256: agent.sha256 ?? null,
        bytes: agent.bytes ?? null,
      },
      release_url: `https://github.com/jkooe/nodeagent/releases/tag/v${latest}`,
      source: url,
      checked_at: Date.now(),
    };
  },

  /**
   * 下载文件并做 sha256 校验（校验不通过**不落盘**，避免半成品污染数据目录）。
   * 供「更新本机被控端」使用。
   */
  async download(params) {
    const url = String(params?.url ?? '');
    const expect = String(params?.sha256 ?? '').toLowerCase();
    const dest = String(params?.dest ?? '');
    if (!url || !dest) {
      throw Object.assign(new Error('download 需要 url 与 dest'), { code: -32602 });
    }
    if (!/^[0-9a-f]{12,64}$/.test(expect)) {
      throw Object.assign(
        new Error('download 需要 sha256（12~64 位十六进制）—— 不校验哈希等于接受任意内容'),
        { code: -32602 },
      );
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 300_000);
    let buf;
    try {
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw new Error(`下载失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== expect && !got.startsWith(expect)) {
      throw Object.assign(new Error('哈希校验失败，已丢弃（未写入任何文件）'), {
        data: { expected: expect.slice(0, 12), actual: got.slice(0, 12), bytes: buf.length },
      });
    }

    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    // 写后复核：防止截断/半写（磁盘满等）
    const written = createHash('sha256')
      .update(await readFile(dest))
      .digest('hex');
    if (written !== got) {
      await unlink(dest).catch(() => {});
      throw new Error('写入后校验不一致，已删除（请检查磁盘空间）');
    }
    return { path: dest, sha256: got, bytes: buf.length };
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
