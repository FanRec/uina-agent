# Uina Minecraft World

Uina 如何通过普通 JS 程序与一套能力目录，熟练、自主地游玩完整 Java 原版 Minecraft。

更新时间：2026-11-08（Asia/Shanghai，批37）。变更历史见 [changelog.md](changelog.md)；本页只给状态与导航，不复制合同。

## 当前状态

| 部分 | 状态 | 最后核对 |
|---|---|---|
| Driver（受控玩家）、World（观察与记录） | 连接级 1.21.11 协议窄口、玩家/容器/工作站共享确认、独立库存/采矿/牌面、统一查询校验、窗口会话（批2/3/修复轮）、feedback 与默认自保（批10）、领域记录与 places/route（批11）、Watch 类别化失效与断线证据链（批23）；地图/图片出口（批17） | 2026-11-04 |
| Runtime（Run / Segment / Call / Effect） | 原生受理、Call 组合、身体仲裁（含 priority 档，批21）、效果与恢复；Owner/心跳/三门（批4）、固定记录与交付处置（批6）、决策/续段/替换/抢占（批9B）、feedback（批10）；schema v6 | 2026-11-03 |
| 能力面（16 查询 + 35 动作） | **51/51 全部落地**（批19 transit 收口）；批20 G6 节流 digest / G7 inventory@1 {since} / G8 run {wait}；批21 G9 priority / G10 FRAME_EXPIRED hint / G24 tunnel 上行加高；批22 G15 关闭（残余 G25）；批24 静态 Catalog（批43 起 `createCapabilityCatalog()`/`builtinDescriptors`，describe 离线可发现）；**批37 G6 关闭方式换成请求前状态帧**（`state.snapshot` + `WorldDef.requestContext`，digest 链路已删） | 2026-11-08 |
| 会话与多世界（session / Profile） | **批25**：`session` 动作（status/list/connect/disconnect）、World 启用默认不入服、Profile 身份文件与 `sessions/<profileId>/` 数据根、Executor 双根 + 目录 Job 跨 Profile 唯一、close 三事实、connection.wait 入服回执、离线 describe/library；设计合同见 [multi-world-v3.md](multi-world-v3.md)；批26 剩 RuntimeArchiveReader/profile 查询/离线 saveFromRun/交付 envelope/M4 | 2026-11-05 |
| Addon（非原版兼容） | **已落地**：Manifest/Profile 选择/Companion 装配/统一 Catalog/连接级协议（prepare+attach+`minecraft:register`）/addon facts/包内知识/`directory.snapshot`；示例 `example-mod` 真服纵向闭环 + SpectatorPlus 诚实失败；合同见 [addons.md](addons.md) | 2026-11-08 |
| Library（程序、蓝图与经验） | 批 8 三类文件 CRUD、来源保存与统一发现；批25 收敛宿主常驻唯一写入口（Companion 只读、离线 validator、无会话可读写）；蓝图解释/施工留 Construction | 2026-11-05 |
| Executor（Uina 接入、IPC、进程与通知） | 批 4 Windows x64 双 Job、受管 bootstrap/Companion、私有 IPC、身份/launch 账本；批 6 正式 WorldDef、请求凭证、可靠通知与 BodyEndpoint；批25 双根 + close 三事实 + connection.wait + blocked 重试语义 | 2026-11-05 |
| Host 持久交付接缝 | 批 5：journal v4、工具/输入元数据与提交索引、inspect/retire、Extension/World 来源绑定 | 2026-10-25 |
| Program（单文件 JS + 共享 worker/独立 guest） | 批 7 执行、正式入口、快照与取消；9A 可等待查询与 waitUntil；9B 决策/checkpoint；批10 feedback/loop；批21 priority 透传 | 2026-11-03 |
| refactor-v2（批次 A 导航 / 批次 B 战斗+施工+探索） | **批26–33 已实施并真服验证**（01-DESIGN 的"待实施"口径已过时）：G25 贴角对角线+Paper 贴面回弹双根因修复（三补丁入库）、G26/G27 关闭（upstream-nav 7/7）、A* 启发式加权 w=3（批28）、fight@1 近身拍 context steering + feedback 流 + fuse 感知（批29/33）、build@1 站位分区批量（批30）、explore@1 前沿覆盖重写（批32）；剩余 = 批次 C（M7 生存/M8 生产/M9 体验/M10 收敛）未开工 | 2026-11-07 |
| 任务级基线（批34） | `dev:mc:task` 三任务竞技场（SHELTER/MINE/NIGHT，完整 Program，终态服务端判决，失败强制归因，记录落 task-runs/）；暴露 mine 回程 11 轮全挂 → 探针钉死执行器缺陷集群登记 **G30**（批35/36 关闭 (a)(c)(b)）；goto 圈禁看门狗 NoCloser；场地自毁修复（矿石格=阶梯末级踏步块） | 2026-11-07 |
| 真实 Minecraft 游玩验收 | 真服场景 37 个 `pnpm dev:mc:*`（能力面/生产链/移动/建造/会话/审查/Addon 各有独立验收）+ 任务级基线 `dev:mc:task`；确定性回归 tests/mc 109 文件 **901/903**（vmThreads，重负载限 4 worker；`mcp-extension-loading` 2 项为既有基线红）；真模型 30 分钟窗口 G14 待跑 | 2026-11-08 |

职责分工：程序负责组合，能力负责领域目标，Runtime 负责执行、控制归属和记录，Library 保存文件，SessionController 拥有会话生命周期。

**下一步与当前状态分开**：按 [总规划 §10](development-plan.md#10-剩余施工总纲2026-10-25-重排)，批 0–19 依次接通原生入口、Program/Library、等待/决策 I2、反馈与默认自保、领域记录、移动鲁棒性、地形切片、蓝图施工、专用工作站、地图图片出口、K8 活动与 transit（**能力面 51/51**）；批 20–22 关闭 G6/G7/G8、G9/G10/G24、G15（残余 G25）与 G16 断电子项；批 23 审查修复轮；批 24 方案 01 收尾；批 25 多世界自治 v3 第一阶段（M1+M2+M3.1）；批 26–33 refactor-v2 批次 A/B（导航端到端 + 战斗/施工/探索，进度唯一真源见 [总规划 §10.3](development-plan.md)）；批 34 任务级基线（G30 登记）；批 35 关闭 G30 (a)(c)（跳跃决策纯节点规则 + tunnel 脚位支撑核验 + 回程 tolerance 收紧，mine 4/4 连绿）；批 36 关闭 G30 (b)（退避只拥有地面——空中残留键抵消跳跃弧线的逐帧修复，探针 10/10 连绿），**G30 全部关闭**；批 37 把状态从"定时推送"改成"每次请求前读一眼"（G6 关闭方式换掉，事件按种类分流、同世界合批、失败终态保留进度）。**批38 方向**：批次 C（M7 生存 / M8 生产，设计先行）；G14 真模型 30 分钟窗口挪至批次 C 收官（兼 G17）。剩余横向缺口见 [known-gaps.md](known-gaps.md)：G12/G13（需授权账号/目标硬件）、G14（待跑）、G28（水中爬岸）、G29 残余（苦力怕击杀路径）、G16 子项、G17；v3 剩余：RuntimeArchiveReader、profile 查询参数、离线 saveFromRun、交付 envelope、完整 M4 迁移仪式。

各历史轮次的设计取舍与验收证据统一见 [changelog.md](changelog.md) 与 [archive/](archive/README.md)；真服场景入口见 `package.json` 的 `dev:mc:*`（36 个）与 `dev/MC-WORLD.md`。

## 文档地图

| 文档 | 是什么 | 读者 |
|---|---|---|
| [design.md](design.md) | 终态概要：目标、结构、交互、生命周期、感知、流程 | 所有人，先读 |
| [development-plan.md](development-plan.md) | 全模块依赖、正式实现工作包、51 项能力覆盖；**§10 当前施工总纲（批次、就绪队列与分责任验收）** | 实施负责人，按依赖推进 |
| [multi-world-v3.md](multi-world-v3.md) | 多世界自治设计合同（M1/M2/M3.1 已落地，M3.2/M3.3/M4 为批26 施工范围） | 批26 实施者 |
| [addons.md](addons.md) | Addon 合同：Manifest、Profile 选择、连接级协议与通道注册、事实/知识边界、CLI 与真服夹具 | 扩展实现者/运维 |
| [refactor-v2/](refactor-v2/DEVELOPMENT-PLAN.md) | 下一轮重构/打磨执行包（2026-11-06，基线 a0c9a596）：M0–M10 工作包、三条接缝、验收场景与 Agent 指令；**待核实的设计候选与执行指令，不是现行合同**——已确认的决策与进度回填 development-plan/known-gaps/modules 后，整包转 archive | 下一轮实施负责人 |
| [development-guide.md](development-guide.md) | 统一接缝、复用/重构、真实环境优先及适量验证 | 所有开发者，开工前阅读 |
| [contracts.md](contracts.md) | 所有权、依赖与跨模块协作导航；算法链接所属模块 | 实现者（跨模块时） |
| [public-api.md](public-api.md) | 公开类型与方法；§6 导航到 Program/Library 的权威定义 | 实现者（查类型） |
| [modules/executor.md](modules/executor.md) | 入口/启动/关闭、Windows 独占与退役、IPC、受理查证和交付、会话双根 | Executor/接入实现者 |
| [Host 持久交付回执](../runtime/delivery-receipts.md) | 工具/输入标记、持久接收查询、尝试退役；不含游戏逻辑 | Host/Core/World 接入实现者 |
| [modules/runtime.md](modules/runtime.md) | Run / Segment / Call / Effect、身体排队与委托、记录屏障 | Runtime 实现者 |
| [modules/program.md](modules/program.md) | 程序模型、编程面、执行材料、guest 与关闭 | Program 实现者 |
| [modules/capabilities.md](modules/capabilities.md) | 16 查询 + 35 动作、事件/地图/文字交互与生存合同 | 能力实现者；§7–§8 给模型 |
| [modules/driver.md](modules/driver.md) | 客户端操作、写入资格、反馈时序、停止屏障 | Driver 实现者 |
| [modules/world.md](modules/world.md) | 分区、证据交付、查询切面、Watch、持久化 | World 实现者 |
| [modules/library.md](modules/library.md) | 三类文件、程序头、CRUD、save from 与统一发现 | Library 实现者 |
| [changelog.md](changelog.md) | 每轮改了什么、为什么 | 评审者 |
| [known-gaps.md](known-gaps.md) | 当前缺陷与欠缺清单（含优先级、修法与验收） | 施工负责人 |
| [archive/](archive/README.md) | 历史实施记录与早期研究；只用于追溯当时的做法与证据 | 需要查证据的人 |

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
| 受理出口、最终交付、投递停滞恢复 | modules/executor.md §8；modules/runtime.md §6；Host 持久交付回执 |
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
- 实施记录与早期研究只进 [archive/](archive/README.md)；根目录只放当前有效的规范、索引与状态。批次完成后不再往根目录新增文件；未完结的设计合同随其施工范围留在规范树（当前即 [multi-world-v3.md](multi-world-v3.md) 与 [refactor-v2/](refactor-v2/DEVELOPMENT-PLAN.md)），完结后整包转 archive。
- 实现状态与验收要求分开；Program 验收见 program.md §8，Runtime 验收见 runtime.md §8。
