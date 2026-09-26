import os from 'node:os';
import { CAPABILITY_MANIFEST } from '@nodeagent/protocol';
import { loadAgentConfig, agentConfigPath } from './config.js';
import { ensureCert } from './certs.js';
import { createAgentServer } from './server.js';

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
  const tls = config.tls ? ensureCert() : null;
  const server = await createAgentServer(config, tls);

  const ips = listLocalIps();
  console.log('');
  console.log('  nodeagent 被控端已启动');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  节点 ID    : ${config.node_id}`);
  console.log(`  监听地址   : ${config.host}:${config.port} (${config.tls ? 'wss / TLS' : 'ws / 明文'})`);
  console.log(`  本机 IP    : ${ips.join(', ') || '未检测到'}`);
  console.log(`  能力       : ${CAPABILITY_MANIFEST.length} 项`);
  console.log(`  配置文件   : ${agentConfigPath()}`);
  if (isNew) {
    console.log('');
    console.log('  ⚠️  首次启动，已生成预共享密钥，请配置到控制端：');
    console.log(`     密钥 : ${config.key}`);
    console.log(`     命令 : nodeagent connect <本机IP> --port ${config.port} --key <密钥>`);
  }
  console.log('');

  const shutdown = async (): Promise<void> => {
    console.log('\n正在关闭...');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('启动失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
