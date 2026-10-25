# Minecraft World：所有权与协作

日期：2026-10-18。状态：设计导航；原生能力与批 4–6 已接通；Program 执行与批 8 Library 已接通，等待/决策与完整 I2 仍待实现。

本文只列模块边界和跨模块流程。行为合同由所属模块唯一维护，跨模块类型见 [public-api](public-api.md)；本文件不另定义受理、停止、等待或结算算法。

<a id="judgments"></a>

## 1. 合同归属

| 问题 | 唯一正文 |
|---|---|
| façade、接入凭证、IPC、进程监管、Host 投递 | [Executor](modules/executor.md) |
| Run/Segment/Call/Effect、受理、身体调度、停止与结算 | [Runtime](modules/runtime.md) |
| JS、guest API、源码固定、共享 worker 与退役 | [Program](modules/program.md) |
| 能力输入、默认值、目标、结果、领域错误；共用施工目标 | [能力面](modules/capabilities.md) |
| 客户端、实际写入、Operation/窗口/反馈、控制屏障 | [Driver](modules/driver.md) |
| 当前/历史查询、Watch、证据与领域记录 | [World](modules/world.md) |
| 库文件、头、CRUD、来源保存与发现 | [Library](modules/library.md) |
| 通用工具/输入的持久接收与尝试退役 | [Host 回执](../runtime/delivery-receipts.md) |

跨模块更改同步修改类型、所属正文、消费者示例与验收，不在导航补一套规则。

<a id="ownership"></a>

## 2. 依赖与唯一写入者

| 模块 | 可使用 | 唯一拥有 | 不穿透 |
|---|---|---|---|
| Executor | Runtime 客户端、World/目录/Library、Host 回执、OS 进程句柄 | executor.db、传输与通知尝试 | Runtime 表、游戏算法、Bot |
| Runtime | 动作描述/实现、Program、Driver、World、只读库材料 | runtime.db、身体队列与调用身份 | Host/UI、具体玩法内部 |
| Program | 注入的宿主桥、只读库加载、快照文件 | guest/worker、段内名字固定与执行源码 | Bot、Runtime 表、库 CRUD |
| 能力 | 当前调用上下文、World、Driver、明确使用的其他能力 | 领域算法、目标核验与进度含义 | 原始 Bot、顶层受理队列、其他模块表 |
| Driver | 客户端依赖、调用核验与效果 sink、纯采样函数 | 客户端当前状态、有效资格与操作资源 | 业务队列、历史与工程算法 |
| World | Driver 事实、查询/领域定义、自己的存储 | world-history.db、Watch 与证据保留 | 主动开箱/移动、Runtime 表 |
| Library | 文件、compile-only、确切调用快照读取 | programs/blueprints/experiences | 运行结论、身体控制、数据库表 |
| 组合根 | 各公开端口及实现 | 静态装配与可信注入 | 不向模块泄漏全局容器 |

Runtime 的事务不覆盖 Library 文件或 World 存储。工作文件、执行快照和服务端事实各按其所有者的边界固定，不声称跨库/跨服务器原子。

<a id="ingress"></a>

## 3. 接入与受理

接入生成/保存请求凭证由 [Executor §6](modules/executor.md#6-接入账本与受理查证) 定义；唯一受理、请求撤销与抢占事务由 [Runtime §2/§4.4](modules/runtime.md) 定义。工具等待、Run 停止和整个 World 停用的不同取消范围见 [Executor §2/§7](modules/executor.md)。

<a id="delivery"></a>

## 4. 交付

Runtime 保存唯一不可变报告及处置，见 [Runtime §6](modules/runtime.md#delivery)。Executor 选择短直返/后台输入、核对 Host 回执和恢复停滞，见 [Executor §8](modules/executor.md)。普通查询不消费通知。

<a id="control"></a>

## 5. 控制与等待

Runtime 唯一安排身体队列和委托，见 [Runtime §3](modules/runtime.md#body)；Driver 唯一落实实际写入隔离和交接，见 [Driver §5/§10](modules/driver.md)。程序等待/反馈用法见 [Program §2](modules/program.md)，各玩法是否自行释放身体由其能力合同说明。

<a id="completion"></a>

## 6. 结果与证据

领域能力核验自己的声明目标，见 [能力面 §2](modules/capabilities.md)。效果来源与五态结算、记录屏障、晚到核验见 [Runtime §5](modules/runtime.md)。Program 返回只完成 execution，不认证开放游戏意图。

<a id="observations"></a>

## 7. 观察与领域记录

Driver 提供唯一当前事实入口，见 [Driver §11](modules/driver.md)。World 定义查询切面、观察游标、Watch、领域写入与证据保留，见 [World §6–§10](modules/world.md)。强引用先保留再发布的跨库次序由 [Runtime §7.2](modules/runtime.md) 拥有。

events 的增量/分页与观察版本、players 的名单/实体区别、map 图像和牌面定义见 [能力面](modules/capabilities.md) / [World §8.5–§8.6](modules/world.md)。图片附件复用 [Executor §2.1.1](modules/executor.md#observation-images)；安全介入的独立效果归属见 [Runtime §3.3.3](modules/runtime.md#safety-intervention)。

<a id="assets"></a>

## 8. 库与执行材料

Library 管普通工作文件与来源保存，见 [Library §5](modules/library.md)。Program 管运行材料与段内解析固定，见 [Program §3](modules/program.md)。Construction 的设计目标见 [能力面](modules/capabilities.md)，蓝图 Raw/Target/Project 的文件边界见 [Library §3](modules/library.md)。

<a id="flows"></a>

## 9. 跨模块推演

| 场景 | 协作顺序 |
|---|---|
| 受理回复丢失后停止 | Executor 保留 requestId → Runtime 查原受理或建立撤销屏障 → Driver 撤销控制 → Runtime 持久结算 → Executor 交付同一报告 |
| 熔炼与收割并行 | 能力投料并确认 → 退出自有 Body → 等待后申请新 Body 复查 → 核验产物。接受外层委托时祖先 Body 保留，见能力合同 |
| 保存并局部修改程序 | Library 核验确切 Call → 取执行快照 → 写工作文件；在途段仍读已固定字节，新段加载新文件 |
| 物品转移部分完成 | 能力固定源清单 → Driver 窗口逐次操作/取证 → 能力报告 moved/remaining 或未知 → Runtime 保存效果，不替领域累计 |
| 按图施工与修复 | Construction 解释 Target → World 提供现场 → 共用差异算法生成挖放操作 → Driver 执行 → 能力核验剩余差异；旧进度不代替当前现场 |
| worker 故障 | Program 报实际影响 Call → Runtime 关准入/撤销控制 → Program 确认线程退出 → 各调用分别结算；无法隔离时 Executor 退役整树 |

<a id="verification"></a>

## 10. 验收归属

开发阶段与依赖见 [开发规划](development-plan.md)。各模块正文保留自己的接口、故障与验收场景；研究和历史证据在 [research](research.md)，不作为现行合同。文档静态检查、本地实现测试、真实进程/OS 验证、Minecraft 与模型游玩验收分别报告。
