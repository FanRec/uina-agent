# Minecraft 实现入口

更新时间：2026-11-08。基线 `codex/phase0-baseline`。批 0–19 已实现，**能力面 16 查询 + 35 动作 = 51/51 全部落地**（批19 关闭 G21 并接 `transit@1`）；批20（2026-11-03）关闭横向缺口 G6（节流 digest 推送，`world/digest.ts`，独立事件类型 `minecraft_digest` + 忙时只保最新）与 G7（`inventory@1 {since}` 增量游标，协议槽位变更标记）。**批41 已移除 `run {wait}` 短窗与旧同步等待**：顶层 `run/chat/runs.continue` 只回受理，完成由 `minecraft_completion` 独立投递，`runs.wait` 仅作状态查询。

2026-11-08 v2 闭环改造（提交 `31fa672c`）：`WorldDef.environmentGuide` + `turn.prepare` 注入 ENV（可组合、停用卸载）；`describe {kind:'guide'}` 提供六份官方只读 Guide，`nativeGuide` 精简为入口；`goto@1`/`route.plan@1` 默认 `placeToReach:false`；Body 撤销写不可变 `retiredBy` 并从 Effect 账本现算失败；Window 保留 `window_items.stateId` 并输出 `outcome/diagnostics`（真服工作台的"仅同步 full"不能判拒绝）；`excavate` 计划集合守恒、`collect` 候选分类与地面掉落清扫、`craft` 暴露 station 来源；MINE Program 以最新 `self/inventory` 终验，不满足即 `mc.decide`。真服 `dev:mc:task` MINE/SHELTER/NIGHT 全 PASS；`pnpm typecheck` 全绿；tests/mc 808 passed。剩余缺口 G9/G10、G12–G17、G24 见 known-gaps.md。

开工先读 [总规划 §10](../../../docs/proposals/mc/development-plan.md)、[开发规范](../../../docs/proposals/mc/development-guide.md)，再按需阅读 [公开合同](../../../docs/proposals/mc/public-api.md) 与所属模块。Host 回执行为见 [合同](../../../docs/proposals/runtime/delivery-receipts.md)，批 6 证据见 [实施记录](../../../docs/proposals/mc/native-host-implementation.md)。

真服入口仍为 `pnpm dev:mc`、`dev:mc:k1`、`dev:mc:k2`、`dev:mc:containers`、`dev:mc:k3`、`dev:mc:repair`、`dev:mc:production-repair`、`dev:mc:executor`、`dev:mc:places`（批11）。MC 专项使用显式 `tests/mc/*.test.ts` 列表与 vmThreads；Host/扩展及全仓使用默认池。真服历史记录见 dev/MC-WORLD.md，批 6 同时提供 `dev:mc:native` / `dev:mc:model`，覆盖真实 Host/Paper 与真实模型。

不要清理真实 `.uina/world-data`、profile、认证、会话或 Minecraft 世界。journal v4/history v4 保留原文件，使用新数据根，不自动迁移。dev-env 的启停：`start-server.ps1`（或直接 `java -jar paper-1.21.11-132.jar --nogui`）、`stop-server.mjs`（op 账号 /stop 优雅关服）、`reset-server.ps1`。
