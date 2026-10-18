# Minecraft 开发入口

更新：2026-10-18。这里仅导航当前设计与源码差异；旧版协调阶段、目录独占分工和冻结桩不再是实施约束，历史见 Git。

## 权威设计

- [状态与文档地图](../../../docs/proposals/mc/README.md)、[概要](../../../docs/proposals/mc/design.md)。
- [跨模块行为](../../../docs/proposals/mc/contracts.md)、[公开交换类型](../../../docs/proposals/mc/public-api.md)。
- [Executor](../../../docs/proposals/mc/modules/executor.md)：Uina 侧 façade、进程、IPC、账本与通知。
- [Runtime](../../../docs/proposals/mc/modules/runtime.md)：受理、调用、身体、记录与结算。
- [Program](../../../docs/proposals/mc/modules/program.md)、[Library](../../../docs/proposals/mc/modules/library.md)：普通文件、执行快照、共享 worker 与独立 guest。
- [Driver](../../../docs/proposals/mc/modules/driver.md)、[World](../../../docs/proposals/mc/modules/world.md)、[能力面](../../../docs/proposals/mc/modules/capabilities.md)。

## 当前差异

Driver/World 存在实现，但不是本文新接入合同和真实服务器验收的证明。executor/index.ts、worlddef/index.ts 仍为占位；旧 contracts/*.ts 和 assets/ 不能覆盖后来的设计裁决。实施时按所有者同步真实接缝，不为保持旧桩而增加兼容层。

Minecraft 复用 World 生命周期、五态 ToolExecutionResult、BodyEndpoint 与 worldDataDir；可靠通知另依赖 [Host 通用持久交付接缝](../../../docs/proposals/runtime/delivery-receipts.md)，尚未实现。现有 tool_result 不是 canonical ACK；按通用合同补标记/查询/退役，不增加 Minecraft 专属 Core 事件、资产发布/CAS 或第二套 Runtime。

只在用户授权范围实施；修改前检查工作树并保留无关文件。测试分别标明静态、fake、真实 Node/Windows 和真实 Minecraft 证据。
