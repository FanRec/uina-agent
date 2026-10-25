# Uina Minecraft World

Uina 如何通过普通 JS 程序与一套能力目录，熟练、自主地游玩完整 Java 原版 Minecraft。

更新时间：2026-10-25（Asia/Shanghai）。变更历史见 [changelog.md](changelog.md)；本页只给状态与导航，不复制合同。

## 当前状态

| 部分 | 状态 | 最后核对 |
|---|---|---|
| Driver（受控玩家）、World（观察与记录） | K1 + 批 2 + 修复：连接级 1.21.11 协议适配、玩家/容器共享确认、独立库存/采矿/牌面操作、统一查询校验；窗口仅普通容器（`crafting`/`furnace` 明确拒绝）；feedback、通用领域记录仍缺 | 2026-10-25 |
| Runtime（Run / Segment / Call / Effect） | I1 子集已实现：受理、Call 组合、身体仲裁、记录结算与恢复；已修正直接/嵌套未知效果结算（程序/决策/核验器仍缺） | 2026-10-25 |
| 能力面（16 查询 + 35 动作） | K1、批 1 采集、批 2 窗口容器已实现：**10 查询 + 13 动作**；下一批为 craft / smelt，其窗口类型、配方图案与熔炼表三处前置见 development-plan §10.7；K3–K8 尚未实现 | 2026-10-25 |
| Library（程序、蓝图与经验） | 未实现；按普通文件库设计 | 2026-10-19 |
| Executor（Uina 接入、IPC、进程与通知） | 未实现；依赖通用 Host 回执；Windows 待 OS 验收 | 2026-10-19 |
| Host 持久交付接缝 | **未实现**（源码仍是 journal v3，无 receipt 类型）；设计见 delivery-receipts.md | 2026-10-23 |
| Program（单文件 JS + 共享 worker/独立 guest） | 详细设计已写，未实现 | 2026-10-19 |
| 真实 Minecraft 游玩验收 | 本轮 repair 源码/构建产物各 **15/15 PASS**，独立数据根，包含实际工具/组件覆盖、采集、精确丢弃、容器、牌面/挖掘取消、禁放置导航及完整关闭重开历史。I1/K1/批 2 专项保留各自历史记录 | 2026-10-25 |

职责分工：程序负责组合，能力负责领域目标，Runtime 负责执行、控制归属和记录，Library 保存文件。当前规格仍需实现与真实游戏验收。

批 2 设计、取舍与任务记录见 [窗口与容器实施](window-container-implementation.md)。运行 `pnpm dev:mc:containers` 做独立真服场景；普通容器开放 mode-0 左/右键，工作站专用操作留给生产/工作站批次。祖先身体只操作已触及容器，先导航再持身体；开窗未确认而取消/超时后须重连客户端。

本轮修复与重构见 [Driver 修复实施](driver-repair-implementation.md)。`pnpm dev:mc:repair` 默认使用独立临时数据目录，串行验证协议确认、工具/实例选择、取消、导航和容器历史；当前受控写入实现仅支持 Java 1.21.11，后续版本通过同一 DriverProtocol 接缝实现，未支持版本明确失败。

## 文档地图

| 文档 | 是什么 | 读者 |
|---|---|---|
| [design.md](design.md) | 终态概要：目标、结构、交互、生命周期、感知、流程 | 所有人，先读 |
| [development-plan.md](development-plan.md) | 全模块依赖、正式实现工作包、51 项能力覆盖；**§10 剩余施工总纲（实际开工批次与真服判据）** | 实施负责人，按依赖推进 |
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
| [research.md](research.md) | 参考实现、源码证据、被否方案、验证边界 | 评审者 |
| [changelog.md](changelog.md) | 每轮改了什么、为什么 | 评审者 |

## 怎么读

1. **只看一遍**：[design.md](design.md)。它给终态和理由，不含实现细节。
2. **要写某个模块**：读 `modules/<模块>.md` 的正文（章节范围见该文目录）；附录按需查。
3. **要查类型或改跨模块接口**：[public-api.md](public-api.md) §1–§5、§7；§6 导航到 Program/Library，Executor façade 由其模块文档拥有。
4. **要问"为什么不是另一种做法"**：[changelog.md](changelog.md) 与 [research.md](research.md)。

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
| 参考实现对照与被否方案 | research.md §3–§5 |
| 尚未验证的技术判断 | design.md §11；research.md §6 |
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
- 实现状态与验收要求分开；Program 验收见 program.md §8，Runtime 验收见 runtime.md §8。
