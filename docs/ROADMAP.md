# nodeagent 进度盘点与下一步路线

> 盘点日期：2026-10-07（**当日第二次更新**，据工作区最新推进刷新）
> 盘点方式：只读核查仓库（`git fetch` + 源码 grep + 本地跑单测）
> 基线：远端 main `0d62cb1`（tag **v1.5.0**）｜本地 HEAD `7ad820c`（1 个未推送 CI 提交）
> 工作区：有**未提交的业务改动** —— `gui.await`（v1.6，语义方向一的首个落地）
> 适用范围：本文档随仓库公开，**不含任何真机地址与账户信息**（见 §6 脱敏约定）

---

## 一、结论先行

功能层面已基本收口。**43 项能力**覆盖了「命令接管 → 图形接管 → 零信任 → 文件传输 → Hub 中转 → 自更新」六条主线，安全加固已发版两批。

**方向一（语义可断言）已开工**：`gui.await` 在工作区完成实现（170 行 + 57 行 manifest + 注册），把 GUI 操作从「盲试」推进到「可等待、可断言」。**但尚未收尾** —— 详见 §4。

当前瓶颈：

| 性质 | 问题 | 影响 |
|---|---|---|
| **在建未收尾** | `gui.await` 已实现但**未提交、未发版、单测未覆盖、CI 未绿** | 能力数断言失败（见下），远端拿不到 |
| **收尾缺口** | 本地 1 个 CI 提交未推送；`ci/workflow-unit-tests` 分支贡献已并入但分支未清理 | CI 护栏未生效于远端 |
| **语义深度** | `gui.await` 解决了「等得到」，但 `screen.find` 仍不返回 UIA **属性**（value/enabled/selected） | 能等「元素出现」，还不能等「元素变成某状态」 |
| **状态留存** | 事件订阅已通，但无采样留存与回看 | 间歇性问题（代理不通、杀软拦截）仍只能靠巧遇 |

> ⚠️ **当前工作区单测是红的**：195 例中 **194 通过、1 失败** —— `tests/unit/capabilities.test.mjs:66` 硬编码 `assert.equal(CAPABILITY_MANIFEST.length, 42)`，而 `gui.await` 使能力数变 43。**修断言前不要提交**，否则 CI 必红。

优先级：**`gui.await` 收尾 > 语义属性 > 状态采样 > 安全残余**。

---

## 二、现状快照

### 2.1 版本与仓库

| 项 | 值 |
|---|---|
| `package.json` version | `1.5.0`（root 及 6 个子包一致）—— **未随 `gui.await` 上调** |
| 本地 HEAD | `7ad820c` ci: 补全 Windows 真机验证 |
| 远端 main | `0d62cb1`（tag **`v1.5.0`**） |
| 本地领先远端 | **1 个提交**（仅 `.github/workflows/windows-e2e.yml`，未推送） |
| **未提交业务改动** | `gui.await` 全套：`apps/agent/src/capabilities/await.ts`（新增 170 行）／`capabilities/index.ts`（+3 注册）／`packages/protocol/.../names.ts`（+1 能力名）／`manifest/graphics.ts`（+57 行契约） |
| 未合并分支 | `ci/workflow-unit-tests`（其贡献**已手工并入** `7ad820c`，分支本身基于 09-29 老 main，直接 merge 会回退上万行，故**只取内容不 merge**，分支可清理） |
| 未跟踪文件 | `docs/ROADMAP.md`（本文档）、`docs/console-plan.md`（大前端方案） |
| Release 资产 | `nodeagent-win-x64.zip`（≈32.9MB，含 Node 运行时）/ `agent.mjs` / `latest.json` / `SHA256SUMS` |

**近期提交脉络**：

```
0d62cb1 (tag v1.5.0)  chore(release): v1.5.0
1c836e0              feat(v1.5): 快捷键控制范围扩展（字符串热键/预设别名/长按/后台定向投递）
0ee8231              feat(v1.2): 媒体键 WM_APPCOMMAND 通道 + 定向投递
42ec556 (tag v1.4.3) chore(release): v1.4.3
7ad820c (本地 HEAD)   ci: 补全 Windows 真机验证        ← 未推送
[工作区未提交]        feat(v1.6): gui.await 等待条件    ← 在建
```

### 2.2 代码与测试

| 项 | 数值 |
|---|---|
| `apps/` 代码量 | 12,201 行 TS（agent / cli / hub / mcp）+ `await.ts` 170 行（在建） |
| `packages/` 代码量 | 3,620 行 TS（client / protocol）+ manifest 57 行（在建） |
| 合计 | **约 1.58 万行** |
| 单测 | 18 个文件 / **195 例：194 通过、1 失败**（本地实跑） |
| e2e | 2 个套件（`run.mjs` 通用 29 例 / `windows.mjs` Windows 专属 13 例） |
| **`gui.await` 覆盖** | **0** —— 单测、e2e、CLI、MCP 均无 `gui.await`/`GuiAwait` 命中 |

> ⚠️ 单测数从 162 增至 195（新增 33 例，来自 v1.5 快捷键的按键表覆盖断言），但**红了一例**：`tests/unit/capabilities.test.mjs:66` 的 `assert.equal(CAPABILITY_MANIFEST.length, 42)`，实际 43。**修法**：改为 43，或更稳妥地改成「断言每个 `CapabilityNames` 键都在 manifest 中」以免每加一能力都要改数。

**最大的三个文件**（后续拆分候选）：

| 文件 | 行数 | 说明 |
|---|---|---|
| `apps/mcp/src/index.ts` | 1000 | MCP 工具定义全集中，协议前缀 `na_` |
| `apps/agent/src/capabilities/window.ts` | 963 | UIA 枚举 + 模板匹配 + OCR 三条路径 |
| `apps/agent/src/capabilities/network.ts` | 747 | 两阶段提交网络变更 |

### 2.3 能力清单（43 项，以 `packages/protocol/src/capabilities/names.ts` 为准）

| 域 | 能力 |
|---|---|
| **系统与命令**（5） | `system.info` `system.status` `system.process.list` `system.service.list` `system.shell.exec` |
| **软件**（2） | `app.list` `app.install`（winget 静默优先） |
| **屏幕与录制**（4） | `screen.info` `screen.capture` `screen.record` `screen.find` |
| **输入**（6） | `input.mouse.move` `input.mouse.click` `input.mouse.scroll` `input.mouse.drag` `input.key.type` `input.key.press` |
| **窗口**（2） | `window.list` `window.focus` |
| **GUI 等待**（1） | **`gui.await`** 🆕 v1.6 在建未提交 —— 等条件成立再返回 |
| **文件**（4） | `fs.list` `fs.stat` `fs.read` `fs.write`（分块 RPC + 原子写） |
| **剪贴板**（2） | `clip.get` `clip.set` |
| **异步任务**（3） | `system.task.list` `system.task.get` `system.task.kill` |
| **审计与指标**（3） | `system.audit.list` `system.audit.verify`（哈希链） `system.metrics` |
| **事件订阅**（4） | `event.watch` `event.unwatch` `event.list` `event.poll` |
| **自持与更新**（2） | `system.agent.restart`（走计划任务） `system.agent.update`（拉取式，校验 sha256） |
| **音频**（2） | `system.audio.get` `system.audio.set`（Core Audio COM） |
| **网络变更**（3） | `system.net.apply` `system.net.confirm` `system.net.status` |

**`gui.await` 设计要点**（工作区在建，v1.6）：

| 项 | 内容 |
|---|---|
| 四类条件 | `window` / `control` / `process` / `file`，各自复用既有 `window.list` / `screen.find` / `process.list` / `fs.stat` —— **零新增平台探测代码**，Windows/macOS 行为与底层能力完全一致 |
| 两个状态 | `state=present`（默认，等出现）／`absent`（等消失） |
| 参数 | `timeout_ms`（0~60000，默认 5000）／`interval_ms`（50~5000，默认 400） |
| 返回 | `{satisfied, condition, state, elapsed_ms, attempts, last_seen, last_error?, note?}` |
| **超时是正常返回** | 返 `satisfied:false` + `last_seen` + `note`，**不抛异常** —— 避免上层反复重试。`last_error` 带回末次异常，用于区分「真的没有」与「每次都在报错」 |
| 轮询期异常 | 视为「尚未命中」并记录，不让单次抖动整句失败（启动中的程序常短暂报错） |
| 风控 | `risk: 'low'`（纯只读），`additionalProperties: false` |

典型编排：

```
await gui.await(condition:"control", text:"完成", timeout_ms:30000)
  → input.mouse.click(命中坐标)
  → gui.await(condition:"control", text:"安装中", state:"absent")
```

> v1.5.0 未新增能力名，而是**扩展了 `input.key.press` 的参数面**：字符串热键 `hotkey: "ctrl+shift+esc"`、约 50 个预设别名（`copy` / `show_desktop` / `task_manager` / `volume_mute_toggle`…）、`hold_ms` 长按、`route=post` + `target_pid` 后台定向投递；按键表补齐左右侧修饰键、小键盘、OEM 符号键（解锁 `win+d` / `ctrl++` / `win+.`）、IME 键。**这些是同一能力内的行为扩展，不改协议结构**。

安全机制（不计入能力数）：挑战-应答握手、nonce 一次性、能力级 ACL（deny → allow → 默认拒绝）、调用限速、审计链、证书指纹钉住（TOFU）、来源网段白名单 `allow_from`、每客户端独立 PSK、发现广播最小化 + HMAC 签名、键鼠默认禁用。

---

## 三、与复盘文档的对照

`docs/RETROSPECTIVE.md` 写于 2026-09-28（当时 19 项能力）。逐项核对，**多数 P0/P1 已解决**，文档本身已过期：

| 复盘当时的判断 | 现状 | 落点 |
|---|---|---|
| **P0** UI 元素定位缺失 | ✅ 已解决 | `screen.find`（UIA → 模板匹配 → OCR 三级降级，返回 `engine`） |
| **P0** 受控重启缺失 | ✅ 已解决 | `system.agent.restart`（借计划任务，任务名带时间戳） |
| **P0** 编码未统一 UTF-8 | ✅ 已解决 | v7 UTF-8 全链路；`.ps1` 带 BOM / `.cmd` 纯 ASCII+CRLF / `.json` 无 BOM，三套规则有单测守卫 |
| **P0** exec 输出污染 | ✅ 已解决 | 结构化 `{stdout, stderr, exit_code, duration_ms}` |
| **P1** 长任务异步化 | ✅ 已解决 | `system.task.list/get/kill` |
| **P1** 剪贴板 | ✅ 已解决 | `clip.get` / `clip.set`（软失败需重试 + 读回校验） |
| **P1** 窗口管理 | ✅ 已解决 | `window.list` / `window.focus`（`window.rect` 无独立能力，rect 由 list 返回） |
| **P1** CLI 无连接复用 | ✅ 已解决 | `apps/cli/src/daemon.ts` + `nodeagent daemon start` |
| **P1** 定时采样 / 监控 | ❌ **未做** | 无 `monitor.*` 能力（grep 命中 0） |
| **P1** GUI 操作需可断言 | 🚧 **在建** | `gui.await` 已实现未提交（等 window/control/process/file 出现或消失）；属性条件与组合未做 |
| **P2** 文件监控 `fs.watch` | ❌ **未做** | grep 命中 0 |
| **P2** 日志聚合 `log.query` | ❌ **未做** | grep 命中 0 |
| **P2** 录屏 | ✅ 已解决 | `screen.record` |
| **P2** 键盘宏 / 鼠标拖拽 | ✅ 已解决 | `packages/client/src/macro.ts` + `input.mouse.drag` |
| **P2** 并发 RPC | ⚠️ 部分 | WS 单连接仍串行批量；daemon 缓解了重连成本，未解决单连接并发 |
| **P2** 多设备并行 | ❌ 未做 | 仍需 `--node` 串行切换 |

**结论**：复盘 §十的三个短板，「自持」已彻底解决，「语义」解决了一半（能找到，读不懂），「状态」只补了事件通知，采样留存仍是空白。

---

## 四、待办一：收尾

### 4.0 ⚠️ 推送前必须先脱敏（优先级高于一切）

第九轮隐私审查发现：**`0ee8231` 与 `1c836e0` 两个已推送提交都带真机痕迹**，其中设备软件清单已在公开面：

| 位置 | 内容性质 | 状态 |
|---|---|---|
| `0ee8231` 提交信息 | 真机内网地址 + 具体软件名（详见该提交） | **已推送** |
| `1c836e0` → `apps/agent/src/capabilities/input.ts:145,146,163,410` | 注释含具体播放器名与游戏名 | **已在 origin/main** |
| `1c836e0` → `apps/agent/src/capabilities/input-script.ts:29,32` | 同上 | **已在 origin/main** |

这构成**设备软件清单 + 使用习惯**的公开暴露（哪台机器装了哪些软件、常在什么场景下远程控它）。比单纯的 IP 泄露更难辩解 —— IP 会换，软件清单是稳定画像。

处置建议（按代价排序）：

| 方案 | 代价 | 效果 |
|---|---|---|
| **A. 只清未来**（最低） | 0 | 新增代码与提交信息一律脱敏，历史不动。仓库公开仍有痕迹 |
| **B. 清注释 + 清未来**（臣建议） | 半小时 | 源码注释泛化为「主流播放器」「全屏游戏」，不动历史 |
| **C. B + 改写历史** | 需 `git filter-repo` + force push | 连历史一并清，但**旧 blob 已被匿名抓取过，改写不等于收回** |

> ⚠️ 关键认知：**已推送到公开仓库并被匿名抓取过的内容，改写历史无法收回**。旧 blob 只能靠 GitHub Support GC，而 Support GC 本身也非保证。因此现实目标应是「**止血 + 不再恶化**」，即方案 B。

**具体要改的注释**（脱敏后按此句式重写，勿照抄原词）：

| 原文式（不复述） | 改为 |
|---|---|
| 「远程控制某播放器 / 某云音乐」 | 「远程控制主流媒体播放器」 |
| 「某音乐会建 30+ 辅助窗口」 | 「部分播放器会创建大量辅助窗口」 |
| 「某游戏全屏遮挡时」 | 「全屏独占应用遮挡时」 |

### 4.1 推送 CI 提交

- **现状**：本地 `7ad820c` 领先远端 1 个提交，仅改 `.github/workflows/windows-e2e.yml`（+61 行）。
- **内容**（三段护栏，全部来自 10-04 真机事故复盘）：
  1. **单测步骤** —— 把 `pnpm test:unit` 并入 Windows E2E 工作流。该内容取自 `ci/workflow-unit-tests` 分支（`4d73d6e`）；因该分支基于 09-29 老 main，直接 merge 会**回退上万行**，故只取提交内容手工并入。
  2. **5.1 BOM 解析守卫** —— 刻意用 `cmd` 调 `powershell`（5.1）而非 `pwsh`。5.1 读无 BOM 的 `.ps1` 会按 ANSI/GBK 解析，中文注释破坏字符串边界 → 整份脚本 ParseError。此前全用 pwsh（7+ 认无 BOM UTF-8），所以**CI 绿、真机炸**。这道守卫只问一件事：5.1 能否读懂 —— 而这就是真机的核心约束。
  3. **install.cmd / control.cmd 双击链路冒烟** —— 这两个脚本是用户唯一上手入口，编码或语法坏了只有真机 cmd.exe 测得出。
- **收尾**：推送后可清理 `ci/workflow-unit-tests` 分支（贡献已并入，留着只会误导）。

### 4.2 v1.5.0 真机验证尚未做（v1.5 提交信息自陈）

`1c836e0` 的提交信息里写明：

> ⚠️ **真机未验证**：Windows 被控端当前离线（连接超时）。待上线后需验……

即v1.5.0 是**未经真机验证就发的版**。待办：

```
node scripts/verify.mjs --host <地址> --key <密钥> --report <报告.md>
```

重点验四项（提交信息已列）：字符串热键 `hotkey`、预设别名、长按 `hold_ms`、后台定向投递 `route=post`。其中后台定向投递需复验「窗口被遮挡时是否真有效」—— 这条机制此前只在媒体键通道验证过，等价推断需实测坐实。

### 4.3 大前端方案（`docs/console-plan.md`，已出文档待评审）

盘点期间新增了一份前端方案文档，臣不在此展开（详见该文档），仅提示它引入了**一个新包 `crates/nodeagent-client`（Rust）**，与现有 TypeScript 的 `@nodeagent/client` 并存 —— 意味着 client 层有两套实现。这本身是个需要皇上拍板的架构决策（详见该文档的待确认项）。

---

## 五、待办二：三个开发方向

### 方向一：语义 —— 从「能找到」到「可断言」

**判断**：`screen.find` 的能力边界已经够用，缺的是**返回值的信息量**与**操作后的状态断言**。原来的链条是「点 → 截图 → 目测 → 再点」。

**当前进度：第一步已落地（在建），第二步未做。**

| # | 改动 | 状态 | 说明 |
|---|---|---|---|
| 1 | **新增 `gui.await` 等待条件** | ✅ **已实现，未提交** | 四类条件（window/control/process/file）× 两态（present/absent）；复用既有能力，零新增平台探测代码；超时**正常返回**不抛异常 |
| 2 | `screen.find` 返回 UIA 属性 | ⬜ 未做 | 补 `name` / `value` / `enabled` / `selected` / `rect` / `automation_id` |
| 3 | 条件组合（`and` / `or` / `not`） | ⬜ 未做 | `gui.await` 目前是单条件；组合需先有属性支持 |

#### `gui.await` 收尾清单（**提交前必做**）

| # | 事项 | 说明 |
|---|---|---|
| 1 | **修能力数断言** | `tests/unit/capabilities.test.mjs:66` 硬编码 42 → 实际 43，**当前单测是红的**。建议改成「断言每个 `CapabilityNames` 键都在 manifest 中」，避免每加一能力都要改数 |
| 2 | **补单测** | 当前 `gui.await` 覆盖为 0。至少覆盖：参数校验（非法 condition/state）、`timeout_ms` 上限裁剪、`isHit` 对不同返回形态的判定（`found` / `exists` / 数组 / 布尔）、超时返 `satisfied:false`、轮询期异常不中断 |
| 3 | **补 CLI / MCP 入口** | grep 显示 `apps/cli/` 与 `apps/mcp/` **均无 `GuiAwait` 命中**。若 CLI 走通用 invoke 通道则无需改；若逐能力映射则必须补 |
| 4 | **版本号上调** | `package.json` 仍 `1.5.0`，root + 6 子包。新增能力名 → MINOR → **v1.6.0** |
| 5 | 真机验证 | 至少验一次「等窗口出现 → 点击 → 等元素消失」完整编排。`gui.await` 是**阻塞调用**，需确认 `timeout_ms` 上限（60s）不会撞上 WS 心跳/超时机制 |
| 6 | 发版 | `node scripts/release.mjs` → v1.6.0 |

**验收标准**：

- 「等某窗口出现某控件」在设定 timeout 内命中，返回 `attempts` 与 `elapsed_ms`；
- 条件永不满足时返回 `satisfied:false` + `last_seen`，**不抛异常**；
- 条件本就「不存在」时立即返回（`attempts:1`），不等满 timeout。

#### 第二步：`screen.find` 属性化（后续）

这是方向一的**真正深水区**。`gui.await` 解决「等得到出现/消失」，但等不到「等它变成某状态」：

| 改动 | 内容 | 验收标准 |
|---|---|---|
| `screen.find` 返回 UIA 属性 | 在现有坐标之外补 `name` / `value` / `enabled` / `selected` / `rect` / `automation_id` | 对某个真实界面能读出 enabled 状态随播放状态变化 |
| `gui.await` 支持属性条件 | predicate 可比较 `enabled` / `selected` / `value` | 能表达「按钮出现 **且** enabled」 |
| 条件组合 | `and` / `or` / `not` | 能表达「弹窗出现 且 其中某按钮 enabled」 |

**为什么仍排第一**：GUI 接管是 v2 的核心价值，也是当前唯一还「不好用」的域。`gui.await` 只是把「盲试」变成「有耐心的盲试」—— 补上属性比较后，才真正变成可断言。

**风险**：`gui.await` 是**阻塞式调用**，必须有 `timeout_ms` 上限（已设 60s 上限 ✓）；超时属正常返回（已实现 ✓）。第二个风险：`screen.find` 的 UIA 属性读取在部分应用上可能拿到空值（Electron / 游戏 UI 常见），需能优雅降级为「仅坐标 + found」。

### 方向二：状态 —— 治间歇性问题

**判断**：复盘 §四那条判断仍成立 —— 代理不通、杀软拦截都是**间歇性**的，而臣只能看当下快照。`event.watch` 解决「有事件时通知」，没解决「持续记录并回看」。

| 能力 | 设计 | 验收标准 |
|---|---|---|
| `monitor.start` | `{ interval_ms, command \| metric, duration_ms }` → 落盘，返回 `id` | 对某连接端口跑 5 分钟 / 每 2 秒采样，事后能拿到完整时间序列 |
| `monitor.report` | `{ id }` → 返回采样序列 + 摘要（min/max/均值/异常点） | 能直接回答「5 分钟里断过几次、最长断了多久」 |
| `log.query` | `{ path, since, level, pattern, limit }` —— **被控端侧过滤** | 10 万行日志中按 pattern 查 20 条，不整份拉回 |
| `fs.watch` | `{ path, recursive, filter }` → 走事件订阅通道推送 | 监听配置文件变更，变更事件 ≤2s 内到达 |

**关键点**：`log.query` 必须过滤在 Windows 侧。当前 `fs.read` 虽有 8MB 上限，但拉大日志既慢又占带宽，治标不治本。

### 方向三：安全 —— 剩余四项

`docs/SECURITY.md` §5 自列的未做项：

| 项 | 现状 | 建议 |
|---|---|---|
| **握手失败封禁** | 只计数 + 记审计，无按 IP 拉黑 | 加指数退避封禁（如 5 分钟内失败 10 次 → 临时拉黑 1 小时），可配置白名单豁免 |
| **会话上限与空闲断开** | 无最大连接数、无空闲超时 | 上限防资源耗尽；空闲断开（如 30 分钟无调用）释放资源 |
| **安装期密钥传递** | `install.cmd` 用命令行 `-Key` 传参，**同机其他用户 `ps` 可见** | 改走 stdin 或临时文件（600 权限，读后即删）。这是唯一还没堵住的密钥暴露面 |
| **审计链外部锚定** | 哈希链可被「有 root 的攻击者」整链重写 | 定期把链头哈希同步到独立位置（如 Hub 或另一台机器），重写即暴露 |

**臣另建议一项**：**ed25519 默认化**。`SECURITY.md` §2 已写明 PSK 模式的固有限制（`client_id` 自报 → ACL 身份维度形同虚设）。v22 的每客户端独立 PSK 只是缓解 —— 持有共享 key 的人仍可冒充未登记的 client_id。新装默认应走 ed25519，PSK 降级为「兼容存量」并在安装时明确告警。

---

## 六、待办三：隐私收敛（已连续多轮 P1，该决断）

### 6.1 已暴露且无法收回

| 项 | 状态 | 处置 |
|---|---|---|
| **设备软件清单已在公开面** | `input.ts` / `input-script.ts` 注释含具体播放器与游戏名（见 §4.0） | 泛化注释（方案 B）；历史不追 |
| **2 个含PII 的 blob 匿名可直取** | 旧提交中的 blob 用 40 位完整 SHA 即可匿名读取，已连续 6 轮未消；内容含本机用户名与真实目录名 | 报 GitHub Support 申请 GC，或删库重建。**这是唯一的「真泄露」** |
| **提交信息含真机内网地址** | 5 条 commit message 含内网 IP 与端口 | 公开且被搜索引擎收录。后续禁止在 message 写真机地址 |
| **Windows 账户名** | 硬编码在 `network.ts:96` | 改为从配置或环境变量读取 |
| **网卡名「Ethernet」+ 网段常量** | 测试与源码中多处 | 同上，注入式配置 |

### 6.2 尚未暴露，立即处置

| 项 | 处置 |
|---|---|
| `.gitignore` 缺 `keys/`、`*.key`、`*.pem` | 立即补（当前已有 `**/PSK.txt`、`../win-backup/`） |
| `input.ts:324` 附近含 3 个 U+FFFD 字面量 | 编码缺陷，顺手修 |

### 6.3 脱敏约定（本文档已遵守，后续继续遵守）

本文档不出现任何真机地址、端口、账户名、密钥，一律用 `<地址>` / `<密钥>` 占位。代码与测试中的真实值应逐步改为从配置或环境变量读取。

**新增约定**：提交信息与源码注释**不得出现具体软件名、设备名、真实地址**。举例子：「实测某播放器被某游戏全屏压住」→「实测主流播放器被全屏游戏遮挡」；真实内网地址→「控制端内网地址」。

> **教训**：本轮暴露的根源不是泄露了密钥（那类已按等式法核验并修复），而是**注释里写「为什么这么做」时顺手写了真实环境**。真实环境信息对理解原理无帮助，却直接画像了使用者。以后写注释，理由归理由，实况归实况。

---

## 七、建议排期

| 序 | 事项 | 预估 | 依赖 |
|---|---|---|---|
| 0 | **修 `gui.await` 能力数断言**（42→43，当前单测红） | 5 分钟 | 无（**提交前必做，否则 CI 必红**） |
| 0.5 | **脱敏**：泛化 `input.ts` / `input-script.ts` 注释里的软件名 | 20 分钟 | 无（**先于一切推送**） |
| 1 | `gui.await` 收尾：补单测 + CLI/MCP 入口 + 版本号 v1.6.0 + 真机验证 + 发版 | 1 天 | 序 0 |
| 2 | 推送 CI 提交 + 清理 `ci/workflow-unit-tests` 分支 | 10 分钟 | 序 1 |
| 3 | **v1.5.0 真机验证**（该版未经真机就发了） | 半天 | 被控端在线 |
| 4 | 方向一第二步：`screen.find` 属性化 + `gui.await` 支持属性条件 + 条件组合 | 2~3 天 | 序 1 |
| 5 | 方向三：`install.cmd` 密钥改 stdin + 握手封禁 + 会话上限 | 1~2 天 | 无（安全项建议提前插队） |
| 6 | 方向二：`monitor.*` + `log.query` + `fs.watch` | 2~3 天 | 无 |
| 7 | `.gitignore` 补密钥规则 + 源码真机常量注入化 | 分散 | 无 |
| 8 | PII blob 报 Support GC / 决定是否重建仓库 | — | **需皇上决策** |
| 9 | `ed25519` 默认化 | 1~2 天 | 需确认向后兼容策略 |
| 10 | `console-plan.md` 评审：Rust client 与 TS client 双实现取舍 | — | **需皇上拍板** |

**臣的建议**：

- **序 0 立刻做**。5 分钟的事，但不做则单测红、CI 必红。注意建议顺手把断言改成「每个 `CapabilityNames` 键都在 manifest 中」——否则每加一能力都要改数字，这类「硬编码计数」会反复咬人。
- **序 0.5 紧接着做**。只改注释，20 分钟，零风险，但能阻止「设备软件清单」继续扩散。`gui.await` 也正好是新代码，此时立脱敏规矩最自然。
- **序 1 是当前主线**。`gui.await` 实现已完成（170 行 + 57 行契约 + 注册），设计也站得住（超时正常返回、轮询期异常不中断、复用既有能力零新增探测代码）。差的只是收尾四件事：单测、CLI/MCP 入口、版本号、真机验证。**建议一次做完再提交，不要分批**。
- **序 3 优先级高于新功能**。v1.5.0 是**未经真机验证就发的版**，其中「后台定向投递」只在媒体键通道验证过、等价推断未经实测。
- **序 5 可提前**。`install.cmd` 密钥经命令行传参（同机 `ps` 可见）是当下唯一未堵住的密钥暴露路径，改动局限在一个脚本内。
- **序 8、10 需皇上决策**：前者关系到公开历史能否部分收回，后者关系到是否长期维护两套 client 实现。

> **一条经验**：`gui.await` 一次加能力就让单测红，原因是能力数被硬编码成 `42`。这类「计数断言」在持续加能力的项目里必然反复失效。**改为集合断言**（每个能力名都在 manifest 中）比每次改数字更省事，也更不容易漏检。

---

## 八、附：本文档的核查方法

| 结论 | 核查方式 |
|---|---|
| 版本与提交差距 | `git fetch` 后比 `git log origin/main..HEAD`（**必须先 fetch** —— 盘点期间远端已推进到 v1.5.0，本地缓存的 origin 是过期的） |
| 能力清单 | 读 `packages/protocol/src/capabilities/names.ts` 全量枚举 |
| 遗留能力未实现 | 对 `fs.watch` / `log.query` / `monitor.` / `serve` / `daemon` 逐个 grep 源码，命中 0 即未实现 |
| 单测状态 | 本地 `node --test "tests/unit/**/*.test.mjs"` → **195 例：194 pass / 1 fail**（`capabilities.test.mjs:66` 能力数断言 42≠43） |
| 复盘对照 | 逐条读 `docs/RETROSPECTIVE.md` 的 P0/P1/P2 表，与能力清单交叉 |
| `gui.await` 完成度 | 分别 grep `tests/` `apps/cli/` `apps/mcp/` 找 `gui.await`／`GuiAwait`／`guiAwait` —— 三处均 0 命中 → 单测与两端入口都还没接|
| 安全残余 | 读 `docs/SECURITY.md` §5「还没做的（后续批次）」 |
| 公开面暴露 | `git fetch` 后 `git grep <关键词> origin/main` —— **必须先 fetch**（否则查的是过期快照），且**关键词要带空格变体**（`XX音乐` / `XX 音乐`），否则会漏 |

> **两条教训**：
> 1. 跨平台差异（编码、文件重命名、进程语义）**必须在真机验证** —— macOS 通过不代表 Windows 通过。文档层面的盘点只能发现「没写」，发现不了「写错了但没人跑」。
> 2. **`git grep` 不 fetch 会查旧快照**。本次差点把「未推送」误判成「未暴露」，实际远端已含该内容。凡涉及「公开面是否暴露」的结论，必须 `git fetch` 后再查，且关键词要带空格变体。