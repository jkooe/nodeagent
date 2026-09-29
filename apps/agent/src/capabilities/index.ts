import { CapabilityNames } from '@nodeagent/protocol';
import type { AgentConfig } from '../config.js';
import { systemInfo, systemStatus, processList, serviceList, shellExec, auditList, auditVerify, metricsReport, agentRestart } from './system.js';
import { appList, appInstall } from './app.js';
import { screenInfo, screenCapture } from './screen.js';
import { windowList, windowFocus, screenFind } from './window.js';
import { screenRecord } from './record.js';
import { taskList, taskGet, taskKill } from './task.js';
import { clipGet, clipSet } from './clipboard.js';
import { eventWatch, eventUnwatch, eventList, eventPoll } from '../events.js';
import { mouseMove, mouseClick, mouseScroll, mouseDrag, keyType, keyPress, setInputPolicy } from './input.js';
import { fsList, fsStat, fsRead, fsWrite, setFsRoots } from './fs.js';

export interface HandlerContext {
  /** 连接标识（事件订阅归属 / 断开清理） */
  owner: string;
  /** 向该连接推送事件 */
  emit: (evt: unknown) => void;
}

export type CapabilityHandler = (
  args: Record<string, unknown>,
  ctx?: HandlerContext,
) => Promise<unknown>;

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
    [CapabilityNames.MouseDrag]: mouseDrag,
    [CapabilityNames.KeyType]: keyType,
    [CapabilityNames.KeyPress]: keyPress,
    // v3+ 审计
    [CapabilityNames.AuditList]: auditList,
    // v11 审计防篡改
    [CapabilityNames.AuditVerify]: auditVerify,
    // v13 成功指标
    [CapabilityNames.Metrics]: metricsReport,
    // v5 文件传输
    [CapabilityNames.FsList]: fsList,
    [CapabilityNames.FsStat]: fsStat,
    [CapabilityNames.FsRead]: fsRead,
    [CapabilityNames.FsWrite]: fsWrite,
    // v7 自持能力
    [CapabilityNames.AgentRestart]: agentRestart,
    // v8 GUI 语义（窗口与元素定位）
    [CapabilityNames.WindowList]: windowList,
    [CapabilityNames.WindowFocus]: windowFocus,
    [CapabilityNames.ScreenFind]: screenFind,
    [CapabilityNames.ScreenRecord]: screenRecord,
    // v10 异步任务与剪贴板
    [CapabilityNames.TaskList]: taskList,
    [CapabilityNames.TaskGet]: taskGet,
    [CapabilityNames.TaskKill]: taskKill,
    [CapabilityNames.ClipGet]: clipGet,
    [CapabilityNames.ClipSet]: clipSet,
    // v12 事件订阅
    [CapabilityNames.EventWatch]: (args, ctx) =>
      eventWatch(args, ctx ?? { owner: 'unknown', emit: () => undefined }),
    [CapabilityNames.EventUnwatch]: eventUnwatch,
    [CapabilityNames.EventList]: eventList,
    [CapabilityNames.EventPoll]: eventPoll,
  };
}
