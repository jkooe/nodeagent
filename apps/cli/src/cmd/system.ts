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
  humanSize,
  printJson,
  riskIcon,
  withClient,
  withClientDirect,
} from '../core.js';
import { CHUNK_BYTES, type Options } from '../types.js';

// CLI 命令组：cmd/system.ts
export async function cmdList(opts: Options): Promise<void> {
  const caps = await withClient(async (c) => {
    return c.listCapabilities();
  });
  if (opts.json) return printJson(caps);
  console.log(`被控端可用能力（${caps.length}）:`);
  for (const c of caps as CapabilityDescriptor[]) {
    console.log(`  ${riskIcon(c.risk)} ${c.name.padEnd(24)} ${c.description}`);
  }
}

export async function cmdStatus(opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.SystemStatus, {}, opts.json, (data) => {
      const d = data as {
        cpu_pct: number;
        memory_used: number;
        memory_total: number;
        memory_pct: number;
        disks: Array<{ drive: string; total: number; free: number; used_pct: number }>;
        net: Array<{ adapter: string; ip: string }>;
      };
      console.log(`CPU 占用 : ${d.cpu_pct}%`);
      console.log(`内存     : ${humanSize(d.memory_used)} / ${humanSize(d.memory_total)} (${d.memory_pct}%)`);
      console.log('磁盘     :');
      for (const disk of d.disks) {
        console.log(`  ${disk.drive.padEnd(12)} ${humanSize(disk.total - disk.free)} / ${humanSize(disk.total)} 已用 ${disk.used_pct}%`);
      }
      console.log('网络     :');
      for (const n of d.net) console.log(`  ${n.adapter.padEnd(16)} ${n.ip}`);
    }),
  );
}

export async function cmdInfo(opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.SystemInfo, {}, opts.json, (data) => {
      const d = data as Record<string, unknown>;
      for (const [k, v] of Object.entries(d)) {
        const val = k === 'memory_total' && typeof v === 'number' ? humanSize(v) : String(v);
        console.log(`${k.padEnd(14)}: ${val}`);
      }
    }),
  );
}

export async function cmdPs(opts: Options): Promise<void> {
  const limit = Number(opts.limit ?? 20);
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ProcessList, { limit }, opts.json, (data) => {
      const rows = (data as { processes: Array<{ pid: number; name: string; cpu_pct: number; memory_bytes: number }> }).processes;
      console.log(`${'PID'.padStart(7)}  ${'CPU%'.padStart(7)}  ${'内存'.padStart(9)}  名称`);
      for (const p of rows) {
        console.log(`${String(p.pid).padStart(7)}  ${String(p.cpu_pct).padStart(7)}  ${humanSize(p.memory_bytes).padStart(9)}  ${p.name}`);
      }
    }),
  );
}

export async function cmdServices(opts: Options): Promise<void> {
  const limit = Number(opts.limit ?? 20);
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ServiceList, { limit }, opts.json, (data) => {
      const rows = (data as { services: Array<{ name: string; display_name: string; state: string }> }).services;
      console.log(`${'状态'.padEnd(10)} ${'服务名'.padEnd(28)} 显示名`);
      for (const s of rows) console.log(`${s.state.padEnd(10)} ${s.name.padEnd(28)} ${s.display_name}`);
    }),
  );
}

export async function cmdExec(command: string, opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.ShellExec, { command }, opts.json, (data) => {
      const d = data as { exit_code: number; stdout: string; stderr: string; duration_ms: number; truncated: boolean };
      // 命令自身的输出原样打到 stdout —— 保证 `nodeagent exec "..." | jq` 不被污染
      if (d.stdout) console.log(d.stdout);
      if (d.stderr) console.error(d.stderr);
      // 诊断信息（退出码/耗时）走 stderr：终端下照常可见，管道里不干扰数据
      console.error(
        `[退出码 ${d.exit_code} · ${d.duration_ms}ms${d.truncated ? ' · 输出已截断' : ''}]`,
      );
    }),
  );
}

export async function cmdRestart(opts: Options): Promise<void> {
  const delayMs = opts.delay ? Number(opts.delay) : 2000;
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.AgentRestart, { delay_ms: delayMs, reason: 'cli' }, opts.json, (data) => {
      const d = data as { scheduled: boolean; delay_ms: number; mechanism: string; message: string };
      console.log(`✓ ${d.message}`);
      console.log(`  机制: ${d.mechanism}`);
      console.log('  提示: 约 3~4 秒后重连，可执行 `nodeagent info` 验证是否已恢复');
    }),
  );
}

export async function cmdAuditVerify(opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.AuditVerify, {}, opts.json, (data) => {
      const d = data as {
        ok: boolean;
        checked: number;
        legacy: number;
        broken_at?: { file: string; line: number; reason: string };
      };
      if (d.ok) {
        console.log(`✓ 审计链完整（校验 ${d.checked} 条${d.legacy ? `，跳过历史条目 ${d.legacy} 条` : ''}）`);
        return;
      }
      console.error(`✗ 审计链已损坏：${d.broken_at?.reason ?? '未知原因'}`);
      if (d.broken_at) console.error(`  位置: ${d.broken_at.file}:${d.broken_at.line}`);
      console.error(`  已校验 ${d.checked} 条`);
      process.exitCode = 1;
    }),
  );
}

export async function cmdAudit(opts: Options): Promise<void> {
  const args: Record<string, unknown> = {};
  if (opts.limit) args['limit'] = Number(opts.limit);
  if (opts.since) args['since'] = Number(opts.since);
  if (opts.type) args['type'] = opts.type;
  if (opts.clientId) args['client_id'] = opts.clientId;

  await withClient((c) =>
    callAndPrint(c, CapabilityNames.AuditList, args, opts.json, (data) => {
      const d = data as { entries: Array<Record<string, unknown>>; total: number; file: string };
      console.log(`审计文件: ${d.file}`);
      console.log(`读取 ${d.total} 条，展示最新 ${d.entries.length} 条：\n`);
      for (const e of d.entries) {
        const ts = new Date(Number(e['ts'])).toLocaleString('zh-CN');
        const cols = [
          ts.padEnd(20),
          String(e['type'] ?? '').padEnd(17),
          String(e['client_id'] ?? '-').padEnd(10),
          String(e['capability'] ?? '-').padEnd(20),
          String(e['status'] ?? '-').padEnd(7),
          e['duration_ms'] !== undefined ? `${e['duration_ms']}ms` : '',
          e['error'] ? `err=${e['error']}` : '',
          e['reason'] ? String(e['reason']) : '',
        ];
        console.log('  ' + cols.filter((x) => x !== '').join('  '));
      }
    }),
  );
}

// ---------- v4 局域网发现 ----------

export async function cmdMetrics(opts: Options): Promise<void> {
  const args: Record<string, unknown> = {};
  if (opts.since) args['since'] = Number(opts.since);
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.Metrics, args, opts.json, (data) => {
      const m = data as {
        close_loop: { attempts: number; ok: number; failed: number; success_rate: number };
        app_install: { attempts: number; ok: number; failed: number; success_rate: number | null };
        latency: {
          p50_ms: number;
          p95_ms: number;
          max_ms: number;
          timeouts: number;
          fast: { samples: number; p50_ms: number; p95_ms: number; max_ms: number };
          slow: { samples: number; p50_ms: number; p95_ms: number; max_ms: number; capabilities: string[] };
        };
        security: { acl_denied: number; rate_limited: number; auth_failures: number; interception_rate: number };
        verdict: {
          close_loop_ok: boolean;
          app_install_ok: boolean;
          p95_ok: boolean;
          interception_ok: boolean;
          all_pass: boolean;
        };
        targets: { close_loop_success_rate: number; app_install_success_rate: number; p95_ms: number };
        by_capability: Record<string, { attempts: number; ok: number; success_rate: number; p95_ms: number }>;
        window: { from: number; to: number; entries: number };
      };
      const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
      const mark = (ok: boolean): string => (ok ? '✅' : '❌');
      const from = m.window.from ? new Date(m.window.from).toLocaleString('zh-CN') : '-';
      const to = m.window.to ? new Date(m.window.to).toLocaleString('zh-CN') : '-';
      console.log(`窗口: ${from} → ${to}   （审计 ${m.window.entries} 条）\n`);
      console.log(`闭环成功率  ${pct(m.close_loop.success_rate).padStart(7)}  ${mark(m.verdict.close_loop_ok)}  目标 ≥${pct(m.targets.close_loop_success_rate)}  样本 ${m.close_loop.ok}/${m.close_loop.attempts}`);
      const ir = m.app_install.success_rate;
      console.log(`装软件成功率 ${ir === null ? '  无样本' : pct(ir).padStart(7)}  ${mark(m.verdict.app_install_ok)}  目标 ≥${pct(m.targets.app_install_success_rate)}  样本 ${m.app_install.ok}/${m.app_install.attempts}`);
      console.log(`P95 时延    ${String(m.latency.fast.p95_ms + 'ms').padStart(7)}  ${mark(m.verdict.p95_ok)}  交互层（目标 <${m.targets.p95_ms}ms，样本 ${m.latency.fast.samples}：P50 ${m.latency.fast.p50_ms}ms / 最大 ${m.latency.fast.max_ms}ms${m.latency.timeouts ? ` / 超时 ${m.latency.timeouts}` : ''}）`);
      console.log(`慢操作耗时  ${String(m.latency.slow.p95_ms + 'ms').padStart(7)}  ——   样本 ${m.latency.slow.samples}（${m.latency.slow.capabilities.join(' / ')}；本身耗时由业务决定，不计入达标判定）`);
      console.log(`安全拦截    ${pct(m.security.interception_rate).padStart(7)}  ${mark(m.verdict.interception_ok)}  ACL 拒绝 ${m.security.acl_denied} / 超频 ${m.security.rate_limited} / 认证失败 ${m.security.auth_failures}`);
      console.log(`\n总体: ${m.verdict.all_pass ? '✅ 四项全达标' : '⚠️ 存在未达标项'}`);

      const caps = Object.entries(m.by_capability).sort((a, b) => b[1].attempts - a[1].attempts);
      if (caps.length > 0) {
        console.log('\n按能力细分（Top 10）：');
        console.log(`  ${'能力'.padEnd(26)} ${'次数'.padStart(6)} ${'成功率'.padStart(8)} ${'P95'.padStart(9)}`);
        for (const [name, st] of caps.slice(0, 10)) {
          console.log(`  ${name.padEnd(26)} ${String(st.attempts).padStart(6)} ${pct(st.success_rate).padStart(8)} ${String(st.p95_ms + 'ms').padStart(9)}`);
        }
      }
    }),
  );
}

/** v16：网络变更两阶段提交（备份 → 应用 → 定时回滚 → 确认提交）。 */

export async function cmdInvoke(capability: string, opts: Options): Promise<void> {
  let args: Record<string, unknown> = {};
  if (opts.args) {
    try {
      args = JSON.parse(opts.args) as Record<string, unknown>;
    } catch {
      fail('--args 必须是合法 JSON');
    }
  }
  await withClient(async (c) => {
    const result: InvokeResult = await c.invoke(capability, args);
    printJson(result);
    if (result.status === 'failed') process.exitCode = 2;
  });
}

// ---------- v2 图形操作 ----------

export async function cmdApps(opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.AppList, {}, opts.json, (data) => {
      const rows = (data as { apps: Array<{ name: string; version: string; publisher: string }> }).apps;
      console.log(`已安装软件（${rows.length}）:`);
      for (const a of rows) console.log(`  ${a.name.padEnd(40)} ${(a.version || '-').padEnd(14)} ${a.publisher}`);
    }),
  );
}

export async function cmdInstall(pkg: string, opts: Options): Promise<void> {
  await withClient((c) =>
    callAndPrint(c, CapabilityNames.AppInstall, { package: pkg, id: opts.id }, opts.json, (data) => {
      const d = data as { installed: boolean; name: string; version: string; detail: string };
      console.log(d.installed ? `✓ 安装成功: ${d.name} ${d.version}` : `✗ 安装失败: ${d.name}`);
      if (d.detail) console.log(`\n${d.detail}`);
    }),
  );
}
