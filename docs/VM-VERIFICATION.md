# VM 验证清单（Parallels Desktop 27 + Windows 11 ARM）

> 用途：Windows 真机不可用时，用 **Parallels 27 的 Windows 11 ARM 虚拟机**提前跑掉
> **架构无关**的验证项，把"等机器"的时间省下来。
>
> ⚠️ **本清单的结论必须按 §5 的规则标注**：VM 验过的项写「VM 已验」，并注明
> 是否仍需真机复验。**不要把 VM 结论当作真机结论** —— 二者架构不同。

---

## 1. 能补什么 / 不能补什么

| 类别 | 项 | VM 可否 |
|---|---|---|
| **协议层**（与架构无关） | v23 三防护（握手封禁/连接上限/空闲断开）、审计锚点端到端、v26 计划任务清理逻辑 | ✅ **可验，结论直接可用** |
| **输入注入层** | v1.5 四项（字符串热键/预设别名/长按/后台定向投递） | ✅ 可验（走 Win32 `SendInput`/`WM_APPCOMMAND`，ARM Windows 同样完整） |
| **安装与自持** | `install.cmd` 自提权、计划任务注册、受控重启 | ✅ 可验（VM 里也是真 Windows，机制一致） |
| **系统能力** | 进程/服务/文件/剪贴板/命令执行/`winget` | ✅ 可验 |
| **刻意不可验** | 第三方杀软拦截（火绒等） | ❌ VM 里只有 Defender |
| | 显示 / DPI / 多显示器 / 坐标校准 | ❌ VM 显示栈不同 |
| | 性能指标（P95 时延等） | ❌ VM 数字不可比 |
| **需注意** | `win-x64` 包在 ARM Windows 上走 **Prism 模拟** | ❌ **实测结论（2026-10-11）：能启动、能 listen，但 TLS 握手不完成**（控制端只见 `E_TIMEOUT`）→ 被控端实际不可用。ARM Windows **必须**用 `nodeagent-win-arm64.zip`（见 B5） |

---

## 2. 前置准备

```
① Parallels 27 装 Windows 11 ARM（Pro/Enterprise）
   └ Apple silicon 只能跑 ARM 版 Windows（x86_64 仅 Pro/Business 的早期预览，性能显著更低）

② 网络 → 桥接（Bridged），不要用默认「共享网络」
   └ 共享/NAT 下 VM 拿不到同网段 IP → UDP 广播发现（v4）测不了，Mac 也未必能直连

③ VM 内装 Node：优先 **ARM64 版**（避开 Prism 模拟层）
   └ 若想验分发包，同样**必须用 `nodeagent-win-arm64.zip`** —— x64 包在 ARM 上握手不通（见 B5）

④ VM 内起被控端（二选一）
   a. 免安装：双击 run-portable.cmd        （不注册计划任务，适合快速验能力）
   b. 正式装：解压 nodeagent-win-arm64.zip → 双击 install.cmd（自提权，会建计划任务）

⑤ Mac 端登记设备并连接
   nodeagent --node vm connect <VM的IP> --key <密钥> --insecure
   nodeagent --node vm info          # 看到 51 项能力即通
```

> 建议设备名用 `vm`，与真机 `win` 分开 —— 后续所有命令都在 `--node vm` 上跑。

---

## 3. 验证清单

### A. 基础验收（17 项，一步到位）

```bash
# 对齐 PRD FR-01~FR-08 的全套验收，可同时输出 Markdown 报告
node scripts/verify.mjs --host <VM的IP> --port 8765 --key <密钥> --insecure \
  --report /tmp/vm-verify.md
```
**判定**：脚本自报通过项；报告存档（日后对比真机报告，差异项即为"架构相关"）。

---

### B. 待办专项（逐条）

#### B1. v1.5 四项（该版当初未经真机就发版）

```bash
# ① 字符串热键（分隔符 + - 空格、大小写不敏感）
nodeagent --node vm key press "ctrl+shift+esc"
#   期望：{ pressed: true, chords: [...] }（被控端返回里**没有 keys 字段**，别按它判）

# ② 预设别名（约 50 个语义名）
nodeagent --node vm key press copy
#   期望：同上，且 args 走 preset 分支（非 hotkey）

# ③ 长按
nodeagent --node vm key press f24 --hold 800
#   期望：按下并保持 800ms

# ④ 后台定向投递（PostMessage 到指定进程，窗口被遮挡也生效）
nodeagent --node vm ps                      # 先取一个目标 PID
nodeagent --node vm key press f24 --route post --pid <PID>
#   期望：{ pressed: true }；目标进程窗口被遮挡/最小化时**仍然生效**
```
**判定**：四条都返回 `pressed: true` 且无异常。
**选键建议**：用 `f24` / `shift` / `copy` 这类**无副作用**的键（F24 几乎无程序绑定）。

#### B2. v23 三防护（配置在 `agent.json` 的 `security` 段）

```jsonc
// VM 被控端数据目录下的 agent.json
{ "security": { "auth_ban": { "max_attempts": 3, "ban_ms": 60000 }, "idle_timeout_ms": 60000 } }
```

```bash
# ① 握手失败封禁：连续用**错误密钥**连 -> 达阈值后**正确密钥也被拒**
for i in 1 2 3; do nodeagent --node tmp connect <IP> --key WRONG --insecure; done
nodeagent --node tmp connect <IP> --key <正确密钥> --insecure
#   期望：前几次报 E_AUTH_FAILED；达到 max_attempts 后，即使是正确密钥也报被封禁

# ② 连接上限：并发开连接直到第 N+1 个被拒
#   期望：超出上限的连接被拒（E_NODE_BUSY 或等价错误）

# ③ 空闲断开：连上后静置超过 idle_timeout_ms
#   期望：连接被服务端主动断开，控制端收到 closed
```
**判定**：三种防护各自可达且**恢复后正常**（封禁到期、连接释放、重连成功）。

#### B3. v26 自重启任务清理（治"Running 僵尸"）

```bash
# ① 触发受控重启
nodeagent --node vm restart              # 重启会让配置变更生效，连接会短暂断开
# ② 重连后查看计划任务
nodeagent --node vm exec "schtasks /query /fo csv /tn \"nodeagent-selfrestart*\""
```
**判定**：
- 清理条件为「**非 Running** 或 **LastRunTime 早于 1 小时**」
- 刚创建的那个任务（当前 agent 的宿主）**必须仍在** ← 若它被清掉，说明误杀了宿主（严重）
- 一小时后复查：旧任务应已被清理，**不再累积**

#### B4. 审计锚点端到端（此前只做了离线 fixture 验证）

```bash
# ① 生成锚点（拉 VM 的链头）
node scripts/anchor-audit.mjs collect --node vm --out /tmp/vm-anchor.jsonl --note "VM 验证"
# ② 上传到链外（云盘 …/Project/NodeAgent/anchors/，文件名带年月日）
# ③ 从云盘下载回来再比对
node scripts/anchor-audit.mjs verify --anchors /tmp/vm-anchor.jsonl --node vm
#   期望：ok:true，verdict 为「链已增长」或「与锚点完全一致」
#   （刚锚定就比对通常显示"已增长" —— 锚定动作自身也写一条审计，属正常）
```
**判定**：`collect` 能拿到链头、云盘上传成功、`verify` 返回 `ok:true`。

#### B5. 分发包在 ARM Windows 上的架构适配（✅ 已验，2026-10-11）

**结论：ARM Windows 上必须用 `nodeagent-win-arm64.zip`；`win-x64` 包不可用。**

同机、同密钥、同参数的对照实测：

| 包 | 内含 `node.exe` | 结果 |
|---|---|---|
| `nodeagent-win-arm64.zip` | ARM64（PE `0xaa64`） | ✅ TLS 握手成功 → PSK 认证 → 声明 51 项能力（两端一致）→ `info`/`status`/`process.list`/`service.list`/`shell.exec`/`audit verify` 全通；`system.info.arch` 报 `arm64`（原生，非模拟层） |
| `nodeagent-win-x64.zip` | x86-64（PE `0x8664`） | ❌ 能启动、能 listen，但 `connect` 报 `E_TIMEOUT` —— **TLS 握手不完成** |

> 踩坑记录：v2.0.1 的 arm64 资产曾**误装 x64 node**（`pack.mjs` 的运行时缓存文件名不含架构 →
> 打 arm64 时复用了 x64 的缓存），两份公开包内 `node.exe` 字节完全相同（同 sha256）。
> 该缺陷在 macOS 上 **100% 复现不出**，只有 ARM 目标机才暴露。
> 现 `pack.mjs` 解包后断言 PE Machine，CI 亦直接校验最终产物内 `node.exe` 的 PE 头。

**复验方式**：

```bash
# ① VM 内，用包内自带 node 起被控端（务必 arm64 包）
C:\nodeagent-test\node.exe C:\nodeagent-test\agent.mjs
#    注意：以 SYSTEM（会话 0）启动时 screen.capture 等图形能力必失败（会话 0 无交互桌面），
#    正式安装路径不受影响 —— install.ps1 的计划任务用登录用户 + LogonType Interactive。

# ② Mac 侧连入
nodeagent connect <VM的IP> --port 8765 --key <密钥> --insecure --id vm
```

**判定**：`connect` 成功并列出 51 项能力 = 通。若只见 `E_TIMEOUT`，先查包内 `node.exe` 是不是 ARM64。

---

## 4. 一键顺序（建议）

```
A 基础验收（verify.mjs）
  → B1 v1.5 四项
    → B2 v23 三防护（改 agent.json 后需 restart）
      → B3 v26 清理（restart 后查任务）
        → B4 锚点端到端
          → B5 x64 包兼容性
```
每步完成后把结论记到 `docs/ROADMAP.md` §九 台账，**并标注来源是 VM 还是真机**。

---

## 5. 结论标注规则（强制）

| 情形 | 台账/CHANGELOG 写法 |
|---|---|
| 架构无关项（B2/B3/B4）在 VM 验过 | `✅ 已验证（VM · Windows 11 ARM）` |
| 输入/系统能力（A/B1）在 VM 验过 | `✅ 已验证（VM）`，**若涉及坐标/DPI 则加注「坐标类待真机复验」** |
| 杀软交互 / 显示 / 性能 | `⏳ 待真机`（VM 不可替代，**不得**因 VM 通过就标已验） |
| 分发包架构适配（B5） | `✅ 已验证（VM · Windows 11 ARM）：arm64 包原生可用；win-x64 包 TLS 握手不完成、不可用` |

> **一条纪律**：VM 与真机**架构不同**（真机 i7-12650H = x86_64）。任何"VM 通过"
> 都不能自动推出"真机通过"；涉及**原生二进制、驱动、杀软、显示栈**的部分尤其如此。
> 宁可多留一条"待真机复验"，也不要让台账出现无法追溯来源的"已验证"。

---

## 6. 已知 VM 环境差异（排查时先看这里）

| 现象 | 原因 | 处理 |
|---|---|---|
| `discover`（UDP 广播发现）无结果 | 网络是共享/NAT | 改**桥接** |
| 分辨率/坐标与真机不符 | VM 显示栈不同 | 只做逻辑验证，坐标待真机 |
| 性能数字明显偏低 | VM + 可能的 Prism 模拟 | **不要**采信 VM 的性能指标 |
| 杀软相关错误复现不了 | VM 里只有 Defender | 需真机（或另行安装第三方杀软） |
| **x64 Node 在 ARM Windows 上"启动慢/协议异常"** | 走 **Prism 模拟层**，TLS 握手下行为异常（能 listen，握手不完成） | 换 **ARM64 Node**（用 `nodeagent-win-arm64.zip`） |
| **`screen.capture` 报 `E_EXECUTION_FAILED`** | 被控端跑在 **SYSTEM（会话 0）**，会话 0 **无交互桌面** | 以**登录用户 + `LogonType Interactive`** 启动（见 §8 配方）；**非产品缺陷** |
| **autologon 对微软账户（MSA）无效** | MSA 凭据由 **CloudAP** 处理，注册表 `DefaultPassword`（Winlogon→LSA）那条路对它不生效 | 建**本地账户**做 autologon（`LogonUser` 对 MSA 恒返回 `1326`） |

---

## 7. 实测记录（VM）

| 日期 | 项 | 结论 | 证据 |
|---|---|---|---|
| 2026-10-11 | **B5 架构适配** | ✅ arm64 包原生可用；❌ win-x64 包不可用 | 同机同参对照：arm64 握手成功 / x64 `E_TIMEOUT` |
| 2026-10-11 | 基础能力（A 子集） | ✅ | `system.info`（`arch=arm64`、能力 51 项两端一致）/ `status` / `process.list` / `service.list` / `shell.exec`（退出码 0）/ `audit.list` / `audit verify`（链完整）均正常 |
| 2026-10-11 | **图形能力** | ✅ **登录态下全通** | 以登录用户 + `LogonType Interactive` 启动后：`screen.capture` 返回**真实桌面** 1800×1010（含中文，渲染正常）／`window.list` 返回窗口列表（前台窗口 PID 与实测一致）／`screen` 枚举显示器／`audit verify` 链完整。**证实会话 0 的失败是身份问题，非产品缺陷** |

> 本轮**尚未执行**：B1（v1.5 四项输入）/ B2（v23 三防护）/ B3（v26 重启清理）/ B4（审计锚点端到端）。
> 另注：VM 的 `prlctl exec` 默认以 **SYSTEM（会话 0）** 身份执行，图形类能力须换登录用户会话方可复验。
> **图形能力复验配方（本轮实证可通过）**：见 §8 末节。

---

## 8. 实际验证结果（2026-10-11，Parallels 27 + Win11 ARM）

> 本节是**实测记录**，不是计划。环境：Parallels 共享网络，VM `10.211.55.9`，
> Mac 侧 `bridge100=10.211.55.2`；被控端 `-NodeId win-arm -AllowInput`。

### B5 结论（重要，与预期不同）

| 组合 | 结果 |
|---|---|
| **`win-x64` 包（内含 x64 Node）** | ⚠️ **能启动、能 listen 8765，但 TLS 握手 60s 不完成** → **协议层不可用**（Prism 模拟下） |
| **换成 ARM64 Node（同版本 v22.20.0）** | ✅ **完全正常**：TLS 握手成功、连接、51 项能力 |

**结论**：`nodeagent-win-x64.zip` **不能在 ARM Windows 上实用**。

**解决方案（已落地）**：`scripts/pack.mjs` 新增 `--arch`：
```bash
node scripts/pack.mjs --arch arm64     # → release/nodeagent-win-arm64.zip（内含 ARM64 node.exe）
node scripts/pack.mjs                  # 默认仍出 x64 包（向后兼容）
```
ARM Windows（含 Parallels Win11 ARM）请用 **arm64 包**；用 x64 包会卡在 TLS 握手。
（临时替代：手工把包内 `node.exe` 换成 ARM64 版同样可行，重启后需再换 —— 故推荐用 arm64 包。）

### 各项结果

| 项 | 结果 |
|---|---|
| A 组（`verify.mjs` 17 项） | ✅ 15 通过 / 0 失败 / 1 跳过 |
| B1 v1.5 四项 | ✅ 全过（含 `route=post` 实测命中 138 窗口） |
| B4 锚点端到端 | ✅ 全过（含上传云盘） |
| B2 v23 三防护 | ✅ **三场景全通过**：① 握手封禁（3 次错误密钥后**连正确密钥也被拒**）② 连接上限（配 6 → 第 7 个被拒）③ 空闲断开（静默 40s 被断，符合 idle 20s + 清扫周期 30s） |
| B3 v26 清理 | ✅ **验证并改进了策略**：实测发现「1 小时」粗阈值下频繁 restart 仍累积 → 改为「**早于本 agent 启动时刻**」精确阈值（部署到 VM 实测：restart 后旧任务被自动清理、宿主未误杀） |

### 实测新增的排查项（补进 §6）

| 现象 | 原因 | 处理 |
|---|---|---|
| 装了却连不上（TLS 握手不完成） | **x64 Node 在 Prism 下协议层异常** | 换 ARM64 Node |
| `control.ps1` 报"变量引用无效" | 脚本里 `$var:` 被当 drive 引用（**解析期**错误 → 整个脚本废） | 已修（写 `${var}`）；已加守卫 |
| 直接跑 `install.ps1` 后找不到 `PSK.txt` | **只有 `install.cmd` 才产生 PSK.txt** | 密钥在 `<数据目录>\agent.json` 的 `key` 字段 |
| 装完输入类能力不可用 | `install.cmd` 不传 `-AllowInput`（默认 false） | 用 `install.ps1 -AllowInput` |
| `nodeagent --node x cmd` 报"未知命令" | `--node` **前置需等号** | 写 `--node=x`，或放命令后 |
| 计划任务启动后端口不通 | **node.exe 被手工进程占用**（覆盖失败）+ 8765 被占（任务起来即冲突退出） | 先 `Get-Process node \| Stop-Process -Force` 再解压/启动 |
| 自测时 `socket hang up` | **URL 写成 `ws://` 而服务端是 `wss`**（`tls:true`） | 用 `wss://` |
| 测 `max_connections` 把自己锁在外面 | 测试值太小 + 被拒连接会被计入握手失败 → 恶性循环 | ① 测试时留余量 ② **给自己加 `auth_ban.whitelist`** |

---

## 9. 图形能力复验配方（2026-10-11 实证）

图形类能力（`screen.capture` / `window.list` / `input.*` / `screen.find`）在 VM 里失败的**唯一原因**
是被控端跑在 **SYSTEM（会话 0）**——会话 0 没有交互桌面。要让它们可用，须让被控端跑在
**已登录用户的会话**里。完整配方（本轮实测可复现）：

### ① 建立登录会话（关键坑：微软账户不行）

VM 无人登录时停在 LogonUI。可脚本化的路径只有 **autologon**，但：

> **微软账户（MSA）不支持传统 autologon。** MSA 凭据由 **CloudAP** 凭据提供程序处理，
> 而 autologon 走的是 Winlogon→LSA + 注册表 `DefaultPassword` 那条**老路**。
> 实测：对 MSA 账户调 `LogonUser` 四种域形式**全部返回 `1326`（用户名或密码错误）**，
> 且 Winlogon 日志里**连一次登录尝试都不记录**（账户解析阶段就被跳过）——
> 极易误判为"密码打错了"。

**配方**：新建一个**本地账户**再 autologon：
```powershell
$pw = ConvertTo-SecureString '<password>' -AsPlainText -Force
New-LocalUser -Name pdverify -Password $pw -PasswordNeverExpires -AccountNeverExpires
Add-LocalGroupMember -Group Administrators -Member pdverify
$k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $k AutoAdminLogon   '1'
Set-ItemProperty $k DefaultUserName  'pdverify'
Set-ItemProperty $k DefaultDomainName $env:COMPUTERNAME
Set-ItemProperty $k DefaultPassword  '<password>'    # 明文，验完务必清理
Restart-Computer -Force
```

### ② 以登录用户身份启动被控端（这一步才是图形能力的关键）

```powershell
$act = New-ScheduledTaskAction -Execute 'C:\nodeagent-test\node.exe' -Argument 'C:\nodeagent-test\agent.mjs'
$pri = New-ScheduledTaskPrincipal -UserId ($env:COMPUTERNAME + '\pdverify') -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName 'na-gui' -Action $act -Principal $pri -Force
Start-ScheduledTask -TaskName 'na-gui'
```

`LogonType Interactive` = 「仅在用户登录时运行」→ 任务落在**该用户的交互会话**里。

### ③ 核对（三件事缺一不可）

| 检查 | 期望 |
|---|---|
| `Get-Process node \| Select Id,SessionId` | **SessionId = 1**（不是 0） |
| `Get-Process explorer \| Select SessionId` | 1（桌面已就绪） |
| `Get-LocalUser pdverify \| Select LastLogon` | 有值（确实登录过） |

### ④ 证书指纹会变（这是钉住机制在正常工作）

换了数据目录（新用户 → 新 `.nodeagent/`）→ agent **重新生成自签证书** →
客户端报 `E_CERT_MISMATCH`。用 `nodeagent connect <ip> --forget-cert --insecure` 重钉即可。
**注意**：这不代表被中间人，而是"换目录=换身份"的正常结果。

### ⑤ 验证完的清理（安全）

autologon 会把密码**明文**写进 `HKLM\...\Winlogon\DefaultPassword`：

```powershell
$k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Remove-ItemProperty $k DefaultPassword -ErrorAction SilentlyContinue
Set-ItemProperty   $k AutoAdminLogon '0'
Unregister-ScheduledTask -TaskName 'na-gui' -Confirm:$false
Remove-LocalUser -Name pdverify          # 临时账户一并删除
```

> 若需**保留**该环境供后续验证（重启后仍自动恢复图形会话），可暂不清理 ——
> 但要清楚：明文密码就留在注册表里。

---

## 10. 200% 缩放下的坐标口径，与 VM 输入通道的真机真相（2026-10-12）

全部在 **Parallels 27 + Win11 ARM64（200% 缩放）** 上实测。
§9 讲「怎么让图形能力跑起来」，本节讲「跑起来之后坐标为什么还是错的」以及「被控端自己不动了怎么救」。

### 10.1 缺陷本体：一个进程里并存两套坐标系

被控端的 PowerShell 助手进程**默认 DPI 不感知**（Windows 的默认行为）：

| 调用 | 不感知时的结果 | 危害 |
|---|---|---|
| `Screen.Bounds` / `SystemInformation.VirtualScreen` | **逻辑**尺寸 1800×1010 | `screen.info` 报错尺寸；`screen.capture` 缺省 region 一并错 |
| `CopyFromScreen` | 按**物理**像素裁剪 | `screen.capture` 缺省**只截到左上 1/4** |
| `SetCursorPos` | 被系统 **×2** | `input.mouse.*` 喂 100,100 → 光标落到 200,200 |
| UIA（`screen.find`） | **物理**坐标（与进程是否感知无关） | 与上面三项**口径不一致** |

净效果：`screen.find` 给出的物理矩形**不能**直接喂给 `input.mouse.*`，得人工除以 `scale`。
修法是 `apps/agent/src/util/dpi.ts` 的 `PS_DPI_AWARE` 注入到**每个坐标脚本的最前面**。

### 10.2 复验配方（改完全部坐标路径后，这三条必须跑）

| 断言 | 怎么取 | 修复前 | 修复后应为 |
|---|---|---|---|
| 屏幕尺寸口径 | `screen.info` | `1800x1010` | **`3600x2020`**，且与**裸 Win32** `GetSystemMetrics(0/1)`（感知后）一致 |
| 缺省整屏截图 | `screen.capture`（**不传** `region`） | 只有左上 1/4 | 整屏（按 `scale` 缩放后返回） |
| 光标落点 | `input.mouse.move(x,y)` 后**用同样感知的助手**读回 `GetCursorPos` | 落到 (2x,2y) | **精确等于** `(x,y)` |
| 端到端零换算 | `screen.find` 的物理矩形中心**直接**喂 `input.mouse.click` | 点不中 | 命中（可用主题单选框的 UIA `selected` 翻转验证） |

> ⚠️ 读回光标时**助手也必须 DPI 感知**，否则读到的是逻辑值 —— 会得到「move 生效了但值差 2 倍」的假象。

### 10.3 被控端「输入注入整体失效」——VM 环境坑，**不是产品缺陷**

现象：`input.mouse.*` 与 `input.key.*` 全部无效，光标纹丝不动。

先把环境位逐条排干净：

| 检查 | 实测 |
|---|---|
| 会话 / 窗口站 / 桌面 | `session=1` / `WinSta0` / `Default` ✅ |
| `UserInteractive` | `True` ✅ |
| `OpenInputDesktop` | 成功 → `Default`；`SetThreadDesktop(它)` 报 `ERROR_BUSY(170)`（本就在该桌面）✅ |
| `ClipCursor` | 整屏 `0,0,3600,2020`，无裁剪 ✅ |
| 指点设备 | `HID-compliant mouse` + `Parallels USB Mouse Synchronization Device` 均 `Status OK` ✅ |
| `prl_mouf` 驱动 | `STATE: 4 RUNNING` ✅ |
| **进程来源** | 从 **node 子树** 与 **`prlctl enter`**（Parallels Tools 侧）两条**互不相干**的来源跑同一段探针，**结果完全一致** ❌ |

判决性证据（**纯 Win32 探针，不含任何本产品代码**）：

```text
SetCursorPos(1500,1200) = FALSE            ← 直改 win32k 指针：硬失败
SendInput(绝对)          = 1               ← 已插入输入队列
SendInput(相对)          = 1               ← 已插入输入队列
GetCursorPos             = 410,1488 → 410,1488   ← 指针纹丝不动
GetAsyncKeyState(按键)   = 0x0000          ← 连键盘注入也不被系统认可
```

**`SendInput` 报告成功，而键盘与鼠标一视同仁地无反应** —— 不是「指针被同步设备独占」，
而是**整条输入注入通道被吞在输入队列之后**。任何应用层代码都绕不过去。

复位手段实测：

| 手段 | 结果 |
|---|---|
| `--smart-mouse-optimize` 三档（`off` / `auto` / `on`） | ❌ 无效 |
| `prlctl suspend` + `start`（挂起 / 恢复） | ❌ 无效 —— resume 会**完整还原 win32k 状态**，卡住的输入态当然一起被还原 |
| **`prlctl stop --acpi` + `start`（真正冷启动 Windows）** | ✅ **立即恢复** |

> 结论：VM 输入栈瞬时卡死，**只有冷启动能复位**。
> 开工前先让宿主机把 VM 窗口真正当前台窗口交互一次（宿主机侧绝对鼠标集成会把 guest 指针从属过去；
> 实测 `--smart-mouse-optimize` 三档都不改变这一点）。

### 10.4 被控端「活着但不响应」——两条运维事实

**① 计划任务以 `RunLevel Highest` 拉起时，普通权限 `taskkill` 会「拒绝访问」。**

```text
na-gui   user=pdverify  logon=Interactive  runlevel=Highest
```

→ 必须从**更高权限通道**杀：`prlctl enter "Windows 11"`（**不带** `--current-user`）
拿到 `nt authority\system` 的 shell，`taskkill /F /PID <pid>` 才会成功。

另外：旧进程仍占着 8765 时，`schtasks /run /tn na-gui` 会**报「执行成功」但新实例立即退出**
（表现为端口仍被旧 PID 占着）→ 必须**先杀后起**。

**② 客户端异常断开后，被控端会留一条 `CLOSE_WAIT` 并拒收新连接。**

```text
netstat -ano | findstr 8765
  TCP   10.211.55.9:8765   10.211.55.2:57182   CLOSE_WAIT   9396
```

此时新连接**能完成 TCP 三次握手，但 TLS 握手永不完成**（控制端只见 `E_TIMEOUT`），
**不会自愈**，只能重启被控端进程。触发方式：客户端在请求进行中被 `SIGTERM`/`SIGKILL`
（即「不做优雅关闭」）。

> ⚠️ **尚未定论**是产品缺陷还是环境使然 —— 本轮只观察到现象与可复现路径，未取到被控端的卡点证据。
> 记此供后续专门排查。若成因是「`console.log` 写满无人读取的管道 → 事件循环阻塞」，
> 那对「被控端常驻、控制端随时可能硬断开」这种使用模式是个真问题。

### 10.5 两条 `prlctl` 通道的语义差异（本轮踩出来的）

| 命令 | 实测行为 |
|---|---|
| `prlctl exec <VM> -- <cmd>` | **返回 exit=0 但完全空转**：无输出、无副作用（用「guest 反连 Mac 监听端口」判决）→ **不可用** |
| `prlctl enter <VM>` | 默认 `nt authority\system`（会话 0，无交互桌面） |
| `prlctl enter <VM> --current-user` | 登录用户的**真实交互** shell ✅ |

另两条：

- `prlctl enter` **没有执行参数**（加 `--` 报 `Unrecognized option`），它是交互式 shell，
  命令要**经 stdin 喂**：`printf 'cmd\r\n...\r\nexit\r\n' | prlctl enter ...`
- **`prlctl` 的参数里带逗号 / `&&` / 重定向会报 `Invalid argument`** —— 复杂逻辑一律先落成 `.cmd` / `.ps1` 再调用。

> 仅供技术参考，不构成任何投资建议。

