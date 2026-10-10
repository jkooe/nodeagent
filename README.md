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
| **系统** | `system.info` · `system.status` · `system.process.list` · `system.service.list` · `system.shell.exec` · `system.audit.list` · `system.audit.verify` · `system.metrics` | 信息 / 资源 / 进程 / 服务 / 命令 / 审计 / **防篡改校验** / **成功指标（PRD 2.2）** |
| **自持** | `system.agent.restart` | **受控重启自身**（配置变更后让它生效，不会失联） |
| **异步任务** | `system.task.list` · `system.task.get` · `system.task.kill` | 长命令后台执行 + 增量续读 + 终止（`exec` 加 `async:true`） |
| **软件** | `app.list` · `app.install` | 已装软件（注册表 + winget）、winget 静默安装 |
| **屏幕** | `screen.info` · `screen.capture` · `screen.record` · `screen.find` | 显示器 / 截屏 / **录屏为帧序列** / **元素定位三引擎**（UIA 控件树 → OCR 文字 → **图像模板**） |
| **窗口** | `window.list` · `window.focus` | 枚举可见窗口（精确矩形）/ 置前聚焦（**Windows + macOS**） |
| **文件** | `fs.list` · `fs.stat` · `fs.read` · `fs.write` | 列目录 / 元信息 / 分块读 / 原子写 |
| **输入** | `input.mouse.move` · `input.mouse.click` · `input.mouse.scroll` · `input.mouse.drag` · `input.key.type` · `input.key.press` | 键鼠控制（🔒 **默认禁用**），含**拖拽**、**字符串热键 / 预设 / 长按 / 后台定向投递** |
| **剪贴板** | `clip.get` · `clip.set` | 读写文本**或图片**（PNG Base64） |
| **事件订阅** | `event.watch` · `event.unwatch` · `event.list` · `event.poll` | 文件变动 / 进程启停 / 端口开闭，**主动推送**（无需轮询） |
| **GUI 等待** | `gui.await` | 等条件成立再返回（窗口/元素/进程/文件 × 出现/消失）；支持**属性谓词 `where`** 与 **`any_of` 组合** |
| **状态采样** | `log.query` · `monitor.start` · `monitor.report` · `monitor.stop` · `monitor.list` · `monitor.delete` | 日志**在被控端侧过滤**（不上传整份）/ 定时采样落盘 + **摘要回看**（断几次、最长断多久、CPU/内存值域） |
| **审计锚定** | `system.audit.head` · `system.audit.anchor` | 链头可读 + 锚点**追加**落盘，让「有 root 者整链重写」可被发现 |

## 快捷键（hotkey）控制 —— v1.5.0

`input.key.press` 支持 **4 种输入形式**（一次只用一种）：

```bash
# ① 字符串热键（最常用；分隔符支持 + - 空格，大小写不敏感）
nodeagent --node win key press "ctrl+shift+esc"
nodeagent --node win key press "win+d"                     # 显示桌面
nodeagent --node win key press "alt+tab"                   # 切换应用

# ② 热键序列
nodeagent --node win key press "ctrl+c"                    # 老形式也兼容：key press ctrl c
nodeagent --node win invoke input.key.press --args '{"hotkeys":["ctrl+c","ctrl+v"]}'

# ③ 预设语义名（约 50 个，免记键位）
nodeagent --node win key press copy                        # = ctrl+c
nodeagent --node win key press task_manager                 # = ctrl+shift+esc
nodeagent --node win key press volume_mute_toggle           # 媒体键（走 WM_APPCOMMAND）

# ④ 老数组形式
nodeagent --node win key press ctrl c
```

**按键覆盖**：字母/数字 · F1–F24 · 左右侧修饰键（`lalt`/`rctrl`/`lwin`…）·
小键盘（`numpad7`、`numpad_add`…，**与数字键分开**——Excel 靠 NumLock 区分）·
OEM 符号键（`oem_plus`/`oem_comma`/`oem_period`… → 支持 `win+d`、`ctrl++`、`win+.`）·
媒体键 · 浏览器键 · IME 键（`convert`/`kana`…）· 系统键（`sleep`/`help`…）

**进阶参数**：

| 参数 | 说明 |
|---|---|
| `hold_ms` | 长按：按下后保持 N 毫秒再释放（≤5000） |
| `route=post` + `target_pid` | **后台定向投递**：向目标进程全部顶层窗口 PostMessage（目标窗口被遮挡/最小化时用）。⚠️ 游戏与部分输入型程序不响应后台键消息 |
| `target_pid`（默认路由） | 媒体键定向（播放器常建 30+ 辅助窗口，指定 PID 投给该进程全部顶层窗口） |

**预设速查**（完整表见 `packages/protocol/src/hotkeys.ts` 的 `HOTKEY_PRESETS`）：

| 类别 | 预设名 |
|---|---|
| 编辑 | `copy` `cut` `paste` `paste_plain` `undo` `redo` `select_all` |
| 文件 | `save` `save_as` `new` `open` `close_tab` `print` |
| 窗口 | `switch_app` `task_view` `task_manager` `show_desktop` `minimize_all` `maximize` `snap_left` `snap_right` `rename` `properties` |
| 系统 | `lock_screen` `run` `explorer` `search` `settings` `clipboard_history` `emoji_picker` `screenshot` |
| 虚拟桌面 | `new_desktop` `desktop_left` `desktop_right` |
| 标签/视图 | `new_tab` `next_tab` `reopen_tab` `zoom_in` `zoom_out` `fullscreen` |
| 媒体 | `music_play_pause` `music_next` `music_prev` `volume_add` `volume_mute_toggle` |

> MCP 侧同名工具为 `na_key`（`action: "press"`），支持同一套参数。

## 等待条件 gui.await —— v1.6.0

GUI 操作从「按一下→睡几秒→截图碰运气」变成**可断言**流程：

```bash
# 等界面元素出现（最多 30s）
nodeagent --node win invoke gui.await --args '{"condition":"control","text":"完成","timeout_ms":30000}'
# 等它消失
nodeagent --node win invoke gui.await --args '{"condition":"control","text":"安装中","state":"absent"}'
# 等窗口 / 进程 / 文件
nodeagent --node win invoke gui.await --args '{"condition":"window","title":"安装程序","timeout_ms":10000}'
nodeagent --node win invoke gui.await --args '{"condition":"process","process":"setup.exe"}'
nodeagent --node win invoke gui.await --args '{"condition":"file","path":"C:\\log.txt"}'
```

四类条件各自复用 `window.list` / `screen.find` / `process.list` / `fs.stat`，
平台行为（Windows UIA/OCR、macOS Vision OCR）与那些能力完全一致，**只读低危**。
轮询期单次异常不视为失败（启动中的程序常短暂报错），超时未命中才带回 `last_error`。

**典型闭环**：`await control(text:"立即安装")` → `mouse.click(x, y)` → `await control(text:"完成", timeout_ms:60000)` → `click` → `await absent(text:"安装中")`。

### 属性谓词与组合（v2.0.0）

`screen.find` 现在返回 UIA 属性，`gui.await` 可据此等**状态**而不只是「出现」：

```bash
# 等一个「可用」的按钮（不指定文字）
nodeagent --node win await --condition control --where '{"enabled":true}'
# 等值里含「已」的元素
nodeagent --node win await --condition control --where '{"value":"*已*"}' --timeout 15000
# 组合：装成功 或 报错，先出现的算
nodeagent --node win await --any_of '[{"condition":"window","title":"安装完成"},{"condition":"control","text":"错误"}]'
```

| 属性 | 来源 | 拿不到时 |
|---|---|---|
| `enabled` | `IsEnabled` | — |
| `value` | `ValuePattern` | `null`（**不猜**） |
| `selected` | `SelectionItemPattern` | `null` |
| `toggle` | `TogglePattern` | `null` |

> 属性只在 **UIA 引擎**下可读（Windows）。走 OCR/图像模板时 `where` 被忽略并**带回 `note`**，
> 不会让调用方误以为「按属性过滤过了」。macOS 无 UIA 等价物，`where` 不可用（会明确报错提示用 `text`）。

---

## 状态采样：日志过滤与定时采样 —— v2.0.0

治**间歇性**问题（代理不通、杀软拦截、端口时开时闭）—— `system.status` 只能看当下快照，
而 `event.watch` 只解决「有事件时通知」，没有「**持续记录并回看**」。

```bash
# 日志在被控端侧过滤，只回匹配行（几万行日志也不整份拉回）
nodeagent --node win log --path "C:\app\app.log" --level ERROR --limit 20
nodeagent --node win log --path "C:\app\app.log" --pattern "timeout|refused" --tail

# 连续采样 5 分钟，事后回看「断过几次、最长断多久」
nodeagent --node win invoke monitor.start --args '{"source":"port","target":"127.0.0.1:8765","interval_ms":2000,"id":"probe"}'
nodeagent --node win monitor report probe
nodeagent --node win monitor stop probe
```

采样源四类：`port`（连通性 + 延迟）/ `process`（存活 + PID）/ `command`（退出码 + 首行输出）/
`metric`（CPU·内存）。样本落 `<数据目录>/monitors/<id>.jsonl`，**摘要直接给结论**。

---

## 审计链外部锚定 —— v2.0.0

链内哈希只能发现「改一条」。**有 root 的攻击者可以整链重写** —— 从零重建一份自洽的假日志，
`audit.verify` 照样通过。外部锚定是唯一能戳破它的手段：把链头记到**链外**。

```bash
nodeagent --node win audit head --compare           # 看链头 + 与最近锚点比对
nodeagent --node win audit anchor --note "每日例行"   # 追加一个锚点
```

**锚点记四元组** `{entries, head_hash, head_ts, rotated_segments}`，不能只记哈希 ——
日志轮转会丢弃最旧段使条目数下降，只比哈希会把**轮转误判成篡改**。
锚点文件**只追加**（可覆盖的话，攻击者重写链后再刷新锚点即可抹痕）。

> 真正发挥价值的前提：把锚点文件指向**另一台机器 / 网盘同步目录**。
> 本机文件被整盘重写时，锚点也随之消失 —— 那就等于没锚。

**51 项能力** · **41 个 MCP 工具** · **269 项单元测试** · **30 项端到端用例** · **3 项 Rust 壳单测**（真跑 Node sidecar）（CI 在真实 Windows / Linux runner 上验证）

> 关键里程碑：**GUI 语义**（`window.list` + `screen.find`，UIA 找不到自动降级 OCR）
> 让 AI 从「看得到画面但读不懂界面」变成「按名字取坐标点下去」。

## 快速开始

### 0. 构建

```bash
pnpm install
pnpm build          # 全部 workspace（protocol/client/agent/cli/mcp/hub + 桌面控制台前端）
pnpm test:unit      # 单元测试（协议纯函数 / 清单守护 / 编码脚本守卫 / 契约守卫）
pnpm test:e2e       # 端到端（起真实被控端跑全链路）
pnpm test:rust      # Rust 控制端客户端（需 cargo）
```

> 桌面控制台是 Tauri 应用，**打包**需另进目录：`cd apps/console && pnpm tauri build`。
> 仅前端产物则 `pnpm build` 已覆盖。

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

2. 把 zip 拷到 Windows 并解压到**固定目录**（如 `D:\nodeagent`，装完不要移动或改名）
3. **双击 `install.cmd`** —— 会自动弹 UAC 提权，然后一路装完并打印连接信息

> 不需要记任何命令行。`install.cmd` 会自己提权、自己读包内 `PSK.txt` 的密钥（没有就生成一把），
> 再调用底层的 `install.ps1`。日后管理双击 **`control.cmd`**（启动 / 停止 / 重启 / 状态 / 日志 / 卸载）。

安装脚本会使用**包内自带的 Node.js 运行时**，自动：读/生成预共享密钥 → 写配置 → 放行防火墙 → 注册开机自启 → 启动 Agent，并打印**密钥**与**连接命令**。

<details>
<summary>需要指定端口 / 无人值守模式？展开命令行用法</summary>

```powershell
# 指定端口（默认 8765）
install.cmd 18770

# 等价的底层调用（install.cmd 就是这行 + 提权 + 读 PSK）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -NodeId my-pc -Key <PSK> -AllowInput

# 无人值守：注销/重启后仍运行，但**没有 GUI**（Session 0 无桌面）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Unattended -AtStartup
```

</details>

**两种运行模式（重要）**

| 模式 | 命令 | 登录/注销 | 能力范围 |
|---|---|---|---|
| 交互（默认） | `install.cmd` | 登录时启动；**注销即停** | 全部能力，**含 GUI**（截屏 / UIA 找元素 / 键鼠注入） |
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
                    ┌──────────────────────────────────────────┐
                    │  控制端 (macOS / Windows)                │
                    │  ① 桌面控制台（Tauri 2）  ② CLI  ③ MCP   │
                    └──────────────────────────────────────────┘
                                        │
                         JSON-RPC 2.0 over WebSocket
                                        │
                    ┌──────────────────────────────────────────┐
                    │  被控端 Agent（Windows 常驻 / 开机自启）   │
                    │  同时也是「本地被控端」，供本机控制台直连   │
                    └──────────────────────────────────────────┘
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

### 桌面控制台（Tauri 2）

`apps/console` —— 跨端图形控制台，**主控与被控一体**：本机也可作为被控端，
由控制台经 loopback 直连（复用同一个 Agent，不做第二套被控端实现）。

技术栈 Tauri 2（Rust 壳 + 系统 WebView）+ Vue 3 + TypeScript + Pinia + Naive UI。
协议客户端由 **Node sidecar**（`apps/console/sidecar/`）承担（复用 `@nodeagent/client`，
Tauri 侧经 Cargo path 依赖），**不引入第二套协议实现**。

| 页面 | 能力 |
|---|---|
| 设备管理 | 连接/断开、保存多台设备、能力清单与握手元信息、实时日志 |
| 状态总览 | CPU / 内存 / 磁盘 / 网卡，3s 轮询 |
| 终端 | `system.shell.exec`（可设超时）、历史回放 |
| 进程与服务 | 进程表（CPU/内存/已运行）+ Windows 服务表 |
| 软件 | `app.list` / `app.install`（winget 静默安装，超时放大到 10 分钟） |
| 文件 | 浏览 / 预览 / 写入（走分块能力，天然支持大文件） |
| 审计 | `system.audit.list` 筛选 + `system.audit.verify` 链完整性校验 + 导出 JSONL |

```bash
pnpm -r build                       # 含 console 前端
cd apps/console && pnpm tauri dev   # 开发态（起 Vite + Tauri 窗口）
cd apps/console && pnpm tauri build # 打包（macOS 实测 .app ≈ 6.8 MiB）
```

⚠️ 平台差异：`app.*` 与 `system.service.list` **仅在被控端为 Windows 时可用**，
非 Windows 被控端会返回 `E_UNSUPPORTED_PLATFORM`。控制台连接后会探测
`system.info.os` 并**事前禁用**这些入口，而不是发出注定失败的请求。

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
nodeagent metrics [--since <ms>]                    # 成功指标：闭环率/装软件率/P95/拦截率
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
nodeagent events --kind file --path C:\logs --seconds 20   # 实时接收文件变动推送（CLI 直连推送）
nodeagent events --kind process --pattern chrome*            # 进程启停
nodeagent events                                              # 列出当前订阅
nodeagent macro init demo.json                               # 生成示例宏
nodeagent macro run demo.json --var STAMP=hello               # 回放（逐步校验）
nodeagent macro validate demo.json                            # 仅校验文件
nodeagent group add 办公机 win_a,win_b                        # 设备分组
nodeagent fanout system.info --nodes @办公机                  # 按组并发下发
```

### GUI 语义（三条腿：控件树 / 文字 / 图像）

```bash
nodeagent screen find "确定"                        # UIA → OCR 自动降级
nodeagent screen find "登录" --method ocr --wait-ms 5000   # 等界面加载出来
nodeagent screen find "" --method image --template C:\icons\save.png --threshold 0.9
                                                    # 纯图标控件：按图找坐标
```

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
| `na_event_watch` · `na_event_poll` · `na_event_list` · `na_event_unwatch` | 事件订阅；`notify:true` 走 MCP 日志通知实时推送，否则用 `na_event_poll` 拉取 |
| `na_macro_run` | 回放 GUI 宏（步骤序列，逐步校验） |
| `na_metrics` | 成功指标（闭环率 / 装软件率 / P95 / 拦截率）+ 达标判定 |

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
pnpm test:unit    # 单元测试（114 项：协议纯函数 / 清单守护 / 审计链 / ACL / 宏引擎 / 分组 / Hub 授权 / 指标 / 助手与预加载段）
pnpm test:e2e     # 端到端测试（21 项，含 TLS / 零信任 / 发现 / 文件 / Hub）
pnpm test:windows # Windows 专属能力（服务 / 软件 / winget 真实装软件）
pnpm verify       # 对已配置的被控端跑全套验收并输出报告
node scripts/verify-mcp-events.mjs   # 验证 MCP 事件双通路（推送 + 拉取）
```

### 三层自动化真机验证

无需手工点测：

| 层次 | 方式 | 覆盖 |
|---|---|---|
| **CI（推荐）** | GitHub Actions `windows-latest` | 真实 Windows 上跑协议 E2E、专属能力（`Get-Service` / 注册表 / winget 装软件）、`install.ps1` 链路、`install.cmd`/`control.cmd` 双击链路、**Windows PowerShell 5.1 解析守卫**、CLI 连入、MCP 工具列表 |
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
├── scripts/               # install.cmd / control.cmd（一键入口）/ install.ps1 / control.ps1 / verify.mjs
├── tests/e2e/             # 端到端测试
├── docs/                  # 开发文档
├── docs/                  # 项目文档（含 PRD）
└── README.md
```

## 路线图

> 下表「**批次**」是**开发阶段的内部代号**（一批相关改动的集合），**不是版本号** ——
> 项目的唯一版本号是 semver（见 `git tag` / `package.json`）。批次与发布版本的对应关系
> 及书写规范见 [`docs/VERSIONING.md`](docs/VERSIONING.md) §0。

| 阶段（开发批次） | 目标 | 状态 |
|---|---|---|
| **批次 1** | 命令级接管 + 装软件 + 查状态 + 基本鉴权 + CLI + MCP | ✅ |
| **批次 2** | 图形接管（`screen.*` 截屏 + `input.*` 键鼠）+ 输入控制开关 | ✅ |
| **批次 3** | 零信任：Ed25519 身份认证 + 能力级 ACL | ✅ |
| **批次 3+** | 审计日志（留痕 + 查询）+ 调用限速 | ✅ |
| **批次 4** | 无感体验：局域网自动发现 + 断线自动重连 | ✅ |
| **批次 5** | 多设备管理 + 文件传输（分块 / 大文件 / 原子写） | ✅ |
| **批次 6** | Hub 中转：跨网段 / 公网接入（被控端主动外连，穿 NAT） | ✅ |
| **批次 7** | **自持**：受控重启（配置变更后让自身生效，不再丢连接） | ✅ |
| **批次 8** | **GUI 语义**：`window.list` / `window.focus` / `screen.find`（UIA 按名取坐标） | ✅ |
| **批次 9** | `screen.find` **OCR 兜底**（自绘 UI 也能定位）+ MCP 工具同步 | ✅ |
| **批次 10** | **长任务异步化**（`system.task.*`）+ 剪贴板 + CLI 常驻连接池 daemon | ✅ |
| **批次 11** | **安全加固**：私钥入系统密钥库（Keychain/DPAPI）+ 审计链防篡改 + ACL 细化（IP/时段/按能力限速） | ✅ |
| **批次 11+** | **操作面补完**：鼠标拖拽 / 录屏 / 剪贴板图片 / 多设备并发 / 一键升级 | ✅ |
| **批次 12** | **事件订阅**（file/process/net 主动推送）+ **GUI 宏**（步骤序列回放）+ **Hub 并发多控制端** + 设备分组 | ✅ |
| **批次 12.1** | **Hub 侧按控制端授权**（多令牌 + 按设备白/黑名单 + 注册准入） | ✅ |
| **批次 12.2** | GUI **等待/重试语义**（`wait_ms`）—— 界面加载/动画不再假失败 | ✅ |
| **批次 12.3** | **macOS 端 GUI 对齐**：AppleScript 窗口枚举/聚焦 + Vision OCR 元素定位（含 Retina 坐标换算） | ✅ |
| **批次 12.4** | **事件直达 MCP 宿主**（实时推送 + 拉取双通路） | ✅ |
| **批次 13** | **成功指标聚合**（PRD 2.2 四项）+ 依真实数据修正口径（时延分层） | ✅ |
| **批次 14** | **PowerShell 常驻助手** —— GUI 能力提速 4~25 倍（预加载 C#/UIA，免每次现编译） | ✅ |
| **批次 15** | `screen.find` **图像模板匹配**（纯图标/无文字控件盲区）+ 一堆真机根因修复 | ✅ |
| **批次 16 ~ 26** | 网络两阶段提交 · 音频控制 · 构建指纹 · 自更新 · 证书钉住 · 每客户端 PSK · 连接层三防护 · 零信任安装 · 审计锚定 | ✅ |
| **批次 27 ~ 29** | **语义可断言**（`gui.await` + UIA 属性 + `where` 谓词 + `any_of`）· **状态可回看**（`log.query` + `monitor.*`） | ✅ |
| **发布** | **v2.0.0**（2026-10-10）：51 项能力 · 273 单测 · Windows/Rust CI 全绿 | ✅ 已发布 |

## 文档

- [`docs/SECURITY.md`](docs/SECURITY.md) —— **安全模型与加固指南**（钥匙=root、证书指纹钉住、网段白名单、应急处置）
- [`docs/VERSIONING.md`](docs/VERSIONING.md) —— **版本与兼容性契约**（升级顺序、什么算破坏性、发版流程、更新方式）
- [`docs/REMOTE-LIMITS.md`](docs/REMOTE-LIMITS.md) —— 远程能力边界与真实故障案例（含杀软误拦）
- [`docs/VM-VERIFICATION.md`](docs/VM-VERIFICATION.md) —— **无 Windows 真机时，用 Parallels 的 Win11 ARM 虚拟机补验证**（含逐条命令与结论标注规则）
- [`CHANGELOG.md`](CHANGELOG.md) —— **变更日志**（未发布版本的内容汇总 / 历史版本）
- [`docs/ROADMAP.md`](docs/ROADMAP.md) —— **当前进度盘点与下一步路线**（2026-10-07 基线：待办收尾 / 语义可断言 / 状态采样 / 安全残余）

- [产品需求文档（PRD）](./docs/PRD.md)
- [开发文档（DEVELOPMENT）](./docs/DEVELOPMENT.md) —— 协议细节、能力 schema、安全模型、各端实现指南
- [**跨机接管的边界与局限**](./docs/REMOTE-LIMITS.md) —— 哪些问题能远程修、哪些必须人工，附真实故障诊断案例
- [**实战复盘：短板与改进优先级**](./docs/RETROSPECTIVE.md) —— 基于真机使用的短板分析（GUI 语义 / 编码 / 自愈 / 可观测性）。**写于 2026-09-28（19 项能力时），多数 P0/P1 已解决 —— 最新状态见 [ROADMAP](./docs/ROADMAP.md) §3 对照表**

## 关键决策

| 决策点 | 结论 |
|---|---|
| 拓扑 | 局域网点对点直连为主；跨网段时经 Hub 中转（Hub 仅透传，端到端安全不受影响） |
| 安全演进 | 先简化（预共享密钥 + HMAC）→ 后强化（Ed25519 + 能力级 ACL + 审计） |
| AI 接入 | 核心能力 → CLI（调试底座）→ MCP（AI 落点） |
| 装软件 | 优先 winget 静默安装 |
| Windows 部署 | 一键 `install.cmd`（双击即装，自提权）+ 开机自启；`control.cmd` 管理 |
| 依赖策略 | 被控端零原生编译；能力全部基于系统原生 API 实现 |
