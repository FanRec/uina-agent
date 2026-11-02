# Minecraft 实现入口

更新时间：2026-11-02。基线 `codex/phase0-baseline`。批 0–18 已实现：批 18 落地 K8 四动作 `sleep@1`/`fish@1`/`ride@1`/`lead@1`（真服 K8 验收 16/16，身体证据窗口 `awaitBodyEvent` + 1.21.2+ 载具客户端权威驾驶 + 链接事实缓存；马驾驶缺口登记 G23）。能力面 **16 查询 + 34 动作（50/51）**；仅剩 `transit@1`（受 G21 上坡楔死与 G23 牵制）。真服历史见 dev/MC-WORLD.md，文档合同见 docs/proposals/mc/（changelog/known-gaps/capabilities 均已同步批 18）。

开工先读 [总规划 §10](../../../docs/proposals/mc/development-plan.md)、[开发规范](../../../docs/proposals/mc/development-guide.md)，再按需阅读 [公开合同](../../../docs/proposals/mc/public-api.md) 与所属模块。Host 回执行为见 [合同](../../../docs/proposals/runtime/delivery-receipts.md)，批 6 证据见 [实施记录](../../../docs/proposals/mc/native-host-implementation.md)。

真服入口仍为 `pnpm dev:mc`、`dev:mc:k1`、`dev:mc:k2`、`dev:mc:containers`、`dev:mc:k3`、`dev:mc:repair`、`dev:mc:production-repair`、`dev:mc:executor`、`dev:mc:places`（批11）。MC 专项使用显式 `tests/mc/*.test.ts` 列表与 vmThreads；Host/扩展及全仓使用默认池。真服历史记录见 dev/MC-WORLD.md，批 6 同时提供 `dev:mc:native` / `dev:mc:model`，覆盖真实 Host/Paper 与真实模型。

不要清理真实 `.uina/world-data`、profile、认证、会话或 Minecraft 世界。journal v4/history v4 保留原文件，使用新数据根，不自动迁移。dev-env 的启停：`start-server.ps1`（或直接 `java -jar paper-1.21.11-132.jar --nogui`）、`stop-server.mjs`（op 账号 /stop 优雅关服）、`reset-server.ps1`。
