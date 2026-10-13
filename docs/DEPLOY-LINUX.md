# Linux 被控端部署（Debian 12 / Ubuntu / NAS 系统等 systemd 系统）

> 适用：把一台 Linux 机器作为**被控端**，让 Mac/Linux 控制端接管。
> 本文的能力清单是 **2026-10-13 在 Debian 12 容器里实测**得出的，不是推测。

---

## 0. 一句话

Linux 被控端 = **命令 / 状态 / 文件 / 审计**（服务器型用途）；
**没有 GUI 能力**（截图、键鼠、窗口、剪贴板、音量均为 Windows/macOS 实现，
Linux 端未实现 —— 调用会明确返回 `E_UNSUPPORTED_PLATFORM`，不假装可用）。

---

## 1. 快速开始（以 NAS 设备为例）

```bash
# ① 把仓库放到 NAS 上（任选其一）
#    - git clone https://github.com/jkooe/nodeagent.git
#    - 或从控制端 scp 整个目录过去

# ② 生成被控端载荷（在**控制端**或任意有 Node 22+ 的机器上执行一次）
node scripts/pack.mjs                       # → release/agent.mjs

# ③ 在 NAS 上执行安装（需要 sudo；会自动注册 systemd 服务并开机自启）
cd nodeagent
sudo bash scripts/install-linux.sh --node-id nas-01

# ④ 抄下屏幕上打印的「密钥」与「连接命令」，回控制端执行：
#    nodeagent connect <NAS的IP> --port 8765 --key <密钥> --insecure
```

**装完即自启**：`systemctl status nodeagent` 应为 `active (running)`；
重启 NAS 后也会自动拉起（`systemctl is-enabled nodeagent` → `enabled`）。

### 三种安装模式

| 模式 | 命令 | 程序目录 | 自启方式 | 适用 |
|---|---|---|---|---|
| **系统级**（默认） | `sudo bash scripts/install-linux.sh` | `/opt/nodeagent` | 系统 systemd（`multi-user.target`） | NAS / 服务器，需 sudo |
| **用户级** | `bash scripts/install-linux.sh --user` | `~/.local/share/nodeagent` | 用户 systemd + `linger` | 无 sudo 的场景 |
| **不注册服务** | `sudo bash scripts/install-linux.sh --no-service` | 同上（按模式定） | 自行安排（supervisor / cron `@reboot` / nohup） | systemd 受限的系统 |

其他参数：`--port 8765`、`--allow-input`（**Linux 上无实际输入能力**，仅留存配置）、
`--uninstall [--purge]`。

---

## 2. 运行依赖（脚本会自动处理能处理的）

| 依赖 | 是否必需 | 说明 |
|---|---|---|
| **Node ≥ 22** | 必需 | 脚本优先用系统 Node；**没有就自动下载** `node-v22.x-linux-<arch>` 到 `<安装目录>/runtime/`（用 npmmirror，国内快）。NAS 上通常没有 Node → 走自动下载 ✓ |
| **systemd** | 默认必需 | 用于开机自启。没有就加 `--no-service`（脚本会给出替代启动命令） |
| **bash** | 必需 | 安装脚本与部分能力用它。**Alpine 等只有 busybox 的系统需先装 bash**（`apk add bash`） |
| **procps（`ps`）** | **`system.process.list` 需要** | Debian/Ubuntu 自带 ✓；**精简容器镜像（如 `node:*-slim`）默认没有** → 表现为「进程列表为空」。装：`apt-get install -y procps` |
| **iproute2（`ip`）** | 可选 | 仅用于安装时显示本机 IP；缺失时脚本回退 `hostname -I` / `ifconfig`，再不行显示占位符 ✓ |
| **curl 或 wget** | 下载运行时时需要 | 若已装 Node 22+ 则不需要 |

> ⚠️ 实测踩到的坑：在 **Alpine** 容器里测会看到 `spawn /bin/bash ENOENT`，
> 极易误判成「Linux 不支持」——**实际是镜像没有 bash**。
> 同理 `node:22-slim` 里 `process.list` 返回空是**没有 procps**，不是代码问题。

---

## 3. Linux 上真实可用的能力（实测）

在同一台（Debian 12）机器上跑 `node scripts/verify.mjs` 的结果：

| 能力 | Linux | 说明 |
|---|---|---|
| `system.info` | ✅ | 返回 OS 名 "Linux"、CPU 核数、主机名 |
| `system.status` | ✅ | CPU / 内存 / 磁盘（多磁盘正常识别） |
| `system.process.list` | ✅** | 需 `procps`；缺则返回空列表 |
| `system.shell.exec` | ✅ | 含非零退出码回传、**超时强制终止**（实测 exit=124） |
| `system.service.list` | ⚠️ | Windows 服务概念，Linux 上退化为 systemd 单元（部分可用） |
| `system.audit.list` / 审计链 | ✅ | 与平台无关 |
| `system.task.*` | ✅ | 异步长任务框架 |
| `fs.*`（list/read/write/stat） | ✅ | 路径按 POSIX 语义（区分大小写） |
| `log.query` / `monitor.*` | ⚠️ 部分 | `monitor` 有 Windows 专属实现，部分子能力不可用 |
| `event.watch`（file/process/net） | ✅ | 与平台无关 |
| `system.agent.update`（自更新） | ✅ | 与平台无关 |
| `screen.*` / `input.*` / `window.*` / `clipboard.*` / `audio.*` / `record.*` | ❌ | **未实现** → 明确返回 `E_UNSUPPORTED_PLATFORM` |
| `app.list` / `app.install` | ❌ | winget 专属 → 同样明确拒绝 |

**汇总对比**：本机 macOS 15 通过/0 失败；Linux（Debian 12）**9 通过 / 1 失败（缺 procps）/ 6 跳过**（跳过的都是 GUI 类）。

---

## 4. 管理命令

```bash
# 系统级
systemctl status nodeagent
journalctl -u nodeagent -f          # 实时日志
systemctl restart nodeagent
sudo bash scripts/install-linux.sh --uninstall            # 卸载（保留配置与审计日志）
sudo bash scripts/install-linux.sh --uninstall --purge    # 连数据目录一起删

# 用户级：把上面命令里的 systemctl / journalctl 加 --user
```

**配置与数据**（`~/.nodeagent`，与 agent 侧 `agentDir()` 一致）：

| 文件 | 内容 |
|---|---|
| `agent.json` | 节点 ID / 端口 / **密钥**（权限 600）/ 认证模式 |
| `audit.log` | 审计日志（JSONL，10MB 轮转留 5 份） |
| `audit-anchors.jsonl` | 审计链锚点（启用锚定后产生） |

---

## 5. 故障排查（按实测顺序）

| 现象 | 原因 | 处理 |
|---|---|---|
| `未检测到 systemd` | 容器/非 systemd 系统 | 加 `--no-service`，或改用 supervisor |
| `spawn /bin/bash ENOENT` | **系统没有 bash**（Alpine 等） | `apk add bash` / `apt-get install -y bash` |
| `进程列表为空` | **没有 `ps`**（slim 镜像） | `apt-get install -y procps` |
| 脚本"跑到一半就没了" | `set -e` 下某个命令替换失败（如缺 `ip`） | 已在 v2.0.3+ 加固为多级回退；旧版请升级脚本 |
| 控制端连不上，被控端却显示已监听 | 防火墙 | Debian: `ufw allow 8765/tcp`；firewalld: `firewall-cmd --add-port=8765/tcp --permanent && firewall-cmd --reload` |
| `E_AUTH_FAILED` | 密钥不一致 | 以被控端 `~/.nodeagent/agent.json` 的 `key` 为准 |
| GUI 能力报 `E_UNSUPPORTED_PLATFORM` | **正常**（Linux 无 GUI 实现） | 无需处理；这是「诚实拒绝」而非故障 |

---

## 6. 建议（服务器型被控端）

1. **尽快启用审计链外部锚定** —— 把链头存到 NAS 之外（云盘/另一台机器）。
   本机锚点等于没锚：被控端被 root 后锚点也会一起被改。
   ```bash
   node scripts/anchor-audit.mjs collect --out /tmp/anchor-$(date +%Y%m%d).jsonl
   # 再把该文件上传到云盘，之后用 verify 子命令比对
   ```
2. **不要开 `--allow-input`** —— Linux 上无实际输入能力，开着只是加大配置面。
3. 若机器只有公网无内网互通，考虑用 **Hub 中转**（被控端主动外连，穿 NAT）。
