# Uina 信息注入体系：接线迁移、遗留清理与结构收口

> **执行基线**：`FanRec/uina-agent`，分支 `mc/world-refactor`；接口审查以 `47a4eb2d57d6163e121474367d8bd93bf1cdbf0b` 为准，并复核至 `c28036d6eaf98fc1772d7007cce028b0b22acabf`（后续提交仅涉及 TTS 测试环境）。实施时先检查实际 HEAD，以现役代码核对合同。
>
> **任务性质**：现有 Context Source、Request Composer、扩展 Markdown Prompt 编译机制已经实现。本任务将所有仍使用旧注入路径的生产者迁移到正确的信息渠道，并删除相应的重复接缝、过时观察和测试。不是重写 Agent Harness 或业务执行系统。

## 1. 产品合同与边界

模型应该在每次请求中准确区分：主体核心指令、扩展使用指南、已经发生的对话/事件/工具结果、此刻可用的能力与事实，以及可执行工具。任何事实只有一个权威生产者；同一内容不因多个旧入口而重复出现。

### 1.1 模型请求的逻辑结构

```text
Host System + Persona                         主体核心合同
Extension Guidance User (0..1)                已激活扩展的稳定说明
History View                                  canonical history 经协议投影与必要压缩
Runtime Context User (0..N)                  本次请求的 capability / observation
Tool Definitions                              Broker 可执行工具 + 必需的历史协议声明

                         ↓
                 RequestProjection
                         ↓
              Measure / Preflight / Validate
                         ↓
                   Provider Adapter
```

- Guidance 是现有 Composer 已实现的**固定 User 前缀**，位于 System 与 History 之间。所有文件式、内联式 Guidance 共用此入口；不允许恢复 System 拼接，不允许针对 World/MCP/Voice 再建装配器。
- Capability/Observation 由 `provideContext` 注册，按请求只读收集，不进入历史、不触发回合、不因预览而消费事件。
- 用户输入、异步完成通知及需要可靠交付的事实，走已有 Input/Delivery 与 Session。Tool Result 继续使用 canonical + 可选 `modelView`；不通过 Context Source 再播一遍。
- 历史压缩只形塑 **History View**；预算对**最终完整请求**判断。Event Frame 只描述历史中的真实输入，不用于包装当前运行时快照。
- Provider 只编码语义请求，不可在统一装配和预算校验后通过通用扩展 Hook 偷改消息或工具。

### 1.2 必须保持不变

1. 现有 `ContextSourceRegistry`、`pi.provideContext`、`PromptFileCompiler` 与单条 Guidance User 前缀：保留现役合同，修复必要问题即可；**不重复造 Registry、Prompt Engine、缓存、优先级或变量系统**。
2. Input Queue、`submitInput/submitInputs`、Delivery Receipt、Canonical History、Rewind、Tool Broker、Tool `modelView`、实际 Provider 协议适配、Event Frame 历史协议：保持职责及外部语义。
3. Compaction 的摘要算法、Checkpoint 持久化与有效性检查、自动/手动触发、通知、回溯和时序：保留，仅重构输入边界及其接线。
4. Minecraft Driver/Executor/Program、MCP Proxy/Manager、TTS 播放和 Live2D 行动：不做领域重写。
5. 已发布的历史 Journal 无需迁移或重写。旧的非关键辅助记录可以不再解释、但不能使旧 Session 无法打开。

## 2. 信息归属：迁移的唯一判断规则

| 信息的性质 | 所有权与进入方式 | 生命周期 |
|---|---|---|
| 身份、不可让扩展覆盖的 Host 协议 | Host `systemPrompt` / Persona | Subject 装配 |
| 扩展稳定用法、表达惯例 | `provideContext({kind:"guidance", text/file})` | Source 注册/卸载/Reload |
| 当前可用的能力、连接资格和必要入口 | `provideContext({kind:"capability",read})` | 每次请求的只读快照 |
| 当前状态、未解决的运行时问题和证据 | `provideContext({kind:"observation",read})` | 每次请求的只读快照 |
| 真正发生且需要处理/历史连续性的事件 | `submitInput`、`emitEvent(s)`、Delivery，以及已有 `sendMessage` 的历史消息语义 | 已有接收/队列/Session 合同 |
| 工具执行回执 | Tool canonical + `modelView` | Tool 事实与历史 |
| 详细能力说明、按需玩法指南、Skills 正文 | 已有工具/资源/Skill 读取 | 模型主动查询 |

**禁令**：不得以 Context Source 的 `read()` 推进游标、确认一次性投递、清除“已看过”的事件或发起模型请求；不得通过 Message 构造伪用户需求；不得因为存在 Context Source 而把本可按需获得的大量文档常驻注入。

**清理判据**：删除一个旧入口时，应同时证明其信息生产者已归位、所有真实消费者已迁移、最终请求与执行行为仍正确；“全仓搜索找不到旧符号”是必要条件，但单独不构成完成证明。保留明确范围之外的执行/会话能力；不因未审查到外部私有扩展而宣称能保证所有外部调用方兼容。

## 3. 核心结构收口

### 3.1 History View：为 Compaction 提供一个窄接口

当前 `src/extensions/compaction/index.ts` 仍通过 `turn.transformContext(RequestProjection)` 修改完整消息数组；`stage()` 则从完整 `inspectRequest().projection.messages` 中识别并排除 `runtime.perception`、`runtime.guidance`，计算裁剪对象及预算。这是功能可运行、但职责边界错误的结构。

**目标**：把历史投影交给压缩器，而不是让压缩器猜哪条消息才是历史。

建议最小合同（命名随代码惯例调整，语义不得改变）：

```ts
// 只有一个当前提供者；无提供者时 identity。同步、只读、无副作用。
type HistoryView = (history: readonly ChatMsg[]) => readonly ChatMsg[];

pi.registerHistoryView(view: HistoryView): () => void;

// Subject 使用 RuntimeHooks 中的窄端口；不直接 import extensions。
runtimeHooks.history.project(history: readonly ChatMsg[]): readonly ChatMsg[];
```

- **单一所有者**：同一 Host 同时只允许一个 History View 提供者；重复注册明确报错；注册跟随现有 `ResourceScope` 生命周期自动撤销。使用一个可替换的函数槽即可，不建多层 Hook 链、排序、注册优先级或第二个投影策略注册表。需区分原有 `ProjectionPolicy`（历史/协议解释）与此接口（压缩后的可见历史），不额外引入第三套历史投影解释器。
- **边界**：输入是 canonical history 经过现有 `ProjectionPolicy.convertToLlm`（含历史 Event Frame）后的 **History 消息**；不含 System、Guidance、当前 Sources 或工具列表；输出必须是合法的 History 消息序列，不可改变模型、工具、System。`ProjectionPolicy.projectHistory/convertToLlm` 仍负责原有的 Session/协议形塑，History View 专注进一步的历史裁剪；不二次转换 Event Frame。
- **实现**：内置 Compaction 注册此函数，复用现有 `activeCheckpoint()`、`staged`、`compactedMessages` 的摘要+尾部裁剪规则；移除输入中对 System/`runtime.perception`/`runtime.guidance` 的过滤和重新追加。保留 Event Frame 分组、真实工具调用/回执的原子边界。
- **只读性**：`project()` 不更新 Checkpoint、不提交候选、不发事件。`inspectRequest()` 与真实请求都可安全调用。Checkpoint 的生成、提交、自动/手动压缩继续由现有 Command、`turn.preflight`、`turn.afterEnd` 负责。
- **不重复投影**：每轮 `prepareProjection()` 从 canonical history 重构历史视图；`preflight=rebuild` 重跑，不能在上轮已压缩消息上二次叠加相同摘要。

`src/agent/loop.ts` 应在装配前明确取得 `historyMessages`，而不是先建完整 RequestProjection 再交给外部任意改写：

```ts
const history = projectionPolicy.convertToLlm(subjectHistory, { thinkingReplay }); // subjectHistory 已遵守现有 projectHistory/rewind 规则
const visibleHistory = runtimeHooks.history.project(history);
const tools = declaredToolsForHistory(visibleHistory); // Event Frame 声明按实际历史决定
const base = requestProjection(systemPrompt, visibleHistory, tools, thinkingLevel);
const collection = await runtimeHooks.context.collect({ modelKey, signal });
const { projection, assembly } = composeContextSources({ projection: base, collection });
// 之后统一 measure / preflight / validate / stream；rebuild 重新走整条路径。
```

保持 Host 指定的历史 `ProjectionPolicy`，不能绕过其 `projectHistory`/`convertToLlm` 或回溯连续性保护。`buildContext()` 可以提取明确的历史转换自由函数，不新建一个万能 Pipeline 类。

### 3.2 Compaction 的预算与检查接口

从最终消息中靠 `role` 或 `context.kind` 提取历史，属于反向猜测。应让真实请求检查携带**明确的已使用 History View**：

```ts
interface RequestInspection {
  // existing: projection, measurement, inputBudget, assembly, basis ...
  readonly history: readonly ChatMsg[]; // 本次实际装配的 History View（压缩后视图）
}

// turn.preflight 的输入也带同一个 history 视图，供自动压缩规划使用。
```

- `stage()` 的摘要输入、切分边界、`entryId` 映射只读取 `inspection.history`；不能遍历固定 Guidance、System、Runtime Source 来寻找可裁剪内容。历史允许已含现役 Checkpoint 的摘要与尾部；新的 staged 候选应用到**重建时从 canonical 重新生成**的历史，而非在上次输出上重复压缩。
- 预算须预留 **System + Guidance + 当前动态 Context + Tools + 其他不能裁剪的开销**。可从同次装配的明确历史视图计算估算历史成本，再用同一估算口径计算非历史成本；不能把 Provider 级真实/近似测量值与不同口径的逐段 token 数无条件相减并当作精确等式。保守规划即可，完成 rebuild 后仍以**完整请求**的现有测量与 Preflight 为最终准入依据。**不得**把 `inputBudget` 全部交给 History。
- Guidance 或 Runtime Context 本身超预算、没有可压缩 History 时，清楚失败，不试图裁掉 System、当前用户输入或静态指南，不空造 Checkpoint。
- 手动 `/compact` 仍以 `inspectRequest()` 判断当前请求；自动压缩仍通过 `preflight` 分两次装配/验证，保持原有 pass 上界与无收益 `noop` 语义。
- 删除 `splitGuidancePrefix`、`filterCompactionMessages`、`isRuntimePerception` 及相应的“剔除后重新拼接”代码，**前提是其所有调用者均已改用明确的 History View**；保留实际历史中必需的协议分组规则。
- 不修改存量 Compaction Checkpoint 数据结构、指纹及 rewind 语义，除非迁移后测试发现其确有历史投影依赖。

### 3.3 工具声明与请求收口

移除 `turn.transformContext` 后，不再允许 Handler 修改工具集，因此：

- 合并 `Subject.declaredTools()` / `mergeContextTools()` 的重复职责。工具声明在最终 History View 已知后**计算一次**：`ToolBroker.defs()` + `ProjectionPolicy` 对该历史所需的协议工具（例如 `external_event_frame`）；Context Source 不提供/改写 Tool Definitions。
- 保留 `ProjectionPolicy.contextToolsRequired` 和保留名调用过滤，除非另外以等价的协议合同替代；**不能因为删除 Transform 就误删 Event Frame 所需的虚构工具声明及其防误执行处理**。
- Provider 的最终 Wire 顺序、历史中的真实 Tool Call/Result、模型视图回放均保持一致。

## 4. 业务信息源迁移

### 4.1 World Framework 与 Minecraft

涉及：

- `src/extensions/world-framework/{types,world-activation}.ts`
- `.uina/worlds/minecraft/worlddef/{index,schema,ENV_PROMPT.md}`
- `tests/world-environment-guide.test.ts` 及相关 World 测试

**决策**：移除 `WorldDef.environmentGuide()` 和 `WorldActivation.registerEnvironmentGuide()`，不创造 World 专用的 Prompt 拼接能力。World 通过自身 `ServiceCompanionContext` 的**薄转发端口**调用现有 `pi.provideContext()`：

```ts
interface ServiceCompanionContext {
  // 其他原有世界服务不变
  provideContext(source: ContextSource): () => void;
}
```

- 转发者 `WorldActivation` 使用自己的 `ResourceScope` 跟踪注销句柄，且仅在 Scope 活跃时允许注册。Registry owner 仍由真实扩展作用域注入（例如 `builtin:world-framework`）；World 局部 ID 由 Framework 自动添加稳定的 `world:<name>/` 前缀，调用者只声明局部 `source.id`，不能重复前缀或伪造 Registry owner。多世界同名局部 ID 必须互不冲突；不新增 World Context Registry。
- 向 `WorldDef.onStart(ctx)` 暴露此端口即可；由世界在资源准备完成后注册，随停用或启动失败撤下。World 关闭时一并撤销所有 Source；下一次激活不得留下旧注册。
- Minecraft 现有 `onStart` 已读取 `ENV_PROMPT.md`。继续读取该文本，并以 `ctx.provideContext({id:"guidance",kind:"guidance",text})` 注册；无需让非 Extension 的 World 强行使用扩展专属文件编译 API，亦不改 Prompt Compiler 的资源根规则。将来 World 真正迁移为独立 Extension 时，可直接改用 `file` 声明。
- 静态指南按 World 激活生命周期注册，不再随着 `connectedSession()` 在 System 里出现/消失。指南描述**有连接时如何行动**，不宣称当前已连接。若有必要让模型无查询即可判断当前是否可操作，增加简短的 World `capability`：从本世界只读连接状态获得 `connected / actionsAllowed`，明确区分“扩展可用”与“当前可行动”。不要把整份背包、地形、工具目录常驻注入。
- `WorldDef.description` / `nativeGuide` 仍仅承担工具入口与发现；长 API、Program、建造等指南继续由既有 `describe`、Guide、Library 按需读取。检查并删除迁移造成的重复解释，而非盲目缩减必要工具语义。
- `emitEvent(s)`、任务受理/完成/恢复和 Delivery 不迁移到 Source，也不改变其时序。

### 4.2 MCP

涉及：`.uina/extensions/mcp/index.ts`、对应 MCP 加载测试。

- 删除 `turn.prepare` 对 System 追加 `buildCapabilityIndex()` 的实现。
- 保留 `mcp` Proxy Tool 的 `list/search/describe/call/status` 及目录发现、权限、连接、按需启动行为。
- 对原来用于主动发现的**全局已配置服务名与用途**，保留一份简短 `capability` Source；每次 `read()` 调用与 MCP Proxy 相同的只读 `resolveMcpConfig()` 获取当前配置，只列与旧 `buildCapabilityIndex()` 相同授权范围内的全局有效配置，明确“已配置不等于已在线/已发现工具”，不重复 Proxy Tool 已解释的调用步骤。没有这类服务时返回 `null`。不擅自将原来未常驻公开的**项目级未信任服务**扩大成常驻目录；其发现仍由 Proxy 的信任门与按需操作管理。
- 允许读取少量本地配置文件以保持与 Proxy 的按次配置解析一致；**不得**在 Source `read()` 中启动 MCP Server、刷新 Catalog、改变信任状态或触发请求。无需另建 MCP Context 缓存；如后续测出实际性能瓶颈，再让 Proxy 与 Source 复用同一个配置快照读取能力。

### 4.3 Voice / TTS

涉及：`.uina/extensions/voice/{index,perception}.ts`，必要时 `.uina/extensions/tts/index.ts` 的服务契约；相关 TTS/Voice 测试。

- 删除 Voice 对 `turn.transformContext` 的尾帧注入、为确认该临时投影而绑定的 `turn.preflight` / `output_start` / `tool_call` 消费链，以及 `VoicePerception` 的 `prepared`、`projections`、合成 Event Frame ID 等投影专属状态。
- 保留 TTS → Voice 的 `voice_perception:record` 服务调用、`causeRef` 归属、失败/中断/未知事实，以及 TTS 已有的 `resolved` 回调。
- `VoicePerception` 只维护当前**未解决且影响后续判断**的事实，注册一个 `observation` Source。`read()` 聚合并返回简短的运行时事实；没有事实时 `null`，不改变候选集合、不标记已读、不触发模型或清除状态。不能因一段文字包含“声音”就把它当成需要长驻的当前状态。
- **必须按现有 TTS 事实链逐类定生命周期**：`driver-impl.ts` 中的 `setResolutionListener` 主要在一段源音频全部确认完成时调用；`tts/index.ts` 的某些 `delivery_failed`、`delivery_unknown`、`interrupted` 并无对应的未来 `resolve(causeRef)`，部分调用甚至没有 `causeRef`。因此不能用“所有记录一直保留到 resolve”作为完成实现。失败/未知若可通过现有 Delivery/Snapshot 对账，随真实确认或新一轮恢复事实清除；一次性的“已被主动打断”若不代表持续待处理问题，则不作为长驻 Observation。确实必须可靠交付一次的事件，走 Input/Delivery，并明确其是否值得主动唤醒。
- 仅对能稳定关联的声音源使用真实 `causeRef` 做替换/解决；没有真实标识的临时事件不得以 `fact.kind` 充当全局伪 ID，将多次独立故障错误合并。不要为此建立新消息 Ack 系统或任意时长的 TTL 猜测。
- 事实的 `record/resolve`、替换/清理应对应真实声音状态，不以“预览过”“本轮生成了文字/工具调用”作为已解决依据。对确有源身份的 `record/resolve` 按实际发生顺序生效，避免异步服务调用乱序使已恢复故障再次出现（优先复用现有保序机制；否则仅在这条服务链上串行化）。必须以故障发生、恢复、断开、后续正常交付等真实反例证明最终会退出，不接受“永远保留未解决观察”作为默认方案。
- 未解决的同一事实允许在多次请求中继续可见；同一 `causeRef` 更新应替换旧内容，不累积重复通知。只在有关联的问题时提供，不把普通电平、播放进度或高频音频状态注入模型。
- 不更改 TTS/Voice Driver 的播放、抢话、输出控制或协议。

### 4.4 Skills 示例与 Memory 实验

- `examples/extensions/skills/index.ts`：删除 `turn.prepare.messages`；简短的可发现 Skill 索引作为 `capability`（必要时缓存发现结果，`read()` 不消费状态）；详细 `SKILL.md` 继续通过 `read_skill` 按需打开。不把示例升级成全局 Skills 框架。
- `tests/helpers/memory-capability.ts`：把 `turn.prepare.systemPrompt` + `turn.transformContext.user` 的双份记忆注入改成**单份** Observation Source；仍由 Auxiliary/`appendEntry` 拥有持久事实。更新对应测试，让 Source 变化、回放、Rewind 行为可核验。它是测试 Fixture，不扩大为生产记忆系统。

## 5. 旧通道及其直接依赖：完整删除合同

### 5.1 旧 Hook 与其组合逻辑

迁移完成后，从类型、API、Host、Runner、Guard、Noop、实际调用和现役示例/测试中一并删除：

- `turn.prepare` 整条链（`messages`、`systemPrompt`、`model`、`thinkingLevel`、聚合规则、`runTurnPrepare`、`applyPreparedRuntime`、临时 `beforeMessages` 传递）。生产代码未发现需要保留的独立模型策略消费者；模型/思考档位已有专用入口。
- `turn.transformContext` 整条链，以及 `tail` 注册选项、`runTransformContext`、`lastTransformLedger`、Transform 来源增量记录。
- 所有旧接口传递的 `RuntimeHooks` 字段、守卫及空实现；旧注入路径的类型 `InjectionProvenance` 和聚合辅助函数。
- 清除 `Host.assembleCapabilities()` 中围绕“先 Compaction、后 Tail Frame”的激活顺序语义注释。Compaction 是唯一 History View 所有者，Source 由 Composer 排序；Host 的实际能力装配顺序仍可保留有意义的启动依赖。
- 不引入废弃接口别名、双写、空 Hook 或“仍可调用但不推荐”的旧路径。受影响的外部自定义扩展属于明确的破坏性 API 变更，应更新现役开发文档并给出新接口用法。

**保留**：`turn.preflight`（完整请求预算/发送决策）、`turn.afterEnd`（压缩等收尾）、`turn.shouldStop`、`tools.beforeCall`、`tools.transformResult`、`provider.transformHeaders`、`provider.observeResponse`、Input/Session/Tool 现有独立接口。禁止为了消除旧注入顺手改写这些业务合同。

### 5.2 开发/验收脚本的工具可见性迁移

仍有两处**非普通信息注入**的旧 `turn.transformContext` 用途不能漏掉：

- `.uina/worlds/minecraft/dev/native-host.ts` 在特定真服/模型验收模式下过滤 `projection.tools`，并使用同一 Hook 的请求观察辅助测试。
- `.uina/worlds/minecraft/dev/i2.ts` 在真模型模式下将声明工具收窄为 `minecraft`。

删除完整请求 Transform 前，必须迁移这两个**现役测试/开发入口**，保留“模型仅见 Minecraft 工具”和测试观察的原始效果。**优先在这两个测试 Host 的装配阶段，将非 Minecraft 工具从该测试实例的 Tool Broker 中撤下**（Broker 已有 `names()/remove()`；这些脚本已使用测试专属的 Host 内部访问方式），使请求定义、工具执行权限与预算从源头保持一致；不要先装配完整工具表，再在 Provider Stream 边界偷偷过滤。仍需通过只读的最近请求观察（模型有输出/工具回执时按 requestId 去重）或测试已有的受控 Provider 请求记录，代替 `rhythm.onRequest(projection)` 的旧 Hook 观测用途。不得为两个验收脚本在生产 Extension API 中重新开放工具过滤/完整请求 Transform Hook。已有 `ToolBroker.createScopedView()` **目前没有直接接入根 Host 的模型请求路径**，不要把它当作现成的 Host 工具声明筛选接口；若现有测试装配方式不足以实现完整约束，再在测试侧就地调整，避免把测试专有需求抽象成公共模型策略。

相关测试（如 `tests/projection-order.test.ts`、`tests/context-snapshot.test.ts`、`tests/extensions-hooks.test.ts`）要保留所验证的时序、取消、模型选择与来源语义；删除旧接口测试时不得顺便删掉这些独立行为的覆盖。

### 5.3 Provider Payload 旁路

- 当前公共 `provider.transformPayload` 可在测量与协议验证之后修改业务消息、工具声明，绕过 Context Composer。现役生产扩展没有发现使用者；本轮删除其**通用扩展 Hook**及 Host 聚合/Guard/Noop 转接、相关用例。
- Provider Adapter 继续拥有不同协议的 Wire 编码；`transformHeaders` 及响应观察不受影响。
- `ProviderWireObservation` 收口为**实际准备发送的载荷**摘要（requestId、provider、hash、bytes、messageCount、toolCount）；删除仅因旧 payload transform 存在而引入的 `before/after/transformed` 比较。`onWireObservation` 保持只读且不进网络请求。若内部仍有合法协议级变换，在其完成后采集最终摘要。
- 这不是删除 Provider 专有参数能力：温度、缓存控制、消息格式等属于 Adapter 自身的正式映射，不属于 Extension Context 注入。

### 5.4 Event Frame 保留其真实职责

- 保留 `src/extensions/event-frames/{index,projection,protocol}.ts` 的历史事件来源标签、原子调用/回执协议、首位降级及 Provider 兼容处理，不将真实外部事件无差别改为普通 User 内容。
- `EVENT_FRAME_PROMPT` 只描述**历史中的外部输入及其协议**，删除“运行时当前状态也都走外部事件帧”等过时陈述；错误提示不再要求 `turn.prepare` 注入消息。
- 不再让 Voice 的当前观察生成 Event Frame；`appendEventFrame` 仅留给真正需要事件协议的历史投影，删除无消费者的通用尾帧注入用途。
- 必须保留 `contextToolsRequired` 随实际 Event Frame 出现才声明合成工具、以及 Subject 对模型生成该保留名调用的过滤。历史回放和 Compaction 不得拆散有效工具对。首次外部输入的历史投影**应先完成首位降级判断**，固定 Guidance User 虽然出现在最终请求前缀，但不得被误用来改变该历史投影的首位判定。

## 6. 请求检查与旧 Prompt Snapshot 的收口

当前每回合的 `context_prepare` / `uina.prompt.snapshot` 只记录旧 System + `turn.prepare` 注入，**不能反映固定 Guidance、动态 Source、压缩历史、真实工具与每次模型请求**。它不再是准确的 Prompt 检视真相。

**统一事实源**：`Subject.inspectRequest()` 返回 `preview`；`Subject.getRequestObservation()` 返回最近通过 Preflight 并**准备交给 Provider 的活动语义请求**，以及可能存在的 `provider_wire` 摘要。两者由 Host 提供窄的只读访问，UI 不直接 import Subject 或访问扩展 Registry。

**事实边界**：当前 `activeRequest` 在调用 `streamFn` 前即记录；`onWireObservation` 在 HTTP 请求构造完成后、实际 `fetch` 之前触发。因而二者**都不独立证明模型已收到消息，也不证明请求成功**。界面应显示“最近准备请求 / 已编码 Wire 摘要 / 实际调用结果（如有）”，不得把“已准备”或“已编码”标为“已成功发送”。不需要为了这个区别另造发送状态机。

### 6.1 删除旧观察链

- 删除 `Subject.dispatchContextPrepare()`、`lastPromptFingerprint`、向 Auxiliary 写 `uina.prompt.snapshot`、`ContextPrepareEvent`、`InjectionProvenance` 及对应事件派发。
- 删除 `src/session/prompt-snapshots.ts` 的运行期读取/写入逻辑；历史 Journal 中的旧记录允许保留，不需要改 Journal schema 或写迁移器。
- 清理 `src/presentation/{facts,ingest-live}.ts`、`src/ui/{tui,ui-host}.ts`、`src/ui/components/{transcript/context-card,transcript/transcript}.ts`、`src/cli/app.ts` 中只为旧 Prompt 卡片服务的导入、参数、重放和展示路径；**保留**外部输入卡、其他 Compaction Decoration、历史转录和通用 Presentation 投影。
- 不把每次真实请求全文落入 Session 以“替代”旧快照；避免存储敏感正文和无限增长。

### 6.2 `/prompt` 的新合同

- `src/ui/features/overlays/prompt-overlay.ts` 与 `src/ui/features.ts`：经 Host 提供的只读查询端口打开检查面。当前 `Host` 向 `ExtensionRunner` 提供了 `inspectRequest`，但**没有直接向 UI 提供 `Subject.getRequestObservation()`**；需要补一条明确的只读 Host→组合根→UI Feature 查询接线，而不是让 `UIHost` 持有 Subject。**已有准备请求则显示“最近请求准备”**，标示 requestId / model / Source Trace / 语义 Messages / Tools / Wire 摘要及可获知的状态；无请求记录时使用 `inspectRequest()` 显示明确标注的“当前预览”。需要时可手动刷新，预览必须为纯读操作。
- **不能混淆**这些信息：最近准备请求可能早于扩展 Reload、Rewind 或模型切换，因此必须显示请求身份及“此前准备”的提示；预览不能称为“已发送”。Provider Wire 目前只提供序列化前摘要/哈希，不能伪称完整网络正文或网络交付成功。自定义 Provider 如未接入 Wire 观察，应明确显示“Wire 未提供”，不得凭语义请求伪造。
- 不新增 Prompt 数据库、每步观察事件流、独立 Inspector Registry；尽量复用现有 `RequestInspection`、`ActiveRequestObservation`、`RequestAssemblyTrace` 和现有 Overlay UI 基础。
- 历史每回合 Prompt 卡片被**有意移除**；旧 Session 仍可打开、回放历史内容，不承诺能从最新 Request Inspection 重建往昔每次请求。

## 7. 模块修改地图

| 范围 | 必改或检查的代码 | 决定 |
|---|---|---|
| Agent 主链 | `src/agent/{loop,context,projection,composer}.ts` | 分离历史视图；唯一 Composer；移除旧全请求改写；声明工具一次收口 |
| 类型与端口 | `src/core/types.ts`、`src/runtime/{hooks,guard,noop,events}.ts` | History View / inspection 合同；删旧 Hook/账本；保留独立执行钩子 |
| Extension Runtime | `src/extensions/{host,runner,runtime-hooks}.ts` | 单一 History View 提供者；保留 Context Registry/Scope；移除 `prepare/transform/tail` |
| Context/Prompt 基础 | `src/extensions/{context-registry,prompt-compiler,loader}.ts` | **原则上不动**；只在迁移实际需要时修小缺陷 |
| Compaction | `src/extensions/compaction/index.ts` | 使用明确 History View、完整预算；不重写 Checkpoint/摘要 |
| Worlds | `src/extensions/world-framework/{types,world-activation}.ts`、Minecraft `worlddef` | World Source 的作用域薄转发；删除专用 Environment Guide Hook |
| MCP | `.uina/extensions/mcp/index.ts` | Service Index → 简短 Capability；保留 Proxy/Manager |
| Voice/TTS | `.uina/extensions/voice/{index,perception}.ts`，必要的 TTS 服务连接 | 内部未解决事实 → Observation；删除尾帧与消费账本 |
| Event Frame | `src/extensions/event-frames/{index,projection,protocol}.ts` | 保留历史协议；修正旧路径描述/使用者 |
| Provider | `src/ai/{gateway,providers}.ts` | 去掉公共 payload 变换旁路，保留 Adapter 与实际 Wire 观察 |
| 请求检视 | `src/session/prompt-snapshots.ts`、`src/{presentation,ui,cli,host}` 对应消费者 | 删除旧快照链，`/prompt` 消费既有实际请求/预览 |
| 示例、测试与开发脚本 | `examples/extensions/{skills,custom-compaction}`、`tests/helpers/memory-capability.ts`、`.uina/worlds/minecraft/dev/{native-host,i2}.ts` | 只演示现役 Source / History View；保留验收模式的工具可见性约束；无旧完整请求改写 |
| 文档 | `README.md`、`CONTEXT.md`、`docs/{current-runtime,extensions,extensions-development}.md` 及现役测试说明 | 新接口成为唯一推荐合同；归档文件不做无谓历史重写 |

## 8. 实施顺序与发布门

### S0 — 固定基线和真实覆盖

核对最新 HEAD 与 Prompt 文件机制提交，记录新/旧 API 的全部仓内引用（`src/`、`.uina/` 含 `dev/`、`examples/`、`tests/`、现行 docs）。重点列出每个 `turn.transformContext` 的**实际用途**（压缩、状态注入、工具筛选、测试观测），不按符号名盲迁移。先运行项目真实基线的 typecheck/test；记录既有失败，不把环境故障包装成重构缺陷。依赖 Package Scripts，勿臆造命令或测试结果。

### S1 — Context Source 生产者迁移

先处理 World/Minecraft、MCP，再处理 Voice，最后迁移 Skills 示例和 Memory Fixture。并记录 Minecraft `dev/` 的工具筛选/请求观测依赖，为 S3 删除旧 Hook 提前准备等价的验收脚本接线。每个迁移完成后用真实 `inspectRequest` 和端到端 Model Request 验证 Source 唯一性、身份、内容、卸载及 Reload。此阶段可短暂保留旧 Hook 以便分步验证，**最终不能双写或留下并行注入**。

### S2 — History View / Compaction 接线

新增单一所有者 History View、连通 Host/Runner/RuntimeHooks/Subject。Compaction 改为只读历史投影，Stage 从明确 History 规划边界，预算预留所有非历史部分。验证手动/自动/超预算/重建/Checkpoint 恢复、Event Frame 和工具对；之后删除 `splitGuidancePrefix` 与运行时临时消息过滤等补丁。

### S3 — 删除旧公共注入通道

先迁移 Minecraft `dev/` 的两条工具筛选调用及所有测试专用消费者，再一次性从类型、API、运行时、Subject、扩展及测试中移除 `turn.prepare`、`turn.transformContext`、`tail`、`beforeMessages` 和相关 Ledger；消除重复工具定义合并。确认生产代码无法再经普通扩展接口任意改写 System、Messages、Tools。保留 Preflight/AfterEnd/ShouldStop 与 Tool 原有独立语义。

### S4 — Provider / UI / Event Frame 收口

删除无消费者的公共 `provider.transformPayload`；简化 Wire Observation。修正 Event Frame 说明和错误提示。删除旧 Prompt Snapshot 事件/辅助记录消费者/卡片链，接通 `/prompt` 最新实际请求与预览。只清理直接依赖，不展开 Session/Presentation 框架重构。

### S5 — 统一回归与彻底清理

覆盖三类 Provider 的真实 Wire 结构、特殊开场历史、长历史压缩、动态 Source、Scope 卸载/Reload、Rewind、旧 Session 恢复。删除旧测试，而不是保留断言旧接口存在的“兼容测试”；替换为等价的现役行为测试。更新现行文档；全仓检查已删除名称无**现役引用**，不能靠空实现维持构建通过。

## 9. 必须通过的验收矩阵

| 编号 | 验收条件 |
|---|---|
| A01 | `System → 至多一条 Guidance User → History → Runtime Context`；文件与内联 Guidance 共用唯一 Composer，顺序稳定、不入 Journal。 |
| A02 | 同一 Source 同一请求最多贡献一次，Trace 的 owner/id、messageIndex、offset 与实际语义请求一致；卸载/Reload 无旧贡献残留。 |
| A03 | 新旧注入不得并存；没有生产者再调用 `turn.prepare/turn.transformContext/tail`；公开类型和 Runner 不保留空旧接口。 |
| A04 | `History View` 只接收历史；Compaction 不扫描 System/Guidance/Runtime Source 以猜出历史，历史摘要不含固定/动态信息。 |
| A05 | 自动压缩 `preflight` 重建后完整请求在预算内；固定指南/动态状态过大而历史不可压缩时明确失败，不造无效 Checkpoint。 |
| A06 | Compaction 的 Checkpoint 恢复、手动命令、Rewind、长历史、Tool Call/Result、Event Frame 原子性和 thinking replay 均保持正确。 |
| A07 | Minecraft 启动、连接、断开、停用和重新启用时，模型所见指南/资格状态与事实一致；任务完成通知仍可靠交付。 |
| A08 | MCP 原全局服务索引范围不被无意扩大到未信任项目配置；有配置但未启动时描述为“已配置”；Proxy 查询/连接、权限、按需发现不受影响，信息不重复。 |
| A09 | Voice `inspectRequest()` 不清除事实；同一真实 `causeRef` 不重复堆积；无 `causeRef` 的中断/失败不被错误归并或永久滞留；真实解决或业务终止后不再出现；不会因普通音频状态变化无意义唤醒主体。 |
| A10 | Skills 示例只暴露轻量目录，完整 Skill 按需读取；Memory Fixture 只显示一次同一事实，Auxiliary 与 Rewind 正确。 |
| A11 | 历史真实外部输入仍按正确来源呈现；Event Frame 合成工具只在需要时声明且不能被模型实际调用；OpenAI、Anthropic、Gemini 均保持有效角色/配对。 |
| A12 | `tools.transformResult` 的 canonical/modelView 及 JSONL replay 仍可对账；工具内容不被重新经 Context Source 注入。 |
| A13 | 无通用 `provider.transformPayload` 业务注入旁路；Wire 摘要对应最终序列化的待发送载荷，requestId 与活动语义请求可关联；不把“已编码”虚称为 HTTP 已成功发送。 |
| A14 | `/prompt` 通过真实 Host 只读端口显示最近准备的语义请求、Source、工具及可用 Wire 摘要；无请求记录时显示明确的 Preview；不虚称发送成功，不误称历史 Prompt Snapshot 是实际请求。 |
| A15 | 旧 `uina.prompt.snapshot` 记录不再新写或作为运行时依据；既有 Session 可打开；其他 External Input Card、Compaction Decoration 和 Presentation 功能不受影响。 |
| A16 | 全量 typecheck、相关单测与端到端测试按项目现有脚本运行；`.uina/worlds/minecraft/dev/` 的真服验收工具限制仍有等价测试路径；不存在因兼容而留下的死代码、重复 Composer、第二套 Registry、未被使用的新 Hook。 |

关键反例测试：

1. 有固定 Guidance + 很长 History + 动态 Observation 时自动压缩；摘要只来自历史，二次装配不重复，最终预算通过。
2. 仅固定 Guidance 和动态内容超出窗口、History 几乎为空；明确失败，不删除指南/最新输入，不伪造成功压缩。
3. OpenAI/Anthropic/Gemini：固定 Guidance User 后接第一条外部事件及之后的工具对；允许 Provider 合并相邻 User 文本，但不丢来源标识，不创造新 Assistant 回合。
4. Voice：有 `causeRef` 的失败 → Preview → 实际请求 → 状态对账/恢复；以及**无 `causeRef` 的中断和未知交付**。Preview 不消费，真正未解决的事实保持可见，但一次性事实和无回调的已终结故障不会无限残留。
5. World 与项目扩展热重载交错进行；旧 Source 不复活，新 World Source 没有冲突/泄漏，重新激活仅注册一次。
6. 老 Session 含旧 Prompt Snapshot 和 Compaction Checkpoint；可恢复主线、回溯和新请求，且不会重新注入旧 System 文本。
7. Minecraft `dev/native-host.ts` 与 `dev/i2.ts` 的真模型验收：请求仅暴露 `minecraft` 工具，工具调用和结果仍可核对；移除旧 Transform 后测试语义不退化。
8. Provider 请求已通过 Preflight 但在 Wire 编码或 HTTP 前失败：`/prompt` 仍准确标注请求准备状态，不宣称交付成功。

## 10. 完成定义与范围约束

交付须同时满足：**所有真实生产者已经迁移、旧普通注入 Hook 已从公共合同删除、Compaction 只形塑历史、最终请求只有一条正常装配路径、旧 Prompt 检视不再提供错误权威性**。代码、测试和现行文档描述同一套行为。

不以新增抽象数量、覆盖测试数量或重写代码规模衡量成功；能通过组合现有 Source、History、Delivery、Tool 与 Provider 实现的能力，不再创造专属 Context 管理器。涉及 Minecraft 动作执行、Voice 播放、MCP 管理、Session 数据模型和一般 UI 框架的非信息注入问题，明确留在本任务之外。
