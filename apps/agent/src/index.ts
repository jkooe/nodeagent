import os from 'node:os';
import { warmupWindowHelper } from './capabilities/window.js';
import { CAPABILITY_MANIFEST } from '@nodeagent/protocol';
import { loadAgentConfig, agentConfigPath } from './config.js';
import { ensureCert } from './certs.js';
import { createAgentServer } from './server.js';
import { initAudit, audit, auditFilePath } from './audit.js';
import { startBeacon, DEFAULT_DISCOVERY_PORT, type Beacon } from './discovery.js';
import { startHubClient, type HubClient } from './hub-mode.js';

function listLocalIps(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

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
  const tls = !useHub && config.tls ? ensureCert() : null;
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
