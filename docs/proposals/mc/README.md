# Uina Minecraft World

更新时间：2026-10-17（Asia/Shanghai）。状态：**终态概要、跨模块契约与 Runtime/Program 详细设计；World 与 Driver 核心已实现并通过集成验收（fake bot 阶段），Runtime/Program 未实现；Assets 当前已有代码，本轮未验收，未经过真实 Minecraft 验收**。2026-10-17 架构重构：World SQLite 迁入专用 Worker（提交屏障化历史查询）、ACK 收敛 durable-only（删 received 层/重传/outbox 与 R/recv 持久字段，schema v3）、Driver 状态唯一所有权收编（gate 资格/会话使用归属/KeyHold/窗口 revision live getter/setSlot 单路径/say 停用准入）；二轮收口：历史 cursor 改取读取视图提交版本（双量纲水位：current=失效事件序 / history=存储提交版本，混声明拒绝）、身体调度唯一权威归 Runtime、driver.close 必须结算排队申请、durable 物理前提（WAL+synchronous=FULL）显式设定并核验、pnpm verify:mc-worker 用真实构建产物验证 Worker。各模块设计中标注『条件条款』的小节是消费方/拆域出现后才激活的简洁合同。

本目录面向完整 Java 原版，研究怎样使 Uina 熟练、自主地游玩，并通过普通程序持续创造和复用能力。文档整理已获授权，不代表已授权代码开发。当前源码事实仍以 [current-runtime.md](../../current-runtime.md) 和实际实现为准。

## 阅读顺序与内容归属

1. [概要设计](design.md)：完整推荐方案的概览，集中说明需求、职责、调用、运行状态与游戏流程。
2. [跨模块详细契约草案](contracts.md)：具体依赖边界、唯一写入者、受理/停止/交付、控制屏障、效果要求、观测引用与版本解析；含两条完整正常/异常流程，供审阅。
3. [模块公开接口草案](public-api.md)：可调用导出、内部上下文、Body/World、Program/Assets 与 Executor 的唯一方法/类型定义；含正常程序示例与模块阅读范围。
4. [Runtime / Callable 详细设计](modules/runtime.md)：Run/Segment/Call/Effect、Body 排队与委托、受理材料/记录屏障、短直返/后台通知、Program/Executor 边界与验收。
5. [研究与验证记录](research.md)：参考项目固定提交、当前源码证据、替代方案、场景与验证边界。
6. [Driver / 受控玩家详细设计](modules/driver.md)：客户端操作、统一写入资格、两种原生复用方式、反馈时序、停止屏障与 World 事实入口。
7. [World / 观察与记录详细设计](modules/world.md)：世界分区、证据交付与 ACK、固定查询切面、Section、Watch、领域修订、持久化及恢复。
8. [Assets / AssetRepository 详细设计](modules/assets.md)：原件与四态目标、资产版本、结构化/字节存储、发布恢复、从运行段导出、强弱来源、派生读取及故障边界。Runtime 已明确不再依赖旧 capture/retain 资产协议。
9. [Program / 普通 JavaScript 与局部控制详细设计](../../../.uina/worlds/minecraft/modules/program.md)：执行域、guest/host 桥接、绑定冻结、Body/World/Assets 接口、取消/退役、重启恢复、隔离验收与未决实验；按本次指定目录保存，其他文档只链接这一份。

本页只提供状态与导航，不复制设计合同或研究结论。概要保留目标与选择，全局行为集中在 contracts.md、公开接口集中在 public-api.md，研究记录集中保留证据；不维护两套并列的完整方案。示例类型仍是候选合同，研究中的源码实现不等于真实游玩表现。

## 已确认选择

四项边界的完整定义见 [设计目标与已确认边界](design.md#goals)：

- 完整 Java 原版，模组可扩展。
- 使用客户端结构化数据，区分协议可知、当前可见、历史和未知。
- 常态自保，主脑可按玩法调整。
- 已受理任务独立于思考回合，明确停止任务、停用 World 或全局急停时停止动作。

## 按问题查阅

| 问题 | 入口 |
| --- | --- |
| 系统组成、依赖与 AI 局部开发 | [总体结构](design.md#architecture) |
| Driver 内部结构、插件适配、物理步与事实采集 | [Driver 详细设计](modules/driver.md) |
| 当前/历史、证据交付、查询快照与订阅、记录及恢复 | [World 详细设计](modules/world.md) |
| 程序/蓝图/经验的保存、恢复、原件/目标、证据与派生读取 | [Assets 详细设计](modules/assets.md) |
| 跨模块允许依赖、记录写入者及生命周期身份 | [详细契约：所有权](contracts.md#ownership) |
| 受理事务、回执丢失、替换/抢占、World 停用与急停 | [详细契约：接入](contracts.md#ingress) |
| canonical 递送核对与不确定补报 | [详细契约：递送](contracts.md#delivery) |
| 原生插件迟到写入、停止屏障与主动复查 | [详细契约：控制](contracts.md#control) |
| 完成证据要求、三组事实与五态结算 | [详细契约：结果](contracts.md#effects) |
| 只读视图、简短发现、观察游标、蓝图/经验仓库接口 | [公开接口](public-api.md) |
| 活句柄代次、确切程序版本与蓝图格语义 | [详细契约：观测](contracts.md#observations)、[资产](contracts.md#assets) |
| 能力声明、嵌套调用、正常程序与模块独立验证 | [公开接口](public-api.md#callables)、[程序](public-api.md#programs) |
| 工具发现、调用与异步回执 | [LLM 交互](design.md#interfaces) |
| 能力装配、发现与内部调用 | [能力加载与调用](design.md#capability-loading) |
| 完整请求、回执与停止示例 | [调用闭环](design.md#call-contract) |
| 普通 JS、精细操作与新玩法 | [程序组合](design.md#programs) |
| `await` 返回值、部分完成与错误 | [程序值与错误](design.md#program-values) |
| 自保、等待、取消与控制交接 | [身体控制](design.md#control) |
| 等待、交还决策与恢复的状态关系 | [运行生命周期](design.md#run-lifecycle) |
| 状态摘要、事实范围和事件唤醒 | [感知与自主活动](design.md#perception) |
| 成功、进度与未知效果 | [结果真实性](design.md#results) |
| 地图、容器、工程与事故记录 | [世界持久化](design.md#persistence) |
| 程序、蓝图和经验的保存与改进 | [资产复用](design.md#reuse) |
| 从执行代码到模块及工程数据关系 | [资产协作流程](design.md#asset-flow) |
| 游戏场景中的完整运行关系 | [核心流程](design.md#flows) |
| 尚未验证的技术判断及检验办法 | [待验证项](design.md#open-questions)、[验证场景](research.md#validation) |
| 原稿内容去向与未采纳理由 | [归并记录](research.md#draft-migration) |

## 原稿与维护

六份编号讨论稿已由本目录的概要、行为契约、公开接口、研究与入口替代，不继续充当规范或跳转入口。原稿快照保存在 [本次整理备份](../../../.artifacts/minecraft-design-originals-20261015-144602.zip)，不参与日常阅读。

本目录及提案总索引保持原有 Git 忽略规则，不强制纳入提交。后续设计修改应更新唯一正文与有关研究依据，避免再维护平行版本。本文不规定 MVP、开发阶段或排期。
