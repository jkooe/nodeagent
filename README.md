# nodeagent

> **跨机 AI 接管框架** —— 让 MacBook 上的 AI 无缝接管 Windows，装软件、查状态，如同操作同一台电脑

## 这是什么

nodeagent 让 Mac 上的 AI（WorkBuddy）通过统一协议接管局域网内的 Windows 机器——执行命令、装软件、查状态。

**核心不是「远程控制」，而是把被控端能力标准化、可授权、可被 AI 调用。**

## 当前状态

🟢 **v1 已实现**（命令级接管）—— Mac 控制端 + Windows 被控端点对点直连，握手鉴权、7 项能力、CLI、MCP 全部打通。

## 架构

```
┌──────────────────────┐        wss:// (TLS 1.3)        ┌──────────────────────┐
│  控制端 (macOS)       │ ◄────────────────────────────► │  被控端 (Windows)     │
│  CLI · MCP Server    │        局域网点对点直连          │  Agent（开机自启）    │
└──────────────────────┘                                └──────────────────────┘
```

| 层 | 内容 |
|---|---|
| 协议 | JSON-RPC 2.0 over WebSocket，握手 `hello → challenge → auth → auth_ok` |
| 鉴权 | 预共享密钥 + HMAC-SHA256 挑战-应答（防重放） |
| 能力 | `system.*`(5) + `app.*`(2) + `screen.*`(2) + `input.*`(5，**默认禁用**) |
| 接入 | CLI（调试底座）+ MCP（AI 落点） |

## 快速开始

### 0. 构建

```bash
pnpm install
pnpm build
```

### 1. Windows 被控端

在 Windows 上（**管理员权限**）运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

脚本会：生成预共享密钥 → 写配置 → 放行防火墙端口 → 注册开机自启任务 → 启动 Agent，并打印**密钥**与**连接命令**。

### 2. Mac 控制端

```bash
# 连接被控端（首次需 --key <密钥>；自签证书需加 --insecure）
node apps/cli/dist/index.js connect 192.168.1.100 --port 8765 --key <密钥> --insecure

# 常用命令
node apps/cli/dist/index.js status                  # 资源状态（CPU/内存/磁盘/网络）
node apps/cli/dist/index.js info                    # 系统信息
node apps/cli/dist/index.js exec "Get-Service Spooler"
node apps/cli/dist/index.js install Microsoft.VisualStudioCode
node apps/cli/dist/index.js apps                    # 已安装软件
node apps/cli/dist/index.js list                    # 被控端可用能力

# 图形接管（v2）
node apps/cli/dist/index.js screen                  # 显示器信息
node apps/cli/dist/index.js screenshot --out s.jpg --scale 0.5   # 截屏存盘
node apps/cli/dist/index.js mouse move 500 300      # 移动鼠标（需被控端开 allow_input）
node apps/cli/dist/index.js mouse click 500 300
node apps/cli/dist/index.js key type "hello world"  # 输入文本
node apps/cli/dist/index.js key press ctrl s        # 组合键
```

### 3. 接入 WorkBuddy（MCP）

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

随后即可用自然语言调度，例如「Windows 上装个 VSCode」「看看 Windows 内存够不够」。

MCP 工具：`na_status` · `na_system_info` · `na_exec` · `na_install` · `na_app_list` · `na_process_list` · `na_service_list` · **`na_screenshot`**（直接返回图片）· **`na_mouse`** · **`na_key`**

## 开发

```bash
pnpm build        # 构建全部包
pnpm typecheck    # 类型检查
pnpm test:e2e     # 端到端测试（本机起 Agent，跑通握手 + 能力调用 + 异常路径）
pnpm test:windows # Windows 专属能力测试（服务 / 软件 / winget 装软件）
pnpm verify       # 对本机配置的被控端跑全套验收并输出报告
```

## 自动化真机验证

三层验证体系，无需手工点测：

| 层次 | 方式 | 覆盖 |
|---|---|---|
| **CI（推荐）** | GitHub Actions `windows-latest` | 真实 Windows 上跑协议 E2E、Windows 专属能力（`Get-Service`/注册表/winget 装软件）、`install.ps1` 安装链路、CLI 连入、MCP 工具列表 |
| **远程验收** | `node scripts/verify.mjs --host <IP> --key <密钥> [--insecure]` | 对齐 PRD FR-01~FR-08 的逐条验收，输出终端报告 + `--report report.md` |
| **本地测试** | `pnpm test:e2e` / `pnpm test:windows` | 单机自举：起一个 Agent 当被控端，自测协议与能力 |

CI 工作流见 [`.github/workflows/windows-e2e.yml`](./.github/workflows/windows-e2e.yml)，每次 push 到 `main` 或手动触发即运行。

```bash
# 对皇上自己的 Windows 机器验收（含真实装软件）
node scripts/verify.mjs --host 192.168.1.100 --port 8765 --key <密钥> --insecure --with-install jqlang.jq --report verify-report.md
```

### 成本

三层验证里 **②③ 完全免费**（本机运行），**① 走 GitHub Actions 免费额度**：

| 账户 | 免费额度（Linux 等效分钟/月） | 实际可用 Windows 分钟（2x 计费） |
|---|---|---|
| Free | 2,000 | ≈ 1,000 |
| Pro / Team | 3,000 | ≈ 1,500 |

单次 CI 约 5 分钟（含 winget 真实下载安装），按 Windows 2x 计 ≈ 10 计费分钟/次 → **Free 账户每月约可跑 200 次**，个人项目用不完。

> 默认支出限额为 **$0**：额度用尽时作业只是停止运行，**不会自动扣费**。若想彻底无限免费，把仓库改为公开（标准 runner 对公开仓库不限量）；或改用自托管 runner（同样免费，但需自备机器）。



### 工程结构

```
nodeagent/
├── packages/
│   ├── protocol/          # 协议定义：信封 / 方法 / 错误码 / 能力 schema / 校验 / HMAC
│   └── client/            # 控制端客户端库（连接、握手、调用、超时）
├── apps/
│   ├── agent/             # Windows 被控端（监听、认证、能力分发、进程执行）
│   ├── cli/               # macOS 控制端 CLI
│   └── mcp/               # MCP server（接入 WorkBuddy）
├── scripts/               # install.ps1 / uninstall.ps1
├── tests/e2e/             # 端到端测试
├── docs/                  # 开发文档
├── PRD.md                 # 产品需求文档
└── README.md
```

## 文档

- [产品需求文档（PRD）](./PRD.md)
- [开发文档（DEVELOPMENT）](./docs/DEVELOPMENT.md)

## 路线图

| 阶段 | 目标 | 状态 |
|---|---|---|
| **v1** | 命令级接管 + 装软件 + 查状态 + 基本鉴权 + CLI + MCP | ✅ 已实现 |
| **v2** | 图形接管（`screen.*` 截屏 + `input.*` 键鼠）+ 输入控制开关 | 🟡 开发中（能力已就绪） |
| **v3** | 无感体验 + 零信任（Ed25519 + 能力级 ACL） | 规划中 |

> **输入控制安全默认**：`input.*` 为高危能力，**默认禁用**。需在被控端 `agent.json` 设 `"allow_input": true` 重启后生效，或用 `install.ps1 -AllowInput` 安装。

## 关键决策速览

| 决策点 | 结论 |
|---|---|
| 架构拓扑 | 点对点直连（Mac ↔ Windows，无中枢） |
| 端 | Mac + Windows 同时 |
| 安全 | 先简化（预共享密钥 + HMAC）→ 后强化（Ed25519 + ACL） |
| AI 接入 | 核心能力 → CLI → MCP |
| 装软件 | 优先 winget 静默安装 |
| Windows 部署 | 一键 `install.ps1` + 开机自启 |

## 安全说明

- v1 采用**预共享密钥 + HMAC 挑战-应答**鉴权，密钥不明文外传、不写日志
- 传输层支持 TLS（自签证书）；TLS 默认开启，控制端可用 `--insecure` 跳过证书校验（鉴权仍由 HMAC 保障）
- **v1 简化**：预共享密钥存于本机 600 权限配置文件，v2 将升级为 OS 密钥链（Keychain / DPAPI）
