/**
 * 审计事件类型 —— **唯一真源**。
 *
 * ## 为什么单独成文件（v2.0.3，修 C-01）
 * 审计类型此前散在三处、各写一份，于是**静默漂移**：
 *   - `apps/agent/src/audit.ts` 的 `AuditType` 联合类型 —— 实际会写入日志的类型；
 *   - manifest `system.audit.list` 的 `enum: ['invoke','auth','acl','agent']` —— 只认 4 个；
 *   - 控制台下拉框的 11 个**细粒度**取值（`auth.success` / `acl.denied` / …）。
 * 三者交集只剩 `invoke`：**除 `invoke` 外任何筛选都被 schema 判为 `E_PARAM_INVALID`**，
 * 下拉框形同虚设。而漂移**不报错、类型也抓不到**（和「静默空列」同一类病）。
 *
 * 现在：真源在这里 → manifest 的 `enum` 由它派生 → 控制台取值受 `tests/unit/audit-filter.test.mjs`
 * 守卫。**新增审计类型只需改这一处**，忘了同步会被测试拦下。
 *
 * ## 过滤用 `startsWith`（故粗粒度前缀也是合法取值）
 * 被控端 `readAudit()` 的判据是 `entry.type.startsWith(query)`，所以 `auth` 能命中
 * `auth.success` + `auth.failure`，`agent` 能命中 `agent.start/stop/update/error`。
 * 这正是控制台用粗粒度分组的原因 —— 覆盖面更全，下拉框也不会膨胀成二十几项。
 */

/** 会被真正写入 `audit.log` 的全部类型。 */
export const AUDIT_TYPES = [
  'agent.start',
  'agent.stop',
  /** v2.0.3：进程级未捕获错误 / 未处理 Promise 拒绝（兜底拦截，不退出） */
  'agent.error',
  'auth.success',
  'auth.failure',
  'invoke',
  'acl.denied',
  'capability.disabled',
  'rate.limited',
  /** v16：网络配置变更（两阶段提交） */
  'net.change',
  /** v21：来源不在 allow_from 被拒 */
  'net.deny',
  /** v19：agent 自更新（拉取式） */
  'agent.update',
  /** v2.0.0：连接空闲被主动断开 */
  'session.idle_close',
  /** v2.0.3：被拒的请求统一留痕（畸形报文 / 未认证 / 参数非法 / 能力不存在） */
  'request.rejected',
] as const;

export type AuditType = (typeof AUDIT_TYPES)[number];

/**
 * 过滤用的**粗粒度前缀**。
 *
 * 每个前缀都必须能命中至少一个 `AUDIT_TYPES`（由单测钉死）—— 否则下拉框里会出现
 * 「选了永远是空」的选项，用户只会以为「这段时间没出事」。
 */
export const AUDIT_TYPE_PREFIXES = [
  'invoke',
  'auth',
  'acl',
  'capability',
  'rate',
  'net',
  'agent',
  'session',
  'request',
] as const;

/**
 * `system.audit.list` 的 `type` 参数**允许取的全部值**（精确类型 ∪ 粗粒度前缀）。
 * manifest 的 `enum` 直接用它，故「控制台能点的」与「协议认的」必然一致。
 */
export const AUDIT_FILTER_TYPES: readonly string[] = Array.from(
  new Set<string>([...AUDIT_TYPES, ...AUDIT_TYPE_PREFIXES]),
);
