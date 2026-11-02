# Minecraft 实现入口

更新时间：2026-11-03。基线 `codex/phase0-baseline`。批 0–19 已实现，**能力面 16 查询 + 35 动作 = 51/51 全部落地**（批19 关闭 G21 并接 `transit@1`）；批20（2026-11-03）关闭横向缺口 G6（节流 digest 推送，`world/digest.ts`，独立事件类型 `minecraft_digest` + 忙时只保最新）、G7（`inventory@1 {since}` 增量游标，协议槽位变更标记）与 G8（`run {wait}` 按调用短窗）。真服 `dev:mc:digest` 7/7、tests/mc 771 项全绿。剩余缺口 G9/G10、G12–G17、G24 见 known-gaps.md。真服历史见 dev/MC-WORLD.md，文档合同见 docs/proposals/mc/（changelog/known-gaps/capabilities/public-api 均已同步批 20）。

开工先读 [总规划 §10](../../../docs/proposals/mc/development-plan.md)、[开发规范](../../../docs/proposals/mc/development-guide.md)，再按需阅读 [公开合同](../../../docs/proposals/mc/public-api.md) 与所属模块。Host 回执行为见 [合同](../../../docs/proposals/runtime/delivery-receipts.md)，批 6 证据见 [实施记录](../../../docs/proposals/mc/native-host-implementation.md)。

真服入口仍为 `pnpm dev:mc`、`dev:mc:k1`、`dev:mc:k2`、`dev:mc:containers`、`dev:mc:k3`、`dev:mc:repair`、`dev:mc:production-repair`、`dev:mc:executor`、`dev:mc:places`（批11）。MC 专项使用显式 `tests/mc/*.test.ts` 列表与 vmThreads；Host/扩展及全仓使用默认池。真服历史记录见 dev/MC-WORLD.md，批 6 同时提供 `dev:mc:native` / `dev:mc:model`，覆盖真实 Host/Paper 与真实模型。

不要清理真实 `.uina/world-data`、profile、认证、会话或 Minecraft 世界。journal v4/history v4 保留原文件，使用新数据根，不自动迁移。dev-env 的启停：`start-server.ps1`（或直接 `java -jar paper-1.21.11-132.jar --nogui`）、`stop-server.mjs`（op 账号 /stop 优雅关服）、`reset-server.ps1`。
