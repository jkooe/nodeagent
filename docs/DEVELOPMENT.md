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
| 15 | `system.audit.list` | 🟢 | 查询审计日志（谁在何时调了什么） | v3+ |
| 16 | `fs.list` | 🟢 | 列目录（glob / 递归） | v5 |
| 17 | `fs.stat` | 🟢 | 文件元信息 | v5 |
| 18 | `fs.read` | 🟡 | 读文件（分块续读） | v5 |
| 19 | `fs.write` | 🔴 | 写文件（分块 / 原子写） | v5 |

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

| 阶段 | 鉴权 | 传输 | 授权 | 状态 |
|---|---|---|---|---|
| v1 | 预共享密钥 + HMAC 挑战-应答 | TLS | 无（凭密钥信任） | ✅ 已实现 |
| v2 | 同上 + 输入控制开关 | TLS | `allow_input` 能力组开关 | ✅ 已实现 |
| v3 | **Ed25519 签名挑战-应答** | TLS | **能力级 ACL（默认拒绝）** | ✅ 已实现 |
| v3+ | 同上 + 审计日志 | TLS | 对齐参考文档完整安全模型 | 规划中 |

> **向后兼容**：`auth_mode` 默认 `psk`，对既有部署零影响；切到 `ed25519` 才启用零信任与 ACL。

### 6.4 零信任实现（v3）

**身份**：每个控制端持有独立 Ed25519 密钥对（用 Node 内置 `crypto`，无新增依赖）。

```
控制端                            被控端
  │ ① hello {client_id}  ─────────►│
  │ ◄─── challenge {nonce} ────────│  32B CSPRNG，TTL 30s，一次性
  │ ② auth {signature}   ─────────►│  用 ACL 中登记的公钥验签
  │ ◄─── auth_ok {capabilities,    │
  │        authorized: [...]} ─────│  下发「已授权能力」子集
```

| 项 | 设计 |
|---|---|
| 密钥格式 | Base64(SPKI DER) 公钥 / Base64(PKCS8 DER) 私钥 —— 单行，便于写配置 |
| 私钥存放 | `<数据目录>/keys/ed25519.json`，**600 权限、永不外传**；可用 `NODEAGENT_PRIVATE_KEY` 覆盖 |
| 公钥登记 | 被控端 `acl.clients[].pubkey`；未登记 → 握手直接拒绝 |
| 密钥标识 | 公钥 SHA-256 前 16 位 hex（`key_id`），便于轮换与追踪 |

**授权**：能力级 ACL，判定顺序 `deny` → `allow` → `default_effect`。

```jsonc
{
  "auth_mode": "ed25519",
  "acl": {
    "default_effect": "deny",            // 默认拒绝（零信任核心）
    "clients": [
      {
        "client_id": "mac_01",
        "pubkey": "MCowBQYDK2VwAyEA...",  // Base64 SPKI DER
        "allow": ["system.*", "screen.*"], // 支持 glob
        "deny": ["input.*"]                // deny 优先，可覆盖 allow
      }
    ]
  }
}
```

| 场景 | 结果 |
|---|---|
| 未注册的 client_id 连接 | 握手失败 `E_AUTH_FAILED` |
| 私钥与登记公钥不匹配 | 握手失败 `E_AUTH_FAILED`（验签不过） |
| 调用未授权能力 | `E_ACL_DENIED`（附 matched 规则与原因） |
| 握手成功 | `auth_ok.authorized` 下发授权子集，CLI 以 🟢/🚫 展示授权矩阵 |

> **实测**：E2E 覆盖四项 —— 授权能力可调用 / 未授权能力被拒 / 未注册身份被拒 / 错误私钥被拒。

### 6.5 审计与限速（v3+）

**审计**：被控端把每次关键动作以 **JSONL** 追加写入 `<数据目录>/audit.log`；写入失败被吞掉，**绝不影响业务**。

| 事件 | 记录内容 |
|---|---|
| `agent.start` / `agent.stop` | 启动参数、认证模式 |
| `auth.success` / `auth.failure` | 调用方、来源 IP、失败原因 |
| `invoke` | 调用方、能力、状态、耗时、参数摘要 |
| `acl.denied` | 命中的 ACL 规则与原因 |
| `rate.limited` | 超限的调用方与配额 |

| 项 | 设计 |
|---|---|
| 轮转 | 单文件超 `max_bytes`（默认 10MB）即轮转，保留 `max_files`（默认 5）份 |
| 脱敏 | 参数键含 `pass`/`token`/`secret`/`key`/`auth` → 替换为 `***`；字符串截断 200 字符 |
| 参数记录 | 默认**仅记摘要**（`sha256` 前 16 位）；`log_args: true` 时才记脱敏预览 |
| 查询 | 能力 `system.audit.list`（`limit`/`since`/`client_id`/`type`），CLI 为 `nodeagent audit` |

**限速**：ACL 中的 `max_calls_per_min` 按调用方**滑动窗口**计数，超限返回 `E_RATE_LIMITED`(-32407)。

```jsonc
{ "client_id": "mac_01", "pubkey": "...", "allow": ["system.*"], "max_calls_per_min": 120 }
```

> **设计取舍**：审计只落被控端本地（不引入中心存储），既保持点对点架构的简洁，又满足「谁动过我的机器」这一核心诉求；集中式审计聚合留待 Hub 模式引入时再议。

### 6.6 无感体验：自动发现与重连（v4）

#### 局域网自动发现（免手抄 IP）

被控端通过 **UDP 心跳广播**自报家门，控制端被动监听即可，**无需任何中心服务**。

```
被控端 ──(每 5s，UDP 8766 → 255.255.255.255)──► 局域网
控制端 ──(监听 UDP 8766)──► 设备表（TTL 30s 自动过期）
```

| 项 | 设计 |
|---|---|
| 端口 | 默认 UDP `8766`（被控端广播目标 = 控制端监听端口） |
| 报文 | `{ service:"nodeagent", node_id, host, port, tls, auth_mode, input_enabled, platform, ts }` |
| **安全** | 报文**不含任何凭据**；被控端可 `discovery.enabled: false` 关闭 |
| 地址判定 | 控制端取**报文来源 IP** 作为可达地址（比被控端自报地址可靠），自报地址另存备查 |
| 可配 | `discovery: { enabled, port, broadcast, interval_ms }`；`broadcast` 可指向具体地址以便测试 |

#### 断线自动重连

客户端可选开启 **指数退避 + 抖动**重连（默认关闭，适合 MCP 等长驻进程）：

| 项 | 值 |
|---|---|
| 退避 | `1s → 2s → 4s → … 上限 30s`（`max_reconnect_delay_ms` 可调） |
| 抖动 | ±15%，避免多客户端同时重连形成惊群 |
| 重连前 | 清空在途请求（统一以 `E_NODE_OFFLINE` 失败），避免悬挂 |
| 状态回调 | `onStateChange: 'connected' | 'reconnecting' | 'closed'` |
| 主动关闭 | `close()` 会停止重连，不会「关不掉」 |

> **实测**：E2E 覆盖两项 —— UDP 广播可被发现 / 被控端重启后客户端自动恢复调用。

### 6.7 多设备与文件传输（v5）

#### 多设备管理

控制端配置从「单设备扁平结构」升级为「设备表」：

```jsonc
// ~/.nodeagent/config.json
{
  "client_id": "mac_01",      // 控制端身份（多台设备共用）
  "current": "win_a",         // 当前默认设备
  "nodes": {
    "win_a": { "host": "192.168.1.100", "port": 8765, "tls": true, "insecure": true, "key": "...", "auth_mode": "psk" },
    "win_b": { "host": "192.168.1.101", "port": 8765, "tls": true, "insecure": true, "auth_mode": "ed25519", "note": "工位机" }
  }
}
```

| 命令 | 作用 |
|---|---|
| `nodeagent connect <host> --key <K> --name win_a` | 连接测试通过后**才**写入设备表，避免脏配置 |
| `nodeagent nodes` | 列出设备（● 标记当前设备） |
| `nodeagent use <name>` | 切换默认设备 |
| `nodeagent remove <name>` | 移除设备（若移除的是当前设备，自动切到第一个） |
| `nodeagent <cmd> --node <name>` | 单次命令临时指定目标，不改动 `current` |

> **零破坏迁移**：`loadConfig()` 会自动把 v1/v2 的扁平配置迁移为 `nodes.default`，老配置文件无需手工改写。

#### 文件传输

传输层用**分块 RPC**（而非新增二进制帧）—— 协议无改动、天然支持断点与进度、实现简单：

| 能力 | 关键设计 |
|---|---|
| `fs.read` | `offset` + `max_bytes` 分块；`eof` 标识结束；小文件（≤8MB）首次读取附带 `sha256` 便于校验 |
| `fs.write` | 覆盖写走**临时文件 + 原子重命名**（不会留半截文件）；`append: true` 追加；`create_dirs` 自动建目录 |
| `fs.list` | 递归 + glob 过滤；递归设硬上限（`max_entries × 3`）防止失控 |
| `fs.stat` | 不存在时返回 `exists: false` 而非报错，便于探测 |

**路径白名单**：被控端可配 `fs_roots: ["C:\\work"]`，非空时只允许访问这些根目录之下的路径，越界返回 `E_ACL_DENIED`；为空则完全交给 v3 的能力级 ACL 管控。

CLI 便捷命令：`ls` / `stat` / `cat` / `pull` / `push`（pull 与 push 自动分块，支持任意大小文件；下载同样**原子落盘**）。

> **实测**：E2E 覆盖 —— 写入 → 读回 → 递归列表 → **1.5MB 分块重组 sha256 一致** → append 语义 → 白名单越界被拒。

### 6.8 Hub 中转（v6）

用于被控端位于 NAT 后 / 与控制端不在同一网段的场景。

```
控制端 ──► Hub ──► 被控端
             ↑ 字节透传，不认识 RPC 内容
```

| 环节 | 设计 |
|---|---|
| 被控端接入 | **主动外连** `ws(s)://hub/hub/agent`，发 `register`（node_id + Hub 令牌 + 元信息）→ 免公网 IP、免入站放行 |
| 控制端接入 | 连 `ws(s)://hub/hub/client`，发 `connect`（node_id + Hub 令牌）→ Hub 回 `paired` |
| 配对之后 | **双向字节透传**：Hub 卸载自身消息监听，仅做 `send` 转发，不再解析 |
| 连接语义 | 控制端断开 → 仅解绑配对，**被控端保持在线**；被控端掉线 → 连带关闭控制端 |
| 并发模型 | 同一被控端同一时刻只服务一个控制端（避免多路复用复杂度），占用时返回 `E_NODE_BUSY` |
| 鉴权 | Hub 令牌（被控端/控制端共用）；`list` 可查在线设备 |

**安全边界**：Hub 位于信任边界之外 —— 它不持有设备密钥，也无法解密业务流量（端到端握手绕不过去）。因此：

- Hub 被攻陷 ≠ 设备被接管（攻击者仍需通过设备侧鉴权）
- Hub 能审计「哪些设备在线」，但看不到「做了什么」（那是被控端本地审计的职责）

**连接复用注意**：Hub 模式下同一连接会被不同控制端先后复用，故被控端在 `hello` 时必须**重置认证态与授权**（已实现），否则存在越权风险。

**TLS**：默认由反向代理终止（Caddy/Nginx），Hub 也可通过 `tls.cert_file` / `tls.key_file` 直接提供。

> **实测**：E2E 覆盖 —— 经 Hub 完成端到端握手并调用 / Hub 令牌错误被拒 / 目标设备不存在 / 控制端断开后被控端仍可再次接入。

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
