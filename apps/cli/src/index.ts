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
import { HELP } from './help.js';
import { parseOptions } from './options.js';
import { cmdConnect, cmdDiscover, cmdKeygen, cmdNodes, cmdRemove, cmdUse } from './cmd/conn.js';
import {
  cmdApps, cmdAudio, cmdAudit, cmdAuditVerify, cmdExec, cmdInfo, cmdInstall, cmdInvoke, cmdList,
  cmdMetrics, cmdPs, cmdRestart, cmdServices, cmdStatus,
} from './cmd/system.js';
import {
  cmdBg, cmdClip, cmdDeploy, cmdEvents, cmdFanout, cmdMacro, cmdRecord, cmdTask, cmdTasks,
} from './cmd/ops.js';
import { cmdKey, cmdMouse, cmdScreen, cmdScreenshot } from './cmd/gui.js';
import { cmdCat, cmdLs, cmdPull, cmdPush, cmdStat } from './cmd/fs.js';
import { cmdNet } from './cmd/net.js';
import { DAEMON_SOCK, fail, getClientConfig, setNodeOverride } from './core.js';

// CLI 入口：参数解析后按子命令调度
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // 命令 = 第一个非选项 token，故全局选项可前置（--node=win_b info）
  const cmdIdx = argv.findIndex((a) => !a.startsWith('-'));
  const command = cmdIdx >= 0 ? argv[cmdIdx] : undefined;
  const rest = cmdIdx >= 0 ? [...argv.slice(0, cmdIdx), ...argv.slice(cmdIdx + 1)] : argv;
  const { opts, positionals } = parseOptions(rest);
  setNodeOverride(opts.node); // 全局 --node 生效于本次命令

  if (rest.includes('--config')) {
    console.log(configPath());
    return;
  }

  switch (command) {
    case 'connect': {
      const host = positionals[0];
      if (!host) fail('用法: nodeagent connect <host> --port 8765 --key <密钥>');
      await cmdConnect(host, opts);
      return;
    }
    case 'list':
      await cmdList(opts);
      return;
    case 'info':
      await cmdInfo(opts);
      return;
    case 'status':
      await cmdStatus(opts);
      return;
    case 'ps':
      await cmdPs(opts);
      return;
    case 'services':
      await cmdServices(opts);
      return;
    case 'exec': {
      const cmd = positionals.join(' ');
      if (!cmd) fail('用法: nodeagent exec "<命令>"');
      await cmdExec(cmd, opts);
      return;
    }
    case 'apps':
      await cmdApps(opts);
      return;
    case 'restart':
      await cmdRestart(opts);
      return;
    case 'bg': {
      const cmd = positionals.join(' ');
      if (!cmd) fail('用法: nodeagent bg "<命令>" [--timeout-ms 300000]');
      await cmdBg(cmd, opts);
      return;
    }
    case 'tasks':
      await cmdTasks(opts);
      return;
    case 'task': {
      const id = positionals[0];
      if (!id) fail('用法: nodeagent task <task_id> [--offset N] [--kill]');
      await cmdTask(id, opts);
      return;
    }
    case 'daemon': {
      // start | stop | status（无参默认 status）
      const sub = positionals[0] ?? 'status';
      if (sub === 'start') {
        // 找 nodeagentd：优先 PATH 上的同名二进制（esbuild 单文件模式下与 CLI 同目录）
        const { spawn: spawnDetached } = await import('node:child_process');
        const binDir = path.dirname(process.argv[1] ?? 'nodeagent');
        const candidates = [path.join(binDir, 'nodeagentd'), 'nodeagentd'];
        let entry = '';
        for (const c of candidates) {
          if (existsSync(c)) {
            entry = c;
            break;
          }
        }
        if (!entry) {
          // 兜底：dev 模式 dist/daemon.js
          const devEntry = path.join(binDir, 'daemon.js');
          if (existsSync(devEntry)) entry = devEntry;
        }
        if (!entry) {
          fail('未找到 nodeagentd（请运行: bash scripts/install-macos.sh）');
        }
        const child = spawnDetached(process.execPath, [entry], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        });
        child.unref();
        await new Promise((r) => setTimeout(r, 800));
        console.log(existsSync(DAEMON_SOCK) ? `✓ nodeagentd 已启动（${DAEMON_SOCK}）` : '✗ daemon 未能启动');
        return;
      }
      if (sub === 'stop') {
        if (!existsSync(DAEMON_SOCK)) {
          console.log('daemon 未在运行');
          return;
        }
        const { spawn: sp } = await import('node:child_process');
        sp('pkill', ['-f', 'nodeagentd.sock'], { stdio: 'ignore' });
        await new Promise((r) => setTimeout(r, 500));
        try {
          fsSync.unlinkSync(DAEMON_SOCK);
        } catch {
          /* ignore */
        }
        console.log('✓ nodeagentd 已停止');
        return;
      }
      // status
      if (!existsSync(DAEMON_SOCK)) {
        console.log('daemon: 未运行（启动: nodeagent daemon start）');
      } else {
        console.log(`daemon: 运行中（${DAEMON_SOCK}）`);
      }
      return;
    }
    case 'net':
      await cmdNet(positionals[0], opts);
      return;
    case 'audio':
      await cmdAudio(positionals[0], opts);
      return;
    case 'metrics':
      await cmdMetrics(opts);
      return;
    case 'clip':
      await cmdClip(opts);
      return;
    case 'record':
      await cmdRecord(opts);
      return;
    case 'events':
      await cmdEvents(opts);
      return;
    case 'macro': {
      const sub = positionals[0];
      await cmdMacro(sub, positionals[1], opts);
      return;
    }
    case 'group': {
      const sub = positionals[0];
      const cfg = getClientConfig();
      if (sub === 'add') {
        const name = positionals[1];
        const members = positionals.slice(2).join(',').split(',').map((x) => x.trim()).filter(Boolean);
        if (!name || members.length === 0) fail('用法: nodeagent group add <组名> <设备1,设备2,...>');
        for (const m of members) {
          if (!m.startsWith('@') && !cfg.nodes[m]) fail(`设备不存在: ${m}（先 nodeagent connect 添加，或写 @另一组名）`);
        }
        cfg.groups = { ...(cfg.groups ?? {}), [name]: members };
        saveConfig(cfg);
        console.log(`✓ 分组「${name}」已保存：${members.join(', ')}`);
        return;
      }
      if (sub === 'remove' || sub === 'rm') {
        const name = positionals[1];
        if (!name) fail('用法: nodeagent group remove <组名>');
        if (!cfg.groups?.[name]) fail(`分组不存在: ${name}`);
        delete cfg.groups[name];
        saveConfig(cfg);
        console.log(`✓ 已删除分组「${name}」`);
        return;
      }
      // 默认：列出分组
      const groups = cfg.groups ?? {};
      const names2 = Object.keys(groups);
      if (names2.length === 0) {
        console.log('尚未定义设备分组');
        console.log('用法: nodeagent group add <组名> <设备1,设备2,...>   （成员可写 @其它组名）');
        return;
      }
      for (const g of names2) {
        const { nodes } = resolveNodeSelector(cfg, [`@${g}`]);
        console.log(`  @${g.padEnd(14)} → ${nodes.join(', ')}   （${nodes.length} 台）`);
      }
      return;
    }
    case 'fanout': {
      const cap = positionals[0];
      if (!cap) fail('用法: nodeagent fanout <能力名> [--nodes a,b] [--args JSON]');
      await cmdFanout(cap, opts);
      return;
    }
    case 'deploy': {
      const f = positionals[0];
      if (!f) fail('用法: nodeagent deploy <agent.mjs 路径> [--path <远端路径>]');
      await cmdDeploy(f, opts);
      return;
    }
    case 'install': {
      const pkg = positionals[0];
      if (!pkg) fail('用法: nodeagent install <包名|ID>');
      await cmdInstall(pkg, opts);
      return;
    }
    case 'invoke': {
      const cap = positionals[0];
      if (!cap) fail('用法: nodeagent invoke <capability> [--args \'<json>\']');
      await cmdInvoke(cap, opts);
      return;
    }
    case 'keygen':
      await cmdKeygen(opts);
      return;
    case 'nodes':
      await cmdNodes(opts);
      return;
    case 'use':
      await cmdUse(positionals[0], opts);
      return;
    case 'remove':
      await cmdRemove(positionals[0], opts);
      return;
    case 'audit':
      if (positionals[0] === 'verify') await cmdAuditVerify(opts);
      else await cmdAudit(opts);
      return;
    case 'discover':
      await cmdDiscover(opts);
      return;
    case 'ls':
      await cmdLs(positionals[0], opts);
      return;
    case 'stat':
      await cmdStat(positionals[0], opts);
      return;
    case 'cat':
      await cmdCat(positionals[0], opts);
      return;
    case 'pull':
      await cmdPull(positionals[0], opts);
      return;
    case 'push':
      await cmdPush(positionals[0], positionals[1], opts);
      return;
    case 'screen':
      await cmdScreen(opts);
      return;
    case 'screenshot':
      await cmdScreenshot(opts);
      return;
    case 'mouse': {
      const [action, ...rest2] = positionals;
      await cmdMouse(action, rest2, opts);
      return;
    }
    case 'key': {
      const [action, ...rest2] = positionals;
      await cmdKey(action, rest2, opts);
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      fail(`未知命令: ${command}\n\n${HELP}`);
  }
}

main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  // NODEAGENT_DEBUG=1 时打印堆栈 —— CLI 定位问题（尤其是异步链里的异常）必备
  if (process.env['NODEAGENT_DEBUG'] === '1' && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
