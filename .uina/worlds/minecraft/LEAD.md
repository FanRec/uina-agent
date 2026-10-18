# Minecraft 实现重做入口

更新时间：2026-10-19。当前目录只保留本入口；旧 Driver、World、Assets、contracts、Executor、WorldDef、对应测试及 Worker 验证器已删除。

本目录开发者开工前先读 [总开发规划](../../../docs/proposals/mc/development-plan.md) 和 [开发规范](../../../docs/proposals/mc/development-guide.md)，再按需阅读所属模块。规范中的接口/所有权、真实结果、退出与验证要求适用于本次重做；不要求特定代理工具、假 Bot 先行或每个小步骤都提交。

## 权威设计

- [状态与导航](../../../docs/proposals/mc/README.md)、[概要](../../../docs/proposals/mc/design.md)。
- [完整开发规划](../../../docs/proposals/mc/development-plan.md)、[开发规范](../../../docs/proposals/mc/development-guide.md)。
- [跨模块合同](../../../docs/proposals/mc/contracts.md)、[公开类型](../../../docs/proposals/mc/public-api.md)。
- [Executor](../../../docs/proposals/mc/modules/executor.md)、[Runtime](../../../docs/proposals/mc/modules/runtime.md)、[Program](../../../docs/proposals/mc/modules/program.md)、[Library](../../../docs/proposals/mc/modules/library.md)。
- [Driver](../../../docs/proposals/mc/modules/driver.md)、[World](../../../docs/proposals/mc/modules/world.md)、[能力面](../../../docs/proposals/mc/modules/capabilities.md)。
- 通用 Host 交付依赖：[持久交付回执](../../../docs/proposals/runtime/delivery-receipts.md)。

源码实现与旧专属测试已清理；设计文档保留。先落实首批接缝与工程接线，再按总规划并行推进 Runtime、Driver/World、Program/Library、Host 回执与 Executor；尽早接通正式实现的真实游戏流程。当前没有 Minecraft World 入口，Uina 不会加载旧 World 占位。

不要清理 `.uina/world-data/minecraft`、profile 数据或其他运行数据；本次只移除源码、旧测试和对应开发接线。
