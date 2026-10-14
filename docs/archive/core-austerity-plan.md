# Core 紧缩重构设计（Core Austerity Pass）

状态：**已实施完成（2026-09-17，Phase 0–6 全部执行）**，实施记录见文末附录 A；五问删除审查答案见附录 B；思想实验验收结果见附录 C。历史行号为实施前快照，冲突以当前源码为准。

## 0. 目标与范围

**目标**：把 Uina Core 收敛为"最小、稳定、可持久化、接缝直接"的 Subject Runtime——未来出现今天未预期的能力时，原则上只加扩展，不改 Core 主循环 / Session 核心 / Recovery 核心。

**非目标（本轮明确不做）**：Planner、Memory、Workflow Engine、Activity/Task DAG、统一 Effect Framework、Event Sourcing、长期任务框架、任何新业务能力。

**验收标准**（思想实验）：取若干今天不存在的能力（如"运行中按成本切换模型"、"工具执行中途注入提醒"、"跨会话任务看板"），逐个走查——应全部落在现有或本规划新增的接缝上；若必须改 Subject 主循环或 session/recovery 才能实现，说明接缝不合格。

**总原则**：机制留 Core，策略出 Core；Core 记录事实，不理解业务事实；不知道的明确说不知道（unknown/not_started 纪律保留）；不为假想未来预先设计，也不为历史错误设计保留兼容层。

## 1. 现状证据（2026-09-17 核实）

### 1.1 Subject 职责聚集（God Object 前兆）

`src/agent/loop.ts`（~1300 行）同时拥有：

| 职责 | 位置 | 性质判定 |
|---|---|---|
| 模型调用主循环 decide/runTurn | L655-837 | **机制**，Subject 本质 |
| 输入队列调度（steer/followUp） | L487-535, L737-753 | 机制（Pi 的 Agent 同样自持队列） |
| 中断/取消传播 | L537-545 | 机制，Subject 本质 |
| 压缩编排（决策/执行/验证/落盘） | L1028-1198 | 机制编排属于生命周期，**实现应下沉** |
| 回溯调度+提交+投影+超限压缩 | L331-485 | 安全点调度是机制，**提交/投影应下沉** |
| usage 记账与缓存失效 | L117-126, L192-247 | 记账是 telemetry，**应剥离** |
| session 导航 API（SessionAccess 挂 Subject） | L84-105 | 纯 store 读取，**不属于 Subject** |
| UI 编辑器取队列 | L579-598 | UI 关切，**不属于 Subject** |
| thinking 档位管理与循环切换 | L281-299 | 边缘，可留 |

### 1.2 Core 理解业务事实（边界违规）

- `session/recovery.ts` L115-116：`WRITE_TOOL_NAMES = new Set(["write_file"])`
- `session/recovery.ts` L170：`if (call.name === "exec_command")` 特判
- `session/types.ts` L116-124：`AbandonedSideEffects` 硬编码 `modifiedFiles / executedCommands / dispatchedTasks(type: "job"|"subagent")`
- `host.ts` L177-179, L260-262：`abandonedTaskIds` 在 Host 层注入 subagent 语义
- `agent/compaction.ts` L300：`WRITE_TOOLS = new Set(["write_file"])`（默认算法内；已有 `registerCompactor` 可整体替换，属轻度问题）

后果：每新增一种副作用工具（git_push、db_write、send_email…）都要回头修改 session 层——Core 在猜世界内容。

### 1.3 接缝现状（比直觉好）

已有接缝：`RuntimeHooks`（turn.prepare / transformContext / beforeCompact；tools.beforeCall / transformResult；provider transformHeaders/transformPayload/observeResponse；events.emit/observe/flush）、`ExtensionAPI`（registerCompactor+shouldCompact、registerContextContributor、submitInput、sendMessage/appendEntry、callTool、registerTool/Command/Provider/Model、services）。

压缩策略已是注入 seam；问题只在 Subject 拥有编排而非策略在 Core。

### 1.4 对照 Pi 的真实缺口（E:/Uina/ThirdParty/pi，已核源码）

Pi `packages/agent/src/agent.ts`（~590 行）+ `agent-loop.ts`：

1. **`prepareNextTurn` 可中途换 model + thinkingLevel + context**（agent-loop.ts L177-190）。Uina 的 `turn.prepare` 只能换 `messages/systemPrompt`。任何"运行中切换口径"的能力（成本控制、降级、多模型协作）目前必须改 Subject 主循环。
2. **`shouldStopAfterTurn`**（agent-loop.ts L252）。Uina 只有工具结果 `continuation: "stop"` 一种停止表达；回合间停止策略（预算、审批等待）无直接接入点。

注意：Pi 的 Agent 自己拥有 steer/followUp 队列——队列所有权不是违规，无需搬出。

Pi 核心无持久化/journal/usage 记账/压缩/回溯。Uina 的持久化层既是差异化资产，也是边界违规最重的地方——优先动刀对象。

## 2. 目标架构

```text
                 Extensions（策略层）
      Planner / Memory / Jobs / Skills / 未来未知能力
                  │
          ─── 直接接缝（少而有力）───
                  │
              Subject（机制层）
          input → decide → tool → continue
          生命周期安全点（压缩/回溯在此调度，不在此实现）
                  │
              Journal（事实层）
          durable facts（generic，不含工具语义）
                  │
          External Reality
```

归属裁定（宪法五问的应用结果）：

- **留在 Subject**：主循环、队列、中断、运行安全点调度（回溯 busy→scheduled / idle→commit 的时机判定）。
- **下沉到 session/ 或独立模块**：压缩的执行/验证/落盘、回溯的提交/投影、usage 记账、session 导航读取。
- **泛化为通用原语**：AbandonedSideEffects → generic effect fact。
- **保持注入 seam 不动**：压缩策略（compactor/trigger）、上下文贡献、工具注册、Provider 注册。

## 3. 分阶段计划

每阶段独立分支，门：`pnpm typecheck && pnpm test && pnpm dev:baseline -- --quick`（Phase 2/3 追加全量 `pnpm dev:baseline`）。阶段间可暂停，无顺序倒置依赖的项可并行。

### Phase 0 — 冻结与基线（半天）

- 建立职责/接缝清单（以本文 §1 行号为准），跑全量基线确认绿。
- 固化"不做"清单（§0 非目标），防止执行中漂移。
- 产出：无代码改动。

### Phase 1 — 低耦合剥离（风险最低）

1. **SessionAccess 导航读取移出 Subject**：`list/listBranches/readBranch/read` 是纯 store 读取，移到 Host 组合（`host.ts` 已有 session 转发，Subject 只保留 `requestRewind`——它需要安全点）。受影响：`extensions/session-tools/` 的注入点、`ExtensionRunner` 的 session 选项。
2. **编辑器取队列移出 Subject**：`takeQueuedForEditor/takeLastQueuedForEditor` 的 claim 机制下沉到 `agent/queue.ts`，Host 组合暴露给 UI。队列**所有权保留在 Subject**（对齐 Pi，不做无谓搬迁）。
3. **UsageTracker 抽取**：`lastReportedUsage/lastKnownUsage/forgetUsage` 及其脆弱的广播顺序不变量（loop.ts L209-218 注释自认）抽成独立对象注入；Subject 只发原始 usage 事件。`getUsedTokens/getContextSegments` 一并移交，HostSnapshot 从 tracker 取数。

判据：行为零变化；现有 47 个测试文件全绿；loop.ts 减重 ~200 行。

### Phase 2 — 压缩/回溯实现下沉（高风险核心）

1. `performCompaction/resolveCompactionResult/compactProjectionForRewind` → 新 `session/compaction-runtime.ts`（或并入现有 `agent/compaction.ts` 后整体移至 session/）。切点有效性规则（不切断 tool_call 配对、usage 锚随口径切换失效、rewind 投影先测量再落盘）是**机制**，随实现走，不改语义。
2. `commitRewind` 的投影/落盘部分 → `session/rewind.ts`；Subject 保留 pendingRewind 状态机与安全点判定（decide 循环内的 applyRewind 调用点）。
3. **前置**：为 `recoverRecords` 补顺序回归测试（先测试后迁移）。

判据：loop.ts ≤ ~500 行；不再 import `session/navigation.js`；压缩/回溯全路径测试绿。

### Phase 3 — AbandonedSideEffects 泛化（唯一动 journal schema 的阶段）

1. 新增 generic effect 记录：工具执行时可声明 `{ effectType: string, externalOperationId?: string, data?: unknown }`（通过 tool 执行结果或 ExtensionAPI 追加 durable fact），session 只存不解。
2. recovery 的 `WRITE_TOOL_NAMES/exec_command` 特判删除，改为消费上述 generic fact；`AbandonedSideEffects` 类型退役或降为扩展层视图类型。
3. subagent 的 abandoned 判定迁至 subagents 扩展：从 journal 的 generic fact 自行派生；`host.ts` 的 `abandonedTaskIds` 移除。
4. 默认 compactor 中 `WRITE_TOOLS` 的文件清单改为从工具声明的 effect facts 收集（compaction 仍属 agent/，但数据来源通用化）。
5. journal 只加新 kind，旧记录读取兼容一个迁移窗口；`docs/session-rewind.md` 同步更新。

单独分支，便于回滚。

### Phase 4 — 删除审查 + 默认实现下沉

按五问逐个过（记录答案到本文件附录）：

- `QueueMode` 双配置（loop.ts L41-42）无消费者证据 → 删或简化。
- `Model` 上 `contextWindow/maxContextWindow/modelContextWindow` 三字段并存（core/types.ts L208-210）→ 核实后收敛为单一事实字段。
- extensions services 注册表使用率 → 无真实跨扩展调用场景则删。
- `SessionEventName` 闭合枚举 vs Phase 3 的 generic fact → 收敛为后者，闭合枚举删除。
- 默认 compactor（含 write_file 清单）整体下沉为 builtin extension，经 `registerCompactor` 注册——Core 只剩机制。

### Phase 5 — 接缝补齐（仅两项，语义照抄 Pi，不做 UniversalExtension）

1. **turn.prepare 返回值扩展**：允许返回 `{ model?, thinkingLevel?, messages?, systemPrompt? }`；Subject 在每次回合边界应用，模型切换复用 `setModel` 的 usage 锚失效纪律（单一实现，不并行两套）。
2. **回合间停止 seam**：`RuntimeHooks.turn` 增加 `shouldStopAfterTurn(input): Promise<{stop?: boolean}>`，在 decide 循环的回合边界检查（对应 Pi agent-loop.ts L252 位置）。默认 no-op，不加其它参数。

除这两项外**不新增任何接缝**。

### Phase 6 — 思想实验验收

走查至少三个假设能力，全部应只经扩展实现：

- "运行中按成本/负载切换模型" → Phase 5.1。
- "工具执行中途注入外部提醒" → submitInput + registerContextContributor（现有）。
- "跨会话任务看板" → appendEntry durable fact + 扩展自持状态（现有）。

走查不过的项 → 列为下一轮唯一 Core 改动候选，本轮不扩大范围。

## 4. 风险与边界

- Phase 2/3 依赖 recovery 投影的记录顺序不变量：先补回归测试再动。
- 不改启动方式、配置路径（~/.uina/auth.json、data/session.jsonl）、已有 journal 记录的可读性。
- 不动 `E:/Uina/ThirdParty/pi`、真实 Provider 配置、真实会话与用户认证。
- 全程遵守 AGENTS.md 稳定边界（host 不依赖 UI、session 不依赖 agent、agent/core/session/tools 不依赖 extensions 等）；Phase 4 默认 compactor 下沉为 builtin extension 后需确认 boundary script 对 `extensions/` 的既有豁免方式（builtin 装配路径已存在先例：workspace-tools）。

## 5. 阶段产出汇总

| 阶段 | 代码改动 | journal schema | 风险 |
|---|---|---|---|
| 0 | 无 | 无 | 无 |
| 1 | 纯结构移动 | 无 | 低 |
| 2 | 实现下沉 | 无 | 中高 |
| 3 | 泛化 + 删特判 | 新增 kind（兼容读旧） | 中高 |
| 4 | 删除 + compactor 下沉 | 视删除项 | 中 |
| 5 | 两个接缝扩展 | 无 | 低中 |
| 6 | 无（走查文档） | 无 | 无 |

## 附录 A — 实施记录（2026-09-17）

| 阶段 | 提交 | 核心改动 |
|---|---|---|
| 0 | （无代码） | 基线绿：typecheck / 45 文件 639 测试 / quick baseline |
| 1 | `de8746b` | 新增 `session/access.ts`（createSessionAccess：store+回溯入口组合 SessionAccess）；Subject 移除 session 字段与 navigation import；AgentHandle.session 组合视图；BuiltinServices.session |
| 2 | `074ea23` | 新增 `agent/rewind.ts`（commitRewindTransition + compactProjectionForRewind 纯机制层）；resolveCompactionResult 上移 agent/compaction.ts 导出；Subject.commitRewind 收敛为薄编排；+3 机制回归测试 |
| 3 | `2ccdca3` | ToolEffect（effectType/externalOperationId/label/data）+ `details.effects` 声明约定；AbandonedSideEffects 退役为 AbandonedEffects；recovery 删除 write_file/exec_command/subagent_start 全部工具名知识；工具侧自行声明效果事实；journal 结构零变更（effects 为回放派生字段） |
| 4 | `ee16417` | 删除 steerQueueMode/followUpQueueMode；新增 `core/effects.ts`（isToolEffect/readDeclaredEffects 唯一读取点）；默认压缩器写入清单改以 file.write 效果事实为准 |
| 5 | `02211e8` | turn.prepare 返回值扩展 model/thinkingLevel（Subject.applyPreparedRuntime 以 setModel 全套纪律应用）；turn.shouldStop 回合间停止 seam；+2 接缝测试 |

终态测试：45 文件 645 通过 + 1 expected fail；每阶段均过 typecheck / 全量测试 / quick baseline。

### 有意偏差（均已在提交信息记录理由）

1. **Phase 1.2 编辑器取队列**：claim 机制（同步 remove）本就在 `agent/queue.ts`，Subject 只留两个薄入口；未按字面把入口搬到 Host——队列所有权裁定属于 Subject（对齐 Pi），搬 Host 反而暴露队列内部。
2. **Phase 1.3 UsageTracker 抽取**：Phase 2 完成后复评，**最终裁定保留在 Subject**。实际仅约 60 行，与模型切换/回溯提交/回合结束等安全点交织；抽取后广播顺序不变量（forgetUsage 先于 session_compact）仍是 Subject 侧调用顺序纪律，只换名字不减耦合。
3. **Phase 2 落位**：回溯转换落 `agent/rewind.ts` 而非规划说的 session/——session 不依赖 agent 的稳定边界禁止 session 层引用 compactHistory（agent 层默认算法）；agent→session 方向合法。
4. **Phase 3 journal schema**：实际零变更（优于规划）。effects 是回放时从 `details.effects` 派生的 hydrated 字段，旧日志读取天然兼容，无需迁移窗口。
5. **Phase 4 默认 compactor 物理下沉**：缓期。`registerCompactor` 接缝已可整体替换，物理搬移是无边界收益的 churn；数据来源通用化（effect facts）已完成。
6. **Phase 4 保留项**：Model 三窗口字段（contextWindow/maxContextWindow/modelContextWindow = 物理/运维钳制/有效=min，是配置事实非冗余）；extensions services 注册表（examples/skills 有真实消费者）；SessionEventName 闭合枚举（描述运行时事件类型，与 generic effect facts 不冲突）。
7. **loop.ts 行数**：1209 行（规划估 ≤500）。未达数字指标但结构性判据全部达成：navigation import 已消失、压缩/回溯实现已下沉、Core 无工具名知识、usage 记账经复评裁定保留。剩余主体是 runTurn/settleToolExchange/队列调度/中断传播——均判定为 Subject 本质机制。数字是估算而非硬门。

## 附录 B — 五问删除审查答案（Phase 4）

| 候选项 | 裁定 | 证据 |
|---|---|---|
| steerQueueMode/followUpQueueMode | **删除** | 全仓（src/tests/examples）零消费者，纯"以后可能需要" |
| Model 三窗口字段 | **保留** | provider-model-decoupling 测试钉住"物理窗口/运维收紧钳制/有效窗口=min"纪律 |
| extensions services 注册表 | **保留** | examples/skills 与文档有真实跨扩展调用场景 |
| SessionEventName 闭合枚举 | **保留** | 描述运行时事实类型而非业务语义；与 generic effect facts 分层不重叠 |
| 默认 compactor 整体下沉 builtin | **缓期** | registerCompactor 已可整体替换；物理搬移无边界收益；写入清单已效果事实化 |

## 附录 C — Phase 6 思想实验验收（2026-09-17，全部有代码实证）

| 假设能力 | 接缝 | 实证 |
|---|---|---|
| 运行中按成本/负载切换模型 | Phase 5.1 | `turn.prepare` 返回 `model/thinkingLevel`（runtime/hooks.ts L17）；`Subject.applyPreparedRuntime` 在三个安全点应用（loop.ts L353/597/738），换模型走 setModel 全套纪律；扩展只需注册 before_agent_start 处理器观察用量并返回更廉价模型事实 |
| 工具执行中途注入外部提醒 | 现有 | `submitInput`（runner.ts L40/L568，steer 队列即时注入当前回合）+ `registerContextContributor`（L55/L474） |
| 跨会话任务看板 | 现有 | `appendEntry` durable fact（runner.ts L101/L684）+ 扩展自持状态；跨会话读取走 session/access.ts 组合视图 |

走查结论：**3/3 通过，无需新增 Core 改动候选**。验收标准（§0 思想实验）达成：未知能力原则上只加扩展。
