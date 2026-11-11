# Minecraft World 游玩信息交付重构计划

状态：生产路径已切换（2026-11-11，批46）。设计基线为 `mc/world-refactor@78883144`，当前行为以工作树源码和 [运行合同](../../current-runtime.md#minecraft-world) 为准。真 Paper 与真模型对照窗口未跑，见第 4 节。

本文是这一轮唯一的执行与审查入口。《信息交付与模型决策设计决策》和《信息交付、持续决策与自主感知设计决策》的裁决已并入本文，不再并行维护第二份执行清单。与 [游玩接口重构路线](play-interface/02-REFACTOR.md) 共用 `contracts/task.ts` 的 `taskView`：两项改造都改任务投影时，以同一处改动为准。

## 1. 裁决

| 问题 | 定下来的做法 |
| --- | --- |
| 每请求完整快照 | 从生产链删除。不改成常驻短简报，也不保留禁用开关。当前世界细节由 `observe` 按需读取。 |
| 新 visit 的起始立足点 | 只由 `session.connect` 本次新建的 ready visit 给一次有界 `entry`；幂等连接、`session.status`、失败连接不给。 |
| 重入 | 复用历史里的任务引用、`session.status`、`tasks.list/get`、`observe`。不新增意图识别器、第二个状态缓存或恢复专用工具。 |
| confirming 受理未知 | 义务写进原始请求凭证，按原 `requestId` 对账；确定拒绝主动交到模型面前；长期未知保持未知，不重派动作。 |
| Completion 正文 | 以已有 RunSummary、CompletionHeader、Effect 为唯一事实源；没有证据就不写 `goalMet`。`nextCall` 只用于跨过具体证据缺口。 |
| 跨重启可靠投递的前提 | `worlddef/index.ts` 激活时要求 `ctx.delivery.durability === "durable"`，这是唯一前提。ack 链不重复检查，receipt 不加 durability 字段。 |
| 完成通知的队列时机 | 本次不改 Host 队列调度。`followUp` 在整个回合收口后由 `resumeQueued` 消费是现有确定行为，不为此新建安全点认领或第二套队列。 |
| 快照对照实验 | 删除快照是裁决，已直接执行。实验只用于判断要不要补最小的边界事实；跑不了就单列未验证，不阻塞代码完成，也不据此宣称验收通过。 |
| 事件可靠性分级 | `minecraft_event` 是即发即弃加一次幂等补发，证据本体留在 `events@1`，没有 durable receipt；`minecraft_completion` 和受理终局走批量 receipt、Host canonical 回执与结清。两者不混为一谈。 |
| 自主发现 | `explore@1` 已有 `until` 发现条件和 `mc.decide` 交接，Program 内的等待与纠错沿用现有接口。不新增机会感知通道、兴趣评分器或 MC 心跳。不采用「受理仍未知」的一次性提醒：`tasks.list` 的 confirming 相位已能查回。 |

不新增 Broker、Manager、Wait Manager、第二状态机或永久双轨生产实现。Runtime 不替 Agent 做开放式决定，MC 不把世界状态自动播给模型，Host 不判断具体世界事实的意义。

## 2. 目标合同（现行行为）

| 时机 | 模型收到什么 | 事实来源和出口 |
| --- | --- | --- |
| 新建 ready visit | 连接状态、服务器、身份、能否行动；另给一次带 `visitId` 与 `observedAt` 的维度、位置。读取失败或换代只给准确说明。 | `SessionController.connect`，位置复用 `self@1`，一起进 `session.connect` 工具回执。 |
| 想了解现场 | 当前需要的局部观察，含覆盖、时点、未知与游标。 | `observe` 与 Program 的 `mc.read`。 |
| 提交行动 | `accepted`、`confirming` 或 `rejected`，以及句柄、原因和可从提交凭据提取的目标。 | 原提交凭据与 Runtime 受理事实。 |
| 受理终局 | 明确拒绝或取消前未受理时，按原句柄送达「没有后台 Run」及原因。 | 请求凭证的 `notice` 字段，经 `acceptance:<requestId>` 稳定键走现有批量 receipt 通道。 |
| 行动完成或需要接手 | 任务身份、结算范围、已证实的成果、部分成果、剩余与未知、决策身份。 | Runtime 固定报告、Effect、任务投影与完成投递。 |
| 有事需要主动告知 | 死亡、断线、私聊、点名、进行中的短对话、自保未脱险。聊天保留发送者、频道、原话、时点、事件引用。 | Driver 事实、Runtime 自保、事件投递。 |

`accepted` 只表示受理；`yield` 只表示没有必要为等待再调用模型，不锁住主体。混合工具批次仍按 Host 原有规则续轮。`succeeded` 只在报告声明的结算范围内成立，`goalVerification: "unknown"` 表示这次只证明了程序按自己的语义跑完。

## 3. 实施记录

**受理闭环。** `RequestCredential` 增加 `notice`（`pending` / `delivered`），状态就在原始请求凭证里，没有平行的请求状态表。`confirming` 先落义务再返回，去掉默认 `tasks.get`，与 `accepted` 一样带 `continuation: "yield"`。`recoverRequests` 仍只按原 `requestId` 对账，不重发动作；确定拒绝由 `scanAcceptance` 从持久凭证重建义务，走与完成通知相同的 Host 批量入口。key 用 `acceptance:<requestId>`，复用 `delivery_attempts` 记录 attempt；`ack` 按 key 前缀区分结清凭证还是 `runtime.settleDelivery`，`completionRef` 语义不变。诊断增加未确认请求数与待交接义务数。

**结果正文。** `formatCompletion` 保留权威 `record` 与 `segment`，报告不可读时给 `reportGap`（引用、缺什么、错误码）。`nextCall` 只剩未知写入的精确 Effect、未知写入范围，以及报告过大时的权威 record；自足结算和已有 decision 的待决定不再附泛用 `tasks.get`。`taskView` 明确 `completionScope`，`execution` 范围附 `goalVerification: "unknown"`，不虚构目标达成。`gameEventView` 去掉默认 `observe(events@1)`，聊天补回 `observedAt`。

**入场与文案。** `SessionController.connect` 只在确实新建 ready visit 时读一次 `self@1`，读前后核对 `visitId` 与取消状态，1.2 秒有界超时；读数失败、换代、取消都不改连接结果，`actionsAllowed` 独立显露。`ENV_PROMPT.md` 与 `nativeGuide` 改成按需观察与重入的说法，不再声称「简报已经够你行动」。

**删除的生产链。** `WorldDef.requestContext` 类型与 `WorldActivation` 的采样、超时、在途去重分支全部删除；`state.snapshot` RPC、`world/state-frame.ts`、`world/run-digest.ts`、伴生侧 reader 组合、私有 schema 项一并删除。`RequestObservation`、`ContextSnapshot.requestObservations`、事件帧的 `observationSource`、Subject 的最近观察缓存、TUI 的「上次世界观察」入口和 `/prompt` 观察面板、相关测试与 `dev:mc:state-frame` 脚本全部清掉。通用 `turn.transformContext`、`environmentGuide`、真实外部事件帧和 `getContextSnapshot()` 保留。`--rhythm-flow` 的踢出探针改用 `Executor.status()` 的连接事实判定。

**社交关联。** `companion/side.ts` 用发送者的 `uuid`（无则 `name`）加频道作键，只有确实送达的私聊或点名才建立分钟级关联；同一人的后续普通公聊在关联有效时作为非抢占事实送达，带 `related`。自回声、无关公聊不升级；断线清空，换 visit 随伴生重建清空。原始公聊仍进 `events@1`。

## 4. 验收与发布门

| 场景 | 布场和驱动 | 可观察的通过条件 |
| --- | --- | --- |
| 入服后自由游玩 | 重置陌生场景，真实模型只知道服务器信息。另用固定入服场景验证正常、幂等连接、换服、断线重连、旧读迟到和读取失败。 | 主动入服的轮次能看到可信起点，不会为同一位置再发一次无增益查询。Owner Gate 真实可见。 |
| 找铁并遇阻 | 固定含可采来源的区域，服务端库存独立复核。 | 报告与服务端变化一致，受阻回执交代确认量和原因，未知写入不重放。 |
| 等待与混合批次 | 只有委托工具、accepted 加其他工具两种批次；后台任务运行时第二客户端发私聊、点名、普通公屏。 | 纯委托不为等待产生空续轮；混合批次照常续轮且不丢工具结果。私聊、点名、进行中的短对话送达，无关公聊与自回声不刷屏。 |
| confirming 三条终局 | 原工具回执只见 confirming，分别让它最终受理、最终拒绝、长期未知；重启后继续对账。 | 受理找到对应一个 Run；拒绝主动送达且无后台 Run；未知保持可诊断，不自动重做，不产生第二条动作。 |
| 结果正文 | 成功、执行成功但目标未证实、部分成果待决定、未知写入、单报告不可读加多任务积压。 | 正文可直接开始下一次决定；有界权威 Header 回退；一条坏消息不阻塞同批其他任务。 |
| 用户停止与重启 | 主动停止、回合失败、会话存储与投递重启。 | 不违背 Subject 停止语义，事实留在持久记录里可合法恢复，诊断不称「模型已处理」。 |
| 游戏无事和退游 | 正常游戏状态下多次纯聊天，随后退出、服务端踢出并重连。 | Provider 投影里没有固定快照或离线占位；断线、任务结果和新入服位置各经原入口可见。 |
| 长时间聊天后继续任务 | 压缩历史、切换话题、断线重连后再让她继续。 | 能找到原任务并区分历史事实与当前现场，必要时用 `session.status`、`tasks.list/get`、`observe` 恢复，不出现幽灵坐标。 |
| 开放式探索 | `explore@1` 命中 `until`、Program 里 `mc.decide` 交回候选。 | 发现按能力结果或待决策交接，不靠任务进度洪流，也不把普通实体更新变成主脑待办。 |

**已覆盖**：`pnpm typecheck:fast` 除工作树既有的 `vitest.config.ts` `retries` 类型错误外无新增错误；本批相关的静态检查与受控 Provider 链路（含踢出探针改用连接事实）随源码同批核对。本批直接相关的 15 个测试文件 129 项通过（含受理终局闭环与 confirming 义务落账）；一次全量 `pnpm test:dev` 3609 项通过，仅 `tts-bridge-protocol`（缺 httpx）与 `mc-executor-platform`（PATH node 22 缺 `node_api.h`）两项环境基线红；`biome format` 与 `check:boundaries` 通过。`--rhythm-flow` 的踢出探针已改用 `Executor.status()` 的连接事实。

**未验证**：真实 Paper 服务器与真实模型的交错对照、快照策略 A/B、双客户端社交、长时间压缩后重入、开放式探索发现、跨重启的受理终局实跑。这些需要隔离 Profile、固定地图/模型/思考档和临时存档；环境不具备时保留可复现命令，不把受控用例当成发布验收。可复现入口：`pnpm dev:mc:task`、`pnpm dev:mc:native --rhythm-flow`、`pnpm dev:mc:session`、`pnpm dev:mc:explore-frontier`。

代码完成与验收完成分开记：前者以源码与静态/受控证据判定，后者以第 4 节的真实服与真模型记录判定。没有实验数据时不宣称信息策略已验证，也不为压低统计数字机械抑制必要工具。
