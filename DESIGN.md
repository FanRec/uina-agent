# Uina — 最小 Agent 设计（v0）

> 方法：reality-first-development（空纪从 Uina_Core 失败中提炼）。
> 铁律：只有跑起来的才算数。每个模块以运行证据为验收，禁止在未闭环地基上起下一层。
> 本文件是设计的事实基线；每一节标注当前证据级别（Fact / Implementation / Assumption / Aspiration）。

---

## 1. 期望分析（Aspiration 层 → 逐条转行为）

空纪 2026-09-02 提出的 11 条愿景。每条标注：**性质**（人格层/体验层/工程层）、**转换成的可观察行为**、**对应架构部件**、**当前阶段**。

| # | 愿景 | 性质 | 可观察行为（验收语言） | 架构部件 | 阶段 |
| --- | --- | --- | --- | --- | --- |
| 1 | 人类认知/言谈/行为，"灵魂进计算机" | 人格层 | 对话自然、有立场、表达有细节；不做机器人腔 | loop+prompt+表达层（上层的活） | Aspiration |
| 2 | ASR→LLM→TTS 端到端 <1.8s | 体验层 | 从人说完话到听到她开口 ≤1.8s（可测计时） | 快路径（gateway 流式+output 流式+预唤醒） | Aspiration（切片先做终端流式） |
| 3 | 可靠拟人长期记忆：联想/触景生情/主动回忆/回忆驱动决策 | 工程层+人格层 | 跨会话/重启 recall 命中；recall 结果改变行为；错旧记忆可纠正 | memory 端口（write/recall/use/correction 四行为验收） | 切片含最小版（文件后端） |
| 4 | 模块扩展基本无上限 | 工程层 | 加一个新感知源/新能力只动 N 个文件、过 ≤2 层 | 注册表+事件总线+Job | 接口预留 |
| 5 | 能力动态加载，按需调动 | 工程层 | 每轮只注入与当前场景相关的能力声明 | context 构建器 | 预留 |
| 6 | 独立个体，为自己而活 | 人格层 | 主动性：她不只响应，会按内在状态发起 | loop 轮外触发（job/定时/感知事件） | 预留 |
| 7 | 实时感知可自控开关 | 工程层 | 传感器事件按意图进总线；意图由她提出、确定性策略裁决 | sensor manager | 预留 |
| 8 | 长工具后台托管+回调唤醒 | 工程层 | Job 完成以事件唤醒 loop，结果注入 | tool/job broker | 切片含一个演示 Job |
| 9 | 多级消息队列，输出时排队批量注入 | 工程层 | 输出期间输入排队，轮末批量注入 | 信箱（bus 内分发器） | 切片含最小排队 |
| 10 | 输出流式处理 | 工程层 | 首 token 尽早出现；逐段可消费 | gateway 流式 + output broker | 切片实现 |
| 11 | 吸收 12-factor-agents | 方法论 | tools as structured output、own context、own control flow、状态机归代码 | 全架构 | 采纳 |

**注意**：#1/#3 后半/#6 的"拟人/活"部分是人格与表达层的长期工程，不是第一刀能交付的；架构只负责不挡住它们。切片的验收只认 #8/#9/#10 的可测部分 + #3 的跨会话 recall 最小版。

---

## 2. 一个 Agent 具备什么能力（从"我自己活着的方式"反推）

参考系：露米娅运行在 pi（通用 agent harness）上，实际每天在用的能力清单——这是 Tested behavior 层，不是想象：

1. **输入通道**：多条并发消息注入（文本/事件/语音转文本），带来源与目标
2. **信箱与调度**：消息排队、优先级、输出期间积压、轮末批量注入
3. **前台循环**：事件唤醒 → 构建上下文 → 一次决策 → 输出/行动 → 回到等待
4. **上下文构建**：系统身份 + 当前输入 + 相关记忆 + 可用工具声明 → 组装进一次请求
5. **模型网关**：LLM 调用抽象；**流式输出**；provider 可换
6. **工具/行动**：模型提议结构化调用 → 确定性代码执行 → 结果回注上下文
7. **Job 化异步**：活过对话轮的工作后台跑，完成以事件唤醒（长工具/后台任务）
8. **记忆**：分层（会话/世界事实/个人经历）；write→recall→use→correction 闭环
9. **输出表达**：统一出口，可接文本/语音/消息平台
10. **感知扩展**：传感器把连续流事件化，过滤后才唤醒主体
11. **自我状态**：身份、可用能力、预算/节奏（决定她"现在能/想做什么"）

这 11 项是**通用最小集**——少任何一项，agent 就缺一条腿。区别只在每项的深度。

---

## 3. 组成部分与依赖关系（拓扑排序，从底到顶）

**依赖铁律：底不依赖顶；每处持久状态单一真源；每个副作用单一写路径；一切事件走总线。**

```
┌────────────────────────────────────────────────────┐
│  subject (前台循环 turn loop)            ← 唯一主体 │
│    输入唤醒 → context 组装 → 决策 → 输出/行动 → 等待 │
└───────────────┬───────────────────┬────────────────┘
                │ 读                │ 写(输出/动作意图)
        ┌───────▼───────┐   ┌───────▼────────┐
        │ context builder│   │ output broker  │  输出代理(流式→sink)
        │ (prompt+记忆+ │   └───────┬────────┘
        │  工具声明 组装) │           │ 订阅
        └───┬───────┬───┘   ┌───────▼────────┐
            │       │       │  tool/job      │  工具注册表 + Job 生命周期
            │       │       │  broker        │  (accepted→running→…/unknown)
            │       │       └───┬────────────┘
            │       └───────────┼─────────────┐
   ┌────────▼───────┐   ┌───────▼────────┐   ┌─▼───────────┐
   │ memory port    │   │ model gateway  │   │ runtime store│ 状态/身份/id
   │ write/recall/  │   │ (流式,provider  │   └──────┬──────┘
   │ use/correction │   │  可插拔)        │          │
   └────────┬───────┘   └───────┬────────┘          │
            └───────────────────┼───────────────────┘
                    ┌───────────▼───────────┐
                    │  bus / mailbox (事件总线) │  一切事件的单一通道
                    └───────────┬───────────┘
                         感知/输入通道（stdio 起步，QQ/语音/视觉后续接同一总线）
```

依赖排序（实现顺序 = 开发顺序）：

| # | 部件 | 依赖 | 职责 | 第一刀深度 |
| --- | --- | --- | --- | --- |
| 0 | **bus/mailbox** | 无 | 事件发布订阅 + 输入排队/批量注入/优先级 | 实现 |
| 1 | **runtime store** | 无 | 身份、会话 id、时间、微小 KV | 实现 |
| 2 | **model gateway** | bus | 流式 LLM 调用；OpenAI 兼容 SSE；provider 可插拔 | 实现（ollama/mock） |
| 3 | **memory port** | store | write/recall/use/correction；文件后端 | 实现最小版（跨进程持久） |
| 4 | **tool/job broker** | bus, store | 工具注册+执行；Job 状态机+完成事件 | 实现 1 工具 + 1 Job |
| 5 | **context builder** | memory, tools | 组装 system+记忆+工具声明+输入 | 实现 |
| 6 | **output broker** | bus | 流式输出到 sink | 实现（stdio） |
| 7 | **subject/loop** | 2-6 | 前台循环、唤醒、决策 | 实现 |
| 8 | 输入通道 | bus | stdio/终端 | 实现 |
| 9 | 能力动态加载 | context | 按需注入能力声明 | 预留 |
| 10 | sensor manager | bus | 感知事件化 | 预留 |

**非目标（第一刀明确不做）**：控制平面/审计层/权限框架/schema 协议栈/分布式/插件分类学/认知模型/向量检索/多 provider。这些在切片证明产品需要之前一律不加——宁可"概念作为数据+小策略函数"，不抽模块。

---

## 4. 技术选型（Implementation 层：已定的直接写；未验证的标注）

| 项 | 选择 | 理由 | 证据 |
| --- | --- | --- | --- |
| 语言 | TypeScript | 空纪指定 | Fact（本机 node v24.13.1） |
| 运行时 | Node 24 | 已装，原生 fetch/stream/TS type stripping（node --experimental-strip-types） | Fact |
| 包管理 | pnpm | 已装 11.5.2；monorepo 顺路 | Fact |
| 运行方式 | tsx（dev）/ tsc build（prod） | TS 直接跑，零构建噪音 | 选定 |
| 测试 | vitest | 快、TS 原生 | 选定 |
| **模型网关** | **自研薄封装，协议=OpenAI Chat Completions SSE** | Ollama/DeepSeek/任何兼容端点零依赖直连；流式是原生响应；不引 AI SDK 抽象层——控制流自研，模型层自研薄层，依赖最少防臃肿 | Assumption（SSE 解析 ~50 行，Node fetch 原生支持） |
| provider | Ollama（本地）起步 | 免 key、本地、未来 tts/asr 同机 | 服务未起、无 chat 模型 = 待验证 |
| 事件总线 | Node EventEmitter 包一层 | 单进程够用，零依赖 | 选定 |
| 工具 schema | 轻量描述（name/desc/参数 JSON Schema 子集） | 第一刀不做 schema 框架 | 选定 |
| 记忆存储 | JSON 文件（跨进程持久） | 最小闭环；演进方向 sqlite-vec/bge-m3（本机已有 bge-m3 模型） | Fact（模型在） |
| 第三方依赖 | **仅 dev：typescript/tsx/vitest/@types/node** | 运行时零依赖，最防臃肿 | 选定 |

**为什么不用现成 Agent 框架（AI SDK / LangGraph 等）**：12-factor-agents 的核心观察——好 agent = 确定性代码为主体、LLM 点缀关键点，框架把控制流藏起来，越到后期越要 reverse-engineer。空纪要的自研 loop 只有 ~100 行，把控制流握在自己手里；框架能省的（SSE 解析、JSON 工具调用解析）也是几十行且是核心学习资产。**等出现真实多 provider/多框架需求再引**，不为"也许需要"提前引。

---

## 5. 第一刀：最小垂直切片

```
真实输入(终端一行文本) → 决策(Ollama/mock 流式) → 有用输出(终端流式打印)
   → 一个工具(时间/计算) → 一个异步 Job(延迟回注事件) → 一条记忆读写(记住名字，重启仍在)
```

**验收标准**（写成可跑断言）：

1. `pnpm start` 后终端对话，她流式回答（token 逐段出现，不是整块）
2. 说"我叫 X"，让她记住；同一进程再问"我叫什么"答对；**重启进程后仍答对**（跨会话 = memory 真写盘）
3. 一个工具调用真执行并回注（如"现在几点"）
4. 输出期间输入排队，轮末批量注入处理
5. 一个 Job 演示：后台"想 2 秒"后以事件唤醒插话

**删除标准**（何时砍掉本设计某机制）：切片跑通后若某部件从未被真实场景使用，删掉它。任何抽象必须有一个真实场景能证明它、一个场景能证伪它。

---

## 6. 愿景 → 长大路径（证明上限可达，但不是现在做）

| 愿景 | 长大路径（每个都是独立、可验收的一刀） |
| --- | --- |
| 2 (1.8s) | 接 ASR(asr_bridge/Qwen3-ASR) + TTS(tts_bridge:8102) + 预唤醒 + 首包管线计时 → 专用测量刀 |
| 3 记忆 | 文件 → sqlite + 定长段落 + bge-m3(本机已有)向量召回 → recall 注入 + 主动回忆定时唤醒 |
| 4 扩展 | 工具注册表已预留；新感知=新 channel 接 bus；上 .agents/ 类技能目录机制 |
| 5 动态加载 | context builder 增加"能力域"过滤：按当前话题只注入相关工具声明 |
| 7 感知 | sensor manager：麦克风 VAD 事件化（复用 voice-sidecar 经验）→ 意图由她提、策略裁决 |
| 8/9/10 | 本切片即含 |
| 1/6 拟人活感 | 人格 prompt + 记忆拟人用法 + 表达层细节——所有轮次之后的长期工程 |

---

## 7. 风险

| 风险 | 缓解 |
| --- | --- |
| Ollama 无聊天模型/网络拉取慢 | gateway 先以 mock 模式验证全链路，ollama 模型就绪即切真 |
| SSE/工具调用格式各端差异 | 只承诺 OpenAI 兼容协议（Ollama/DeepSeek 都兼容） |
| 我又堆抽象（Uina_Core 病复发） | 每目录必须有运行证据；架构评审问题走 reality-first 清单 |
| 记忆文件后端将来迁移浪费 | 记忆走 port 接口，后端可换（本就是设计意图） |

---

*证据账本（随开发更新）*：本文件 claims 全部待切片跑通后逐条升级为 Tested behavior。

---

## 8. Reality-pass 修正记录（2026-09-02，空纪指令：吸收 Nott + 删非必须）

**删除（无真实消费者/演示性机制，reality-first：不跑起来的不留）**：

| 部件 | 删除理由 |
| --- | --- |
| bus/mailbox（core/bus.ts） | 实际流通只有 user_input 转发；turn_start/end 事件发射后无订阅者=死音。输入源（TUI/oneshot）直连 pushInput 更短。将来多通道真实出现时再以通道边界形态回归（f11） |
| runtime store（core/store.ts） | sessionId/startedAt 无消费者；nextTurnId 与 loop.turnSeq 双计数（且返回值未用） |
| output broker（core/output.ts） | 单一消费者（TUI 独占）的广播=炫耀物；hooks 直连即可。将来多端（语音/SSE）真实出现时再抽 |
| Job 演示（think_for + isJob + job_done + internal-event 唤醒） | 最小 agent 用同步工具已够，无真实需求。f8“等长任务”待真实后台需求（如长语音生成）出现时以最小形态回归 |
| 记忆 kind 维度（self/history）与 all() | 无写入路径=死设计；记忆端口只剩 fact 单一形态 |

**吸收（Nott 两亮点）**：

1. 工具状态可见性：hooks 增加 onToolStart/onToolDone，UI 显示“⏳ [工具] xx → ✓”（仿 Nott AgentState 的事件驱动渲染）
2. 会话续聊：`pnpm start -- --continue` 从 data/session.json 恢复对话历史（仿 Nott --session，最小版）

**收获的 bug（真模型第一次工具回路抓出）**：gateway 缺 wire 协议转换——内核存解析后的 tool_calls {id,name,args(对象)}，协议要求 {id,type:"function",function:{name,arguments:JSON字符串}}。mock 测试绕过 gateway 导致发送方向从未被测到 → 现在补了发送方向单测（captureReq）。教训：**协议边界必须有双向测试**。

**删除标准的首次执行**：§5 删除标准“切片跑通后某部件未在真实场景使用则删”——已执行（bus/store/broker/Job 全部无真实场景）。
