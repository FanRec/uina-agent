# Minecraft 实现重做入口

更新时间：2026-10-22。当前目录已有 I1 子集实现（contracts / driver / world / runtime / capabilities）与 dev/entry.ts；K1 能力子集已整批回退，不再计入。

本目录开发者开工前先读 [总开发规划](../../../docs/proposals/mc/development-plan.md) 和 [开发规范](../../../docs/proposals/mc/development-guide.md)，再按需阅读所属模块。规范中的接口/所有权、真实结果、退出与验证要求适用于本次重做；不要求特定代理工具、假 Bot 先行或每个小步骤都提交。

## 权威设计

- [状态与导航](../../../docs/proposals/mc/README.md)、[概要](../../../docs/proposals/mc/design.md)。
- [完整开发规划](../../../docs/proposals/mc/development-plan.md)、[开发规范](../../../docs/proposals/mc/development-guide.md)。
- [跨模块合同](../../../docs/proposals/mc/contracts.md)、[公开类型](../../../docs/proposals/mc/public-api.md)。
- [Executor](../../../docs/proposals/mc/modules/executor.md)、[Runtime](../../../docs/proposals/mc/modules/runtime.md)、[Program](../../../docs/proposals/mc/modules/program.md)、[Library](../../../docs/proposals/mc/modules/library.md)。
- [Driver](../../../docs/proposals/mc/modules/driver.md)、[World](../../../docs/proposals/mc/modules/world.md)、[能力面](../../../docs/proposals/mc/modules/capabilities.md)。
- 通用 Host 交付依赖：[持久交付回执](../../../docs/proposals/runtime/delivery-receipts.md)。

I1 已接通：`pnpm dev:mc` 跑 read self → chat → 近距 goto → 远距 goto 运行中 stop → 静止证明 → close；`tests/mc` 9 files / 46 tests 无需服务端。后续按总规划推进剩余能力组、Program/Library、Host 回执完整验收与 Executor。

不要清理 `.uina/world-data/minecraft`、profile 数据或其他运行数据；本次只移除源码、旧测试和对应开发接线。
