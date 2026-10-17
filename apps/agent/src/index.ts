import os from 'node:os';
import { warmupWindowHelper } from './capabilities/window.js';
import { CAPABILITY_MANIFEST } from '@nodeagent/protocol';
import { loadAgentConfig, agentConfigPath } from './config.js';
import { ensureCert } from './certs.js';
import { createAgentServer } from './server.js';
import { initAudit, audit, auditFilePath } from './audit.js';
import { startBeacon, DEFAULT_DISCOVERY_PORT, type Beacon } from './discovery.js';
import { startHubClient, type HubClient } from './hub-mode.js';
import { recordLKG } from './lkg.js';

function listLocalIps(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// v2.0.3：进程级最后一道防线（崩溃链兜底）
// ---------------------------------------------------------------------------
//
// ## 为什么需要
// 真机缺陷链的共同根因：`ws.on('message')` 里用 `void handleMessage(...)` 启动异步处理，
// 未挂 `.catch`；而全仓**没有任何** `unhandledRejection` 处理器 → Node ≥22 的默认策略是
// **直接终止进程**。于是一条畸形报文就能把被控端打死（外部只见 `code=1` / 连接断开），
// 且因为 `verifyHmac`（psk 默认路径）没有 try/catch，连**未认证**的报文都能触发。
//
// 根治在源头（`server.ts` 已改 `.catch(...)` + 逐处报文类型校验），这里补的是
// 「将来某处再漏一个 await」时的兜底 —— 有证据地活着，胜过静默地死。
//
// ## 为什么**不**退出进程
// 被控端是常驻服务，「可用性」优先于「出错即死」。若这里改成 `process.exit(1)`，
// 就退化回「一条畸形报文打死服务」—— 正是本次要修的东西。
// 代价（可能带着不一致的状态继续跑）由两点对冲：
//   ① 源头已有报文校验与 `.catch`；② 这里每次都写审计 + 日志，问题不会被掩盖。
//
// ## 为什么要限流审计
// 畸形报文可以高频重复（扫描/爆破）→ 无限写 `agent.error` 会把审计日志冲爆、把
// 正常记录挤掉。故日志每次都打（stdout 由控制台的环形缓冲兜底），但**审计按时间窗限流**。

let procErrCount = 0;
let lastProcErrAuditAt = 0;
/** 两条 `agent.error` 审计之间的最小间隔 */
const PROC_ERR_AUDIT_INTERVAL_MS = 10_000;

function reportProcessError(kind: string, detail: string): void {
  procErrCount += 1;
  console.error(
    `[${new Date().toISOString()}] [ERROR] ${kind}（已拦截，进程继续运行；累计 ${procErrCount} 次）：${detail}`,
  );
  const now = Date.now();
  if (now - lastProcErrAuditAt < PROC_ERR_AUDIT_INTERVAL_MS) return;
  lastProcErrAuditAt = now;
  audit({
    type: 'agent.error',
    status: 'failed',
    reason: `${kind}: ${detail}（累计 ${procErrCount} 次，审计按 ${PROC_ERR_AUDIT_INTERVAL_MS / 1000}s 限流）`,
  });
}

process.on('unhandledRejection', (reason: unknown) => {
  reportProcessError(
    '未处理的 Promise 拒绝',
    reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
  );
});

// ---------------------------------------------------------------------------
// stdout / stderr 断管容错（2026-10-17 真机两次踩到）
// ---------------------------------------------------------------------------
//
// ## 现象
// 端口仍然 `OPEN`，但**所有** RPC 都超时（握手都不回）。持续数分钟不自愈，
// 只能靠重开控制台恢复。
//
// ## 根因
// 被控端由控制台 spawn 时，stdout/stderr 是**管道**而非终端。用户退出控制台
// （尤其选「保留被控端」）后，管道**读端消失**，而 agent 仍在往这个死管道写日志：
//   - Node 对未监听 'error' 的 stream 会把 `EPIPE` **抛成未捕获异常** → 进程退出；
//   - 更糟的是写端在无读者时可能**阻塞**，把事件循环一起卡住 ——
//     于是端口保住了（OS 层 socket 还在），但 JS 再也不执行了。
// 这解释了为什么「退出控制台后被控端还在，却谁都连不上」：它活着，但哑了。
//
// ## 做法
//   ① 监听 'error' 吞掉 EPIPE，不让它升级成未捕获异常；
//   ② 一旦判定通道已断，就**短路后续写**，不再往死管道里堆字节。
//
// 日志不会因此丢失：审计走文件（`audit.log`），控制台在时照常收到管道输出。
// 宁可少一行 stdout，也不能让常驻服务因为「没人看日志」而假死。
let stdoutDead = false;
let stderrDead = false;

function markDead(e: NodeJS.ErrnoException, isErr: boolean): void {
  if (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED' || e.code === 'ERR_STREAM_WRITE_AFTER_END') {
    if (isErr) stderrDead = true;
    else stdoutDead = true;
    return;
  }
  // 其他写错误也一律吞掉：日志通道的故障不该打死被控端
  if (isErr) stderrDead = true;
  else stdoutDead = true;
}

process.stdout.on('error', (e: NodeJS.ErrnoException) => markDead(e, false));
process.stderr.on('error', (e: NodeJS.ErrnoException) => markDead(e, true));

const rawLog = console.log.bind(console);
const rawErr = console.error.bind(console);
console.log = (...a: unknown[]): void => {
  if (stdoutDead) return;
  try {
    rawLog(...a);
  } catch {
    stdoutDead = true;
  }
};
console.error = (...a: unknown[]): void => {
  if (stderrDead) return;
  try {
    rawErr(...a);
  } catch {
    stderrDead = true;
  }
};

process.on('uncaughtException', (err: unknown) => {
  reportProcessError(
    '未捕获异常',
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  );
});

async function main(): Promise<void> {
  const { config, isNew } = loadAgentConfig();
  initAudit({
    enabled: config.audit?.enabled ?? true,
    maxBytes: config.audit?.max_bytes,
    maxFiles: config.audit?.max_files,
    logArgs: config.audit?.log_args,
  });
  // v6：Hub 模式下不监听本地端口，改为主动外连 Hub（穿 NAT）
  const useHub = config.hub?.enabled === true;
  const tls = !useHub && config.tls ? await ensureCert() : null;
  const server = useHub ? null : await createAgentServer(config, tls);

  let hubClient: HubClient | null = null;
  if (useHub && config.hub) {
    hubClient = startHubClient(
      config,
      {
        url: config.hub.url,
        token: config.hub.token,
        insecure: config.hub.insecure,
        maxSlots: config.hub.max_slots,
        warmSlots: config.hub.warm_slots,
      },
      (level, msg) => console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`),
    );
  }

  const auditMode = config.auth_mode ?? 'psk';
  audit({
    type: 'agent.start',
    reason: `node_id=${config.node_id} port=${config.port} auth_mode=${auditMode}`,
  });

  const ips = listLocalIps();

  // v4：局域网心跳广播（报文不含任何凭据）
  const beacon: Beacon | null = startBeacon(
    {
      enabled: !useHub && config.discovery?.enabled !== false,
      port: config.discovery?.port ?? DEFAULT_DISCOVERY_PORT,
      broadcast: config.discovery?.broadcast ?? '255.255.255.255',
      intervalMs: config.discovery?.interval_ms ?? 5000,
      // v22：详情分级 + 认证（配了 secret 自动启用 minimal）
      detail: config.discovery?.detail ?? 'full',
      secret: config.discovery?.secret,
      base: {
        node_id: config.node_id,
        host: ips[0] ?? '127.0.0.1',
        port: config.port,
        tls: config.tls,
        auth_mode: auditMode,
        input_enabled: config.allow_input === true,
        platform: process.platform,
      },
    },
    (msg) => console.log(`[WARN] ${msg}`),
  );
  // 交付流水线 §6：此刻脚本已加载、配置已读、证书已签、端口已绑、心跳已起 ——
  // 走到这里说明「这个版本至少能启动」，故记为最后已知可用版本（LKG）。
  // 注意**不在更新写完时就记**：那会把尚未验证的版本当成已知可用，LKG 就失去意义。
  recordLKG();

  console.log('');
  console.log('  nodeagent 被控端已启动');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  节点 ID    : ${config.node_id}`);
  console.log(
    `  接入方式   : ${
      useHub
        ? `Hub 中转 → ${config.hub?.url ?? ''}`
        : `本地监听 ${config.host}:${config.port} (${config.tls ? 'wss / TLS' : 'ws / 明文'})`
    }`,
  );
  console.log(`  本机 IP    : ${ips.join(', ') || '未检测到'}`);
  console.log(`  能力       : ${CAPABILITY_MANIFEST.length} 项`);
  console.log(`  认证模式   : ${auditMode}${auditMode === 'ed25519' ? `（已登记 ${config.acl?.clients.length ?? 0} 个调用方）` : ''}`);
  console.log(`  输入控制   : ${config.allow_input === true ? '已开启' : '已禁用（默认）'}`);
  // v22：明文广播会暴露「地址/端口/认证方式/键鼠是否开启」，未收敛时必须提醒
  if (config.discovery?.enabled !== false && !useHub) {
    const minimal = config.discovery?.detail === 'minimal' || !!config.discovery?.secret;
    if (!minimal) {
      console.log(
        '  ⚠️  发现广播为「明文全量」：同网段可见 IP/端口/认证方式/键鼠开关。' +
          '建议在 agent.json 设 discovery.detail="minimal"（可再配 secret 加密详情）',
      );
    } else if (!config.discovery?.secret) {
      console.log('  ℹ️  发现广播已最小化，但 detail 未配 secret —— 详情仍是明文（可加 secret 让其带签名）');
    }
  }

  const discoOn = config.discovery?.enabled !== false;
  console.log(
    `  局域网发现 : ${discoOn ? `已开启（UDP ${config.discovery?.port ?? DEFAULT_DISCOVERY_PORT} 心跳广播）` : '已关闭'}`,
  );
  console.log(`  配置文件   : ${agentConfigPath()}`);
  console.log(`  审计日志   : ${auditFilePath()}`);
  if (isNew) {
    console.log('');
    console.log('  ⚠️  首次启动，已生成预共享密钥，请配置到控制端：');
    console.log(`     密钥 : ${config.key}`);
    console.log(`     命令 : nodeagent connect <本机IP> --port ${config.port} --key <密钥>`);
  }
  console.log('');

  // 后台预热 GUI 能力的常驻 PowerShell 助手：把「首次调用」的启动+类型预加载成本
  // （~1-3s）挪到启动后无人等待的时刻，避免算在第一个真实调用头上（真机指标可见）。
  warmupWindowHelper();

  const shutdown = async (): Promise<void> => {
    console.log('\n正在关闭...');
    beacon?.stop();
    hubClient?.stop();
    audit({ type: 'agent.stop', reason: 'signal' });
    if (server) await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('启动失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
