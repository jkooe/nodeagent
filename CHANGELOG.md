# 变更日志

本文件记录 nodeagent 的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [未发布]

> 主题：**控制台「去命令行化」** —— 双击应用即用，启停/重启/更新/日志/托盘常驻/开机自启全部在界面里完成。
> 目标原文：「不再打开命令行窗口，运行应用之后，有启动、停止、重启、检查更新等功能，
> 有日志功能，可以后台运行和开机自启等等功能」。
>
> 末段另含两轮纯界面调整：**一律不使用图标**（emoji 在部分渲染器里退化成豆腐块）、
> **配色收敛为「简约白 / 高级灰」两套中性灰阶主题**。

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

### 新增 —— 契约守卫（`tests/unit/console-commands.test.mjs`，8 用例）

把「改了名字两边不同步、但不报错」的三类**静默失效**钉死，避免「界面点了没反应、控制台无异常」：

| # | 守卫 | 抓什么 |
|---|---|---|
| 1 | 前端每个 `invoke("x")` 都已在 Rust `generate_handler!` 注册 | 前端调了个不存在的命令 → 运行时才 `not found` |
| 2 | Rust 注册的命令都被前端使用 | 死命令堆积（改名后残留的旧命令） |
| 3 | `emit("na-*")` ⇄ `listen("na-*")` 双向一致 | 事件名不匹配 → **界面永远不刷新，且无任何报错** |
| 4 | `tauri.bundle.gen.json` 资源目标名 ⇄ Rust `resolve_*` 字面量 | 映射改名 → 生产包内找不到 sidecar/node/agent |
| 5 | sidecar 方法名 ⇄ Rust `.request("x")` | 跨语言调用错名 |
| 6 | 新页面已注册路由 + 默认路由指向 `/local` + 懒加载的 view 文件真实存在 | 「写了页面但进不去」／循环依赖导致的路由表推导失败 |
| 7 | 自定义样式用到的 `var(--na-*)` 都由 `cssVars()` 定义 | 拼错变量名**不报错**，颜色只是静默落回继承值 —— 类型检查、构建、运行全都不吭声 |
| 8 | `index.html` 的首帧兜底色 ⇄ 调色板的 `bg` | 首帧底色是全应用**唯一允许的色值重复处**；允许重复就必须有守卫 |

> **已注入故障实测会红**：① 把 `agent_start` 改成 `agent_startX`、`na-agent-state` 改成 `na-agent-statee`
> → 当场 2 条失败；② 把某处 `var(--na-sunken)` 拼成 `var(--na-sunkenTypo)`（含大写）与 `var(--na-sunkenx)`
> → 第 7 条均失败；③ 把 `index.html` 的 `#f4f4f5` 改回 `#ffffff` → 第 8 条失败。
> 全部复原后 `#pass = 8 / #fail = 0`，文件逐字节还原。未验证过会红的守卫等于没有守卫。
>
> 第 7 条的正则刻意放宽到 `[^)\s,;]+` 而非 `[a-z0-9-]+` —— 后者遇到含大写的拼错会在中途停下导致
> **整个模式不匹配**，于是「写错的变量名」反而逃过检查。这是注入故障时才发现的守卫自身漏报。

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

### 新增 —— Windows 端控制台安装包（`.github/workflows/console-windows.yml`）

控制台此前**只在 macOS 上出过包**（`.app` / `.dmg`），而它的主战场恰恰是
「在 Windows 上管控其他机器」。本轮补上 Windows 构建：**双架构矩阵** ——
`windows-latest` 出 x64 `.msi` + NSIS `-setup.exe`，`windows-11-arm` 出 arm64 NSIS `-setup.exe`。

- **为什么必须双架构**：与 v2.0.2 那次事故同源 —— 包里装着错架构的 `node.exe` 时，
  ARM Windows 上「能启动、能 listen，但 TLS 握手不完成」，而 macOS 侧 100% 复现不出。
  控制台更甚：它内含 node 运行时，还要用这个 node **托起本机被控端**，即自己就是 TLS 服务端。
- **为什么用原生 ARM runner 而非交叉编译**：`prepare-console.mjs` 的自检要**真执行 `node.exe`**，
  x64 机器跑不了 arm64 二进制；交叉编译会逼着引入「跳过自检」这类**削弱验证**的开关 ——
  而产出错架构运行时的时候，自检正是唯一能拦住它的那道闸。
- **`cfg!(windows)` 分支第一次被编译器看到**：macOS 上的 `cargo check` **不会编译 `cfg(windows)` 代码**，
  故 `taskkill` 收进程树、PowerShell 计划任务、`node.exe` 路径等分支此前从未产出过 Windows 产物。
- **实测产物**：x64 `.msi` **34.2 MiB** ／ NSIS **23.2 MiB**；arm64 NSIS **19.5 MiB**（均低于 40MB 目标）。
  `if-no-files-found: error` + `fail-fast: false`：一条架构没产出就报错，同时一条挂了不掩盖另一条的结果。
- **尚未接入 `scripts/release.mjs`**：安装包目前只作为 CI artifact 产出，未随 Release 发布。

> **首个 run 两个 job 全红，但错的不是构建，是断言。**（run `38151366534`）
> 两个 job 的失败点完全一致，而日志显示构建链路**一路全绿**：构建机架构（arm64 runner 上
> `process.arch = arm64`，原生属实）、随包 `node.exe` 的 PE Machine（`0x8664` / `0xaa64`）、
> `tauri build`、产物自举（打包内 node v22.23.3 真跑起打包内 sidecar）四步全 success。
> 死掉的是本步自己写的守卫 —— 原断言「安装包体积 > 50MB」，理由是「含 Node 运行时约 80MB」，
> 这**把未压缩的目录形态（`.app` ≈ 92 MiB）当成了压缩安装包的体积**：
> LZMA 下 `node.exe` 自身能压到 1/3～1/4，实测 `.msi` 34.2 MiB、NSIS 19.5～23.2 MiB，阈值必然误杀。
>
> 更根本的问题是：**体积阈值属于「中间逻辑自洽」式断言**。包大不等于 `node.exe` 真在里面
> （可能打进的是别的大文件），包小也不等于没在里面（压缩率会随 Node 版本漂移）。
> 判据必须落在**产物内容**上，不能落在**间接指标**上。
>
> 改为**解开安装包查内容**（`.msi` 走 `msiexec /a` 管理安装、NSIS 走 `/S /D=` 静默安装，
> 两者都是各自格式的核心能力，不引任何外部依赖），一次钉死三件事：
> ① `node.exe` / `sidecar.mjs` / `agent.mjs` **三样随包资源必须都在**（缺任一，真机上就是
> 「应用能开、但托不起被控端」）；② `node.exe` 的 **PE Machine = 目标架构**（最终交付物级架构断言）；
> ③ `node.exe` 解压后 **> 40MB**（体积在这是**正确用法**：内容已验明后的自明性检查，
> 而不是「运行时在不在」的**替代判据**）。附带收益：**真装一遍本身就是安装器冒烟**。
> 另给该步加 `timeout-minutes: 8`，避免静默安装万一卡住把 job 拖满 60 分钟。
>
> **第二个 run（`38152850819`）两 job 仍同点红，但已是另一处原因，且同样是静默失效**：
> 日志里 `msiexec /a 失败（退出码 ）` —— `$LASTEXITCODE` 是**空的**，而整步从开始到抛错
> 只过了 **0.8 秒**。根因是 `msiexec.exe` 与 NSIS 安装包都是 **GUI 子系统程序**，
> PowerShell 用 `&` 调用时**既不等待其结束、也不设置 `$LASTEXITCODE`**
> （`$null -ne 0` 判真 → 安装器还没跑完就抛错，报错读起来像「安装失败」，实为「压根没等」）；
> arm64 那条没有 MSI、直奔 NSIS，失败形态一模一样，正是同一根因的第二个样本。
> 修法：改 `Start-Process -Wait -PassThru` 读 `.ExitCode`；参数拼成**单个字符串**传，
> 避免数组被自动加引号而破坏 NSIS `/D=` 的「原样、不加引号、且居末」硬要求；
> 加 `Wait-PayloadRoot`（30 秒收敛）防安装器「自己先退出、子进程继续装」的竞态误报。
>
> **第三个 run（`38154282653`）双绿**，断言给出产物实证 —— x64 `.msi`/`-setup.exe` 内均解出
> **`node.exe` 82.9 MB / PE `0x8664`**、arm64 `-setup.exe` 内解出 **`node.exe` 73.5 MB / PE `0xaa64`**，
> 三样随包资源齐全（sidecar 232 KB、agent 1060 KB）。
> 这一步证明的恰是体积断言永远无法区分的那件事：**19.5MB 的压缩包里真的装着 73.5MB 的 arm64 运行时**。

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

### 变更 —— 配色收敛为两套中性灰阶主题

- **两套可切换主题：`简约白`（浅）与 `高级灰`（深）**，侧栏底部一行切换，选择存 `localStorage`。
  两套都**只用中性灰阶**：去掉原先的青色品牌字（`#63e2b7`）与 naive-ui 默认的绿色主色，
  主按钮 / 开关激活态 / 进度条 / 勾选框统一改吃「主色位 = 中性灰」这一个值。
  - 白主题的**页底刻意不是 `#ffffff`**（`#f4f4f5`）：卡片本身是白的，两者同色就只能靠 1px 分线撑层次，
    整页发「糊」；压一档浅灰后层次为「页底 < 侧栏 < 卡片」，且仍是白为主。
- **语义色不是去掉，而是降饱和**（灰绿 / 灰琥珀 / 灰红 / 灰蓝）。
  这是运维工具，`运行中 / 出错` 必须一眼可辨，全部灰化会导致误读；故它们只出现在徽章与告警这类小面积上，
  底色观感仍是「白 + 灰」。严重程度在关闭图标后本就更依赖 `type` 的底色/边框。
- **色值只有一份定义**（`src/theme/index.ts` 的 `Palette`）：既生成 naive-ui 的 `themeOverrides`，
  又由 `App.vue` 在运行期注入成 `--na-*` CSS 变量供自定义样式使用。
  原因是若「TS 调色板」与「CSS 写死的色值」各存一份，换主题时会**一半新一半旧且不报错、类型也抓不到**
  —— 这正是本轮要消灭的失效模式。
- **清掉 17 处写死的色值**（散在 8 个文件：日志三流着色、代码块/预览底色、节点选中边框、历史悬停等），
  全部改为 `var(--na-*)`。复扫后自定义样式里的硬编码色为 **0**。
- **主题偏好只存 `localStorage`，不落 Rust 侧 settings**：那是给「仅服务模式」（无窗口、常驻托盘）
  也要生效的偏好用的，而主题是纯图形偏好 —— 没有窗口时毫无意义。为一件纯前端的事去动 Rust 命令面与契约守卫不划算。
- **首帧防闪**：`index.html` 内联一段极小脚本，在 Vue 接管前先把上次主题的底色刷上，
  否则「高级灰」用户每次启动都会看到一帧刺眼的白。此处**刻意重复了 2 个底色值**（真值在 `theme/index.ts`），
  因为在此之前没有任何模块可依赖；已在两处都注明「改底色时同步」。

### 说明 —— 本轮**刻意不升版本号**

本轮新增的全部是**控制台**功能，**被控端能力集合未变**（未增删任何 `system.*` / `fs.*` / `app.*` 能力）。
而 `scripts/lib/bundle-agent.mjs` 会把**根 `package.json` 的 version 注入 `agent.mjs`**（`__AGENT_VERSION__`）：
一旦为控制台功能去升版本号，被控端就会**谎报**一个它并未包含的版本 —— 属版本纪律所禁止。
故版本号维持 **2.0.2**，本批改动记入本节，待真正含被控端变更时由 `pnpm release minor` 一并升号。

### 修复 —— 图形能力在 200% 缩放下坐标错位（真机实证，**属被控端变更**）

> ⚠️ 与上一节结论**不同**：本节改的是**被控端**（`apps/agent/src/**`）。
> 按上一节自己立的规矩，发版时**必须**升版本号（PATCH，→ 2.0.3），
> 否则 `agent.mjs` 会谎报一个并不包含本修复的版本。

真机（Parallels 27 + Win11 ARM64，**200% 缩放**）暴露的缺陷：

被控端的 PowerShell 助手进程**默认 DPI 不感知**，于是**同一个进程里并存两套坐标系**：

| 调用 | 不感知时的结果 | 实际危害 |
|---|---|---|
| `Screen.Bounds` / `SystemInformation.VirtualScreen` | **逻辑**尺寸 1800×1010 | `screen.info` 报错尺寸；`screen.capture` 缺省 region 一并错 |
| `CopyFromScreen` | 按**物理**像素裁剪 | `screen.capture` 缺省**只截到左上 1/4** |
| `SetCursorPos` | 被系统 **×2** | `input.mouse.*` 喂 100,100 → 光标落到 200,200 |
| UIA（`screen.find`） | **物理**坐标（与进程是否感知无关） | 与上面三项**口径不一致** |

净效果：`screen.find` 给出的物理矩形**不能**直接喂给 `input.mouse.*`，必须人工除以 `scale`
（上一轮就是靠这个临时绕法才点中的主题按钮 —— **能绕，但属用户侧的隐式约定，必须消灭**）。

- **新增 `apps/agent/src/util/dpi.ts`**：`PS_DPI_AWARE` 常量，把 `SetProcessDPIAware()` 提到脚本首行，
  并附完整真机实证表与「不要删」警告。
- **注入到全部坐标相关脚本**：`capabilities/screen.ts`（`listDisplays` / `captureWindows`）、
  `capabilities/input.ts`（`buildInputPsScript` ＋ 点击后读回光标那一次）、
  `capabilities/window.ts`（`WIN_HELPER_PRELUDE` —— `window.list` / `window.focus` 都走它）、
  `capabilities/record.ts`（全屏探测）。
- **从 OCR 前奏的 `try{}` 里移除** `SetProcessDPIAware`（`win-ps/prelude-ocr.ts`）：
  放在 `try` 里一旦抛错就被 catch 吞掉 → 助手静默退回不感知。
- **新增 8 条守卫（`tests/unit/dpi-awareness.test.mjs`）**，关键设计是**断言「实际下发的脚本文本」
  而非「源码里出现过常量」** —— 首版用源码扫描，注入故障实测**不会变红**（同文件别处也引用了该常量）；
  改为断言 `buildInputPsScript()` / `buildListDisplaysScript()` / `buildCaptureScript()` / `WIN_HELPER_PRELUDE`
  的脚本串后，二次注入故障**精准变红**。另含一条「`::SetProcessDPIAware()` 恰好出现 1 次」防重复注入
  （正则用 `::` 区分**调用**与 P/Invoke **声明**，否则把声明也算一次 → 误报 2 次）。
- **修复后真机复验（三项全过，零换算）**：

  | 断言 | 结果 |
  |---|---|
  | `screen.info` | 报 **3600×2020**，与裸 `GetSystemMetrics`（感知后）一致 ✅ |
  | `input.mouse.move(x,y)` → 读回光标（物理） | 四次抽样**精确等于** (x,y) ✅ |
  | `screen.find` 物理矩形 → `input.mouse.click` **直接点击** | 移动后光标 = 物理中心；主题单选框 `selected` 翻转且**可逆** ✅ |

### 修复 —— 安全加固批次：18 条实机复现缺陷（**属被控端变更**）

> 来源：一轮「静态审查 + 真机实测」的完整缺陷普查（报告 `bug-report-2026-10-13.html`）。
> 基线 v2.0.2 / `ad90634` 上 `test:unit` **291/291** + `test:e2e` **30/30** **全绿** ——
> 也就是说 **18 条全部落在既有覆盖之外**。分级 **2×P0 / 5×P1 / 10×P2 / 1×P3**。

#### P0-1 命令注入（`window.focus` 的 `title`）—— 而且它是**静默**的

原实现把 `JSON.stringify(title)` 直接插进 PowerShell 的**双引号**串。PS 里 `\` 不是转义符，
双引号串还会做变量插值与 `$(...)` 展开 —— 于是 `title` 里的 `"; <命令>; "` 被当代码执行。

真机实测里最险的一点：**接口返回的是「正常业务错误」**（`E_EXECUTION_FAILED: 未找到匹配的窗口`），
而 payload 已经把文件创建出来了 —— 调用方从返回值里完全看不出异常。

- 新增 `apps/agent/src/util/quote.ts`：`psLit` / `shLit` 作**单一真源**
  （PS 用 `''` 转义、sh 用 `'\''`），另加 `assertSingleQuotedLiteral()` 与裸参前提校验
  `isSafeBareWindowsPathArg()`（用于 `-File <path>` 这种不能用引号的位置）。
- 全仓注入点收敛到 `psLit`/`shLit`：`window.focus` / `uiaFind` / `ocrFind` /
  `system.ts` 的计划任务参数 / `ps-helper.ts` 的 `-File` 裸拼 等 **14 处**；
  原有的「双引号」断言同步**翻转**为单引号 —— 旧断言的方向本就是错的（CI 断言会过期且方向可能反）。
- 新增 `tests/unit/quote.test.mjs`：既有行为断言，也有**源码形态守卫**
  （禁止 `${JSON.stringify(` 拼进 PS 模板、禁止再手写 `replace(/'/g,"''")`）。
  形态守卫带 `stripComments()` —— 否则注释里**讲解漏洞**的文字会被当成犯案。

#### P0-2 ACL 省略 `clients` → 每条 invoke 崩掉被控端

`{"acl":{"default_effect":"deny"}}`（没写 `clients`）会让 `aclPolicy.clients.find(...)` 抛错，
而这段**落在 `if (hasAcl)` 块之外**、无条件执行 —— 配置少写一个字段，整个被控端即不可用。

⚠️ 值得记一笔：**静态审查当时判它是「fail-open 放行」，实测是崩溃**（后果更严重）。
静态审查必须配实测 —— 这是本轮最直接的一条教训。

#### 崩溃链的共同根因：没有 `unhandledRejection` 兜底

`ws.on('message')` 用 `void handleMessage()` 起 Promise 且**没有 `.catch`**，
而全仓没有任何 `process.on('unhandledRejection')` —— Node ≥22 遇到未处理的 rejection **直接终止进程**。
`verifyNonce` 有 try/catch，而 psk 默认路径走的 `verifyHmac` 没有。于是两条畸形报文就够了：
`hello {protocol:123}` 与 `auth {hmac:1}` 都能在**认证之前**把被控端打死。

- `apps/agent/src/index.ts` 新增进程级兜底：日志每次都打、**审计按 10s 限流**
  （否则畸形报文可高频刷爆 `audit.log`）。
- 明确**不**退出进程：源头已有校验与 `.catch`，可用性优先（取舍写在注释里）。

#### 其余 15 条

| 级别 | 缺陷 | 修法 |
|---|---|---|
| P1 | `clients: []` → **fail-open 全放行** | 判据改为「对象是否存在」而非「数组长度」 |
| P1 | 畸形 hello / 畸形 auth → 崩且**免认证** | 控制面报文类型校验 + 上述进程级兜底 |
| P1 | macOS `screen.find` 的 text 拼 bash → `$(...)` 实测执行 | 走 `shLit` |
| P1 | 控制台审计筛选项与协议 enum 漂移（除 `invoke` 外全 `E_PARAM_INVALID`） | 新增 `packages/protocol/src/audit-types.ts` 作**唯一真源**，manifest enum 由它派生，并加编译期双向守卫 |
| P2 | `monitor.start` 的 target 注入；monitor id 路径穿越（读/删） | 走 `psLit` + 统一过 `guardPath` |
| P2 | `keys{}` + `client_id:"constructor"` 崩 | 改 `Object.prototype.hasOwnProperty.call`（原型链取值） |
| P2 | 事件订阅跨控制端可见/可删；`event.watch` 绕开 `fs_roots` | 有状态资源落 owner + 统一路径白名单 |
| P2 | `screen.capture` 的 region 无上界 | `assertRegionSane()`，并**提前到枚举显示器之前**（fail fast） |
| P2 | `ipMatchesCidr('8.8.8.8','10.0.0.0/')` → `true`（空掩码被 `Number('') === 0` 当成 `/0`） | 掩码解析加严，补 `/0` 与 `/32` 对照组用例 |
| P3 | CLI `--timeout` 静默失效 | `parseArgs` 补声明（`strict:false` 下未声明选项被当 boolean，值掉进 `positionals`，双重危害） |
| P3 | 拒绝类事件不写审计 | 补 `request.rejected` / `agent.error` 两类事件 |

#### 回归

`test:unit` **312/312**（+21）、`test:e2e` **33/33**（+3 组硬化用例）、`test:rust` **11/11**。
e2e 新增的 ACL / 畸形报文用例有个必须记住的姿势：**每个场景独占端口 + 独立临时 `NODEAGENT_HOME`** ——
首版复用了同一端口，结果连上了上一块的残留实例，把对照组误判成「实现有缺陷」。

### 新增 —— 控制台单实例保护（症状：Windows 端起了两个被控端）

真机观察到两桩现象：① Windows 上同时跑着**两个被控端**；② **旧的服务端还在运行时，控制台起不来**。
根因是同一个：控制台**没有单实例锁**，再启动一次就是第二个进程 → 第二个 `AgentManager`
→ 抢同一个 8765 端口 → 后起的那个起不来。另有一条陈旧的 `na-gui` 计划任务指向
测试部署目录，也在抢同一个端口。

- 引入 `tauri-plugin-single-instance`（**必须注册为第一个插件**）。
- 第二次启动**不是**静默退出，而是「聚焦既有窗口 + 发 `na-second-instance` 事件」让前端刷新状态。
  这一点是刻意为之：自启动的实例是**无窗口**的，若第二次启动静默退出，用户双击图标只会看到
  「什么都不发生」—— 那比缺陷本身更难排查。带自启参数（`AGENT_ONLY_FLAG`）时跳过显示。
- 端口占用的报错补上「怎么找出占用者」：`netstat -ano | findstr :<port>` /
  `lsof -nP -iTCP:<port> -sTCP:LISTEN`，并新增一条单测。

### 修复 —— 发版脚本漏改 Cargo 清单（版本号会分叉）

`release.mjs patch --dry-run` 实测：只改 **8 个 `package.json` + 1 个 `tauri.conf.json`**，
而 `apps/console/src-tauri/{Cargo.toml,Cargo.lock}` 里**同样存着 2.0.2** —— 发版后必然滞留，
与 `tauri.conf.json` 悄悄分叉，且**不报错**（Tauri 打包以 `tauri.conf.json` 为准）。

- 版本写入抽成 `scripts/lib/version-write.mjs`（纯函数、可测），`release.mjs` 调用它。
- `Cargo.toml` **只在 `[package]` 段**改（非 package 段里也可能有独占一行的 `version = "…"`）；
  `Cargo.lock` **按 `[[package]]` 块 + crate 名定位**（全文盲替换会改坏 `thiserror 2.0.21` 这类依赖版本）。
- `release.mjs` 的「脏文件白名单」改为取自**实际改写结果**（`changed`），不再手写文件名列表 ——
  手写的那份一旦与写入逻辑漂移，要么拦下本该放行的（发版卡死），要么放过不该放行的（静默推走改动）。
- 新增 `tests/unit/version-write.test.mjs`（9 条）：在临时目录铺**真实文件**并 `git init` / `git add`
  （`versionTargets` 走 `git ls-files`，不真进索引就会假绿），跑完**读回文件**断言；
  另含一条**仓库版本号一致性守卫**，发版漏项会直接变红。
- 注入 4 处故障实测：编排漏 Cargo / `Cargo.toml` 全文盲替换 / `Cargo.lock` 按位置盲改 /
  仓库版本分叉 —— **全部变红**，还原后全绿。

> ⚠️ 本批**含被控端变更**（`apps/agent/src/**` 十余个文件），按版本纪律，发版时
> `pnpm release patch`（→ **v2.0.3**）**必须**执行，否则 `agent.mjs` 会谎报一个并不包含这些修复的版本。

### 修复 —— 控制台复用已退出的 sidecar（真机症状：更新等满 45 秒报超时）

**现象**（Windows 11 ARM64 真机）：应用启动被控端后，界面点「检查更新」**等满 45 秒**，
报「检查更新失败：**check_update 超时**」。

**排查对照**（决定性的一条）：同一台机器、同一份 sidecar、同一个请求 ——
- 界面内发起：**45s 超时**（`check_update` 的 `request` 超时上限）；
- 在 VM 上手工拉起 sidecar 跑同一请求：**6.989s 成功返回** `has_update: true, latest 2.0.3`。

现场另证：任务管理器里 `node.exe` **只有被控端一个** —— 控制台的 sidecar 进程**根本不存在**。
逐条排除网络（curl 取 release 资产 **HTTP 200 / 1096096 字节**）、哈希（探针 sha256 一致）、
版本判定（控制台 2.0.2 < 发布 2.0.3）、进程归属（被控端 pid 的父进程正是控制台）之后，
根因锁定在控制台上壳：**`ensure_sidecar` 只判「缓存里有没有实例」，不判「那个实例还活着没」**。

**为什么以前没暴露**：往**已退出进程**的管道里写，在 Windows 上未必立刻报错 ——
管道缓冲区把数据吞下就返回成功。于是请求既没报错、也永远等不到响应，只能一路干等到 `request` 的超时。

**修法**（`apps/console/src-tauri/src/sidecar.rs` + `lib.rs`）：
- `Sidecar` 增 `dead: Arc<AtomicBool>`。三处置死：stdout 任务读到 **EOF**、`stdin` 写入/`flush` 失败、
  `shutdown()` 主动关闭；**stdout 关闭时顺手唤醒所有在等的请求**，让它们立刻失败而不是各等各的超时。
- 新增 `is_alive()`：`dead` 为真即假；否则 `child.try_wait()` 为 `Ok(None)` 才为真；
  **拿不准一律按不可用**（宁可付一次冷启动，也不要让用户每个操作都干等到 timeout）。
- `request()` **入口先判存活**，不可用则立刻返回 —— 这是「秒失败」的那一道。
- `ensure_sidecar` 取到缓存实例后先 `is_alive()`，已退出则**丢弃并重建**。
- 新增 3 条单测：shutdown 后必须判死、子进程被杀后必须判死、
  **对已退出的 sidecar 发请求必须秒失败**（故意给 30s 超时，**断言耗时 < 5s** ——
  修复前的表现恰恰是「干等到超时」，只断言「有没有报错」会漏掉这个缺陷）。
  注入故障（把 `is_alive()` 换成恒 `true`）实测两条守卫如期变红。
- `pnpm test:rust` **14/14**（基线 11 + 新增 3）。

> ⚠️ **本项属控制台上壳变更，不是被控端变更**，因此**不触发** `pnpm release patch`
> （被控端 `agent.mjs` 无需重新发布）。但要**让用户真正拿到修复，必须重新构建并分发控制台安装包**
> （`.msi` / NSIS）；直接重启已装的旧版控制台只是**临时绕开**（进程内缓存被清空 → 重新拉起 sidecar），
> 症状会消失，但下次 sidecar 再退出仍会复发。

### 修复 —— 两条守卫在 Windows 上必红（平台差异：CRLF 与路径分隔符）

CI 实证（run `38380306200`，提交 `73ed06f`）：`Windows 真机验证 → 单元测试` **319/321**，
macOS 上同样两条却是绿的 —— 典型的「只在 Windows 暴露」。两条各有明确根因：

**① `仓库内全部版本号互一致`：CRLF 把版本号读成 `undefined`**

报错原文：`undefined  apps/console/src-tauri/Cargo.lock`（其余 10 处均为 `2.0.3`，`2 !== 1`）。
根因：Windows 上 `actions/checkout` 默认 `core.autocrlf=true`，工作区文本是 **CRLF**，
而 `Cargo.lock` 的版本提取把 `\n` 写死了。更严重的是 —— **同一处隐患也在生产代码里**：
`version-write.mjs` 的写入路径另有一条 `name…\nversion…` 正则读旧值，CRLF 下同样返回 `undefined`，
于是它把 Cargo.lock 当成「没找到该 crate」记入 `skipped` 并**跳过** → 发版后该文件滞留旧版本，
**正是本模块要消灭的那类分叉，且不报错**。

- 收敛为**单一真源**：读旧值改走 `readCargoTomlVersion()` / `setCargoLockVersion().before`，
  删掉那条会漂移的重复正则。
- 新增 `splitLineEol()`：写值前先把行尾拆下来、改完正文再拼回去 ——
  不能偷懒写 `(".*)$` 兜行尾，因为 **JS 的 `.` 不匹配 `\r`**（与 `\n` 同属行终止符），照样失配。
- 读值一律 `split('\n')` 后对 `line.trim()` 匹配 → LF / CRLF 结果一致，写回**逐字节保真**。
- 新增 3 条守卫：Cargo.lock / Cargo.toml 纯函数级 CRLF 用例 + **CRLF 工作区上真跑一遍
  `writeVersionEverywhere` 并读回文件断言**（注入故障后 3 条如期变红）。

**② `W-01 根因守卫：PowerShell 单引号字面量必须来自 util/quote.ts`：把唯一真源自己判成违规**

报错原文：`以下文件手写了 PS 单引号转义：util\quote.ts`。
根因：守卫用 `file.slice(dir.length + 1)` 得相对路径，Windows 上是 `util\quote.ts`，
与白名单里的 `util/quote.ts` 比不中 → **守卫自己错**（铁律 3 的第 ② 类），macOS 上复现不出。

- 新增 `relPosix()` 把相对路径统一归一成 `/`；并补一条**用 `path.win32` 形态字符串在 macOS 上
  直接测掉 Windows 分支**的用例 —— 跨平台差异不必真上 Windows 才能验（铁律 4）。

回归：`test:unit` **325/325**（321 + 新增 4），注入故障实测 4 条守卫如期变红、还原逐字节一致。

> 附带发现（不构成缺陷，但值得记档）：控制台随包的 `agent.mjs` 与发布版 `agent.mjs`
> **逐行一致、同报 2.0.3**，唯二差异是 esbuild 的模块相对路径串与内嵌 commit 常量
> （随包 `73ed06f` / 发布版 `a1c51d6`）—— 源于两次构建的**基准目录不同**。
> 因此二者 **sha256 必然不同**，不能用发布清单的哈希去校验控制台播种出来的那份。

### 修复 —— 打包后 sidecar 因 Windows verbatim 路径秒退（真机症状：「sidecar 已退出（stdout 关闭），请重试」）

上一节修好「复用已退出的 sidecar」之后，真机复验**症状变了但没解决**：不再干等 45 秒，
改为**立刻**报「检查更新失败：**sidecar 已退出（stdout 关闭），请重试**」——
说明被拉起的 sidecar **在请求进行中真的退出了**，只是这次被立刻发现。本节是它的真根因。

**真机 A/B（决定性的一条）**：Windows 11 ARM64；同一个 `node.exe`、同一份 `sidecar.mjs`，
**只换脚本参数的写法**：

| 脚本参数 | 结果 |
|---|---|
| `C:\…\sidecar.mjs` | 2.5 秒返回 `check_update` 结果，进程常驻、心跳持续 |
| `\\?\C:\…\sidecar.mjs` | **0.47 秒即退出，exit 1**，**零 JS 执行** |

「零 JS 执行」是实测出来的：sidecar 自己的启动日志一行没写、审计日志在 `agent.start` 之后
一片空白、判死探针文件 0 字节 —— 连第一行 JS 都没跑到。

**根因**：Tauri 的 `resource_dir()` 在 Windows 上返回的是 `std::fs::canonicalize` 之后的
**verbatim 路径**（`\\?\C:\Users\…\nodeagent-console`）。把它当**参数**交给 node 时，
node 启动流程在入口模块的 `realpathSync` 里把 `\\?\C:` 拆成盘符 `C:` 与剩余部分：

```text
Error: EISDIR: illegal operation on a directory, lstat 'C:'
    at Object.realpathSync (node:fs:27xx)
```

→ exit 1，**一行 JS 都来不及执行**。两种界面表现都由这一条派生：
修存活检测**之前**是「写进已死进程的管道 → 干等 45 秒超时」，
修**之后**是「stdout 立即 EOF → 立刻报 sidecar 已退出」。

**为什么单测 / CI / 开发模式全都测不出来**：开发期 `resolve_sidecar` 走的是
`CARGO_MANIFEST_DIR` 拼出来的**普通路径**；只有**打包之后**才会从 `resource_dir()`
拿到 verbatim 路径。CI 里 `cargo test` 又只在 `ubuntu-latest` 跑（`.github/workflows/rust.yml`），
Windows 侧只有打包（`console-windows.yml`）。于是「本地全绿 + CI 全绿 + 真机必挂」。

**修法**（`apps/console/src-tauri/src/sidecar.rs` + `agent.rs` + `autostart.rs`）：
- 新增 `unverbatim()`：剥 `\\?\UNC\` → `\\`、剥 `\\?\` → 无前缀，其余原样返回；
  **纯字符串处理，任何平台都可安全调用** —— 因此可以用 Windows 形态的字符串在
  macOS / Linux 上直接守住 Windows 分支（铁律 4：跨平台差异不必真上 Windows 才能验）。
- 新增 `sidecar_command()`：**唯一**把路径交给 node 的地方，内部统一净化。
  纪律只在这里守一次，单测直接断言它产出的 `program` / `args`（守「最终下发文本」，
  不是「源码里出现过某个常量」）。
- 四个来源统一加闸：`resolve_node` / `resolve_sidecar` / `resolve_bundled_agent` 的
  **全部出口**（环境变量、resource_dir、系统 PATH / 开发路径），以及进程边界的
  `Sidecar::spawn` 与 `AgentManager::start`（对 node / script / data_dir 三条路径都净化）。
- `autostart::app_exe()` 一并净化：该路径会被写进计划任务的 `New-ScheduledTaskAction -Execute`，
  与上述同源风险。

**回归**：
- 新增 3 条守卫 —— `unverbatim_去掉各类_windows_前缀`（盘符 / UNC / 普通 / POSIX / **幂等**）、
  `unverbatim_对_resource_dir_拼接后的路径同样生效`（前缀在目录上、拼完仍在最前）、
  **`交给_node_的路径必须去掉_verbatim_前缀`**（断言最终 `program` 与 `args` 文本）。
- **注入故障实测**：把 `sidecar_command` 里的 `unverbatim` 去掉 → 第三条如期变红，
  报错正文即 `program 仍带 verbatim 前缀（示例：\\?\C:\…\node.exe）`；还原后 **sha256 逐字节一致**，复跑全绿。
- `pnpm test:rust` **17/17**（14 → +3）。

> ⚠️ **本项属控制台上壳变更，不是被控端变更**，因此**不触发** `pnpm release patch`。
> 但要让用户真正拿到修复，**必须重新构建并分发控制台安装包**。
> ⚠️ 修复只净化了「交给 node 的路径」，**尚待在真机上跑通完整链路**（下一版安装包复验）。

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
