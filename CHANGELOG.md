# 变更日志

本文件记录 nodeagent 的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [未发布]

> 主题：**控制台「去命令行化」** —— 双击应用即用，启停/重启/更新/日志/托盘常驻/开机自启全部在界面里完成。
> 目标原文：「不再打开命令行窗口，运行应用之后，有启动、停止、重启、检查更新等功能，
> 有日志功能，可以后台运行和开机自启等等功能」。

### 新增 —— 本机被控端托管（`apps/console/src-tauri/src/agent.rs`，约 560 行）

- **新增「本机服务」页（`/local`，默认首页）与「服务日志」页（`/logs`）**。
  默认路由由 `/nodes` 改为 `/local`：打开应用先看到「本机被控端」的启停面板，
  而不是先要求用户填一个连接地址 —— 这是「运行应用之后就有启动/停止/重启」的落点。
- **进程生命周期管理**：`AgentManager`（`STOPPED / STARTING / RUNNING / STOPPING / CRASHED` 五态）。
  启动、停止、重启均走界面按钮；`stop()` 在 Windows 走 `taskkill /PID <pid> /T /F`（连子进程树一起收），
  POSIX 走 `child.kill()`，随后**轮询确认端口已释放**才算停干净。
  **重复启动被拒绝**（不会起出两个进程），**异常退出自动重启**（上限 5 次，超限停在 `CRASHED` 并保留原因）。
- **日志功能**：同时捕获被控端 `stdout`/`stderr` 两路，环形缓冲 4000 行。
  每行带一个**单调递增的 `seq`** —— 这是刻意设计：环形缓冲淘汰旧行后，若用「位置下标」做游标，
  前端的增量拉取会静默错位；独立 `AtomicU64` 发号可跨淘汰保持连续。
  界面侧：实时事件推送、关键字过滤、三流（stdout/stderr/system）复选框、自动滚动、
  暂停接收、重新拉取、滚到底部、导出文本、清空。
- **界面化自更新**：`check_update` / `download` / `apply_update` 三个能力。
  - `check_update` 读 GitHub Release 的**稳定别名** `latest.json`（而非 API），**不占用 API 配额**、不受限流影响。
  - `download` 的 `--sha256` 是**必填**（不校验哈希等于开放远程代码执行），校验不通过**不落盘**，写后再复核一次。
  - `apply_update` 的替换顺序：下载到 `runtime/agent.mjs.staged-<pid>` → 复用已有被控端停服 →
    备份现有脚本 → **原子替换** → 写 `agent.seed.json` 版本 → 按需回启。
    任一步失败都停在替换之前，不会留下半截产物。
- **开机自启**（`autostart.rs`）：macOS 写 LaunchAgent `~/Library/LaunchAgents/cn.jkooe.nodeagent-console.plist`
  （`RunAtLoad`；**刻意不用 `KeepAlive`**，否则会与控制台的崩溃自愈形成两层守护互相打架）；
  Windows 用计划任务（**登录用户 + `Interactive` + `Highest`**）。
  一个易错点：macOS 的 `bootstrap` 目标 `gui/<uid>` 里的 uid **不能硬编码 501**（那只是首个本地用户的常见值），
  改为运行时 `id -u` 现取。
- **后台常驻（托盘）**：托盘图标 + 右键菜单（显示主窗口 / 启动 / 停止 / 重启 / 退出）；
  左键单击图标唤出窗口。窗口 `CloseRequested` → `prevent_close()` + `hide()`，
  **关窗不退出**，与「后台运行」的要求一致；真正退出走托盘菜单。
- **`--agent-only` 仅服务模式**：开机自启拉起的是**控制台自身**（GUI 子系统程序，不带控制台窗口），
  进入该模式后不显示窗口、只把被控端托起来；而不是去直接拉起裸 `node`。

### 新增 —— 消灭命令行窗口（三条措施，缺一不可）

| # | 措施 | 位置 | 不加会怎样 |
|---|---|---|---|
| 1 | 控制台是 GUI 子系统程序，自身不弹控制台 | Tauri 默认 | 打开应用先弹黑窗 |
| 2 | spawn `node.exe` 时加 `CREATE_NO_WINDOW`（`0x0800_0000`） | `agent.rs` 的 `creation_flags` | **每次启动被控端都闪一个黑窗** —— 正是皇上要求消灭的现象 |
| 3 | 开机自启拉起控制台而非裸 `node` | `autostart.rs` + `--agent-only` | 开机时黑窗一闪而过 |

### 新增 —— 契约守卫（`tests/unit/console-commands.test.mjs`，6 用例）

把「改了名字两边不同步、但不报错」的三类**静默失效**钉死，避免「界面点了没反应、控制台无异常」：

| # | 守卫 | 抓什么 |
|---|---|---|
| 1 | 前端每个 `invoke("x")` 都已在 Rust `generate_handler!` 注册 | 前端调了个不存在的命令 → 运行时才 `not found` |
| 2 | Rust 注册的命令都被前端使用 | 死命令堆积（改名后残留的旧命令） |
| 3 | `emit("na-*")` ⇄ `listen("na-*")` 双向一致 | 事件名不匹配 → **界面永远不刷新，且无任何报错** |
| 4 | `tauri.bundle.gen.json` 资源目标名 ⇄ Rust `resolve_*` 字面量 | 映射改名 → 生产包内找不到 sidecar/node/agent |
| 5 | sidecar 方法名 ⇄ Rust `.request("x")` | 跨语言调用错名 |
| 6 | 新页面已注册路由 + 默认路由指向 `/local` + 懒加载的 view 文件真实存在 | 「写了页面但进不去」／循环依赖导致的路由表推导失败 |

> **已注入故障实测会红**：把 `agent_start` 改成 `agent_startX`、`na-agent-state` 改成 `na-agent-statee`
> → 当场 2 条失败（`#fail = 2`）；复原后 `#pass = 6 / #fail = 0`，文件逐字节还原。
> 未验证过会红的守卫等于没有守卫。

### 变更 —— 打包与单一实现

- **被控端 esbuild 配置抽为 `scripts/lib/bundle-agent.mjs`**（`repoRoot` / `repoVersion` / `gitShortCommit` / `bundleAgent`），
  `scripts/pack.mjs`（被控端发布包）与 `scripts/prepare-console.mjs`（控制台资源）**共用同一份**。
  此前 `pack.mjs` 里内联了一份配置，控制台若再内联一份就是**两套真相**（改一处漏一处，只在产物里暴露）。
  该模块刻意**不注入构建时间** —— 否则每次打包字节都不同，产物指纹比对会失真。
- **控制台随包分发被控端脚本**：资源由 2 份（`sidecar.mjs` / `node`）增至 **3 份**（+ `agent.mjs`）。
  带来的效果：用户装完控制台，**本机被控端已经就绪**，不需要另外手工安装一次才能点「启动」。
- **播种防降级**：`<数据目录>/runtime/agent.seed.json` 记录版本，
  只有「**随包版本 > 已安装版本**」才覆盖数据目录里的脚本。
  若写成「同版本才跳过」，则用户被控端自更新到更新版本后，下次开控制台会被**静默降回旧版**。
  版本比较按**数值逐段**（`2.0.10 > 2.0.9`），字符串比较会误判。
- `verify-bundle.mjs` 增加 `agent.mjs` 存在性检查 + 用打包内的 node 跑 `--check agent.mjs`。

### 变更 —— CI

- `.github/workflows/rust.yml`：资源数断言 2 → **3**；`paths` 增加 `scripts/lib/bundle-agent.mjs` 与 `apps/agent/**`；
  构建步骤补 `@nodeagent/agent`（`prepare:node` 现在依赖它的 dist，
  **新步骤必须逐条核对前置产物由哪一步生成、顺序是否在其后** —— 本地验证时产物早就在，会把这层依赖完全掩盖）。
- `.github/workflows/windows-e2e.yml`：步骤名与注释同步为含 `agent.mjs` 的说明。

### 变更 —— 界面一律不使用图标

- **去掉全部 emoji 图标**：路由表 `meta.icon` 字段整体移除，侧栏导航由「图标 + 标题」改为**纯文字**。
  触发原因是一次真实的渲染事故：emoji 图标在非系统字体栈的渲染器里退化成**豆腐块**（截图对比可见），
  而「哪套字体栈一定带 emoji」跨平台并不成立 —— 与其赌字形，不如不用。
- **`n-alert` / `n-empty` / `n-popconfirm` 的内置图形一并关闭**：这三个组件的 `showIcon` 默认均为 `true`，
  故 16 处 `n-empty` 的空态插画、7 处 `n-alert` 的类型图标、3 处 `n-popconfirm` 的询问图标全部消失，
  只剩文字与配色（严重程度仍由 `type` 的底色/边框区分，信息不丢）。
  `n-empty` 是**空态里的插画**（比图标更「图形」），在 9 个页面都有，是最容易漏掉的一类。
- **夹在文案里的符号也去掉**：`TerminalView` 的「⚠ 高权限操作，请谨慎」保留纯文字。
- **清理随包的模板残留资产**：删掉 `public/vite.svg`、`public/tauri.svg`、`src/assets/vue.svg`
  与 `index.html` 的 favicon 声明。`public/` 下的文件会被整体复制进产物，
  此前等于把 Vite / Tauri 的 logo 一起发了出去；`index.html` 的标题也还是模板默认值
  （原生窗口标题取自 `tauri.conf.json`，不受影响），本次一并改齐。

> **边界（以下不算「界面图标」，未动）**：① 托盘图标 —— 菜单栏没有图标就点不到，
> 关窗后应用将无法寻回，属**功能必需**；② 被控端 CLI 自身打印的文本标记（`⚠️`/`ℹ️`/`✅`，
> 见 `apps/agent/src/index.ts`、`packages/client/src/keys.ts`、`apps/agent/src/metrics.ts`）——
> 它们是**程序输出内容**，会原样出现在「服务日志」页里，但不是界面元素；
> ③ 控件的结构性部件（下拉箭头、折叠箭头、输入框清除钮、表格排序箭头）。

### 说明 —— 本轮**刻意不升版本号**

本轮新增的全部是**控制台**功能，**被控端能力集合未变**（未增删任何 `system.*` / `fs.*` / `app.*` 能力）。
而 `scripts/lib/bundle-agent.mjs` 会把**根 `package.json` 的 version 注入 `agent.mjs`**（`__AGENT_VERSION__`）：
一旦为控制台功能去升版本号，被控端就会**谎报**一个它并未包含的版本 —— 属版本纪律所禁止。
故版本号维持 **2.0.2**，本批改动记入本节，待真正含被控端变更时由 `pnpm release minor` 一并升号。

---

## [v2.0.2] —— 2026-10-11

> 一轮真机验证（Parallels 27 + Win11 ARM）抓出的**发布事故**修复批次。
> 已公开发布的 `nodeagent-win-arm64.zip` 内装的其实是 **x64 的 `node.exe`** ——
> 该包在 ARM Windows 上能启动、能 listen，却 **TLS 握手不完成**（控制端只见 `E_TIMEOUT`），
> 实际不可用。本版重出资产，并把「交付物架构」直接钉进发版脚本与 CI。

### 新增

- **控制台自带 Node 运行时，目标机器无需预装 Node**（`pnpm --filter nodeagent-console bundle`）
  —— 控制台的 sidecar 是 `.mjs`，此前只能在装了 Node 的机器上运行（`resolve_node` 回退系统 node）。
  现由 `scripts/prepare-console.mjs` 把 Node 运行时准备为 Tauri resource 随包分发。
  实测：`.app` **90.8 MiB**（含运行时 86MB）／`.dmg` **33.78 MiB**（分发件，仍低于 40MB 目标）。
  作为对照，本机实测 Electron 运行时本体（`Electron Framework.framework`）为 207MB ——
  即 Tauri + Node 的运行时开销不到 Electron 的一半。
- **`apps/console/scripts/verify-bundle.mjs`** —— 验证「打包产物能否自举」：真 spawn 打包内的 node
  去跑打包内的 sidecar，并走一次真实 JSON-RPC 握手。源码与单测都正常、只在产物中暴露的问题靠它拦下。

### 修复 / 规避（两处实测踩出来的约束）

- **macOS 上 `strip` 会使 Mach-O 代码签名失效 → 内核直接 `SIGKILL`（exit 137）**，
  且没有任何有用报错（不是警告、不是异常，就是静默无法执行）。
  实测对照：原样复制 ✓ ／ strip 不重签 ✗(137) ／ strip + `codesign --force --sign -` ✓。
  故准备脚本在 strip 之后**必须** adhoc 重签（省 20% 体积值得，但这步不能少）。
- **Node 运行时不得声明进默认 `tauri.conf.json`** —— `bundle.resources` 是**编译期契约**
  （`tauri-build` 校验声明的文件必须存在），声明「运行期才就绪」的资源会让 `cargo check/test`
  在 build.rs 阶段直接失败。一律走 `tauri build --config` 注入。

### 修复 —— 被控端打包（ARM64）

- **`nodeagent-win-arm64.zip` 里装的其实是 x64 的 `node.exe`**。
  `pack.mjs` 下载 Node 运行时的缓存文件名是固定的 `node-runtime.zip`（**不含架构**）：
  `release.mjs` 先打 x64 时把它缓存下来，随后打 arm64 时误判「已缓存」直接复用
  → **两份公开包内的 `node.exe` 字节完全相同**（sha256 同为 `fdddbf45…`，PE Machine = `0x8664`）。
  后果极隐蔽：该包在 ARM Windows 上**能启动、能 listen**，但 **TLS 握手不完成**
  （控制端只见 `E_TIMEOUT`）—— 被控端实际不可用，而 macOS 侧 100% 复现不出来。
  修法：① 缓存文件名带上架构（`node-runtime-<arch>.zip`）；
  ② 解包后**断言 `node.exe` 的 PE Machine 与 `--arch` 一致**（缓存串包 / 手工塞错文件当场红）。
- **CI 补「双架构包 PE 架构校验」**（`.github/workflows/windows-e2e.yml`）——
  此前 CI 只跑 `pnpm pack:win`（默认 x64）且只校验 x64 包，**arm64 打包零覆盖**，
  故该 bug 必然逃过 CI。现两条架构都打，并直接读最终 zip 内 `node.exe` 的 PE 头比对。
- **发版脚本补「交付物架构断言」**（`scripts/lib/zip-pe-arch.mjs`）——
  `release.mjs` 生成资产前，直接解出**最终 zip 内**的 `node.exe`、读 PE 头比对架构，
  不符即**中止发版**。与 `pack.mjs` 的断言刻意分两层：后者是打包**流程内部**的自洽，
  这里钉的是**交付物本身**的性质。纯内置 `zlib` 实现，不依赖 `unzip` / `Expand-Archive`
  （Windows runner 上没有 `unzip`），另留 CLI 自检入口：
  `node scripts/lib/zip-pe-arch.mjs <zip路径> <x64|arm64>`（已注入故障实测会红）。

### 真机实测（ARM64 Windows 虚拟机）

- **arm64 包**：TLS 握手成功 → PSK 认证 → 声明 51 项能力（两端一致）→
  `system.info` / `status` / `process.list` / `service.list` / `shell.exec` /
  `audit verify` 全部正常，`arch` 报告为 `arm64`（原生，非模拟层）。
- **x64 包（对照，同机同参）**：`connect` 报 `E_TIMEOUT` —— **复现**了「能 listen 但握手不完成」。
  → 证实「按架构出包」不是理论洁癖，而是 ARM Windows 上的硬需求。
- 已知边界：被控端若以 **SYSTEM（会话 0）** 手动启动，`screen.capture` 等图形能力会失败
  （会话 0 无交互桌面）。正式安装路径不受影响 —— `install.ps1` 的计划任务 principal
  用的是登录用户 + `LogonType Interactive`，注释已明写「图形能力可用」。

---

## [v2.0.1] —— 2026-10-11

> 一轮**真机验证**（Parallels 27 + Win11 ARM）带来的修复批次：在补齐 6 项待验证项的过程中，
> **抓到并修掉 5 个真问题** —— 全部只有真机能发现（macOS 上 100% 测不出）。

### 修复

- **`control.ps1` 的 `$scheme:` 被当 drive 引用** —— PowerShell **解析期错误 → 整个脚本不可用**
  （stop / start / status 全废，且只报一行语法错、极易误判为别的问题）。改用 `${scheme}`；
  并新增守卫扫全仓 `.ps1` 的 `$ident:` 形式（含注入故障验证）。
- **连接保活缺 pong 检测** —— 心跳只 `ping()` 而不检查 pong，且 ws 库默认不会因「ping 无 pong」断开；
  客户端进程已死（TCP 未发 FIN）时，连接会**永久占用 `max_connections` 名额**，
  叠加「有任务/订阅时清扫保守跳过」的策略 → **会把正常控制端挡在外面**（真机实测把自己锁住了）。
  现对静默超过 `idle_timeout_ms * 2` 的连接 `terminate()`，并让 pong 也算「活跃」。
- **v26 自重启任务清理阈值过粗** —— 原用「早于 1 小时」，频繁 restart（间隔 < 1h）时旧任务照样累积；
  改为「**早于本 agent 启动时刻**」——语义精确：凡在**我启动之前**运行的任务，必然不是我的宿主。

### 新增

- **`scripts/pack.mjs --arch <x64|arm64>`** —— Windows 包分架构。**x64 包在 ARM Windows 上协议层不可用**
  （能启动、能 listen 8765，但 **TLS 握手不完成** —— Prism 模拟下异常，现象极具误导性）；
  ARM 机器须用 arm64 包。`release.mjs` 随之**同时产出两个架构**，`latest.json` 新增 `zip_arm64` 字段
  （**只增不减**，旧控制端忽略即可）。
- **`scripts/verify-b2.mjs`** —— v23 连接层三防护的真机验证脚本（`idle` / `maxconn` / `ban` 三模式），
  全部走真实连接而非 mock。
- **`docs/VM-VERIFICATION.md`** —— 无 Windows 真机时用 Parallels Win11 ARM 补验证的完整清单
  （含实测结果、能补/不能补矩阵、8 条排查项）。

### 真机验证状态（本版实测）

| 项 | 结果 |
|---|---|
| A 组（`verify.mjs` 17 项） | 15 通过 / 0 失败 / 1 跳过 |
| v1.5 四项（字符串热键/预设别名/长按/后台投递） | 全过（`route=post` 实测命中 138 窗口） |
| v23 三防护 | 三场景全过（封禁 / 上限 / 空闲断开） |
| v26 自重启清理 | 验证并改进（阈值改为 agent 启动时刻） |
| 锚点端到端 | 全过（含云盘链外留存） |

## [v2.0.0] —— 2026-10-10

> 自 `v1.6.0` 起累计 37 个提交。**能力数 43 → 51**，单测 195 → 273，端到端 30。
> 之所以直接跳 v2.0.0：两个新方向（语义可断言 / 状态可回看）+ 安全批次四连 + 五处
> 只有真机能暴露的严重缺陷修复，量级远超一次 MINOR。
>
> **兼容性**：完全向后兼容 —— 未改任何既有能力的参数名或语义，未新增必填参数，
> 返回结构只增不减（遵循 `docs/VERSIONING.md` 的四条铁律）。
>
> **验证状态**：本版发布时被控端整机离线，`v1.5.0` 的预设别名/长按/后台投递/热键序列
> 与 `v2.0.0` 的自重启任务清理策略**当时未经真机验证**（后者已在本地单测锁定判定条件）。
>
> ✅ **2026-10-11 已补齐**：在 Parallels 27 + Win11 ARM 虚拟机上完成真机验证 ——
> A 组 15 通过/0 失败、v1.5 四项全过、v23 三防护三场景全过、v26 清理策略**验证并改进**
> （阈值由「1 小时」改为「本 agent 启动时刻」）、锚点端到端跑通（含云盘链外留存）。
> 并**顺带发现并修复 5 个真问题**（含 `control.ps1` 解析期错误、连接保活缺 pong 检测等）。
> 详见 `docs/VM-VERIFICATION.md`。

### 新增：语义可断言（v1.6.0 / v2.0.0）

- **`gui.await`** —— 等条件成立再返回。四类条件（`window` / `control` / `process` / `file`）
  × 两种状态（`present` / `absent`），复用既有能力，零新增平台探测代码。
  超时是**正常返回**（`satisfied:false` + `note`），不抛异常；轮询期单次异常不视为失败。
- **`screen.find` 返回 UIA 属性** —— `enabled` / `value` / `selected` / `toggle`。
  每项单独 try/catch，**拿不到就留 `null` 绝不猜**（Electron、游戏 UI 常给不出值）。
- **`where` 属性谓词** —— 如 `{"enabled":true}`「等一个可用的按钮」，
  比「等一个叫某名字的按钮」更贴近真实意图。仅 UIA 引擎生效，
  OCR/图像引擎会忽略并**带回 `note`**，不让调用方误以为过滤过了。
- **`any_of` 组合** —— 任一命中即算，命中时回报是哪个子条件。
  例：`[{window:"安装完成"},{control:"错误"}]` = 「装成功或报错，先出现的算」。
- CLI：`nodeagent await`；MCP：`na_await`。

### 新增：状态可回看（v2.0.0）

- **`log.query`** —— 日志**在被控端侧过滤**后只回匹配行（`pattern` / `level` / `since` /
  `offset` / `limit` / `tail`）。流式逐行读，几万行日志也不整份拉回。
- **`monitor.start` / `report` / `stop` / `list` / `delete`** —— 定时采样并落盘。
  四类源：`port`（连通性 + 延迟）/ `process`（存活 + PID）/ `command`（退出码 + 首行）/
  `metric`（CPU·内存）。**摘要直接给结论**：断了几次、最长断多久、值域。
- CLI：`nodeagent monitor` / `log`；MCP：`na_monitor` / `na_log`。

### 新增：安全加固（v2.0.0）

- **连接层三防护**：
  - 握手失败封禁 —— 连续失败达阈值 → 指数退避（封顶 24h），成功即清零，支持白名单豁免
  - 连接上限（默认 8）+ 空闲断开（默认 30 分钟；有任务或订阅在跑时保守不踢）
  - 状态从 `WeakMap` 改 `Map`（需要 size 与遍历），关闭时手动清理
- **安装期密钥改 stdin** —— `install.cmd` 用管道喂 `-KeyFromStdin`，密钥不再出现在命令行
  （同机其他用户无法从进程命令行读到）。
- **零信任优先安装** —— 侦测到 `client-acl.json`（含控制端公钥）即走 `ed25519` 并写入
  `acl.default_effect="deny"`；否则保持 `psk` 但输出**醒目安全告警**（说明 `client_id`
  自报的固有风险 + 三步切换指引）。
- **审计链外部锚定** —— `system.audit.head`（链头可读）+ `system.audit.anchor`（锚点追加落盘）。
  锚点记四元组 `{entries, head_hash, head_ts, rotated_segments}`：只记哈希会把**日志轮转
  误判成篡改**。锚点文件只追加 —— 可覆盖的话，攻击者重写链后再刷新锚点即可抹痕。

### 修复（五处只有真机能暴露的严重缺陷）

- **`install.cmd` 双击首装即炸** —— `for /f` 调 PowerShell 时 `^|` 转义漏进 PS，导致
  ParseError。**真实用户第一次安装必然踩到**（PSK.txt 已不在分发包内）。
- **`pack.mjs` 三连** —— `spawn node_modules/.bin/esbuild` 在 pnpm 布局下 ENOENT；
  以及 `zip` / `ls -la` / `du -sh` 在 Windows 上都不存在。已改为 esbuild JS API +
  平台分流（Windows 用 `Compress-Archive`）+ Node 原生 API。
- **`where` 的 PowerShell 注入语法错** —— 连修两轮：JSON 字面量 ✗ → `\"` 反斜杠转义 ✗
  （PS 5.1 不认）→ **PS 单引号字面量** ✓。症状是「带 where 一律窗口操作失败，不带则正常」。
- **`screen.find` 的 where-only 被自己入口校验拦下** —— 只改了一半（`gui.await` 侧放开、
  `screen.find` 侧没动）。
- **`parseLeadingTs` 吃掉 ISO 的 `Z` 时区标记** —— UTC 被当本地时间解析，**整体偏 8 小时**，
  跨时区日志判断「何时断的」会错（单测抓到）。

### 修复（其他）

- **自重启在非管理员身份下失败** —— `-RunLevel Highest` 被系统拒绝（v7 起的既有缺陷）。
  现改为两级降级：先试 Highest，失败则不指定 Principal（继承当前权限级别）。
  修复后 `deploy` 首次能一次走通完整闭环。
- **`deploy` 备份无限堆积** —— `.bak-<时间戳>` → 固定名 `.bak` + 清理历史（真机 17 → 2 个文件）。
- **自重启任务 Running 僵尸** —— 清理条件加「`LastRunTime` 早于 1 小时」余量
  （不能简单清所有 Running：那会连当前 agent 的宿主一起杀）。
- Windows CI 四连：`URL.pathname` 跨平台路径、`shell: cmd` 套多行 PowerShell、
  5.1 执行的内联脚本含中文、产物包断言方向反了（`PSK.txt` 从「必含」改「不得含」）。

### 安全 / 隐私

- 源码与测试里的真机常量脱敏（机器名、内网地址）—— 保留「为什么」的教训，去掉具体实况。
- 能力调用新增审计类型 `session.idle_close`。

### 文档

- `README` 能力总览补三行、数字同步至 51 项能力 / 41 个 MCP 工具 / 269 单测。
- 新增章节：`gui.await` 属性谓词与组合、状态采样、审计链外部锚定。
- `docs/SECURITY.md` 新增 §4.7（零信任优先安装）/ §4.8（审计锚定），
  §5「还没做的」清单**至此全部完成**。
- `docs/DEVELOPMENT.md` 能力表补全（此前停在 19 项）。
- `docs/RETROSPECTIVE.md` 加「短板已全部解决」对照表（保留原判断不改写）。
- `docs/ROADMAP.md` 台账刷新，并新增「真机验证抓到的 8 个真 bug」表。

---

## [v1.6.0] —— 2026-10-07

### 新增

- `gui.await` 等待条件能力（第 43 项）。

### 说明

- 本版**未经真机验证**即发布（当时被控端离线）；相关验证已于 2026-10-09 ~ 10-10 补齐。

## [v1.5.0] —— 2026-10-07

### 新增

- `input.key.press` 参数面扩展：字符串热键（`hotkey: "ctrl+shift+esc"`）、约 50 个预设别名、
  长按 `hold_ms`、后台定向投递 `route=post` + `target_pid`。
- 按键表补齐：左右侧修饰键、小键盘（与数字键分开）、OEM 符号键（解锁 `win+d` / `ctrl++` /
  `win+.`）、IME 键、浏览器键、系统键。

### 说明

- 本版同样**未经真机验证**即发布；2026-10-10 已验证字符串热键与单键投递，其余项待被控端在线后补齐。
