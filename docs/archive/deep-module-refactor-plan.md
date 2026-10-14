# 深模块重构执行稿（v2，2026-09-18）

> **状态：已全部完成（2026-09-19）。** P0=4e7225e、P1-1=de2334c、P1-2=cd7a9f9、P1-3=3966011、P2-A/B=a5bfb06、P2-C/D=36aacd4、P2-E/F=d501ea5、P2-G/H/I/J=c6ed8f5，均已推送远端验证。全量门保持绿（46 文件 / 599 过 + 1 预期失败），CRAP gate 与基线一致（17 个 cli/ui 既有欠账，内核范围零失败）。执行中的两处实现细化：P2-C 空闲有排队时 direct 随队保序（followUp）而非升级 steer——drain 的 steer 优先取用会破坏 FIFO（session-facts 恢复队列测试钉住该语义）；P1-3 链式 hook 的只读视图由 host 链步 shallow rebuild + Object.freeze 呈现（深拷贝仍只在 guard，O(1) 冻结不是拷贝）。

v1 经用户对抗性复核修订：纠正三处技术判断（finishedEvents 生命周期、turn_start/turn_end 真因、rewind 投影时序方案），按"真 P0 / 深模块 P1 / 清扫 P2"重排。所有结论对照 main（6aeba33 后）代码。

## 相对 v1 的判断修正（留档）

| 项 | v1 判断 | v2 裁定（已对照代码） |
|---|---|---|
| finishedEvents | "会话级无限膨胀，result 字符串常驻" | **错**。每批 assistant tool_calls 处 clear()（recovery.ts:284-285）。真问题：①rewind 不清（applyRewind 只清 pendingCalls），上一批状态残留；②result 字段半支持——生产不写（loop.ts:925-928 仅 callId/name/status）、reducer 与测试却支持。按语义二选一重裁定（见 P2-A） |
| turn_start/turn_end | "trajectory 节点打开后永不闭合" | **诊断错**。onTurnStart 直接落 completed 节点（agent-events.ts:41-53）。真 bug：steer 消费 ++turnSeq 发新 turn_start，最终 turn_end 仍用 runTurn 最初 turn 号——事件契约与 trajectory turn 号不一致 |
| rewind 投影时序 | "append 先行、journal 权威、投影失败重试" | **方案否决**。durable rewind 已提交而 Subject 未切换不可接受。改为 store.state 构造 candidate：验证/投影先行，append 收尾（见 P1-2） |
| protectRewindContext | "默认路径恒 no-op，移到 policy 装饰器" | 补充关键事实：它**本来就没保护自定义 policy**（policy 整体绕过 projectAgentHistory），是放错位置的 invariant，不是"已有但多余的守卫"。裁定见 P2-B |
| accept 丢输入 | P0 | 降级：latent dead path（三重上游 clamp 保证不可达），随手删守卫即可，不冠 P0 |
| 双旗标窗口 | "6 旗标收敛 phase 枚举" | **方案过度**。只把 activity 明确为 idle/starting/turn/rewind 三态+起点；pendingRewind/resumingQueue/interrupted 是不同维度，不塞一个 enum |
| RewindRequest.summary | "旧压缩残骸" | **不准确**。旧内嵌字段是 compaction（已删）；summary 现被 session tool 与 UI 实际消费（发起方经验摘要）。改名 note 属清晰度优化，非残留清理 |
| SystemAgentMessage | "无生产者，删" | **保留**。开放 projection seam 的合法表达能力（自定义 projectHistory 可产 system 消息），不是死代码 |
| convertToLlm 孤儿清理 | "reducer 已禁止，纵深防御" | 理由修正：convertToLlm 还接收 turn.prepare / 自定义 policy 产生的消息，provider 边界配对清洗合理。保留+补注释（结论不变，依据换） |
| accept/pushInput | "合并双入口" | **不合并，收窄**。异味在 Subject.pushInput 显式 direct+busy 静默变 followUp；投递规则应单点下沉 Subject，host 变薄透传（见 P2-C） |
| append 仅校验 rewind | "过度防御（不对称）" | **升级为正确性 P0**：appendMessage({role:"user",content:123}) 可过 checkRecord 落盘，重开被 isRecord 拒 → session 变砖 |

---

## P0：正确性（可能造成错误/持久化损坏）

### P0-1 所有 Session append 统一 schema 校验
- `JsonlSessionStore.append` 与 `MemorySessionStore.appendSync`：**先 `isRecord`（schema 边界）再 `checkRecord`（语义）**，全部 record kind 一致；删除现有 rewind-only 特判（jsonl-store.ts:172 / memory:225）。
- SessionStore 接口注释成文两层校验契约：schema 归 store、语义归 reducer。
- 钉：测试"user 消息 content 非字符串的 append 被拒且 store 状态不变"。

### P0-2 turn_start / turn_end 事件身份一致
- 真因：drainQueuedInputs 每消费一个 steer 项 `++turnSeq` dispatch turn_start，但收尾 turn_end 携带 runTurn 入参的最初 turn 号。
- 修：保留 per-item turn_start（transcript 可见性），每项 consumeQueueItem 完成后 dispatch 配对 `turn_end { turnNumber: 该项号, usage: 当前快照 }`——turn_start/turn_end 按 turnNumber 严格一一配对，trajectory 与 transcript 的 turn 号口径恢复一致。
- 钉：事件配对测试（任意输入序列，turnNumber 集合两两相等）。

### P0-3 顺手：删 startRun 的 thinkingLevel 死守卫（loop.ts:511-514）
- latent dead path（constructor 抛错 + setModel/applyPreparedRuntime 双 clamp 保证不可达），删除即消灭 accept 直通丢输入路径。

---

## P1：深模块化（本次最有价值三项）

### P1-1 navigation/access 直读常驻 state
- 四个导航函数签名改收 `CanonicalState`，`createSessionAccess` 直传 `store.state`；**不留 records 兼容包装**，直接改全部调用方（access、branch-inspector tests、session-rewind:715）。
- 改造前写新旧对拍测试，改造后转为直接断言。
- 消灭：每查询 `[...readRecords()]` 全量拷贝 + canonicalReplay 全量重放（违背"禁止第二 walker"不变量）。

### P1-2 rewind 基于 candidate，不再 replay journal
- 现状：readRecords 拷贝 + canonicalReplay 全量重放 + check/apply 本地 + appendRewind 内部再 check/apply；手算 seq 被 store 覆盖（死代码）。
- 修（candidate 方案，保持"投影失败 = 不落盘"语义）：
  1. 从 `store.state` 取 fromId、targetId 前缀切片（entries[0..targetIdx]）；
  2. 用 applyRewind 既有的纯函数（buildRewindNotice / summarizeAbandonedEffects / collectCarriedInputs）构造**候选 hydrated rewind entry**——不触碰常驻状态；
  3. `checkRecord(store.state, record)` 只读校验；
  4. `history = projection.projectHistory([...prefixEntries, candidateEntry], store.state)`——投影先行，自定义 policy 抛错时主线不动；
  5. `await store.appendRewind(record)`——store 内部 checkRecord 复核（其间有并发追加则 fromId 失配被拒，语义安全），apply 落常驻状态。
- 删除：全量 replay、records 拷贝、死 seq 计算。函数 ~63 行 → ~30 行。

### P1-3 Hook 边界单一 clone ownership
- 现状：guard clone/freeze → ExtensionHost 每 handler 再 readonlySnapshot → 返回 host clone → guard 再 clone；单 handler 接近 4 次全上下文深拷贝。
- 规则成文：**clone+freeze 只发生在 guard 边界；host.run* 是纯聚合器**。
- 修：
  1. `ExtensionRunner.runtimeHooks()` 返回 `guardRuntimeHooks(createRuntimeHooks(...))`——堵住 host.runToolDirect / runner.callTool 两条未过 guard 的旁路（host.run* 敢假设输入只读的前提）；
  2. host.run* 全删 per-handler readonlySnapshot 与返回侧 structuredClone/copyValue；返回收口只在 guard 一次。
- 净效果：每次 hook 全量拷贝 → 入 1 + 出 1。

---

## P2：清扫与小项

| # | 项 | 动作 |
|---|---|---|
| A | **finishedEvents 语义重裁定（二选一，需确认）** | **推荐 B**：tool_finished 只证明 execution terminal——`finishedEvents: Map<callId, ToolResultStatus>`（去 result 字段），planRecovery/recoveredToolMessage 相应简化；同时 applyRewind 补 `finishedEvents.clear()` + resultIds 处置（rewind 清残留）。方案 A（正式持久化 result）意味生产 loop.ts 要写 result 进事件，无需求支撑。**不保持半支持现状** |
| B | **protectRewindContext 位置裁定（需确认）** | 推荐：**升格为 Replacement seam 的 Core invariant**——resolveProjectionPolicy 对自定义 projectHistory 包 `protectCanonicalContinuity` 装饰器（默认实现由构造保证、零开销）；若裁定"rewind notice 可被投影擦除"则整函数删除。不维持"默认路径 no-op 但自定义路径裸奔"的现状 |
| C | 投递规则收窄 | direct 忙时规则单点下沉 Subject（submitText 语义整体归 Subject），host.submitText/pushInput 变薄透传；accept 不合并。消灭"Subject.pushInput 显式 direct+busy 静默变 followUp"的含糊 |
| D | pipeline.ts:68 二次 prepare | 删（broker.execute 已复核 tool identity，AJV 白跑） |
| E | 死代码 | InputQueues.enqueue、ToolBroker.copyTo、QueueMode+peekMany("all")、BuildInput.runtimeInputs+formatRuntimeInput（测试用例改写） |
| F | buildAssistantMessage | recordTerminalAssistant / settleToolExchange 共用构造器，**不合并两流程** |
| G | 小项 | buildUsageEvent 提取；snapshot() 单次 queuedSnapshot；删 eventData()；SessionMessageRecord.message 收窄 AgentMessage；P1.3 标签、builtin.ts:96 注释 |
| H | TOOL_RESULT_STATUSES | 常量入 core/types.ts，broker 运行时校验与 recovery.checkEvent 共用（校验本身保留：第三方 Tool 是不可信边界） |
| I | RewindRequest.summary → note | 清晰度改名（session-tools/branch-inspector/transcript/isRecord 同步；v3 无历史包袱） |
| J | convertToLlm 孤儿清理 | 保留 + 补注释（provider 边界纵深防御，输入含 turn.prepare / policy 产物） |

## 明确不做

- 不动 Jobs/Subagents Host 特权（另立执行稿）。
- 不给 ToolView 加 get()；不拆 Subject 文件；不做 projector memoization（无性能墙证据）。
- SystemAgentMessage 保留；UI 域另立稿。

## 批次顺序

P0（一个提交：P0-1/2/3 同属正确性）→ P1（三个独立提交：1-1 / 1-2 / 1-3）→ P2（A、B 裁定后与其余合并 1-2 个提交）。每批全量门 + 本批专属验证。

## 待用户裁定（阻塞 P2 的两项）

1. **finishedEvents**：A（正式持久化 result）还是 B（status-only）？——推荐 B。
2. **protectRewindContext**：升格 seam invariant（自定义 policy 包装饰器）还是删除？——推荐升格。
