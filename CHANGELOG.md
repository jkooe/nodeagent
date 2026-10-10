# 变更日志

本文件记录 nodeagent 的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [v2.0.0] —— 2026-10-10

> 自 `v1.6.0` 起累计 37 个提交。**能力数 43 → 51**，单测 195 → 273，端到端 30。
> 之所以直接跳 v2.0.0：两个新方向（语义可断言 / 状态可回看）+ 安全批次四连 + 五处
> 只有真机能暴露的严重缺陷修复，量级远超一次 MINOR。
>
> **兼容性**：完全向后兼容 —— 未改任何既有能力的参数名或语义，未新增必填参数，
> 返回结构只增不减（遵循 `docs/VERSIONING.md` 的四条铁律）。
>
> **已知限制**：本版发布时被控端整机离线，`v1.5` 的预设别名/长按/后台投递/热键序列
> 与 `v26` 的自重启任务清理策略**尚未经真机验证**（后者已在本地单测锁定判定条件）。

### 新增：语义可断言（v1.6 / v1.7）

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

### 新增：状态可回看（v1.8）

- **`log.query`** —— 日志**在被控端侧过滤**后只回匹配行（`pattern` / `level` / `since` /
  `offset` / `limit` / `tail`）。流式逐行读，几万行日志也不整份拉回。
- **`monitor.start` / `report` / `stop` / `list` / `delete`** —— 定时采样并落盘。
  四类源：`port`（连通性 + 延迟）/ `process`（存活 + PID）/ `command`（退出码 + 首行）/
  `metric`（CPU·内存）。**摘要直接给结论**：断了几次、最长断多久、值域。
- CLI：`nodeagent monitor` / `log`；MCP：`na_monitor` / `na_log`。

### 新增：安全加固（v23 / v24 / v25）

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
