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
| **需注意** | `win-x64` 包在 ARM Windows 上走 **Prism 模拟** | ⚠️ 能跑但慢；**这本身是值得记录的兼容性结论**（见 B5） |

---

## 2. 前置准备

```
① Parallels 27 装 Windows 11 ARM（Pro/Enterprise）
   └ Apple silicon 只能跑 ARM 版 Windows（x86_64 仅 Pro/Business 的早期预览，性能显著更低）

② 网络 → 桥接（Bridged），不要用默认「共享网络」
   └ 共享/NAT 下 VM 拿不到同网段 IP → UDP 广播发现（v4）测不了，Mac 也未必能直连

③ VM 内装 Node：优先 **ARM64 版**（避开 Prism 模拟层）
   └ 若想验分发包，另见 B5（用项目打的 win-x64 包）

④ VM 内起被控端（二选一）
   a. 免安装：双击 run-portable.cmd        （不注册计划任务，适合快速验能力）
   b. 正式装：解压 nodeagent-win-x64.zip → 双击 install.cmd（自提权，会建计划任务）

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

#### B5. `win-x64` 包在 ARM Windows 上的兼容性（额外结论）

```bash
# 把项目打的包解压到 VM，用**包内自带的 x64 Node**起被控端（走 Prism 模拟）
# 期望：能起、能被连接、基础能调用
```
**判定**：能跑 → 说明分发包对 ARM Windows 也友好（**值得写进 README 的加分结论**）；
不能跑或异常 → 记录现象，并在文档里注明"分发包需 ARM64 版本方能原生运行"。

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
| x64 包在 ARM 上跑通（B5） | `✅ 兼容性结论：win-x64 包可在 ARM Windows 运行（经 Prism）` |

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
| x64 Node 启动慢/异常 | 走 Prism 模拟 | 换 ARM64 Node 复核 |

---

## 7. 实际验证结果（2026-10-11，Parallels 27 + Win11 ARM）

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
| B2 v23 三防护 | ⏸ 阻塞：需改配置 + restart，而计划任务当前启动失败 |
| B3 v26 清理 | ⏸ 同上 |

### 实测新增的排查项（补进 §6）

| 现象 | 原因 | 处理 |
|---|---|---|
| 装了却连不上（TLS 握手不完成） | **x64 Node 在 Prism 下协议层异常** | 换 ARM64 Node |
| `control.ps1` 报"变量引用无效" | 脚本里 `$var:` 被当 drive 引用（**解析期**错误 → 整个脚本废） | 已修（写 `${var}`）；已加守卫 |
| 直接跑 `install.ps1` 后找不到 `PSK.txt` | **只有 `install.cmd` 才产生 PSK.txt** | 密钥在 `<数据目录>\agent.json` 的 `key` 字段 |
| 装完输入类能力不可用 | `install.cmd` 不传 `-AllowInput`（默认 false） | 用 `install.ps1 -AllowInput` |
| `nodeagent --node x cmd` 报"未知命令" | `--node` **前置需等号** | 写 `--node=x`，或放命令后 |
| 计划任务启动后端口不通 | 待查（手工跑正常） | `(Get-ScheduledTask -TaskName nodeagent).Actions` |
