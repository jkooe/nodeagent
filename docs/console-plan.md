# nodeagent 大前端开发方案（桌面操作台）

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
