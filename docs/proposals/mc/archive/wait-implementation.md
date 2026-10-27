# 批 9A：可等待查询实施记录

基线 b712754，分支 codex/phase0-baseline。开工已有 src/agent/context.ts 修改，保持不动。范围：World 查询版本与事件 Watch、Program waitUntil、生命周期投影及正式入口验收。Runtime v4、Host journal v4 保持不变；历史库 v2，旧库拒绝，不迁移真实数据。

## 工作进度

- A：查询声明是可等待性的唯一来源，确切查询/参数绑定观察游标，World 拥有 Watch 生命周期。
- B：SQLite 提交版本、库身份、事件/gap 增量与事件 Watch。
- C：guest predicate、单调期限与 Runtime 宿主 watch 桥。
- D：正式入口、源码/产物/模型验收和文档。

实施按同一当前工作树顺序推进。无 Core 变更，不更改真实 Provider 配置、认证、会话或 Pi。历史清理与决策续段仍属 9B。


## 实现与合同

- QueryDescriptor 决定可等待性：self/inventory/block/world/entities；events 只允许固定 after 且无未读页。blocks、静态知识、规划与 container.last 不可等待。游标绑定确切查询、JSON 参数、源与代次；当前事实保持保守失效。
- 历史库 v2 持久保存 storage_id、commit_version 与 gap 可见位置。版本随真实事务提交发布，页与版本同一次读取。after/next 分开类型并固定库身份、分区、过滤和窗口；源证据序号不能冒充 EventAfter，无法映射的 gap 边界为 null。
- ProgramHostApi.watch 仅等失效；普通 JS predicate 在 guest 内同步求值。目标参数入场捕获，单调期限包含读取/判定，到期末次读取。取消/失败清理所属 Watch，失效不带旧值；独立等待不占身体，withBody 等待仍持身体。
- Runtime 只投影等待事实，不重复求值条件；并发等待目标变化会更新 revision。身体排队不能被 Program 遥测改成普通 waiting。正常未知库存可为 null，条件须按实际字段处理。

## 审查与校准中的修正

独立审查两项均由失败回归复现后修复：reset 已知时先交付 reset，不能被断线后的 checkpoint 采样错误遮盖；world_change 的目标增加/减少必须更新状态，不能只比较 kind。源码真服首轮在制作期间直接读取 null 库存的 counts 而失败；只修正验收谓词，未将未知库存伪装成空库存。

首轮真实模型实际完成发消息→等待→保存→命名运行，但把 input.text 写死，第二次没有观察到新要求的文本，验收正确失败，数据保留在 uina-mc-model-EFSoc8。指南据此明确 params.input、read 返回的 value.after 与 target.input.after；模型验收按实际事件及 met 结果判断，允许查询别名和返回包装，不依赖偶然字段名。

## 首次交付验证

| 检查 | 结果 |
|---|---|
| pnpm typecheck | PASS，含 9 条边界 |
| MC 显式文件列表 vmThreads | 42 文件 / 316 项 PASS |
| Host/receipt 默认池 | 5 文件 / 27 项 PASS |
| pnpm build | PASS |
| pnpm dev:mc:wait -- --model | 真实 deepseek-flash 最终 4/4 PASS；临时数据 uina-mc-model-4oJVzG |
| pnpm dev:mc:wait | 最终源码真服 8/8 PASS；临时数据 uina-mc-native-KksWn2 |
| node dist/.uina/worlds/minecraft/dev/wait.js | 产物真服 8/8 PASS；临时数据 uina-mc-native-puMYny |

真实环境为 Windows 11 x64、Node 24.13.1、Java 21.0.9、Paper 1.21.11 build132、offline UinaDev。源码/产物沿同一正式 WorldTool/Host/受管进程，覆盖事件增量等待、实际采集制作供料、持身体等待后 stop/交接、确切源码保存/命名复用及零期限末次库存读取。

日志在系统 Temp：uina-mc-wait-source-final.log、uina-mc-wait-dist.log、uina-mc-wait-regression-final.log、uina-mc-wait-host.log、uina-mc-wait-build-final.log。中间失败日志保留，不算通过证据。dev/MC-WORLD.md 与 dev/FACTS.md 按仓库既有忽略规则保留在本地。

未交付：decide/checkpoint/continue、replace_pending/preempt_current、World 持久引用保护/清理和领域记录、反馈/自保及其他玩法；完整 I2 尚未完成。真实断电、长期负载、其他协议/认证未验证。无新增调度或玩法数量，仍为10查询+15动作。


## 最终模型证据与收尾

最终模型轮次实际从输入 input.text 构造消息，发送后在固定 after 之后观察到原文；从程序 Call 快照保存 wait_echo，再用 uina-wait-model-reused 命名运行，持久结果为 met 且包含新消息。最终报告位于系统 Temp 的 uina-mc-model-4oJVzG/report.json，日志 uina-mc-wait-model-final.log。该轮记录45次模型工具调用（runs26、describe4、run13、observe1、library1），其中6次程序执行失败后由模型纠正；不将它记为零错误或低往返体验。后续指南进一步明示 mc.read 的 value/page.after 信封，此项文案校正未再重复模型校准。

本轮启动的 Paper 经控制台 stop 正常保存退出，启动进程 exit0；未重置世界，验收数据保留。代码与文档留在 E:/Uina/Uina 的 codex/phase0-baseline 工作树，未提交/推送。src/agent/context.ts 的开工既有修改保持原样。下一批为9B，不将9A计作完整I2。


## 常规审查与提交前验证（2026-10-25）

本轮再次做完整工作树审查，独立审查与实际调用链核实发现并关闭两项 P2：

1. 身体申请已被投影为 queued，随后 Driver.acquire 失败且被程序捕获时，programChanged 原来无条件跳过 queued，导致后续世界等待仍永久显示 queued。现在只跳过尚未开始的 queued Run；真实 Runtime/QuickJS 回归覆盖申请失败→捕获→继续世界等待→停止。
2. changed 返回后重读及超时末次读取原来丢弃此前来源身份，可能静默采用重生/重连后的新代次并返回 met。waitUntil 现在在重读携带上一轮版本，由宿主比较 stream/epoch/序号连续性后再让 guest 求值；断连返回 source_unavailable，新源返回 invalidated 且不带旧值。版本解析保持在宿主侧。ProgramHostApi.read 增可选 after，内部 ReadResult 增 invalidated 分支，普通 mc.read 不传 after，仍获得原有 value/version/unknown。

两项均先观察失败回归后修复。最终 typecheck（含9条边界）PASS；MC显式列表42文件/317项PASS；Host默认池5文件/27项PASS；pnpm build PASS。构建产物真实 QuickJS/ProgramHost 额外验证普通变化、变化后重建及到期读取前重建3/3 PASS，临时数据 uina-wait-review-dist-IzXeZs。

日志：Temp/uina-mc-wait-precommit-queued-red.log、uina-mc-wait-precommit-epoch-red.log、uina-mc-wait-precommit-disconnect-red.log、uina-mc-wait-precommit-fixes.log、uina-mc-wait-precommit-typecheck.log、uina-mc-wait-precommit-tests.log、uina-mc-wait-precommit-host.log、uina-mc-wait-precommit-build.log。本轮未修改游戏协议，未重新启动Paper或调用真实模型；上文源码/产物8/8与真实模型4/4保留各自证据边界。

提交范围是9A代码、直接消费者、测试及文档，不包含src/agent/context.ts；后者文件摘要在审查前后保持58ff28319858a1ea47e26c9ba2617ef72c65086e。dev/记录仍按既有忽略规则保留本地，不推送。
