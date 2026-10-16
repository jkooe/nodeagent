# nodeagent 交付流水线规范

> 本文是《代码审计 → 上线 完整交付方案》v1.0（2026-10-14）在 **nodeagent** 项目上的落地适配。
> 适配日期：2026-10-17。基线提交：`590f62e`。

---

## 0. 适配原则（先说清楚为什么不能照搬）

原方案面向 **Web/容器服务**（FinDataHub / reader·bookshelf / OnlyInOne）——有服务端、有镜像、
有多套环境、有线上流量。nodeagent 与之有三处根本差异，照搬会产生**假门禁**（跑得很好但守不住任何东西）。

因此本文对每一阶段给出三档判定：

| 判定 | 含义 | 处置 |
|---|---|---|
| **适用** | 原样落地即可 | 直接实施 |
| **改造后适用** | 目标一致，但形态不同 | 换等价手段，并说明为什么等价 |
| **不适用** | 本项目不存在该风险面 | **必须给出替代手段**，不允许只写「N/A」了事 |

> **为什么「不适用」也必须给替代**：原方案每项都对应一类真实风险。若某类风险在本项目不存在，
> 说明风险换了形态，替代手段才是真正守它的东西；直接跳过等于承认该风险无人看守。

### nodeagent 项目画像

| 维度 | 事实 |
|---|---|
| 形态 | monorepo：TypeScript（agent/cli/mcp/hub/protocol）+ Rust（Tauri 控制台壳） |
| 交付物 | Windows 安装包 zip（含 `node.exe` + `agent.mjs`）、macOS CLI 三件套、macOS Tauri 控制台 app |
| 运行位置 | 常驻在**用户自己的机器**上（Windows/Linux/macOS），非服务器 |
| 有无服务端 | **无**（点对点直连 + 可选 Hub 中转，Hub 不在本仓库） |
| 有无容器 | **无** |
| 更新方式 | 被控端**拉取式自更新**（`system.agent.update` 读 `latest.json` + sha256） |
| 现有测试 | 单测 **341**（全绿）/ 协议 e2e / Windows 真机 e2e / Rust `cargo test` |

---

## 1. 代码审计（四维扫描 + 漏洞分级）

原方案四维：SAST / SCA / 密钥扫描 / 容器镜像。

| 维度 | 判定 | 现状 | 落地动作 |
|---|---|---|---|
| SAST 静态安全 | **适用** | ❌ 无 | 引入 Semgrep（TS/JS 规则集）进 CI，阻断 High 及以上 |
| SCA 依赖漏洞 | **适用** | ❌ 无 | `pnpm audit --audit-level=high` 进 CI；锁文件已入库 ✅ |
| 密钥与敏感信息 | **适用** | ⚠️ **有巡检无门禁** | 每日定时任务已做隐私巡检（`security-reports/`），但**不阻断合并** → 加 gitleaks 进 CI |
| 容器镜像 | **不适用** | — | 无容器。**替代：交付物断言**（见下） |

### 替代：交付物断言（比镜像扫描更贴本项目的那一层）

nodeagent 的「制品风险」不在镜像层，而在**分发包本身**。已有两道断言，本文将其升格为正式门禁：

1. **PE 架构断言**（`scripts/lib/zip-pe-arch.mjs`）：解出最终 zip 内的 `node.exe` 读 PE 头，
   与期望架构比对。
   - 缘起（2026-10-11 事故）：arm64 包里装进了 x64 的 `node.exe`，该包在 ARM Windows 上
     **能启动、能 listen，只是 TLS 握手不完成** —— 单测/CI/macOS 侧全都抓不到，
     且两个公开包内 `node.exe` 的 sha256 完全相同。
2. **打包期守卫**（`scripts/pack.mjs`）：`.ps1` 必须带 UTF-8 BOM、`.cmd` 必须纯 ASCII + CRLF。
   这两条各自对应一次真机事故（PowerShell 5.1 解析失败 / CMD 代码页截断）。

> **为什么这两条比通用镜像扫描更要紧**：镜像扫的是「第三方引入的漏洞」，
> 而这两条守的是「我们自己把错误的东西发了出去」——后者是本项目历史上真实发生过的。

### 准入判据（硬门禁）

- Critical / High 漏洞数 **必须为 0**，一票否决。
- Medium 登记并附限期修复计划；Low 可接受但须留痕。
- **黄金法则沿用**：密钥一旦提交即视为泄露，删除提交只是止损，**立即轮换**才是根治。
  nodeagent 的密钥面比一般项目大：PSK、Ed25519 私钥、TLS 自签证书 —— 轮换路径已在
  `docs/SECURITY.md` §6 应急处置中定义。

---

## 2. 质量门禁（Quality Gate）

| 指标 | 原方案阈值 | 现状 | 落地动作 |
|---|---|---|---|
| 新增代码覆盖率 | ≥ 80% | ❌ **未采集** | `node --test --experimental-test-coverage` 采集，设阈值（见下） |
| 圈复杂度 ≤ 10/方法 | — | ❌ 未检 | 暂不接入（见说明） |
| 重复率 ≤ 3% | — | ❌ 未检 | 暂不接入 |
| 坏味道新增 0 | — | ❌ 未检 | 暂不接入 |
| 阻断性 Bug 0 | — | ✅ `typecheck` + `clippy -D warnings` | 保持 |

**关于覆盖率阈值的现实校准**：原方案 80% 面向新项目。nodeagent 存量 341 个单测集中在
协议/编码/安全守卫，**部分模块（GUI 注入、平台脚本）无法在 CI 上无头验证**。
故采用**增量口径**：

- 全量覆盖率**先只观测、不阻断**（出数字，建立基线）；
- **新增/修改文件的行覆盖率 ≥ 70% 才阻断**；
- 无法无头验证的模块显式标注豁免，并在文档中列出理由。

> 直接照搬 80% 全量阈值会导致两种后果：要么长期挂 `--skip`（门禁形同虚设），
> 要么逼迫团队为 GUI 注入代码写无意义的假断言。**门禁的价值在于守得住，不在于数字好看。**

**关于圈复杂度/重复率**：需引入 SonarQube，但对本地优先的单人项目运维成本高于收益，
本文标记为**可选项**，不进阻断门禁。

---

## 3. 自动化测试（金字塔分层）

| 层 | 判定 | 现状 | 说明 |
|---|---|---|---|
| 单元测试 | **适用** | ✅ **341 全绿** | `pnpm test:unit` |
| 集成测试 | **适用** | ✅ 协议 e2e | `pnpm test:e2e`（TLS / ed25519 / 发现 / 重连 / 文件 / Hub） |
| E2E 关键路径 | **适用** | ✅ **Windows 真机 e2e** | `pnpm test:windows`（含 `install.cmd` 双击链路）——**强于原方案**（真机而非模拟） |
| DAST 动态扫描 | **不适用** | — | 无对外 Web 服务面。**替代：协议健壮性测试** |

### 替代：协议健壮性测试（对应「运行态注入」这一类风险）

DAST 守的是「外部输入打进来会怎样」。nodeagent 的对外输入面是 **WebSocket RPC**，
已有等价覆盖（`tests/e2e/run.mjs` 内）：

- 畸形 `hello`（protocol 传数字 / 传对象）
- 畸形 `auth`（hmac 传数字 / 对象 + nonce 为 null）
- **未认证直接 invoke**（U-01：必须留审计且不崩）
- 未知能力 / 参数非法 / ACL 拒绝 / 超频

> 这比通用 DAST 更精准：DAST 是黑盒猜测，这里是针对本项目协议状态机的定向攻击面覆盖。

**缺口**：畸形报文目前是**枚举式**用例，未做随机化 fuzz。建议后续加一轮
「随机字节 + 随机 JSON 结构」的模糊测试 → 记为可选改进项。

---

## 4. CI/CD 构建与制品

| 项 | 判定 | 现状 |
|---|---|---|
| 流水线 lint→test→build→scan | **适用** | ⚠️ 有 test/build/typecheck，**缺 scan** |
| 制品仓库 | **改造后适用** | ✅ GitHub Release（非镜像仓库） |
| 版本号 = 语义化 + git SHA | **适用** | ✅ 语义化版本；`release.mjs` 统一写入 11 处 |
| 签名与追溯 | **改造后适用** | ⚠️ 有 sha256 + `latest.json`，**无 cosign/SBOM** |

### 签名与追溯：容器 cosign 不适用，改为「分发包完整性」三件套

cosign 签的是容器镜像。nodeagent 分发的是 zip + `agent.mjs`，等价保障是：

1. **sha256 入库**：`SHA256SUMS.txt` 随包发布（已有）。
2. **包内容清单**：zip 内文件列表与体积随 release 记录，用于事后核对「发出去的到底是什么」。
3. **可验签**：`system.agent.update` **强制校验 sha256**（不校验等于开放远程代码执行）。
   这是本项目**最强的一道**——被控端只认哈希，不认「看起来对」的包。

> **待补（可选）**：对 `agent.mjs` 做 detached GPG 签名，供高安全场景人工验签。
> 注意这不能替代 sha256 —— 被控端目前不支持验签，加签名只服务于人工审计场景。

### 现有 CI 的已知待改项

- `retention-days: 30` → 建议 **7**（CI artifact 公开可下载，留存越久暴露面越大）。
- 三个 workflow 均未集成密钥/依赖扫描（见 §1）。

---

## 5. 分级环境发布（dev / staging / prod）

**判定：不适用**，但必须给替代。

nodeagent 无服务端、无多环境：`agent` 跑在用户自己的机器上，控制端是本机 CLI。
「dev/staging/prod」这类环境隔离在物理上不存在。

### 替代：真机矩阵验证

风险换成了形态 —— 不是「哪个环境先炸」，而是「哪类机器先炸」。nodeagent 已多次栽在
**平台差异**上（CRLF、路径分隔符、verbatim 路径、ARM Windows 的 TLS、PowerShell 5.1 的 BOM）。

故替代为**真机矩阵**：

| 平台 | 架构 / 形态 | 验证方式 |
|---|---|---|
| Windows | x64 | `tests/e2e/windows.mjs`（`windows-latest` runner） |
| Windows | **arm64** | 真机验证（CI 无 arm64 Windows runner，必须人工） |
| macOS | CLI 三件套 | 本机安装冒烟 |
| macOS | Tauri 控制台 | `console-windows.yml` 构建 + `verify-bundle.mjs` |
| Linux | systemd 被控端 | `docs/DEPLOY-LINUX.md` + 真机验证 |

> **矩阵里最弱的一环是 Windows arm64** —— CI 覆盖不到，而它恰恰是历史上出过
> 「能启动但 TLS 握手不完成」这一最难发现故障的平台。本文将其列为**发版前必查项**。

---

## 6. 生产发布策略

| 原方案策略 | 判定 | 说明 |
|---|---|---|
| 滚动发布 | 不适用 | 无多实例 |
| 蓝绿部署 | 不适用 | 无流量切换 |
| 金丝雀 | **改造后适用** | 改为**设备分批**：先一台试点 |
| Feature Flag | 适用（有限） | 能力级 ACL 可视为开关 |

### 改造：金丝雀 → 设备分批自更新

被控端是**拉取式**更新（读 `latest.json`），天然支持分批：

1. **试点**：选 1 台可达且物理可及的设备先更新，观察 ≥ 30 分钟。
2. **放量**：确认无异常后，其余设备再触发更新。
3. **回滚**：每设备保留上一版本备份（`agent.mjs.bak-<ts>`）+ `latest.json` 可回退。

### ⚠️ 本项目特有风险：发布即失联（原方案未覆盖）

这是 nodeagent **最严重**的上线失败形态，且原方案完全没有对应条款：

> 一次失败的 agent 更新，会让一台**物理不可达**的远程设备**永久脱管**。
> 对 Web 服务，发布失败可以回滚、可以摘流量；对被控端，**回滚通道本身就是被更新的那个程序**。

缓解措施（部分已有，本文整合为强制项）：

| 措施 | 状态 |
|---|---|
| 更新前备份当前 `agent.mjs` | ✅ 已有 |
| **先备份再原子替换**（同目录 rename，失败可回滚） | ✅ 已有 |
| **sha256 强制校验**（不校验不落盘） | ✅ 已有 |
| 更新后**重启并轮询校验新指纹**上线 | ✅ 已有（`deploy` 闭环） |
| **保留「最后已知可用版本」标记（LKG）** | ✅ **本次落地**（`apps/agent/src/lkg.ts`） |
| **更新后健康检查失败 → 自动回滚到备份** | ⚠️ **刻意不做**，见下 |

### LKG 的设计（本次落地）

- **写入时机**：agent **成功启动后**（服务器已 listen、心跳已起）才写 `agent-lkg.json`。
  **不在更新写完时就写** —— 那会把尚未验证的版本当成已知可用，LKG 就失去意义。
- **内容**：`hash`（与 `system.info` 的 `build.hash` 同口径）、`bytes`、`script_path`、
  `recorded_at`、`node_version`、`platform`。
- **暴露**：`system.info.lkg = { lkg, current_hash, matches, byte_delta }`。
  `matches=false` = 当前版本还没被证明能启动 → 控制端应**暂缓向其余设备放量**。

### 为什么**不做**自动回滚（明确的设计取舍）

自动回滚听起来更安全，但在远程被控端上会引入更坏的失败形态：

1. **无法归因**：远程设备上区分不出「更新本身坏了」与「网络抖动 / 端口被占 / 依赖服务未起」。
2. **回滚循环**：回滚 → 启动 → 又判定失败 → 再回滚。在无人值守设备上，这比「停在坏版本」更难恢复。
3. **失控**：被控端一旦自作主张改自己的程序，控制端就失去对「当前跑的到底是什么」的掌控。

故定位为：**LKG 提供确定的回滚目标，决策权留给控制端**（`nodeagent rollback` 读 LKG → 覆盖回入口 → 重启）。
现有 `system.agent.update` 已具备备份、哈希校验、写后校验、不一致即回滚 —— 那是**写入期**的闭环；
**运行期**的可用性判断交给人，不交给一个可能误判的自动机。

---

## 7. 上线监控与复盘

| 支柱 | 判定 | nodeagent 对应 |
|---|---|---|
| 指标 | **改造后适用** | `system.metrics`：闭环成功率 / P95 时延 / 安全拦截率 / 装软件成功率 |
| 日志 | **适用** | 审计日志 JSONL（哈希链 + 外部锚定），见 `docs/SECURITY.md` §4.8 |
| 链路追踪 | 不适用 | 点对点调用，无分布式链路 |
| 告警 | 改造后适用 | 无值班通道；改为**发版后主动复核** |

### 发布后复核清单（替代 Prometheus 盯盘）

| 项 | 命令 | 期望 |
|---|---|---|
| 能力数未减少 | `nodeagent list` | 与发版前一致 |
| 审计链完整 | `nodeagent audit verify` | `ok: true` |
| 锚点自洽 | `nodeagent audit anchor --compare` | 无「整链重写」告警 |
| 核心能力可用 | `node scripts/verify.mjs --host … --key …` | 全绿 |
| 指标未恶化 | `nodeagent metrics` | 闭环率 ≥ 95%、拦截率 100% |

### 复盘

已有载体：`bug-report-2026-10-13.html`（缺陷台账）、`docs/RETROSPECTIVE.md`（短板复盘）、
`security-reports/YYYY-MM-DD.md`（每日巡检）。

**待补**：原方案要求「任何事故/回滚必须写复盘 —— 时间线、根因、改进项、责任人」。
本项目为单人项目，「责任人」不适用，改为**改进项是否进入守卫**（即：是否变成一条会红的断言）。

> 这是本项目复盘最有价值的一问：**没有变成断言的复盘，等于没有复盘**。
> 历史上多次同类事故复发（CRLF、路径、编码）都栽在这一点上。

---

## 8. 落地清单（Action Checklist）

按优先级排序，✅ 表示本次已落地：

- [x] 建立 `.gitignore` 密钥基线（`PSK.txt` / `keys/` / `*.key` / `*.pem` / `config.json` / `agent.json`）— **已有**
- [x] 密钥扫描（gitleaks）进 CI 并阻断合并 — **本次落地**（`quality-gate.yml`）
- [x] 依赖漏洞扫描（`pnpm audit --audit-level=high`）进 CI — **本次落地**
- [ ] SAST（Semgrep TS/JS 规则集）进 CI — **未做**：需先定规则集，否则噪声会淹没真问题
- [x] 覆盖率采集接入 CI（全量观测 + 变更文件 ≥70% 阻断）— **本次落地**（`scripts/ci/check-coverage.mjs`）
- [x] 提交信息规范强制（Conventional Commits + CI 校验）— **本次落地**（`scripts/ci/check-commit-msg.mjs`）
- [x] 交付物 PE 架构断言 — **已有**，升格为门禁
- [x] 打包期 `.ps1` BOM / `.cmd` ASCII+CRLF 守卫 — **已有**
- [x] CI artifact `retention-days` 30 → 7 — **本次落地**
- [x] 保留「最后已知可用版本」标记（LKG）— **本次落地**
- [ ] 分支保护：main 需 PR + CI 全绿 — **需仓库设置**（当前 protection 返回 404，已知 P1）
- [ ] 发版前 Windows arm64 真机必查（CI 覆盖不到）— **流程项**，已写入本文档
- [ ] 协议模糊测试（随机报文 fuzz）— **可选改进项**

### 本次落地的实测证据

| 项 | 证据 |
|---|---|
| 覆盖率门禁 | 三条故障注入均 `exit=1`（阈值 100 / 全量 99 / lcov 缺失）；正常路径 `exit=0` |
| 覆盖率基线 | 全量 **66.9%**（6399/9560 行，54 文件）—— 印证「照搬 80% 全量不现实」 |
| 提交规范校验 | 反例 3 类均红（无类型 / wip / 类型拼错）；Merge 与无 scope 正确豁免；**历史 20 条提交一次通过** |
| LKG | 新增 8 条单测全绿；含「篡改 hash 必须检出 matches=false」故障注入 |
| 契约守卫 | 新增 `lkg` 字段后，既有契约测试**立刻报红**（`SystemInfo` 缺声明）→ 补接口后转绿。这本身是门禁有效的实证 |
| 全量单测 | **349 全绿**（落地前 341） |
| 门禁会红的验证 | 覆盖率 3 注入 + LKG 1 注入，均实测为真红，非摆设 |

---

## 附录 A：CI 骨架（GitHub Actions，适配 nodeagent）

```yaml
# .github/workflows/quality-gate.yml
name: Quality Gate
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      # 密钥扫描：历史 + 增量（nodeagent 密钥面：PSK / ed25519 / TLS 私钥）
      - uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
      # 依赖漏洞
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm audit --audit-level=high

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      # 覆盖率：全量出数字（观测），增量阈值由 coverage-gate 判定
      - run: node --test --experimental-test-coverage --test-reporter=lcov \
             --test-reporter-destination=coverage/lcov.info "tests/unit/**/*.test.mjs"
      - uses: actions/upload-artifact@v4
        with: { name: coverage, path: coverage/, retention-days: 7 }
```

> **注**：`windows-e2e.yml` 保留原样 —— 它跑的是真机链路（`install.cmd` / `control.cmd` 双击），
> 是本项目 CI 里最有价值的一环，不可被「更快」的 Linux 流水线替代。

## 附录 B：提交信息规范

项目**实际已在用** Conventional Commits（`git log` 可验证），但**无强制**。补齐校验：

```
<type>(<scope>): <subject>

type: feat | fix | docs | style | refactor | perf | test | chore | ci
scope: agent | cli | mcp | hub | protocol | console | pack | release | linux | …
```

示例（取自实际提交）：

```
feat(linux): Linux 被控端适配 —— 安装器 + systemd 自启 + 平台守卫 + 部署文档
fix(console): sidecar 补 CREATE_NO_WINDOW（不再弹常驻黑窗）
chore(privacy): 公开仓库隐私脱敏 —— 清除可定位到个人与设备的字面量
```

## 附录 C：回滚检查清单（nodeagent 版）

**触发回滚的条件（满足任一）**

- 目标设备**失联**（更新后无法连接，且已排除网络问题）—— **最高优先级**
- `nodeagent list` 能力数少于发版前
- `nodeagent audit verify` 返回 `ok: false`
- `verify.mjs` 出现失败项

**回滚动作**

1. 登录目标机（物理或带外方式），用备份恢复：`agent.mjs.bak-<ts>` → `agent.mjs`。
2. 若需回退发布通道：把 `latest.json` 指回上一版本 URL + sha256。
3. 重启 agent（计划任务或 `run-temp.cmd`）。
4. 复核：`verify.mjs` 全绿 → 记录时间线 → 写复盘 → **把根因变成一条会红的断言**。

---

## 变更记录

| 日期 | 内容 |
|---|---|
| 2026-10-17 | 初版。基于《代码审计 → 上线 完整交付方案》v1.0 适配，基线 `590f62e`，单测 341 全绿。 |
