import { hubConfigPath, loadHubConfig } from './config.js';
import { createHubServer } from './hub.js';

async function main(): Promise<void> {
  const { config, isNew } = loadHubConfig();
  const server = await createHubServer(config);

  console.log('');
  console.log('  nodeagent Hub 已启动（中转节点）');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  节点 ID   : ${config.node_id}`);
  console.log(`  监听      : ${server.url}`);
  console.log(`  配置文件  : ${hubConfigPath()}`);
  console.log(`  Hub 令牌  : ${config.token}`);
  console.log('');
  console.log('  被控端接入 : 在 agent.json 配置 hub: { url, token } 后启动 agent');
  console.log(
    `  控制端接入 : nodeagent connect <hub-主机> --port ${config.port} --hub-token <Hub 令牌> --hub-node <设备ID> --key <设备密钥>`,
  );
  console.log('');
  console.log('  安全说明   : Hub 只透传字节流，不解析内容 ——');
  console.log('               控制端与被控端仍执行自有握手，Hub 无法解密或伪造。');
  if (isNew) {
    console.log('');
    console.log('  ⚠️  首次启动，已生成 Hub 令牌，请一并配置到被控端与控制端。');
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

await main();
