# Minecraft 实现重做入口

更新时间：2026-10-25。当前目录已有 I1/K1、批 1 采集、批 2 窗口与容器、**批 3 生产链**，源码落在 `d77d20f`（K1+批 1+批 2）与 `6157834`（修复与 Driver 收敛），批 3 为本轮工作树；能力目录共 **12 查询 + 15 动作（27/51）**，`craft@1`/`smelt@1` 已真服 14/14 PASS。Program/Library、Host 回执、Executor/WorldDef 尚未实现，下一批为**批 4 校准点**（用现有 27 项能力让模型真玩 30–60 分钟，产出 K4–K8 的重排表）。

本目录开发者开工前先读 [总开发规划](../../../docs/proposals/mc/development-plan.md) 和 [开发规范](../../../docs/proposals/mc/development-guide.md)，再按需阅读所属模块。规范中的接口/所有权、真实结果、退出与验证要求适用于本次重做；不要求特定代理工具、假 Bot 先行或每个小步骤都提交。

## 权威设计

- [状态与导航](../../../docs/proposals/mc/README.md)、[概要](../../../docs/proposals/mc/design.md)。
- [完整开发规划](../../../docs/proposals/mc/development-plan.md)、[开发规范](../../../docs/proposals/mc/development-guide.md)。
- [跨模块合同](../../../docs/proposals/mc/contracts.md)、[公开类型](../../../docs/proposals/mc/public-api.md)。
- [Executor](../../../docs/proposals/mc/modules/executor.md)、[Runtime](../../../docs/proposals/mc/modules/runtime.md)、[Program](../../../docs/proposals/mc/modules/program.md)、[Library](../../../docs/proposals/mc/modules/library.md)。
- [Driver](../../../docs/proposals/mc/modules/driver.md)、[World](../../../docs/proposals/mc/modules/world.md)、[能力面](../../../docs/proposals/mc/modules/capabilities.md)。
- 通用 Host 交付依赖：[持久交付回执](../../../docs/proposals/runtime/delivery-receipts.md)。

I1 入口 `pnpm dev:mc`；K1 `pnpm dev:mc:k1`；采集 `pnpm dev:mc:k2`；窗口容器 `pnpm dev:mc:containers`；生产链 `pnpm dev:mc:k3`；修复与协议确认 `pnpm dev:mc:repair`。当前确定性回归使用显式 tests/mc/*.test.ts 列表与 vmThreads，**26 files / 201 tests**（2026-10-25 实测）；实际真服记录见 dev/MC-WORLD.md。

不要清理 `.uina/world-data/minecraft`、profile 数据或其他运行数据；本次只移除源码、旧测试和对应开发接线。
