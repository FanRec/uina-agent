# Uina Minecraft World

Uina 如何通过普通 JS 程序与一套能力目录，熟练、自主地游玩完整 Java 原版 Minecraft。

更新时间：2026-10-25（Asia/Shanghai）。变更历史见 [changelog.md](changelog.md)；本页只给状态与导航，不复制合同。

## 当前状态

| 部分 | 状态 | 最后核对 |
|---|---|---|
| Driver（受控玩家）、World（观察与记录） | K1 + 批 2 + 批 3 + 修复：连接级 1.21.11 协议适配、玩家/容器/工作站共享确认、独立库存/采矿/牌面操作、统一查询校验；窗口含普通容器、工作台与熔炉（高炉/烟熏炉仍拒），`revision` 只随槽位与光标推进；批10已接feedback/默认自保；通用领域记录仍缺 | 2026-10-25 |
| Runtime（Run / Segment / Call / Effect） | 原生受理、Call 组合、身体仲裁、效果与恢复；批 4 补齐 Owner/心跳/三门、受理及开始提交屏障、关闭与退役，批 6 固定记录与交付处置已接通，库 schema v6（批10），批 9B 已接程序决策、显式续段、替换/抢占与决策报告有效性 | 2026-10-25 |
| 能力面（16 查询 + 35 动作） | K1、批 1 采集、批 2 窗口容器、批 3 生产链、批11 领域记录与地点/路径探索（places/remember/forget/route.plan/explore）已实现：**12 查询 + 18 动作（30/51）**，按真实目录计数；其余 K3–K8 待实现 | 2026-10-30 |
| Library（程序、蓝图与经验） | 批 8 已实现三类文件 CRUD、来源保存与统一发现；蓝图解释/施工留 Construction，见 [实施记录](archive/library-implementation.md) | 2026-10-25 |
| Executor（Uina 接入、IPC、进程与通知） | 批 4 平台已实现：Windows x64 双 Job、受管 bootstrap/Companion、私有 IPC、身份/launch 账本、停止/退役/显式恢复；批 6 正式 WorldDef、原生工具、请求凭证、可靠通知与 BodyEndpoint 已接线。见 [原生接入实施](archive/native-host-implementation.md) | 2026-10-25 |
| Host 持久交付接缝 | **批 5 已实现**：journal v4、工具/输入元数据与提交索引、inspect/retire、Extension/World 来源绑定；见 [实施记录](archive/host-delivery-implementation.md) | 2026-10-25 |
| Program（单文件 JS + 共享 worker/独立 guest） | 批 7 执行子集、正式入口、快照与取消已实现，见 [实施记录](archive/program-implementation.md)；9A 已接可等待查询与 waitUntil；9B 已接决策/checkpoint；批10已接feedback/loop | 2026-10-25 |
| 真实 Minecraft 游玩验收 | 批 4 受管源码/产物各 **8/8**（含导航中关闭/过期/故障恢复）；MC **33 文件/270 项**。生产链 K3 各 **14/14**、production-repair 各 **7/7** 及 Driver repair/I1/K1/批 2 保留对应历史证据。批 6 已有真实 deepseek-flash 的采集/生产、缺料纠错和显式停止校准，见 [实施记录](archive/native-host-implementation.md) | 2026-10-25 |

批 7 审查收口：MC **38 文件/293 项**、Host 相关 **5 文件/27 项**、typecheck/build 通过；正式源码/产物程序真服场景各 **8/8**，真实 deepseek-flash 程序校准通过。证据与未验证范围见 [实施记录](archive/program-implementation.md)。

批 8 验收：MC **40 文件/305 项**、Host **5 文件/27 项**、typecheck/build 通过；正式源码/产物 Library 场景各 **7/7**，真实 deepseek-flash 文件复用校准 **4/4**。范围和保留证据见 [实施记录](archive/library-implementation.md)。

职责分工：程序负责组合，能力负责领域目标，Runtime 负责执行、控制归属和记录，Library 保存文件。当前规格仍需实现与真实游戏验收。

**下一步与当前状态分开**：批 6 正式原生工具、首次校准及独立审查已完成，最终验收见 [实施记录](archive/native-host-implementation.md)。按 [总规划 §10](development-plan.md#10-剩余施工总纲2026-10-25-重排)，批 7 执行已接通，批 8 文件与发现复用已接通，9A 等待已接通；9B 决策/调度/现有历史清理已接通；批10已接反馈与默认自保；批11已接领域记录（G1 关闭）、地点与路径探索，下一组为移动鲁棒性与完整战斗。现有 30 项能力不等于全部 51 项设计完成。

批 2 设计、取舍与任务记录见 [窗口与容器实施](archive/window-container-implementation.md)。运行 `pnpm dev:mc:containers` 做独立真服场景；普通容器开放 mode-0 左/右键，工作站专用操作留给生产/工作站批次。祖先身体只操作已触及容器，先导航再持身体；开窗未确认而取消/超时后须重连客户端。

本轮修复与重构见 [Driver 修复实施](archive/driver-repair-implementation.md)。`pnpm dev:mc:repair` 默认使用独立临时数据目录，串行验证协议确认、工具/实例选择、取消、导航和容器历史；当前受控写入实现仅支持 Java 1.21.11，后续版本通过同一 DriverProtocol 接缝实现，未支持版本明确失败。


生产链八项审查修复见 [生产链修复实施](archive/production-repair-implementation.md)：合成/熔炼独立实现，共用组件感知与多槽搬运；熔炼等待释放自有身体，进度保留累计确认量。入口 `pnpm dev:mc:production-repair` 默认独立临时数据根。

## 文档地图

| 文档 | 是什么 | 读者 |
|---|---|---|
| [design.md](design.md) | 终态概要：目标、结构、交互、生命周期、感知、流程 | 所有人，先读 |
| [development-plan.md](development-plan.md) | 全模块依赖、正式实现工作包、51 项能力覆盖；**§10 当前施工总纲（批次、就绪队列与分责任验收）** | 实施负责人，按依赖推进 |
| [development-guide.md](development-guide.md) | 统一接缝、复用/重构、真实环境优先及适量验证 | 所有开发者，开工前阅读 |
| [contracts.md](contracts.md) | 所有权、依赖与跨模块协作导航；算法链接所属模块 | 实现者（跨模块时） |
| [public-api.md](public-api.md) | 公开类型与方法；§6 导航到 Program/Library 的权威定义 | 实现者（查类型） |
| [modules/executor.md](modules/executor.md) | 六入口、启动/关闭、Windows 独占与退役、IPC、受理查证和交付 | Executor/接入实现者 |
| [Host 持久交付回执](../runtime/delivery-receipts.md) | 工具/输入标记、持久接收查询、尝试退役；不含游戏逻辑 | Host/Core/World 接入实现者 |
| [modules/runtime.md](modules/runtime.md) | Run / Segment / Call / Effect、身体排队与委托、记录屏障 | Runtime 实现者 |
| [modules/program.md](modules/program.md) | 程序模型、编程面、执行材料、guest 与关闭 | Program 实现者 |
| [modules/capabilities.md](modules/capabilities.md) | 16 查询 + 35 动作、事件/地图/文字交互与生存合同 | 能力实现者；§7–§8 给模型 |
| [modules/driver.md](modules/driver.md) | 客户端操作、写入资格、反馈时序、停止屏障 | Driver 实现者 |
| [modules/world.md](modules/world.md) | 分区、证据交付、查询切面、Watch、持久化 | World 实现者 |
| [modules/library.md](modules/library.md) | 三类文件、程序头、CRUD、save from 与统一发现 | Library 实现者 |
| [changelog.md](changelog.md) | 每轮改了什么、为什么 | 评审者 |
| [known-gaps.md](known-gaps.md) | 当前缺陷与欠缺清单（含优先级、修法与验收） | 施工负责人 |
| [archive/](archive/README.md) | 批 2–10 实施记录与早期研究；只用于追溯当时的做法与证据 | 需要查证据的人 |

## 怎么读

1. **只看一遍**：[design.md](design.md)。它给终态和理由，不含实现细节。
2. **要写某个模块**：读 `modules/<模块>.md` 的正文（章节范围见该文目录）；附录按需查。
3. **要查类型或改跨模块接口**：[public-api.md](public-api.md) §1–§5、§7；§6 导航到 Program/Library，Executor façade 由其模块文档拥有。
4. **要问"为什么不是另一种做法"**：[changelog.md](changelog.md) 与 [archive/research.md](archive/research.md)。

开发者先读 [总规划](development-plan.md) 和 [开发规范](development-guide.md)，再读所认领模块；不必通读全部研究档案。规范统一施工与验证方式，不复制模块行为合同。

## 按问题查阅

（标号指该文档内的章节号；链接不带锚点，避免失效。）

| 问题 | 入口 |
|---|---|
| 系统组成、依赖、AI 局部开发的边界 | design.md §2 |
| 模型看到什么、怎么调工具、上下文成本 | design.md §3 |
| 身体控制、委托、停止与恢复 | design.md §5；modules/runtime.md §3–§4 |
| 感知边界、事实范围、事件唤醒 | design.md §6；modules/world.md |
| 事件增量、名单、地图和牌面 | modules/capabilities.md §3–§4；modules/world.md §8.5–§8.6 |
| 默认生存反射、介入和效果归属 | modules/capabilities.md §2.14；modules/runtime.md §3.3.3 |
| 成功、进度、未知效果的判定 | modules/capabilities.md §2；modules/runtime.md §5 |
| 数据放在哪、各文件归谁写 | design.md §8.2；modules/program.md §3；modules/library.md §2 |
| 程序怎么写（`mc` 表面、句柄、示例） | modules/program.md §2 |
| 执行域、容量、预算、取消、退役 | modules/program.md §5 |
| 程序文件、保存与迭代 | modules/library.md §5；modules/program.md §4 |
| 能力清单（参数、返回、失败码） | modules/capabilities.md §3–§4 |
| 模型用的速查与 `describe` 输出 | modules/capabilities.md §7–§8 |
| 试算、部分完成与剩余量 | modules/capabilities.md §2.11 |
| 蓝图的存放、原件/目标、完整性 | modules/library.md §3 |
| 经验的存放与证据 | modules/library.md §4 |
| 跨模块允许依赖、唯一写入者 | contracts.md §2 |
| 受理事务、回执丢失、替换/抢占 | modules/runtime.md §2；modules/executor.md §6 |
| 结果直返、最终交付、投递停滞恢复 | modules/executor.md §8；modules/runtime.md §6；Host 持久交付回执 |
| 启用/停用、IPC、父进程崩溃与退出证明 | modules/executor.md §3–§7 |
| 模型 façade 参数、unknown 撤销/同键重试、恢复确认 | modules/executor.md §2、§6–§7 |
| Microsoft/offline 登录、离线名字与账号独占 | modules/executor.md §3.1；modules/driver.md §4.1.1 |
| chat 消息与服务器指令、发送回执与真实效果 | modules/capabilities.md §4 chat；modules/driver.md §7.7 |
| 摘要、完整记录直读、按需 JSON 文件 | modules/executor.md §5.5；public-api.md §7 |
| 停止屏障与主动复查 | modules/driver.md §10；modules/runtime.md §4 |
| 完成证据、五态结算 | modules/runtime.md §5 |
| 观测引用、版本与写记录 | modules/world.md §6–§10 |
| 公开类型与模块独立验证 | public-api.md §1–§5、§7–§8 |
| 参考实现对照与被否方案 | archive/research.md §3–§5 |
| 尚未验证的技术判断 | design.md §11；archive/research.md §6 |
| 本轮为什么改 | changelog.md |
| 全项目按什么顺序实现 | development-plan.md |
| 开发者如何复用、重构、选择验证与协调接口 | development-guide.md |

## 已确认边界

边界的完整定义见 design.md §1.1：

- 完整 Java 原版，模组可扩展。
- Microsoft 认证与 offline 登录并列；本机/LAN/远程离线服按实际地址和端口连接。
- chat 同时发送普通消息和 `/` 服务器指令，命令权限仍由服务器决定。
- 使用客户端结构化数据；区分协议可知、当前可见、历史与未知。
- 常态自保，主脑可按玩法调整。
- 已受理任务独立于思考回合；明确停止任务、停用 World 或全局急停时停止动作。

## 维护约定

- 每个行为由所属 modules 文档唯一维护；public-api 保存跨模块类型，contracts 只给所有权/协作导航。本页和 design 只给概要。
- 改动先改权威正文，再改本页索引；一轮改动追加到 changelog.md。
- 已作废的机制不保留第二份完整描述：正文里留一句指针，细节去 git 历史。
- 实施记录与早期研究只进 [archive/](archive/README.md)；根目录只放当前有效的规范、索引与状态。批次完成后不再往根目录新增文件。
- 实现状态与验收要求分开；Program 验收见 program.md §8，Runtime 验收见 runtime.md §8。

批 9A：确切查询版本、事件提交 Watch、Program waitUntil 与停止/身体生命周期已接通；能力仍为 25/51，历史库 v2，Runtime/Host 格式不变。完整证据见 [实施记录](archive/wait-implementation.md)。


批9B：decide/checkpoint、显式continue、替换/抢占、历史保留与显式清理已接通，Runtime v5/history v3/ledger v3，仍为25/51能力。MC46文件357项、Host5文件27项、类型/边界/构建通过；正式源码/产物I2各7/7，真实deepseek-flash分阶段校准3/3。30分钟开放观察暴露重复死亡与OwnerLost恢复限制，批10已接反馈与默认自保，下一工作包为地点与路径探索。详见[批9B实施记录](archive/decision-implementation.md)。
