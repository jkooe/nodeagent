# 版本与兼容性契约

> 为什么需要这份文档：agent 与 CLI/MCP 是**分开更新的**（CLI 随控制端装，agent 推/拉到被控端），
> 新旧混用是常态而非例外。没有明文契约，升级顺序、什么算破坏性改动、出问题怎么定位全靠猜。

## 0. 版本号唯一性规范（2026-10-10 确立）

> **背景**：项目早期同时存在两套编号 —— 发布版本（`v1.1.0`/`v2.0.0`）与开发批次代号（`v1`~`v26`）。
> 二者**从来不是一对一**（例：`v1.1.0` 首发时批次已推进到 `v12.4`），并列出现时无法判断哪个是"当前版本"。
> 自 v2.0.0 起统一为下列规则。

### 唯一版本号

**`vX.Y.Z`（semver）是项目唯一的版本标识**，两个来源必须永远一致：

| 来源 | 位置 | 谁在读 |
|---|---|---|
| git tag | `v2.0.0` | 人 / GitHub Release |
| `package.json` 的 `version` | 全部 workspace + `tauri.conf.json` | 构建期经 esbuild `--define` 注入 agent |

```bash
nodeagent info        # 被控端自报的 version 即来自这里
git tag -l            # 发布历史，唯一权威
```

### 开发批次代号（已并入发布版本）

`v1`~`v26` 是**开发阶段的内部代号**（一批相关改动的集合），**不是版本号，也不再单独出现**：

| 批次 | 内容 | **归属发布版本** |
|---|---|---|
| v1 ~ v12.4 | 命令级接管 → 事件订阅 / GUI 宏 / Hub 并发（首发前的全部积累） | **v1.1.0** |
| v12.2 ~ v15 | 等待语义 / macOS GUI 对齐 / 常驻助手 / 图像模板 | v1.2.1 ~ v1.4.x |
| v16 ~ v18 | 网络两阶段提交 / 音频 / 构建指纹 | v1.4.x |
| v19 ~ v22 | 拉取式自更新 / 证书钉住 / 每客户端 PSK / 发现最小化 | v1.5.0 ~ v1.6.0 |
| v23 ~ v26、语义属性化、状态采样 | 连接层三防护 / 零信任安装 / 审计锚定 / UIA 属性 / monitor | **v2.0.0** |

> 上表按 tag 时间线与功能内容推定，**近似**而非精确（批次与发布本无严格边界）。
> 判断"某个改动属于哪个版本"时，**以 CHANGELOG 的版本段落为准**，不以批次号为准。

### 书写规则（新代码 / 新文档）

| 场景 | 写法 | 例 |
|---|---|---|
| 引用发布版本 | `vX.Y.Z` | `v2.0.0 新增 gui.await` |
| 需要区分同一版本内的多批改动 | 用**功能名**，不用批次号 | `审计锚定（v2.0.0）` |
| 历史注释中的批次号 | 保留但**不得**再新增；见上表归属 | `v16：网络两阶段提交` |


## 1. 版本号

- 单一来源：**根 `package.json` 的 `version`**，构建时经 esbuild `--define` 注入 agent。
- 运行时可通过 `system.info` 的 `build` 字段读到：`version` / `commit`（git sha）/ `built_at` /
  `hash`（运行中脚本的 sha256 前 12 位 —— 部署校验用）。
- 控制端在握手（`auth_ok`）即拿到被控端版本，`nodeagent info` 会显示：
  ```
  被控端版本 : v1.0.0 @ ef9ad97  构建 740d51953fd0
  能力对齐   : 42 项，两端一致 ✓
  ```

## 2. 语义化版本的含义

| 变更类型 | 版本位 | 例子 |
|---|---|---|
| **破坏性**：删除能力、给既有能力**新增必填参数**、改变既有能力的返回结构、修改认证/握手流程 | MAJOR | 删掉 `screen.find`；把 `fs.read` 的 `path` 改成必填 `remote_path` |
| **新增**：新能力、既有能力的**可选**参数、新增返回字段、新增审计事件类型 | MINOR | 加 `system.audio.*`、给 `deploy` 加 `--check` |
| **修复/内部**：bug 修复、性能、文档、不影响协议的重构 | PATCH | 修备份编码、拆分文件 |

## 3. 兼容性契约（硬规则）

1. **只增不改**：既有能力的**参数名与语义不得变更**；要改就新增能力（如 `screen.find` 与未来的
   `screen.find2` 并存一代），旧能力至少在下一个 MAJOR 才移除。
2. **不新增必填参数**：既有能力只能加**可选**参数 —— 否则旧控制端一调就 `E_PARAM_INVALID`。
3. **返回结构只加不减**：新增字段必须可选，旧控制端忽略即可。
4. **`auth_ok` 的字段只增不减**：v20 新增的 `agent_version`/`build`/`protocol` 均为可选，
   旧控制端不认也不报错。
5. **协议主版本**（`PROTOCOL_VERSION` 的主号）不一致时被控端直接拒绝连接并返回
   `E_PROTOCOL_MISMATCH` —— 这是唯一的硬闸门，用于承载**无法兼容**的协议变更。
6. **能力清单是唯一事实源**：控制端不比版本号，而是比**能力集合**
   （`capabilityDiff`）—— 版本号可能相同而内容不同（本地 dev 构建），能力集合不会骗人。

## 3.1 v21 新增字段（均为**可选**，向后兼容）

| 位置 | 字段 | 含义 |
|---|---|---|
| 被控端 `agent.json` | `allow_from: string[]` | 来源网段白名单；**未配置 = 放行全部**（与旧行为一致） |
| 被控端 `system.info` | `build.cert_sha256` / `network.allow_from` | 证书指纹与白名单状态（供控制端展示与巡检） |
| 被控端 `auth_ok` | `build.cert_sha256` | 同上（握手期即可得） |
| 控制端 `nodes.<名>` | `cert_sha256: string` | **钉住**的被控端证书指纹；不一致即 `E_CERT_MISMATCH` 拒连 |
| 发现报文 | `cert_sha256` | 未认证广播，**仅作参考**，不可当身份凭据 |

新增错误码：`E_CERT_MISMATCH (-32422)`、`E_NET_DENY` 类事件走审计 `net.deny`。

## 4. 升级顺序建议

**先升级被控端，再升级控制端**：

| 组合 | 结果 |
|---|---|
| 新被控端 + 旧控制端 | ✅ 安全。被控端只做加法，旧控制端不认识的新能力会被忽略 |
| 旧被控端 + 新控制端 | ⚠️ 可用，但新功能不可用。`nodeagent info` 会列出**远端缺少**的能力并提示升级 |

> 若顺序反了也不会坏：控制端调用缺失能力时返回 `E_CAPABILITY_NOT_FOUND`，
> 而 `nodeagent info` / `connect` 会提前把它变成一句人话提示。

## 5. 更新方式（两条路，按可达性选）

| 方式 | 命令 | 前提 |
|---|---|---|
| 推送式 | `pnpm update:win <设备名>` | 控制端↔被控端**可达**；自动打包含校验与指纹复核 |
| **拉取式** | `nodeagent update --url <地址> --sha256 <哈希>` | **只要被控端能上网**（含 GitHub Release） |

先预检再更新（不动任何文件）：

```bash
nodeagent --node win update --url <地址> --sha256 <哈希> --dry-run
```

`--sha256` 是**安全底线**：不校验哈希等于开放远程代码执行。

## 6. 发版流程

```bash
pnpm release patch|minor|major|<x.y.z>   # 改版本 → 构建 → 打包 → 校验和/清单 → 提交打标签 → GitHub Release
pnpm release 1.0.0 --dry-run             # 演练（无任何副作用）
```

产物（GitHub Release 资产）：

| 资产 | 用途 |
|---|---|
| `agent.mjs` | **自更新载荷** —— 被控端 `system.agent.update` 直接用它（配 `--sha256`） |
| `nodeagent-win-x64.zip` | 人工安装包（自包含 `node.exe`，免装 Node.js） |
| `latest.json` | 版本清单：version/commit/built_at/capabilities + 两个资产的 url 与 sha256 |
| `SHA256SUMS` | 校验和 |

> ⚠️ **首次仍需一次性安装**：自更新能力本身得先在机器上（鸡生蛋无解）。
> ⚠️ **`node.exe`（Node 运行时）不在自更新范围**：只换 `agent.mjs`；需升级 Node 时重跑 `install.ps1`。
> ⚠️ 本仓库的 `.github/` 改动需要 `workflow` 权限才能推送（`gh auth refresh -h github.com -s workflow`），
> 发版脚本刻意跳过 `.github/`，避免发版流程被它卡住。

## 7. 出问题怎么排查

```bash
nodeagent --node win info                       # 版本 + 能力对齐情况（先看这个）
nodeagent --node win invoke system.info --args '{"fields":["build"]}'   # 构建指纹
nodeagent --node win deploy <包> --check        # 本地包 vs 远端是否一致（不改动）
```

- **远端过旧**：`info` 会列出缺失能力 → `nodeagent update ...`
- **本控制端过旧**：`info` 会列出"不认识的新能力" → 更新控制端（`git pull` → `pack:mac` → `install-macos.sh`）
- **同版本但指纹不同**：属正常（内容相同才叫同版本）；用 `--check` 对比实际内容
- **部署后没生效**：先查杀软是否处置了被替换的 `agent.mjs`（见 `REMOTE-LIMITS.md` 的「杀软误拦」）
