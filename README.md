# nodeagent

> **跨机 AI 接管框架** —— 让 MacBook 上的 AI 无缝接管 Windows，装软件、查状态，如同操作同一台电脑

## 这是什么

nodeagent 让 Mac 上的 AI（WorkBuddy）通过统一协议接管局域网内的 Windows 机器——执行命令、装软件、查状态。

## 当前状态

✅ 需求已定（PRD v1.0 已认可），开发待启动。

## 文档

- [产品需求文档（PRD）](./PRD.md)
- [开发文档（DEVELOPMENT）](./docs/DEVELOPMENT.md)

## 分阶段路线

| 阶段 | 目标 |
|---|---|
| v1 | 命令级接管 + 装软件 + 查状态 + 基本鉴权 + CLI + MCP |
| v2 | 图形接管（截屏 + 键鼠模拟）+ 能力级 ACL |
| v3 | 无感体验 + 零信任 + 多端扩展 |

## 关键决策速览

| 决策点 | 结论 |
|---|---|
| 架构拓扑 | 点对点直连（Mac ↔ Windows，无中枢） |
| 端 | Mac + Windows 同时 |
| 安全 | 先简化（预共享密钥）→ 后强化（零信任） |
| AI 接入 | 核心能力 → CLI → MCP |
