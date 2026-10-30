# Minecraft 实现入口

更新时间：2026-10-30。基线 `codex/phase0-baseline`。批 0–10 与批 11 已实现：批 11 落地领域记录（world-history.db records 表，history SCHEMA v4，旧库拒绝不迁移）、`places@1`/`remember@1`/`forget@1`、`route.plan@1`（组合根注入 `WorldRoutePlanner` 窄端口）与 `explore@1`；WorldPort 增 `removeRecord`。能力面 **12 查询 + 18 动作（30/51）**。

开工先读 [总规划 §10](../../../docs/proposals/mc/development-plan.md)、[开发规范](../../../docs/proposals/mc/development-guide.md)，再按需阅读 [公开合同](../../../docs/proposals/mc/public-api.md) 与所属模块。Host 回执行为见 [合同](../../../docs/proposals/runtime/delivery-receipts.md)，批 6 证据见 [实施记录](../../../docs/proposals/mc/native-host-implementation.md)。

真服入口仍为 `pnpm dev:mc`、`dev:mc:k1`、`dev:mc:k2`、`dev:mc:containers`、`dev:mc:k3`、`dev:mc:repair`、`dev:mc:production-repair`、`dev:mc:executor`、`dev:mc:places`（批11）。MC 专项使用显式 `tests/mc/*.test.ts` 列表与 vmThreads；Host/扩展及全仓使用默认池。真服历史记录见 dev/MC-WORLD.md，批 6 同时提供 `dev:mc:native` / `dev:mc:model`，覆盖真实 Host/Paper 与真实模型。

不要清理真实 `.uina/world-data`、profile、认证、会话或 Minecraft 世界。journal v4/history v4 保留原文件，使用新数据根，不自动迁移。dev-env 的启停：`start-server.ps1`（或直接 `java -jar paper-1.21.11-132.jar --nogui`）、`stop-server.mjs`（op 账号 /stop 优雅关服）、`reset-server.ps1`。
