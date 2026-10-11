# 变更日志

本文件记录 nodeagent 的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [未发布]

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
