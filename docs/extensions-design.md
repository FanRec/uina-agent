# Uina 扩展系统设计

状态：设计稿，尚未代表全部运行时已经实现。

本文定义 Uina 的第一版扩展事件边界。目标是为 Agent Loop、输入输出、工具、Provider、记忆和动态能力加载提供开放接缝，同时保持核心只有一个运行协调者和一套生命周期状态。

后台任务与子代理的完整设计见：[后台任务与子代理设计](background-and-subagent-design.md)。本文只定义扩展事件和它们与核心的关系。

## 设计原则

- 扩展通过 `on(event, handler)` 注册，不直接持有 Agent、Session 或工具内部状态。
- 事件是观察点和有限的变换点，不自动引入审批、沙箱、白名单、工具轮次或其他 Pi 没有的限制。
- 核心负责顺序、状态、取消、持久化和副作用事实；扩展负责能力增补和明确的输入/结果变换。
- 事件处理错误进入统一错误路径，不能阻塞 active run 释放、队列恢复或 idle waiter。
- 需要修改数据的事件必须明确返回变换结果；只观察的事件不复制第二套状态机。
- 输入、Provider 和工具扩展都应能在没有 TTY 的运行模式下工作。

## 连续主体模型

Uina 的主运行时不是常规的多 Session Agent 工作台，而是一个持续存在的主体：

```text
键盘 / TUI / stdio / ASR / 传感器 / 外部 API / 后台回调
  -> 统一 input
  -> 同一个 root Subject
  -> 同一个主历史和主体运行记录
```

因此主 Uina 只有一个主 Session，不提供 Session switch、fork、lane、tree 或多会话列表。不同入口是不同输入来源，不是不同会话。

主历史、主体运行事实和扩展私有状态分开：

- 主历史保存用户输入、Uina 输出、工具调用、工具结果和必要的思考内容。
- 运行事实保存输出中断、后台结果、感知状态等需要在后续决策中使用的事实；它们通过 `context` 按需投影，不自动伪造成普通 user 消息。
- 扩展私有状态由扩展自己管理，不因扩展存在就进入主 Session。

后台任务和子代理都是扩展能力。内核只提供运行一个 Agent 所需的 `Subject`、SessionStore、ModelProvider、ToolBroker、ExtensionHost 以及创建和管理 Agent 实例所需的最小原语；内核不认识 `Job`、`Subagent`、`Background` 或父子关系。

一次性后台工作由后台任务扩展管理。长期子代理由子代理扩展创建一个内部隔离的 Agent 执行上下文，以保存独立上下文、接收后续消息和支持恢复，但它不是用户可切换的平级 Session。

子代理的完整上下文留在其内部执行上下文中；子代理结果通过主 Subject 的统一输入路径回到 Uina。只有结果通知或按需读取的结果进入主上下文，不自动合并子代理 transcript。

## Uina 语音输出扩展

Uina 的语音输出不把 TTS 逻辑塞进 Agent Core。核心只发布规范化的普通内容流；语音扩展负责选择 TTS、切句、缓冲、转换和播放。这样本地 TTS、远程 TTS、TTY、WebSocket 等输出端可以拥有不同策略。

### Uina 核心事件

以下 4 个事件是 Uina 当前采纳的语音输出扩展接缝：

| 事件 | 时机 | 用途 |
| --- | --- | --- |
| `output_start` | 一条对外内容流开始 | 发布一条可被 TTS、TTY 或其他输出端消费的规范化流。 |
| `output_update` | 内容产生新的规范化增量 | 低延迟转发 `content`、`thinking` 或 `tool` 增量；不负责句子切分。 |
| `output_end` | 内容流不再产生新的增量 | 表示内容发布结束，不表示 TTS 已经播放完成。 |
| `output_interrupted` | 内容流被取消、中断或异常终止 | 传播输出流中断事实。 |
`output_*` 描述 Uina 的规范化内容流生命周期。它们不绑定 TTS，也可以被 TTY、WebSocket、字幕或其他输出扩展消费。

TTS 的切句和播放生命周期不进入 Uina 全局事件表。它们由 TTS 扩展内部维护，避免核心依赖某一种语音输出模型。

### 典型 TTS 流程

```text
ModelProvider
  -> message_update
  -> output_start/update/end
  -> TTS Extension
      -> 缓冲与切句
      -> 选择 TTS adapter
      -> 播放与播放状态
```

`output_update` 应低延迟地发布规范化增量：

```ts
{
  messageId: string;
  offset: number;
  channel: "content" | "thinking" | "tool";
  text: string;
}
```

TTS 扩展可以将多个小增量缓冲成一句，再交给 adapter；WebSocket 扩展则可以直接转发每个增量。核心不规定切句、括号过滤、Markdown 转换或具体路由策略。

普通 `content` 默认进入语音输出，`thinking` 默认不进入 TTS。括号内容可以作为默认 TTS 扩展的可配置过滤约定，但不能改变原始 assistant 内容、主 Session 历史或其他输出渠道。

### TTS 扩展内部边界

TTS 扩展可以根据自己的路由器将当前 content 路由到不同 adapter，例如切换到本地主机 TTS。它可以在内部使用以下生命周期概念，但这些不是 Uina 全局钩子：

```text
routeSelected
utteranceStarted
playbackStarted
playbackProgress
playbackEnded
playbackInterrupted
```

TTS adapter 通过一个输出端接口接收内容并返回播放事实：

```ts
interface OutputSink {
  start(meta: OutputMeta): Promise<void>;
  update(chunk: OutputChunk): Promise<void>;
  end(): Promise<void>;
  interrupt(reason: InterruptReason): Promise<PlaybackReceipt>;
}

type PlaybackReceipt = {
  status: "completed" | "interrupted" | "unknown";
  spokenUntil?: number;
  reason?: string;
};
```

外部打断机制调用当前输出控制器的 `interrupt()`。adapter 完成实际停止后，由 TTS 扩展向核心报告 `PlaybackReceipt`，核心据此生成并持久化 `SpeechRecord`。核心不需要知道 adapter 如何切句、合成或播放。

新的 content 在旧语音仍播放时，默认采用自我打断策略：

```text
新 content 到达
  -> interrupt(reason = "self")
  -> TTS 扩展记录 playbackInterrupted
  -> 固化旧片段的播放位置
  -> 播放新的 utterance
```

这是一项输出扩展策略，不是 Agent Core 对模型内容的硬限制。扩展也可以实现排队或忽略策略。

播放进度必须使用原始文本偏移，而不能只记录句子序号：

```ts
type SpeechRecord = {
  utteranceId: string;
  messageId: string;
  text: string;
  status: "completed" | "interrupted" | "unknown";
  spokenUntil: number;
  reason?: "external" | "self" | "cancelled" | "adapter_error";
};
```

### “正在说”和“打断”状态

播放中的状态不直接写入 assistant `content`，也不把 `【正在说】`、`【打断】`作为普通对话文本持久化。语音扩展产生 `PlaybackReceipt`，核心或其持久化接缝保存独立的 `SpeechRecord`，UI 或日志投影时再显示这些状态。

播放期间，下一次用户输入前的上下文可以包含当前状态：

```text
<runtime_state>
  <speech status="playing" message_id="msg-42">
    <spoken>你好，今天</spoken>
    <remaining>我们可以讨论这个问题。</remaining>
  </speech>
</runtime_state>
```

被打断后，核心先固化播放事实，再处理新的输入：

```text
<runtime_state>
  <speech status="interrupted"
          message_id="msg-42"
          spoken_until="5"
          reason="external">
    <spoken>你好，今天</spoken>
    <not_spoken>我们可以讨论这个问题。</not_spoken>
  </speech>
</runtime_state>
```

推荐顺序：

```text
停止或确认 TTS
  -> TTS 扩展得到 PlaybackReceipt
  -> 持久化 SpeechRecord
  -> 生成 runtime context
  -> 接收并处理新的用户输入
```

`runtime_state` 是下一次模型请求的上下文投影，不是新的 user 或 assistant 消息。它放在历史对话之后、当前用户输入之前。当前播放状态和刚发生的中断可以注入；已经被模型看过且不再影响决策的状态不重复追加。

播放事件可以完整保存在运行记录中，但上下文只投影与当前决策相关的最新快照。正常播放完成通常只需保存事实，不必每轮重复告诉模型；播放失败或 `unknown` 状态必须保留，不能假设用户已经听到。

## 事件总览

第一版记录 30 个事件。命名与 Pi 扩展 API 对齐，但事件载荷和返回值应按 Uina 的 v1 Session、ModelProvider 和 ToolBroker 类型定义。

### 输入与 UI

| 事件 | 时机 | 用途 |
| --- | --- | --- |
| `input` | 任意输入进入 Agent 前 | 接收用户、ASR、传感器和后台任务回调；可转换、排队或标记为已处理。 |
| `ui_prompt_start` | TUI/stdio 一次用户提交开始 | 记录交互起点、建立关联 ID、准备输入级扩展。 |
| `ui_prompt_end` | 该次用户提交处理完成 | 记录输入生命周期和延迟；不等同于 Agent 已完全空闲。 |

`ui_prompt_*` 只属于输入适配层，传感器和后台回调不必伪造 prompt 生命周期。

### Agent 生命周期

| 事件 | 时机 | 用途 |
| --- | --- | --- |
| `before_agent_start` | Agent 占用 active run 前 | 修改本轮输入、初始上下文或运行元数据。 |
| `agent_start` | Agent 已开始运行 | 初始化本轮扩展状态和观测。 |
| `agent_end` | 当前 Agent 运行结束 | 处理成功、失败、中断或部分输出的结果。 |
| `agent_settled` | Agent 及其可消费队列全部处理完 | 适合释放本轮资源；与单次 `agent_end` 不同。 |
| `turn_start` | 一次模型/工具回合开始 | 建立回合级计时和关联信息。 |
| `turn_end` | 一次模型/工具回合结束 | 记录回合结果，不代表整个 Agent 已结束。 |

### 消息与上下文

| 事件 | 时机 | 用途 |
| --- | --- | --- |
| `message_start` | assistant、tool 或其他消息开始产生 | 初始化流式消息状态。 |
| `message_update` | 消息产生增量 | 转发文本、thinking、tool call 和进度；支持即时输出。 |
| `message_end` | 消息完成或以失败状态结束 | 固化完整消息和状态。 |
| `context` | 每次模型请求生成上下文时 | 注入长期记忆、感知、后台任务结果和当前任务信息。 |

历史消息是否包含 thinking 由上下文投影和 Provider adapter 决定，扩展不能擅自改变主主体的持久化事实。

### 工具与后台任务

| 事件 | 时机 | 用途 |
| --- | --- | --- |
| `tool_call` | 工具启动前 | 观察、补充或拒绝一次 Agent 工具调用；不得伪造执行结果。 |
| `tool_result` | 工具返回后 | 转换模型可见结果，保留成功、失败、取消和 `unknown` 语义。 |
| `tool_execution_start` | 工具副作用开始前后 | 发布启动事实和任务 ID。 |
| `tool_execution_update` | 工具运行期间 | 发布进度、日志、部分输出或后台任务状态。 |
| `tool_execution_end` | 工具结束 | 发布最终状态和可验证结果。 |

长时任务由后台任务或子代理扩展托管；ToolBroker 只负责工具调用本身。扩展使用核心的输入、Agent 生命周期和 Session 持久化接缝，不在 Agent Loop 内增加后台任务分支。

### Provider 与模型

| 事件 | 时机 | 用途 |
| --- | --- | --- |
| `model_select` | 每次选择模型时 | 按任务、延迟、能力或运行状态选择模型。 |
| `thinking_level_select` | 每次确定思考等级时 | 动态选择 `off` 至 `max`，不支持时明确失败，不静默降级。 |
| `before_provider_headers` | 发起 Provider 请求前 | 修改协议所需 Header、认证或关联信息。 |
| `before_provider_request` | 序列化请求后发送前 | 修改 Provider 请求体；Provider 特有字段只在 adapter 边界内处理。 |
| `after_provider_response` | 收到 Provider 响应后 | 观察原始响应元数据或执行协议层转换。 |

网络重试、SSE 解析、协议校验和 Provider capability 仍由网关/adapter 负责，不能通过扩展绕过。

### Session、压缩与资源

| 事件 | 时机 | 用途 |
| --- | --- | --- |
| `session_start` | 主 Session 创建或恢复后 | 初始化扩展并读取必要的主主体状态；子代理内部执行上下文由子代理扩展自行管理。 |
| `session_before_compact` | 压缩开始前 | 调整摘要输入，保留事实、决定、偏好和未完成事项。 |
| `session_compact` | 压缩成功后 | 发布新摘要并更新扩展索引。 |
| `session_compact_failed` | 压缩失败后 | 记录失败并保持旧历史，不删除或伪造摘要。 |
| `session_shutdown` | Session/进程关闭时 | 释放扩展、设备监听和后台资源。 |
| `user_bash` | 用户主动执行 shell 命令前后 | 观察命令生命周期和结果；不默认添加审批、沙箱或白名单。 |

## 暂不纳入的 Pi 事件

以下 6 个事件在 Uina 当前没有稳定对应语义，暂不进入第一版 API：

- `project_trust`：Uina 当前没有 Pi 式项目受信模型。
- `session_info_changed`：暂无独立的 Session 元信息编辑流程。
- `session_before_switch`：暂无多 Session 切换操作。
- `session_before_fork`：明确不引入 Pi 的 fork/branch/lane。
- `session_before_tree`：暂无历史树操作。
- `session_tree`：暂无历史树变化事件。

这不是永久禁止。只有相应功能成为真实运行时行为后，才增加对应事件和测试。

## 推荐事件顺序

典型前台交互：

```text
ui_prompt_start
  -> input
  -> before_agent_start
  -> agent_start
  -> context
  -> turn_start
  -> message_start/update/end
  -> tool_call
  -> tool_execution_start/update/end
  -> tool_result
  -> turn_end
  -> agent_end
  -> agent_settled
  -> ui_prompt_end
```

实际顺序由是否调用工具、是否排队输入、是否压缩上下文和是否产生扩展输入决定。扩展不得依赖不存在的事件或把 `agent_end` 当作系统已经完全空闲。

## 实现边界

第一阶段只实现事件注册、确定性顺序、异步 handler 等待、错误传播和必要的返回值变换。扩展加载、资源发现和生命周期释放必须经过同一个 ExtensionHost；不为每个事件建立独立总线或审计状态机。

验收重点：事件顺序可测试，handler 错误不会泄漏 active run，工具结果不会被伪造成成功，输入和 Provider 变换可追踪，扩展卸载后不再收到事件。
