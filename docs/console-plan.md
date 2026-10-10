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
| 打包体积 | 单端安装包 | Mac `.app` < 30MB / Win 安装包 < 40MB |
| 双端编译 | `pnpm build` 一次产出两端 | 100% |

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

### ⚠️ 两处已知待办（本轮未做，均需真机/图形环境）

1. **Node 运行时随包分发**：sidecar 是 `.mjs`，目标机器需有 Node。开发期用系统 node
   （`resolve_node` 会回退到 PATH）；**分发给他人时**需把 Node 运行时作为 resource 打进包。
   计划：写 `scripts/prepare-console.mjs` 下载对应平台 node 到 `src-tauri/resources/`，
   并在打包时用 `tauri build --config` 注入 `bundle.resources` 的 node 项
   （**不能写死在默认 conf 里** —— `tauri-build` 会在编译期校验文件存在性，
   声明未下载的文件会让 `cargo check/test` 直接失败，本轮已踩并修复）。
2. **GUI 端到端人工验证**：开窗口 → 连接被控端 → 操作界面。
   沙箱无法运行图形应用，故本轮的验证止于 `cargo test`（真跑 sidecar）+ 单测/构建全绿。

### 一个易踩的构建约束（本轮 CI 失败后查明）

`tauri-build`（build.rs）会**在编译期校验** `tauri.conf.json` 里 `bundle.resources`
声明的每个文件是否存在。因此：
- 只声明**构建期必会生成**的产物（如 `sidecar.mjs`，由 beforeBuildCommand 产出）
- CI 里在 clippy/test **之前**必须先生成它，否则 build.rs 阶段就失败
- 本地复现：删掉 `sidecar/dist/` → `cargo check` 报 "failed to run custom build command" ✓
