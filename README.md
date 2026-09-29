# nodeagent

> **让 Mac 上的 AI 接管 Windows** —— 跨机能力框架：装软件、查状态、截屏、操作键鼠、传文件，如同操作同一台电脑。

## 这是什么

nodeagent 把一台 Windows 机器的能力**标准化成一组可授权、可审计的能力**，让 Mac 上的 AI（WorkBuddy）按需调用。

它**不是远程桌面**，而是「能力层」：

| 特性 | 含义 |
|---|---|
| **结构化** | 每项能力都有明确的参数 schema 与返回结构，AI 无需猜命令行 |
| **可授权** | 零信任模式下按调用方 × 按能力精细授权，默认拒绝 |
| **可审计** | 谁在何时调了什么、结果如何、耗时多少，全部本地留痕 |
| **可穿透** | 局域网直连 / 自动发现 / 经 Hub 中转跨网段与公网 |
| **零依赖部署** | 被控端只需 Node.js，全部能力用原生 API 实现，无原生模块编译 |

## 能力总览

| 分组 | 能力 | 说明 |
|---|---|---|
| **系统** | `system.info` · `system.status` · `system.process.list` · `system.service.list` · `system.shell.exec` · `system.audit.list` · `system.audit.verify` | 信息 / 资源 / 进程 / 服务 / 命令 / 审计 / **审计防篡改校验** |
| **自持** | `system.agent.restart` | **受控重启自身**（配置变更后让它生效，不会失联） |
| **异步任务** | `system.task.list` · `system.task.get` · `system.task.kill` | 长命令后台执行 + 增量续读 + 终止（`exec` 加 `async:true`） |
| **软件** | `app.list` · `app.install` | 已装软件（注册表 + winget）、winget 静默安装 |
| **屏幕** | `screen.info` · `screen.capture` · `screen.record` · `screen.find` | 显示器 / 截屏 / **录屏为帧序列** / **按名字找元素取坐标** |
| **窗口** | `window.list` · `window.focus` | 枚举可见窗口（精确矩形）/ 置前聚焦 |
| **文件** | `fs.list` · `fs.stat` · `fs.read` · `fs.write` | 列目录 / 元信息 / 分块读 / 原子写 |
| **输入** | `input.mouse.move` · `input.mouse.click` · `input.mouse.scroll` · `input.mouse.drag` · `input.key.type` · `input.key.press` | 键鼠控制（🔒 **默认禁用**），含**拖拽**与**按键序列/连按** |
| **剪贴板** | `clip.get` · `clip.set` | 读写文本**或图片**（PNG Base64） |
| **事件订阅** | `event.watch` · `event.unwatch` · `event.list` · `event.poll` | 文件变动 / 进程启停 / 端口开闭，**主动推送**（无需轮询） |

**35 项能力** · **31 个 MCP 工具** · **89 项单元测试** · **21 项端到端用例**（CI 在真实 Windows 上验证）

> 关键里程碑：**GUI 语义**（`window.list` + `screen.find`，UIA 找不到自动降级 OCR）
> 让 AI 从「看得到画面但读不懂界面」变成「按名字取坐标点下去」。

## 快速开始

### 0. 构建

```bash
pnpm install
pnpm build
```

### 1. Windows 侧（被控端）

**方式 A：安装包（推荐，免装 Node.js）**

1. 在控制端构建安装包（**需在项目目录执行**）：

   ```bash
   cd <项目目录>            # 例如 ~/WorkBuddy/NodeAgent/nodeagent
   pnpm pack:win

   # 或从任意目录调用：
   node <项目目录>/scripts/pack.mjs
   ```

   产物：`release/nodeagent-win-x64.zip`（约 32MB）

2. 把 zip 拷到 Windows 并解压
3. 右键以**管理员**运行其中的 `install.ps1`

安装脚本会使用**包内自带的 Node.js 运行时**，自动：生成预共享密钥 → 写配置 → 放行防火墙 → 注册开机自启 → 启动 Agent，并打印**密钥**与**连接命令**。

**两种运行模式（重要）**

| 模式 | 命令 | 登录/注销 | 能力范围 |
|---|---|---|---|
| 交互（默认） | `install.ps1` | 登录时启动；**注销即停** | 全部能力，**含 GUI**（截屏 / UIA 找元素 / 键鼠注入） |
| 无人值守 | `install.ps1 -Unattended -AtStartup` | **注销、重启后仍运行**（S4U，无需存密码） | 无 GUI —— 截屏/输入类能力不可用（进程在非交互会话，没有桌面） |

> 这是 Windows 的固有限制：**图形操作必须有交互桌面**。需要 GUI 就保持登录（可锁屏）；
> 只需跑命令/传文件/查状态这类无人值守场景，用 `-Unattended` 更稳。

**方式 B：开发模式（本仓库）**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

### 2. Mac 侧（控制端）

> Mac 作为控制端，**不需要**上面的 Windows 安装包；只需本机 Node.js 22+（`brew install node`）。

**方式 A：装成全局命令（推荐，随处可用）**

```bash
cd <项目目录>
pnpm pack:mac                        # 打包为单文件（约 1MB，免 node_modules）
bash scripts/install-macos.sh        # 安装到 ~/.local/bin 并打印 MCP 配置
```

装好后命令行直接可用：

```bash
nodeagent discover --wait 5          # 局域网内有哪些 Windows（免手抄 IP）
nodeagent connect 192.168.1.100 --key <密钥> --insecure --name win_a
nodeagent info
```

**方式 B：仓库内直接调用（开发调试）**

```bash
node apps/cli/dist/index.js discover --wait 5
node apps/cli/dist/index.js info
```

**常用命令**

```bash
nodeagent info | status | ps | services              # 系统与资源
nodeagent exec "Get-Service Spooler"                 # 执行命令
nodeagent install Microsoft.VisualStudioCode         # 装软件
nodeagent apps                                       # 已安装软件
nodeagent screen                                     # 显示器信息
nodeagent screenshot --out s.jpg --scale 0.5         # 截屏
nodeagent ls "C:\Users\me\Desktop" --recursive       # 列目录
nodeagent pull "C:\big.iso" --out ./big.iso          # 下载（大文件自动分块）
```

> 完整命令见下方「命令速查」。

### 3. 接入 AI（MCP）

在 `~/.workbuddy/mcp.json` 中加入：

```json
{
  "mcpServers": {
    "nodeagent": {
      "command": "node",
      "args": ["/绝对路径/nodeagent/apps/mcp/dist/index.js"]
    }
  }
}
```

之后即可用自然语言调度，例如：

- 「看看 Windows 内存够不够」
- 「Windows 上装个 VSCode」
- 「截个图看看当前画面」
- 「最近谁在操作这台 Windows」

## 架构

```
┌────────────────────┐                          ┌────────────────────┐
│  控制端 (macOS)     │ ◄──── JSON-RPC 2.0 ────► │  被控端 (Windows)   │
│  CLI · MCP Server  │        over WebSocket    │  Agent（开机自启）  │
└────────────────────┘                          └────────────────────┘
         │                                                │
         └──────────── 三种链路可选 ──────────────────────┘
          ① 局域网直连     ② UDP 广播自动发现     ③ Hub 中转（跨网段/公网）
```

| 层 | 内容 |
|---|---|
| 协议 | JSON-RPC 2.0 over WebSocket，握手 `hello → challenge → auth → auth_ok` |
| 鉴权 | `psk`（HMAC 挑战-应答，默认）或 `ed25519`（签名挑战-应答） |
| 授权 | 能力级 ACL：`deny` → `allow` → 默认拒绝 |
| 审计 | JSONL 落盘 + 轮转 + 参数脱敏 + 查询能力 |
| 传输 | TLS（自签证书可用 `--insecure` 跳过校验，鉴权另有保障） |

## 安全模型

三层防护，逐层收窄权限：

| 层 | 机制 | 解决什么 |
|---|---|---|
| **认证** | `psk` / `ed25519` 挑战-应答 | 只有持有凭据的人能接入 |
| **授权** | 能力级 ACL（默认拒绝）、`allow_input` 高危开关 | 接入了也不代表什么都能做 |
| **审计** | 操作留痕 + 调用限速 | 做过什么可追溯、异常频率可拦截 |

### 启用零信任（Ed25519 + ACL）

```bash
# 1. Mac 侧生成密钥对（私钥 600 权限落盘，永不外传），并打印被控端 ACL 片段
node apps/cli/dist/index.js keygen --id mac_01

# 2. 把打印的片段加入被控端 agent.json 的 acl.clients，并设 "auth_mode": "ed25519"
#    { "client_id": "mac_01", "pubkey": "...", "allow": ["system.*", "screen.*"], "deny": ["input.*"] }

# 3. 以零信任模式连接（无需预共享密钥）
node apps/cli/dist/index.js connect 192.168.1.100 --port 8765 --auth-mode ed25519 --insecure
```

握手后 CLI 会展示**授权矩阵**（🟢 已授权 / 🚫 未授权），调用未授权能力返回 `E_ACL_DENIED`。

### 其他安全默认

- 输入控制（键鼠）默认禁用，需被控端显式 `"allow_input": true`
- 私钥不落明文：macOS 存 Keychain、Windows 存 DPAPI（老版本明文密钥首次加载自动迁移）
- 审计日志**链式哈希**（`prev`/`hash`），`nodeagent audit verify` 可检出篡改与删除
- ACL 支持 IP 白/黑名单（CIDR）、生效时段（含跨零点）、**按能力限速**（精确 > glob > 全局）
- `input.*`（键鼠控制）**默认禁用**，需被控端 `"allow_input": true` 或 `install.ps1 -AllowInput`
- 键盘文本经 Base64 传参、PowerShell 侧解码，**杜绝内容注入**；按键名走白名单映射
- 文件能力支持 `fs_roots` 路径白名单，越界返回 `E_ACL_DENIED`
- 私钥 / 预共享密钥不明文外传、不写日志；审计中敏感字段自动替换为 `***`

## 命令速查

### 连接与设备

```bash
nodeagent discover --wait 5                        # 局域网发现（UDP 广播）
nodeagent connect <host> --key <K> --name win_a    # 连接并命名（自签证书加 --insecure）
nodeagent nodes                                    # 列出设备（● 标记当前）
nodeagent use win_a                                # 切换默认设备
nodeagent remove win_a                             # 移除设备
nodeagent info --node win_b                        # 临时指定目标（不改 current）
```

### 系统与软件

```bash
nodeagent info | status | ps [--limit 20] | services [--limit 20]
nodeagent exec "<命令>"                             # 执行命令，返回退出码与输出
nodeagent apps                                      # 已安装软件
nodeagent install <包名|ID>                          # winget 静默安装
nodeagent list                                      # 被控端能力清单（含授权矩阵）
```

### 图形与文件

```bash
nodeagent screen                                    # 显示器信息
nodeagent screenshot --out s.jpg [--scale 0.5] [--region x,y,w,h]
nodeagent mouse move <x> <y> [--duration 300]
nodeagent mouse click [<x> <y>] [--button left|right|middle]
nodeagent key type "<文本>" | key press ctrl c

nodeagent ls <远端路径> [--recursive] [--pattern "*.log"]
nodeagent stat <远端路径> | cat <远端路径> [--out 本地文件]
nodeagent pull <远端路径> [--out 本地文件]           # 下载（自动分块 + 原子落盘）
nodeagent push <本地文件> <远端路径> [--create-dirs]  # 上传（自动分块）
```

### 审计与密钥

```bash
nodeagent audit [--limit 20] [--type invoke|auth|acl|agent] [--client-id X] [--since <ms>]
nodeagent audit verify                              # 校验审计链完整性（防篡改检测）
nodeagent keygen [--id mac_01]                      # 生成 Ed25519 密钥 + ACL 配置片段（私钥入系统钥匙串）
```

### 自持与运维

```bash
nodeagent restart [--delay 2000]                    # 受控重启被控端（配置变更后让它生效）
nodeagent deploy <agent.mjs> [--path <远端路径>]     # 一键升级（备份 → 上传 → 重启 → 复验）
nodeagent daemon [start|stop|status]                # 常驻连接池（批量操作省去每次握手）
nodeagent fanout <能力名> [--nodes a,b] [--args JSON] # 多设备并发下发并汇总
```

### 长任务与剪贴板

```bash
nodeagent bg "<命令>" [--timeout-ms N]               # 后台执行，立即返回 task_id
nodeagent tasks | nodeagent task <id> [--offset N] [--kill]   # 列出 / 增量读 / 终止
nodeagent clip [--set "文本"] [--out <路径>] [--image-file <路径>]  # 剪贴板文本或图片
nodeagent record [--duration 5000] [--fps 2] [--region x,y,w,h]     # 录屏为帧序列
```

### 事件订阅与宏

```bash
nodeagent events --kind file --path C:\logs --seconds 20   # 实时接收文件变动推送
nodeagent events --kind process --pattern chrome*            # 进程启停
nodeagent events                                              # 列出当前订阅
nodeagent macro init demo.json                               # 生成示例宏
nodeagent macro run demo.json --var STAMP=hello               # 回放（逐步校验）
nodeagent macro validate demo.json                            # 仅校验文件
nodeagent group add 办公机 win_a,win_b                        # 设备分组
nodeagent fanout system.info --nodes @办公机                  # 按组并发下发
```

### GUI 语义（找到元素再点，不猜坐标）

```bash
nodeagent invoke window.list --args '{"title_pattern":"记事本"}'
nodeagent invoke window.focus --args '{"title":"记事本"}'
nodeagent invoke screen.find --args '{"text":"一键加速","method":"auto"}'  # UIA → OCR 兜底
nodeagent mouse drag 300 200 700 500                # 拖拽（拖文件/框选）
```

## MCP 工具

| 工具 | 说明 |
|---|---|
| `na_system_info` · `na_status` · `na_process_list` · `na_service_list` | 系统信息与状态 |
| `na_exec` · `na_bg` · `na_task` | 执行命令、后台长任务（启动/续读/终止） |
| `na_install` · `na_app_list` | 装软件、列软件 |
| `na_screenshot` · `na_record` | 截屏（直接返回图片给 AI 看）、录屏为帧序列 |
| `na_window_list` · `na_window_focus` · `na_screen_find` | **GUI 语义**：列窗口 / 聚焦 / 按名字取坐标（UIA+OCR） |
| `na_mouse` · `na_key` | 键鼠控制（含拖拽、按键序列；需被控端开启） |
| `na_clip` | 读写剪贴板文本或图片 |
| `na_fs_list` · `na_fs_read` · `na_fs_write` · `na_fs_stat` | 读目录 / 读文件 / 写文件 / 元信息 |
| `na_restart` | 受控重启被控端 |
| `na_audit` · `na_discover` · `na_nodes` · `na_use` | 查审计、发现设备、多设备切换 |
| `na_event_watch` · `na_event_poll` · `na_event_list` · `na_event_unwatch` | 事件订阅与增量拉取 |
| `na_macro_run` | 回放 GUI 宏（步骤序列，逐步校验） |

## Hub 中转（跨网段 / 公网）

被控端与 Mac 不在同一局域网时，用 Hub 中转：

```
Mac ──► Hub（VPS / 公网）──► Windows（NAT 后也可）
           ↑ 只透传，不解密
```

```bash
# 1) VPS 上启动 Hub（首次启动自动生成令牌，存于 ~/.nodeagent/hub.json）
node apps/hub/dist/index.js

# 2) 被控端 agent.json 增加 —— agent 会主动外连注册，免公网 IP、免入站放行
#    "hub": { "enabled": true, "url": "wss://hub.example.com/hub/agent", "token": "<Hub 令牌>" }

# 3) Mac 侧经 Hub 接入
node apps/cli/dist/index.js connect hub.example.com --port 443 --hub-token <Hub 令牌> \
     --hub-node win_01 --key <设备密钥> --name win_01
```

**并发多控制端**：Hub 为每个被控端维护**槽位池**（`max_slots_per_node`，默认 3），
被控端侧常备 2 条连接（`hub.warm_slots`）并在被占用时自动扩容 —— 因此
「AI + 人同时在线」不再互斥（旧版是独占，会返回 `E_NODE_BUSY`）。

**Hub 侧访问控制（v12）**：可配置多令牌，每个令牌独立指定能访问哪些设备：

```json
{
  "token": "<主令牌，放行全部>",
  "node_allowlist": ["win_*"],
  "tokens": [
    { "value": "ci-token",    "name": "ci",    "allow_nodes": ["win_build_*"] },
    { "value": "guest-token", "name": "guest", "allow_nodes": ["*"], "deny_nodes": ["win_prod"] },
    { "value": "roll-*",      "name": "rolling", "allow_nodes": ["win_a"] }
  ]
}
```

- 判定顺序 **deny → allow → 默认拒绝**；`node_allowlist` 非空时只有匹配的 node_id 能注册
- `value` 以 `*` 结尾表示**前缀匹配**（便于令牌轮换期间灰度）
- 设备列表按身份过滤（控制端只看得到自己被授权的设备），越权接入返回 `E_NODE_FORBIDDEN`
- **职责边界**：Hub 只做「能否连到某设备」的接入过滤；连上之后的**能力级**授权
  仍由被控端 ACL 按 client_id 裁决 —— 两层独立，Hub 不参与能力决策

**安全边界**：Hub **只做字节透传**，不解析内容、不持有设备密钥 —— 控制端与被控端之间仍执行端到端握手，因此 **Hub 无法窃听也无法伪造**（Hub 被攻陷也不等于设备被接管）。生产环境建议在 Hub 前挂 Caddy / Nginx 终止 TLS。

## 开发

```bash
pnpm build        # 构建全部包
pnpm typecheck    # 类型检查
pnpm test:unit    # 单元测试（89 项：协议纯函数 / 清单守护 / 审计链 / ACL / 宏引擎 / 设备分组 / Hub 授权）
pnpm test:e2e     # 端到端测试（21 项，含 TLS / 零信任 / 发现 / 文件 / Hub）
pnpm test:windows # Windows 专属能力（服务 / 软件 / winget 真实装软件）
pnpm verify       # 对已配置的被控端跑全套验收并输出报告
```

### 三层自动化真机验证

无需手工点测：

| 层次 | 方式 | 覆盖 |
|---|---|---|
| **CI（推荐）** | GitHub Actions `windows-latest` | 真实 Windows 上跑协议 E2E、专属能力（`Get-Service` / 注册表 / winget 装软件）、`install.ps1` 链路、CLI 连入、MCP 工具列表 |
| **远程验收** | `node scripts/verify.mjs --host <IP> --key <密钥> [--insecure]` | 逐条验收并输出终端报告（`--report report.md`） |
| **本地测试** | `pnpm test:e2e` / `pnpm test:windows` | 单机自举：本机起 Agent 当被控端自测 |

工作流见 [`.github/workflows/windows-e2e.yml`](./.github/workflows/windows-e2e.yml)，push 到 `main` 或手动触发即运行。

```bash
# 对自己真实的 Windows 机器验收（含真实装软件）
node scripts/verify.mjs --host 192.168.1.100 --port 8765 --key <密钥> --insecure \
     --with-install jqlang.jq --report verify-report.md
```

**成本**：②③ 完全免费（本机运行）；① 走 GitHub Actions 免费额度 —— 单次约 5 分钟，按 Windows 2x 计约 10 计费分钟，Free 账户每月约可跑 200 次。默认支出限额为 `$0`，额度用尽只会停跑、**不会自动扣费**。

### 工程结构

```
nodeagent/
├── packages/
│   ├── protocol/          # 协议定义：信封 / 方法 / 错误码 / 能力 schema / 校验 / HMAC / Ed25519 / ACL
│   └── client/            # 控制端库：连接、握手、调用、超时、重连、密钥、发现
├── apps/
│   ├── agent/             # Windows 被控端：监听或 Hub 外连、认证、授权、审计、能力分发
│   ├── hub/               # 中转节点：设备注册、控制端配对、字节透传（跨网段/公网）
│   ├── cli/               # macOS 控制端 CLI
│   └── mcp/               # MCP server（接入 WorkBuddy）
├── scripts/               # install.ps1 / uninstall.ps1 / verify.mjs
├── tests/e2e/             # 端到端测试
├── docs/                  # 开发文档
├── PRD.md                 # 产品需求文档
└── README.md
```

## 路线图

| 阶段 | 目标 | 状态 |
|---|---|---|
| **v1** | 命令级接管 + 装软件 + 查状态 + 基本鉴权 + CLI + MCP | ✅ |
| **v2** | 图形接管（`screen.*` 截屏 + `input.*` 键鼠）+ 输入控制开关 | ✅ |
| **v3** | 零信任：Ed25519 身份认证 + 能力级 ACL | ✅ |
| **v3+** | 审计日志（留痕 + 查询）+ 调用限速 | ✅ |
| **v4** | 无感体验：局域网自动发现 + 断线自动重连 | ✅ |
| **v5** | 多设备管理 + 文件传输（分块 / 大文件 / 原子写） | ✅ |
| **v6** | Hub 中转：跨网段 / 公网接入（被控端主动外连，穿 NAT） | ✅ |
| **v7** | **自持**：受控重启（配置变更后让自身生效，不再丢连接） | ✅ |
| **v8** | **GUI 语义**：`window.list` / `window.focus` / `screen.find`（UIA 按名取坐标） | ✅ |
| **v9** | `screen.find` **OCR 兜底**（自绘 UI 也能定位）+ MCP 工具同步 | ✅ |
| **v10** | **长任务异步化**（`system.task.*`）+ 剪贴板 + CLI 常驻连接池 daemon | ✅ |
| **v11** | **安全加固**：私钥入系统密钥库（Keychain/DPAPI）+ 审计链防篡改 + ACL 细化（IP/时段/按能力限速） | ✅ |
| **v11+** | **操作面补完**：鼠标拖拽 / 录屏 / 剪贴板图片 / 多设备并发 / 一键升级 | ✅ |
| **v12** | **事件订阅**（file/process/net 主动推送）+ **GUI 宏**（步骤序列回放）+ **Hub 并发多控制端** + 设备分组 | ✅ |
| **v12.1** | **Hub 侧按控制端授权**（多令牌 + 按设备白/黑名单 + 注册准入） | ✅ |
| **待办** | v7~v12 能力入 CI（需 workflow scope 才能推 CI 改动）、macOS 端 GUI 能力对齐、事件订阅推给 MCP 客户端（当前为缓冲拉取） | 🚧 |

## 文档

- [产品需求文档（PRD）](./PRD.md)
- [开发文档（DEVELOPMENT）](./docs/DEVELOPMENT.md) —— 协议细节、能力 schema、安全模型、各端实现指南
- [**跨机接管的边界与局限**](./docs/REMOTE-LIMITS.md) —— 哪些问题能远程修、哪些必须人工，附真实故障诊断案例
- [**实战复盘：短板与改进优先级**](./docs/RETROSPECTIVE.md) —— 基于真机使用的短板分析（GUI 语义 / 编码 / 自愈 / 可观测性）

## 关键决策

| 决策点 | 结论 |
|---|---|
| 拓扑 | 局域网点对点直连为主；跨网段时经 Hub 中转（Hub 仅透传，端到端安全不受影响） |
| 安全演进 | 先简化（预共享密钥 + HMAC）→ 后强化（Ed25519 + 能力级 ACL + 审计） |
| AI 接入 | 核心能力 → CLI（调试底座）→ MCP（AI 落点） |
| 装软件 | 优先 winget 静默安装 |
| Windows 部署 | 一键 `install.ps1` + 开机自启 |
| 依赖策略 | 被控端零原生编译；能力全部基于系统原生 API 实现 |
