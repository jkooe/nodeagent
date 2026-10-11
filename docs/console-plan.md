# nodeagent 大前端开发方案（桌面操作台）

> ⚠️ **本文档 §2 选型、§5.1 的 Rust 版 client、§6 目录结构描述的是「原方案」**，
> **已于 2026-10 被文末「实施决策」取代**（改为 Node sidecar，退役 `crates/nodeagent-client`）。
> 保留原文是为了可回溯决策过程；实现以「实施决策」节与代码为准。


> 版本 v1.0 ｜ 日期 2026-10-07 ｜ 状态：待皇上评审
> 定位：为「Mac 控 Windows」补上**人肉可视化操作台**——CLI 是脚本底座、MCP 是 AI 落点、本方案是**皇上自己点按钮**的桌面界面。

---

## 1. 一句话结论

用 **Tauri 2 + Vue 3 + TypeScript + Vite** 造一套**跨端桌面应用**，同一份代码编译出 **Mac 版（控制端操作台）**与 **Windows 版（被控端本地面板）**；Rust 后端复刻 `@nodeagent/client` 的握手/RPC/事件逻辑，经 Tauri command 暴露给 Vue 前端。首期覆盖 **核心管控 + 文件管理 + 审计**。

---

## 2. 技术栈选型（含取舍）

| 层 | 选型 | 版本 | 选型理由 |
|---|---|---|---|
| 桌面壳 | **Tauri 2** | 2.x | 跨端（Mac/Win）+ 性能好 + 体积小；Rust 后端契合皇上「Rust 加速」技术栈 |
| 前端框架 | **Vue 3** | 3.5+ | 皇上既有 Vue2/Vue3 经验（reader、FinDataHub），迁移成本最低 |
| 语言 | **TypeScript** | 5.x | 与 monorepo 既有 TS 生态对齐，复用协议类型定义 |
| 构建 | **Vite** | 6.x | Tauri 官方模板默认，HMR 快 |
| 状态管理 | **Pinia** | 2.x | Vue3 官方推荐，模块化 store 天然契合多面板 |
| 路由 | **Vue Router** | 4.x | 多页面（总览/终端/文件/审计…）需要 |
| 组件库 | **Naive UI** | 2.x | 暗色主题友好、TS 类型完整、可自定义涨红跌绿 |
| 图表 | **ECharts** | 5.x | 资源趋势/磁盘/指标可视化，涨红跌绿可配 |
| Rust 客户端 | tokio + tokio-tungstenite + rustls | — | 复刻 client.ts 的 WebSocket 握手与 RPC |
| Rust 密码学 | hmac + sha2 + ed25519-dalek + x509-parser | — | HMAC 挑战应答、ed25519 签名、证书指纹钉住 |

### 为什么 Tauri 而不是 Electron / 纯 Web

| 维度 | Tauri 2 | Electron | 纯 Web（浏览器） |
|---|---|---|---|
| 跨端 Mac+Win | ✅ | ✅ | ✅（但无桌面壳） |
| 打包体积 | ~10MB 级 | ~100MB+ | 无 |
| 内存占用 | 低（复用系统 WebView） | 高（自建 Chromium） | 视浏览器 |
| 性能 | 好（Rust 后端） | 中 | 受浏览器沙箱限制 |
| 直接复用 Node SDK | ❌（需 Rust 版 client） | ✅（主进程可 import） | ❌（需浏览器版） |

**取舍**：Tauri 需要新写一份 Rust 版 client（协议本身是 JSON-RPC over WebSocket，语言无关，逻辑对齐已跑通的 client.ts 即可），换取体积、内存、性能上的长期优势——与皇上「性能好 + 跨端」的要求一致。

---

## 3. 整体架构

```
┌─────────────────────────── apps/console（桌面应用，同一份代码两端编译） ───────────────────────────┐
│                                                                                                    │
│  Vue 3 前端（src/）                     Tauri Rust 壳（src-tauri/）                                  │
│  ┌─────────────────────┐   IPC invoke   ┌──────────────────────────────┐                            │
│  │ 视图 Views           │ ────────────► │ commands/*.rs（薄命令层）      │                            │
│  │ 组件 Components      │ ◄──────────── │   │                          │                            │
│  │ Pinia stores         │   event 推送   │   ▼                          │                            │
│  │ api 调用层           │ ◄──────────── │ state.rs（连接管理器）         │                            │
│  └─────────────────────┘               │   │                          │                            │
│                                         │   ▼                          │                            │
│                                         │ crates/nodeagent-client      │ ── WebSocket ──► 被控端      │
│                                         │ （Rust 版 client：握手/RPC/    │   (wss://IP:8765)  Windows    │
│                                         │  事件/重连/证书钉住/ed25519)   │                            │
│                                         └──────────────────────────────┘                            │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

关键设计：

1. **薄壳厚前端**：Rust 壳只做「连接管理 + 协议桥接」，业务展示逻辑全在 Vue 前端。
2. **事件推送走 Tauri event**：被控端主动事件（v12 `event.*`）、连接状态变化，由 Rust 后端转发为 Tauri event，前端 `listen()` 订阅，避免轮询。
3. **能力调用统一 `invoke`**：所有 42 项能力都走一个泛型 `invoke(capability, args)` 通道，前端按能力清单动态渲染参数表单，**不逐能力手写 command**。

---

## 4. 功能模块与页面清单（首期 = 核心管控 + 文件 + 审计）

| # | 页面/模块 | 路由 | 支撑能力 | 功能点 |
|---|---|---|---|---|
| 1 | **设备管理** | `/nodes` | `discover`、`nodes` 配置、`connect` | 局域网发现、设备列表、连接/断开、增删改节点、设默认设备、证书指纹展示与重钉 |
| 2 | **状态总览 Dashboard** | `/overview` | `system.info` / `system.status` / `system.metrics` / `system.audio.get` | 连接状态、主机名/OS/CPU/内存/开机时长、磁盘用量环图、网络适配器、PRD 成功指标（闭环率/P95/拦截率） |
| 3 | **命令执行（终端）** | `/terminal` | `system.shell.exec`、`system.task.*` | 交互式 PowerShell 终端、退出码/耗时、超时可配、长命令后台化 + 任务列表/续读/终止 |
| 4 | **进程与服务** | `/processes` | `system.process.list` / `system.service.list` | 进程/服务列表，按 CPU/内存/PID/名称排序，按名筛选，按状态筛选 |
| 5 | **软件管理** | `/software` | `app.list` / `app.install` | 已装软件列表与版本、winget 静默安装（输入包名/ID，返回结果+版本） |
| 6 | **文件管理** | `/files` | `fs.list` / `fs.stat` / `fs.read` / `fs.write` | 目录树浏览、文件预览（分块读）、上传/下载（分块 + 进度）、新建/覆盖/追加写入、元信息 |
| 7 | **审计日志** | `/audit` | `system.audit.list` / `system.audit.verify` | 审计列表分页、按类型/调用方/时间筛选、完整性校验（verify）、导出 JSONL |

> **Windows 版侧重**（待确认）：同一套代码，Windows 版默认聚焦**被控端本地面板**——本机连接状态、授权（ACL/`allow_input` 输入开关）、本机资源、日志、自更新入口。因协议点对点对称，Windows 版同样可作控制端。

---

## 5. 数据接口与状态管理

### 5.1 Rust 版 client（`crates/nodeagent-client`）对外 API

| 方法 | 说明 | 对齐 client.ts |
|---|---|---|
| `Client::connect(profile) -> NodeInfo` | 握手：hello → challenge → auth → auth_ok | `connect()` |
| `Client::invoke(capability, args, timeout) -> InvokeResult` | 泛型能力调用 | `invoke()` |
| `Client::list_capabilities()` / `list_authorized()` | 能力/授权清单 | `listCapabilities()` |
| `Client::set_event_handler(fn)` | 订阅被控端事件（无 id 通知） | `onEvent` |
| `Client::on_state_change(fn)` | 连接/重连/关闭状态回调 | `onStateChange` |
| `Client::close()` | 主动断开（停自动重连） | `close()` |
| `Client::peer_cert_fingerprint()` | 对端证书指纹（TOFU 钉住） | `getPeerCertFingerprint()` |

复刻要点（已跑通，勿重蹈）：指数退避重连 1s→30s ±15% 抖动；证书指纹 sha256 比对（`E_CERT_MISMATCH`）；ed25519 模式需私钥；Hub 配对透传。

### 5.2 Tauri command（Rust 壳 → 前端 IPC）

| Command | 入参 | 返回 | 说明 |
|---|---|---|---|
| `discover` | `wait_ms` | `Node[]` | UDP 8766 发现 |
| `connect_node` | `node_id` | `NodeInfo` | 连接并握手 |
| `disconnect` | — | `()` | 断开 |
| `invoke` | `capability, args, timeout_ms?` | `InvokeResult` | 泛型能力调用 |
| `list_nodes` / `add_node` / `remove_node` / `set_current` | profile 结构 | 配置 | 设备 CRUD（写 `~/.nodeagent/config.json`） |
| `get_conn_state` | — | `ConnState` | 当前连接状态 |
| `get_capabilities` | — | `Capability[]` | 能力/授权清单 |

### 5.3 事件推送（Tauri event，Rust → 前端）

| 事件名 | 载荷 | 触发 |
|---|---|---|
| `node-event` | 被控端事件（`kind/action/target/detail`） | 被控端 `event.*` 主动推送 |
| `conn-state` | `connected/reconnecting/closed` | 连接状态变化 |
| `task-progress` | `task_id, offset, output` | 长任务增量输出 |

### 5.4 Pinia store 设计

| Store | 职责 | 关键 state |
|---|---|---|
| `useConnStore` | 连接状态、当前节点、能力/授权清单、证书指纹 | `state, nodeId, capabilities, authorized, certSha256` |
| `useNodeStore` | 设备配置列表、发现结果、分组 | `nodes, current, groups, discovered` |
| `useSysStore` | 系统信息/状态/指标缓存（可手动刷新） | `info, status, metrics` |
| `useFileStore` | 当前目录、文件列表、选中项、上传下载进度 | `cwd, entries, selection, transfers` |
| `useAuditStore` | 审计分页与筛选 | `items, page, filter` |
| `useEventStore` | 事件流（订阅 + 游标续拉） | `watches, events, cursor` |
| `useTaskStore` | 后台长命令任务 | `tasks` |

**数据流**：组件 → Pinia store → `api/`（封装 `invoke`）→ Tauri command → Rust client → 被控端；反向经 Tauri event → store 更新 → 响应式视图。高频指标（status/metrics）由 store 内定时器轮询，可配置周期；事件类数据走推送，不轮询。

---

## 6. 代码结构（monorepo 新增）

```
nodeagent/
├── apps/
│   └── console/                    # 桌面应用（新增）
│       ├── package.json
│       ├── vite.config.ts
│       ├── index.html
│       ├── src/                    # Vue 3 前端
│       │   ├── main.ts / App.vue
│       │   ├── router/index.ts     # 7 条路由
│       │   ├── views/              # Nodes / Overview / Terminal / Processes / Software / Files / Audit
│       │   ├── components/         # 可复用组件（设备卡片、参数表单、状态徽章、进度条…）
│       │   ├── stores/             # Pinia（5.4 节 7 个 store）
│       │   ├── api/                # invoke 封装 + 类型（对齐 Rust command）
│       │   ├── types/              # 能力清单、InvokeResult、NodeProfile 等类型镜像
│       │   └── utils/              # 格式化、涨红跌绿、分块编排
│       └── src-tauri/              # Rust 壳
│           ├── Cargo.toml
│           ├── tauri.conf.json
│           └── src/
│               ├── main.rs / lib.rs
│               ├── state.rs        # 连接管理器（持有 client）
│               └── commands/       # 5.2 节 command 实现
├── crates/
│   ├── nodeagent-client/           # Rust 版 client（新增，5.1 节）
│   │   ├── Cargo.toml
│   │   └── src/{lib.rs, client.rs, handshake.rs, tls.rs, events.rs}
│   └── nodeagent-protocol/         # （可选）协议类型/能力清单的 Rust 镜像
└── packages/… apps/{agent,cli,hub,mcp}   # 现有，不动
```

约束：Rust client 与 Node client（`packages/client`）**行为一致**，两端共享 `~/.nodeagent/config.json` 与 `keys/`，不新造存储位置；能力清单以 `packages/protocol/src/capabilities/manifest` 为唯一事实源，Rust 侧做类型镜像并对齐。

---

## 7. 交付范围

### In scope（首期 v1）

| # | 交付物 | 说明 |
|---|---|---|
| 1 | `crates/nodeagent-client` | Rust 版 client，对齐 client.ts 全部行为，含单元测试 |
| 2 | `apps/console` 桌面应用 | Tauri + Vue3，7 个页面，Mac/Win 双端可编译 |
| 3 | 核心管控 | 设备管理、总览、终端、进程/服务、软件安装 |
| 4 | 文件管理 | 浏览/预览/上传/下载（分块）/写入 |
| 5 | 审计 | 列表分页筛选、完整性校验、导出 |
| 6 | 打包脚本 | Mac `.app` + Windows `.msi/.exe`（复用现有 `pack.mjs` 风格） |

### Out of scope（后续版本）

| # | 内容 | 归属 |
|---|---|---|
| 1 | 图形接管 UI（实时截图/键鼠/窗口定位/宏回放） | v2 |
| 2 | 网络两阶段变更、音频控制、自更新面板 | v2 |
| 3 | 事件流订阅的可视化（watch/list/poll 面板） | v2 |
| 4 | 应用签名/公证/自动更新 | 独立发布项 |
| 5 | 多设备批量下发（fanout/分组）面板 | v2 |

---

## 8. 验收标准

### 8.1 功能验收（Given/When/Then）

| # | 验收项 | 标准 |
|---|---|---|
| A1 | 设备连接 | Given 已配置被控端，When 点击连接，Then 3s 内返回能力清单并进入总览；密钥错误返回 `E_AUTH_FAILED` 且界面明确提示 |
| A2 | 状态总览 | Given 已连接，When 打开总览，Then 正确展示 CPU/内存/磁盘/网络与 PRD 指标，且数据带时间戳 |
| A3 | 命令执行 | Given 已连接，When 输入合法 PowerShell，Then 返回 `exit_code/stdout/stderr/duration_ms`；超时命令返回 `E_TIMEOUT` 且无残留进程 |
| A4 | 软件安装 | Given winget 可用，When 输入包名，Then 返回安装结果+版本；不存在时给出明确失败原因 |
| A5 | 文件上传/下载 | Given 已连接，When 上传大文件（>8MB），Then 分块写入成功且校验 sha256 一致；下载支持断点续读 |
| A6 | 审计 | Given 已连接，When 打开审计页，Then 分页展示并可筛选；verify 返回完整性结论 |
| A7 | 断线重连 | Given 已连接，When 拔网再恢复，Then 指数退避自动重连并回到 connected，界面状态同步 |

### 8.2 指标验收

| 指标 | 口径 | 目标 |
|---|---|---|
| 命令闭环成功率 | 成功返回 ÷ 发起 | ≥ 95% |
| 内网调用 P95 时延 | 前端点击到结果渲染 | < 3s |
| 应用内存占用 | Mac 版空闲常驻 RSS | < 150MB（远低于 Electron） |
| 打包体积 | **用户实际下载的分发件** | Mac `.dmg` < 40MB（实测 **33.8MB** ✓）／Win 安装包 < 40MB（待实测） |
| 双端编译 | `pnpm build` 一次产出两端 | 100% |

> **⚠️ 口径调整（2026-10-11，待确认）**：原指标写的是「Mac `.app` < 30MB / Win 安装包 < 40MB」。
> 那条是 **Tauri + Rust client** 时代的数字 —— 当时应用内不含 JS 运行时。
> 改为 Node sidecar 方案后，应用必须自带 Node 运行时（sidecar 是 `.mjs`，不能假定用户装了 Node），
> 故 `.app` 实测 **90.8 MiB**（其中 Node 运行时 86MB）。
> **但用户下载的是 `.dmg`，实测 33.78 MiB** —— 仍低于原定 40MB。
> 故本表口径改为「分发件体积」。作为对照：本机实测 Electron 运行时本体
> （`Electron Framework.framework`）为 **207MB**，即 Tauri + Node 的运行时开销
> 仍不到 Electron 的 **一半**（86MB vs 207MB）。

---

## 9. 里程碑拆分

| 阶段 | 内容 | 退出标准 |
|---|---|---|
| M1 | Rust client crate + 握手/RPC/事件/重连 + 单测 | 与现有 `test:e2e` 协议用例对齐通过 |
| M2 | Tauri 壳 + command 层 + 设备管理/总览/终端三页 | 真机连接成功、能跑命令、总览数据正确 |
| M3 | 文件管理 + 审计 + 软件/进程服务页 | A5/A6/A4 验收通过 |
| M4 | Mac/Win 双端打包脚本 + 文档 | A 全部通过、指标达标 |

---

## 9.1 M3 实测：契约探针与漂移修正（2026-10-07）

M3 七页写完后，用 `crates/nodeagent-client/examples/probe.rs` 对**真实被控端**逐项调用，
输出**字段契约**（顶层键 + 数组首元素键）而非数据预览，再与前端类型逐项比对。

```
cargo run --example probe -- ws://127.0.0.1:8765 <key> /tmp/nodeagent-e2e
═══ 通过 10 · 失败 0 ═══
```

> 便捷入口：`pnpm probe -- ws://127.0.0.1:8765 <key> /tmp/nodeagent-e2e`
> （等价于 `cargo run --manifest-path crates/nodeagent-client/Cargo.toml --example probe -- <url> <key> [base]`；
> `--full` 可打印完整 JSON）
> 起本地被控端：`NODEAGENT_HOME=/tmp/nodeagent-e2e node apps/agent/dist/index.js`

**探针结果**（被控端 = macOS，故 Windows 专属能力预期失败）：

| 能力 | 结果 | 实测字段 |
|---|---|---|
| `fs.list` | ✓ | `entries[{name,path,type,size,mtime}]`, `total`, `truncated` |
| `fs.stat` | ✓ | `exists,mtime,path,size,type` |
| `fs.read` | ✓ | `bytes,data,encoding,eof,offset,sha256,total_bytes` |
| `fs.write` | ✓ | `path,total_bytes,written` |
| `system.audit.list` | ✓ | `entries[{args_digest,capability,client_id,duration_ms,hash,prev,remote,status,ts,type}]`, `total`, `file` |
| `system.audit.verify` | ✓ | `checked,legacy,ok` |
| `app.list` / `app.install` | ✗ 预期 | `E_UNSUPPORTED_PLATFORM`（非 Windows） |
| `system.process.list` | ✓ | `processes[{cpu_pct,memory_bytes,name,pid,started_at}]` |
| `system.service.list` | ✗ 预期 | `E_UNSUPPORTED_PLATFORM`（非 Windows） |
| `system.info` | ✓ | `os` 返回 `macOS`（**平台门控的判断锚点**） |
| `system.status` | ✓ | `disks[{drive,free,total,used_pct}]`, `net[{adapter,ip,up}]` |
| `system.shell.exec` | ✓ | `duration_ms,exit_code,killed,stderr,stdout,truncated` |

### 抓到的漂移（均为**静默空列**，非运行时报错）

| 页面 | 前端原读 | 契约真源 | 后果 |
|---|---|---|---|
| 进程表 CPU 列 | `r.cpu` | `cpu_pct` | 恒为 `-` |
| 进程表 内存列 | `r.memory` | `memory_bytes` | 恒为 `-` |
| 进程表 已运行 | （无） | `started_at` | 缺列 |
| 服务表 状态列 | `r.status` | `state` | 恒为 `-` |
| 总览 磁盘盘名 | `d.mount \|\| d.name` | `drive` | 恒空白 |
| 总览 磁盘已用 | `d.used` | **无该字段**，须算 `total - free` | 恒为 `-` |
| 总览 网卡 | `{name,rx_bytes,tx_bytes}` | `{adapter,ip,up}` | 整块错位 |
| 软件表 ID 列 | `a.id` | `publisher`（结果里**没有 id**） | 整列恒空 |
| 审计断点 | `broken_at` 当数字渲染 | `{file,line,reason}` 对象 | 渲染成 `[object Object]` |

### 修正与固化

1. **类型镜像** `apps/console/src/types/index.ts` 全部按契约改写；
   `ProcessEntry`/`ServiceEntry`/`DiskInfo`/`NetInfo`/`AppEntry`/`AuditEntry`/`BuildInfo` 等。
2. **平台门控**：`conn.ts` 导出 `WINDOWS_ONLY_CAPS`，连接后自动探测 `system.info.os` → `isWindows`/`platformReady`；
   软件页与服务 Tab **事前禁用并说明原因**，而不是发出注定失败的请求再解释错误。
3. **结构化错误**：`api.CapabilityFailure` 携带 `error.name`（协议真源 `InvokeResult.error` 只有
   `{name,message,data?}`，**没有 code**），提供 `isUnsupportedPlatform` / `isAclDenied` / `isRateLimited`。
4. **守卫测试** `tests/unit/console-contract.test.mjs`（20 用例）：
   - 正向：console 声明的字段 **⊆** 该能力 `returns_schema` 的字段 → 抓「声明了不存在的字段」
   - 反向：`returns_schema` 字段 **⊆** console 声明 → 抓「契约加了字段、前端没跟上」
   - 平台门控清单与 agent 侧实际抛 `UNSUPPORTED_PLATFORM` 的能力集合一致
   - 审计 `AuditType` 覆盖 `apps/agent/src/audit.ts` 的全部取值
   - **已注入漂移实测**：把 `cpu_pct` 改回 `cpu` → 正向+反向各挂 1 项，确认非空转守卫。

---

## 10. 风险与对策

| # | 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|---|
| R1 | Rust 版 client 与 Node 版行为漂移 | 中 | 高 | 以 `packages/protocol` 能力清单为唯一事实源；协议用例双端共跑 |
| R2 | Tauri 下自签证书/TLS 处理差异 | 中 | 中 | 复刻 client.ts 的 `insecure` + 指纹钉住逻辑，单测覆盖 `E_CERT_MISMATCH` |
| R3 | Windows 端定位歧义 | 中 | 中 | 见第 4 节「待确认」，评审时定死再做 |
| R4 | 大文件分块上传稳定性 | 中 | 中 | 复用已有分块能力；前端做进度+断点，M3 真机压测 |

---

## 11. 待确认项（请皇上评审时一并拍板）

| # | 事项 | 臣的建议 |
|---|---|---|
| C1 | Windows 端桌面应用的定位 | 被控端本地面板（默认侧重）+ 对称可作控制端 |
| C2 | 组件库 | Naive UI（暗色友好、TS 完整）；若皇上惯用 Element Plus 可换 |
| C3 | 图表库 | ECharts（资源趋势/磁盘）；确认后纳入 M2 |
| C4 | 是否同步做图形接管 UI | 建议 v2 再做，首期聚焦闭环 |

> 仅供参考，本方案为技术规划，不构成任何投资建议。

---

## 实施决策（2026-10-10）：采纳「Tauri + Node sidecar」，退役 Rust client

### 为什么改

原计划（本文档 §2）让 Rust 壳**自己实现一份 client**（`crates/nodeagent-client`），
代价是「**两套协议实现**」—— Rust 版与 TS 版会**静默漂移**：改了一处漏另一处时，
构建通过、单测通过，只在真机运行时才暴露。这是本项目已经反复吃过的一类坑
（见 `RETROSPECTIVE.md` 的「两份真相」教训）。

**sidecar 方案**让 Rust 壳退化为**进程管理者 + 消息转发者**，协议实现只剩 TS 一份：

```
┌──────────────┐   Tauri command（签名不变）   ┌─────────────────┐
│  Vue 前端     │ ───────────────────────────► │  Rust 壳         │
└──────────────┘ ◄──── Tauri event ──────────  │（启动/转发/监督） │
                                               └────────┬────────┘
                                                  stdin/stdout（JSON-RPC 2.0，行分隔）
                                                        ▼
                                            ┌───────────────────────────┐
                                            │ Node sidecar（sidecar.mjs）│
                                            │ 复用 @nodeagent/client     │
                                            └───────────────────────────┘
```

### sidecar 协议

请求（Rust → sidecar）：
```jsonc
{"jsonrpc":"2.0","id":1,"method":"connect","params":{url,key,client_id,insecure,auth_mode?,private_key?,cert_sha256?,hub?}}
{"jsonrpc":"2.0","id":2,"method":"invoke","params":{capability,args,timeout_ms?}}
{"jsonrpc":"2.0","id":3,"method":"state"}
{"jsonrpc":"2.0","id":4,"method":"disconnect"}
```
通知（sidecar → Rust，用 `params.kind` 区分，Rust 侧再桥接成 Tauri event）：
```jsonc
{"jsonrpc":"2.0","method":"event","params":{"kind":"state","state":"connected"}}
{"jsonrpc":"2.0","method":"event","params":{"kind":"log","message":"..."}}
{"jsonrpc":"2.0","method":"event","params":{"kind":"agent_event","event":{…}}}
```

**两条纪律**：① **stdout 只写协议消息**（日志一律 stderr，混入非 JSON 行会让 Rust 侧解析失败）；
② 任何异常都转成响应，**绝不因单个请求崩进程**。

### 错误形态归一（真机实测中修正）

被控端对「未知能力 / ACL 拒绝 / 超时」是回 **JSON-RPC error**，`client.invoke()` 因此**抛异常**。
若原样上抛，前端要处理两种形态。sidecar 已把它归一成 `InvokeResult` 的 failed 形态：

```jsonc
{"result":{"status":"failed","error":{"name":"E_CAPABILITY_NOT_FOUND","message":"…"}}}
```
「调用方式不对」（未连接 / 缺参数）仍走**协议错误**（带明确 code），二者语义不同、不混淆。

### 进度

| 步骤 | 状态 |
|---|---|
| ① sidecar 实现（`apps/console/sidecar/main.mjs`） | ✅ 190 行 |
| ② 真实链路 e2e（本地 agent → connect → invoke → 事件 → 错误 → disconnect） | ✅ **8/8 通过** |
| ③ 单文件打包（`sidecar/build.mjs`，esbuild JS API + createRequire shim） | ✅ 227KB，**仓库外可独立运行** |
| ④~⑥ 见下 | ✅ 详见「Rust 壳改造」一节 |
| ④ Rust 壳改造（`sidecar.rs` + 薄转发 `lib.rs`，5 个 command 签名与 3 个 event 名不变） | ✅ |
| ⑤ `tauri.conf.json` 的 resource 配置（sidecar.mjs）+ `beforeBuildCommand` 串 sidecar:build | ✅ |
| ⑥ 退役 `crates/nodeagent-client` | ✅ 已删 crates/；`rust.yml` 改为验证 console 壳 |

### 打包说明（步骤 ⑤ 的既定方向）

sidecar 是 `.mjs`，需要 Node 解释器 —— **不满足 Tauri `externalBin`（要求可执行文件）**。
采用与 `pack:win` 一致的既有做法：**sidecar.mjs + Node 运行时都作为 Tauri resource**，
Rust 侧从 resource 目录解析路径后 spawn（开发期直接用系统 node）。
（`externalBin` 若要走，需 Node SEA 打成真二进制，但其动态 require 限制与 `ws` 有冲突，故不采用。）

### Rust 壳改造（步骤 ④⑤⑥ 详情）

| 文件 | 变更 |
|---|---|
| `src-tauri/src/sidecar.rs`（新增 ~290 行） | `Sidecar` 管理器：spawn node + 行分隔 JSON-RPC 请求/响应匹配（oneshot）+ 通知回调；`resolve_node`/`resolve_sidecar` 路径解析（env → resource → 开发期系统 node） |
| `src-tauri/src/lib.rs`（重写） | 退化为薄转发：`ensure_sidecar` 懒启动；**5 个 command 签名与 3 个 event 名一律不变**；`get_capabilities`/`get_state` 读本地缓存以**保持同步签名**；`RunEvent::Exit` 时优雅 `shutdown` |
| `Cargo.toml` | 移除 `nodeagent-client` 依赖；加 `tokio`（process/io-util/sync/time/macros）；版本 0.1.0 → **2.0.0**（原先与 tauri.conf.json 不一致） |
| `crates/`（整目录） | **删除**（12 个文件） |
| `.github/workflows/rust.yml` | 由「Rust client 单测」改为「**Rust 壳单测（真跑 sidecar）**」：装 Tauri 系统依赖 + Node + pnpm，跑 clippy -D warnings 与 `cargo test` |
| `package.json` | `test:rust` 改指 console 壳；移除 `probe`（其"对真机逐项核对字段"的用途已由 CLI `nodeagent invoke` 覆盖） |

**可测试性设计（关键）**：sidecar 管理器**不依赖 Tauri GUI**，故其单测能在 CI 里
**真跑 Node 子进程**验证 spawn / 请求-响应匹配 / 错误不崩 —— 不必等到人工开窗口才敢确认。
`cargo test` 实测：**3/3 通过**（0.49s）。

### Node 运行时分发（2026-10-11 完成）

sidecar 是 `.mjs`（不是可执行文件，故**不满足 Tauri `externalBin` 的要求**），
分发给他人时须把 Node 运行时一并打进包。做法沿袭被控端 `scripts/pack.mjs` 的既有路子：
**把 Node 运行时当作 Tauri resource**。

```
scripts/prepare-console.mjs        ① 从本机 node 复制 → apps/console/src-tauri/runtime/node
                                   ② macOS：strip -x（108MB→86MB）**并 adhoc 重签**
                                   ③ 生成 apps/console/src-tauri/tauri.bundle.gen.json
                                      { "bundle": { "resources": {
                                          "../sidecar/dist/sidecar.mjs": "sidecar.mjs",
                                          "runtime/node": "node" } } }
pnpm --filter nodeagent-console bundle
    = sidecar:build → prepare:node → tauri build --config tauri.bundle.gen.json → verify:bundle
```

**三处必须记住的约束**（都是实测踩出来的）：

1. **绝不写进默认 `tauri.conf.json`** —— `bundle.resources` 是**编译期契约**，
   `tauri-build` 会校验声明的每个文件必须存在；声明一个「运行期才准备好」的文件会让
   `cargo check/test` 直接失败（2026-10-10 已踩）。故一律走 `--config` 注入。
2. **macOS 上 strip 之后必须 adhoc 重签** —— `strip` 会使 Mach-O 代码签名失效，
   而 macOS 内核对签名无效的可执行文件**直接 SIGKILL（exit 137）**，无任何有用报错。
   实测对照：原样复制 ✓｜strip 不重签 ✗(137)｜strip + `codesign --force --sign -` ✓。
3. **`resolve_node` 与 resource 映射必须对齐** —— 映射 `runtime/node → node`
   使产物落在 `Contents/Resources/node`，正是 `src-tauri/src/sidecar.rs` 里
   `resolve_node(resource_dir)` 查找的路径。

**验证（不只看「打包成功」）**：`apps/console/scripts/verify-bundle.mjs` 真 spawn 打包内的
node 去跑打包内的 sidecar，并走一次真实 JSON-RPC 握手 —— 源码与单测都正常、
只在产物中暴露的问题（如上述 137）靠它拦下。已接入 CI（Linux 与 Windows 双覆盖）。

**实测体积**：`.app` **90.8 MiB**（6.75 MiB → 90.8 MiB，增量即 Node 运行时 86MB）／
`.dmg` **33.78 MiB**（分发件，仍 < 40MB 目标）。

### ⚠️ 剩余一处已知待办（需图形环境）

**GUI 端到端人工验证**：开窗口 → 连接被控端 → 操作界面。
沙箱无法运行图形应用，故验证止于 `cargo test`（真跑 sidecar）+ `verify:bundle`（真跑产物）
+ 应用进程可启动（实测存活、无崩溃输出）。**界面交互仍需在图形环境点一遍。**

### 一个易踩的构建约束（本轮 CI 失败后查明）

`tauri-build`（build.rs）会**在编译期校验** `tauri.conf.json` 里 `bundle.resources`
声明的每个文件是否存在。因此：
- 只声明**构建期必会生成**的产物（如 `sidecar.mjs`，由 beforeBuildCommand 产出）
- CI 里在 clippy/test **之前**必须先生成它，否则 build.rs 阶段就失败
- 本地复现：删掉 `sidecar/dist/` → `cargo check` 报 "failed to run custom build command" ✓

---

## 本机服务托管（2026-10-11）：把「命令行那一步」从用户手里拿走

### 需求原文与逐条落点

> 「不再打开命令行窗口，运行应用之后，有启动、停止、重启、检查更新等功能，
> 有日志功能，可以后台运行和开机自启等等功能」

| # | 要求 | 落点 | 实现位置 |
|---|---|---|---|
| 1 | **不再打开命令行窗口** | 三处（见下表） | `agent.rs` / `autostart.rs` / Tauri 自身 |
| 2 | 启动 / 停止 / 重启 | 「本机服务」页三按钮 + 托盘菜单 + 侧栏快捷按钮 | `AgentManager` |
| 3 | 检查更新 | 「更新」卡片：检查 → 更新 → 打开 Release 页 | `check_update` / `download` / `apply_update` |
| 4 | 日志功能 | 「服务日志」页（实时推送 + 过滤 + 暂停 + 导出） | `na-agent-log` 事件 + `agent_logs` |
| 5 | 后台运行 | 托盘常驻；关窗 → 最小化到托盘 | `build_tray()` + `on_window_event` |
| 6 | 开机自启 | 「运行方式」卡片开关 | `autostart.rs` |

### 消灭命令行窗口：三条措施缺一不可

| # | 措施 | 不加会怎样 |
|---|---|---|
| 1 | 控制台本身是 GUI 子系统程序 | 打开应用先弹一个黑窗 |
| 2 | spawn `node.exe` 时带 `CREATE_NO_WINDOW`（`0x0800_0000`） | **每次点「启动」都闪一个黑窗** —— 正是要消灭的现象 |
| 3 | 开机自启拉起的是控制台（`--agent-only`），不是裸 `node` | 开机时黑窗一闪而过 |

> 第 2 条是最容易被漏掉的一条：Rust 的 `std::process::Command` **默认不设**这个标志，
> 于是「界面上点一下启动」= 屏幕上闪一个控制台窗口。它不报错、不影响功能，
> 所以只有在**真的看着屏幕点**的时候才会发现。

### 架构：控制台自己就是被控端的「进程管理者」

```
┌──────────────────── apps/console ────────────────────┐
│  Vue：本机服务页 / 服务日志页                           │
│        │ invoke                    ▲ event            │
│        ▼                           │ na-agent-state   │
│  Rust：AgentManager ──────────────────────────────┐    │
│        │  ① spawn node agent.mjs（CREATE_NO_WINDOW）│    │
│        │  ② 800ms 轮询 try_wait（不把 Child 交给 wait()） │
│        │  ③ stdout/stderr 双泵 → 环形 4000 行 + seq   │    │
│        ▼                                             │    │
│  Node 被控端（本机，loopback 8765）◄──── 同一个 agent 复用 ─┘
└──────────────────────────────────────────────────────┘
```

**复用同一个被控端实现**：控制台托管的这台本机被控端，与控制端连远端用的是**同一份 `agent.mjs`**，
不做「控制台内嵌一个第二套被控端」。这与 §「主控被控一体」的既有决策一致。

### 四条实测踩出来的关键约束

| # | 约束 | 为什么（踩坑记录） |
|---|---|---|
| 1 | **退出监控用轮询 `try_wait`，绝不把 `Child` 交给 `wait()`** | `wait()` 会**取得 `Child` 的所有权**，此后 `stop()` 再也拿不到它去 kill → 点「停止」无效 |
| 2 | **日志游标用独立单调 `seq`，不用位置下标** | 环形缓冲淘汰旧行后位置下标会漂移 → 前端增量拉取**静默错位**（重复行 / 丢行，且不报错） |
| 3 | **`start()` / `restart()` 的接收者必须是 `self: &Arc<Self>`** | 监控任务要持有自持引用；`&self` 拿不到 `Arc`，编译期 E0599/E0502 |
| 4 | **macOS `gui/<uid>` 的 uid 运行时 `id -u` 现取** | 硬编码 `501` 只是首个本地用户的常见值，多用户机不成立 |

### 播种（seeding）：为什么必须有版本比较

控制台随包带一份 `agent.mjs`，首次运行复制到数据目录。规则：

```
随包版本 > 已安装版本  →  覆盖（用户拿到了更新的控制台，应带上更新的被控端）
随包版本 ≤ 已安装版本  →  保留数据目录里的（用户可能已自更新到更新版本）
```

若写成「同版本才跳过」，则**用户自更新过被控端后，下次开控制台会被静默降回旧版** ——
无任何提示，能力凭空变少，且极难归因。已用单测钉死「随包版本更低时不得覆盖」。
版本比较按**数值逐段**（`2.0.10 > 2.0.9`）：字符串比较会把前者判小。

### 判定「实例是否在跑」为什么不靠单一信号

控制台同时面对两种被控端：

| 情况 | 判定方式 | 界面处置 |
|---|---|---|
| 本控制台托管的实例 | 管理器状态 = `RUNNING` | 可停止 / 重启 |
| **手工安装的非托管实例**（用户先跑过 `install.ps1` / `install-macos.sh`） | 管理器状态 = `STOPPED` **但** TCP 探测端口已被占用 | **明确告警**：这不是本控制台启的，无法代它停止；给出两条出路 —— 手工停掉，或用「连接本机」直接复用 |

只看管理器状态会把第二种情况判成「未运行」，然后用户点「启动」得到一个端口冲突；
只看端口探测则会把「别人的服务」误报成本控制台托管的实例。**两个信号交叉判**才能给出正确建议。

### 契约守卫：钉住三类「不报错的失效」

界面点按钮没反应、日志不刷新，往往**没有任何异常** —— 因为失效发生在「两边名字不一致」这种
编译器和类型系统都看不见的地方。新增 `tests/unit/console-commands.test.mjs`（8 用例）覆盖：

| 守卫 | 若缺失会怎样 |
|---|---|
| `invoke("x")` ⇄ Rust `generate_handler!` 双向 | 前端调不存在的命令；或改名后残留死命令 |
| `emit("na-*")` ⇄ `listen("na-*")` 双向 | **界面永不刷新，零报错**（最阴的一类） |
| `tauri.bundle.gen.json` 资源名 ⇄ Rust `resolve_*` 字面量 | 生产包内找不到 sidecar / node / agent |
| sidecar 方法名 ⇄ Rust `.request("x")` | 跨语言调用错名 |
| 路由表 ⇄ 实际 view 文件 + 默认路由 | 写了页面进不去；循环依赖导致路由推导成 `any` |
| `var(--na-*)` 使用点 ⇄ `cssVars()` 定义 | 拼错变量名**不报错**，颜色静默落回继承值 |
| `index.html` 首帧兜底色 ⇄ 调色板 `bg` | 首帧兜底是全应用唯一允许的色值重复处，允许重复就必须有守卫 |

> 该测试**已注入故障实测会红**：① 改 `agent_start` → `agent_startX`、`na-agent-state` → `na-agent-statee`
> 当场 2 条失败；② 把 `var(--na-sunken)` 拼成 `var(--na-sunkenTypo)`（含大写）与 `var(--na-sunkenx)`，
> 变量闭合那条均失败；③ 把 `index.html` 的 `#f4f4f5` 改回 `#ffffff`，首帧底色那条失败。
> 全部复原后 `#pass = 8 / #fail = 0`，文件逐字节还原。
>
> 第 ② 条暴露过一次**守卫自身漏报**：正则原写 `[a-z0-9-]+`，遇到含大写的拼错会在中途停下导致
> 整个模式不匹配 —— 于是「写错的变量名」反而逃过检查。放宽到 `[^)\s,;]+` 后才真正生效。
> 教训：**注入故障不只是验证守卫有没有，还要验证它是否覆盖了目标形态**。

## 界面观感约定（2026-10-11）

两轮纯界面调整，方向都是「少即是多」。理由记下来，免得日后被当成"没做完"再补回去。

### 一、一律不使用图标

触发原因是一次真实的渲染事故：侧栏的 emoji 图标在非系统字体栈的渲染器里退化成**豆腐块**。
试过三法，分别无效或更糟 —— 给图标指定 `Apple Color Emoji`、全局字体栈加 `!important`、
乃至 `font-variant-emoji: emoji`（最后一招把 ASCII 数字也拆成了 emoji 呈现）。
「哪套字体栈一定带 emoji」跨平台并不成立 —— **与其赌字形，不如不用**。

去掉的范围比"看得见的图标"宽得多（下面这三类都算）：

| 类别 | 处数 | 关法 |
|---|---|---|
| 侧栏 emoji | 9 | 路由表 `meta.icon` 字段**整体删除**，`NavMeta` 接口同步收窄 |
| `n-empty` 空态**插画** | **16** | `:show-icon="false"` —— 插画比图标更「图形」，散在 9 个页面，**最易漏** |
| `n-alert` 类型图标 | 7 | naive-ui 的 `showIcon` **默认就是 `true`**，不显式关它就一直都在 |
| `n-popconfirm` 询问图标 | 3 | 同上 |
| 文案里的符号 | 1 | 终端页「⚠ 高权限操作，请谨慎」保留纯文字 |

顺带清掉 `public/{vite,tauri}.svg` 与 `src/assets/vue.svg`：`public/` 下的文件会被**整体复制进产物**，
此前等于把 Vite / Tauri 的 logo 一并发了出去（且 `index.html` 的 favicon 正指向它）。
`index.html` 的 `<title>` 还是模板默认的「Tauri + Vue + Typescript App」，也一并改齐
（原生窗口标题取自 `tauri.conf.json`，故此前只是 dev 态标签页不一致）。

**刻意未动**：① 托盘图标 —— 菜单栏没图标就点不到，关窗后应用无法寻回，属**功能必需**；
② 被控端 CLI 自己打印的文本标记（`⚠️`/`ℹ️`/`✅`）—— 是**程序输出内容**，会原样出现在「服务日志」页里，
但不是界面元素；③ 控件的结构性部件（下拉/折叠箭头、输入框清除钮、表格排序箭头）。

### 二、配色收敛为两套中性灰阶主题

`简约白`（浅）／`高级灰`（深），侧栏底部一行切换，选择存 `localStorage`。

| 决定 | 理由 |
|---|---|
| **主色位改中性灰** | naive-ui 默认主色是**绿色**、原设计的品牌字是**青绿 `#63e2b7`** —— 都是"颜色"，与「简单些」相悖。主按钮/开关激活/进度条/勾选框统一吃这一个值 |
| 白主题**页底不是纯白**（`#f4f4f5`） | 卡片本身是白的，两者同色就只能靠 1px 分线撑层次，整页发「糊」。压一档浅灰后层次为「页底 < 侧栏 < 卡片」，且仍是白为主 |
| 语义色**降饱和**而非去掉 | 这是运维工具，「运行中 / 出错」必须一眼可辨，全部灰化会导致误读。故它们只出现在徽章与告警这类**小面积**上，底色观感仍是「白 + 灰」 |
| **色值只定义一份** | `src/theme/index.ts` 的 `Palette` 同时喂 naive-ui 的 `themeOverrides` 与 `--na-*` CSS 变量（`App.vue` 运行期注入）。两处各写一份，换主题时会**一半新一半旧且不报错、类型也抓不到** |
| 主题**只存 `localStorage`**，不落 Rust settings | Rust 那套 `Settings` 是给「仅服务模式」（无窗口、常驻托盘）也要生效的偏好用的；主题是纯图形偏好，**没有窗口时毫无意义**。为一件纯前端的事去动 Rust 命令面与契约守卫不划算 |

清掉散在 **8 个文件**里的 **17 处写死色值**（日志三流着色、代码块/预览底色、节点选中边框、历史悬停…），
全部改为 `var(--na-*)`。复扫后自定义样式里的硬编码色为 **0**。

**首帧防闪**：`index.html` 内联一小段脚本，在 Vue 接管前先把上次主题的底色刷上
（否则「高级灰」用户每次启动都会看到一帧刺眼的白）。
此处**刻意重复了 2 个底色值**，已在 `index.html` 与 `theme/index.ts` 两处注明「改底色时同步」——
因为在它执行之前没有任何模块可依赖。除此之外全应用再无第二份色值。

### 本轮验证记录

| 条目 | 结果 |
|---|---|
| `cargo check --all-targets` | ✅ 0 错 0 警 |
| `cargo test --lib` | ✅ **10/10**（含真起 node 子进程：启动/日志/停止/崩溃自愈/重复启动拒绝） |
| `cargo clippy --all-targets -- -D warnings` | ✅ 0 警告 |
| `npx vue-tsc --noEmit` | ✅ 通过 |
| `node tests/unit/console-commands.test.mjs` | ✅ 8/8（三条注入故障均验证会红） |
| `pnpm test:unit` | ✅ **282/282**（274 → 282） |
| `node scripts/prepare-console.mjs` | ✅ agent.mjs 1059 KB ＋ Node 运行时 86.3 MB ＝ 87.6 MB |
| `node apps/console/scripts/verify-bundle.mjs --runtime` | ✅ 打包内 node 真跑起打包内 sidecar（`agent.mjs` 语法解析通过） |

### ⚠️ 仍需图形环境人工验证的部分

沙箱内无法运行图形应用，故以下**只做了代码级与产物级验证，未实点**：

| 待验 | 怎么验 |
|---|---|
| 托盘图标 / 菜单 / 左键唤出 | 打开打包后的 `.app`，点图标与菜单项 |
| 关窗 → 最小化到托盘（不退出） | 点窗口关闭按钮，确认进程仍在、图标仍在 |
| 界面点「启动/停止/重启」 | 点三按钮，看状态与日志是否实时变化 |
| 开机自启实际生效 | macOS：登出再登入 / 重启；Windows：重启后看计划任务 |
| 黑窗是否真的没有 | **全程盯着屏幕操作一遍**（这条只能靠眼睛） |

> 仅供技术参考，不构成任何投资建议。
