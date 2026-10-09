import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';
import { agentDir } from '../config.js';
import { audit } from '../audit.js';
import { extractPsError } from '../util/ps-helper.js';

type Args = Record<string, unknown>;

/**
 * 网络变更两阶段提交（v16 / commit-confirm）。
 *
 * ## 解决的痛点（审查报告 §5.4「自断生路」悖论）
 * 远程改 IP / 切 DHCP 是**最容易把自己关在门外**的操作：改完若新地址连不上，
 * 控制端就再也进不来了，而现场又没人能救 —— 只能物理接触。
 *
 * ## 方案：仿网络设备的 commit-confirm（同 Cisco `reload in 5` 的思路）
 *   ① 备份当前网络配置（netsh dump / ip addr 快照）
 *   ② 应用变更
 *   ③ **注册一个 OS 级的一次性计划任务**，到点自动执行回滚
 *      —— 关键：任务由 OS 触发，**不依赖 agent 进程存活**（agent 被网络变更
 *         影响/重启甚至崩溃都照样回滚）
 *   ④ 控制端（可能已在新地址上）调用 system.net.confirm 取消该任务 = 提交
 *   未确认 → 到点自动回滚 → 链路恢复原样，不会失联。
 *
 * ## 为什么用 S4U 计划任务
 * 网络变更最常发生在「无人值守」场景（无人登录）。S4U 无需保存密码且注销后仍可运行，
 * 正是这里需要的语义。
 */

const NET_DIR = (): string => join(agentDir(), 'net');
const TASK_PREFIX = 'nodeagent-netrollback-';
/** 延时执行变更的秒数：留出时间让本次响应先回到调用方（连接随后会被变更切断） */
const APPLY_TASK_PREFIX = 'nodeagent-netapply-';
const APPLY_DELAY_MS = 3000;

export interface PendingRollback {
  task_name: string;
  created_at: number;
  rollback_at: number;
  seconds_left: number;
  interface: string;
  mode: string;
  backup_path: string;
  requested_by?: string;
}

/**
 * 执行一段 PowerShell：**落地临时脚本 + -File**。
 *
 * ⚠️ 为什么不用 `-EncodedCommand`：真机实测同一段注册计划任务的脚本，
 *    `-File` 稳定成功并回显 `Scheduled`；`-EncodedCommand` 下 PowerShell 把进度流
 *    以 CLIXML 写 stderr、且 stdout 拿不到预期输出，导致「明明成功却被判失败」，
 *    个别场景还直接报账号映射错误。计划任务类操作一律走 -File。
 */
async function runPsFile(script: string, timeoutMs: number, tag = 'ps'): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const dir = ensureDir();
  const path = join(dir, `${tag}-${Date.now()}.ps1`);
  writeFileSync(path, withBom(script), 'utf8');
  return execCommand({
    command: `powershell -NoProfile -ExecutionPolicy Bypass -File ${JSON.stringify(path)}`,
    timeoutMs,
  });
}

/**
 * 生成的 .ps1 **必须带 UTF-8 BOM**。
 *
 * ⚠️ 真机踩过：PowerShell 5.1 读**无 BOM** 的 .ps1 会按系统 ANSI(GBK) 解析，
 *    脚本里的中文（如网卡名「Ethernet」）会吃掉后面的闭合引号 →
 *    报「The string is missing the terminator」→ 计划任务退出码 1 且不留日志。
 *    所有落盘的 PowerShell 脚本一律经此函数。
 */
export function withBom(content: string): string {
  return `\uFEFF${content}`;
}

/**
 * 把字符串包成 PowerShell **单引号字面量**。
 *
 * ⚠️ 单引号内一切都是字面量：**反斜杠不需要任何转义**。
 *    曾经用 JSON.stringify（双引号）或手动把 \ 翻倍当转义，结果生成 `C:\\Users\\...`
 *    这种非法路径 → Out-File 失败 → 计划任务退出码 1 且不留日志（真机踩过）。
 *    需要字面量时一律走本函数；需要插值时用双引号但避免反斜杠。
 */
export function psLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * 生成「注册一次性计划任务」的 PowerShell 脚本（唯一实现，两处复用）。
 *
 * ⚠️ 两个真机教训都固化在这里：
 *   1) **账号名必须用 WindowsIdentity 取**，不要用 "$env:USERDOMAIN\$env:USERNAME" 拼 ——
 *      在 TS 模板串里 `\$` 会被当转义吃掉反斜杠，拼出「机器名+纯数字」这种不可解析的账号，
 *      Register-ScheduledTask 报 HRESULT 0x80070534「No mapping between account names...」。
 *   2) 复用同一实现：此前回滚/延时两处各写一份，改了一处漏了另一处（真机踩过）。
 */
export function buildTaskRegistration(taskName: string, scriptPath: string, atIso: string): string {
  return [
    `$ErrorActionPreference='Stop'`,
    `$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"'`,
    `$t = New-ScheduledTaskTrigger -Once -At ([datetime]::Parse('${atIso}'))`,
    `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)`,
    // 用权威身份，绝不拼环境变量（见函数注释）
    `$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name`,
    `$p = New-ScheduledTaskPrincipal -UserId $me -RunLevel Highest -LogonType S4U`,
    `Register-ScheduledTask -TaskName '${taskName}' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`,
    `Write-Output 'Scheduled'`,
  ].join('\n');
}

function ensureDir(): string {
  const d = NET_DIR();
  mkdirSync(d, { recursive: true });
  return d;
}

/** 从计划任务名解析待确认项（任务名自带时间戳）。 */
function pendingFromTasks(taskNames: string[]): Array<{ task_name: string; rollback_at: number }> {
  return taskNames
    .filter((t) => t.startsWith(TASK_PREFIX))
    .map((t) => {
      const ms = Number(t.slice(TASK_PREFIX.length));
      return { task_name: t, rollback_at: Number.isFinite(ms) ? ms : 0 };
    });
}

// ---------------- 平台实现 ----------------

/** 找出承载默认路由的网卡名（未显式指定 interface 时使用）。 */
async function defaultInterfaceWindows(): Promise<string> {
  const ifaceScript =
    `$c = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1; ` +
    `if ($c) { $c.InterfaceAlias } else { '' }`;
  const r = await execCommand({
    command: `powershell -NoProfile -EncodedCommand ${Buffer.from(ifaceScript, 'utf16le').toString('base64')}`,
    timeoutMs: 30_000,
  });
  const name = r.stdout.trim();
  if (!name) {
    throw new CapabilityError(
      ErrorCodes.EXECUTION_FAILED,
      '无法自动识别默认网卡（没有带默认网关的接口），请显式传 interface',
    );
  }
  return name;
}

/** 掩码 → 前缀长度（255.255.255.0 → 24）。 */
export function maskToPrefix(mask: string): number {
  const parts = mask.split('.');
  if (parts.length !== 4) return 24;
  let bits = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return 24;
    bits += n.toString(2).split('').filter((c) => c === '1').length;
  }
  return bits;
}

/** 结构化快照（回滚脚本据此用**原生 cmdlet** 重建配置）。 */
export interface IfaceSnapshot {
  alias: string;
  dhcp: boolean;
  ipv4: Array<{ ip: string; prefix: number }>;
  gateway: string[];
  dns: string[];
}

async function snapshotIface(iface: string): Promise<IfaceSnapshot> {
  const script = `
$ErrorActionPreference='Continue'
$a = ${JSON.stringify(iface)}
$o = [ordered]@{ alias = $a; dhcp = $false; ipv4 = @(); gateway = @(); dns = @() }
$ipif = Get-NetIPInterface -InterfaceAlias $a -AddressFamily IPv4 -ErrorAction SilentlyContinue
if ($ipif) { $o.dhcp = ($ipif.Dhcp -eq 'Enabled') }
$o.ipv4 = @(Get-NetIPAddress -InterfaceAlias $a -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.PrefixOrigin -ne 'WellKnown' } |
  ForEach-Object { [ordered]@{ ip = $_.IPAddress; prefix = [int]$_.PrefixLength } })
$o.gateway = @(Get-NetRoute -InterfaceAlias $a -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.NextHop })
$o.dns = @(Get-DnsClientServerAddress -InterfaceAlias $a -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  ForEach-Object { $_.ServerAddresses })
$o | ConvertTo-Json -Compress -Depth 4
`;
  const r = await execCommand({
    command: `powershell -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`,
    timeoutMs: 30_000,
  });
  const start = r.stdout.indexOf('{');
  const end = r.stdout.lastIndexOf('}');
  const fallback: IfaceSnapshot = { alias: iface, dhcp: false, ipv4: [], gateway: [], dns: [] };
  if (start < 0 || end <= start) return fallback;
  try {
    const j = JSON.parse(r.stdout.slice(start, end + 1)) as Record<string, unknown>;
    return {
      alias: iface,
      dhcp: j['dhcp'] === true,
      ipv4: (j['ipv4'] as Array<{ ip: string; prefix: number }>) ?? [],
      gateway: (j['gateway'] as string[]) ?? [],
      dns: (j['dns'] as string[]) ?? [],
    };
  } catch {
    return fallback;
  }
}

/** 由结构化快照生成**原生 cmdlet** 回滚脚本（不用 netsh set —— 它在 Win11 上会挂起）。 */
export function buildRollbackScript(snap: IfaceSnapshot, backupTxt: string, logPath: string): string {
  const a = JSON.stringify(snap.alias);
  const L = psLit(logPath);
  const lines = [
    `# nodeagent 自动回滚（生成于 ${new Date().toISOString()}）`,
    `$ErrorActionPreference = 'Continue'`,
    `$log = ${L}`,
    `function W($m) { ("[" + (Get-Date -Format o) + "] " + $m) | Out-File -Append -Encoding utf8 $log }`,
    `W 'rollback begin'`,
    `try {`,
  ];
  if (snap.dhcp) {
    lines.push(`  Set-NetIPInterface -InterfaceAlias ${a} -Dhcp Enabled -ErrorAction SilentlyContinue`);
    lines.push(`  Set-DnsClientServerAddress -InterfaceAlias ${a} -ResetServerAddresses -ErrorAction SilentlyContinue`);
    lines.push(`  W 'restored: dhcp'`);
  } else {
    lines.push(`  Set-NetIPInterface -InterfaceAlias ${a} -Dhcp Disabled -ErrorAction SilentlyContinue`);
    // 同样「先加后清 + 先清默认路由」——否则回滚本身也会踩 already exists（真机事故根因）
    for (const addr of snap.ipv4) {
      lines.push(
        `  New-NetIPAddress -InterfaceAlias ${a} -IPAddress ${JSON.stringify(addr.ip)} -PrefixLength ${addr.prefix} -ErrorAction SilentlyContinue | Out-Null`,
      );
    }
    lines.push(`  Get-NetRoute -InterfaceAlias ${a} -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue`);
    const keep = snap.ipv4.map((x) => JSON.stringify(x.ip)).join(',');
    lines.push(`  $keep = @(${keep})`);
    lines.push(`  Get-NetIPAddress -InterfaceAlias ${a} -AddressFamily IPv4 -ErrorAction SilentlyContinue |`);
    lines.push(`    Where-Object { $keep -notcontains $_.IPAddress -and $_.PrefixOrigin -ne 'WellKnown' } |`);
    lines.push(`    ForEach-Object { Remove-NetIPAddress -IPAddress $_.IPAddress -InterfaceAlias ${a} -Confirm:$false -ErrorAction SilentlyContinue }`);
    if (snap.gateway[0]) {
      lines.push(
        `  New-NetRoute -InterfaceAlias ${a} -DestinationPrefix '0.0.0.0/0' -NextHop ${JSON.stringify(snap.gateway[0])} -ErrorAction SilentlyContinue | Out-Null`,
      );
    }
    if (snap.dns.length > 0) {
      lines.push(
        `  Set-DnsClientServerAddress -InterfaceAlias ${a} -ServerAddresses ${snap.dns.map((d) => JSON.stringify(d)).join(',')} -ErrorAction SilentlyContinue`,
      );
    }
    lines.push(`  W 'restored: static'`);
  }
  lines.push(`} catch { W ("rollback failed: " + $_) }`);
  lines.push(`W ('netsh dump for manual recovery: ' + ${psLit(backupTxt)})`);
  lines.push(`W 'rollback done'`);
  return lines.join('\n');
}

/** 读取网卡当前地址（用于回报与审计）。 */
async function readIfaceWindows(iface: string): Promise<Record<string, unknown>> {
  const script = `
$ErrorActionPreference='Continue'
$c = Get-NetIPConfiguration -InterfaceAlias ${JSON.stringify(iface)} -ErrorAction SilentlyContinue
if (-not $c) { Write-Output '{}'; return }
$o = [ordered]@{ interface = ${JSON.stringify(iface)} }
$o.ipv4 = @($c.IPv4Address | ForEach-Object { $_.IPAddress })
$o.prefix = @($c.IPv4Address | ForEach-Object { $_.PrefixLength })
$o.gateway = @($c.IPv4DefaultGateway | ForEach-Object { $_.NextHop })
$o.dns = @($c.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses } | Select-Object -First 4)
$dhcp = Get-NetIPInterface -InterfaceAlias ${JSON.stringify(iface)} -AddressFamily IPv4 -ErrorAction SilentlyContinue
$o.dhcp = ($dhcp.Dhcp -eq 'Enabled')
$o | ConvertTo-Json -Compress
`;
  const r = await execCommand({
    command: `powershell -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`,
    timeoutMs: 30_000,
  });
  const start = r.stdout.indexOf('{');
  const end = r.stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return { interface: iface };
  try {
    return JSON.parse(r.stdout.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { interface: iface };
  }
}

// ---------------- system.net.apply ----------------

export async function netApply(args: Args): Promise<unknown> {
  const mode = (args['mode'] as string | undefined) ?? 'static';
  const confirmWithinMs = Math.max(
    15_000,
    Math.min(600_000, (args['confirm_within_ms'] as number | undefined) ?? 60_000),
  );
  const explicitIface = args['interface'] as string | undefined;
  const customCommand = args['command'] as string | undefined;

  const dir = ensureDir();
  const ts = Date.now();

  if (!IS_WINDOWS) {
    // POSIX：只支持「自定义命令 + 分离式回滚」——静态/DHCP 自动化涉及 nmcli/netplan
    // 差异过大，未做（避免给出不可靠的自动化承诺）。
    if (!customCommand) {
      throw new CapabilityError(
        ErrorCodes.UNSUPPORTED_PLATFORM,
        'macOS/Linux 被控端仅支持 mode=command（自定义命令）；静态/DHCP 自动化当前仅 Windows',
        { platform: process.platform },
      );
    }
    return posixCommandApply(customCommand, confirmWithinMs, dir, ts);
  }

  const iface = explicitIface ?? (await defaultInterfaceWindows());
  const before = await readIfaceWindows(iface);

  // ① 备份：netsh 导出的脚本可用 `netsh -f` 原样恢复
  const backupPath = join(dir, `backup-${ts}.txt`);
  // ⚠️ 关键：netsh 输出的是 **OEM 代码页（中文系统=GBK）字节**。经 PowerShell 重定向会被
  //    转码破坏，导致回滚时 `netsh -f` 解析失败（报「找不到下列命令」）—— 也就是说
  //    回滚看似执行、实际什么都没恢复（真机踩过）。必须走 cmd 的原始重定向保字节。
  const dump = await execCommand({
    command: `cmd.exe /c netsh -c interface dump > "${backupPath}"`,
    timeoutMs: 30_000,
  });
  if (dump.exit_code !== 0 || !existsSync(backupPath)) {
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '网络配置备份失败，已中止（不做无备份的变更）', {
      detail: (dump.stderr || dump.stdout).slice(0, 300),
    });
  }

  // ② 快照 + 生成回滚脚本（与 agent 进程解耦，由计划任务触发）
  //    ⚠️ 不用「netsh -f 备份」回滚：备份里是 `set address`，而该命令在 Win11 上会**挂起**
  //    （真机实测 >60s 无响应）—— 那样回滚等于没有。改为按结构化快照用原生 cmdlet 重建。
  const snapshot = await snapshotIface(iface);
  const rollbackLog = join(dir, `rollback-${ts}.log`);
  const rollbackPath = join(dir, `rollback-${ts}.ps1`);
  writeFileSync(rollbackPath, withBom(buildRollbackScript(snapshot, backupPath, rollbackLog)), 'utf8');

  // ③ 先注册一次性回滚任务（OS 级，S4U —— 不依赖登录会话与 agent 进程）
  //    **先武装后开火**：即使 apply 慢或挂起，保护也已经就位。
  //    任务名编码的是**回滚时间戳**（不是创建时间），status 可直接算出剩余秒数。
  // 回滚时间 = 现在 + 延时执行 + 确认窗口（窗口从变更真正生效时算起）
  const at = new Date(Date.now() + APPLY_DELAY_MS + confirmWithinMs);
  const taskName = `${TASK_PREFIX}${at.getTime()}`;
  const register = buildTaskRegistration(taskName, rollbackPath, at.toISOString());
  const reg = await runPsFile(register, 60_000, 'reg-rollback');
  if (!reg.stdout.includes('Scheduled')) {
    throw new CapabilityError(
      ErrorCodes.EXECUTION_FAILED,
      '**回滚任务注册失败，已中止变更**（宁可不变更也不做无保护的网络改动）',
      {
        detail: `exit=${reg.exit_code} ` + (extractPsError(reg.stderr) || reg.stdout.slice(0, 400) || '(无输出)'),
        backup_path: backupPath,
      },
    );
  }

  // ④ 应用变更 —— **异步执行**，先应答再动手。
  //
  // 为什么必须异步：改地址/切 DHCP 必然导致本控制端与被控端的连接中断（旧地址被移除），
  // 同步执行的话调用方永远收不到返回值（真机实测：客户端 200s 超时，而变更其实已生效）。
  // 与网络设备的 commit-confirm 一致：先排程，交出凭据，由调用方在新地址上确认。
  const applyCmd = buildApplyCommand(mode, iface, args, snapshot);
  const applyScriptPath = join(dir, `apply-${ts}.ps1`);
  writeFileSync(
    applyScriptPath,
    withBom([
      `$ErrorActionPreference='Stop'`,
      `$log = ${psLit(join(dir, `apply-${ts}.log`))}`,
      `try {`,
      ...applyCmd.split('\n').map((l) => `  ${l}`),
      `  "apply ok" | Out-File -Append -Encoding utf8 $log`,
      `} catch { ("apply failed: " + $_) | Out-File -Append -Encoding utf8 $log }`,
      // 自检 + 失败自愈（没有它就会静默把机器留在无地址状态 —— 真机事故根因之一）
      buildSelfCheck(iface, mode === 'static' ? (args['ip'] as string) : null, rollbackPath),
    ].join('\n')),
    'utf8',
  );
  const applyAt = new Date(Date.now() + APPLY_DELAY_MS);
  const applyTask = `${APPLY_TASK_PREFIX}${applyAt.getTime()}`;
  const regApply = buildTaskRegistration(applyTask, applyScriptPath, applyAt.toISOString());
  const regA = await runPsFile(regApply, 60_000, 'reg-apply');
  if (!regA.stdout.includes('Scheduled')) {
    // 排程失败：撤销已注册的回滚任务，保证状态干净
    await runPsFile(
      `Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue`,
      30_000,
      'unreg',
    );
    throw new CapabilityError(ErrorCodes.EXECUTION_FAILED, '变更排程失败，已撤销回滚任务（配置未改动）', {
      detail:
        `exit=${regA.exit_code} ` +
        (extractPsError(regA.stderr) || '(无 stderr) ') +
        ` | out=${regA.stdout.replace(/\s+/g, ' ').slice(0, 200)}`,
    });
  }

  audit({
    type: 'net.change',
    capability: 'system.net.apply',
    status: 'ok',
    reason:
      `mode=${mode} interface=${iface} apply_at=${applyAt.getTime()} rollback_at=${at.getTime()} ` +
      `backup=${backupPath} snapshot_dhcp=${snapshot.dhcp} snapshot_ip=${JSON.stringify(snapshot.ipv4)}`,
  });

  return {
    apply_scheduled: true,
    apply_at: applyAt.getTime(),
    apply_task: applyTask,
    mode,
    interface: iface,
    backup_path: backupPath,
    rollback_script: rollbackPath,
    rollback_scheduled: true,
    task_name: taskName,
    rollback_at: at.getTime(),
    confirm_within_ms: confirmWithinMs,
    before: { ...snapshot, raw: before },
    hint:
      `变更将于约 ${APPLY_DELAY_MS / 1000}s 后执行（先放行本次响应）；连接会随地址变更中断。` +
      `请在 ${new Date(at.getTime()).toLocaleTimeString('zh-CN')} 之前（若改了地址，用 nodeagent connect <新地址> --port ${'<端口>'} 重连后）` +
      `调用 system.net.confirm 确认提交；逾期自动回滚到变更前配置（${JSON.stringify(snapshot.ipv4)}）。`,
    snapshot,
  };
}

/** 生成应用命令（PowerShell 片段）。 */
/**
 * 生成应用脚本（PowerShell，**原生 NetTCPIP cmdlet**）。
 *
 * ⚠️ 不用 `netsh interface ipv4 set address`：真机实测它在 Windows 11 上会挂起（>60s 无返回），
 * 而 `Set-NetIPAddress` / `Set-NetIPInterface` / `Set-DnsClientServerAddress` 同场景 <1s。
 * netsh 仅保留用于「读取」与人工恢复用的 dump 备份（对操作者友好）。
 */
export function buildApplyCommand(mode: string, iface: string, args: Args, snap: IfaceSnapshot): string {
  const a = JSON.stringify(iface);
  if (mode === 'command') {
    const cmd = args['command'] as string | undefined;
    if (!cmd) throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'mode=command 需要 command 参数');
    return cmd;
  }
  if (mode === 'dhcp') {
    return [
      `$ErrorActionPreference='Stop'`,
      `Set-NetIPInterface -InterfaceAlias ${a} -Dhcp Enabled -ErrorAction Stop`,
      `Set-DnsClientServerAddress -InterfaceAlias ${a} -ResetServerAddresses -ErrorAction SilentlyContinue`,
      `Write-Output 'dhcp applied'`,
    ].join('\n');
  }
  // static
  const ip = args['ip'] as string | undefined;
  const mask = args['mask'] as string | undefined;
  const gateway = args['gateway'] as string | undefined;
  if (!ip || !mask) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'mode=static 需要 ip 与 mask');
  }
  const prefix = maskToPrefix(mask);
  const dns = (args['dns'] as string[] | undefined) ?? [];
  const ipLit = JSON.stringify(ip);
  const lines = [
    `$ErrorActionPreference='Continue'`,
    // 关掉 DHCP（否则设静态地址会与 DHCP 租约打架）
    `Set-NetIPInterface -InterfaceAlias ${a} -Dhcp Disabled -ErrorAction SilentlyContinue`,
    // ⚠️ 顺序很关键：**先加新地址**（此时旧地址还在，链路不断）→ 再清旧地址与默认路由 → 最后补路由。
    //    曾经写成「先删后加」，结果 Windows 残留的默认路由让 New-NetIPAddress 报 already exists
    //    → 新地址没加上 → 机器回落到 APIPA 彻底失联（真机事故，务必保留本顺序注释）。
    `New-NetIPAddress -InterfaceAlias ${a} -IPAddress ${ipLit} -PrefixLength ${prefix} -ErrorAction SilentlyContinue | Out-Null`,
    // 清掉旧的默认路由（不先清，后面 New-NetRoute 会因「实例已存在」失败）
    `Get-NetRoute -InterfaceAlias ${a} -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue`,
    // 清掉非目标地址（保留 APIPA/回环）
    `Get-NetIPAddress -InterfaceAlias ${a} -AddressFamily IPv4 -ErrorAction SilentlyContinue |`,
    `  Where-Object { $_.IPAddress -ne ${ipLit} -and $_.PrefixOrigin -ne 'WellKnown' } |`,
    `  ForEach-Object { Remove-NetIPAddress -IPAddress $_.IPAddress -InterfaceAlias ${a} -Confirm:$false -ErrorAction SilentlyContinue }`,
  ];
  if (gateway) {
    lines.push(
      `New-NetRoute -InterfaceAlias ${a} -DestinationPrefix '0.0.0.0/0' -NextHop ${JSON.stringify(gateway)} -ErrorAction SilentlyContinue | Out-Null`,
    );
  }
  if (dns.length > 0) {
    lines.push(
      `Set-DnsClientServerAddress -InterfaceAlias ${a} -ServerAddresses ${dns.map((d) => JSON.stringify(d)).join(',')} -ErrorAction SilentlyContinue`,
    );
  }
  lines.push(`Write-Output 'static applied'`);
  return lines.join('\n');
}

/**
 * 变更后的自检 + 失败自愈片段。
 * ⚠️ 这段是**事故换来的**：没有自检时，变更失败会静默把机器留在「无地址」状态，
 * 而调用方还以为变更成功了（真机事故：机器掉到 APIPA 彻底失联）。
 */
export function buildSelfCheck(iface: string, expectIp: string | null, rollbackScriptPath: string): string {
  const a = JSON.stringify(iface);
  const rb = JSON.stringify(rollbackScriptPath);
  const cond = expectIp
    ? `$ok = @(Get-NetIPAddress -InterfaceAlias ${a} -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq ${JSON.stringify(expectIp)} }).Count -gt 0`
    : `$ok = @(Get-NetIPAddress -InterfaceAlias ${a} -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -ne 'WellKnown' }).Count -gt 0`;
  return [
    ``,
    `# ---- 自检：变更是否真的生效，失败立即回滚（自愈）----`,
    `Start-Sleep -Seconds 3`,
    cond,
    `if ($ok) {`,
    `  Write-Output 'selfcheck ok'`,
    `} else {`,
    `  Write-Output 'selfcheck FAILED -> auto rollback'`,
    `  & ${rb}`,
    `}`,
  ].join('\n');
}


/** POSIX：自定义命令 + 分离式回滚（sleep N 后执行回滚命令）。 */
async function posixCommandApply(
  applyCommand: string,
  confirmWithinMs: number,
  dir: string,
  ts: number,
): Promise<unknown> {
  const backupPath = join(dir, `backup-${ts}.txt`);
  const snap = await execCommand({ command: 'ip -o addr 2>/dev/null; echo ---; ip route 2>/dev/null', timeoutMs: 15_000 });
  writeFileSync(backupPath, snap.stdout, 'utf8');

  // POSIX 恢复：用快照重放地址与路由（尽力而为 —— 各发行版差异大，故提示谨慎使用）
  // 注意：不要用 sed 反向引用（\1 在 TS 模板串里是八进制转义，编译期报错）—— 统一用 awk
  const rollbackCmd = [
    `# 尽力恢复：从快照重放 IPv4 地址与默认路由`,
    `awk '/inet /{dev=""; for(i=1;i<=NF;i++) if($i=="dev") dev=$(i+1); if(dev && $2!="127.0.0.1/8") print $2, dev}' '${backupPath}' | while read -r addr dev; do`,
    `  ip addr add "$addr" dev "$dev" 2>/dev/null`,
    `done`,
    `awk '/^default/{via=""; dev=""; for(i=1;i<=NF;i++){ if($i=="via") via=$(i+1); if($i=="dev") dev=$(i+1) } if(via && dev) print via, dev}' '${backupPath}' | while read -r via dev; do`,
    `  ip route add default via "$via" dev "$dev" 2>/dev/null`,
    `done`,
  ].join('\n');
  const rollbackPath = join(dir, `rollback-${ts}.sh`);
  writeFileSync(
    rollbackPath,
    withBom([
      '#!/bin/sh',
      `# nodeagent 自动回滚（${new Date(ts).toISOString()}）`,
      `sleep ${Math.round(confirmWithinMs / 1000)}`,
      `# 若确认文件存在则跳过回滚`,
      `[ -f '${join(dir, `confirmed-${ts}`)}' ] && exit 0`,
      rollbackCmd,
    ].join('\n')),
    'utf8',
  );
  const launched = await execCommand({
    command: `chmod +x ${JSON.stringify(rollbackPath)} && setsid nohup sh ${JSON.stringify(rollbackPath)} > ${JSON.stringify(join(dir, `rollback-${ts}.log`))} 2>&1 & echo started`,
    timeoutMs: 15_000,
  });

  const applied = await execCommand({ command: applyCommand, timeoutMs: 60_000 });
  audit({
    type: 'net.change',
    capability: 'system.net.apply',
    status: applied.exit_code === 0 ? 'ok' : 'failed',
    reason: `mode=command confirm_within=${confirmWithinMs}ms backup=${backupPath}`,
  });
  return {
    applied: applied.exit_code === 0,
    mode: 'command',
    backup_path: backupPath,
    rollback_script: rollbackPath,
    rollback_scheduled: launched.stdout.includes('started'),
    task_name: `posix-${ts}`,
    rollback_at: Date.now() + confirmWithinMs,
    confirm_within_ms: confirmWithinMs,
    hint:
      `请在 ${Math.round(confirmWithinMs / 1000)} 秒内调用 system.net.confirm(task_name="posix-${ts}") 确认；` +
      `逾期由分离进程执行回滚（依赖备份脚本可恢复，网络类变更的 POSIX 恢复能力弱于 Windows，请谨慎）`,
    apply_output: (applied.stdout || applied.stderr).trim().slice(0, 300),
  };
}

// ---------------- system.net.confirm ----------------

export async function netConfirm(args: Args): Promise<unknown> {
  const taskName = args['task_name'] as string | undefined;
  const dir = NET_DIR();

  if (!IS_WINDOWS) {
    // POSIX：写确认标记文件，回滚脚本会自行跳过
    if (!taskName) return { confirmed: 0, note: 'POSIX 需指定 task_name' };
    const ts = taskName.replace('posix-', '');
    writeFileSync(join(dir, `confirmed-${ts}`), String(Date.now()), 'utf8');
    audit({ type: 'net.change', capability: 'system.net.confirm', status: 'ok', reason: `confirmed ${taskName}` });
    return { confirmed: 1, cancelled: [taskName] };
  }

  const listScript = `Get-ScheduledTask -TaskName '${TASK_PREFIX}*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TaskName`;
  let targets: string[] = [];
  if (taskName) {
    targets = [taskName];
  } else {
    const r = await execCommand({
      command: `powershell -NoProfile -EncodedCommand ${Buffer.from(listScript, 'utf16le').toString('base64')}`,
      timeoutMs: 30_000,
    });
    targets = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith(TASK_PREFIX));
  }
  if (targets.length === 0) {
    return { confirmed: 0, cancelled: [], note: '没有待确认的网络变更（可能已确认或已回滚）' };
  }

  const unreg = [
    ...targets.map((t) => `Unregister-ScheduledTask -TaskName '${t}' -Confirm:$false -ErrorAction SilentlyContinue`),
    // 顺带清理已执行过的 netapply 任务（一次性、已完成，留着只会让任务计划程序变乱）
    `Get-ScheduledTask -TaskName '${APPLY_TASK_PREFIX}*' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue`,
  ].join('\n');
  const r = await runPsFile(unreg, 60_000, 'unreg-all');
  const stillThere = await execCommand({
    command: `powershell -NoProfile -EncodedCommand ${Buffer.from(listScript, 'utf16le').toString('base64')}`,
    timeoutMs: 30_000,
  });
  const remaining = stillThere.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(TASK_PREFIX));

  audit({
    type: 'net.change',
    capability: 'system.net.confirm',
    status: remaining.length === 0 ? 'ok' : 'failed',
    reason: `confirmed=[${targets.join(',')}]`,
  });
  return {
    confirmed: targets.length - remaining.length,
    cancelled: targets.filter((t) => !remaining.includes(t)),
    remaining,
    detail: (r.stderr || '').slice(0, 200),
  };
}

// ---------------- system.net.status ----------------

export async function netStatus(_args: Args): Promise<unknown> {
  const dir = NET_DIR();
  let backups: Array<{ file: string; bytes: number; mtime: number }> = [];
  try {
    backups = readdirSync(dir)
      .filter((f) => f.startsWith('backup-'))
      .map((f) => {
        const p = join(dir, f);
        const st = readFileSync(p);
        return { file: p, bytes: st.length, mtime: 0 };
      });
  } catch {
    backups = [];
  }

  if (!IS_WINDOWS) {
    const r = await execCommand({ command: 'ip -o addr 2>/dev/null | head -20', timeoutMs: 15_000 });
    return { platform: process.platform, addresses: r.stdout.trim().split('\n'), backups, pending: [] };
  }

  const listScript = `Get-ScheduledTask -TaskName '${TASK_PREFIX}*' -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName + '|' + $_.State }`;
  const r = await execCommand({
    command: `powershell -NoProfile -EncodedCommand ${Buffer.from(listScript, 'utf16le').toString('base64')}`,
    timeoutMs: 30_000,
  });
  const rows = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(TASK_PREFIX));
  const now = Date.now();
  const pending: PendingRollback[] = rows.map((row) => {
    const [task_name, state] = row.split('|') as [string, string];
    const rollbackAt = Number(task_name.slice(TASK_PREFIX.length));
    return {
      task_name,
      created_at: rollbackAt,
      rollback_at: rollbackAt,
      seconds_left: Math.max(0, Math.round((rollbackAt - now) / 1000)),
      interface: '(见 task)',
      mode: '(见 task)',
      backup_path: '',
      requested_by: state,
    };
  });

  // ⚠️ 必须用 -EncodedCommand：用 -Command "..." 时内层的 $_ 会被**外层 PowerShell** 展开，
  //    命令静默失效并返回空（真机踩过）。
  const addrScript =
    `Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' } | ` +
    `Select-Object InterfaceAlias, @{n='ip';e={$_.IPv4Address.IPAddress}}, @{n='gw';e={$_.IPv4DefaultGateway.NextHop}} | ` +
    `ConvertTo-Json -Compress`;
  const addr = await execCommand({
    command: `powershell -NoProfile -EncodedCommand ${Buffer.from(addrScript, 'utf16le').toString('base64')}`,
    timeoutMs: 30_000,
  });
  // ⚠️ 只有一块网卡时 ConvertTo-Json 输出的是**对象**而不是数组 —— 只按 [...] 解析会
  //    在单网卡机器上永远返回空（真机踩过）。这里统一用首 { 到末 } 截取后按需包成数组。
  const s = addr.stdout.indexOf('{');
  const e = addr.stdout.lastIndexOf('}');
  let interfaces: unknown[] = [];
  if (s >= 0 && e > s) {
    try {
      const parsed = JSON.parse(addr.stdout.slice(s, e + 1)) as unknown;
      interfaces = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      interfaces = [];
    }
  }

  return {
    platform: process.platform,
    interfaces,
    pending,
    pending_count: pending.length,
    backups,
    note: pending.length > 0
      ? '存在待确认的网络变更：请在逾期前调用 system.net.confirm；逾期会自动回滚'
      : '没有待确认的网络变更',
  };
}

/** 清理旧的备份/回滚脚本（保留最近 N 份）。 */
export function pruneNetArtifacts(keep = 10): number {
  const dir = NET_DIR();
  let removed = 0;
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('backup-') || f.startsWith('rollback-'))
      .sort()
      .reverse();
    for (const f of files.slice(keep * 2)) {
      try {
        unlinkSync(join(dir, f));
        removed += 1;
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return removed;
}
