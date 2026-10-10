import { createHash } from 'node:crypto';
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
import {
  callAndPrint,
  fail,
  getClientConfig,
  getNodeOverride,
  probeOnce,
  humanSize,
  printJson,
  riskIcon,
  withClient,
  withClientDirect,
} from '../core.js';
import { CHUNK_BYTES, type Options } from '../types.js';

// CLI 命令组：cmd/ops.ts
export async function cmdBg(command: string, opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(
      c,
      CapabilityNames.ShellExec,
      { command, async: true, timeout_ms: opts.timeoutMs ? Number(opts.timeoutMs) : undefined },
      opts.json,
      (data) => {
        const d = data as { task_id: string; state: string };
        console.log(`✓ 后台任务已启动: ${d.task_id}（${d.state}）`);
        console.log('  查询: nodeagent task ' + d.task_id);
        console.log('  终止: nodeagent task ' + d.task_id + ' --kill');
      },
    ),
  );
}

export async function cmdTasks(opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.TaskList, {}, opts.json, (data) => {
      const rows = (data as { tasks: Array<{ task_id: string; state: string; duration_ms: number; exit_code?: number }> }).tasks;
      if (rows.length === 0) {
        console.log('当前没有后台任务');
        return;
      }
      console.log(`${'任务ID'.padEnd(26)} ${'状态'.padEnd(9)} ${'耗时'.padStart(9)}  退出码`);
      for (const t of rows) {
        console.log(
          `${t.task_id.padEnd(26)} ${t.state.padEnd(9)} ${String(t.duration_ms + 'ms').padStart(9)}  ${t.exit_code ?? '-'}`,
        );
      }
    }),
  );
}

export async function cmdTask(taskId: string, opts: Options): Promise<void> {
  if (opts.kill) {
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.TaskKill, { task_id: taskId }, opts.json, (data) => {
        const d = data as { killed: boolean };
        console.log(d.killed ? `✓ 已终止 ${taskId}` : `任务 ${taskId} 已不在运行`);
      }),
    );
    return;
  }
  const offset = opts.offset ? Number(opts.offset) : 0;
  await withClient((c) =>
    callAndPrint(
      c,
      CapabilityNames.TaskGet,
      { task_id: taskId, offset },
      opts.json,
      (data) => {
        const d = data as {
          state: string;
          exit_code: number | null;
          duration_ms: number;
          data: string;
          offset: number;
          total_bytes: number;
        };
        if (d.data) console.log(d.data);
        console.error(
          `[${d.state} · ${d.duration_ms}ms · 已读 ${d.offset}/${d.total_bytes} 字节${d.exit_code !== null && d.state !== 'running' ? ` · 退出码 ${d.exit_code}` : ''}]`,
        );
        if (d.state === 'running' && d.offset < d.total_bytes) {
          console.error('  续读: nodeagent task ' + taskId + ' --offset ' + d.offset);
        }
      },
    ),
  );
}

/**
 * v11 / C5：把一个能力并发下发到多台设备并汇总结果。
 * 每台设备独立连接、互不阻塞（allSettled），任一失败不影响其他。
 */

export async function cmdFanout(capability: string, opts: Options): Promise<void> {
  const cfg = getClientConfig();
  const names = (opts.nodes ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const selector = names.length > 0 ? names : Object.keys(cfg.nodes);
  // v12：支持 @组名（组内可嵌套引用其它组）
  const { nodes: targets, resolvedGroups } = resolveNodeSelector(cfg, selector);
  if (targets.length === 0) fail('没有可用的设备，请先 nodeagent connect 或检查分组定义');
  for (const [g, members] of Object.entries(resolvedGroups)) {
    if (members.length === 0) fail(`分组「${g}」为空或不存在（可用: ${Object.keys(cfg.groups ?? {}).join(', ') || '无'}）`);
  }

  let args: Record<string, unknown> = {};
  if (opts.args) {
    try {
      args = JSON.parse(opts.args) as Record<string, unknown>;
    } catch {
      fail('--args 需为合法 JSON，例如 --args {"limit":5}');
    }
  }

  const started = Date.now();
  const results = await Promise.allSettled(
    targets.map(async (n) => {
      const t0 = Date.now();
      const data = await withClient(async (c) => {
        const r = await c.invoke(capability, args, Number(opts.timeoutMs ?? 60_000));
        if (r.status === 'failed') throw new Error(`${r.error?.name}: ${r.error?.message}`);
        return r.data;
      }, n);
      return { node: n, ms: Date.now() - t0, data };
    }),
  );

  if (opts.json) {
    printJson(
      results.map((r, i) =>
        r.status === 'fulfilled'
          ? { node: r.value.node, ok: true, ms: r.value.ms, data: r.value.data }
          : { node: targets[i], ok: false, error: String(r.reason) },
      ),
    );
    return;
  }

  console.log(`并发下发 ${capability} → ${targets.length} 台设备（总耗时 ${Date.now() - started}ms）\n`);
  results.forEach((r, i) => {
    const name = (targets[i] ?? '?').padEnd(16);
    if (r.status === 'fulfilled') {
      const preview = JSON.stringify(r.value.data);
      console.log(`  ✓ ${name} ${String(r.value.ms + 'ms').padStart(7)}  ${preview.slice(0, 150)}`);
    } else {
      console.log(`  ✗ ${name} ${'—'.padStart(7)}  ${String(r.reason).slice(0, 150)}`);
    }
  });
}

export async function cmdRecord(opts: Options): Promise<void> {
  const args: Record<string, unknown> = {};
  if (opts.duration) args['duration_ms'] = Number(opts.duration);
  if (opts.fps) args['fps'] = Number(opts.fps);
  if (opts.scale) args['scale'] = Number(opts.scale);
  if (opts.region) {
    const n = opts.region.split(',').map(Number);
    if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) fail('region 格式应为 "x,y,width,height"');
    args['region'] = { x: n[0], y: n[1], width: n[2], height: n[3] };
  }
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ScreenRecord, args, opts.json, (data) => {
      const d = data as { dir: string; frames: number; fps: number; elapsed_ms: number; video_path?: string; frames_only: boolean };
      console.log(`✓ 录制完成：${d.frames} 帧 @ ${d.fps}fps（${d.elapsed_ms}ms）`);
      console.log(`  目录: ${d.dir}`);
      if (d.video_path) console.log(`  视频: ${d.video_path}`);
      else if (d.frames_only) console.log('  提示: 无 ffmpeg，用 `nodeagent pull` 或 `nodeagent ls` 取回帧');
    }),
  );
}

/**
 * v11 / D2：一键部署 / 升级被控端 agent。
 * 流程：被控端自报入口路径（system.info）→ 上传新 agent.mjs → 受控重启 → 复验能力数。
 * 全程无需手工拷文件或起计划任务。
 */

/**
 * 部署/更新被控端 agent（v18 起带指纹校验）。
 *
 * 流程：本地算 sha256 → 问远端构建指纹 → 相同则跳过（--force 可强制）→
 *       备份 → 分块上传 → 受控重启 → **轮询直到远端指纹等于本地**（替代盲等）。
 *
 * 为什么必须比指纹：只看「PID 变了 / 能力数对了」证明不了换成了新代码
 * （旧版可能恰好有同样多的能力）。内容哈希是唯一可靠判据。
 */
export async function cmdDeploy(localFile: string, opts: Options): Promise<void> {
  if (!existsSync(localFile)) fail(`本地文件不存在: ${localFile}`);
  const buf = readFileSync(localFile);
  if (buf.length < 10_000) fail(`文件过小，疑似不是 agent 包: ${localFile}`);
  const localHash = createHash('sha256').update(buf).digest('hex').slice(0, 12);

  // 单条 RPC 的安全分块（与上传保持一致）
  const BACKUP_CHUNK = 512 * 1024;

  type Info = {
    agent_script?: string;
    pid?: number;
    node_path?: string;
    build?: { hash?: string; node?: string; started_at?: number };
  };

  const remote = await withClient((c) => c.invoke<Info>(CapabilityNames.SystemInfo, {}));
  if (remote.status === 'failed') fail('无法读取被控端信息');
  const info: Info = remote.data ?? {};
  const remoteHash = info.build?.hash ?? 'unknown';
  const target = opts.path ?? info.agent_script;
  if (!target) fail('被控端未上报入口路径，请用 --path <远端路径> 指定');

  console.log(`本地 : ${localHash}  (${(buf.length / 1024).toFixed(0)} KB)`);
  console.log(`远端 : ${remoteHash}  ${info.build?.node ? `(node ${info.build.node})` : ''}`);
  console.log(`目标 : ${target}（当前 PID ${info.pid ?? '?'}）`);

  const unknownRemote = remoteHash === 'unknown';
  if (unknownRemote) {
    console.log('ℹ️ 远端未上报构建指纹（多为 v18 之前的旧版）—— 无法比对，建议直接部署');
  }

  if (opts.check === true) {
    if (remoteHash === localHash) {
      console.log('✓ 已是最新，无需更新');
    } else if (unknownRemote) {
      console.log('⚠️ 无法比对（远端过旧），建议执行 `nodeagent deploy <文件>` 更新');
      process.exitCode = 2;
    } else {
      console.log('⚠️ 版本不一致 —— 执行 `nodeagent deploy <文件>` 更新（加 --force 可强制覆盖）');
      process.exitCode = 2;
    }
    return;
  }

  if (!unknownRemote && remoteHash === localHash && opts.force !== true) {
    console.log('✓ 远端指纹与本地一致，已是最新（如需强制覆盖请加 --force）');
    return;
  }

  // 备份 + 上传 + 重启
  const uploadInfo = await withClient(async (c) => {
    // 备份走协议自带的 fs 能力（而非 shell 的 Copy-Item）——
    // Copy-Item 是 Windows 专用，在 macOS 被控端上会静默失败（真机踩过：以为备份了，其实没有）。
    // 备份用**固定名**（覆盖式）：此前用 `.bak-<时间戳>`，每部署一次就多一个文件 ——
    // 真机 2026-10-09 发现 D:\Nodeagent 下堆了 15+ 个 bak（单文件 1MB，纯浪费）。
    // 部署回滚只需要「上一个可用版本」，一份就够，故改为覆盖写。
    const backup = `${target}.bak`;
    let backupPath = '';
    try {
      const st = await c.invoke<{ size?: number; exists?: boolean }>(CapabilityNames.FsStat, { path: target });
      const size = st.status === 'ok' ? (st.data?.size ?? 0) : 0;
      if (size > 0) {
        let off = 0;
        let first = true;
        while (off < size) {
          // 自行计算本次长度并据此前进（对齐 cmdPush 的成熟写法）：
          // fs.read 返回的 offset 是**本次读取的起始位置**，拿它当前进量会原地打转
          // → 死循环 + 文件暴涨（真机踩过：备份 33B→268KB 且部署卡死 200s）。
          const len = Math.min(BACKUP_CHUNK, size - off);
          const r = await c.invoke<{ data?: string }>(CapabilityNames.FsRead, {
            path: target,
            offset: off,
            max_bytes: len,
            // ⚠️ 必须显式 base64：默认 utf8 会把二进制按文本读（损坏），
            //    再当 base64 写回就得到几十字节的垃圾备份（真机踩过：备份 33 字节）
            encoding: 'base64',
          });
          if (r.status !== 'ok') break;
          const chunk = r.data?.data ?? '';
          if (!chunk) break;
          const w = await c.invoke(CapabilityNames.FsWrite, {
            path: backup,
            data: chunk,
            encoding: 'base64',
            append: !first,
          });
          if (w.status !== 'ok') break;
          first = false;
          off += len;
        }
        if (!first) backupPath = backup;
      }
    } catch {
      /* 备份失败不阻断部署，但下面会提示 */
    }
    if (backupPath) console.log(`已备份: ${backupPath}`);
    else console.log('⚠️ 备份未成功（部署继续，但无自动回滚点）');

    const CHUNK = 512 * 1024;
    let offset = 0;
    while (offset < buf.length) {
      const part = buf.subarray(offset, Math.min(offset + CHUNK, buf.length));
      const w = await c.invoke(CapabilityNames.FsWrite, {
        path: target,
        data: part.toString('base64'),
        encoding: 'base64',
        append: offset > 0,
      });
      if (w.status === 'failed') fail(`上传失败于 offset ${offset}: ${w.error?.message}`);
      offset += part.length;
    }
    console.log(`✓ 已上传 ${(buf.length / 1024).toFixed(0)} KB`);

    // best-effort 清理历史的时间戳备份（老格式 `.bak-<ts>`）。
    // 平台分流：Windows 用 PS，类 Unix 用 rm。清不掉不影响部署，只提示。
    try {
      const isWin = String((info as { os?: string }).os ?? '').toLowerCase().startsWith('win');
      const cleanup = isWin
        ? `Get-ChildItem '${target}.bak-*' -EA SilentlyContinue | Remove-Item -Force -EA SilentlyContinue; (Get-ChildItem '${target}.bak-*' -EA SilentlyContinue | Measure-Object).Count`
        : `rm -f '${target}.bak-'* 2>/dev/null; ls '${target}.bak-'* 2>/dev/null | wc -l`;
      const r = await c.invoke<{ stdout?: string }>(CapabilityNames.ShellExec, { command: cleanup, timeout_ms: 15_000 });
      const left = Number((r.data?.stdout ?? '').trim());
      if (r.status === 'ok' && Number.isFinite(left)) {
        if (left === 0) console.log('✓ 已清理历史时间戳备份（老格式）');
        else console.log(`⚠️ 仍有 ${left} 个历史备份未清理（可手动删除）`);
      }
    } catch {
      /* 清理是附加项，失败不影响部署结果 */
    }
    return { backupPath };
  });

  // 触发重启：**用独立连接且吞掉连接中断**。
  // 重启会把本连接切断，这属于预期行为；若当成失败抛出，整个部署会被误判为失败
  // （真机踩过：文件其实已换好、新进程也起来了，CLI 却报 E_NODE_OFFLINE）。
  try {
    const r = await withClient((c) =>
      c.invoke(CapabilityNames.AgentRestart, { delay_ms: 1500, reason: 'deploy' }),
    );
    if (r.status === 'failed') fail(`重启失败: ${r.error?.message}`);
  } catch (err) {
    console.log(`（重启切断了连接，属预期：${err instanceof Error ? err.message : String(err)}）`);
  }
  console.log('✓ 已触发重启，校验新版本上线…');

  // 轮询校验：直到远端指纹 == 本地指纹。
  // 用 probeOnce（永不退出），**不能用 withClient** —— 后者连不上会 fail() 退出，
  // 使得「等待重连」根本无法实现（真机踩过：部署成功却报 E_NODE_OFFLINE）。
  // 按墙钟限时而非固定次数：每次连接耗时不定，按次数算总时长不可预期。
  let verified = false;
  let lastSeen = '';
  let pidSeen: number | undefined;
  let capsSeen = 0;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((t) => setTimeout(t, 1500));
    const p = await probeOnce();
    if (!p.ok) continue;
    lastSeen = p.buildHash ?? 'unknown';
    pidSeen = p.pid;
    capsSeen = p.caps;
    if (lastSeen === localHash) {
      verified = true;
      console.log(`✓ 新版本已上线并校验通过：指纹 ${lastSeen}，PID ${pidSeen ?? '?'}，能力 ${capsSeen} 项`);
      break;
    }
  }

  if (!verified) {
    const waited = Math.round((Date.now() - (deadline - 90_000)) / 1000);
    console.error(`✗ ${waited}s 内未校验到新版本（当前远端指纹 ${lastSeen || '连不上'}）`);
    if (uploadInfo.backupPath) {
      console.error(`  回滚方式：把备份复制回目标即可 ——`);
      console.error(`  nodeagent exec "Copy-Item '${uploadInfo.backupPath}' '${target}' -Force"`);
    }
    console.error('  排查：被控端杀软可能处置了被覆盖的 agent 文件');
    process.exitCode = 1;
  }
}

/**
 * v12 / E1+E2：订阅被控端事件并实时接收推送。
 * 与普通命令不同，它需要**保持连接**一段时间（长连接 + 推送），因此不走 withClient 的「用完即关」。
 */

export async function cmdEvents(opts: Options): Promise<void> {
  const cfg = getClientConfig();
  let target: ResolvedTarget;
  try {
    target = resolveTarget(cfg, getNodeOverride());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  // 无 --kind 时列出当前订阅
  if (!opts.kind) {
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.EventList, {}, opts.json, (data) => {
        const d = data as {
          watches: Array<{ watch_id: string; kind: string; description: string; events: number }>;
          buffered: number;
        };
        if (d.watches.length === 0) {
          console.log(`当前没有事件订阅（缓冲 ${d.buffered} 条）`);
          console.log('用法: nodeagent events --kind file --path <路径> [--seconds 20]');
          return;
        }
        console.log(`${'订阅ID'.padEnd(24)} ${'类型'.padEnd(8)} 事件数  说明`);
        for (const w of d.watches) {
          console.log(`${w.watch_id.padEnd(24)} ${w.kind.padEnd(8)} ${String(w.events).padStart(6)}  ${w.description}`);
        }
      }),
    );
    return;
  }

  const seconds = Math.max(1, Math.min(600, Number(opts.seconds ?? 15)));
  const { profile, clientId } = target;
  const keys = profile.auth_mode === 'ed25519' ? loadKeys() : null;
  const received: Array<Record<string, unknown>> = [];

  const client = new NodeAgentClient({
    url: toWsUrl(profile),
    key: profile.key ?? '',
    clientId,
    insecure: profile.insecure,
    authMode: profile.auth_mode,
    privateKey: keys?.privateKey,
    hub: profile.hub ? { token: profile.hub.token, nodeId: profile.hub.node_id } : undefined,
    onEvent: (evt) => {
      received.push(evt);
      const ts = new Date(Number(evt['ts'] ?? Date.now())).toLocaleTimeString('zh-CN');
      const line = `${ts}  ${String(evt['action'] ?? '').padEnd(20)} ${String(evt['target'] ?? '')}${evt['detail'] ? `  (${evt['detail']})` : ''}`;
      if (opts.json) console.log(JSON.stringify(evt));
      else console.log(`  ${line}`);
    },
  });

  try {
    await client.connect();
    const args: Record<string, unknown> = { kind: opts.kind };
    if (opts.path) args['path'] = opts.path;
    if (opts.pattern) args['pattern'] = opts.pattern;
    if (opts.recursive) args['recursive'] = true;
    if (opts.intervalMs) args['interval_ms'] = Number(opts.intervalMs);

    const r = await client.invoke<{ watch_id: string; description: string }>(
      CapabilityNames.EventWatch,
      args,
    );
    if (r.status === 'failed') fail(`${r.error?.name}: ${r.error?.message}`);
    const watchId = (r.data as { watch_id: string }).watch_id;
    if (!opts.json) {
      console.log(`已订阅：${(r.data as { description: string }).description}`);
      console.log(`订阅 ID: ${watchId}    监听 ${seconds}s（Ctrl+C 可提前结束）\n`);
    }

    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, seconds * 1000);
      process.once('SIGINT', () => {
        clearTimeout(t);
        resolve();
      });
    });

    await client.invoke(CapabilityNames.EventUnwatch, { watch_id: watchId });
    if (!opts.json) {
      console.log(`\n共收到 ${received.length} 个事件（订阅已取消）`);
    }
  } catch (err) {
    if (err instanceof ClientError) fail(`${err.name}: ${err.message}`);
    throw err;
  } finally {
    client.close();
  }
}

/**
 * v12 / E4：GUI 宏 —— 把一次成功操作固化为可重放的步骤序列。
 * 子命令：run（回放）/ validate（仅校验文件）/ init（生成示例）
 */

export async function cmdMacro(sub: string | undefined, file: string | undefined, opts: Options): Promise<void> {
  if (sub === 'init') {
    const target = file ?? 'macro.json';
    if (existsSync(target)) fail(`文件已存在: ${target}`);
    const sample = {
      name: '示例：在记事本里打字并复制',
      description: '演示 focus / find / type / key / clip / assert 组合；坐标与文本请按实际调整',
      default_delay_ms: 300,
      steps: [
        { action: 'focus', title: 'Notepad', retry: 3, interval_ms: 800 },
        { action: 'key', keys: ['ctrl', 'a'] },
        { action: 'key', keys: ['delete'] },
        { action: 'type', text: '宏回放演示 ${STAMP:-demo}' },
        { action: 'sleep', ms: 300 },
        { action: 'key', keys: ['ctrl', 'a'] },
        { action: 'key', keys: ['ctrl', 'c'] },
        { action: 'clip', expect: '宏回放演示' },
        { action: 'assert', kind: 'window', text: 'Notepad' },
      ],
    };
    writeFileSync(target, JSON.stringify(sample, null, 2) + '\n');
    console.log(`✓ 已生成示例宏: ${target}`);
    console.log('  试用: nodeagent --node=<设备> macro run ' + target + ' --var STAMP=hello');
    return;
  }

  if (!file) fail('用法: nodeagent macro run <文件.json> [--var k=v] / macro validate <文件.json> / macro init [文件.json]');
  if (!existsSync(file)) fail(`宏文件不存在: ${file}`);

  const macro = loadMacroFile(file);

  if (sub === 'validate') {
    const actions = macro.steps.map((s) => String(s['action'] ?? '?'));
    console.log(`✓ 语法有效：${macro.steps.length} 个步骤`);
    console.log(`  名称: ${macro.name ?? '(未命名)'}`);
    console.log(`  步骤: ${actions.join(' → ')}`);
    return;
  }

  // 解析 --var k=v
  const vars: Record<string, string> = {};
  for (const kv of opts.vars ?? []) {
    const i = kv.indexOf('=');
    if (i <= 0) fail(`--var 需为 k=v 形式: ${kv}`);
    vars[kv.slice(0, i)] = kv.slice(i + 1);
  }

  await withClient(async (c) => {
    const outDir = opts.out ?? '.';
    const t0 = Date.now();
    const res = await runMacro(
      {
        client: c,
        saveCapture: opts.out
          ? (name, b64) => {
              const p = join(outDir, name);
              writeFileSync(p, Buffer.from(b64, 'base64'));
              return p;
            }
          : undefined,
        log: (m) => console.error(m),
      },
      macro,
      vars,
    );

    if (opts.json) {
      printJson(res);
      if (!res.ok) process.exitCode = 1;
      return;
    }
    console.log(`宏「${res.name}」共 ${macro.steps.length} 步，耗时 ${Date.now() - t0}ms\n`);
    for (const s of res.steps) {
      const mark = s.ok ? '✓' : '✗';
      console.log(`  ${mark} [${String(s.index).padStart(2)}] ${s.action.padEnd(8)} ${String(s.ms + 'ms').padStart(7)}  ${s.detail ?? ''}`);
    }
    if (res.ok) {
      console.log('\n✓ 全部步骤通过');
    } else {
      console.error(`\n✗ 在第 ${res.failed_at} 步失败，宏已中止`);
      process.exitCode = 1;
    }
  });
}

/** v13：成功指标（对齐 PRD 2.2 四项验收指标）。 */

export async function cmdClip(opts: Options): Promise<void> {
  // 图片上传：从本地文件读入（避免超长命令行参数）
  if (opts.imageFile) {
    const p = opts.imageFile;
    if (!existsSync(p)) fail(`文件不存在: ${p}`);
    const b64 = readFileSync(p).toString('base64');
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.ClipSet, { image_base64: b64 }, opts.json, (data) => {
        const d = data as { written_bytes: number };
        console.log(`✓ 图片已写入剪贴板（${d.written_bytes} 字节）`);
      }),
    );
    return;
  }
  if (opts.set !== undefined) {
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.ClipSet, { text: opts.set }, opts.json, (data) => {
        const d = data as { written: number };
        console.log(`✓ 已写入剪贴板 ${d.written} 字符`);
      }),
    );
    return;
  }
  // 图片下载：--out 指定保存路径
  if (opts.out) {
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.ClipGet, { format: 'image' }, opts.json, (data) => {
        const d = data as { image_base64: string; bytes: number; format: string };
        writeFileSync(opts.out!, Buffer.from(d.image_base64, 'base64'));
        console.log(`✓ 剪贴板图片已保存 ${opts.out}（${d.bytes} 字节，${d.format}）`);
      }),
    );
    return;
  }
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ClipGet, { format: opts.format ?? 'auto' }, opts.json, (data) => {
      const d = data as {
        type?: string;
        text?: string;
        bytes?: number;
        image_base64?: string;
      };
      if (d.type === 'image') {
        console.log(`(剪贴板为图片，${d.bytes} 字节；用 --out <路径> 保存)`);
        return;
      }
      if (d.text) console.log(d.text);
      else console.log('(剪贴板为空或非文本)');
    }),
  );
}

// ---------- v2.0.0 状态采样（monitor / log） ----------

/**
 * 状态采样与回看。
 *
 *   nodeagent monitor start --source port --target 127.0.0.1:8765 --interval 2000
 *   nodeagent monitor report <id>
 *   nodeagent monitor stop <id>
 *   nodeagent monitor list
 *   nodeagent monitor delete <id>
 */
export async function cmdMonitor(action: string | undefined, positional: string[], opts: Options): Promise<void> {
  switch (action) {
    case 'start': {
      const source = opts.source;
      if (!source) fail('用法: nodeagent monitor start --source <port|process|command|metric> [--target X] [--interval ms] [--id name]');
      const args: Record<string, unknown> = { source };
      if (opts.target !== undefined) args['target'] = opts.target;
      if (opts.interval !== undefined) args['interval_ms'] = Number(opts.interval);
      if (positional[0]) args['id'] = positional[0];
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MonitorStart, args, opts.json, (d) => {
          const r = d as { id: string; source: string; target: string; interval_ms: number; file: string };
          console.log(`✓ 已启动监控 ${r.id}（${r.source}${r.target ? ' → ' + r.target : ''}，每 ${r.interval_ms}ms 一针）`);
          console.log(`  样本文件：${r.file}`);
          console.log(`  回看：nodeagent monitor report ${r.id}`);
        }),
      );
      return;
    }
    case 'report': {
      const id = positional[0];
      if (!id) fail('用法: nodeagent monitor report <id> [--limit n]');
      const args: Record<string, unknown> = { id };
      if (opts.limit !== undefined) args['limit'] = Number(opts.limit);
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MonitorReport, args, opts.json, (d) => {
          const r = d as {
            running: boolean; source: string; target: string; samples: number;
            summary: Record<string, number>;
          };
          console.log(`${r.running ? '● 运行中' : '○ 已停止'} ${r.source}${r.target ? ' → ' + r.target : ''}，共 ${r.samples} 个样本`);
          // 摘要直接说人话（这是本能力的主要价值）
          const sm = r.summary;
          if (sm.down_count !== undefined) {
            console.log(`  连通：${sm.up_count} 通 / ${sm.down_count} 断；最长连续中断 ${sm.longest_outage_samples} 针` +
              (sm.ms_avg !== undefined ? `；延迟 min/avg/max = ${sm.ms_min}/${sm.ms_avg}/${sm.ms_max}ms` : ''));
          }
          if (sm.dead_count !== undefined) console.log(`  存活：${sm.alive_count} 在 / ${sm.dead_count} 不在；最长连续缺失 ${sm.longest_dead_samples} 针`);
          if (sm.fail_count !== undefined) console.log(`  命令：${sm.ok_count} 成功 / ${sm.fail_count} 失败；退出码 ${JSON.stringify(sm.exit_codes_seen)}`);
          if (sm.cpu_avg !== undefined) console.log(`  CPU min/avg/max = ${sm.cpu_min}/${sm.cpu_avg}/${sm.cpu_max}%；内存 avg ${sm.mem_avg}%`);
          if (sm.window_ms !== undefined) console.log(`  时间窗：${(sm.window_ms / 1000).toFixed(1)}s`);
        }),
      );
      return;
    }
    case 'stop': {
      const id = positional[0];
      if (!id) fail('用法: nodeagent monitor stop <id>');
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MonitorStop, { id }, opts.json, (d) => {
          const r = d as { id: string; samples: number; file: string };
          console.log(`✓ 已停止 ${r.id}（共 ${r.samples} 个样本）；样本留在 ${r.file}`);
        }),
      );
      return;
    }
    case 'list': {
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MonitorList, {}, opts.json, (d) => {
          const r = d as { running: Array<{ id: string; source: string; target: string; samples: number }>; running_count: number; history_files: string[] };
          console.log(`运行中 ${r.running_count} 个：`);
          for (const m of r.running) console.log(`  ● ${m.id}（${m.source}${m.target ? ' → ' + m.target : ''}，${m.samples} 样本）`);
          if (r.history_files.length) console.log(`历史文件：${r.history_files.join(', ')}`);
        }),
      );
      return;
    }
    case 'delete': {
      const id = positional[0];
      if (!id) fail('用法: nodeagent monitor delete <id>（运行中需先 stop）');
      await withClient((c) =>
        callAndPrint(c, CapabilityNames.MonitorDelete, { id }, opts.json, () => console.log(`✓ 已删除 ${id} 的历史样本`)),
      );
      return;
    }
    default:
      fail('用法: nodeagent monitor <start|report|stop|list|delete> ...');
  }
}

/** 在被控端侧过滤日志（v2.0.0）：日志常几万行，过滤必须发生在被控端。 */
export async function cmdLog(opts: Options): Promise<void> {
  const logPath = opts.path;
  if (!logPath) fail('用法: nodeagent log --path <文件> [--pattern 正则] [--level ERROR] [--limit n] [--tail]');
  const args: Record<string, unknown> = { path: logPath };
  if (opts.pattern !== undefined) args['pattern'] = opts.pattern;
  if (opts.level !== undefined) args['level'] = opts.level;
  if (opts.since !== undefined) args['since'] = Number(opts.since);
  if (opts.limit !== undefined) args['limit'] = Number(opts.limit);
  if (opts.offset !== undefined) args['offset'] = Number(opts.offset);
  if (opts.tail === true) args['tail'] = true;
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.LogQuery, args, opts.json, (d) => {
      const r = d as { matched: Array<{ n: number; text: string }>; scanned: number; truncated: boolean; note?: string };
      console.log(`✓ 扫描 ${r.scanned} 行，命中 ${r.matched.length} 条${r.truncated ? '（结果被截断）' : ''}`);
      for (const m of r.matched) console.log(`  ${String(m.n).padStart(6)}  ${m.text.slice(0, 160)}`);
      if (r.note) console.log(`  ℹ️ ${r.note}`);
    }),
  );
}
