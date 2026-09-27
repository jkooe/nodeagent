import { CapabilityNames } from '@nodeagent/protocol';
import type { AgentConfig } from '../config.js';
import { systemInfo, systemStatus, processList, serviceList, shellExec, auditList } from './system.js';
import { appList, appInstall } from './app.js';
import { screenInfo, screenCapture } from './screen.js';
import { mouseMove, mouseClick, mouseScroll, keyType, keyPress, setInputPolicy } from './input.js';
import { fsList, fsStat, fsRead, fsWrite, setFsRoots } from './fs.js';

export type CapabilityHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * 装配能力注册表。
 * 输入控制类能力由配置开关（allow_input）统一管控，默认关闭。
 */
export function createCapabilityRegistry(cfg: AgentConfig): Record<string, CapabilityHandler> {
  setInputPolicy({ allowInput: cfg.allow_input === true });
  setFsRoots(cfg.fs_roots);
  return {
    // v1 命令级
    [CapabilityNames.SystemInfo]: systemInfo,
    [CapabilityNames.SystemStatus]: systemStatus,
    [CapabilityNames.ProcessList]: processList,
    [CapabilityNames.ServiceList]: serviceList,
    [CapabilityNames.ShellExec]: shellExec,
    [CapabilityNames.AppList]: appList,
    [CapabilityNames.AppInstall]: appInstall,
    // v2 屏幕感知
    [CapabilityNames.ScreenInfo]: screenInfo,
    [CapabilityNames.ScreenCapture]: screenCapture,
    // v2 输入控制（默认禁用）
    [CapabilityNames.MouseMove]: mouseMove,
    [CapabilityNames.MouseClick]: mouseClick,
    [CapabilityNames.MouseScroll]: mouseScroll,
    [CapabilityNames.KeyType]: keyType,
    [CapabilityNames.KeyPress]: keyPress,
    // v3+ 审计
    [CapabilityNames.AuditList]: auditList,
    // v5 文件传输
    [CapabilityNames.FsList]: fsList,
    [CapabilityNames.FsStat]: fsStat,
    [CapabilityNames.FsRead]: fsRead,
    [CapabilityNames.FsWrite]: fsWrite,
  };
}
