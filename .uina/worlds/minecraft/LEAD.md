# Minecraft 实现入口

更新时间：2026-10-25。基线 `codex/phase0-baseline` / `6fbd9a4`。批 0–3 能力与生产链修复、批 4 Executor 平台已入库；批 5 通用 Host 持久回执已实现并随本批提交。能力面仍为 **10 查询 + 15 动作（25/51）**。

批 4 有 Windows x64 双 Job、受管 bootstrap/Companion、固定 IPC、Owner/心跳/三门、停止/退役/恢复。批 5 有 journal v4、工具与输入 receipt、提交索引、来源绑定 inspect/retire、Mailbox 去重与 World 上下文接线。

下一任务是 **批 6：正式原生主脑入口与可靠通知及首次模型校准**。Program/Library、等待/决策与完整 I2 按批 7–9 推进；其余玩法按实际依赖与校准收益选择。当前没有正式 minecraft 模型工具，不能以开发脚本替代主脑游玩验收。

开工先读 [总规划 §10](../../../docs/proposals/mc/development-plan.md)、[开发规范](../../../docs/proposals/mc/development-guide.md)，再按需阅读 [公开合同](../../../docs/proposals/mc/public-api.md) 与所属模块。Host 回执行为见 [合同](../../../docs/proposals/runtime/delivery-receipts.md)，本轮证据见 [实施记录](../../../docs/proposals/mc/host-delivery-implementation.md)。

真服入口仍为 `pnpm dev:mc`、`dev:mc:k1`、`dev:mc:k2`、`dev:mc:containers`、`dev:mc:k3`、`dev:mc:repair`、`dev:mc:production-repair`、`dev:mc:executor`。MC 专项使用显式 `tests/mc/*.test.ts` 列表与 vmThreads；Host/扩展及全仓使用默认池。真服历史记录见 dev/MC-WORLD.md，本轮只验证 Host/Session 责任。

不要清理真实 `.uina/world-data`、profile、认证、会话或 Minecraft 世界。journal v3 保留原文件，使用新 v4 会话，不自动迁移。
