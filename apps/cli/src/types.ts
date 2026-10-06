// CLI 共享类型与常量（从 index.ts 拆出）
/** 已解析的常用选项。 */
export interface Options {
  json: boolean;
  insecure: boolean;
  port?: string;
  key?: string;
  id?: string;
  limit?: string;
  args?: string;
  // v2 图形操作
  out?: string;
  format?: string;
  scale?: string;
  region?: string;
  button?: string;
  duration?: string;
  interval?: string;
  /** 媒体键定向投递的目标进程 PID（v1.2 keyPress） */
  /** v1.5 快捷键扩展：长按毫秒 */
  hold?: string;
  /** v1.5 快捷键扩展：投递路由 foreground|post */
  route?: string;
  pid?: string;
  /** v3：认证模式 psk | ed25519 */
  authMode?: string;
  /** v3+ 审计查询 */
  since?: string;
  type?: string;
  clientId?: string;
  /** v4 发现 */
  wait?: string;
  discoveryPort?: string;
  /** v5 多设备 */
  node?: string;
  name?: string;
  note?: string;
  /** v5 文件 */
  recursive?: boolean;
  pattern?: string;
  createDirs?: boolean;
  /** v6 Hub */
  hubToken?: string;
  hubNode?: string;
  /** v7 受控重启：延时毫秒 */
  delay?: string;
  /** v10 后台任务 / 剪贴板 */
  timeoutMs?: string;
  kill?: boolean;
  offset?: string;
  set?: string;
  /** v11 剪贴板图片 */
  imageFile?: string;
  /** v11 录屏 */
  fps?: string;
  /** v11 多设备并发 */
  nodes?: string;
  /** v11 部署目标路径 */
  path?: string;
  /** v12 事件订阅 */
  kind?: string;
  /** v12 宏变量 */
  vars?: string[];
  /** v22 发现广播认证密钥 */
  discoverSecret?: string;
  /** v22 每客户端 PSK */
  psk?: boolean;
  /** v21 证书指纹 */
  forgetCert?: boolean;
  /** v19 拉取式自更新 */
  url?: string;
  sha256?: string;
  dryRun?: boolean;
  /** v18 部署校验 */
  check?: boolean;
  force?: boolean;
  /** v17 音频 */
  mute?: string;
  volume?: string;
  /** v16 网络变更 */
  mode?: string;
  iface?: string;
  ip?: string;
  mask?: string;
  gateway?: string;
  dns?: string;
  command?: string;
  confirmWithin?: string;
  taskName?: string;
  yes?: boolean;
  seconds?: string;
  intervalMs?: string;
}

/** 文件分块传输的块大小（fs.read/write 用，v5） */
export const CHUNK_BYTES = 1024 * 1024;
