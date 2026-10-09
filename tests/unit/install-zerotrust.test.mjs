import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 零信任优先安装（v24）的**源码断言**。
 *
 * 为什么用源码断言：install.ps1 是 5.1 脚本，Node 侧无法直接执行它；
 * 而这里要守的是「关键决策逻辑不许被误删」—— 一旦有人重构掉 acl 写入或
 * 告警文案，测试立刻红。运行时的正确性已在真机用等效片段验证过
 * （CASE A ed25519+deny / CASE B psk 无 acl / CASE C 缺字段回退 psk）。
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ps1 = readFileSync(join(ROOT, 'scripts', 'install.ps1'), 'utf8');

test('install.ps1 有 ClientAclFile 参数（零信任入口）', () => {
  assert.match(ps1, /\[string\]\$ClientAclFile/, '缺少 -ClientAclFile 参数');
});

test('install.ps1 默认探测脚本同目录的 client-acl.json', () => {
  assert.match(ps1, /client-acl\.json/, '缺少默认探测路径');
  assert.match(ps1, /\$scriptDir/, '应用 $scriptDir 兜底（-Command 调用时 $PSScriptRoot 为空）');
});

test('install.ps1 有 useZeroTrust 判定且 auth_mode 条件化', () => {
  assert.match(ps1, /\$useZeroTrust\s*=/, '缺少 useZeroTrust 判定');
  assert.match(ps1, /auth_mode\s*=\s*if \(\$useZeroTrust\)/, 'auth_mode 必须按零信任开关条件化');
});

test('零信任分支写入 acl 且 default_effect=deny（兜底拒绝）', () => {
  assert.match(ps1, /default_effect\s*=\s*"deny"/, 'default_effect 必须是 deny（未登记一律拒）');
  assert.match(ps1, /clients\s*=\s*@\(\$aclEntry\)/, '缺少 clients 数组写入');
});

test('缺 client_id/pubkey 时忽略并回退（不写半截 ACL）', () => {
  assert.match(ps1, /-not \$aclEntry\.client_id -or -not \$aclEntry\.pubkey/, '缺少字段校验');
  assert.match(ps1, /\$aclEntry = \$null/, '校验失败必须置空以回退');
});

test('psk 路径必须给出醒目安全告警（不能静默降级）', () => {
  assert.match(ps1, /SECURITY WARNING/, 'psk 分支缺少醒目告警');
  assert.match(ps1, /SELF-REPORTED/, '告警须说明 client_id 可自报这一固有问题');
  assert.match(ps1, /nodeagent keygen/, '告警须给出切换命令');
  assert.match(ps1, /Yellow/, '告警须用醒目颜色（Yellow）');
});

test('零信任路径给出正确的连接指引（--id + --auth-mode）', () => {
  assert.match(ps1, /--auth-mode ed25519/, '缺少 ed25519 连接示例');
  assert.match(ps1, /Zero-trust is ON/, '缺少启用确认输出');
});

test('安装写入的 JSON 用 -Depth 6（acl 嵌套不会被截断）', () => {
  assert.match(ps1, /ConvertTo-Json -Depth 6/, 'acl 是嵌套结构，Depth 不足会被截成字符串');
});
