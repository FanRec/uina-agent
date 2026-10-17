# Uina Minecraft World

更新时间：2026-10-18（Asia/Shanghai）。状态：**终态概要、跨模块契约与 Runtime/Program 详细设计；World 与 Driver 核心已实现并通过集成验收（fake bot 阶段），Runtime 与 Program 未实现；旧资产仓库代码（SQLite/CAS）已作废，蓝图与经验改为普通文件库（Library），未经过真实 Minecraft 验收**。2026-10-17 架构重构：World SQLite 迁入专用 Worker（提交屏障化历史查询）、ACK 收敛 durable-only（删 received 层/重传/outbox 与 R/recv 持久字段，schema v3）、Driver 状态唯一所有权收编（gate 资格/会话使用归属/KeyHold/窗口 revision live getter/setSlot 单路径/say 停用准入）；二轮收口：历史 cursor 改取读取视图提交版本（双量纲水位：current=失效事件序 / history=存储提交版本，混声明拒绝）、身体调度唯一权威归 Runtime、driver.close 必须结算排队申请、durable 物理前提（WAL+synchronous=FULL）显式设定并核验、pnpm verify:mc-worker 用真实构建产物验证 Worker。2026-10-18 补 Program 详细设计：程序是单文件 + 头注释的合法 JS（入口 `async function main(mc, input)`），取消版本/发布/绑定表；`mc.read` 返回观察版本、`mc.waitForChange` 用版本原子比较保证无漏唤醒，身体委托走 `body.call`；每次调用捕获源码快照（按 sha256 内容寻址），段内同名固定同一字节；执行域为 worker + QuickJS-WASM，容量按段（持身体租约时只尝试、满了 `PROGRAM_CAPACITY`）、资源失败降为 call 级；失败带来源（`source`）与建议（`hint`），实测证据见该文附录。同日定下数据布局：所有 Minecraft 数据在同一 `worldDataDir` 下并列——库文件（`programs/`、`blueprints/`、`experiences/`）、调用级源码快照（`runs/<run>/sources/<sha256>.js`）、World 历史（`world-history.db`）、Runtime 记录（`runtime.db`）。各模块设计中标注『条件条款』的小节是消费方/拆域出现后才激活的简洁合同。

本目录面向完整 Java 原版，研究怎样使 Uina 熟练、自主地游玩，并通过普通程序持续创造和复用能力。文档整理已获授权，不代表已授权代码开发。当前源码事实仍以 [current-runtime.md](../../current-runtime.md) 和实际实现为准。

## 阅读顺序与内容归属

1. [概要设计](design.md)：完整推荐方案的概览，集中说明需求、职责、调用、运行状态与游戏流程。
2. [跨模块详细契约草案](contracts.md)：具体依赖边界、唯一写入者、受理/停止/交付、控制屏障、效果要求、观测引用与版本解析；含两条完整正常/异常流程，供审阅。
3. [模块公开接口草案](public-api.md)：可调用导出、内部上下文、Body/World、Program 与 Executor 的唯一方法/类型定义；Library 只留历史对照；含正常程序示例与模块阅读范围。
4. [Runtime / Callable 详细设计](modules/runtime.md)：Run/Segment/Call/Effect、Body 排队与委托、受理材料/记录屏障、短直返/后台通知、Program/Executor 边界与验收。
5. [Program / 程序详细设计](modules/program.md)：单文件 + 头注释的程序库（`programs/*.js`，`list/get/save/update/delete`）、能力阶梯、`mc` 表面与为什么是调用而不是 SDK、执行域（worker + QuickJS-WASM）、宿主 RPC、失败的来源与建议、实施验收，以及对 public-api/assets/runtime/executor 的合同变更。
6. [研究与验证记录](research.md)：参考项目固定提交、当前源码证据、替代方案、场景与验证边界。
7. [Driver / 受控玩家详细设计](modules/driver.md)：客户端操作、统一写入资格、两种原生复用方式、反馈时序、停止屏障与 World 事实入口。
8. [World / 观察与记录详细设计](modules/world.md)：世界分区、证据交付与 ACK、固定查询切面、Section、Watch、领域修订、持久化及恢复。
9. [Library / 蓝图与经验详细设计](modules/assets.md)：库的文件约定（三类条目共享命名与目录）、蓝图的 Raw/Target/Project 三分与 AirPolicy、经验笔记形态、`library` 工具面、被删除的仓库机制清单。文件名沿用 `assets.md`；程序部分见 modules/program.md。

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
| 蓝图与经验的存放、元数据、原件/目标、完整性 | [Library 详细设计](modules/assets.md) |
| 程序文件布局、保存与修改、源码快照与复用 | [Program 详细设计](modules/program.md) |
| 程序执行域、隔离、容量、预算、取消与退役 | [Program 详细设计](modules/program.md) |
| `mc` 对象表面、宿主 RPC、值边界与错误重建 | [Program 详细设计](modules/program.md) |
| `library` 的五个操作与三类条目 | [Library §5](modules/assets.md)、[Program §4](modules/program.md) |
| 跨模块允许依赖、记录写入者及生命周期身份 | [详细契约：所有权](contracts.md#ownership) |
| 受理事务、回执丢失、替换/抢占、World 停用与急停 | [详细契约：接入](contracts.md#ingress) |
| canonical 递送核对与不确定补报 | [详细契约：递送](contracts.md#delivery) |
| 原生插件迟到写入、停止屏障与主动复查 | [详细契约：控制](contracts.md#control) |
| 完成证据要求、三组事实与五态结算 | [详细契约：结果](contracts.md#effects) |
| 只读视图、简短发现、观察游标、蓝图/经验仓库接口 | [公开接口](public-api.md) |
| 活句柄代次、程序快照与蓝图格语义 | [详细契约：观测](contracts.md#observations)、[库](contracts.md#assets) |
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
| 数据放在哪个目录、各文件的归属 | [存储位置](design.md#persistence)（§8.2） |
| 程序、蓝图和经验的保存与改进 | [资产复用](design.md#reuse) |
| 从执行代码到模块及工程数据关系 | [资产协作流程](design.md#asset-flow) |
| 游戏场景中的完整运行关系 | [核心流程](design.md#flows) |
| 尚未验证的技术判断及检验办法 | [待验证项](design.md#open-questions)、[验证场景](research.md#validation) |
| 原稿内容去向与未采纳理由 | [归并记录](research.md#draft-migration) |

## 原稿与维护

六份编号讨论稿已由本目录的概要、行为契约、公开接口、研究与入口替代，不继续充当规范或跳转入口。原稿快照保存在 [本次整理备份](../../../.artifacts/minecraft-design-originals-20261015-144602.zip)，不参与日常阅读。

本目录及提案总索引保持原有 Git 忽略规则，不强制纳入提交。后续设计修改应更新唯一正文与有关研究依据，避免再维护平行版本。本文不规定 MVP、开发阶段或排期。
