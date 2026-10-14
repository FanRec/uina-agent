# 接缝清单：Pi vs Uina

状态：清点完成（2026-09-17）。Pi 侧全部对照 `E:/Uina/ThirdParty/pi` 源码核实（agent.ts L100–200、extensions/types.ts 事件逐字提取）；Uina 侧对照本仓 src/ 源码。用途：接缝设计对照档案，供"直接接缝"风格学习与 Core 演进参考。

**类别图例（全文统一）**

| 标记 | 含义 |
|---|---|
| 替换 | 可改写/接管核心行为（返回值或原地改写即生效） |
| 拦截 | 可短路/否决（cancel / block / stop） |
| 注入 | 注册新能力（工具/命令/模型/渲染器/消息/条目） |
| 观察 | 只读，无返回效果 |

---

## 1. 总览

| 维度 | Pi | Uina |
|---|---|---|
| Core 回调钩子 | 9 个，AgentOptions 直挂 | 9 个，RuntimeHooks 契约（guard 冻结隔离） |
| Core 事件 | 10 种，全部观察，无 before_* 变体 | 27 变体，全部观察（干预走钩子/事件双通道） |
| 扩展事件 | 36 个（15 干预型 + 21 观察型） | 28 种（27 RuntimeEvent + 扩展层 input） |
| 扩展注册 API | 9 类 register* | 13 类 register* |
| 动作 API | sendMessage/appendEntry/compact/setModel/fork/navigateTree… | submitInput/sendMessage/appendEntry/compact/callTool/callService… |
| 存储可插拔 | Session 接口 + conformance 测试套件 | SessionStore 接口 + Memory/Jsonl 两实现 |
| 后端级替换 | BashOperations 等操作层、registerApiProvider | registerTool replace（工具整体）、AgentFactory |
| 主题/键位 | JSON 文件 + 注册表 | 硬编码（不可插拔） |
| 包管理 | npm/git 自动装扩展 + project_trust | 无 |
| RPC/Server | CBOR protocol + RPC 30+ 命令 | 无独立 server 包 |

---

## 2. Pi 接缝全清单

### 2.1 Agent 构造回调（packages/agent/src/agent.ts L100–200）

| 接缝 | 触发时机 | 语义 | 类别 |
|---|---|---|---|
| `initialState` | 构造 | 初始 systemPrompt/model/thinkingLevel/tools/messages | 替换 |
| `convertToLlm` | 每次 LLM 调用前 | AgentMessage→LLM Message 整体投影（过滤/改写/custom 转 user） | 替换 |
| `transformContext` | 每次 LLM 调用前 | 整体改写上下文（裁剪/注入） | 替换 |
| `streamFn` | 每次 LLM 调用 | 整个流式调用函数；禁 throw，失败编码为 stopReason | 替换 |
| `setDefaultStreamFn` | 宿主安装 | 安装默认 StreamFn（sdk.ts 注册缺省用） | 替换 |
| `getApiKey` | 每次 LLM 调用前 | 动态 API key（OAuth 场景） | 替换 |
| `onPayload` | 请求体发送前 | 返回非 undefined 即替换整个 provider 请求体 | 替换 |
| `onResponse` | HTTP 响应后 | 观测 status/headers（消费 body 前） | 观察 |
| `beforeToolCall` | 工具执行前 | `{block?, reason?, terminate?}` 阻断执行 | 拦截 |
| `afterToolCall` | 工具执行后 | 按字段覆盖 content/details/isError/usage/terminate | 替换 |
| `shouldStopAfterTurn` | turn 完全结束后 | 返回 true 优雅收尾（不再 poll 队列） | 拦截 |
| `prepareNextTurn(+WithContext)` | turn_end 后 | 替换下回合 context/model/thinkingLevel（自动压缩用此实现） | 替换 |
| `steeringMode` / `followUpMode` | 队列 drain | `"all" \| "one-at-a-time"` | 配置 |
| `state.tools` / `state.messages` setter | 运行中 | 随时替换工具集/转录 | 替换 |
| `subscribe` | 每个事件 | 按序 await；listener 计入 run 结算 | 观察 |
| `runAgentLoop(AgentLoopConfig)` | 宿主自建 | 低层循环，钩子与上表一一对应 | 替换 |

### 2.2 扩展事件（pi.on()，36 个）

**干预型（15 个，带结果协议）**

| 事件 | 结果协议 | 类别 |
|---|---|---|
| `project_trust` | `{trusted, remember?}` 接管信任决策 | 替换 |
| `resources_discover` | `{skillPaths?, promptPaths?, themePaths?}` 追加资源路径 | 替换 |
| `session_before_switch` | `{cancel?}` | 拦截 |
| `session_before_fork` | `{cancel?, skipConversationRestore?}` | 拦截 |
| `session_before_compact` | `{cancel?, compaction?}` 返回完整 CompactionResult = 整个接管压缩 | 替换/拦截 |
| `session_before_tree` | `{cancel?, summary?, replaceInstructions?, label?}` 接管分支摘要 | 替换/拦截 |
| `context` | `{messages?}` 链式改写上下文 | 替换 |
| `before_provider_request` | 返回值即整个请求体（unknown） | 替换 |
| `before_provider_headers` | 原地 mutate，null 删除该头 | 替换 |
| `before_agent_start` | `{message?, systemPrompt?}` 链式（后写覆盖） | 替换 |
| `message_end` | `{message?}` 替换最终消息并同步持久化 | 替换 |
| `tool_call` | `{block?, reason?, terminate?}`；原地改 `event.input` 改参数（无再校验） | 拦截 |
| `tool_result` | `{content?, details?, isError?, usage?}` | 替换 |
| `user_bash` | `{operations?, result?}` 自定义 bash 后端或全量接管 | 替换 |
| `input` | `{transform, text, images?}` 或 `{handled}` 转换/吞掉输入 | 替换 |

**观察型（21 个）**

| 事件 | 载荷要点 |
|---|---|
| `session_start` / `session_info_changed` / `session_shutdown` | reason: startup/reload/new/resume/fork |
| `session_compact` / `session_compact_failed` | 压缩结果/错误 |
| `session_tree` | 分支导航完成 |
| `after_provider_response` | status/headers |
| `agent_start` / `agent_end` / `agent_settled` | end 带 willRetry |
| `ui_prompt_start` / `ui_prompt_end` | 阻塞式 UI 提示计数 |
| `turn_start` / `turn_end` | — |
| `message_start` / `message_update` | update 仅 assistant 流式期间 |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | args/partialResult/result |
| `model_select` / `thinking_level_select` | — |

core 层 `AgentEvent` 10 种（`agent_start/agent_end/turn_start/turn_end/message_start/message_update/message_end/tool_execution_start/tool_execution_update/tool_execution_end`）全部观察，**无 before_\* 阻断变体**——干预全部走回调。AgentSession.subscribe 另有增量观察事件：`queue_update/entry_appended/auto_retry_start/end/summarization_retry_*/bash_execution_update`。

### 2.3 扩展注册 API（pi.\*）

| 方法 | 语义 | 类别 |
|---|---|---|
| `registerTool(tool)` | 注册工具（运行时自动 refreshTools） | 注入 |
| `registerCommand(name, {getArgumentCompletions?, handler})` | `/name` 斜杠命令 | 注入 |
| `registerShortcut(key, {handler})` | 全局快捷键（17 个保留键不可抢占） | 注入 |
| `registerFlag(name, {type, default?})` + `getFlag` | CLI 标志注入 | 注入 |
| `registerProvider(provider \| name, config)` / `unregisterProvider` | 注册模型提供方；config 支持 `streamSimple`（替换 API 流实现）、`oauth{name,login,refreshToken,getApiKey}`、`$ENV`/`!command` apiKey | 注入/替换 |
| `registerMessageRenderer(customType, renderer)` | 自定义消息 TUI 渲染 | 注入 |
| `registerEntryRenderer(customType, renderer)` | 自定义会话条目渲染（不进 LLM 上下文） | 注入 |
| `registerMarkdownTransformer(fn)` | Markdown 渲染链改写 | 替换 |
| `events: EventBus` | 任意频道 emit/on（扩展间通信） | 观察 |

### 2.4 扩展动作 API（pi.\*）

| 方法 | 语义 |
|---|---|
| `sendMessage(msg, {deliverAs: "steer"\|"followUp"\|"nextTurn", triggerTurn?})` | 注入 custom 消息，三条投递路径 |
| `sendUserMessage(content, {deliverAs?, expandPromptTemplates?})` | 注入用户消息 |
| `appendEntry(customType, data?)` | 持久化条目，不进上下文 |
| `setModel` / `setThinkingLevel` / `getThinkingLevel` | 模型纪律 |
| `getActiveTools` / `getAllTools` / `setActiveTools` / `getCommands` | 工具面控制 |
| `setSessionName` / `getSessionName` / `setLabel(entryId, label?)` | 会话元数据 |
| `exec(command, args, options?)` | 执行命令 |

### 2.5 事件上下文（ctx.\*）

| 组 | 成员 |
|---|---|
| 环境 | `ui` / `mode("tui"\|"rpc"\|"json"\|"print")` / `hasUI` / `cwd` / `signal` / `abort()` |
| 会话 | `sessionManager`(只读) / `isIdle()` / `hasPendingMessages()` / `shutdown()` |
| 模型 | `modelRegistry` / `model` / `scopedModels` / `thinkingLevel` / `isProjectTrusted()` |
| 上下文 | `getContextUsage()` / `compact({customInstructions?, onComplete?, onError?})` / `getSystemPrompt()` |
| 命令独有 | `waitForIdle` / `newSession({parentSession?, setup?, withSession?})` / `fork(entryId, {position?, withSession?})` / `navigateTree(targetId, {summarize?, …})` / `switchSession(path, {withSession?})` / `reload()` |

### 2.6 UI 接缝（ctx.ui.\*）

| 方法 | 语义 | 类别 |
|---|---|---|
| `select` / `confirm` / `input` | 对话框 | 注入 |
| `notify` / `setStatus` / `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator({frames?, intervalMs?})` / `setHiddenThinkingLabel` / `setTitle` | 状态区 | 注入 |
| `setWidget(key, item, {placement: "aboveEditor"\|"belowEditor"})` | 小部件槽 | 注入 |
| `setFooter` / `setHeader` | 自定义顶/底组件 | 替换 |
| `custom(factory, {overlay?, onHandle?})` | 自定义区域/overlay（snake、space-invaders 示例） | 替换 |
| `onTerminalInput(handler)` | 原始按键拦截 `{consume?, data?}` | 替换 |
| `pasteToEditor` / `setEditorText` / `getEditorText` / `editor(title, prefill?)` | 编辑器操作 | 注入 |
| `addAutocompleteProvider` | 补全源叠加 | 注入 |
| `setEditorComponent` / `getEditorComponent` | 编辑器组件整体替换 | 替换 |
| `getTheme` / `setTheme` / `getAllThemes` | 主题 | 替换 |
| `getToolsExpanded` / `setToolsExpanded` | 展示开关 | 配置 |

其他 UI 面：`CustomEditor` 可继承基类（super.handleInput 保留应用键）；SDK 导出 25+ 组件类与 renderDiff/highlightCode/Theme 工具；主题 JSON（`~/.pi/agent/themes/`、`.pi/themes/`）；`KeybindingsManager`（keybindings.json，36 个 app.\* 动作）。

### 2.7 工具接缝

| 接缝 | 语义 | 类别 |
|---|---|---|
| `AgentTool.execute(toolCallId, params, signal, onUpdate)` | 工具本体；onUpdate 流式部分结果 | 注入 |
| `prepareArguments` | 校验前参数垫片 | 替换 |
| `executionMode` | sequential/parallel 覆盖 | 声明 |
| `AgentToolResult.addedToolNames` | 结果动态引入新工具（循环自动回填） | 注入 |
| `AgentToolResult.terminate` | 全批 true 提前终止循环 | 拦截 |
| `ToolDefinition.renderCall/renderResult/renderShell:"self"` | 自定义工具卡片渲染 | 替换 |
| `createReadTool/createBashTool/createEditTool/…` + `baseToolsOverride` | 内置工具工厂 SDK 导出，整体替换工具集 | 替换 |
| `BashOperations/ReadOperations/EditOperations/WriteOperations/GrepOperations/FindOperations/LsOperations/PowerShellOperations` | 内置工具执行后端整体替换（ssh.ts 远程代理） | 替换 |
| `BashSpawnHook(ctx)→ctx` | 进程 spawn 上下文替换（sandbox 示例） | 替换 |
| `withFileMutationQueue` | 文件写互斥 | 组合 |
| 权限/确认 | 无内建；由 tool_call 事件/beforeToolCall 实现（permission-gate.ts 等） | — |

### 2.8 Provider/AI 层

| 接缝 | 语义 | 类别 |
|---|---|---|
| `Provider<TApi>` 接口 | 实现即新增 provider（stream/streamSimple/getModels/refreshModels/auth） | 替换 |
| `Models.setProvider/deleteProvider/clearProviders` | 运行时替换集合 | 替换 |
| `createModels({credentials?, modelsStore?, authContext?})` | 凭据/目录存储依赖注入 | 替换 |
| `registerApiProvider({api, stream, streamSimple})` | 替换任意 api id 的流实现（11 内置，扩展优先于内置） | 替换 |
| `registerFauxProvider` / `unregisterApiProviders` / `resetApiProviders` | 测试/卸载 | 替换 |
| `ModelsRequestTransforms.transformHeaders` | 最终请求头替换 | 替换 |
| `StreamOptions.onPayload` / `onResponse` | 请求体替换 / 响应观测（每请求粒度） | 替换/观察 |
| `refreshModels(context)` + `context.publish({persist, update})` | 动态模型目录发布 | 替换 |
| `models.json` 三层叠加 | 内置 → models.json → 扩展（modelOverrides 最高） | 替换 |
| `ModelsStore` 接口 | 目录持久化后端可插拔 | 替换 |
| `ProviderConfig.oauth` | provider 自带 OAuth | 替换 |

### 2.9 持久化与压缩

| 接缝 | 语义 | 类别 |
|---|---|---|
| `CustomAgentMessages` declaration merging | 声明合并新增消息 role（开放联合） | 注入 |
| `SessionEntry` 9 种 | message/thinking_level_change/model_change/compaction(details?, fromHook?)/branch_summary/custom/custom_message/label/session_info；JSONL v3 + 迁移器 | — |
| `SessionManager` 静态工厂 | create/open/continueRecent/inMemory/forkFrom/list | 替换 |
| Harness `Session` 接口 | jsonl/memory 内置 + conformance 一致性测试套件 | 替换 |
| `operation_started.resumeData{[extensionId]}` | 扩展私有恢复数据 | 注入 |
| 压缩五路 | ①session_before_compact 接管 ②ctx.compact() 编程触发 ③默认 summarizer 接收 streamFn（可换模型）④prepareNextTurn 阈值压缩 ⑤CompactionSettings{enabled, reserveTokens, keepRecentTokens} | 替换 |
| 分支摘要 | session_before_tree 可接管 | 替换 |

### 2.10 数据驱动资源与配置

| 资源 | 位置与格式 |
|---|---|
| Skills | SKILL.md + frontmatter；`.pi/skills/` + `~/.pi/agent/skills/` + `.agents/skills/`；`/skill:name` 展开 |
| Prompt templates | `.pi/prompts/*.md`；`$1/$@/${N:-default}` 参数替换 |
| Themes | JSON；`~/.pi/agent/themes/` + `.pi/themes/` |
| 项目上下文 | AGENTS.md → `<project_context>` 注入 |
| 系统提示 | `customPrompt` 整体替换 / `appendSystemPrompt` 追加 / `.pi/SYSTEM.md` |
| settings.json | global + project；SettingsStorage 可换存储；defaultTools/steeringMode/compaction/retry/packages |
| 包管理器 | settings `packages`（npm/git/local）自动装扩展/skills/prompts/themes |
| 扩展发现 | `cwd/.pi/extensions/` → `~/.pi/agent/extensions/` → CLI/settings 显式路径；`pi.extensions` 清单 |
| 实验开关 | `PI_EXPERIMENTAL=1` |

### 2.11 Server / Protocol

| 接缝 | 语义 |
|---|---|
| CBOR 帧 + `PROTOCOL_VERSION=1` | 传输编码与握手（ClientHello/ServerHello） |
| 命令 9 个 | list/create/attach/detach/prompt/steer/abort/set_model/set_thinking |
| 服务端推送 4 事件 | server_snapshot/session_snapshot/session_progress/session_removed |
| 传输可扩展 | Unix socket preset；listener.ts 可扩展其他传输 |
| coding-agent RPC 模式 | RpcCommand 30+（compact/fork/clone/get_tree/export_html/bash/扩展 UI 透传——远程客户端可代替 TUI 应答扩展对话框） |

---

## 3. Uina 接缝全清单

### 3.1 RuntimeHooks（src/runtime/hooks.ts）

| 接缝 | 触发时机 | 语义 | 类别 |
|---|---|---|---|
| `provider.transformHeaders` | 出站前 | 改写请求头（gateway.ts 每请求执行，重试每轮） | 替换 |
| `provider.transformPayload` | 出站前 | 改写整个请求体 | 替换 |
| `provider.observeResponse` | 响应后 | 审计 status/headers | 观察 |
| `turn.prepare({prompt, systemPrompt})` | 回合边界 | 返回 `{messages?, systemPrompt?, model?, thinkingLevel?}`；model 经 applyPreparedRuntime 以 setModel 完整纪律应用 | 替换 |
| `turn.transformContext(messages)` | 每请求前 | 链式整体改写上下文 | 替换 |
| `turn.beforeCompact({tokensBefore})` | 压缩前 | `{cancel?}` 取消压缩 | 拦截 |
| `turn.shouldStop({finishReason, toolCallCount, …})` | 工具续跑点 | `{stop?}` 收尾本运行 | 拦截 |
| `tools.beforeCall({callId, name, args})` | 工具执行前 | `{block?, reason?}` 短路 | 拦截 |
| `tools.transformResult(…)` | 工具执行后 | `{result?, status?, images?, details?}` 改写结果 | 替换 |
| `events.emit / observe / flush` | 事件出口 | RuntimeEvent 出口 / 4 类 output 流式专用通道 | 观察 |

配套：`NO_RUNTIME_HOOKS`（no-op 默认）、`guardRuntimeHooks`（输入深冻结、返回值克隆接管）。

### 3.2 RuntimeEvent（src/runtime/events.ts，22 变体，全观察）

P1a 删 7 个干预形状变体（before_agent_start/context/session_before_compact/turn_should_stop/provider 三件套）退出事件流；P1b 并入 custom_message/custom_entry。

| 组 | 事件 |
|---|---|
| 会话/回合（9） | `session_rewind`（自带 entries）`agent_start` `agent_end` `agent_settled` `turn_start` `turn_end` `turn_aborted` `queue` `error` |
| 模型/压缩（4） | `model_select` `thinking_level_select` `session_compact` `session_compact_failed` |
| 工具（2） | `tool_call` `tool_result`（只带 callId，计时由消费者自算） |
| durable 事实（2） | `custom_message` `custom_entry`（Subject 落盘后自行广播） |
| 输出/用量（5） | `output_start/update/end/interrupted`（OutputEvent，只走 observe）`usage_update` |

### 3.3 ExtensionHost 干预链（src/extensions/host.ts，P1a 起为 Hook 专属词汇）

| 链（run* / onHook 键） | 结果协议 | 类别 |
|---|---|---|
| `runTurnPrepare` / `turn.prepare` | `{messages?(聚合追加), systemPrompt?(后写覆盖), model?, thinkingLevel?}` | 替换 |
| `runTransformContext` / `turn.transformContext` | `{messages?}` 链式 | 替换 |
| `runBeforeCompact` / `turn.beforeCompact` | `{cancel?}` 任一取消即取消（**无接管**，P2 裁定冻结不扩约） | 拦截 |
| `runShouldStop` / `turn.shouldStop` | `{stop?}` 任一 stop 即收尾 | 拦截 |
| `runBeforeCall` / `tools.beforeCall` | `{block?, reason?}` 任一 block 短路 | 拦截 |
| `runTransformResult` / `tools.transformResult` | `{result?, status?, images?, details?}` 逐字段覆盖 | 替换 |
| `runTransformHeaders` / `provider.transformHeaders` | 头改写，整组替换 | 替换 |
| `runTransformPayload` / `provider.transformPayload` | 请求体改写，整组替换 | 替换 |
| `runObserveResponse` / `provider.observeResponse` | 无返回值 | 观察 |
| `on(type)` | type = RuntimeEvent 事实事件名（干预不收） | 观察 |
| `onError` / `emit` / `emitObserved`（保证 start→update→end 顺序）/ `flush` | 基础设施 | 观察 |

registerContextContributor 第三注入路径已退役（P2，见 §5.1 #2）；回合注入收敛为 prepare（回合边界）+ transformContext（每请求）两条。

### 3.4 ExtensionAPI（pi.\*，src/extensions/runner.ts）

| 方法 | 语义 | 类别 |
|---|---|---|
| `registerTool(tool, {replace?})` | 注册工具（run 经 scope 包装：卸载后 not_started、取消后 unknown） | 注入 |
| `callTool(name, args, {signal?})` | 以 scoped view 主动执行工具（审计 extension.tool 条目） | 注入 |
| `registerService/callService/hasService` | 类型化命名服务总线（structuredClone 隔离出入参） | 注入 |
| `registerCompactor(compactor, {replace?, shouldCompact?})` | 压缩器（唯一槽位 `"compaction"`；undefined=委托默认算法；P2 裁定冻结不扩约） | 替换 |
| `compact(instruction?)` | 编程触发手动压缩 | 动作 |
| `models.{current, list, groups, resolve, select, stream, thinkingLevel, setThinkingLevel}` | 模型访问与调用档位（stream 自动附 providerHooks；P2 增 groups/thinkingLevel/setThinkingLevel） | 注入/动作 |
| `usage / isBusy / reload / shutdown` | 主体用量与忙闲事实；扩展重载与消费者关闭（P2 增，官方命令降为纯扩展的支撑面） | 观察/动作 |
| `registerProvider` / `registerModel` | 注册通信端点/模型规格 | 注入 |
| `registerCommand` | 斜杠命令 | 注入 |
| `registerMessageRenderer` / `registerEntryRenderer` / `registerToolRenderer` / `registerMarkdownTransformer` | 渲染链四类 | 注入/替换 |
| `sendMessage(CustomMessage)` | 追加进上下文的自定义消息 | 注入 |
| `appendEntry(CustomEntry)` | 仅持久化/展示，不进上下文 | 注入 |
| `submitInput(input)` | 向宿主提交输入 | 动作 |
| `session.{list, read, requestRewind}` | 会话查询与回溯请求 | 动作 |
| `reportError` / `on(type)` / `signal` / `ui` | 附属 | 观察 |

生命周期：default 导出 `activate(pi) → void\|Teardown`；ResourceScope（own/ownKeyed/setDispose + pending 追踪，deactivate 倒序清理，register\* 返回的 disposer 自动入 scope）。

### 3.5 工具接缝（src/tools/broker.ts、pipeline.ts、task-tool.ts）

| 接缝 | 语义 | 类别 |
|---|---|---|
| `ToolBroker.register(tool, {replace?})` | Ajv 校验注册；重名未 replace 抛错 | 注入 |
| `Tool.executionMode` | parallel/sequential（任一 sequential 整批串行） | 声明 |
| `ToolExecutionResult.continuation:"stop"` | 工具主动终结决策（队列保留） | 拦截 |
| `ToolExecutionContext{ownerId, callerId?}` | 调用者与注册者解耦（所有权） | — |
| `createOwnedTool` | 受管任务工具构建器 | 注入 |
| `ScopedToolView{include?, exclude?}` | 白/黑名单过滤（子代理权限） | 替换 |
| `executeToolPipeline` 六步 | beforeCall 拦截→校验→onStart→执行→transformResult→onDone | — |
| `details.effects`（ToolEffect） | 通用效果事实（file.write/command.exec/task.dispatch），core/effects.ts 唯一读取点 | 声明 |

### 3.6 模型 / Provider（src/core/types.ts、src/ai/providers.ts）

| 接缝 | 语义 | 类别 |
|---|---|---|
| `ModelStreamFn` | Subject 构造第二参，最小流注入点 | 替换 |
| `Provider{id, refreshModels?, stream}` | 自定义 provider 只需实现 stream | 替换 |
| `ModelRegistry.{registerProvider, registerModel, register, resolve, stream, refreshModels, groups/choices}` | 注册表：注册表→复合键→动态发现三级解析 | 注入 |
| `StreamDelta` 7 种 | 含 `provider_replay` 不透明回放块 | — |
| `Model` 纯数据规格 | contextWindow/maxContextWindow/thinkingLevels/thinkingBudgets/compat | — |
| `loadConfig()` | `~/.uina/auth.json`（UINA_HOME 覆盖） | 配置 |
| settings.json | modelKey + thinkingLevel 持久化（host 监听 model_select 落盘） | 配置 |
| `subject.setModel` / `applyPreparedRuntime` | 换模型完整纪律（usage 锚失效+clamp+广播） | 动作 |

### 3.7 会话 / 持久化（src/session/）

| 接缝 | 语义 | 类别 |
|---|---|---|
| `SessionStore` 接口（11 方法） | path/readRecords/appendRewind/appendInput/appendMessage/appendCustomMessage/appendCustomEntry/appendCompaction/appendEvent/close | 替换 |
| `SessionRecord` 8 种 | header/rewind/input/message/custom_message/custom_entry/compaction/event | — |
| `SessionEventName` 封闭枚举 7 个 | queue_enqueued/queue_consumed/queue_restored/tool_started/tool_finished/turn_failed/turn_aborted（data 开放、名字不可扩展） | — |
| `custom_message` / `custom_entry` | 进上下文 / 仅持久化展示 | 注入 |
| `createSessionAccess(store, rewind?)` | SessionAccess 组合视图（回溯安全点归 Subject） | 替换 |
| `MemorySessionStore` / `openJsonlSession` | 内置两实现（嵌入/测试接缝） | — |
| 回溯契约 | RewindRequest/Result、safeTargets（CanonicalState 增量派生查询，P3 收编，isSafeRewindTarget/safeRewindTargets 第二 walker 已删）、checkRecord/applyRecord/reduceRecord/canonicalReplay（单 reducer 两相；P3b 起 replay 零合成：ensureSettled 拒绝未决期间的事实记录，恢复只能经 planRecovery 落盘）、planRecovery（crash 结算纯函数，稳定身份 recovered:\${originId}:\${callId}，带身份落盘；recoverRecords 结算解释视图已随 fold 合成机制删除）、projectAgentHistory/protectRewindContext/summarizeAbandonedEffects、ProjectionPolicy（P3c：projectHistory/convertToLlm 经 SubjectOptions.projection 可注入，Replacement 单 owner=Subject 实例，resolveProjectionPolicy 解析默认；先只做测试双实现，P4 起经 UinaHostOptions.projection 组合根注入） | — |

### 3.8 压缩

| 接缝 | 语义 | 类别 |
|---|---|---|
| `Compactor = (request, signal) => proposal \| undefined` | undefined = 显式委托默认算法 | 替换 |
| `CompactionTrigger = (check) => boolean \| undefined` | 同步策略检查（prepare 路径禁网络） | 替换 |
| 注册两路 | SubjectOptions.compactor/compactionTrigger；pi.registerCompactor | 注入 |
| `CompactionSettings` + DEFAULT | reserveTokens 16_384 / keepRecentTokens 20_000 | 配置 |
| `resolveCompactionResult` | proposal 与默认算法的唯一裁决点（主回合与回溯共用） | — |
| `findCutPoint` | 回合边界切点，绝不切断工具对 | — |
| 调用点三处 | prepareTurn 体检 / manual compact / 回溯投影预压缩 | — |
| 事件 | beforeCompact（拦截）/ session_compact / session_compact_failed | 观察 |

### 3.9 宿主注册表与服务（src/host/host.ts、extensions/）

| 注册表 | 接缝 |
|---|---|
| `UinaHostOptions` | cwd/extensionPaths/workspaceTools/sessionPath/provider/model/modelName/stream/thinkingLevel/projection（P4：投影 Replacement 缝经组合根注入 Subject）/onError |
| `HostStartOptions` | requestShutdown（ui 已随 BuiltinUI 并入 pi.ui 删除，P2） |
| 输入面 | send / submitText（direct→steer 升级唯一归属）/ pushInput / interrupt / resumePending / claimAllQueued / claimQueued(id)（mailbox claim 原语，"取回编辑器"语义在 UI 组合）/ runToolDirect |
| 观察面 | subscribe（HostEvent = RuntimeEvent 1:1 透传 + notice，P1b 起翻译词表退役）/ snapshot / restoredEntries |
| ~~`BuiltinServices` / `BuiltinUI`~~ | 已退役（P2，inventory #5#6）：官方命令与项目扩展同一张 pi.\* 面；消费者富 UI 能力为 ExtensionUIContext 可选成员 |
| `JobRegistry` | start(JobSpec→JobHandle)/list/get/read/wait/cancel/onChanged/onResolved/maxActivePerOwner + job_* 3 工具 |
| `SubagentRegistry` | start/session(id)/list/get/read/transcript/send/acceptInput/interrupt/close；Options{factory:AgentFactory, createTools, notify} 全注入 + subagent_* 7 工具（task.dispatch 效果） |
| 内置扩展 | session-tools（3 工具，按 ownerId 作用会话）/ runtime-tools（get_time/exec_command/TASK_DISPATCH_EFFECT/createChildTools）/ workspace-tools（6 工具，file.write 效果）/ commands（14 斜杠命令） |

### 3.10 Agent 组合（src/agent/loop.ts、runtime.ts）

| 接缝 | 语义 |
|---|---|
| `new Subject(model, streamFn, tools: ToolView, options)` | 构造注入：store/compaction/compactor/compactionTrigger/projection（P3c Replacement 缝）/systemPrompt/thinkingLevel/runtimeHooks |
| 观测 API | subscribe（不含 model_select/thinking_level_select/output）/historySnapshot/queuedSnapshot/getUsedTokens/getContextSegments |
| 模型纪律 | setModel/setThinkingLevel/cycleThinkingLevel；applyPreparedRuntime 复用同一纪律 |
| 输入/队列 | pushInput/accept(AgentInput{id,mode,source,text?,images?,data?})/steer/followUp/seedQueue/claimAllQueued/claimQueued(id)（mailbox claim 原语，P2 起 "ForEditor" 语义归 UI 组合）/resumePending；队列模式固定 one-at-a-time |
| 生命周期 | interrupt/isBusy/waitForIdle/compact/requestRewind（忙时 scheduled 排队） |
| 历史注入 | addHistory/appendCustomMessage/appendCustomEntry（压缩回溯中拒绝） |
| `InputQueues` | enqueue/seed/peekMany/remove/oldestAgeMs（claim 机制所在） |
| `AgentHandle` | id/subject/session:SessionAccess/send/interrupt/waitForIdle/snapshot/history/dispose |
| `AgentFactory` | 子代理工厂替换接缝（DefaultAgentFactory 内置） |

### 3.11 UI（src/extensions/ui-contract.ts、src/ui/）

| 方法组 | 成员 |
|---|---|
| 对话框 | select / confirm / input |
| 状态区 | notify / clearNotification / setStatus / setWorkingMessage / setWorkingVisible |
| 布局 | setWidget(key, component, {placement, priority}) / setHeader / setFooter |
| 覆盖层 | showOverlay(component, options?) → OverlayHandle{hide, focus, …} |
| 编辑器 | pasteToEditor / setEditorText / getEditorText |
| 终端 | onTerminalInput(handler) |
| 开关 | get/setGutterMode / hasUI |

配套：createPrintUI 无 UI 兜底；attachUI 晚绑定 + dynamicUI Proxy + ownedUI 命名空间隔离；组件契约（render(width)→string[] 行数组，零 Virtual DOM）；渲染链四类 → ExtensionRegistry → 转录缓存失效；UIHostOptions 依赖注入（terminal/registry/jobPort/subagentPort/sessionPort）。**不可插拔**：键位绑定与主题（硬编码）。

### 3.12 配置 / 启动

| 接缝 | 语义 |
|---|---|
| CLI | --extension（可多次）/--model/--no-session/--print；UINA_ONESHOT_MSG；UINA_HOME |
| 扩展发现 | `<cwd>/.uina/extensions` 一级扫描 + extensionPaths + package.json `uina.extensions` 清单 + index 入口 |
| 加载 | jiti（moduleCache:false，reload 不被缓存穿透） |
| 公共出口 | src/extensions/index.ts re-export 扩展作者导入面 |

### 3.13 护栏

| 机制 | 语义 |
|---|---|
| `readonlySnapshot` + `copyValue` | 输入深冻结、返回值接管（guard.ts） |
| `Registrations<T>` | 栈式 replace + dispose 恢复前值（工具/服务/Provider/Model/压缩器/渲染器共用） |
| 通道分流 | model_select/thinking_level_select/output_* 只走扩展通道，不经 Subject.subscribe |
| 升级规则 | direct→steer 唯一归属 submitText |

---

## 4. 对照结论

### 4.1 同一机制、两边形态（重点学习区）

| 机制 | Pi 形态 | Uina 形态 | 判定 |
|---|---|---|---|
| 回合边界替换 | `prepareNextTurn` 直接回调 | `turn.prepare` → `emitBeforeAgentStart` 两层转接 | 同能力，Pi 少一层 |
| 回合间停止 | `shouldStopAfterTurn` 返回 boolean | `turn.shouldStop→emitTurnShouldStop` 包装 `{stop}` | 等价 |
| 工具前拦截 | `beforeToolCall` 回调 + `tool_call` 事件 | `tools.beforeCall` + `tool_call` 事件 | 同构（双通道） |
| 上下文改写 | `transformContext` + `context` 事件 | `transformContext` + `emitContext` + contextContributor | Uina 多一条注入路径 |
| 请求体替换 | `onPayload`（每请求 options） | `provider.transformPayload`（每请求 hooks） | 等价 |
| 压缩取消 | `{cancel?, compaction?}` 可接管 | `{cancel?}` 仅取消 | **Uina 少接管** |
| 存储可插拔 | `Session` + conformance 套件 | `SessionStore` + 2 实现（无套件） | Pi 多工程保障 |
| appendEntry/sendMessage | 同构 | 同构 | 等价 |

### 4.2 Pi 有、Uina 无（学习候选，按价值排序）

| Pi 接缝 | 价值 | Uina 现状 |
|---|---|---|
| `convertToLlm` / `entryProjectors`（投影接缝） | 高：历史→上下文映射可换，投影多样化不必改 Core | buildContext/projectAgentHistory 内部固化 |
| `session_before_compact` 接管压缩 | 高：扩展成为压缩实现者而非仅否决者 | 只能 cancel |
| `BashOperations` 等操作层替换 | 高：工具面不变、后端可换（本地/SSH/sandbox） | workspace-tools run 内置实现 |
| `input` 事件（转换/吞掉输入） | 中：输入管道干预 | InputEvent 仅观察 |
| `message_end` 替换最终消息 | 中 | 无 |
| `addedToolNames` 动态引入工具 | 中 | 无 |
| `prepareArguments` 参数垫片 | 中 | 无（Ajv 前无钩子） |
| QueueMode="all" | 中：Pi 有真实用例 | 固定 one-at-a-time（Phase 4 有意删除） |
| `deliverAs:"nextTurn"` 第三投递路径 | 低中 | 无 |
| 主题/键位 JSON + 注册表 | 低中（TUI 产品力） | 硬编码 |
| `addAutocompleteProvider` / `setEditorComponent` / CustomEditor | 低中 | 有 setEditorText/onTerminalInput，无组件替换 |
| 包管理器 + project_trust | 低（分发形态） | 无 |
| `registerFlag` / `registerShortcut` | 低 | 无（命令有，标志/快捷键无） |
| `registerApiProvider`（按 api id 换流） | 低 | registerProvider 按 provider.id，粒度更粗 |
| OAuth 可插拔 | 低 | 无 |
| Session conformance 套件 | 低（工程实践） | 无 |
| RPC/Server 包、CBOR 协议 | 低（形态差异） | 无 |

### 4.3 Uina 有、Pi 无（反向差异）

| Uina 接缝 | 说明 |
|---|---|
| `registerService`/`callService` 类型化服务总线 | Pi 用 EventBus 字符串频道 |
| `callTool`（扩展主动执行工具 + 审计） | Pi 无 |
| `CompactionTrigger` 策略钩子 | Pi 的 enabled 是布尔 |
| ToolEffect 通用效果事实 | Core 无工具名知识；Pi 的文件清单内联于内置工具 |
| rewind/journal 机制（嵌入压缩投影直接应用） | Pi 无 rewind（分支树导航是另一套） |
| InputQueues seed/claim（claimAllQueued/claimQueued） | Pi 队列无 UI claim 语义 |
| `Registrations<T>` 统一 replace+恢复 | Pi 各注册面语义不完全一致 |
| subagent 为 core 机制（AgentFactory 注入 + notify 回投 + abandoned 血统） | Pi 的 subagent 是扩展示例 |
| `continuation:"stop"`（单工具终结，队列保留） | 与 terminate 近似但作用点不同 |

### 4.4 "直接接缝"五条设计规律

1. **干预点用回调，广播用事件**。Pi 的替换能力全是构造时函数字段，调用点即接缝，无转发层；事件刻意只观察。Uina 的 RuntimeHooks 已同构，但扩展层需经 emit\* 链转接。
2. **替换范围要到"机制接管"级**。只给 cancel 是半截接缝；`{cancel?, compaction?}` 让扩展成为实现者。
3. **投影也是接缝**。convertToLlm/entryProjectors 让"历史→模型上下文"可换——Pi 最值得学的一条。
4. **后端级替换**。Operations 接口：工具面不变、执行后端可换。
5. **同一纪律处处一致**。signal/queue drain/stale 保护在每个接缝形状相同；Uina 的 guard/scope/Registrations 品质已在，保持。

---

## 5. 不够直接的接缝：Pi 派生测试

**判定标准**：若 Uina 拥有 Pi 的接缝集，某 Uina 接缝的功能能否由 Pi 接缝组合实现？
- **能** → 它是"用接缝长出来的功能"，不需要作为独立接缝存在 → **不够直接**
- **不能** → 必要接缝（与 Pi 直接同形，或 Uina 必要特有）

### 5.1 派生映射（7 族不直接；P1b/P2 后收敛状态见判定列）

| # | Uina 接缝族 | 现状 | Pi 的推导路径 | 收敛后果 | 判定 |
|---|---|---|---|---|---|
| 1 | HostEvent 14 类 | **已收敛（P1b）**：HostEvent = RuntimeEvent 1:1 透传 + notice（宿主域事件），翻译层与 toolStartedAt 已删，session_rewind 自带 entries | `AgentSession.subscribe` 单一事件流：core 事件 1:1 同名转发 + 少量增量（willRetry/queue_update），消费者直接订阅 | 删 host 映射层与 HostEvent 翻译，消费者订阅同一词表 | ✅ 已收敛 |
| 2 | `registerContextContributor` | **已收敛（P2）**：第三路径退役；回合注入只剩 prepare（回合边界，messages 聚合）与 transformContext（每请求） | `pi.on("before_agent_start", () => ({message}))` 一个有状态 handler（Pi 唯一路径） | 删第三路径；保留 prepare（回合边界）与 transformContext（每请求）两个时机 | ✅ 已收敛 |
| 3 | 压缩半截协议补偿对：`registerCompactor` 槽 + `CompactionTrigger` | before_compact 只能 cancel，"替换压缩"与"触发策略"靠两条补充接缝 | `session_before_compact` 返回 `{cancel?, compaction?}` 一条协议覆盖接管；阈值是 `CompactionSettings`；策略取消 = 扩展在事件里 cancel | 给 emitSessionBeforeCompact 加接管返回后，槽位退役为事件结果、Trigger 退役为扩展策略 | **建议收敛**（v3 改判：不升级公共协议——P2 仅内部路径收敛，最终形态由 Compaction extraction 裁定，见 subject-runtime-plan.md §2.2 #3） |
| 4 | `registerService`/`callService`/`hasService` | 类型化服务总线（独立 Registrations 机制） | `pi.events` EventBus 任意频道 emit/on（频道名 + 载荷约定） | 类型安全是真实收益 | 可辩护偏差 |
| 5 | `BuiltinUI` 15 方法 | **已收敛（P2）**：并入 ExtensionUIContext 可选成员（clear 更名 clearTranscript），builtin commands 拿 pi.ui，cli 桥接对象删除 | Pi 的内置命令也是扩展，用同一个 `ctx.ui` | 并入 ExtensionUIContext（builtin commands 拿 pi.ui） | ✅ 已收敛 |
| 6 | `BuiltinServices` 装配束 | **已收敛（P2）**：特权 Subject 句柄退役，pi 增 usage/isBusy/reload/shutdown 与 models.groups/thinkingLevel/setThinkingLevel；jobs/subagents 原本就未被命令使用，直接删除 | `pi.*` 扁平面，host 不为内置能力另造服务束 | 内置能力走与项目扩展完全相同的 API 面 | ✅ 已收敛 |
| 7 | 订阅分流例外 | model_select/thinking_level_select/output_* 只走扩展通道，Subject.subscribe 是受限子集——"哪些事件走哪条通道"需例外清单 | Pi 单一 subscribe 全量，session 层做增量 | guard 所有权纪律有理由，但例外清单本身是间接性来源 | 纪律性间接（v3 解法：Hook≠Event 分类——干预形状变体退出事件流成 hook 专属词汇，见 subject-runtime-plan.md §2.2 #5） |

**边缘案例（不计入不直接）**：`appendEvent` + SessionEventName 封闭枚举（持久审计事实，Pi 用 entry 类型表达，形态差异）；`claimAllQueued/claimQueued` claim、`callTool`、`AgentFactory`、ToolEffect、rewind/journal——Pi 推导不出来，属 Uina 必要特有/增强。JobRegistry/SubagentRegistry 严格说是"用接缝长出的功能"（建立在 AgentInput followUp + 注册表上），是正面例子而非接缝。

### 5.2 计数

| 统计口径 | 数值 |
|---|---|
| Uina 接缝族（共享同一宿主/契约点的 API 计 1 族） | ≈46（P2 删除 2 族，扩展面增员不计新族） |
| 与 Pi 直接同形 | ≈27 |
| Uina 必要特有（Pi 推导不出，非不直接） | ≈14 |
| **不够直接（Pi 可派生）** | **3 ≈ 7%**（P1b 收敛 #1、P2 收敛 #2 #5 #6） |
| —— A 类：建议收敛 | 1（#3，最终形态由 Compaction extraction 裁定） |
| —— B 类：可辩护偏差 | 1（#4） |
| —— C 类：纪律性间接 | 1（#7） |

### 5.3 结论

Uina 的接缝面约 93% 与 Pi 直接同形或是必要特有（P1b+P2 前 85%）。曾经"不够直接"的 7 族全部源于同一个反模式：**在直接接缝之外另造专用机制**——第二事件词表（HostEvent）、第二 UI 契约（BuiltinUI）、第三注入路径（contributor）、半截协议的补偿对（compactor 槽 + trigger）、专用总线（services）、装配束（BuiltinServices）、通道例外清单（分流）。Pi 的做法是把它们全部坍缩回一条直接接缝 + 一个约定：同一功能只允许一个接缝形态存在。其中 4 族已按此收敛（#1 P1b、#2/#5/#6 P2），#3 等 Compaction extraction 最终裁定，#4/#7 有成文的可辩护理由。

### 5.4 P4 审计结论（2026-09-18）

执行稿 P4 三项对照代码逐点核验：

1. **生命周期守卫/进程追踪挂点**：已收敛，零迁移需求。进程追踪 = runtime/process-tracker 单模块，调用点仅 runtime-tools/exec-command（extensions 域）；host.dispose 统一 killTrackedDetachedChildren；信号守卫（SIGTERM/SIGHUP/SIGINT/stdout EPIPE）成文为 CLI 顶层所有权（"Process-level ownership lives here"，对齐 Pi modes/*）；Subject 零 process/exit/track 词汇。挂点分层：extensions 工具登记 pid → runtime 模块持表 → host 兜底清杀 → CLI 持信号，各层职责单一。
2. **编辑器队列语义**：已收敛（P2）。Subject 内 "editor" 仅存于 3 处注释（说明 claim 原语边界），"取回编辑器"组合在 cli/app.ts（UI 域）：pull-back 走 host.claimQueued、TUI 启动走 host.claimAllQueued；claim 原语本身是 mailbox 语义（必要特有，见 §5.1 边缘案例）。
3. **内核行数复核**：内核五目录（agent/session/core/tools/runtime）共 5772 行；loop.ts 1227 行 vs 终态裁定 1209（+18），增量全部为 P3 三切片的投影缝本体（ProjectionPolicy 字段/上下文/ensureSettled 相关注释），无 host/UI 词汇渗入（boundary 门禁 + grep 双重核验）。判定：终态容忍内，不拆。

P3c 遗留的"host 分发"已落地：UinaHostOptions.projection → Subject 构造（组合根注入路径），host 启动恢复路径有双实现测试守卫（tests/projection-seam.test.ts）。**宿主编排零残留验收达成**：Subject 生命周期面（interrupt/isBusy/waitForIdle/compact/requestRewind）全部是主体域语义，无进程、无 UI、无宿主编排词汇。

### 5.5 P5 Rewind 提取实验判定（2026-09-18）

裁定**结局 A**：cut = canonical 结构事实，rewind record 留封闭 schema。理由：①主线截断 + 放弃切片只增不减是 replay 必须复现的持久事实（结局 B 的两条路——custom record 或占用投影缝——分别被 replay≡memory 与 P6 裁定堵死）；②四重合法性校验是 journal 防线不可下放；③进 CanonicalState 的派生（carriedInputs/effects/notice 结构）必须确定性。命令/文案已在 capability（session_rewind 工具 + /rewind 命令）；携带策略与 notice 散文为成文候选（触发=第二 owner，沿 ProjectionPolicy 先例）。safeTargets 交互四条 + Mod-Surface 0 行 / Cog-Surface 3 概念，全文见 rewind-extraction.md。派生测试 #8（rewind 由公开 seam 推导）前置证据就绪。

### 5.6 P6a 进度：默认压缩器下沉 official capability（2026-09-18）

- **extensions/compaction**（builtin capability，host 默认激活）：经 pi.registerCompactor 注册 streamCompactor（默认算法 Compactor 形态，摘要调用经 pi.models.stream——runtime provider hooks 由传输层注入，与内建路径行为一致）；shouldCompact = defaultDecision（阈值判据仍由主体按 CompactionSettings 计算，P6b 随语义切换下沉）。
- **Subject 默认回退退役**：resolveCompactionResult 变为纯 proposal 裁决（undefined = 无压缩能力，不再静默走隐藏内置实现）；无 capability 激活的裸 Subject 没有压缩——这是所有权语义的诚实化，不是行为回归（host 路径恒有 capability）。
- **CompactionRequest.cut**：完整切点（split-turn 语义）随请求携带——capability 的摘要与内建算法逐字节等价的前提。**曾设计的 proposal.turnStartIndex/effectiveKeep 为多余设计**（prepareCompaction 的 retainedTail 本就是 slice(firstKeptEntryIndex)，两条路径天然等价），评审中自行撤销。
- **registerCompactor 强制 replace**：槽是 Replacement 接缝（单 owner），后注册者接管、dispose 恢复前值——项目扩展覆盖 builtin 默认无需显式 replace。
- **rewind 解耦**：RewindProjectionContext 退役 stream/providerHooks（唯一消费者是已删除的回退分支）。
- **AgentCreateOptions.compactor**：代理级透传（P6b capability 驱动 prepareTurn 后统一收口）。
- P6b 待办：prepareTurn 阈值体检下沉 + transformContext 裁剪（无状态 keepRecentTokens 设计，rewind-proof；ChatMsg 无 id，身份锚不可行）+ compaction record legacy 化 + Subject 压缩编排/registerCompactor/beforeCompact 退役。

### 5.7 P6b 进度：transformContext 裁剪语义切换（2026-09-18）

- **extensions/compaction 成为自动压缩端到端 owner**：单拦截点 turn.transformContext——估算超限 → 滚动摘要（覆盖 [0..coverTarget)，coverTarget = 裁剪边界 + 半预算余量）→ 返回 [system 原位保留, 摘要消息, 预算内尾部]。摘要覆盖与裁剪边界同刻同函数对齐，构造上无未摘要间隙；无需 turn.prepare 预生成。
- **rewind-proof（结构化）**：摘要锚定生成时主线头 entry id；锚仍在主线 = 前缀未被回溯切断 = 摘要有效；锚被放弃 → 结构性失效重生成。coveredUpTo 以 ChatMsg 流坐标记录（前缀稳定）。重启经 pi.history() 重载 journal 中的 uina.compaction.summary 条目。
- **journal 保留全量历史**：自动压缩不再写 compaction record、不再截断 Subject 内存视图（replay≡memory 更强：内存永不删改）；manual compact() 仍走 canonical 截断（P6c 命令化后收口）。
- **Subject 退役**：prepareTurn 整体删除（每请求裁剪即回合内暴涨安全网）、自动分支、compactionTrigger 全链（SubjectOptions/host/runner/registerCompactor.shouldCompact）。保留：manual compact + beforeCompact + registerCompactor 槽。
- **pi 新原语**：history()（主线 hydrated entries）+ emitEvent()（事实出口 → 扩展事件总线，与旧 manual session_compact 可见性一致；不到宿主消费者——同旧路径）。
- **评审自纠两个真 bug**：①summaryValid 覆盖判断写反（coveredUpTo <= boundary 放行欠覆盖摘要 → 静默丢内容 + 逐请求重生成螺旋）→ 改为 boundary ≤ covered ≤ len + 半预算覆盖余量；②小窗口模型（window < reserve）预算为负 → 全删+逐请求重生成 → reserve = min(16384, window/2) 随窗口缩放。
- **已知保留（P6c）**：manual → capability 命令、beforeCompact/registerCompactor 退役、record 完全 legacy 化、projector memoization（O(全量) 估算每请求发生，暂可接受）、摘要覆盖坐标含 leading system 偏移的边界（system 条数恒定时无影响）。

### 5.8 P6c 进度：压缩端到端收口，Core 零压缩词汇（2026-09-18）

- **手动压缩命令化**：/compact 命令移入 official compaction capability（force 标志 + instruction），下一请求 transformContext 强制裁剪（MANUAL_KEEP_TOKENS 尾部保留）；无下一请求则无压缩对象——压缩是请求上下文的操作，语义自洽。pi.compact → Subject.compact → runner compact 接缝 → host onCompact 全链退役。
- **rewind 嵌入压缩退役（本轮核心裁定）**：compactProjectionForRewind（投影超窗 → 提交前 canonical 载荷摘要 + 超限拒绝门 OVERSIZED_REWIND）整体删除——它是 transformContext 之外的第二条压缩路径（违 L1），其存在动机（历史真被截断的旧世界）已被 P6b journal 全量语义消灭；回溯重暴露由同一条每请求裁剪收敛，P6b 测试已钉正向覆盖。rewind.ts 回归纯结构事实（checkRecord → projectHistory → appendRewind）。旧 journal 的 rewind record compaction 载荷仍由投影解释（legacy 读取器）。
- **registerCompactor 槽退役**：capability 直接经 pi.models.stream 生成摘要；Compactor/CompactionRequest/CompactionProposal/CompactionCheck/CompactionTrigger 类型随 core/compaction.ts 全删；agent/compaction.ts（streamCompactor/compactHistory/findCutPoint/serializeConversation 等 ~400 行）全删；AgentCreateOptions.compactor 退役。
- **beforeCompact hook 退役**：runtime hook 词汇九条 → 八条（合并规则表同步）；host.runBeforeCompact / guard / noop / runtime-hooks 适配全删。为一条 UI notify 保留整个 hook 机制 = 尾巴摇狗；进度由 session_compact / session_compact_failed 事实事件表达（Hook≠Event 一致性）。
- **record 完全 legacy 化**：SessionStore 接口删 appendCompaction（生产零新写通道）；Memory/Jsonl 具体类保留方法为"旧数据铸造器"供测试（不在接口内）。SessionCompactionRecord 类型保留（旧 journal 读取）。
- **手动失败可见性补齐**：force 路径摘要失败 emit session_compact_failed（P6b 自动路径静默缺口分而治之：自动失败下请求自然重试保持静默）；builtin failed 通知带 error 文案。
- **测试迁移**：删 compaction.test/compaction-budget.test（算法单测随算法退役）、activity-lifecycle（Subject.compact 活动语义消失）；compaction-per-step 增 /compact force 端到端 + 失败透传；extension-composition 增 capability 事件契约测试（session_compact/session_compact_failed 进扩展总线）；ui.test beforeCompact 步骤退役。
- **验收（终态行 99 "Core 零压缩词汇"达成）**：全量门 typecheck + boundaries + 测试 + coverage + CRAP gate 426 函数（较 P6b 464 净减 38）全绿；examples/custom-compaction 重写为 transformContext 自定义裁剪示范；docs/extensions.md 压缩章节同步。
- **P6c 保留（P8 或按需）**：projector memoization（O(全量) 每请求估算暂可接受，真实性能墙出现才是 L4 重审证据）；recovery.ts 投影对旧 compaction/rewind 载荷的解释为永久 legacy 读取器。

### 5.9 P7 审计报告：Jobs/Subagent 无 Core 特权证明（2026-09-18）

审计性质：纯审计零迁移（执行稿 P7 行裁定）。对象：src/extensions/jobs/、src/extensions/subagents/、其宿主装配与事实通道。

**1. Import 审计（通过）**：两扩展全部 import = 类型引用（agent/runtime AgentHandle、agent/loop AgentInput、tools/broker Tool/ToolView、core/errors）+ 两个通用原语（runtime/task-handle.ts TaskOutputBuffer/TaskWaiters、extensions/task-tool.ts createOwnedTool）。零 SessionStore / journal / canonicalReplay / 投影内部访问。

**2. 内核词汇检查（通过）**：内核五目录仅 2 文件含 task 词汇——session/access.ts 仅注释提及 subagent（视图消费者）；runtime/task-handle.ts 是 Universal TaskOutputBuffer 原语（Jobs/Subagents 只是注释中的示例消费者）。零 Jobs/Subagent 专属语义入内核。

**3. Hook/后门检查（通过）**：两扩展 0 个 onHook / registerCommand / 事件订阅。能力面全部经宿主装配注入（model getter、stream、createTools 子工具切片、notify 回调、AgentFactory）——全部为公开接缝；子代理回溯放弃感知（provenance.abandoned）经宿主消费 generic effect facts 实现，非 registry 自查 journal。

**4. 事实通道（执行稿偏差 #1，裁定执行稿过时）**：执行稿假设 "crash 恢复故事经 uina.jobs/* custom record + appendRecord 自行恢复"——代码中 uina.jobs/* 不存在。真实故事：任务事实 = ToolEffect（task.dispatch + externalOperationId，由 exec-command 与 subagents/tools 声明）；回溯放弃集合 = 宿主从 rewind record 的 effects 载荷推导（collectAbandonedTaskIds，重启恢复同一推导）。该形态**优于**执行稿设想：零专属持久化格式，复用开放 effect 事实 + 既有 record kind，Core 不需要 GenericJobProtocol（这正是派生测试 #8 的通过标准）。裁定：P8 清算时修订执行稿措辞，实现不动。

**5. 进程 crash 恢复故事（执行稿偏差 #2，裁定不补实现）**：jobs 是进程内 in-flight 状态，非 durable 状态；重启后 JobRegistry 为空，不假装任务还在。journal 保留完整事实（tool_started/tool_finished 配对 + task.dispatch effect 声明），诚实呈现"任务已丢失"。按奥卡姆 + L3（Replay 不能制造事实）：为可丢失的 in-flight 状态发明 uina.jobs/* 持久化格式是过度设计；未来若出现真 durable jobs 需求，capability 可自行经 pi.appendEntry（custom entry，Auxiliary）落盘自恢复——Core 零改动，接缝已备。

**6. 对抗式审查产出（1 项真缺陷已修）**：JobStatus 的 "unknown" 成员在 jobs 域零产生点（"unknown" 的真实产生在 ToolResultStatus——runner 取消路径，另一个枚举），isTerminal 对它的比较是不可达分支，违背"不写欺骗性代码"。已修：JobStatus 去 "unknown"、isTerminal 收窄为三值（提交随本审计）。其余防御分支均有真实触发条件（settle 幂等 guard、waiter 清理、owner 校验、abandoned 透传）。

**7. 派生测试 #8 双维度（通过）**：
- 故事路径：后台任务 capability = registerTool（task 工具）+ ToolEffect 事实声明（task.dispatch）+ 宿主装配消费 generic effects（回溯放弃集合）+ 通用 TaskOutputBuffer 原语。零 Core 专属语义。
- Modification Surface = **0 Core 文件**（两 capability 全在 extensions/，宿主装配消费开放事实）。
- Cognitive Surface = 3 概念：registerTool、ToolEffect 开放事实、TaskOutputBuffer（≤3 达标，且每个概念独立可一句话解释）。

**8. 残余观察（供 P8）**：①JobRegistry/SubagentRegistry 已在 src/extensions/，host.ts 仅装配（既有事实复核成立）；②runner.ts:633 的 ToolResultStatus "unknown"（取消后结果未知）是合法产生点，与本次删除的 JobStatus "unknown" 无关；③P8 终验时七问 #5（Rewind/Compaction/Jobs/Subagent 公开 seam 推导）可直接引用本报告 §1-§3 与派生测试 #8 结论。

### 5.10 P8 终验报告：清算 + 七问 + 残酷审查（2026-09-18，提交 d62c443）

**遗留抽象清算**：①formatForSummary 删除（P6c 零引用孤儿）；②7 处去 export（parseToolArgs/isToolEffect/SUMMARY_ENTRY_TYPE/findTrimBoundary/renderTrimmed/loadSummary/MAX_LINE_LENGTH——导出面即契约面）；③legacy record 清理策略成文：SessionCompactionRecord 与 rewind 载荷解释是**永久 legacy 读取器**（旧 journal 可回放性承诺），appendCompaction 保留于具体 store 作测试铸造器（P6c §5.8 裁定不变）；④BuiltinServices/BuiltinUI 复核：仅存于历史注释，装配束已溶解。

**L4 五关走查（全部接缝）**：
- turn.prepare：不可避免（模型/档位属回合语义）✓ 通用（任意回合级替换）✓ 正交（不碰历史）✓ 最小（3 字段聚合）✓ 第五关：成本切换零 Core 改动 ✓
- turn.transformContext：不可避免（请求上下文每请求态）✓ 通用（压缩/注入/裁剪共用）✓ 正交（链式组合）✓ 最小（整组替换无细粒度协议）✓ 第五关：P6b/c 压缩 + Memory 注入零 Core 改动 ✓
- tools.beforeCall/transformResult：不可避免（工具边界干预）✓ 通用 ✓ 正交 ✓ 最小 ✓ 第五关：危险调用拦截零 Core 改动 ✓
- provider.transformHeaders/Payload/observeResponse：不可避免（provider 边界）✓ 通用 ✓ 正交 ✓ 最小 ✓ 第五关：MCP 桥零 Core 改动 ✓
- ToolEffect：不可避免（工具声明的效果事实）✓ 通用（开放 effectType+data）✓ 正交（Core 不解释语义）✓ 最小（4 字段）✓ 第五关：jobs/subagents 回溯放弃感知零 Core 改动 ✓
- projectHistory/convertToLlm（Replacement 缝）：不可避免（整层解释替换）✓ 通用 ✓ 正交（与 hook 正交）✓ 最小（单 owner 无 pipeline）✓ 第五关：官方 Compaction **不占它**（P6b/c 实证）✓
- canonicalReplay/checkRecord/applyRecord：不可避免（可回放性根基，封闭 schema 是裁定）✓ ✓ ✓ ✓

**派生测试双维度报告（§4，8/8 过，全部 Mod=0 Core 文件）**：
1. 成本切换→turn.prepare（Cog 1）｜2. 工具注入/拦截→transformContext+tools.beforeCall（Cog 2）｜3. 自定义压缩→transformContext capability（Cog 2，P6 实证）｜4. 远程/无头消费→事件单流+SessionStore 可插拔（Cog 2）｜5. 全新工具形态→registerTool+Operations+投影缝（Cog 3）｜6. 重启一致→journal 回放（Cog 1）｜7. 分支/检查点→canonical primitives+投影缝（Cog 3，branch-inspector 扩展实证）｜8. 后台任务 crash→ToolEffect+宿主装配消费（Cog 3，P7 实证）。Cognitive Surface 最大 3（heuristic 上限），且每个概念独立可一句话解释——无巨型 UinaContext 式伪单概念。

**终局验收七问**：
| # | 结论 | 证据 |
|---|---|---|
| 1 | **过** | Subject 主循环 input→prepare→canonical history→project→model→tools 一屏可读；Session/Host 仅类型引用（boundary 门禁机械保证） |
| 2 | **过** | P6b/P6c/P7 三轮实证：新/改 capability 常规 0 Core 文件；hooks 词汇 8 条为唯一接缝扩展点 |
| 3 | **过** | L1 机械化审计：压缩单路径（P6c 收口，rewind 嵌入路径已删）；干预=hook 单词表、事实=event 单出口（Hook≠Event）；无第二实现路径残留 |
| 4 | **过** | 残酷审查逐类质询：内核抽象（Subject/ProjectionPolicy/canonicalReplay/SessionStore/ToolEffect/ToolBroker/RuntimeHooks8/TaskOutputBuffer/InputQueues）均有具体语义一句话；架构类名扫描零命中（仅 UI FocusManager） |
| 5 | **过** | Rewind（P5）/Compaction（P6）/Jobs/Subagent（P7）三轮实验报告 + 派生测试 8/8 |
| 6 | **过** | **减法测试实证**（tests/subtraction.test.ts，本轮新增）：零 capability 裸内核可启动/跑回合/工具可用/journal 持久；旧会话 legacy compaction+rewind 记录正确回放 |
| 6b | **过** | 残酷审查"历史兼容"质询：唯一存留的历史兼容物 = legacy 读取器（旧 journal 可回放承诺，数据模型原则）与 guard（所有权纪律，§6 明示不砍）；其余全部在 P1-P8 退役 |

**行数复核（结果指标，对照 P4 基线）**：
| 目录 | P4 记录 | P8 现值 | Δ |
|---|---|---|---|
| 内核五目录 | 5772 | 4884 | **−888** |
| loop.ts | 1227 | 1077 | −150 |
| rewind.ts | — | 65 | 纯结构事实 |
| 全 src | — | 26159 | extensions 4814 为 capability 主体 |

内核收缩主因：agent/compaction.ts（~400 行）与 core/compaction.ts 全删、loop 压缩编排退役、rewind 嵌入压缩退役。CRAP gate 函数数：P6b 464 → P7 426 → P8 425。**判定**：内核更小且语义更纯——收缩来自删除重复路径，非功能削减；符合预期管理（Session/recovery 的持久语义重量保留）。

**残酷审查最终结论**：假设今天重写 Uina，内核抽象清单（上述 9 项）全部会被主动设计出来；唯一"因为已经这样了"的候选是 ui/ 域（不在本执行稿范围）。P1→P8 执行稿闭环，主体重构终态达成。

**明确遗留（非债务，为裁定）**：①projector memoization 不做（O(全量) 每请求估算无真实性能墙，L4 重审证据未出现）；②键位绑定/主题不可插拔（§6 明示不做）；③执行稿 P7 行 uina.jobs/* 措辞过时（§5.9 裁定修订）；④ui/ 域按 ui 侧执行稿另行清算。

### 5.11 数据模型收口：custom_entry 真正 Auxiliary 化 + Memory 派生实验（2026-09-18）

**问题（用户发现的真架构缺陷）**：custom_entry 名义上是 Auxiliary（capability 私有持久状态），实现却经 addEntry 进主线 entries + allEntries + parentId 链 + trackSafety→safeTargets——`uina.compaction.summary` 成为 canonical lineage 节点，**可被选为 rewind target**；且 capability 用 pi.history() 找私有记录，当主线尾恰为 summary entry 时 anchorId 锚到私有记录上（canonical 污染产生实际错误语义）。v6 定义：custom_entry→Auxiliary→只登记。

**修复**：①applyRecord：custom_entry → auxiliary.push(record)（不 addEntry）；②CanonicalState.auxiliary 类型放宽为 (SessionEventRecord | SessionCustomEntryRecord)[]；③checkRecord 豁免 custom_entry 的 ensureSettled（同 turn_failed/turn_aborted：未决期间写私有状态不改变对话事实，不制造恢复歧义；旧 journal 无该序列，方向安全）；④SessionEntryPayload 收窄（删 custom_entry 成员）——编译器驱动死链清除：transcript loadSession 分支/addCustomEntry/timeline customEntry/render case、cards CustomEntryComponent、ui-contract EntryRenderer/EntryRenderOptions、renderer-registry entryRenderers、runner registerEntryRenderer、ui-host entry resolver、navigation case 全删（addCustomEntry 本就零生产调用方，整链是未接线机制）；⑤**新接缝 pi.auxiliary()**：capability 读自身私有持久状态的通道（host 装配 state.auxiliary）；pi.history() 语义随之变纯（canonical only）——compaction 的 loadSummary 改走 auxiliary，anchorId 取 history().at(-1) 自动回到真主线头。

**Memory 派生实验（第五关再实证）**：新增 tests/helpers/memory-capability.ts + tests/memory-derivation.test.ts——完整 Memory capability 只用 turn.prepare（systemPrompt 注入）+ turn.transformContext（上下文注入）+ registerCommand + appendEntry/auxiliary（私有 durable state）实现；测试含文件级 import 白名单断言（仅 ExtensionAPI 类型，禁词 recovery/CanonicalState/Subject 等）+ 行为断言（注入生效、aux 记录不进主线/safeTargets、rewind 不截断 aux、重读可得）。**Mod-Surface = 0 Core 文件，Cognitive-Surface = 3 概念（onHook/appendEntry/auxiliary）**。

**顺带**：docs/extensions-development.md 旧世界内容修订（registerCompactor/registerContextContributor/before_agent_start/session_before_compact → 现役 Hook/Event 词表与压缩语义）；HostEvent 经用户复核裁定非缺陷（RuntimeEvent 1:1 透传 + HostNoticeEvent，不再转译），不改名（奥卡姆）。

**验收**：typecheck + boundaries + 全量测试 + coverage + CRAP gate 426 函数全绿；净删 72 行。
