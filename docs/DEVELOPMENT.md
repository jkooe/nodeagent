# nodeagent 开发文档

> **跨机 AI 接管框架** —— 让 MacBook 上的 AI 无缝接管 Windows，装软件、查状态，如同操作同一台电脑

| 项 | 值 |
|---|---|
| 工程名 | `nodeagent` |
| 包名前缀 | `@nodeagent/*` |
| 文档版本 | v1.0 |
| 日期 | 2026-09-27 |
| 状态 | 开发阶段 |
| 目标端 | macOS（控制端）/ Windows（被控端） |
| 配套文档 | [产品需求文档（PRD）](../PRD.md) |

---

## 目录

- [第 1 章 项目概述](#第-1-章-项目概述)
- [第 2 章 核心概念与术语](#第-2-章-核心概念与术语)
- [第 3 章 系统架构](#第-3-章-系统架构)
- [第 4 章 协议规范](#第-4-章-协议规范)
- [第 5 章 能力清单](#第-5-章-能力清单)
- [第 6 章 安全模型](#第-6-章-安全模型)
- [第 7 章 各端实现指南](#第-7-章-各端实现指南)
- [第 8 章 工程结构](#第-8-章-工程结构)
- [第 9 章 路线图与里程碑](#第-9-章-路线图与里程碑)
- [第 10 章 测试与验收](#第-10-章-测试与验收)
- [附录 A 错误码表](#附录-a-错误码表)
- [附录 B 与参考文档的差异](#附录-b-与参考文档的差异)

---

## 第 1 章 项目概述

### 1.1 一句话定义

**nodeagent 让 Mac 上的 AI（WorkBuddy）通过统一协议接管局域网内的 Windows 机器——执行命令、装软件、查状态。**

### 1.2 要解决的问题

| 痛点 | 具体表现 |
|---|---|
| **跨机断点** | AI Agent 跑在 Mac 上，无法触达 Windows 执行操作 |
| **手动替代** | 装软件、查状态需人工切换到 Windows 操作，打断工作流 |
| **无统一入口** | 每次都要用远程桌面/SSH 手动拼命令，无法被 AI 自动编排 |

### 1.3 目标与非目标

**目标（In Scope）**

- 点对点直连：Mac 直接连接 Windows，无中枢
- 命令级接管：执行 PowerShell 命令、装软件、查状态，返回结构化结果
- 基本鉴权：预共享密钥 + TLS 传输加密
- AI 一等公民接口：CLI（底座）+ MCP（落点）
- Windows 端常驻服务：开机自启、断线重连

**非目标（Out of Scope，v1 不做）**

- 图形接管（截屏 + 键鼠模拟）→ v2
- 零信任 ACL / 能力级授权 / 审计 → v2/v3
- Hub 中枢（多设备注册/发现/路由）→ 预留接口
- Android / Linux 端 → 后续
- 公网穿透 → 后续（v1 仅局域网）
- 画面串流（远程桌面级）→ 属 OnlyInOne 领域

### 1.4 分阶段路线

| 阶段 | 目标 |
|---|---|
| **v1（本阶段）** | 命令级接管 + 装软件 + 查状态 + 基本鉴权 + CLI + MCP |
| **v2** | 图形接管（截屏 + 键鼠模拟）+ 能力级 ACL |
| **v3** | 无感体验 + 零信任 + 多端扩展 |

---

## 第 2 章 核心概念与术语

| 术语 | 定义 |
|---|---|
| **控制端** | 皇上的 MacBook，发起调用的 AI/CLI 所在端 |
| **被控端** | Windows 机器，执行命令/装软件/查状态的端 |
| **Agent** | 常驻在 Windows 上的后台服务，接收并执行控制端指令 |
| **能力** | 一个可被远程调用的原子操作（执行命令、装软件、查状态） |
| **能力清单** | Agent 启动时声明的「我会什么」的列表，含参数 schema |
| **预共享密钥** | 控制端与被控端预先约定的密钥，v1 鉴权依据 |
| **Invoke** | 一次「控制端 → 被控端」的能力调用 |

---

## 第 3 章 系统架构

### 3.1 拓扑：点对点直连

```
┌─────────────────┐        wss://（TLS 1.3）        ┌─────────────────┐
│   控制端 (Mac)   │ ◄──────────────────────────────► │  被控端 (Windows) │
│  CLI / MCP     │        局域网点对点直连            │     Agent        │
│  @nodeagent/client │                                │  (常驻后台服务)   │
└─────────────────┘                                   └─────────────────┘
```

**关键设计**：无中枢。控制端主动连接被控端（已知 IP:端口）。预留 Hub 接口——协议层不绑定拓扑，未来加设备时可增量引入注册/发现层。

### 3.2 分层架构

```
┌──────────────────────────────────────────────┐
│  L3  接入层    CLI · MCP Server               │
├──────────────────────────────────────────────┤
│  L2  能力层    system.* · app.* · 参数校验     │
├──────────────────────────────────────────────┤
│  L1  协议层    JSON-RPC 2.0 · 握手 · 错误码    │
├──────────────────────────────────────────────┤
│  L0  传输层    WebSocket · TLS 1.3             │
├──────────────────────────────────────────────┤
│  运行时        Node.js 22（两端一致）           │
└──────────────────────────────────────────────┘
```

### 3.3 核心时序

```
控制端 (Mac)                         被控端 Agent (Windows)
  │                                        │
  │ ① hello {protocol, client_id} ────────►│
  │                                        │  生成 nonce（CSPRNG 32字节）
  │ ② challenge {nonce, expires_at} ◄──────│  缓存 nonce（TTL 30s）
  │                                        │
  │ ③ auth {nonce, hmac} ─────────────────►│  用预共享密钥校验 HMAC
  │                                        │  通过 → 返回能力清单
  │ ④ auth_ok {capabilities} ◄─────────────│
  │                                        │
  │ ⑤ invoke {capability, args} ──────────►│  校验 → 执行
  │ ⑥ result ◄─────────────────────────────│
```

---

## 第 4 章 协议规范

### 4.1 协议栈

| 层 | 选型 | 理由 |
|---|---|---|
| 消息格式 | **JSON-RPC 2.0** | 语义成熟、库齐全、调试友好 |
| 传输 | **WebSocket（RFC 6455）** | 全双工、双向推送、可复用连接 |
| 加密 | **TLS 1.3** | 防中间人、防嗅探 |
| 序列化 | JSON | 人类可读、跨实现一致 |

### 4.2 消息信封

```jsonc
{
  "jsonrpc": "2.0",
  "id": "01J8X4K2M9P0Q1R2S3T4V5W6X7",   // ULID，请求唯一标识，响应回填相同 id
  "method": "invoke",                     // 方法名
  "params": {}                            // 方法参数
}
```

> **v1 简化说明**：参考文档的完整信封含 `type`/`sig`/`ts`/`meta` 字段，用于「Hub 转发 + 端到端签名 + 链路追踪」。nodeagent v1 是**单跳直连 + TLS + 预共享密钥**，故省略 `sig`（消息级签名）与 `trace_id`，仅在握手时做 HMAC 挑战-应答。**字段预留**：协议版本号通过 `hello.params.protocol` 协商，v2 引入 Ed25519 时在信封中恢复 `sig`/`ts` 字段，无需破坏现有实现。

### 4.3 方法清单（控制面）

| 方法 | 方向 | 说明 |
|---|---|---|
| `hello` | 控制端 → 被控端 | 发起握手，声明协议版本与 client_id |
| `challenge` | 被控端 → 控制端 | 返回 nonce 挑战 |
| `auth` | 控制端 → 被控端 | 提交 HMAC，完成认证 |
| `auth_ok` | 被控端 → 控制端 | 认证成功，返回能力清单 |
| `invoke` | 控制端 → 被控端 | 调用某项能力 |
| `capabilities` | 控制端 → 被控端 | 查询当前能力清单（可选，auth_ok 已返回） |

### 4.4 握手与认证（预共享密钥 + HMAC 挑战-应答）

**① hello**

```jsonc
{ "jsonrpc": "2.0", "id": "01J8X...", "method": "hello",
  "params": { "protocol": "1.0", "client_id": "mac_01" } }
```

**② challenge**

```jsonc
{ "jsonrpc": "2.0", "id": "01J8X...", "method": "challenge",
  "params": { "nonce": "a3f8b2c1...", "expires_at": 1758902430000 } }
```

**③ auth**

```jsonc
{ "jsonrpc": "2.0", "id": "01J8X...", "method": "auth",
  "params": {
    "client_id": "mac_01",
    "nonce": "a3f8b2c1...",
    "hmac": "Base64( HMAC-SHA256( pre_shared_key, nonce ) )"
  } }
```

**④ auth_ok**

```jsonc
{ "jsonrpc": "2.0", "id": "01J8X...", "method": "auth_ok",
  "params": { "capabilities": [ /* 见第 5 章 */ ] } }
```

**鉴权失败** → 返回 `type: error`，`code: -32401`（`E_AUTH_FAILED`），并断开连接。

> **nonce 管理**：被控端缓存 nonce，TTL 30s，验证后立即删除（一次性）。同一连接同时只允许一个未消费 nonce。这是防重放的最小实现。

### 4.5 调用流程（invoke）

**请求**

```jsonc
{ "jsonrpc": "2.0", "id": "01J8X4K2M9P0Q1R2S3T4V5W6X7", "method": "invoke",
  "params": {
    "capability": "system.shell.exec",
    "args": { "command": "Get-Service -Name Spooler | Select-Object Status", "timeout_ms": 10000 }
  } }
```

**成功响应**

```jsonc
{ "jsonrpc": "2.0", "id": "01J8X4K2M9P0Q1R2S3T4V5W6X7",
  "result": {
    "status": "ok",
    "data": {
      "exit_code": 0,
      "stdout": "Status\n------\nRunning",
      "stderr": "",
      "duration_ms": 312
    }
  } }
```

**`status` 取值**

| 值 | 含义 |
|---|---|
| `ok` | 成功完成 |
| `failed` | 执行失败（业务级失败，如命令非零退出码），详情在 `data` |
| `error` | 协议/鉴权/参数级错误，走 `type: error` |

> **区分**：`type: "error"` = 协议层/权限层失败（如鉴权失败、能力不存在）；`result.status: "failed"` = 能力执行层失败（如命令返回非零退出码）。两者不可混用。

**错误响应**

```jsonc
{ "jsonrpc": "2.0", "id": "01J8X4K2M9P0Q1R2S3T4V5W6X7",
  "error": {
    "code": -32403,
    "name": "E_CAPABILITY_NOT_FOUND",
    "message": "Capability system.foo.bar is not supported",
    "data": { "capability": "system.foo.bar" }
  } }
```

### 4.6 超时与取消

- 控制端在 `args.timeout_ms`（默认 30000ms）内未收到响应 → 判超时，返回 `E_TIMEOUT`，断开或忽略该请求。
- 被控端执行超时后**必须强制终止进程组**（见 7.2），防止残留。

### 4.7 版本协商

协议版本 `MAJOR.MINOR`：
- MAJOR 不同 → 拒绝，`E_PROTOCOL_MISMATCH`
- MINOR 不同 → 降级到 min(双方)，记 warning

---

## 第 5 章 能力清单

### 5.1 风险分级

| 等级 | 默认策略 | 说明 |
|---|---|---|
| 🟢 `low` | 允许 | 只读、无副作用 |
| 🟡 `medium` | 允许 | 可能读敏感数据（如截屏） |
| 🔴 `high` | 分类处理 | 可改变系统状态；**`input.*` 另受 `allow_input` 开关管控，默认禁用** |

> **v2 安全开关**：`input.*`（鼠标 / 键盘控制）是高危能力，由被控端配置项 **`allow_input`** 统一管控，**默认 `false`**。未开启时调用返回 `E_CAPABILITY_DISABLED`（附开启指引）。这是「先简化后强化」路线下、完整 ACL（v3）之前的过渡措施。

### 5.2 能力总览

| # | 能力名 | 风险 | 说明 | 阶段 |
|---|---|---|---|---|
| 1 | `system.info` | 🟢 | 系统基本信息 | v1 |
| 2 | `system.status` | 🟢 | 资源状态（CPU/内存/磁盘/网络） | v1 |
| 3 | `system.process.list` | 🟢 | 进程列表 | v1 |
| 4 | `system.service.list` | 🟢 | 服务列表 | v1 |
| 5 | `system.shell.exec` | 🔴 | 执行 PowerShell 命令 | v1 |
| 6 | `app.list` | 🟢 | 已安装软件列表 | v1 |
| 7 | `app.install` | 🔴 | 装软件（winget 优先） | v1 |
| 8 | `screen.info` | 🟢 | 显示器信息（分辨率/缩放/主屏） | v2 |
| 9 | `screen.capture` | 🟡 | 截屏，返回 base64（支持 region/scale/format） | v2 |
| 10 | `input.mouse.move` | 🔴🔒 | 移动鼠标（支持平滑移动） | v2 |
| 11 | `input.mouse.click` | 🔴🔒 | 鼠标点击（左/中/右键，可先移动） | v2 |
| 12 | `input.mouse.scroll` | 🔴🔒 | 滚轮滚动 | v2 |
| 13 | `input.key.type` | 🔴🔒 | 输入文本（Unicode 逐字符） | v2 |
| 14 | `input.key.press` | 🔴🔒 | 按下按键/组合键 | v2 |

> 🔒 = 受 `allow_input` 开关管控，默认禁用。
>
> **实现方式**：v2 图形能力全部基于 Windows 原生 API（`System.Drawing` 截屏 + `user32.dll` 的 `SendInput` 输入注入），**无需原生编译、无第三方依赖**；文本输入经 Base64 传参后再在 PowerShell 侧解码，杜绝内容注入。

### 5.3 能力明细

#### `system.info` 🟢
- **参数**：`fields` (string[]，可选) — 指定返回字段
- **返回**：`hostname` / `os` / `os_version` / `arch` / `cpu_model` / `cpu_cores` / `memory_total` / `uptime_sec` / `is_admin`

#### `system.status` 🟢
- **参数**：无
- **返回**：`cpu_pct` / `memory_used` / `memory_total` / `memory_pct` / `disks: [{ drive, total, free, used_pct }]` / `net: [{ adapter, ip, up }]`

#### `system.process.list` 🟢
- **参数**：`sort_by` (enum: cpu|memory|pid|name，默认 cpu) / `limit` (默认 50) / `filter` ({ name_pattern })
- **返回**：`processes: [{ pid, name, cpu_pct, memory_bytes, started_at }]`

#### `system.service.list` 🟢
- **参数**：`filter` ({ name_pattern, state })
- **返回**：`services: [{ name, display_name, state, start_type }]`

#### `system.shell.exec` 🔴
- **参数**：
  - `command` (string，必填) — PowerShell 命令
  - `shell` (enum: powershell|cmd，默认 powershell)
  - `cwd` (string，可选)
  - `timeout_ms` (integer，默认 30000，最大 300000)
- **返回**：`exit_code` / `stdout` / `stderr` / `duration_ms` / `truncated` / `killed`
- **安全**：输出超 10MB 截断；超时杀整个进程组（见 7.2）

#### `app.list` 🟢
- **参数**：`filter` ({ name_pattern })
- **返回**：`apps: [{ name, version, publisher, source }]`
- **实现**：读取注册表卸载项 + `winget list`

#### `app.install` 🔴
- **参数**：
  - `package` (string，必填) — winget 包 ID 或软件名
  - `id` (string，可选) — 精确 winget ID（优先）
  - `silent` (boolean，默认 true) — 静默安装
  - `timeout_ms` (integer，默认 600000)
- **返回**：`installed` / `name` / `version` / `source` / `detail`
- **规则**：优先 winget（`--silent --accept-package-agreements --accept-source-agreements`）；winget 不可用或找不到时，返回明确的失败原因（含可选静默参数提示），**不做 GUI 交互**（v1）。

### 5.4 能力声明文件示例

```jsonc
{
  "protocol": "1.0",
  "agent_version": "0.1.0",
  "capabilities": [
    {
      "name": "system.shell.exec",
      "version": "1.0",
      "description": "执行 PowerShell 命令并返回输出",
      "risk": "high",
      "params_schema": {
        "type": "object",
        "properties": {
          "command": { "type": "string" },
          "shell": { "enum": ["powershell", "cmd"], "default": "powershell" },
          "cwd": { "type": "string" },
          "timeout_ms": { "type": "integer", "default": 30000 }
        },
        "required": ["command"],
        "additionalProperties": false
      },
      "returns_schema": {
        "type": "object",
        "properties": {
          "exit_code": { "type": "integer" },
          "stdout": { "type": "string" },
          "stderr": { "type": "string" },
          "duration_ms": { "type": "integer" }
        }
      }
    }
  ]
}
```

### 5.5 能力执行流程（被控端内部）

```
接收 invoke
   │
   ▼
① 校验连接已认证 → 未认证 → E_AUTH_FAILED
   │
   ▼
② 查能力表 → 不存在 → E_CAPABILITY_NOT_FOUND
   │
   ▼
③ 校验 params 是否符合 params_schema → 不符 → E_PARAM_INVALID
   │
   ▼
④ 执行能力（超时控制 + 资源限制）
   │
   ▼
⑤ 返回结果
```

---

## 第 6 章 安全模型

### 6.1 威胁模型（v1）

| 威胁 | 场景 | 对策 |
|---|---|---|
| 中间人 | 局域网嗅探 / ARP 欺骗 | TLS 1.3 |
| 身份伪造 | 攻击者冒充控制端连接 | HMAC 挑战-应答（预共享密钥） |
| 重放攻击 | 抓包重放 auth | nonce 一次性 + TTL 30s |
| 命令注入 | `system.shell.exec` 被塞恶意命令 | v1 记录 + 审计意识；v2 上白名单模式 |
| 资源耗尽 | 高频/超长命令 | 超时强杀 + 输出截断（10MB） |

**明确假设**：v1 简化安全，**不假设局域网可信**但只提供「基本鉴权」级防护，防裸奔、防误连，**不防**已握有密钥的恶意方（那是 v2 零信任的范畴）。

### 6.2 密钥管理（v1）

| 端 | 存储 | 说明 |
|---|---|---|
| macOS 控制端 | Keychain | `security add-generic-password -s nodeagent -a <client_id> -w <key>` |
| Windows 被控端 | DPAPI / 凭据管理器 | `ConvertTo-SecureString` 或 `node-dpapi` |

**铁律**：密钥不明文落盘、不写日志、不经网络传输（HMAC 只传摘要，不传密钥原文）。**与 OnlyInOne「公钥上云 / 私钥永不上传」约定一致。**

### 6.3 演进路径

| 阶段 | 鉴权 | 传输 | 授权 |
|---|---|---|---|
| v1 | 预共享密钥 + HMAC | TLS 1.3 | 无（凭密钥信任） |
| v2 | Ed25519 签名 | TLS 1.3 | 能力级 ACL |
| v3 | 完整零信任 + 审计 | TLS 1.3 | 对齐参考文档安全模型 |

> **预留**：`hello`/`auth` 已预留 `protocol` 版本号字段；信封可无损加回 `sig`/`ts`。v2 升级不破坏 v1 结构。

---

## 第 7 章 各端实现指南

### 7.1 控制端（macOS）

| 项 | 方案 |
|---|---|
| 运行时 | Node.js 22 |
| 连接 | `ws` 库，`wss://<win_ip>:<port>` |
| 密钥存储 | Keychain |
| 客户端核心 | `@nodeagent/client`（连接、握手、调用、超时） |
| CLI | `@nodeagent/cli`，命令：`connect` / `invoke` / `install` / `status` / `list` |
| MCP | `@nodeagent/mcp`，把能力包装为 MCP 工具给 WorkBuddy |

**CLI 命令示例**

```bash
nodeagent connect 192.168.1.100 --port 8765   # 建立连接（首次输入预共享密钥）
nodeagent invoke system.shell.exec --command "Get-Service Spooler"
nodeagent install --package Microsoft.VisualStudioCode
nodeagent status                               # 查状态（system.status）
nodeagent list                                 # 列出被控端能力
```

### 7.2 被控端（Windows Agent）

| 项 | 方案 |
|---|---|
| 运行时 | Node.js 22 |
| shell 执行 | `powershell.exe -NoProfile -NonInteractive -Command <cmd>` |
| 密钥存储 | DPAPI |
| 装软件 | `winget install --id <id> --silent --accept-package-agreements --accept-source-agreements` |
| 查状态 | `Get-CimInstance Win32_Processor/OperatingSystem/LogicalDisk` + `Get-Counter` |
| 服务化 | `node-windows` 或 NSSM，注册为 Windows 服务，失败自动重启 |
| 部署 | 一键 `scripts/install.ps1` + 开机自启 |

**进程超时强杀（关键）**

```typescript
import { spawn } from 'node:child_process';

const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { detached: true });
const timer = setTimeout(() => {
  // 杀整个进程组，防止孙进程残留
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退出 */ }
}, timeout_ms);
```

> **常见错误**：只 kill 父进程，孙进程变孤儿继续跑。必须用 `detached: true` + 负 PID 杀整个进程组。

**输出截断**：stdout + stderr 合计超 10MB 时截断，返回 `truncated: true`。

**防火墙**：被控端需放行监听端口（入站规则），供控制端主动连接。这是与参考文档「Hub 模式出站连接」的关键差异——**点对点直连是被控端监听、控制端连入**。

### 7.3 网络与端口

| 项 | 值 |
|---|---|
| 默认端口 | `8765`（可配置） |
| 协议 | `wss://`（TLS） |
| 证书 | 自签证书（两端固定校验，防中间人） |
| 连接方向 | 控制端主动 → 被控端监听 |

---

## 第 8 章 工程结构

```
nodeagent/
├── packages/
│   ├── protocol/          # 协议类型定义 + 校验（两端共享）
│   └── client/            # 控制端客户端库（连接、握手、调用、超时）
├── apps/
│   ├── agent/             # Windows 被控端 Agent（常驻服务）
│   ├── cli/               # macOS 控制端 CLI
│   └── mcp/               # MCP server（给 WorkBuddy）
├── scripts/
│   └── install.ps1        # Windows 一键安装脚本
├── docs/                  # 文档
├── README.md
└── PRD.md
```

| 包 | 职责 | 关键文件 |
|---|---|---|
| `@nodeagent/protocol` | 消息信封、方法、错误码、能力 schema 的类型与校验 | `src/messages.ts` / `src/capabilities.ts` / `src/errors.ts` |
| `@nodeagent/client` | 控制端连接管理、握手、invoke、超时与重连 | `src/connection.ts` / `src/handshake.ts` / `src/invoke.ts` |
| `@nodeagent/agent` | 被控端：监听、认证、能力分发、执行、服务化 | `src/server.ts` / `src/dispatcher.ts` / `src/capabilities/` |
| `@nodeagent/cli` | 命令行入口 | `src/index.ts` |
| `@nodeagent/mcp` | MCP server，工具 `na_*` | `src/server.ts` / `src/tools.ts` |

**包管理**：pnpm workspace（monorepo）；**语言**：TypeScript；**运行时**：Node.js 22。

### 8.1 MCP 工具映射（`@nodeagent/mcp`）

能力 < 20，采用「展开工具」路线（每个能力一个工具，AI 语义最清晰）：

| 能力 | MCP 工具名 |
|---|---|
| `system.info` | `na_system_info` |
| `system.status` | `na_status` |
| `system.process.list` | `na_process_list` |
| `system.service.list` | `na_service_list` |
| `system.shell.exec` | `na_exec` |
| `app.list` | `na_app_list` |
| `app.install` | `na_install` |

---

## 第 9 章 路线图与里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **v1-1** | monorepo 骨架 + 协议定义 + 握手 | hello→challenge→auth→auth_ok 打通 |
| **v1-2** | Windows Agent：命令执行 + 查状态 | `system.shell.exec` / `system.status` 跑通 |
| **v1-3** | 装软件（winget）+ 服务化 + install.ps1 | `app.install` 真实装成功，开机自启 |
| **v1-4** | Mac CLI + 预共享密钥 + TLS | 跨机「装软件 + 查状态」两类真实任务跑通 |
| **v1-5** | MCP 接入 WorkBuddy | 自然语言调度 Windows 成功 |

> 对齐 PRD 验收标准：命令闭环成功率 ≥ 95%、装软件成功率 ≥ 90%、查状态 P95 < 3s、鉴权拦截率 100%。

---

## 第 10 章 测试与验收

### 10.1 协议一致性测试

| # | 测试 | 说明 |
|---|---|---|
| P1 | 握手全流程 | hello→challenge→auth→auth_ok 成功 |
| P2 | 鉴权失败 | 错误 HMAC → `E_AUTH_FAILED` 并断开 |
| P3 | nonce 重放 | 重用 nonce → 拒绝 |
| P4 | 能力不存在 | 未知能力 → `E_CAPABILITY_NOT_FOUND` |
| P5 | 参数校验 | 缺必填/类型错 → `E_PARAM_INVALID` |
| P6 | 超时强杀 | 长命令超时后无残留进程 |
| P7 | 输出截断 | 超 10MB 截断并标记 |

### 10.2 端到端验收（对齐 PRD FR）

| FR | 验收场景 |
|---|---|
| FR-02 | `invoke system.shell.exec` 执行命令并返回正确 exit_code/stdout |
| FR-03 | `invoke app.install` 真实安装一款软件并返回版本号 |
| FR-04 | `invoke system.status` 返回 CPU/内存/磁盘/网络结构化数据 |
| FR-06 | CLI 各命令可正确交互 |
| FR-07 | WorkBuddy 通过 MCP 自然语言调度 Windows |
| FR-08 | 重启 Windows 后 Agent 自动上线 |

---

## 附录 A 错误码表

| 错误码 | 名称 | 含义 |
|---|---|---|
| -32700 | `E_PARSE_ERROR` | JSON 解析失败 |
| -32600 | `E_INVALID_REQUEST` | 无效请求 |
| -32601 | `E_METHOD_NOT_FOUND` | 方法不存在 |
| -32602 | `E_PARAM_INVALID` | 参数无效 |
| -32401 | `E_AUTH_FAILED` | 鉴权失败 |
| -32402 | `E_AUTH_REQUIRED` | 未认证即调用 |
| -32403 | `E_CAPABILITY_NOT_FOUND` | 能力不存在 |
| -32405 | `E_NODE_OFFLINE` | 被控端离线 |
| -32412 | `E_TIMEOUT` | 执行超时 |
| -32419 | `E_EXECUTION_FAILED` | 命令/安装执行失败 |
| -32420 | `E_PROTOCOL_MISMATCH` | 协议版本不兼容 |

---

## 附录 B 与参考文档的差异

| 维度 | 参考文档（NodeBuddy） | nodeagent |
|---|---|---|
| 拓扑 | Hub 中枢 + 四端 | **点对点直连 + 两端** |
| 端 | macOS/Windows/Linux/Android | **macOS（控）+ Windows（被控）** |
| 鉴权 | Ed25519 + JWT + 挑战-应答 | **预共享密钥 + HMAC 挑战-应答** |
| 授权 | 能力级 ACL + 默认拒绝 | **v1 无（凭密钥信任），v2 引入** |
| 能力数 | 30+ 标准能力 | **7 个核心能力** |
| 数据面 | 控制面/数据面分离 + 流式背压 | **v1 合并，无流式背压** |
| 消息信封 | 含 sig/ts/meta/trace_id | **精简，预留 sig/ts 字段** |
| 审计 | 全量 + HMAC 链 | **v3 引入** |

**裁剪原则**：只保留「Mac 控 Windows 命令级接管」所需的最小技术集，其余（Hub、四端、零信任、流式）作为演进目标预留接口，不提前实现。

---

> 本方案为产品设计参考，具体实施请结合公司合规与法务要求确认。
