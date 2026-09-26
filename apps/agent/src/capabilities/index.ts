import { CapabilityNames } from '@nodeagent/protocol';
import { systemInfo, systemStatus, processList, serviceList, shellExec } from './system.js';
import { appList, appInstall } from './app.js';

export type CapabilityHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** 能力名 → 实现。 */
export const capabilityRegistry: Record<string, CapabilityHandler> = {
  [CapabilityNames.SystemInfo]: systemInfo,
  [CapabilityNames.SystemStatus]: systemStatus,
  [CapabilityNames.ProcessList]: processList,
  [CapabilityNames.ServiceList]: serviceList,
  [CapabilityNames.ShellExec]: shellExec,
  [CapabilityNames.AppList]: appList,
  [CapabilityNames.AppInstall]: appInstall,
};
