import { CapabilityError, ErrorCodes } from '@nodeagent/protocol';
import { IS_WINDOWS, execCommand } from '../util/exec.js';

type Args = Record<string, unknown>;

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function requireWindows(capability: string): void {
  if (!IS_WINDOWS) {
    throw new CapabilityError(ErrorCodes.UNSUPPORTED_PLATFORM, `${capability} 仅在被控端为 Windows 时可用`, {
      platform: process.platform,
    });
  }
}

// ---------------- app.list ----------------

interface AppEntry {
  name: string;
  version: string;
  publisher: string;
  source: string;
}

/** 商店 / UWP 应用（补充注册表卸载项之外的应用；失败不阻塞主清单）。 */
async function listUwpApps(): Promise<AppEntry[]> {
  const script =
    "Get-AppxPackage | Where-Object {$_.SignatureKind -ne 'System' -and $_.IsFramework -eq $false} | " +
    'Select-Object Name,Version,Publisher | ConvertTo-Json -Compress';
  const r = await execCommand({ command: script, timeoutMs: 60_000 }).catch(() => null);
  if (!r || r.exit_code !== 0 || !r.stdout) return [];
  try {
    return toArray<{ Name?: string; Version?: string; Publisher?: string }>(JSON.parse(r.stdout)).map((a) => ({
      name: a.Name ?? '',
      version: a.Version ?? '',
      publisher: a.Publisher ?? '',
      source: 'store',
    }));
  } catch {
    return [];
  }
}

export async function appList(args: Args): Promise<unknown> {
  requireWindows('app.list');
  const pattern = (args['filter'] as { name_pattern?: string } | undefined)?.name_pattern;

  const script =
    '$paths=@(' +
    "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');" +
    '$items=foreach($p in $paths){Get-ItemProperty $p -ErrorAction SilentlyContinue | ' +
    'Where-Object {$_.DisplayName} | Select-Object DisplayName,DisplayVersion,Publisher};' +
    '$items | Sort-Object DisplayName -Unique | ConvertTo-Json -Compress';

  const r = await execCommand({ command: script, timeoutMs: 60_000 });
  const apps: AppEntry[] = toArray<{ DisplayName?: string; DisplayVersion?: string; Publisher?: string }>(
    r.stdout ? JSON.parse(r.stdout) : [],
  ).map((a) => ({
    name: a.DisplayName ?? '',
    version: a.DisplayVersion ?? '',
    publisher: a.Publisher ?? '',
    source: 'registry',
  }));

  // 合并商店 / UWP 应用：以注册表为准，补充其中没有的
  const uwp = await listUwpApps();
  const seen = new Set(apps.map((a) => a.name.toLowerCase()));
  for (const item of uwp) {
    if (item.name && !seen.has(item.name.toLowerCase())) {
      seen.add(item.name.toLowerCase());
      apps.push(item);
    }
  }

  let result = apps;
  if (pattern) {
    const re = new RegExp(pattern, 'i');
    result = result.filter((a) => re.test(a.name));
  }
  return { apps: result, total: result.length, sources: ['registry', 'store'] };
}

// ---------------- app.install ----------------

export async function appInstall(args: Args): Promise<unknown> {
  requireWindows('app.install');
  const pkg = args['package'] as string;
  const id = args['id'] as string | undefined;
  const silent = (args['silent'] as boolean | undefined) ?? true;
  const timeoutMs = (args['timeout_ms'] as number | undefined) ?? 600_000;

  if (typeof pkg !== 'string' || pkg.length === 0) {
    throw new CapabilityError(ErrorCodes.PARAM_INVALID, 'package 不能为空');
  }

  // 先确认 winget 可用
  const probe = await execCommand({ command: 'winget --version', timeoutMs: 15_000 }).catch(() => null);
  if (!probe || probe.exit_code !== 0) {
    throw new CapabilityError(
      ErrorCodes.EXECUTION_FAILED,
      'winget 不可用：请在被控端安装「应用安装程序」(App Installer)',
      { detail: probe?.stderr ?? 'winget not found' },
    );
  }

  const target = id ? `--id ${quote(id)} --exact` : `${quote(pkg)}`;
  const flags = [
    silent ? '--silent' : '',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
  ]
    .filter(Boolean)
    .join(' ');

  const cmd = `winget install ${target} ${flags}`;
  const r = await execCommand({ command: cmd, timeoutMs });

  // winget 退出码：0 成功；-1978335189 (0x8A15002B) 已安装最新版
  const alreadyInstalled = /already installed|已安装/i.test(r.stdout + r.stderr);
  const installed = r.exit_code === 0 || alreadyInstalled;

  return {
    installed,
    name: pkg,
    version: extractVersion(r.stdout) ?? '',
    source: 'winget',
    detail: (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).slice(-2000),
  };
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

function extractVersion(output: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)*(?:-\w+)?)/.exec(output);
  return m ? m[1]! : null;
}
