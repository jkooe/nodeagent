#!/usr/bin/env node
/**
 * B2 验证脚本：v23 连接层三防护（真机跑，不是 mock）。
 *
 * 为什么单独写：CLI 的命令都是**短连接**（连完即断），测不出「空闲断开」；
 * 而 `events` 订阅会让服务端认为"该连接有订阅、不能踢"（这是 v23 的保守设计）。
 * 所以需要一个**握手完成后什么都不做**的长连接。
 *
 * 用法：
 *   node /tmp/b2-idle.mjs idle              # ③ 空闲断开（观察是否 ~idle_timeout 被断）
 *   node /tmp/b2-idle.mjs maxconn           # ② 连接上限（并发 N+1 个，第 N+1 应被拒）
 */

// 用相对路径：从仓库根跑时解析不到 workspace 包（根 package.json 未声明它）
import { NodeAgentClient } from '../packages/client/dist/index.js';

const URL = process.env.NA_URL ?? 'wss://10.211.55.9:8765'  // ⚠️ 必须 wss：被控端 tls=true（写成 ws 会 socket hang up）;
const KEY = process.env.NA_KEY;
if (!KEY) {
  console.error('需要 NA_KEY 环境变量');
  process.exit(1);
}

const mode = process.argv[2] ?? 'idle';
const ts = () => new Date().toISOString().slice(11, 19);

function mkClient(id) {
  return new NodeAgentClient({
    url: URL,
    key: KEY,
    clientId: id,
    insecure: true,
    handshakeTimeoutMs: 10_000,
    onStateChange: (s) => console.log(`[${ts()}] ${id} state=${s}`),
    onLog: (m) => console.log(`[${ts()}] ${id} log: ${m}`),
  });
}

// ---------------- ③ 空闲断开 ----------------
async function idleTest() {
  const started = Date.now();
  const c = mkClient('idle-probe');
  try {
    await c.connect();
  } catch (err) {
    console.log(`[${ts()}] ⚠️ 握手失败：${err?.message ?? err}`);
    console.log(`[${ts()}] 提示：若报 socket hang up，通常说明已达 max_connections（先等空闲超时清掉残留）`);
    process.exit(3);
  }
  console.log(`[${ts()}] ${'idle-probe'} 已握手完成（t=0s），之后**不做任何请求、不订阅**`);
  console.log(`[${ts()}] 期待：约 idle_timeout_ms 后被服务端断开（state=closed）`);

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const sec = ((Date.now() - started) / 1000).toFixed(0);
      if (sec % 10 === '0') console.log(`[${ts()}] t=${sec}s 仍存活`);
      if (Number(sec) >= 75) {
        clearInterval(timer);
        console.log(`[${ts()}] t=${sec}s —— 75 秒到，**未被断开**（空闲断开未生效或阈值更长）`);
        resolve();
      }
    }, 1000);
    // 订阅状态变化：closed 即被服务端断开
    const orig = c.opts?.onStateChange;
    void orig;
  });

  try {
    c.close();
  } catch {
    /* ignore */
  }
  console.log(`[${ts()}] 结束`);
  process.exit(0);
}

// ---------------- ② 连接上限 ----------------
async function maxConnTest() {
  const n = Number(process.env.NA_MAX ?? 2);
  const clients = [];
  console.log(`[${ts()}] 尝试建立 ${n + 1} 个并发连接（配置 max_connections=${n}）`);

  for (let i = 1; i <= n + 1; i += 1) {
    const id = `conn-${i}`;
    const c = mkClient(id);
    try {
      await c.connect();
      clients.push(c);
      console.log(`[${ts()}] ✓ 第 ${i} 个连接成功`);
    } catch (err) {
      console.log(`[${ts()}] ✗ 第 ${i} 个连接被拒：${err?.message ?? err}`);
      // 第 n+1 个被拒即为通过
      for (const x of clients) {
        try {
          x.close();
        } catch {
          /* ignore */
        }
      }
      const pass = i === n + 1;
      console.log(`[${ts()}] 结论：${pass ? '✓ 连接上限生效' : '⚠️ 被拒的不是第 N+1 个'}`);
      process.exit(pass ? 0 : 2);
    }
    // 稍等，避免瞬时并发被当成同一个
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`[${ts()}] ⚠️ ${n + 1} 个连接全部成功 —— 连接上限未生效`);
  for (const x of clients) {
    try {
      x.close();
    } catch {
      /* ignore */
    }
  }
  process.exit(2);
}


// ---------------- ① 握手封禁 ----------------
async function banTest() {
  const n = Number(process.env.NA_ATTEMPTS ?? 3);
  console.log(`[${ts()}] 用**错误密钥**连 ${n} 次（配置 max_attempts=${n}）`);
  for (let i = 1; i <= n; i += 1) {
    const c = new NodeAgentClient({ url: URL, key: 'WRONG-KEY-' + i, clientId: 'ban-' + i, insecure: true, handshakeTimeoutMs: 8000 });
    try {
      await c.connect();
      console.log(`[${ts()}] ⚠️ 第 ${i} 次错误密钥竟然成功（不应发生）`);
      c.close();
    } catch (err) {
      console.log(`[${ts()}] ✓ 第 ${i} 次被拒：${String(err?.message ?? err).slice(0, 60)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[${ts()}] 现在用**正确密钥**连（若封禁生效，应当也被拒）`);
  const good = new NodeAgentClient({ url: URL, key: KEY, clientId: 'ban-good', insecure: true, handshakeTimeoutMs: 8000 });
  try {
    await good.connect();
    console.log(`[${ts()}] ✗ 正确密钥连接成功 —— **封禁未生效**`);
    good.close();
    process.exit(2);
  } catch (err) {
    console.log(`[${ts()}] ✓ 正确密钥也被拒：${String(err?.message ?? err).slice(0, 70)}`);
    console.log(`[${ts()}] 结论：✓ 握手失败封禁生效（连正确密钥都被挡）`);
    process.exit(0);
  }
}

if (mode === 'idle') await idleTest();
else if (mode === 'maxconn') await maxConnTest();
else if (mode === 'ban') await banTest();
else {
  console.error('用法: node b2-idle.mjs <idle|maxconn>');
  process.exit(1);
}
