import { createHash, X509Certificate } from 'node:crypto';

/**
 * 网络访问控制与证书指纹（v21 第一批加固）。
 *
 * 背景：这两个能力必须**两端用同一套算法**，否则控制端钉的指纹与被控端算的对不上、
 * 或白名单在 IPv4/IPv6 表示上出现分歧 → 所以放在 protocol 包里共享。
 */

/** 归一化 IP：去掉 IPv6 的 zone 后缀，并把 IPv4-mapped（::ffff:a.b.c.d）转成 4 字节。 */
function parseIp(ip: string): Uint8Array | null {
  let s = ip.trim();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone); // fe80::1%en0
  if (!s) return null;
  // Node 在 IPv6 监听上会把 IPv4 客户端报成 ::ffff:1.2.3.4
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) s = mapped[1] as string;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) {
    const parts = s.split('.').map((n) => Number.parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    return Uint8Array.from(parts);
  }
  if (!s.includes(':')) return null;
  // 完整展开 IPv6（:: 展开为全 0，末组按十六进制解析）
  const halves = s.split('::');
  const head = halves[0] ?? '';
  const tail = halves[1];
  const headParts = head.length > 0 ? head.split(':') : [];
  const tailParts = tail === undefined || tail.length === 0 ? [] : tail.split(':');
  const fill = 8 - headParts.length - tailParts.length;
  if (fill < 0) return null;
  const groups = [
    ...headParts,
    ...Array.from({ length: fill }, () => '0'),
    ...tailParts,
  ];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const g = groups[i] as string;
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = Number.parseInt(g, 16);
    out[i * 2] = (n >> 8) & 0xff;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

function parseCidr(spec: string): { bytes: Uint8Array; bits: number } | null {
  const [addr, lenRaw] = spec.trim().split('/');
  const bytes = parseIp(addr ?? '');
  if (!bytes) return null;
  const max = bytes.length * 8;
  const bits = lenRaw === undefined ? max : Number.parseInt(lenRaw, 10);
  if (Number.isNaN(bits) || bits < 0 || bits > max) return null;
  return { bytes, bits };
}

/**
 * 判断来源 IP 是否在允许列表内。
 *
 * 语义：
 * - 列表**为空或未配置** → 放行全部（保持向后兼容；但 agent 会打印醒目告警，
 *   并在 system.info / CLI 里提示「未设白名单」）。
 * - 支持三种写法混用：CIDR（`192.168.0.0/16`）、单个 IP（`10.1.2.3`）、
 *   以及 `*` 表示全放行。
 *
 * 注意：比对是**按前缀比特**而不是字符串相等 —— 否则 `::ffff:192.168.0.5`
 * 与 `192.168.0.5` 会判不相等（前者是 IPv6-mapped，后者是 IPv4）。
 */
export function ipInAllowlist(remoteIp: string, list?: string[]): boolean {
  if (!list || list.length === 0) return true;
  if (list.some((x) => x.trim() === '*')) return true;
  const ip = parseIp(remoteIp);
  if (!ip) return false; // 解析不了来源地址 → 保守拒绝（配了白名单时）
  for (const spec of list) {
    const cidr = parseCidr(spec);
    if (!cidr) continue;
    if (cidr.bytes.length !== ip.length) continue; // v4 规则不匹配 v6 地址（除非显式写 ::/0）
    let ok = true;
    for (let i = 0; i < cidr.bytes.length; i += 1) {
      const remain = cidr.bits - i * 8;
      if (remain <= 0) break;
      const take = remain >= 8 ? 8 : remain;
      const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
      if (((cidr.bytes[i] as number) & mask) !== ((ip[i] as number) & mask)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * 计算 TLS 证书指纹：**sha256(DER) 的十六进制**（小写，64 位）。
 *
 * 为什么是 DER 而不是 PEM 文件的字节：PEM 里有多余的头尾/换行，两边算出来必然不同。
 * DER 是证书的规范二进制编码 —— Windows 的 `X509Certificate2.RawData` 也是它，
 * 所以 install.ps1 能用 .NET 算出完全相同的值（供带外核对）。
 */
export function certFingerprint(derOrPem: Uint8Array | string): string {
  const der =
    typeof derOrPem === 'string' ? new Uint8Array(new X509Certificate(derOrPem).raw) : derOrPem;
  return createHash('sha256').update(der).digest('hex');
}

/** 格式化便于人读/口述：前 16 位 + 后 8 位（带冒号分组）。 */
export function shortFingerprint(fp: string): string {
  const head = fp.slice(0, 16).toUpperCase();
  const tail = fp.slice(-8).toUpperCase();
  return `${head}:${tail.match(/.{1,4}/g)?.join(':')}`;
}
