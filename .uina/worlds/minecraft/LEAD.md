# Minecraft 实现重做入口

更新时间：2026-10-25。当前目录已有 I1/K1、批 1 采集、批 2 窗口与容器、**批 3 生产链**，K1/批 1/批 2 在 `d77d20f`，Driver 修复在 `6157834`；当前 `codex/phase0-baseline` 工作树还包含既有未提交生产链修复。实际装配目录为 **10 查询 + 15 动作（25/51）**，此前 27 项为误计；当前专项验证与来源见 dev/MC-WORLD.md。Program/Library、Host 回执、Executor/WorldDef 尚未实现。

下一任务是**批 4：Executor 进程与传输底座**；批 5 的 H 回执可独立推进，批 6 才经正式原生模型入口首次校准，批 7–9 接 Program、文件复用、等待/决策并收口 I2。后续玩法按真实依赖与校准收益入队，施工顺序唯一见总规划 §10；不再先扩到蓝图再接主脑，也不以开发脚本代替模型游玩。

本目录开发者开工前先读 [总开发规划](../../../docs/proposals/mc/development-plan.md) 和 [开发规范](../../../docs/proposals/mc/development-guide.md)，再按需阅读所属模块。规范中的接口/所有权、真实结果、退出与验证要求适用于本次重做；不要求特定代理工具、假 Bot 先行或每个小步骤都提交。

## 权威设计

- [状态与导航](../../../docs/proposals/mc/README.md)、[概要](../../../docs/proposals/mc/design.md)。
- [完整开发规划](../../../docs/proposals/mc/development-plan.md)、[开发规范](../../../docs/proposals/mc/development-guide.md)。
- [跨模块合同](../../../docs/proposals/mc/contracts.md)、[公开类型](../../../docs/proposals/mc/public-api.md)。
- [Executor](../../../docs/proposals/mc/modules/executor.md)、[Runtime](../../../docs/proposals/mc/modules/runtime.md)、[Program](../../../docs/proposals/mc/modules/program.md)、[Library](../../../docs/proposals/mc/modules/library.md)。
- [Driver](../../../docs/proposals/mc/modules/driver.md)、[World](../../../docs/proposals/mc/modules/world.md)、[能力面](../../../docs/proposals/mc/modules/capabilities.md)。
- 通用 Host 交付依赖：[持久交付回执](../../../docs/proposals/runtime/delivery-receipts.md)。

I1 入口 `pnpm dev:mc`；K1 `pnpm dev:mc:k1`；采集 `pnpm dev:mc:k2`；窗口容器 `pnpm dev:mc:containers`；生产链 `pnpm dev:mc:k3`；修复与协议确认 `pnpm dev:mc:repair`；生产链修复 `pnpm dev:mc:production-repair`（默认独立 Temp 数据根）。当前确定性回归使用显式 tests/mc/*.test.ts 列表与 vmThreads，**28 files / 236 tests**（2026-10-25 实测）；实际真服记录见 dev/MC-WORLD.md 与 docs/proposals/mc/production-repair-implementation.md。

不要清理 `.uina/world-data/minecraft`、profile 数据或其他运行数据；规划修订与后续施工使用各自明确范围，验收不得以删除真实数据换取通过。
