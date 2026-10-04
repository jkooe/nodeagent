import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { ipInAllowlist, certFingerprint, shortFingerprint } from '../../packages/protocol/dist/index.js';

// ---------- v21：来源网段白名单 ----------
test('ipInAllowlist：未配置 = 放行全部（向后兼容）', () => {
  assert.equal(ipInAllowlist('1.2.3.4'), true);
  assert.equal(ipInAllowlist('1.2.3.4', []), true);
  assert.equal(ipInAllowlist('1.2.3.4', ['*']), true);
});

test('ipInAllowlist：CIDR 按前缀比特匹配（不是字符串相等）', () => {
  assert.equal(ipInAllowlist('192.168.0.5', ['192.168.0.0/24']), true);
  assert.equal(ipInAllowlist('192.168.1.5', ['192.168.0.0/24']), false);
  assert.equal(ipInAllowlist('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(ipInAllowlist('11.1.2.3', ['10.0.0.0/8']), false);
  assert.equal(ipInAllowlist('192.168.0.200', ['192.168.0.128/25']), true);
  assert.equal(ipInAllowlist('192.168.0.100', ['192.168.0.128/25']), false);
});

test('ipInAllowlist：单 IP 与多条混合', () => {
  assert.equal(ipInAllowlist('127.0.0.1', ['127.0.0.1']), true);
  assert.equal(ipInAllowlist('127.0.0.2', ['127.0.0.1', '10.0.0.0/8']), false);
  assert.equal(ipInAllowlist('10.9.9.9', ['127.0.0.1', '10.0.0.0/8']), true);
});

test('ipInAllowlist：IPv4-mapped IPv6 必须与纯 IPv4 判等（Node 的监听器会这么报）', () => {
  // 关键：Node 在 IPv6 监听上把 IPv4 客户端报成 ::ffff:a.b.c.d
  assert.equal(ipInAllowlist('::ffff:192.168.0.5', ['192.168.0.0/24']), true);
  assert.equal(ipInAllowlist('::ffff:10.0.0.1', ['192.168.0.0/24']), false);
});

test('ipInAllowlist：IPv6 前缀与 zone 后缀', () => {
  assert.equal(ipInAllowlist('fe80::1', ['fe80::/10']), true);
  assert.equal(ipInAllowlist('fe80::1%en0', ['fe80::/10']), true, '带 zone 后缀应归一化');
  assert.equal(ipInAllowlist('2001:db8::1', ['fe80::/10']), false);
});

test('ipInAllowlist：非法来源地址在配了白名单时保守拒绝', () => {
  assert.equal(ipInAllowlist('not-an-ip', ['10.0.0.0/8']), false);
  assert.equal(ipInAllowlist('999.1.1.1', ['10.0.0.0/8']), false);
});

// ---------- v21：证书指纹 ----------
test('certFingerprint：PEM 与 DER 得到同一值（Windows 侧用 .NET 算 DER）', () => {
  // 固定的自签证书夹具（不引第三方依赖，保证测试确定性）
  const der = new Uint8Array(new X509Certificate(FIXTURE_CERT).raw);
  assert.equal(certFingerprint(FIXTURE_CERT), certFingerprint(der), 'PEM 与 DER 必须算出同一指纹');
  assert.match(certFingerprint(FIXTURE_CERT), /^[0-9a-f]{64}$/, '应为 64 位小写 hex');
});

test('certFingerprint：不同证书得到不同指纹（改一个字节即变）', () => {
  const raw = new Uint8Array(new X509Certificate(FIXTURE_CERT).raw);
  raw[raw.length - 1] = (raw[raw.length - 1] + 1) & 0xff; // 篡改末字节
  assert.notEqual(certFingerprint(FIXTURE_CERT), certFingerprint(raw));
});

test('shortFingerprint：可读格式且保留足够位数', () => {
  const fp = 'a'.repeat(64);
  const s = shortFingerprint(fp);
  assert.ok(s.includes(':'));
  assert.ok(s.replace(/:/g, '').length >= 20, '至少保留 20 位十六进制便于人工比对');
});

/** 固定的自签证书（仅测试用，与任何真实部署无关）。 */
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIDCjCCAfKgAwIBAgIJVXL5GdEwCNb0MA0GCSqGSIb3DQEBCwUAMCExHzAdBgNV
BAMTFm5vZGVhZ2VudC10ZXN0LWZpeHR1cmUwHhcNMjYxMDA0MTgxOTQxWhcNMzYx
MDAxMTgxOTQxWjAhMR8wHQYDVQQDExZub2RlYWdlbnQtdGVzdC1maXh0dXJlMIIB
IjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuxJei6y331/yEUAq71AcsXfV
tSOe2s3wKb2zqR2JKCJBSEmIIOZbDGfu5UE8pPkVmyOElQhipOQu5vFhjhbVE7Vs
WTFMCwu2uxpaJdYJ+BJqnPyo/gZMLGRzjL+FC5VWgZz4akP05vx4J7mMDksF+2qH
5aNGTVxMwRX3AoFh+kRjngv/bO5P7w+17VTY7TkC29Fa5fNSIcuFABQa1ToL1CCW
iX38nZR9iLaPAnNMGhjZTwgbTSGIVi06EIeK+2CVnlPt6eaUDLNPxGPME/3Fs5PK
xYTfDqOT9lfeKGD/AFK4RbqSpLlMm9QDT2TVDp/s9rMRjD9sTJQLEI/NiJHKDQID
AQABo0UwQzAMBgNVHRMEBTADAQH/MAsGA1UdDwQEAwIC9DAmBgNVHREEHzAdhhto
dHRwOi8vZXhhbXBsZS5vcmcvd2ViaWQjbWUwDQYJKoZIhvcNAQELBQADggEBAFJa
7lpph2qGIy8k7BlC2FMbxoC7/m5ieIKv1csTPiWlxHXGp414TX7oX1Z1t2UOl4Un
M0v1OkI9IPU2hcfZLHp8H02/xsp8VxElYiosZU4tzjce4oN/Rqlk9EUT4mc9OpdH
2CwVzXoDub5980VlAF7Ujg/jCii+WIDVSkEqGHfi/QAuZKmNa6itYS9E8TCQDTA4
K9hC6qcRROVd4upaXxkQQ7EWYTFjujur3JKNqof+LHei8rb88NrVCEUDJshwn4zi
q8v1k2VO4R7E2PnYRdFdYeQTzc/PxeJmFM7LKYVK+oLy6GgmecdQKKy0Bs+RDG4a
LXRExo5k4XnxHRJ2TP4=
-----END CERTIFICATE-----`;
