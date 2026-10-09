// 标准能力名（从 capabilities.ts 拆出）

/** nodeagent v1 标准能力名。 */
export const CapabilityNames = {
  SystemInfo: 'system.info',
  SystemStatus: 'system.status',
  ProcessList: 'system.process.list',
  ServiceList: 'system.service.list',
  ShellExec: 'system.shell.exec',
  AppList: 'app.list',
  AppInstall: 'app.install',
  // v2 图形接管
  ScreenInfo: 'screen.info',
  ScreenCapture: 'screen.capture',
  MouseMove: 'input.mouse.move',
  MouseClick: 'input.mouse.click',
  MouseScroll: 'input.mouse.scroll',
  MouseDrag: 'input.mouse.drag',
  KeyType: 'input.key.type',
  KeyPress: 'input.key.press',
  GuiAwait: 'gui.await',
  LogQuery: 'log.query',
  MonitorStart: 'monitor.start',
  MonitorReport: 'monitor.report',
  MonitorStop: 'monitor.stop',
  MonitorList: 'monitor.list',
  MonitorDelete: 'monitor.delete',
  // v3+ 审计
  AuditList: 'system.audit.list',
  // v5 文件传输
  FsList: 'fs.list',
  FsStat: 'fs.stat',
  FsRead: 'fs.read',
  FsWrite: 'fs.write',
  // v7 自持能力（受控重启）
  AgentRestart: 'system.agent.restart',
  // v8 GUI 语义（窗口与元素定位）
  WindowList: 'window.list',
  WindowFocus: 'window.focus',
  ScreenFind: 'screen.find',
  ScreenRecord: 'screen.record',
  // v10 异步任务与剪贴板
  TaskList: 'system.task.list',
  TaskGet: 'system.task.get',
  TaskKill: 'system.task.kill',
  ClipGet: 'clip.get',
  ClipSet: 'clip.set',
  // v11 安全加固
  AuditVerify: 'system.audit.verify',
  Metrics: 'system.metrics',
  // v19 拉取式自更新
  AgentUpdate: 'system.agent.update',
  // v17 音频控制
  AudioGet: 'system.audio.get',
  AudioSet: 'system.audio.set',
  // v16 网络变更两阶段提交
  NetApply: 'system.net.apply',
  NetConfirm: 'system.net.confirm',
  NetStatus: 'system.net.status',
  // v12 事件订阅与监控
  EventWatch: 'event.watch',
  EventUnwatch: 'event.unwatch',
  EventList: 'event.list',
  EventPoll: 'event.poll',
} as const;

export type CapabilityName = (typeof CapabilityNames)[keyof typeof CapabilityNames];
