/**
 * 出站代理守卫（`apps/console/sidecar/proxy.mjs`）。
 *
 * ⚠️ 背景（真机缺陷，2026-10-13）
 * 控制台「检查更新」在境内**必然**失败，报 `检查更新失败：fetch failed`。
 * 根因不是网络，而是代码：Node 内置 `fetch`（undici）**默认不读代理环境变量**，
 * 也读不到 Windows 系统代理（WinINET）/ macOS 系统代理 —— 而中文用户配的恰恰是
 * 「系统代理」。真机取证：VM 上 DNS 与 TCP 443 都通、却 `fetch failed`；
 * 同机经代理取 `latest.json` 返回 302。
 *
 * 因此本文件守四件事：
 *   ① **决议逻辑**（纯函数）：代理来源优先级、`NO_PROXY`、系统代理形态解析；
 *   ② **真发请求**（本地服务器，离线可跑）：直连 / 绝对形态 / CONNECT 隧道；
 *   ③ **端到端**：真 spawn sidecar 进程，用 JSON-RPC 跑 `check_update`，**确实经代理**；
 *   ④ **形态守卫**：sidecar 源码不得再出现裸 `fetch(`（防止修复被无声改回去）。
 *
 * 夹具都取自真机：macOS 的是本机 `scutil --proxy` 原样输出；Windows 的是 VM 上
 * `reg query …\Internet Settings` 的原样输出（含「值不存在时 reg 走 stderr」的真形态）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectSystemProxy,
  httpGet,
  isBypassed,
  normalizeProxyUrl,
  parseRegQueryProxy,
  parseScutilProxy,
  pickEnvProxy,
  resolveProxy,
  tunnelConnection,
} from '../../apps/console/sidecar/proxy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const SIDECAR_SRC = join(repoRoot, 'apps/console/sidecar/main.mjs');

// ---------------------------------------------------------------------------
// 夹具（真机原样）
// ---------------------------------------------------------------------------

/** 本机（macOS）真实输出形态：透明代理扩展接管 → PAC 模式，HTTP/HTTPS 开关都是 0。 */
const SCUTIL_PAC = `<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : 127.0.0.0/8
    2 : ::1
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://localhost:51431/proxy.pac
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`;

/** 手工开系统代理时的形态（字段顺序与本机实测输出一致）。 */
const SCUTIL_ON = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}
`;

/**
 * 真机（Windows 11 ARM64 虚拟机）上 `reg query … /v ProxyEnable` 的真实输出形态（值为 0x0）。
 *
 * 注：本文件里的地址一律用**文档保留段**（RFC 5737 的 `192.0.2.0/24`）或回环，
 * 不写任何真机的内网地址 —— 公开仓库的隐私审查会扫内网 IP（见 `security-reports/`）。
 */
const REG_OFF = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x0

`;

/** 开启系统代理的形态（与真机同一列宽：4 空格缩进 + 类型名 + 值）。 */
const REG_ON = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyOverride    REG_SZ    *.local;<local>
    ProxyServer    REG_SZ    192.0.2.10:7890
`;

const REG_PER_PROTOCOL = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891
`;

// ---------------------------------------------------------------------------
// ① 纯函数
// ---------------------------------------------------------------------------

test('代理 URL 归一化：补 scheme、拒 socks、拒垃圾', () => {
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7890')?.href, 'http://127.0.0.1:7890/');
  assert.equal(normalizeProxyUrl('127.0.0.1:7890')?.hostname, '127.0.0.1', '缺 scheme 应补 http://');
  assert.equal(normalizeProxyUrl(' https://proxy.local:8443 ')?.protocol, 'https:');
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:1080'), null, 'SOCKS 尚不支持 → 必须返回 null（上层据此出声）');
  assert.equal(normalizeProxyUrl(''), null);
  assert.equal(normalizeProxyUrl('   '), null);
  assert.equal(normalizeProxyUrl(undefined), null);
  assert.equal(normalizeProxyUrl('http://'), null, '没有主机名不算代理');
});

test('NO_PROXY 命中判定：精确 / 后缀 / 端口 / 通配 / 不误伤', () => {
  const U = 'https://github.com/x';
  assert.equal(isBypassed(U, ''), false);
  assert.equal(isBypassed(U, '  '), false);
  assert.equal(isBypassed(U, 'github.com'), true);
  assert.equal(isBypassed(U, '.github.com'), true, '前导点等价于后缀匹配');
  assert.equal(isBypassed('https://api.github.com/x', 'github.com'), true, '条目应覆盖其子域');
  assert.equal(isBypassed(U, 'api.github.com'), false, '条目比目标更窄时不得反向豁免父域');
  assert.equal(isBypassed(U, 'github.io'), false, '不同后缀不得误伤');
  assert.equal(isBypassed(U, 'evilgithub.com'), false, '拼尾不得误伤');
  assert.equal(isBypassed(U, 'github.com:443'), true, '端口相符应命中');
  assert.equal(isBypassed(U, 'github.com:8080'), false, '端口不符不命中');
  assert.equal(isBypassed(U, ' example.com , github.com '), true, '空白与多条目应容错');
  assert.equal(isBypassed(U, '*'), true);
});

test('代理来源优先级：NA_PROXY > 协议环境变量 > ALL_PROXY', () => {
  const U = 'https://github.com/x';
  assert.equal(pickEnvProxy({ NA_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' }, U).source, 'NA_PROXY');
  assert.equal(pickEnvProxy({ HTTPS_PROXY: 'http://b:2', ALL_PROXY: 'http://c:3' }, U).source, 'HTTPS_PROXY');
  assert.equal(pickEnvProxy({ https_proxy: 'http://b:2' }, U).source, 'https_proxy', '小写形态同样生效');
  assert.equal(pickEnvProxy({ ALL_PROXY: 'http://c:3' }, U).source, 'ALL_PROXY');
  assert.equal(pickEnvProxy({}, U).url, null);
  // 只看 http 目标时不认 HTTPS_PROXY
  assert.equal(pickEnvProxy({ HTTPS_PROXY: 'http://b:2' }, 'http://x/y').url, null);
  assert.equal(pickEnvProxy({ HTTP_PROXY: 'http://d:4' }, 'http://x/y').source, 'HTTP_PROXY');
});

test('环境变量写了 SOCKS 时必须出声，而不是静默直连', () => {
  const r = pickEnvProxy({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' }, 'https://github.com/x');
  assert.equal(r.url, null);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /socks5/, 'note 要带上原值，便于用户自查');
  assert.match(r.notes[0], /已忽略/);
  // 下一个可用来源仍应被采纳（不能因为前一个没看懂就整个放弃）
  const r2 = pickEnvProxy({ HTTPS_PROXY: 'socks5://x:1', ALL_PROXY: 'http://ok:8080' }, 'https://github.com/x');
  assert.equal(r2.source, 'ALL_PROXY');
});

test('解析 scutil：HTTPS 优先、PAC 模式出声、全关则无代理', () => {
  const on = parseScutilProxy(SCUTIL_ON);
  assert.equal(on.url, '127.0.0.1:7891', 'HTTPS 优先于 HTTP');
  assert.equal(on.bypass, '*.local,169.254/16', 'ExceptionsList 应被收集成绕过列表');
  assert.deepEqual(on.notes, []);

  const pac = parseScutilProxy(SCUTIL_PAC);
  assert.equal(pac.url, null);
  assert.match(pac.notes.join(''), /PAC/, 'PAC 不可解析必须明说，否则用户只会看到 fetch failed');

  const off = parseScutilProxy('<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}\n');
  assert.equal(off.url, null);
  assert.deepEqual(off.notes, [], '既没开代理也不是 PAC，就不该报噪音 note');

  assert.equal(parseScutilProxy('not a dict'), null);
  assert.equal(parseScutilProxy(''), null);
});

test('解析 reg query：0x0 即显式关闭、分协议形态取 https、<local> 剔除', () => {
  const off = parseRegQueryProxy(REG_OFF);
  assert.equal(off.url, null, 'ProxyEnable=0x0 是显式关闭，哪怕别的值有内容也不能启用');

  const on = parseRegQueryProxy(REG_ON);
  assert.equal(on.url, '192.0.2.10:7890');
  assert.equal(on.bypass, '*.local', '<local> 是占位符，不是域名，必须剔除');

  const per = parseRegQueryProxy(REG_PER_PROTOCOL);
  assert.equal(per.url, '127.0.0.1:7891', '分协议形态应取 https（我们没有明文 http 目标）');

  // 值不存在时 reg 把错误写在 stderr，stdout 只剩表头 —— 不该崩，也不该瞎猜
  const missing = parseRegQueryProxy(
    '\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\n\n',
  );
  assert.equal(missing, null);
  assert.equal(parseRegQueryProxy('ERROR: The system was unable to find…'), null);
});

test('系统代理探测：命令失败/平台不支持一律视为「没有系统代理」', async () => {
  // 探测失败绝不能让「检查更新」本身报错
  assert.equal(await detectSystemProxy('win32', async () => null), null);
  assert.equal(await detectSystemProxy('darwin', async () => null), null);
  assert.equal(await detectSystemProxy('linux', async () => 'whatever'), null, 'Linux 不做猜测');
  const boom = await detectSystemProxy('win32', async () => {
    throw new Error('安全软件拦截');
  });
  assert.equal(boom, null, '抛异常也要吞掉');

  // 真解析路径
  const win = await detectSystemProxy('win32', async (file, args) => {
    assert.equal(file, 'reg');
    assert.equal(args[0], 'query');
    assert.match(args[1], /Internet Settings$/, '必须查 HKCU 的 Internet Settings');
    return REG_ON;
  });
  assert.equal(win.url, '192.0.2.10:7890');
  assert.equal(
    (await detectSystemProxy('darwin', async (f) => (f === 'scutil' ? SCUTIL_ON : null))).url,
    '127.0.0.1:7891',
  );
});

test('决议代理：NO_PROXY 短路 → 环境变量 → 系统代理兜底（含 note 累积）', async () => {
  const U = 'https://github.com/x';

  // NO_PROXY 直接短路（哪怕环境里有代理）
  const bypass = await resolveProxy({ targetUrl: U, env: { HTTPS_PROXY: 'http://a:1', NO_PROXY: 'github.com' }, system: null });
  assert.equal(bypass.proxy, null);
  assert.match(bypass.notes.join(''), /NO_PROXY/);

  // 环境变量优先于系统代理
  const envFirst = await resolveProxy({
    targetUrl: U,
    env: { HTTPS_PROXY: 'http://env:1' },
    system: { url: 'sys:2', bypass: '', notes: [] },
  });
  assert.equal(envFirst.proxy.href, 'http://env:1/');
  assert.equal(envFirst.source, 'HTTPS_PROXY');

  // 环境变量空 → 用系统代理，并把来源标成 system
  const sys = await resolveProxy({
    targetUrl: U,
    env: {},
    system: { url: '127.0.0.1:7890', bypass: '', notes: [] },
  });
  assert.equal(sys.proxy.href, 'http://127.0.0.1:7890/', '缺 scheme 的系统代理值也应能用');
  assert.equal(sys.source, 'system');

  // 系统代理的绕过列表命中 → 直连
  const sysBypass = await resolveProxy({
    targetUrl: U,
    env: {},
    system: { url: '127.0.0.1:7890', bypass: 'github.com', notes: [] },
  });
  assert.equal(sysBypass.proxy, null);
  assert.match(sysBypass.notes.join(''), /绕过列表/);

  // 完全没有代理：notes 应带出「为什么没用上」（PAC / socks），便于用户自查
  const none = await resolveProxy({
    targetUrl: U,
    env: { HTTPS_PROXY: 'socks5://x:1' },
    system: { url: null, bypass: '', notes: ['PAC 无法解析'] },
  });
  assert.equal(none.proxy, null);
  assert.match(none.notes.join('；'), /socks5/);
  assert.match(none.notes.join('；'), /PAC/);
});

// ---------------------------------------------------------------------------
// ② 真发请求（本地服务器，离线）
// ---------------------------------------------------------------------------

/** 起一个最小 HTTP 源站，返回 {url, close}。 */
async function startOrigin(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, url: (p) => `http://127.0.0.1:${srv.address().port}${p}` };
}

/** 起一个「真转发」的 HTTP 代理；记录它看到的请求行（用于判定是否走了绝对形态）。 */
async function startHttpProxy() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    let u;
    try {
      u = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end('not absolute-form');
      return;
    }
    const up = http.request(
      { host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: req.method, headers: { ...req.headers, host: u.host } },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => {
      res.writeHead(502);
      res.end('upstream error');
    });
    req.pipe(up);
  });
  // CONNECT 也要支持：https 目标经代理走的就是它
  srv.on('connect', (req, clientSock, head) => {
    seen.push(`CONNECT ${req.url}`);
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port), host, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(clientSock);
      clientSock.pipe(up);
    });
    up.on('error', () => clientSock.destroy());
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, seen, url: `http://127.0.0.1:${srv.address().port}` };
}

test('httpGet 直连：跟随 302 且返回最终响应', async () => {
  const origin = await startOrigin((req, res) => {
    if (req.url === '/hop') {
      res.writeHead(302, { location: '/final' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ARRIVED');
  });
  try {
    const r = await httpGet(origin.url('/hop'), { timeoutMs: 5000 });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), 'ARRIVED');
    assert.equal(r.url, origin.url('/final'), '应报出最终 URL');
  } finally {
    origin.srv.close();
  }
});

test('httpGet 经代理：请求行走绝对形态（不是直连）', async () => {
  const origin = await startOrigin((_req, res) => {
    res.writeHead(200);
    res.end('VIA-PROXY');
  });
  const proxy = await startHttpProxy();
  try {
    const r = await httpGet(origin.url('/latest.json'), { proxy: new URL(proxy.url), timeoutMs: 5000 });
    assert.equal(r.body.toString(), 'VIA-PROXY');
    assert.match(proxy.seen[0], /^http:\/\/127\.0\.0\.1:\d+\/latest\.json$/, 'HTTP 代理收到的是绝对 URI');
  } finally {
    proxy.srv.close();
    origin.srv.close();
  }
});

test('httpGet 经代理：代理不通时必须报错（证明真的走了代理而非偷偷直连）', async () => {
  const origin = await startOrigin((_req, res) => {
    res.writeHead(200);
    res.end('SHOULD-NOT-BE-REACHED');
  });
  try {
    await assert.rejects(
      // 死端口：若实现「代理失败就自动直连」，这里会拿到 200 —— 那正是我们最怕的静默降级
      httpGet(origin.url('/x'), { proxy: new URL('http://127.0.0.1:1'), timeoutMs: 5000 }),
      /ECONNREFUSED|代理/,
    );
  } finally {
    origin.srv.close();
  }
});

test('abort 必须覆盖隧道与 TLS 握手：代理收下 CONNECT 却装死时，超时要立即生效', async () => {
  // ⚠️ 真机踩过（2026-10-13）：配置 75s 超时，实际挂了 **109s** 才失败。
  // 根因：`createConnection` 回调返回之前外层 `http.request` 还没建立，
  // 外层的 signal / timeout **无人受理**；若此时卡在 CONNECT 或 TLS 握手上，
  // 超时形同虚设。本用例把那个形态固定下来：
  // 代理回 200 之后就一个字都不说 → TLS 握手永远完不成。
  const srv = http.createServer();
  srv.on('connect', (_req, sock) => {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // 装死：不再说一个字
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  let watchdog;
  try {
    await assert.rejects(
      // 看门狗：没有它，一旦 abort 失效本用例会**挂死**（把整个测试套件拖住），
      // 而不是干脆地变红。有它则 4s 后必定失败，且失败点落在下面的 dt 断言上。
      Promise.race([
        httpGet('https://github.com/x', {
          proxy: new URL(`http://127.0.0.1:${srv.address().port}`),
          timeoutMs: 800,
        }),
        new Promise((_, rej) => {
          watchdog = setTimeout(() => rej(new Error('看门狗触发：abort 未生效')), 4000);
        }),
      ]),
      /abort|中止|超时/i,
    );
    const dt = Date.now() - t0;
    assert.ok(dt < 4000, `超时应立即生效（配置 800ms），实际 ${dt}ms —— 说明 abort 没覆盖隧道/TLS 阶段`);
  } finally {
    clearTimeout(watchdog);
    srv.closeAllConnections();
    srv.close();
  }
});

test('CONNECT 隧道：可用，且代理拒绝时给出明确错误', async () => {
  const origin = await startOrigin((_req, res) => {
    res.writeHead(200);
    res.end('TUNNELED');
  });
  const proxy = await startHttpProxy();
  try {
    // 直接用隧道 socket 说一句裸 HTTP/1.1（这里刻意用 http 目标：隧道层不带 TLS，
    // TLS 叠层由真机端到端验证覆盖 —— 见 CHANGELOG 的「未覆盖」记档）
    const socket = await new Promise((resolve, reject) => {
      const mk = tunnelConnection(new URL(proxy.url), { protocol: 'http:', hostname: '127.0.0.1', port: String(origin.srv.address().port) }, undefined);
      mk({}, (err, s) => (err ? reject(err) : resolve(s)));
    });
    const text = await new Promise((resolve) => {
      let buf = '';
      socket.on('data', (d) => {
        buf += d;
        if (buf.includes('TUNNELED')) {
          socket.destroy();
          resolve(buf);
        }
      });
      socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    assert.match(text, /200 OK/);
    assert.match(proxy.seen.join('|'), /^CONNECT 127\.0\.0\.1:\d+$/, '代理应收到 CONNECT');

    // 代理拒绝（非 200）→ 必须立刻报错并关掉 socket，而不是挂着
    const badProxy = http.createServer();
    badProxy.on('connect', (_req, sock) => {
      sock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      sock.destroy();
    });
    await new Promise((r) => badProxy.listen(0, '127.0.0.1', r));
    await assert.rejects(
      new Promise((resolve, reject) => {
        const mk = tunnelConnection(
          new URL(`http://127.0.0.1:${badProxy.address().port}`),
          { protocol: 'http:', hostname: '127.0.0.1', port: '80' },
          undefined,
        );
        mk({}, (err, s) => (err ? reject(err) : resolve(s)));
      }),
      /代理拒绝 CONNECT/,
    );
    badProxy.close();
  } finally {
    proxy.srv.close();
    origin.srv.close();
  }
});

// ---------------------------------------------------------------------------
// ③ 端到端：真 spawn sidecar，真走 JSON-RPC
// ---------------------------------------------------------------------------

/** 驱动一个真 sidecar 进程；返回 {call, stderr, kill}。 */
function spawnSidecar(env) {
  const child = spawn(process.execPath, [SIDECAR_SRC], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));

  const call = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等 ${method} 响应超时；stderr=${err.trim()}`)), 30_000);
      const onData = () => {
        for (const line of out.split('\n')) {
          if (!line.trim().startsWith('{')) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id !== id) continue;
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve(msg);
        }
      };
      child.stdout.on('data', onData);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  return {
    call,
    stderr: () => err,
    kill: () => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    },
  };
}

test('端到端：check_update 经代理拿到结果，并报出代理来源', async () => {
  const meta = { version: '9.9.9', commit: 'deadbeef', built_at: '2026-10-13T00:00:00.000Z', agent: { url: 'http://x/agent.mjs', sha256: 'a'.repeat(64), bytes: 1 } };
  const origin = await startOrigin((req, res) => {
    if (req.url === '/latest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(meta));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const proxy = await startHttpProxy();
  const sc = spawnSidecar({ HTTP_PROXY: proxy.url });
  try {
    const msg = await sc.call(1, 'check_update', { console_version: '1.0.0', url: origin.url('/latest.json'), timeout_ms: 10_000 });
    assert.equal(msg.error, undefined, `不应报错：${JSON.stringify(msg.error)} stderr=${sc.stderr()}`);
    assert.equal(msg.result.latest_version, '9.9.9');
    assert.equal(msg.result.has_update, true, '1.0.0 对 9.9.9 应有更新');
    assert.equal(msg.result.via_proxy, 'HTTP_PROXY', '结果里要能看出这次走了哪条出网路径');
    assert.match(proxy.seen[0], /\/latest\.json$/, '代理必须真收到这次请求');

    // 反面对照：代理指到死端口 → 必须失败（证明它没有偷偷直连源站）
    const sc2 = spawnSidecar({ HTTP_PROXY: 'http://127.0.0.1:1' });
    try {
      const bad = await sc2.call(1, 'check_update', { console_version: '1.0.0', url: origin.url('/latest.json'), timeout_ms: 5000 });
      assert.ok(bad.error, '代理不可用时必须报错');
      assert.match(bad.error.message, /检查更新失败/);
      assert.match(bad.error.message, /经代理/, '错误信息要说清走了代理，否则用户无从下手');
      assert.match(bad.error.message, /ECONNREFUSED|超时/);
      assert.equal(bad.error.data.proxy, 'http://127.0.0.1:1/', '失败的线索里要带上代理地址');
    } finally {
      sc2.kill();
    }
  } finally {
    sc.kill();
    proxy.srv.close();
    origin.srv.close();
  }
});

test('错误映射：连接被中途重置时不得报成「请求超时」（真机踩过）', async () => {
  // ⚠️ 真机形态（2026-10-13）：耗时 82.9s（预算 120s），连接是被对端**中途重置**的，
  // 却被报成「请求超时（120000ms 内未完成）」—— 一句话把用户引向完全错误的方向。
  // 根因是把 `ECONNRESET` 也归进了「abort 类」。这里用「收到请求立刻 RST」的源站固定该形态。
  const srv = http.createServer((_req, res) => {
    res.socket?.destroy();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const sc = spawnSidecar({});
  try {
    const msg = await sc.call(1, 'check_update', {
      console_version: '1.0.0',
      url: `http://127.0.0.1:${srv.address().port}/latest.json`,
      timeout_ms: 10_000, // 预算 10s：真超时也要 10s 才会到，故「没到预算就报超时」必是误判
    });
    assert.ok(msg.error, '连接被重置必须报错');
    assert.ok(
      !/请求超时/.test(msg.error.message),
      `不得把「连接被重置」报成「请求超时」：${msg.error.message}`,
    );
    assert.match(
      msg.error.message,
      /中途断开|ECONNRESET|socket hang up/,
      `应说明是连接被对端断开：${msg.error.message}`,
    );
  } finally {
    sc.kill();
    srv.closeAllConnections();
    srv.close();
  }
});

// ---------------------------------------------------------------------------
// ④ 形态守卫
// ---------------------------------------------------------------------------

/**
 * sidecar 源码不得再出现**裸 `fetch(`**。
 *
 * 这是一条**源码形态**守卫（而非产物字节守卫）—— 因为这里要守的规则本身就是
 * 「不许调用这个 API」：`fetch` 在 Node 上不认代理，一旦有人图省事写回去，
 * 代理支持会被**静默**废掉，而所有现有测试都会继续绿。
 * 行为层面的守卫是上面的「端到端」用例；两者互补。
 *
 * ⚠️ 例外说明：`apps/agent/src/capabilities/selfupdate.ts` 仍在用 `fetch`，
 * 那是被控端自更新链路，项目既定策略是「改镜像地址」而不是塞代理隧道
 * （见该文件顶部注释）。本守卫**只覆盖 sidecar**，不越界。
 */
test('形态守卫：sidecar 不得再用裸 fetch（否则代理支持会被静默废掉）', () => {
  const src = readFileSync(SIDECAR_SRC, 'utf8');
  const bad = src
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => /(^|[^.\w])fetch\s*\(/.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//'));
  assert.deepEqual(
    bad.map((b) => `${b.no}: ${b.line.trim()}`),
    [],
    'sidecar 内所有出网必须走 proxy.mjs 的 httpGet（Node 的 fetch 不读代理设置）',
  );
  assert.match(src, /from '\.\/proxy\.mjs'/, '必须真的引入 proxy.mjs');
});
