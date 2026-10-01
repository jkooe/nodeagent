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

// CLI 命令组：cmd/net.ts
export async function cmdNet(sub: string | undefined, opts: Options): Promise<void> {
  if (sub === 'status' || sub === undefined) {
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.NetStatus, {}, opts.json, (data) => {
        const d = data as {
          interfaces: Array<Record<string, unknown>>;
          pending: Array<{ task_name: string; seconds_left: number; rollback_at: number }>;
          pending_count: number;
          note: string;
        };
        console.log('网卡地址：');
        for (const i of d.interfaces ?? []) {
          console.log(`  ${String(i['InterfaceAlias'] ?? '?')}  ip=${String(i['ip'] ?? '-')}  gw=${String(i['gw'] ?? '-')}`);
        }
        if (d.pending_count > 0) {
          console.log('\n⏳ 待确认的网络变更（逾期自动回滚）：');
          for (const p of d.pending) {
            console.log(`  ${p.task_name}  剩余 ${p.seconds_left}s`);
          }
          console.log('  确认提交：nodeagent net confirm');
        } else {
          console.log('\n（无待确认变更）');
        }
      }),
    );
    return;
  }

  if (sub === 'confirm') {
    const args: Record<string, unknown> = {};
    if (opts.taskName) args['task_name'] = opts.taskName;
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.NetConfirm, args, opts.json, (data) => {
        const d = data as { confirmed: number; cancelled: string[]; remaining: string[]; note?: string };
        if (d.confirmed === 0) console.log(`✓ 无需确认：${d.note ?? '没有待确认的网络变更'}`);
        else console.log(`✓ 已确认（提交）${d.confirmed} 项：${d.cancelled.join(', ')}`);
        if ((d.remaining ?? []).length > 0) console.error(`⚠️ 仍有未取消：${d.remaining.join(', ')}`);
      }),
    );
    return;
  }

  if (sub === 'apply') {
    const modeRaw = opts.mode ?? 'static';
    const args: Record<string, unknown> = { mode: modeRaw };
    if (opts.iface) args['interface'] = opts.iface;
    if (opts.ip) args['ip'] = opts.ip;
    if (opts.mask) args['mask'] = opts.mask;
    if (opts.gateway) args['gateway'] = opts.gateway;
    if (opts.dns) args['dns'] = String(opts.dns).split(',').map((x) => x.trim());
    if (opts.command) args['command'] = opts.command;
    if (opts.confirmWithin) args['confirm_within_ms'] = Number(opts.confirmWithin);
    if (!opts.yes) {
      fail(
        '网络变更属高危操作，需显式加 --yes 确认。\n' +
          '行为：备份当前配置 → 应用变更 → 注册 OS 级定时回滚任务 → 你在窗口期内 net confirm 即提交；\n' +
          '      逾期未确认则自动回滚到变更前配置（不会把自己关在门外）。',
      );
    }
    // 网络变更本身耗时较长（netsh 重配网卡 + 注册计划任务），默认 60s 不够
    await withClient((c) =>
      callAndPrint(c, CapabilityNames.NetApply, args, opts.json, (data) => {
        const d = data as {
          applied: boolean;
          interface: string;
          backup_path: string;
          task_name: string;
          confirm_within_ms: number;
          hint: string;
        };
        console.log(`✓ 已应用变更（网卡 ${d.interface}），备份：${d.backup_path}`);
        console.log(`  自动回滚任务：${d.task_name}（${Math.round(d.confirm_within_ms / 1000)}s 后触发）`);
        console.log(`  ${d.hint}`);
      }, 200_000),
    );
    return;
  }

  fail('用法: nodeagent net [status] | net apply --mode static|dhcp|command [...] --yes | net confirm [--task-name X]');
}
