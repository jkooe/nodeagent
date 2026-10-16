# L2 系统级审计兜底（设计 + Windows 落地）

> 本文是 `docs/DELIVERY-PIPELINE.md` 与 `docs/SECURITY.md` §4.8 的配套件。
> 编写日期：2026-10-17。基线提交：`2bf45fd`。

---

## 1. L1 与 L2 的分工（先界定问题）

| | L1（已实现） | L2（本文） |
|---|---|---|
| 记录者 | **nodeagent 自己**（`apps/agent/src/audit.ts`） | **操作系统** |
| 落盘位置 | `%NODEAGENT_HOME%/audit.log` | OS 审计子系统（Windows 事件日志 / Linux auditd / macOS ESF） |
| 防篡改 | 哈希链 + 外部锚定 | 由 OS 内核写入，agent 无权改写 |
| 覆盖内容 | 「谁调用了什么能力」 | 「这台机器上发生了什么」（进程创建、登录、文件访问…） |

### 为什么还需要 L2

L1 的哈希链能发现**链内**篡改，外部锚定能发现**整链重写**。但两者都有一个前提：
**agent 还在记录**。

一旦攻击者拿到被控端的 root：

1. 可以直接**停掉 agent**（或让它不再写审计），此后发生的一切 L1 都看不到；
2. 即使不停，L1 记的是「agent 知道的事」——攻击者绕过 agent、直接用系统命令做的事，
   L1 **结构上就记不到**（它只看得见经过自己 RPC 的调用）。

L2 补的就是这块：**agent 不在场时，机器自己留下了记录**。

---

## 2. 必须先说清的信任边界（不要夸大 L2 的作用）

**L2 采集器本身不提供独立性。**

采集器是 agent 的一部分，与被审计对象同权限、同进程。攻击者既然能停 agent，
就能停采集器。**真正的独立性来自「记录不留在本地」**：

```
OS 审计子系统 ──(只读)──> 采集器 ──> ① 本地 audit-l2.log（副本，仅便利）
                                  └─> ② 转发出机（控制端 / 云盘）  ← 独立性在这里
```

- ① 只是**归一化副本**，方便查询，防篡改价值有限（我们写的，我们能改）。
- ② 才是 L2 的意义所在 —— 与 §4.8 的锚定思路一致：**留在攻击者碰不到的地方**。

> 因此本文的落地范围是「①采集与归一化 + ②导出接口」，
> **自动转发**属于部署侧配置（与锚点外发共用同一条通道），不在本文实现。

---

## 3. 三端设计

### 3.1 Windows —— **本次落地**

Windows 有两条可选路径：

| 方案 | 依赖 | 覆盖 | 取舍 |
|---|---|---|---|
| **A. 内置高级审计策略**（`auditpol.exe`） | **零依赖** | 进程创建 4688、登录 4624/4625、进程退出 4689、对象访问 4663 | ✅ **选它**：无需安装任何东西 |
| B. Sysmon（Sysinternals） | 需下载安装 Sysmon 本体 + 配置 XML | 更丰富（镜像加载、命名管道、WMI、DNS） | 可选增强：检测到已装则并用 |

**为什么先选 A**：Sysmon 是第三方驱动，需单独分发、需重启生效、且不同版本行为有差异；
内置策略是 Windows 自带的、开箱即用的那层。能用零依赖方案先立起来，Sysmon 作为可选增强。

**启用方式**（需管理员）：

```cmd
:: 让「高级审计策略」覆盖旧的「类别级策略」—— 否则 subcategory 设置不生效
auditpol /set /subcategory:"进程创建" /success:enable /failure:enable
auditpol /set /subcategory:"登录"      /success:enable /failure:enable
auditpol /set /subcategory:"进程终止"  /success:enable
reg add HKLM\SYSTEM\CurrentControlSet\Control\Lsa /v SCENoApplyLegacyAuditPolicy /t REG_DWORD /d 1 /f
```

> ⚠️ `SCENoApplyLegacyAuditPolicy` 是关键：不设这个，组策略里的旧式类别策略会盖掉
> subcategory 设置，表现为「auditpol 显示已启用但事件日志里没有 4688」。

**采集**：`Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4688,4624,4625; StartTime=…}`
（PowerShell 层，避免额外依赖）。

### 3.2 Linux —— 设计，本次不落地

- 机制：`auditd` + `auditctl` 规则。
- 规则示例：`-a always,exit -F arch=b64 -S execve`（进程执行）、`-w /etc/passwd -p wa`（关键文件）。
- 读取：`ausearch` 或 `/var/log/audit/audit.log`。
- **为什么本次不落地**：需要 `auditd` 已安装且运行；容器/精简发行版常常没有。
  属部署侧前置条件，与 Windows 的「零依赖」不同。

### 3.3 macOS —— 设计，**存在硬性限制**

- 机制：Endpoint Security Framework（ESF）+ OpenBSM。
- ⚠️ **ESF 属 Apple 受限权限**：需向 Apple 申请 `com.apple.developer.endpoint-security.client`
  entitlement，且客户端必须是**签名的 System Extension**。个人/自签分发**无法启用**。
- OpenBSM（`auditd`）在 macOS 上仍可用但自 macOS 11 起被弱化，事件覆盖有限。
- **结论**：macOS 侧本文**只出设计不落地**，如实标注可行性限制，不写「假装能用」的代码。

---

## 4. 归一化 schema

L2 记录与 L1 分开落盘（`audit-l2.log`），schema 独立 —— 因为来源与可信度不同，
混进 L1 会让「agent 记的」与「OS 记的」无法区分。

```jsonc
{
  "ts": 1760000000000,          // 事件发生时间（来自 OS，不是采集时刻）
  "src": "windows-security",    // 来源：windows-security | sysmon | linux-auditd | macos-esf
  "event_id": 4688,             // OS 原始事件 ID（保留原始，便于人工核对）
  "kind": "process.create",     // 归一化后的类别
  "subject": "DOMAIN\\User",    // 主体
  "object": "C:\\Windows\\...", // 客体（进程映像 / 文件路径 / 目标）
  "detail": { "...": "..." },   // 平台特有字段（命令行、PID、父进程…）
  "collected_at": 1760000001234, // 采集时刻 —— ts 与它相差过大说明曾离线
  "prev": "...", "hash": "..."   // 与 L1 同构的哈希链
}
```

`kind` 取值（归一化枚举）：

| kind | Windows | Linux | macOS |
|---|---|---|---|
| `process.create` | 4688 | `execve` | ESF `exec` |
| `process.exit` | 4689 | — | ESF `exit` |
| `auth.success` | 4624 | — | ESF `authentication` |
| `auth.failure` | 4625 | — | — |
| `file.access` | 4663 | `-w ... -p wa` | ESF `open` |

---

## 5. 落地范围（本次）

| 项 | 状态 |
|---|---|
| 设计文档（三端 + 信任边界 + 可行性限制） | ✅ 本文 |
| Windows **状态检查**（策略是否已启用） | ✅ `system.audit.l2 action=status` |
| Windows **启用**（auditpol + 关 legacy 覆盖） | ✅ `action=enable`（需管理员） |
| Windows **采集**（Security 日志 → 归一化 → 落盘） | ✅ `action=collect` |
| L2 链校验 | ✅ `action=verify` |
| Linux auditd | ⚠️ 仅设计，未落地 |
| macOS ESF | ⚠️ 仅设计，**受 Apple entitlement 限制，不可自签启用** |
| 自动转发出机 | ❌ 不在本文范围（与锚点外发共用通道） |

---

## 6. 已知限制（如实记录，不掩饰）

1. **采集器不提供独立性** —— 同进程同权限，攻击者能停 agent 就能停采集器。
   真正独立性依赖转发出机（§2）。
2. **Windows 启用需管理员** —— 已提权时可用；未提权返回明确错误，不静默失败。
3. **4688 默认不含完整命令行** —— 需额外开
   `HKLM\Software\Microsoft\Windows\CurrentVersion\Policies\System\Audit\ProcessCreationIncludeCmdLine_Enabled`
   才能记命令行，否则只能看到进程名。采集器会检测并提示。
4. **量大** —— Security 日志可能极多；采集必须带 `since` 与 `limit`，默认窗口 24 小时、上限 1000 条。
5. **Sysmon 未自动安装** —— 检测到则并用，未检测到不尝试下载（不在本仓库职责内）。
