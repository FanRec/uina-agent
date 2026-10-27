# 批 9B：决策续段、调度与历史清理

日期：2026-10-26。基线 `a96aa0f`，工作树 `codex/phase0-baseline`；保留开工已有的 `src/agent/context.ts` 与 `.workbuddy-ai/`。本批不修改 Core、真实 Provider 配置/认证/会话或 Pi，不迁移旧数据库、不重置游戏世界。

## 已实现与接口

- Program 使用唯一位置参数接口 `mc.decide(reason, checkpoint?)`：同步校验并固定 JSON；本地捕获不关闭调用。私有标记区分普通同名 Error/JSON，宿主关联真实 Call/program/digest；父调用原样上抛保留来源。`mc.checkpoint` 只给续段根程序读取，子程序需显式传参。
- Runtime 只有根未处理请求才封口旧段：关闭调用/身体、退役 guest、冲刷效果前缀后，持久发布 awaiting_decision 和不可变 decision completion。continue 经过同一受理串行点，并在 SQLite 短事务核验门、停止和 decision，建立新段；显式消费，旧栈不恢复、动作不重放。
- Run 保留原 rootRequestId；每段受理凭证/完成报告绑定该段 requestId。Executor 凭证显式区分 submit/continue，retry 使用原操作与语义请求。decision 是否还能投递从当前运行事实派生；旧报告始终可读。
- replace_pending 整体核验同 Owner、确切目标和整个 Run 从未开始的事实；缺 caller 时要求 targets。preempt_current 先把新受理和旧停止意图提交，随后隔离旧控制；替代工作取得一次就绪优先机会，之后恢复 FIFO。导航与 Body 共用此队列，实际资格仍由 Driver 核验。暂停期不撤销尚未提交抢占的旧控制。
- `WorldEvidencePort.retain/release` 对可信持久 owner 幂等追加；存在性检查、持久保护和删除都在同一 SQLite writer 序列。当前 Driver/Runtime 没有发布非空 World 强引用的生产消费者，因此不制造空的跨库保留事务；Library 链接仍为弱引用。
- 历史清理只针对现有事件/窗口材料。显式 store_seq 与持久扫描高水位不因删除回退；保留最后有用容器观察、强引用和正在读取的材料。清理发布稳定 gap 与版本、唤醒 Watch；受影响分页明确过期。删除身份阻止源重发复活已清理载荷。

Runtime schema **v5**、World history **v3**、Executor ledger **v3**；旧格式明确拒绝，验收使用独立 Temp 根。Host journal 仍为 **v4**。

## 实现取舍

保留已验证的 Driver、Program、调用关闭与交付路径。新增 `runtime/admission.ts` 只拥有 writer 的短受理事务，常规记录仍走原有前缀屏障。事务已确认回滚时返回 not_accepted，不把普通受理拒绝升级成 recorder 故障；真正记录故障仍封闭新副作用。

Run 的 ever-started 与当前段活动分别表达：续段不把一个已执行 Run 变回 replace_pending 候选。停止屏障在内存即时生效，恢复状态同样能按 request 解析到 Run；旧段迟到写入不能覆盖新段投影。已经交还且无活动资源的 decision 在生命周期关闭后保留，显式 stop 才产生取消终态。

不新增任务 DSL、持久优先级栈、自动 TTL、通用领域修订库或 Section 依赖图。领域记录、feedback/loop、自保、其他26项玩法仍为后续工作；本批保持 **10查询＋15动作（25/51）**。

## 入口

```text
pnpm dev:mc:i2
pnpm dev:mc:i2 -- --model --duration-minutes 30
node dist/.uina/worlds/minecraft/dev/i2.js
pnpm dev:mc:history -- --help
```

I2 经正式 Host、WorldDef、受管 Executor、Program 和真实 Paper。受控 Provider 只安排工具调用，不冒充真实模型；`--model` 才调用当前真实 Provider。每次默认新建 Temp 数据/会话，场景仅准备 UinaDev 的16000附近专用测试区。入口不自行启动或关闭服务器。

离线维护须先停用对应 World；在线清理只调用该实例的 `pruneHistory`，沿同一 Worker 发布变化。历史维护必须明确提供 `--data-root`、`--partition`（JSON `[binding,world,worldRevision]`）及 `--before-store-seq`（不包含该位置）。结果报告 removed、skippedRetained、请求截止位置、oldestRetainedStoreSeq 和 version；最早剩余位置不承诺其后没有 gap。无默认真实数据目录或按年龄静默删除。

## 回归与审查

- 旧串行失败的根因是测试夹具浅拷贝共享 self，熔炼用例修改嵌套位置/维度后污染其他文件；精确组合先复现9项失败，修正后67/67。Program 旧50/60ms启动等待改为实际宿主调用或 idle 握手，保持计算/容量策略不变。
- 独立审查四项均先由失败回归复现再修复：恢复 decision 的 stop/continue回执竞争；按 request 停止恢复 Run；续段重置整个 Run started；已有 B 等待时抢占 C 未优先。覆盖真实 Worker 回执延迟、SQLite重开，以及 native/Program/子调用身体顺序。
- 真服首轮脚本 predicate 直接读取暂时未知的 inventory 导致失败；已按真实 unknown/null 语义修正，未修改生产查询或掩盖错误。

最终命令、真服源码/产物、模型观察及数据归属在本批验收完成后记录于下节；此前各批历史结果不替代本轮验证。

## 本轮验证

| 验证 | 本轮结果 |
|---|---|
| `pnpm typecheck` | 通过，含9条边界；未格式化或改写用户原有 context.ts |
| MC显式 `tests/mc/*.test.ts` + `--pool=vmThreads` | **46文件 / 357项通过**；日志 `dev/mc-9b-commit-mc.log` |
| Host/交付相关默认池 | **5文件 / 27项通过**；日志 `dev/mc-9b-commit-host.log` |
| `pnpm build` | 通过；日志 `dev/mc-9b-commit-build.log` |
| 正式源码 + Paper | **7/7**；`pnpm dev:mc:i2`，日志 `dev/mc-9b-i2-source-final.log`；Temp `uina-mc-i2-ud4z4J` |
| 构建产物 + Paper | **7/7**；`node dist/.uina/worlds/minecraft/dev/i2.js`，日志 `dev/mc-9b-i2-dist-final.log`；Temp `uina-mc-i2-9KBNUH` |
| 真实 deepseek-flash 分阶段校准 | **3/3**；`pnpm dev:mc:i2 -- --model`，64次实际模型请求；木板76→84，同Run确切材料续段、stop/preempt及完整重开均通过；日志 `dev/mc-9b-model-staged-final.log`；Temp `uina-mc-i2-model-kgxT77` |

以上Temp目录的父目录均为 `C:/Users/34150/AppData/Local/Temp/`；每次 `report.json` 保存模式、失败、实际usage和完整工具结果。源码/产物的受控Provider用于安排验收工具调用，绝不计为真实模型证据。真实模型校准按三个操作目标推进，代码和工具调用均由模型生成；后续目标只携带实际持久运行引用。它不等同于一次无指导的自主生存任务。

### 保留的长时观察与中间失败

- 已运行一次30分钟真实模型开放观察：`uina-mc-i2-model-drftNS/report.json`，178个实际状态样本，211次模型请求，12:44:10Z至13:14:08Z。实际不可变Call证明 v2程序携带原检查点成功续段，木板8→观测峰值24→末次0；旧身体 cancelled、抢占替代 succeeded。后续离场、多次死亡及一次执行侧重建后Owner Lost门关闭，因此**不宣称长期自主生存或无人干预恢复通过**。触发重建的根因未由留存诊断确认。
- 该长时脚本原来要求执行digest等于后来修改过的工作文件digest，导致错误断言；现改读确切Call的digest/返回值。原失败报告保留，额外 `immutable-analysis.json` 只作只读复核，不改写原报告或冒充一次重跑。
- 中间模型校准曾混淆普通waiting与持有Body，也尝试无关shell等待；现指南给出持有身体的最小形状，短校准通过公开请求投影hook只向模型呈现Minecraft工具，分阶段检查目标。没有放宽控制条件、切换Provider/model或注入伪造工具结果。曾遇HTTP402，用户充值后恢复并完成最终真实模型校准。
- 短语义验收在专用围栏区开始，初始化站位/健康/原木场景；木板必须由模型实际采集制作，不由命令补料。该准备不证明自保、战斗或开放导航能力。
- 新增导航交接真服检查最初目标位于残留树干后方，现有寻路超时；独立临时客户端复现，向空走廊实际移动成功。本批交接验收使用空走廊，并保留失败日志 `dev/mc-9b-nav-debug.log` 和成功 `dev/mc-9b-nav-clear.log`，未宣称修复复杂避障算法。
- 首次并发回归又发现旧测试 `expect.poll` 默认仅1秒，四个guest尚在编译就失败；已改成真实宿主入口与guest结束之间的Promise握手，原运行预算未改。最终显式列表全部通过。

### 归属与剩余工作

本批提交在 `codex/phase0-baseline`，不推送；真实Provider配置/认证/会话、Pi与Core未改，既有 `src/agent/context.ts`、`.workbuddy-ai/` 保留。游戏仅作用于开发服专用场景，不重置世界；World/会话均使用独立Temp数据根。

仍未交付：feedback/loop、默认自保、通用领域记录、空间切片、其余26项玩法及其他版本/认证组合。长时观察中出现重复死亡，后续应优先反馈与自保控制工作包，再接地点记录与路径探索；不把这轮I2通过当成51项设计或开放生存全部完成。


收尾：本轮启动的Paper经正式chat端口发送 `/stop`，服务端保存全部维度后正常退出；启动进程exit0，25565无监听。所有专用世界与Temp验收材料保留。


## 常规审查与提交前复验（2026-10-26）

本轮常规审查确认并修复两项问题，每项均先有失败回归：

- 存储Worker已经提交受理、但回执丢失时，continue把传输错误误报成not_accepted。现在submit/continue均只将明确的存储拒绝回执认作未受理；无回执的退出/传输错误（包括带Worker错误码的情况）保持unknown和原请求查证入口。
- 恢复时只用根requestId匹配停止意图，遗漏续段requestId。现在通过持久受理映射将请求关联到Run；续段提交回执未到时按该请求stop，重开后在旧控制已退役的前提下正确恢复cancelled。

真实临时SQLite与Runtime Worker覆盖submit/continue、停止前后、提交后丢失ACK、带错误码的Worker退出和重开查证，确认没有执行/重放探针动作。提交前MC显式列表46文件357项、Host相关默认池5文件27项、typecheck（9条边界）和build均通过。没有在本轮常规审查中重复连接真实Provider或启动游戏服；上节7/7真服与3/3模型结果属于实施阶段证据。

用户已有context.ts与.workbuddy-ai不纳入本批提交；本地dev记录按仓库既有忽略规则保留。
