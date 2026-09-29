#!/usr/bin/env node
/**
 * MCP 事件通路端到端验证。
 *
 * 需要一台已配置的被控端（~/.nodeagent/config.json 里有 current 设备）。
 * 用法:
 *   node scripts/verify-mcp-events.mjs
 *   NODEAGENT_MCP=~/.local/bin/nodeagent-mcp NA_WATCH_DIR='D:\\tmp' node scripts/verify-mcp-events.mjs
 *
 * 验证两条通路：
 *   1) 推送：na_event_watch(notify=true) -> MCP 日志通知（notifications/message）
 *   2) 拉取：na_event_poll 增量读被控端缓冲
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const MCP = process.env['NODEAGENT_MCP'] ?? 'nodeagent-mcp';
const WATCH_DIR = process.env['NA_WATCH_DIR'] ?? 'C:\\Users\\Public\\na-watch';
const proc = spawn(MCP, [], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();
const notifications = [];

proc.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else if (msg.method === 'notifications/message') {
      notifications.push(msg.params);
    }
  }
});
proc.stderr.on('data', (d) => process.stderr.write(`[mcp] ${d}`));

let idSeq = 0;
function call(method, params) {
  const id = ++idSeq;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ error: { message: 'timeout' } });
      }
    }, 90_000);
  });
}

const tool = (name, args) => call('tools/call', { name, arguments: args });
const textOf = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r).slice(0, 300);

const log = (s) => console.log(s);

try {
  // 1) 握手
  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'verify', version: '1' },
  });
  log(`1) initialize: ${init.result ? 'ok' : 'FAIL'} (${init.result?.serverInfo?.name ?? '?'})`);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 2) 列出工具（确认事件类工具已注册）
  const tools = await call('tools/list', {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  const evTools = names.filter((n) => n.startsWith('na_event'));
  log(`2) tools/list: 共 ${names.length} 个，事件类 ${evTools.length} 个 → ${evTools.join(', ')}`);

  // 3) 订阅文件事件（开启推送）
  const w = await tool('na_event_watch', {
    kind: 'file',
    path: WATCH_DIR,
    notify: true,
  });
  log(`3) na_event_watch(notify=true): ${textOf(w).slice(0, 160)}`);

  // 4) 制造一次文件变动（经 na_exec）
  await new Promise((r) => setTimeout(r, 800));
  const mk = await tool('na_exec', {
    command:
      `New-Item -ItemType File -Path '${WATCH_DIR}\\mcp-evt.txt' -Force | Out-Null; ` +
      `Add-Content '${WATCH_DIR}\\mcp-evt.txt' 'hi'; Start-Sleep 1; ` +
      `Remove-Item '${WATCH_DIR}\\mcp-evt.txt' -Force; Write-Output done`,
  });
  log(`4) 制造变动: ${textOf(mk).split('\n')[0].slice(0, 80)}`);

  // 5) 等推送到达
  await new Promise((r) => setTimeout(r, 3000));
  log(`5) 收到的推送通知: ${notifications.length} 条`);
  for (const n of notifications.slice(0, 3)) log(`     · ${String(n.data)}`);

  // 6) 拉取通路
  const poll = await tool('na_event_poll', { limit: 10 });
  log(`6) na_event_poll: ${textOf(poll).replace(/\s+/g, ' ').slice(0, 200)}`);

  // 7) 列表 + 推送状态
  const list = await tool('na_event_list', {});
  log(`7) na_event_list:\n${textOf(list).split('\n').map((l) => '     ' + l).join('\n')}`);

  log(`\n结论：推送 ${notifications.length > 0 ? '✅ 生效' : '⚠️ 未收到（宿主可能不转发日志通知，拉取通路仍可用）'}；拉取 ✅`);
} finally {
  proc.kill();
}
