/**
 * 出站代理支持 —— 只为「检查更新 / 下载更新包」这两条 HTTPS 出网路径服务。
 *
 * ## 为什么必须自己实现（这是缺陷，不是优化）
 *
 * Node 内置 `fetch`（undici）**默认不读任何代理环境变量** —— 实测：设了 `HTTPS_PROXY`
 * 仍然 `fetch failed`。能开的只有 `NODE_USE_ENV_PROXY=1`（Node 22.x 实验性、24 正式），
 * 而它**只能读环境变量**，读不到 Windows 系统代理（WinINET）或 macOS 系统代理
 * —— 而中文用户用 Clash / v2rayN 时配置的恰恰是「系统代理」，不是环境变量。
 * 结果：境内用户即使代理一切正常，「检查更新」也**必然**报 `fetch failed`。
 * （真机取证 2026-10-13：VM 上 DNS 与 TCP 443 都通、但 `fetch failed`；同一台机器
 *   直连 GitHub 被阻断、经代理取 `latest.json` 返回 302。）
 *
 * 另外 `fetch(url, { dispatcher })` 也不通：`dispatcher` 必须是 undici 的 Dispatcher 实例，
 * 而 Node 没有把 undici 暴露成可导入的模块（只能整包 vendored 进来，那会把 sidecar
 * 从 227KB 撑胖一大截，且 undici 依赖 `.wasm` 解析器、esbuild 单文件打包有风险）。
 *
 * ## 做法
 *
 * 不用 `fetch`，改用 `node:http` / `node:https` 自己发请求：
 *   - **https 目标经代理**：先向代理发 `CONNECT host:443` 建隧道，再在隧道 socket 上做 TLS
 *     （通过 `createConnection` 交给 `http.request` —— 注意这里刻意用 `http` 而非 `https`，
 *      因为我们交出去的**已经是 TLS socket**，用 `https.request` 会二次握手）；
 *   - **http 目标经代理**：按 HTTP 代理规范发**绝对形态**请求行（`GET http://… HTTP/1.1`）；
 *   - **无代理**：与改动前一致，直连（走 `https.request`）。
 *
 * ## 代理来源优先级
 *
 *   ① `NA_PROXY`（显式覆盖，便于排查与将来做配置项）
 *   ② 目标协议对应的环境变量（`HTTPS_PROXY`/`https_proxy` → `ALL_PROXY`/`all_proxy` → …）
 *   ③ **系统代理**（Windows 读注册表 WinINET；macOS 读 `scutil --proxy`）
 *
 * `NO_PROXY` / `no_proxy` 命中的主机一律直连。只支持 **HTTP 代理**（`http(s)://`）——
 * HTTPS 目标经 HTTP 代理走 CONNECT，是通用做法；`socks5://` 会**明确**记一条 note
 * 而不是静默直连（静默正是本次缺陷最恶劣的地方）。
 *
 * ## 安全
 *
 * 只做「出站取数据」，不引入任何新依赖；TLS 证书默认校验，不提供跳过开关。
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFile } from 'node:child_process';

/** 代理来源优先级（按目标协议分列）。`NA_PROXY` 恒为第一优先。 */
const ENV_ORDER = {
  'https:': ['NA_PROXY', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'],
  'http:': ['NA_PROXY', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'],
};
const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'];
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const UA = 'nodeagent-console-sidecar';

/**
 * 把环境里/配置里写的各种代理形态归一成可用的 URL。
 *
 * 接受 `http://127.0.0.1:7890`、`127.0.0.1:7890`（补 `http://`）、带账密的 URL；
 * 其余（`socks5://`、空串、无法解析）返回 `null` —— 由调用方把「看到了但用不了」
 * 明确报出来，**不许静默直连**。
 *
 * @param {unknown} raw
 * @returns {URL | null}
 */
export function normalizeProxyUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u;
}

/** 代理 URL 的主机端口（缺省按代理自身协议补 80/443）。 */
function proxyEndpoint(u) {
  return { host: u.hostname, port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80 };
}

/** 代理 URL 里的账密 → `Proxy-Authorization` 头（没有则 null）。 */
function proxyAuthHeader(u) {
  if (!u.username) return null;
  const raw = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
  return 'Basic ' + Buffer.from(raw).toString('base64');
}

/**
 * `NO_PROXY` 命中判定。支持：精确主机、后缀（`example.com` 或 `.example.com` 都匹配
 * `a.example.com`）、`host:port`、`*`。大小写不敏感。
 *
 * ⚠️ 刻意**不支持 CIDR**（如 `169.254/16`）：本模块的目标只有公网域名，
 * 而 CIDR 主机名判定极易写错、错了就是「该走代理的没走」。遇到疑似 CIDR 条目
 * 由调用方记 note（见 `pickEnvProxy` 的 notes 语义）。
 *
 * @param {string} targetUrl
 * @param {string} noProxy
 * @returns {boolean}
 */
export function isBypassed(targetUrl, noProxy) {
  if (!noProxy) return false;
  let host;
  let port;
  try {
    const u = new URL(targetUrl);
    host = u.hostname.toLowerCase();
    port = u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return false;
  }
  for (const rawEntry of String(noProxy).split(',')) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let eHost = entry;
    let ePort = null;
    const i = entry.lastIndexOf(':');
    // 排除 IPv6 字面量（`[::1]:8080`）里的冒号误判
    if (i > 0 && !entry.slice(0, i).includes(':')) {
      eHost = entry.slice(0, i);
      ePort = entry.slice(i + 1);
    }
    if (ePort && ePort !== port) continue;
    const bare = eHost.replace(/^\./, '');
    if (!bare) continue;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/**
 * 从环境变量里挑代理（纯函数，便于单测）。
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} targetUrl
 * @returns {{ url: URL | null, source: string | null, notes: string[] }}
 */
export function pickEnvProxy(env, targetUrl) {
  let proto = 'https:';
  try {
    proto = new URL(targetUrl).protocol;
  } catch {
    /* 保持默认 */
  }
  const keys = ENV_ORDER[proto] ?? ENV_ORDER['https:'];
  const notes = [];
  for (const k of keys) {
    const v = env?.[k];
    if (!v) continue;
    const u = normalizeProxyUrl(v);
    if (u) return { url: u, source: k, notes };
    notes.push(`${k}=${String(v).trim()} 不是受支持的代理协议（仅支持 http/https 代理），已忽略`);
  }
  return { url: null, source: null, notes };
}

/**
 * 解析 macOS `scutil --proxy` 的输出。
 *
 * 形如：
 *   <dictionary> {
 *     HTTPSEnable : 1
 *     HTTPSPort : 7890
 *     HTTPSProxy : 127.0.0.1
 *     ExceptionsList : <array> { 0 : *.local  1 : 169.254/16 }
 *   }
 *
 * 注意 macOS 上 HTTPS 与 HTTP 是**分别开关**的；这里 https 优先，取不到再退 HTTP。
 * `ProxyAutoConfigEnable : 1`（PAC 自动配置脚本）**无法解析** —— 返回 notes 说明，
 * 让上层给出「请显式设 HTTPS_PROXY」这类可操作提示，而不是含糊的 fetch failed。
 *
 * @param {string} text
 * @returns {{ url: string | null, bypass: string, notes: string[] } | null}
 */
export function parseScutilProxy(text) {
  if (typeof text !== 'string' || !text.includes('{')) return null;
  const scalar = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm').exec(text);
    return m ? m[1].trim() : null;
  };
  const isOn = (v) => v === '1' || v === 'true';
  const notes = [];

  // ExceptionsList 是 <array> 块里的 “序号 : 值” 行 —— 收集成逗号分隔的绕过列表
  const bypass = [];
  const arrIdx = text.indexOf('ExceptionsList');
  if (arrIdx >= 0) {
    const body = text.slice(arrIdx, text.indexOf('}', arrIdx) + 1);
    const re = /^\s*\d+\s*:\s*(.+?)\s*$/gm;
    let m;
    while ((m = re.exec(body)) !== null) bypass.push(m[1].trim());
  }

  for (const [flag, hostKey, portKey, dflt] of [
    ['HTTPSEnable', 'HTTPSProxy', 'HTTPSPort', '443'],
    ['HTTPEnable', 'HTTPProxy', 'HTTPPort', '80'],
  ]) {
    if (!isOn(scalar(flag))) continue;
    const host = scalar(hostKey);
    if (!host) continue;
    const port = scalar(portKey) ?? dflt;
    return { url: `${host}:${port}`, bypass: bypass.join(','), notes };
  }

  if (isOn(scalar('ProxyAutoConfigEnable'))) {
    notes.push('系统代理使用 PAC 自动配置脚本（ProxyAutoConfigEnable=1），本程序无法解析脚本内容，已按「无代理」处理');
  }
  return { url: null, bypass: bypass.join(','), notes };
}

/**
 * 解析 Windows `reg query …\Internet Settings` 的输出。
 *
 * 形如（`REG_SZ` / `REG_DWORD` 是**类型名，不随系统语言变化**，可安全按 token 解析）：
 *     ProxyEnable    REG_DWORD    0x1
 *     ProxyOverride  REG_SZ       *.local;<local>
 *     ProxyServer    REG_SZ       127.0.0.1:7890     （也可能是 http=…;https=… 分协议形态）
 *
 * `ProxyEnable=0x0` 视为**显式关闭** → 无代理（哪怕 ProxyServer 有值）。
 * `<local>` 是「本机地址直连」的占位符，不是域名，从绕过列表里剔除。
 *
 * @param {string} text
 * @returns {{ url: string | null, bypass: string, notes: string[] } | null}
 */
export function parseRegQueryProxy(text) {
  if (typeof text !== 'string' || !text.includes('REG_')) return null;
  const value = (name) => {
    const m = new RegExp(`^\\s*${name}\\s+REG_(?:SZ|EXPAND_SZ|DWORD|BINARY)\\s+(.*?)\\s*$`, 'm').exec(text);
    return m ? m[1].trim() : null;
  };
  const notes = [];

  const enable = value('ProxyEnable');
  if (enable !== null && /^0x0+$/i.test(enable)) return { url: null, bypass: '', notes };

  const server = value('ProxyServer');
  if (!server) return { url: null, bypass: '', notes };

  const override = value('ProxyOverride');
  const bypass = override
    ? override
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && !/^<local>$/i.test(s))
        .join(',')
    : '';

  // 分协议形态：http=127.0.0.1:7890;https=127.0.0.1:7891 —— https 优先
  let url = server;
  if (server.includes('=')) {
    const map = new Map();
    for (const part of server.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) map.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
    }
    url = map.get('https') ?? map.get('http') ?? null;
    if (!url) notes.push(`系统代理仅配置了非 http(s) 协议（ProxyServer=${server}）`);
  }
  return { url, bypass, notes };
}

/** 跑一个只读命令，失败/超时一律返回 null（探测系统代理**绝不允许**把检查更新搞挂）。 */
function runQuiet(file, args) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      // windowsHide：本进程是被 CREATE_NO_WINDOW 拉起的「无控制台」进程，
      // 若再 spawn 控制台程序（reg.exe），Windows 会**新开一个控制台** → 黑窗闪一下。
      { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });
}

/**
 * 探测系统代理。`run` 可注入（单测用假 runner，不必真去读注册表）。
 *
 * @param {NodeJS.Platform} [platform]
 * @param {(file: string, args: string[]) => Promise<string | null>} [run]
 * @returns {Promise<{ url: string | null, bypass: string, notes: string[] } | null>}
 */
export async function detectSystemProxy(platform = process.platform, run = runQuiet) {
  try {
    if (platform === 'win32') {
      const out = await run('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      ]);
      return out ? parseRegQueryProxy(out) : null;
    }
    if (platform === 'darwin') {
      const out = await run('scutil', ['--proxy']);
      return out ? parseScutilProxy(out) : null;
    }
    // Linux：桌面环境各异（gsettings / 环境变量 / PAC），不做猜测 —— 只认环境变量
    return null;
  } catch {
    return null;
  }
}

/** 系统代理只探测一次（同一进程内结果不变；用户改代理需重启控制台）。 */
let systemProxyPromise;
export function systemProxy() {
  if (!systemProxyPromise) systemProxyPromise = detectSystemProxy().catch(() => null);
  return systemProxyPromise;
}

/** 单测用：清掉系统代理缓存。 */
export function __resetSystemProxyCache() {
  systemProxyPromise = undefined;
}

/**
 * 决议本次请求该用哪个代理。
 *
 * @param {{ targetUrl: string, env?: Record<string, string | undefined>, system?: unknown }} opts
 *        `system` 显式传入时不做探测（单测用）；传 `null` 表示「确认没有系统代理」。
 * @returns {Promise<{ proxy: URL | null, source: string | null, notes: string[] }>}
 */
export async function resolveProxy({ targetUrl, env = process.env, system } = {}) {
  const notes = [];
  const noProxy = NO_PROXY_KEYS.map((k) => env?.[k]).find(Boolean) ?? '';
  if (noProxy && isBypassed(targetUrl, noProxy)) {
    return { proxy: null, source: null, notes: [`目标命中 NO_PROXY=${noProxy}，按直连处理`] };
  }

  const fromEnv = pickEnvProxy(env ?? {}, targetUrl);
  notes.push(...fromEnv.notes);
  if (fromEnv.url) return { proxy: fromEnv.url, source: fromEnv.source, notes };

  const sys = system === undefined ? await systemProxy() : system;
  if (sys?.url) {
    notes.push(...(sys.notes ?? []));
    if (sys.bypass && isBypassed(targetUrl, sys.bypass)) {
      notes.push(`目标命中系统代理的绕过列表（${sys.bypass}），按直连处理`);
      return { proxy: null, source: null, notes };
    }
    const u = normalizeProxyUrl(String(sys.url));
    if (u) return { proxy: u, source: 'system', notes };
    notes.push(`系统代理 ${sys.url} 不受支持（仅支持 http/https 代理），已按直连处理`);
    return { proxy: null, source: null, notes };
  }
  notes.push(...(sys?.notes ?? []));
  return { proxy: null, source: null, notes };
}

/**
 * 造一个 `createConnection`：向代理发 CONNECT 建隧道，https 目标再在隧道上叠 TLS。
 *
 * 返回的 socket 交给 `http.request` 使用（那已经是 TLS socket，故用 `http` 模块）。
 *
 * ## ⚠️ 为什么必须自己管 `signal`（真机踩过）
 * `createConnection` 的回调**返回之前**，外层 `http.request` 还没建立 —— 此时
 * 外层请求上的 `signal` / `timeout` 都**无人受理**。真机形态：代理 TCP 能连上、却对
 * CONNECT 或随后的 TLS 握手**永不响应**，于是「75s 超时」形同虚设，实际挂了 109s。
 * 所以：CONNECT 请求要带 signal，**拿到 socket 与 tlsSock 之后还要自己挂 abort**，
 * 失败/成功时都要摘掉监听，避免泄漏与误伤。
 */
export function tunnelConnection(proxy, target, signal) {
  const pe = proxyEndpoint(proxy);
  return (_opts, cb) => {
    let settled = false;
    let tunnelSock = null;
    let tlsSock = null;

    const detach = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (tunnelSock) tunnelSock.removeListener('error', onSockError);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      detach();
      // 半开的隧道必须销毁，否则这个悬挂连接会一直占着（用户点几次就攒一堆）
      try {
        tlsSock?.destroy();
        tunnelSock?.destroy();
      } catch {
        /* 已经没了 */
      }
      cb(err);
    };
    const onSockError = (e) => fail(e);
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error('请求已中止'));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const port = target.port || (target.protocol === 'https:' ? 443 : 80);
    const headers = { host: `${target.hostname}:${port}` };
    const auth = proxyAuthHeader(proxy);
    if (auth) headers['proxy-authorization'] = auth;

    const req = http.request({
      host: pe.host,
      port: pe.port,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers,
      agent: false,
      signal,
    });
    req.once('connect', (res, socket, head) => {
      tunnelSock = socket;
      if (res.statusCode !== 200) {
        fail(new Error(`代理拒绝 CONNECT（HTTP ${res.statusCode}）`));
        return;
      }
      if (head && head.length) socket.unshift(head);
      if (target.protocol !== 'https:') {
        settled = true;
        detach();
        cb(null, socket);
        return;
      }
      socket.once('error', onSockError);
      tlsSock = tls.connect({ socket, servername: target.hostname });
      tlsSock.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        detach();
        cb(null, tlsSock);
      });
      tlsSock.once('error', onSockError);
    });
    req.once('error', onSockError);
    req.end();
  };
}

/** 单跳请求（不跟随重定向）。 */
function once(urlStr, { proxy, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error(`不支持的协议：${u.protocol}`));
      return;
    }
    // ⚠️ 手搭 options，**不要**把 URL 对象当第一参再覆盖字段 —— 传 URL 时 Node 会用
    // URL 里的 host/port/path 覆盖后面的同名字段（原型实测踩过：代理形同无效、退化成直连）。
    const opts = {
      method: 'GET',
      signal,
      timeout: timeoutMs,
      host: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: { accept: '*/*', 'user-agent': UA, host: u.host },
    };

    let req;
    if (proxy && !isHttps) {
      // http 目标经代理 → 绝对形态请求行，且请求行交给代理
      const pe = proxyEndpoint(proxy);
      opts.host = pe.host;
      opts.port = pe.port;
      opts.path = u.href;
      const auth = proxyAuthHeader(proxy);
      if (auth) opts.headers['proxy-authorization'] = auth;
      req = http.request(opts);
    } else if (proxy) {
      opts.createConnection = tunnelConnection(proxy, u, signal);
      req = http.request(opts);
    } else {
      req = (isHttps ? https : http).request(opts);
    }

    req.once('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms 无响应）`)));
    req.once('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.once('error', reject);
      res.once('end', () =>
        resolve({ status: res.statusCode, statusText: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.once('error', reject);
    req.end();
  });
}

/**
 * GET 一个 URL（跟随重定向）。
 *
 * 与 `fetch(url, {redirect:'follow'})` 的差异：不自动解压（不发 `accept-encoding`，
 * 服务端会回 identity）、不解析 cookies —— 这两条对本用途都无影响。
 *
 * 整个重定向链共享**同一个**超时预算与 abort 信号（而不是每跳各自计时），
 * 否则 5 跳 × 30s = 150s 会穿过上层的 RPC 超时。
 *
 * @param {string} url
 * @param {{ proxy?: URL | null, timeoutMs?: number, maxRedirects?: number }} [opts]
 * @returns {Promise<{ status: number, statusText: string, headers: Record<string, unknown>, body: Buffer, url: string }>}
 */
export async function httpGet(url, { proxy = null, timeoutMs = 30_000, maxRedirects = 5 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let current = String(url);
    for (let hop = 0; ; hop += 1) {
      const res = await once(current, { proxy, timeoutMs, signal: ac.signal });
      const loc = res.headers?.location;
      if (REDIRECT_STATUS.has(res.status) && typeof loc === 'string' && hop < maxRedirects) {
        current = new URL(loc, current).href;
        continue;
      }
      return { ...res, url: current };
    }
  } finally {
    clearTimeout(timer);
  }
}
