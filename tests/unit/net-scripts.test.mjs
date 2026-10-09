import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApplyCommand,
  buildRollbackScript,
  buildSelfCheck,
  maskToPrefix,
} from '../../apps/agent/dist/capabilities/network.js';

const snap = {
  alias: 'Ethernet',
  dhcp: false,
  ipv4: [{ ip: '192.168.1.159', prefix: 24 }],
  gateway: ['192.168.1.1'],
  dns: ['223.5.5.5'],
};
const args = { mode: 'static', ip: '192.168.1.88', mask: '255.255.255.0', gateway: '192.168.1.1' };

test('掩码换算：常见掩码与前缀长度互转', () => {
  assert.equal(maskToPrefix('255.255.255.0'), 24);
  assert.equal(maskToPrefix('255.255.0.0'), 16);
  assert.equal(maskToPrefix('255.255.255.192'), 26);
  assert.equal(maskToPrefix('255.255.255.255'), 32);
  assert.equal(maskToPrefix('乱码'), 24, '非法输入回退 24');
});

/**
 * 真机事故回归：曾经「先删旧地址 → 再加新地址」，Windows 残留的默认路由让
 * New-NetIPAddress 报 already exists → 新地址没加上 → 机器掉到 APIPA 彻底失联。
 * 下面几条断言就是那道防线。
 */
test('apply(static)：必须先加新地址、再清旧地址（顺序不可颠倒）', () => {
  const script = buildApplyCommand('static', 'Ethernet', args, snap);
  const iAdd = script.indexOf('New-NetIPAddress');
  const iRemove = script.indexOf('Remove-NetIPAddress');
  assert.ok(iAdd > 0 && iRemove > 0, '既要加也要清');
  assert.ok(iAdd < iRemove, '必须先 New-NetIPAddress 后 Remove-NetIPAddress（事故根因）');
});

test('apply(static)：建路由之前必须先清掉旧默认路由（否则 already exists）', () => {
  const script = buildApplyCommand('static', 'Ethernet', args, snap);
  const iRmRoute = script.indexOf('Remove-NetRoute');
  const iAddRoute = script.indexOf('New-NetRoute');
  assert.ok(iRmRoute > 0, '必须显式清理默认路由');
  assert.ok(iAddRoute > 0, '必须重建默认路由');
  assert.ok(iRmRoute < iAddRoute, 'Remove-NetRoute 必须在 New-NetRoute 之前');
});

test('apply：不得使用会在 Win11 挂起的 netsh set address', () => {
  const staticScript = buildApplyCommand('static', 'Ethernet', args, snap);
  const dhcpScript = buildApplyCommand('dhcp', 'Ethernet', { mode: 'dhcp' }, snap);
  for (const s of [staticScript, dhcpScript]) {
    assert.ok(!/netsh interface ipv4 set address/.test(s), 'netsh set address 在 Win11 会挂起（真机实测）');
    assert.ok(!/netsh interface ipv4 set dnsservers/.test(s), 'netsh set dnsservers 同类问题');
  }
  assert.match(staticScript, /Set-NetIPInterface|New-NetIPAddress/, '应使用原生 cmdlet');
});

test('apply(dhcp)：切 DHCP 用原生 cmdlet', () => {
  const s = buildApplyCommand('dhcp', 'Ethernet', { mode: 'dhcp' }, snap);
  assert.match(s, /Set-NetIPInterface -InterfaceAlias "Ethernet" -Dhcp Enabled/);
  assert.match(s, /Set-DnsClientServerAddress/);
});

test('自检：失败时自动执行回滚脚本（自愈）', () => {
  const chk = buildSelfCheck('Ethernet', '192.168.1.88', 'C:/rb.ps1');
  assert.match(chk, /Get-NetIPAddress/);
  assert.match(chk, /192\.168\.1\.88/, '应校验目标地址是否真的生效');
  assert.match(chk, /selfcheck FAILED -> auto rollback/);
  assert.match(chk, /& "C:\/rb\.ps1"/, '失败必须回滚，而不是把机器留在无地址状态');
});

test('rollback：同样先加后清 + 先清路由（否则回滚自己也会失败）', () => {
  const rb = buildRollbackScript(snap, 'C:/backup.txt', 'C:/rb.log');
  const iAdd = rb.indexOf('New-NetIPAddress');
  const iRemove = rb.indexOf('Remove-NetIPAddress');
  const iRmRoute = rb.indexOf('Remove-NetRoute');
  const iAddRoute = rb.indexOf('New-NetRoute');
  assert.ok(iAdd < iRemove, '回滚也必须先加后清');
  assert.ok(iRmRoute < iAddRoute, '回滚也必须先清路由');
  assert.match(rb, /192\.168\.1\.159/, '必须恢复快照里的原地址');
  assert.match(rb, /192\.168\.1\.1/, '必须恢复原网关');
  assert.match(rb, /223\.5\.5\.5/, '必须恢复原 DNS');
  assert.ok(!/netsh -f/.test(rb), '不得用 netsh -f 回滚（备份编码 + set address 双重问题）');
});

test('rollback：DHCP 快照走「切回 DHCP」而非设静态', () => {
  const rb = buildRollbackScript({ ...snap, dhcp: true, ipv4: [] }, 'C:/backup.txt', 'C:/rb.log');
  assert.match(rb, /-Dhcp Enabled/);
  assert.ok(!/New-NetIPAddress/.test(rb), 'DHCP 快照不应写静态地址');
});
