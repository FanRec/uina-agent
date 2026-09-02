# 12-Factor Agents 精读对照（Uina v0）

> 来源：github.com/humanlayer/12-factor-agents（已 clone 到 ThirdParty/，2026-09-02 精读）
> 用途：每条 factor 对照 Uina 现状与差距，决定采纳/拒绝/延后。不是照单全收——这本书是给"生产 SaaS agent"写的，Uina 是"连续存在的个体"，凡与之冲突的条目我们明确标注拒绝。

## 书的底层世界观（brief-history + 全文反复出现）

- **agent 的四件套**：prompt（告诉 LLM 行为与工具）→ switch statement（按结构化输出决定做什么）→ accumulated context（发生了什么）→ for loop（直到终端）。我们的 Subject 就是这四件套的实现。
- **长上下文是 agent 的致命弱点**："loop until solve it" 模式 10-20 轮就乱。书的核心断言：**就算模型上下文越来越长，小聚焦的 prompt + context 永远效果更好。**
- **推荐形态**：确定性 DAG 骨架为主，agent 只在关键点点缀（micro agent）；LLM 管小范围任务，human feedback 转成 workflow 步骤。
- 对 Uina 的含义：她是**单一主体**而非 micro agent 集群——两者不冲突。f10 的"小而聚焦"启示我们：她的长任务应派"心智子进程"（专注小任务、短上下文、结果回注主循环），不是让主体自己无边际抡大锤。

## 逐条对照

| # | Factor | 核心主张 | Uina 现状 | 差距/动作 |
| --- | --- | --- | --- | --- |
| 1 | NL→Tool Calls | 自然语言翻译成结构化工具调用，确定性代码执行 | ✅ 已实现（OpenAI tool_calls + ToolBroker） | 无 |
| 2 | Own your prompts | prompt 是一等公民代码：全控制、可测试、透明、迭代快 | ⚠️ 硬编码在 `mind/context.ts`（黑箱） | **空纪定案：提示词配置化 + 上下文可观察**——把身份/人格 prompt 外置为配置文件，每轮上下文可 dump。首选落点 |
| 3 | Own your context window | LLM 是 stateless 函数；输入=prompt+检索+历史+工具结果+记忆+输出指令；可自定义格式优化 token/注意力 | ⚠️ `mind/context.ts` 是 context 组装层，已控制注入（记忆 ≤5 条、历史 ≤12 条），但格式是标准 messages | 与 #2 一起做：上下文观察窗口（每轮组装后可见）；将来可实验自定义格式（如经历压缩进单条 user） |
| 4 | Tools are structured outputs | 工具=模型输出的 JSON 触发确定性代码；决策与执行分离 | ✅ ToolBroker 即此 | 无 |
| 5 | Unify execution/business state | 尽量从 context 推出执行状态；单一真源、可序列化、可 fork | ⚠️ 业务状态=history[]，执行状态=busy/pending（分离） | 长期：state 形态演进为 **append-only event log**（见 f12），execution 状态尽量可从 log 推出 |
| 6 | Launch/Pause/Resume | agent 是程序，要能停/续；**工具选择与执行之间**要能暂停（审批点） | ❌ 无（现在选→即执行） | shell 等高风险工具接入"执行前暂停/审批"机制时做（她的 ControlPlane 层） |
| 7 | Contact humans with tools | "找人类"是工具：request_human_input→break→等事件→回注 | ❌ 无 | 将来她主动联系空纪/需要用户决策时做成工具——与我的 QQ 通道同构 |
| 8 | Own your control flow | 自己控制循环：break 等长任务、结果缓存/summarize、LLM-as-judge、context 压缩、限流、durable sleep | ✅ 部分：decideLoop 自研、job_done 事件 = "break 等长任务"雏形 | 补：context 压缩（记忆入口）；工具结果 summarize/缓存（f09/a13 相关） |
| 9 | Compact errors | 错误进 context 让模型自愈；**连续错误 ≤3 次熔断**再 break/escalate | ⚠️ 工具失败返回结构化错误回注（一半）；但无"同一工具连续失败计数"，只有全局 MAX_TOOL_ROUNDS=3 | **做：per-tool 连续错误计数熔断**——小而值得，防 spin-out |
| 10 | Small, focused agents | 小聚焦 agent 是确定性大系统的积木；context 越小越好 | ✅ 单一主体；长任务将来派子心智 | 记入长大路径（长任务=小上下文子心智+结果回注） |
| 11 | Trigger from anywhere | 多渠道触发（slack/email/sms）；outer loop（cron/事件触发） | ✅ 架构级：bus 即通道边界，加通道=加消费者 | 将来 QQ/语音接入即此 |
| 12 | Stateless reducer | agent 作为 foldl：状态=累积事件序列，可任意点恢复/fork | ❌ 未采纳"无状态"；**采纳其形态** | **Uina 的记忆存储形态 = append-only event log（经历不可变追加，可回放/fork）+ 可变投影（未做，记忆系统建设时）**——这比 stateless 更适合"连续个体"：不可变日志保证连续性，投影可变保证成长 |
| 13 | Pre-fetch context | 明知要用的数据直接确定性取来塞进 context，别让模型绕圈调工具 | ❌ 未做 | 进 context builder 优化项（如话题检测后预拉记忆），低成本 |

## 采纳/拒绝/延后清单

**采纳（立即/近期）**：

- f2+f3 提示词配置化与上下文可观察（空纪定案，首个大动作）
- f9 per-tool 连续错误熔断（小改，防 spin-out）
- f12 记忆形态定为 event log（设计决策，实现随记忆系统）

**延后（有触发信号再做）**：

- f6 工具执行前暂停/审批（等 shell 真实出事故或她权限需求变大）
- f7 request_human_input 工具（等她需要主动联系/决策）
- f10 子心智（等第一个长任务）
- f11 QQ/语音通道（等 1.8s 语音链路）
- a13 pre-fetch（随 context builder 优化）

**明确拒绝**：f12 的"stateless 可随意重启"(对连续性存在是反的)；不采纳"多 agent 架构"作为主体形态（她是单一意识）。

## 已落地佐证

- f1/f4：`src/tools/broker.ts` + gateway tool_calls —— 9 个测试里有工具闭环用例
- f8："输出期间排队"、"job_done 唤醒"是两个"自有控制流"的实例
- f9 一半：工具失败回注结构化错误（shell 工具错误用例实测）
