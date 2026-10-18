# Uina Minecraft World

Uina 如何通过普通 JS 程序与一套能力目录，熟练、自主地游玩完整 Java 原版 Minecraft。

更新时间：2026-10-18（Asia/Shanghai）。变更历史见 [changelog.md](changelog.md)；本页只给状态与导航，不复制合同。

## 当前状态

| 部分 | 状态 | 最后核对 |
|---|---|---|
| Driver（受控玩家）、World（观察与记录） | **已实现**，通过 fake bot 集成验收；未在真实服务器验收 | 2026-10-17 |
| Library（程序、蓝图与经验） | 文件库设计定稿；旧 SQLite/CAS 资产仓库代码**已作废** | 2026-10-18 |
| Runtime（Run / Segment / Call / Effect） | 详细设计定稿，**未实现** | 2026-10-18 |
| Program（单文件 JS + 执行域） | 详细设计定稿，**未实现** | 2026-10-18 |
| 能力面（13 查询 + 37 动作） | 契约定稿，按 P0/P1/P2 分阶段实现 | 2026-10-18 |
| 真实 Minecraft 游玩验收 | **未开始**（Program 的"做完"以该验收为准，见 program.md §8 阶段 0） | — |

一句话：结构与合同已经收敛——**程序负责组合，能力负责身体，Library 负责留存**；剩下的是实现与真实游玩验证。

## 文档地图

| 文档 | 是什么 | 读者 |
|---|---|---|
| [design.md](design.md) | 终态概要：目标、结构、交互、生命周期、感知、流程 | 所有人，先读 |
| [contracts.md](contracts.md) | 跨模块契约：所有权、受理、递送、控制屏障、结算顺序 | 实现者（跨模块时） |
| [public-api.md](public-api.md) | 公开类型与方法；§6 已作废（程序与资产旧方案） | 实现者（查类型） |
| [modules/runtime.md](modules/runtime.md) | Run / Segment / Call / Effect、身体排队与委托、记录屏障 | Runtime 实现者 |
| [modules/program.md](modules/program.md) | 程序模型、编程面、库、执行域、类型与验收 | Program 实现者 |
| [modules/capabilities.md](modules/capabilities.md) | 13 查询 + 37 动作的逐条契约与失败码 | 能力实现者；§7–§8 给模型 |
| [modules/driver.md](modules/driver.md) | 客户端操作、写入资格、反馈时序、停止屏障 | Driver 实现者 |
| [modules/world.md](modules/world.md) | 分区、证据交付、查询切面、Watch、持久化 | World 实现者 |
| [modules/assets.md](modules/assets.md) | 蓝图与经验的文件约定、`library` 表面、已删机制 | Library 实现者 |
| [research.md](research.md) | 参考实现、源码证据、被否方案、验证边界 | 评审者 |
| [changelog.md](changelog.md) | 每轮改了什么、为什么 | 评审者 |

## 怎么读

1. **只看一遍**：[design.md](design.md)。它给终态和理由，不含实现细节。
2. **要写某个模块**：读 `modules/<模块>.md` 的正文（章节范围见该文目录）；附录按需查。
3. **要查类型或改跨模块接口**：[public-api.md](public-api.md) §1–§5、§7；§6 是已作废的历史。
4. **要问"为什么不是另一种做法"**：[changelog.md](changelog.md) 与 [research.md](research.md)。

## 按问题查阅

（标号指该文档内的章节号；链接不带锚点，避免失效。）

| 问题 | 入口 |
|---|---|
| 系统组成、依赖、AI 局部开发的边界 | design.md §2 |
| 模型看到什么、怎么调工具、上下文成本 | design.md §3 |
| 身体控制、委托、停止与恢复 | design.md §5；modules/runtime.md §8 |
| 感知边界、事实范围、事件唤醒 | design.md §6；modules/world.md |
| 成功、进度、未知效果的判定 | design.md §7；contracts.md §6 |
| 数据放在哪、各文件归谁写 | design.md §8.2；modules/program.md §2；modules/assets.md §2 |
| 程序怎么写（`mc` 表面、句柄、示例） | modules/program.md §3 |
| 执行域、容量、预算、取消、退役 | modules/program.md §5 |
| 程序的库与学习循环 | modules/program.md §4 |
| 能力清单（参数、返回、失败码） | modules/capabilities.md §3–§4 |
| 模型用的速查与 `describe` 输出 | modules/capabilities.md §7–§8 |
| 试算、部分完成与剩余量 | modules/capabilities.md §2.11 |
| 蓝图的存放、原件/目标、完整性 | modules/assets.md §3 |
| 经验的存放与证据 | modules/assets.md §4 |
| 跨模块允许依赖、唯一写入者 | contracts.md §2 |
| 受理事务、回执丢失、替换/抢占 | contracts.md §3 |
| 记录递送与不确定补报 | contracts.md §4 |
| 停止屏障与主动复查 | contracts.md §5 |
| 完成证据、五态结算 | contracts.md §6 |
| 观测引用、版本与写记录 | contracts.md §7 |
| 公开类型与模块独立验证 | public-api.md §1–§5、§7–§8 |
| 参考实现对照与被否方案 | research.md §3–§5 |
| 尚未验证的技术判断 | design.md §11；research.md §6 |
| 本轮为什么改 | changelog.md |

## 已确认边界

四项边界的完整定义见 design.md §1.1：

- 完整 Java 原版，模组可扩展。
- 使用客户端结构化数据；区分协议可知、当前可见、历史与未知。
- 常态自保，主脑可按玩法调整。
- 已受理任务独立于思考回合；明确停止任务、停用 World 或全局急停时停止动作。

## 维护约定

- 每个问题只有一份权威正文：全局行为在 contracts.md，公开类型在 public-api.md，模块细节在 `modules/`，本页与 design.md 不复制合同。
- 改动先改权威正文，再改本页索引；一轮改动追加到 changelog.md。
- 已作废的机制不保留第二份完整描述：正文里留一句指针，细节去 git 历史。
- 本文档不规定 MVP、阶段排期或验收门槛；Program 的验收门槛例外地写在 program.md §8。
