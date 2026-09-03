# Uina 后台任务与子代理设计

状态：第一阶段 Jobs 纵切和首版可持续子代理运行时已实现；UI 状态投影和跨重启恢复仍未实现。

本文是 Uina 后台任务与子代理能力的设计依据。实现参考 `E:\Uina\ThirdParty\deepseek-harness` 的 Job、continuable subagent 和前端 control stream，但采用 Uina 的连续主体模型，不把 Uina 改造成多 Session 工作台。

## 文档边界与当前事实

本文同时记录目标设计和当前实现边界。当前 checkout 中已经存在并被 `src/cli/app.ts` 使用的是：

- 一个 root `Subject`；
- 一个主 `SessionStore` 和一个 `data/session.jsonl`；
- `ModelProvider`、`ToolBroker` 和可取消的前台 Agent Loop；
- shell 同步工具加载，以及 `src/extensions/jobs` 中的进程内 `JobRegistry`、后台 shell producer 和 `job_*` 工具。
- `src/extensions/subagents` 中的 `SubagentRegistry`、`subagent_*` 工具和首版可持续 child runtime。

当前没有完整的 `ExtensionHost`；已有最小 `AgentFactory`/`AgentHandle`，以及位于 `src/extensions/` 下的 Jobs 和 Subagent 能力模块。它们不是核心业务分支。本文中设计、实现和验收分开记录，文档本身不能替代运行证据。

## 目标与非目标

目标：

- 普通长时工作可以脱离当前模型回合运行；
- 工具可以立即返回稳定 ID；
- 工作完成后能可靠通知主 Agent；
- 主 Agent 可以按需读取完整结果、查询状态和请求取消；
- 一个主体及其子代理的运行状态可以被 TUI 或未来 Web UI 展示；
- 长期子代理拥有独立上下文，但不成为用户可切换的平级 Session。

非目标：

- 不把 Job 或 Subagent 加入 Agent Loop 的核心分支；
- 不引入多会话切换、fork、lane 或历史树；
- 不把后台结果全部自动复制进主上下文；
- 不为 Job 和 Subagent 建立第二套独立审计状态机；
- 不要求所有异步工作都采用同一种生命周期。

## 连续主体边界

Uina 的主运行时只有一个 root Subject：

```text
所有入口：键盘、TUI、stdio、ASR、传感器、外部 API、后台回调
  -> root Subject 的统一输入队列
  -> 同一个主历史和主体运行记录
```

后台任务不是新的 Session。它只保存任务记录、执行句柄和结果读取状态。

子代理是由扩展派生的、可观察的内部 Agent 执行上下文。它需要独立 transcript 和 Agent Loop，以便隔离上下文、持续接收消息并在空闲后继续运行。人类和 root Agent 都可以按需查看其状态、输出和 transcript，也可以向它发送消息或请求中断；但产品层不把它当作与主 Uina 平级、可切换的用户会话。

```text
Uina 主体
  ├── root Subject
  ├── root SessionStore
  ├── Jobs Extension：一次性后台工作
  └── Subagent Extension：内部子代理上下文
```

## 归属划分

### Uina 内核

内核的目标最小接缝是：

- 一个 Subject 的消息队列和 Agent Loop；
- ModelProvider、ToolBroker 和上下文生成；
- SessionStore 的读写原语；
- 一个不理解 Job/Subagent 的 Agent 实例句柄：创建、输入、取消、等待空闲和释放；
- 一个不理解具体来源的运行时输入信封，用于把后台结果按正常队列规则送回 Agent；
- ExtensionHost、生命周期事件和资源清理。

内核不认识：

```text
Job
Subagent
Background
parentId
jobId
```

这里的 Agent 创建能力只是通用执行原语，不是“创建子代理”API。子代理的父子关系、名称、模式和生命周期都由 Subagent Extension 保存。内核也不把运行时输入解释成 Job 通知；它只负责顺序、持久化和投递。

为此，内核需要一个足够小的泛化接口：

```ts
interface AgentHandle {
  readonly id: string;
  accept(input: AgentInput): Promise<void>;
  interrupt(): void;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}

interface AgentInput {
  id: string;
  mode: "steer" | "followUp";
  source: { kind: "user" | "runtime" | "agent"; type: string; ref?: string };
  text?: string;
  data?: unknown;
}

```

`AgentFactory` 只负责按给定的 provider、tools 和 transcript store 创建这种通用 handle；它不接受 `parentId`、`jobId` 或 `background` 参数。第一阶段可以只暴露 root handle，等一次性子代理验收通过后再开放 child 创建能力。

`type` 和 `data` 对内核是不透明的。Job、子代理和感知扩展可以使用自己的类型；模型上下文如何投影这些输入由对应扩展或 context 投影器决定。`Subject.accept(AgentInput)` 已提供这条公开接缝，扩展不需要调用私有 loop 方法。

### Jobs Extension

Jobs Extension 负责一次性后台工作：

- Job 身份和 owner；
- 状态、取消和等待；
- 增量输出读取；
- 完成通知；
- `job_output`、`job_list`、`job_kill` 工具；
- 面向 UI 的 Job 快照。

### Subagent Extension

Subagent Extension 负责：

- 创建内部 Agent 执行上下文；
- 父子关系和子代理描述信息；
- one-shot 与 continuable 两种模式；
- 子代理消息发送和中断；
- 子代理完成后的父级通知；
- 面向 UI 的子代理层级和运行状态。

Subagent Extension 可以依赖 Jobs Extension 实现 one-shot 后台子代理，但 continuable 子代理不创建中间 Job。

## 普通后台 Job

### Job 记录

```ts
type JobStatus =
  | "running"
  | "stopping"
  | "completed"
  | "killed"
  | "failed"
  | "unknown";

interface JobSnapshot {
  id: string;
  kind: string;
  label: string;
  ownerId: string;
  status: JobStatus;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  reported: boolean;
}
```

`ownerId` 不是用户可提交的 Session ID，也不是模型可任意填写的字符串。它由扩展在能力绑定时分配：第一版 root 可以使用固定的内部 owner，child 使用其 AgentHandle 的内部 ID；`list/read/kill/wait` 都依据绑定的 owner 做访问隔离。

常规 Job 沿用 DSH 的状态语义：

```text
running -> stopping -> completed | killed | failed
```

`unknown` 只用于已经可能产生外部副作用、但无法确认最终结果的情况。例如请求已经发出后进程断开，不能伪造为 `killed` 或 `failed`。

### Producer 接口

```ts
interface JobSpec {
  kind: string;
  label: string;
  ownerId: string;
  outputLimitBytes?: number;
  start(context: { id: string; signal: AbortSignal }): JobHooks | Promise<JobHooks>;
}

interface JobHooks {
  cancel(reason?: string): void;
  done: Promise<JobOutcome>;
  readOutput?(): string;
}

interface JobOutcome {
  status: "completed" | "killed" | "failed" | "unknown";
  detail?: string;
  output?: string;
}
```

Producer 负责真实工作和资源释放，Jobs Extension 负责 Job ID、状态提交、owner 隔离、取消请求、读取和通知。

`cancel()` 必须同步、幂等，并最终使 `done` 得到结论。`done` 应在 producer 释放资源后完成，不只是外部工作看起来结束时完成。

### 创建顺序

```text
校验 owner 和 Job 配置
  -> 分配 Job ID，先安装 running 记录
  -> 调用 producer.start(context)
  -> 保存 JobHooks，并监听 done
  -> 返回 Job ID
```

`running` 表示工作已被 Registry 接受，不保证外部副作用已经开始。如果 `start()` 明确在副作用开始前失败，记录为 `failed`；如果启动是否已经产生副作用无法确认，记录为 `unknown`。已经返回给调用者的 Job ID 不会因为 producer 启动失败而消失。producer 必须保证 `done` 在资源释放后完成，且取消和结算只会使记录进入一次终态。

第一阶段使用进程内 Registry，沿用 DSH 的轻量边界。正常关闭时，宿主请求取消并等待 producer；如果进程被强制终止或崩溃，进程内记录会消失，下一次启动不能知道外部任务发生了什么，也不能声称它是 `unknown`。当前 `unknown` 只由运行中的 producer 明确报告结果不确定时产生；可恢复的 `unknown` 需要未来增加持久化 Registry 和重启对账。

### 默认运行策略

以下默认值沿用 DSH 的成熟 Job 行为，属于 Jobs Extension 配置，不属于 Agent Loop 限制：

```text
每个 owner 最多 10 个 active Job
job_output wait 默认 30 秒
job_output wait 最大 600 秒
空闲 Agent 的完成通知连续唤醒预算默认 3 次
```

输出限制由 producer 或 Jobs Extension 配置提供，通知只保留短摘要和 Job ID，完整输出通过 `job_output` 按需读取。

## 后台 Job 工具

### `job_output`

```text
job_output({ job_id })
job_output({ job_id, wait: true, timeout_ms })
```

规则：

- 流式 Job 返回上次读取之后的新输出；
- final-output Job 在结束后返回最终结果；
- `wait` 只等待，不取消；
- 等待超时返回当前快照，任务继续运行；
- 读取终态会标记该 Job 已被报告，避免重复完成通知；
- 未知或不属于当前 owner 的 Job 直接报错。

### `job_list`

返回当前 owner 可见的 Job 快照。前端和模型都读取快照，不从事件顺序猜测状态。

### `job_kill`

```text
job_kill({ job_id, reason? })
```

调用 producer 的 `cancel()`，立即返回 `cancellation-requested`；如果已经是终态，返回 `already-finished`。最终状态仍由 `done` 确认。

## 完成通知

完成通知不是普通用户消息，也不是完整 Job 结果。它是一条有明确来源的运行时输入信封：

```ts
interface JobNoticeSource {
  kind: "runtime";
  type: "job-notice";
  ref: string;
}
```

Job 扩展先提交自己的终态和通知去重事实，再调用 parent/root `AgentHandle.accept()`，其中 `source.ref` 是 Job ID，终态和摘要放在不透明的 `data` 中。不能直接调用 `startRun()`，也不能把通知伪装成普通 user message。接收顺序由 AgentHandle 的统一 mailbox 保证：Agent 忙时进入下一步队列，Agent 空闲时按一次 follow-up 规则唤醒。父 Agent 已被释放时，通知必须留在扩展的未投递记录中或明确报告投递失败，不能静默丢弃；进程内第一版不承诺跨重启补投。

典型流程：

```text
Job 终态提交
  -> 生成短 notice
  -> root Subject 正在运行：进入下一步队列
  -> root Subject 空闲：followUp，唤醒一次新回合
  -> 模型需要时调用 job_output
```

通知只说明：

```text
Job job-1 已完成，使用 job_output 读取结果。
```

不能在 Job 完成时自动追加完整输出，也不能生成伪造的 user 文本。多个 Job 同时完成时，通知在同一个队列中按提交顺序进入，下一回合可以批量看到它们。

## 一次性子代理

一次性子代理是 Subagent Extension 创建的普通子 Agent，由 Jobs Extension 托管：

```text
subagent(run_in_background = true)
  -> 通过通用 AgentFactory 创建 child 执行上下文
  -> Jobs Extension 注册 one-shot Job
  -> 立即返回 jobId
  -> child 执行一次任务
  -> child 结束并释放资源
  -> Job resolve
  -> root Subject 收到短 notice
  -> 需要时通过 job_output 读取最终结果
```

子代理的完整 transcript 不自动进入主历史。Job 的最终输出只在模型调用 `job_output` 后进入主上下文。

`run_in_background = false` 时可以等待 child 结束并直接返回其最终输出；`true` 时只返回 Job ID。两种路径使用同一个 child 执行实现，区别仅在调用方是否等待和是否由 Job Registry 托管。一次性 child 的结果应由 producer 读取最终 assistant 输出，不能依赖把整个 child transcript 拼进 root 历史。

## 长期子代理

长期子代理不创建 Job，而由 Subagent Extension 直接持有：

```ts
interface ChildRuntime {
  id: string;
  parentId: string;
  agent: AgentHandle;
  store: SessionStore;
  mode: "continuable";
  status: "running" | "waiting" | "settled";
}
```

这里的 `store` 是 child 的内部 transcript 存储，不是用户可切换的主 Session。它可以复用 v1 消息存储原语，但不参与 root session 的切换、fork、lane 或历史树。第一版若没有可靠的持久化和恢复实现，应明确是进程内 child；不能把 child store 的存在误称为跨重启恢复。

“不是用户级 Session”不等于“不可查看”。Continuable child 必须保留一个可读取的运行上下文：

```text
child context
  -> 当前状态、任务描述和进度
  -> 增量输出
  -> 工具调用、结果和错误
  -> 完整 transcript
  -> 可继续接收消息或中断
```

人类通过 UI 或控制接口查看子代理树、状态、实时输出和完整 transcript；root Agent 通过 Subagent Extension 的读取能力按需检查：

```ts
subagent_list()
subagent_status(id)
subagent_output(id, cursor?)
subagent_messages(id, cursor?)
subagent_send(id, message)
subagent_interrupt(id)
```

这些读取和控制操作由 Subagent Extension 实现，不要求 root 切换身份或切换 Session。默认只把短状态通知送入 root 上下文；完整过程由 root 主动读取，避免每个子代理增量都自动扩大主上下文。

必须保持以下区别：

```text
查看 child context       != 自动合并 child transcript 到 root history
查看 child context       != 切换 Uina 的主体身份
向 child 发送消息        != 修改 root Session
内部 transcript          != 用户可切换的平级 Session
```

创建流程：

```text
subagent(backgroundMode = "continuable")
  -> 创建 child 执行上下文和 child store
  -> 写入 parentId、provider、model 和创建元数据
  -> 投递初始 prompt
  -> 立即返回 childId
```

子代理可以继续接收：

```text
send_message(childId, message)
interrupt_agent(childId)
```

子代理状态由真实事实推导：

```text
running
  = child Subject 正在运行，或已有已接受输入

waiting
  = child Subject 空闲，但仍然保留并可能接收消息

settled
  = child 已显式关闭或发生不可恢复终止，且其资源已经释放
```

空闲不等于 settled。Continuable child 可以长期处于 `waiting` 并继续接收消息；只有 `close`、父级销毁或不可恢复错误完成资源释放后，才进入 `settled`。Subagent Extension 可以保存这个投影状态，但不得再维护一套与 AgentHandle 相互竞争的执行状态机。

## 子代理消息与结算

子代理主动发送给父 Agent 的内容和运行时结算通知必须区分来源：

```ts
type SubagentMessageSource = {
  kind: "agent-message";
  type: "relay";
  ref: string;
};

type SubagentSettledSource = {
  kind: "runtime";
  type: "subagent-settled";
  ref: string;
};
```

结算流程：

```text
child Subject 结束
  -> Subagent Extension 确认 child 终态
  -> 持久化 child 必要结算事实
  -> 向 parent AgentHandle 提交 settled notice
  -> 释放 child 资源
```

父 Agent 忙时，notice 进入下一步队列；父 Agent 空闲时，notice 触发一次 follow-up。通知提交成功不等于父 Agent 已经读完结果。子代理完整历史仍留在 child store，父 Agent 需要详细内容时通过明确的 `subagent_output`、`subagent_messages` 或等价读取能力获取。通知与 child 主动 relay 必须保留不同的 source，避免把运行时事实错误归因给子代理。

## 取消、关闭与未知结果

### 取消普通 Job

```text
job_kill
  -> cancel(reason)
  -> running 变成 stopping
  -> 等待 producer.done
  -> killed / failed / unknown
```

不能因为 `cancel()` 调用成功就报告外部工作已经停止。

### 取消子代理

```text
interrupt_agent
  -> child Subject.interrupt()
  -> child Agent Loop 真实结束
  -> child settled
  -> parent 收到结算通知
```

### 进程关闭

```text
关闭开始
  -> 停止接受新的后台任务和子代理输入
  -> 请求取消 root owner 的 Job 和 child
  -> 等待 producer 和 Subject 完成可确认的释放
  -> 对仍未确认的外部副作用记录关闭诊断，不伪造终态
  -> 释放扩展资源
```

关闭等待属于宿主生命周期，不是 Agent Loop 的任务超时。若宿主最终被强制终止，进程内 Job/child 的恢复能力仍然是未实现能力。

## 前端状态投影

UI 不直接消费 Job completion listener，也不自行推断生命周期。扩展提供权威快照：

```ts
interface RuntimeSnapshot {
  root: AgentSummary;
  jobs: readonly JobSnapshot[];
  subagents: readonly SubagentSummary[];
}
```

连接建立时发送完整 baseline；状态变化时发送对应列表的 replacement：

```text
baseline
  -> jobs replacement
  -> subagents replacement
  -> root queue replacement
```

这套 control stream 属于 UI/扩展适配层，不进入 Uina 内核。前端展示：

- Job 的 running、stopping、completed、killed、failed、unknown；
- Job 标签、类型、状态详情和耗时；
- 子代理的 parentId、名称、运行状态和层级；
- 子代理当前任务描述、进度、增量输出和可查看的 transcript；
- root Subject 当前排队输入和 Agent 状态。

子代理在 UI 中是主 Uina 的派生工作节点，可以打开检查和控制面板，但不是可切换的平级 Session 列表项。

## 扩展接缝

第一版不增加全局 `job_accepted`、`job_update` 或 `job_resolved` 钩子，也不增加 `subagent_*` 全局钩子。

Jobs Extension 内部只需提供：

```ts
onChanged(listener: (ownerId: string) => void): Dispose;
onResolved(listener: (job: JobSnapshot) => void): Dispose;
```

Subagent Extension 内部只需提供：

```ts
onChanged(listener: () => void): Dispose;
onSettled(listener: (childId: string) => void): Dispose;
```

这些是扩展服务接口，不是 Uina 内核事件。内核已有的 `agent_*`、`turn_*`、`message_*`、`tool_execution_*` 和 `context` 事件仍然可以观察子代理和后台通知实际经过的 Agent 行为。

扩展之间只通过稳定服务接口和通用 AgentHandle 组合：

```text
Jobs Extension
  -> JobRegistry.start/get/list/read/cancel/wait
  -> onChanged/onResolved

Subagent Extension
  -> AgentFactory.create
  -> child AgentHandle
  -> Jobs Extension（仅 one-shot background）
```

`parentId`、`jobId`、`subagentId` 是扩展内部的引用，不进入核心类型的业务分支。只有当多个独立扩展确实需要同一生命周期观察点时，才考虑把某个扩展 listener 提升为公共事件；在此之前增加全局 Job/Subagent 钩子只会扩大核心 API，而不会增加能力。

## 与 DSH 的对应和有意差异

| DSH 能力 | Uina 方案 | 原因 |
| --- | --- | --- |
| `jobs.start/get/list/read/kill/wait` | Jobs Extension 提供同名语义的最小服务 | 直接复用成熟的查询、等待、取消和 owner 隔离行为 |
| `running -> stopping -> completed/killed/failed` | 保留；必要时增加 `unknown` | `stopping` 只表示已请求取消，避免伪造外部停止事实 |
| completion notice + `job_output` | 保留，但经通用 mailbox 投递 | 不重入 Agent Loop，不把大输出自动塞进上下文 |
| baseline + replacement 状态同步 | 作为 UI/扩展适配层实现 | TUI/Web 只读权威快照，不自建生命周期 |
| continuable child 的独立 Session | 改成可观察的内部 transcript/context | 保留独立运行和查看能力，但 Uina 不提供用户级多 Session 工作台 |
| DSH 的 scope/controller 组合 | 简化为 owner capability/扩展装载范围 | 当前 Uina 没有 DSH 的 scope 系统，不复制其框架复杂度 |
| DSH 的进程内实现 | 第一版同样进程内 | 先验证行为；不虚构跨重启恢复 |

可以直接借鉴 DSH 的行为不变量和默认策略，但不机械复制其 package、scope、Session Controller 或第二套 Agent 状态机。`maxConcurrentJobsPerOwner = 10`、`job_output` 默认等待 30 秒、最大等待 600 秒仍是 Jobs Extension 的可配置运行策略；它们不进入核心，也不构成工具轮次、模型调用次数或子代理深度限制。没有 DSH 对应依据的审批、沙箱、白名单、隐式超时和自动截断不加入本设计。

Job 创建顺序是 Uina 相对 DSH 的一个有意实现调整：先安装可查询的运行记录，再启动 producer。这样能让“已返回 ID 但启动失败”成为可解释的 Job 终态；它不改变 DSH 对外可见的 `start/read/wait/kill` 语义，也不要求复制 DSH 的 scope 框架。

## 实现顺序

### 阶段一：普通 Job

已实现通用 runtime input 接缝、进程内 `JobRegistry`、`job_output`、`job_list`、`job_kill`、shell 后台 producer，以及通用 `AgentHandle`/`AgentFactory` 和首版可持续子代理。

验收：

```text
后台调用立即返回 Job ID
前端/CLI 能看到 running
job_output 能读取结果
kill 经过 stopping 再到终态
完成通知只发摘要
通知不会破坏 root Subject 的 active run 和 idle waiter
```

### 阶段二：一次性子代理（后续）

让 Subagent Extension 通过 Jobs Extension 托管 one-shot child，验证父 Agent 忙/闲两种通知路径。

### 阶段三：长期子代理（已实现首版）

已实现通用 AgentFactory 的 child handle、进程内 transcript、扩展私有 `parentId`、消息发送、中断、runtime notice 和 `subagent_messages` 读取。首版验证 child 可多轮工作、按 cursor 读取输出且不污染主历史；没有持久化恢复能力。

### 阶段四：状态投影（未实现）

当前尚未为 TUI 增加主 Agent、子代理和 Job 的快照展示；未来需要 Web 时再复用 baseline/replacement control stream。本轮不修改 `src/ui_new/**`。

## 验收场景

- shell 后台任务立即返回 ID，完成后主 Agent 收到通知并按需读取结果；
- 多个后台任务同时结束时，主 Agent 不被并发启动多个 run；
- 主 Agent 忙时完成通知进入下一步队列，空闲时只唤醒一个受预算控制的新回合；
- kill 请求不会把 stopping 伪造为 killed；
- producer 释放失败或外部副作用未知时不会伪造成功；
- 可持续子代理的完整 transcript 不自动进入主上下文；
- 长期子代理可以接收多轮消息，并在结束后通知父 Agent；
- 子代理状态展示能区分 running、waiting 和 settled；
- UI 重连先获得完整 baseline，任务删除后列表不会残留；
- root Subject、后台任务和子代理关闭时没有未等待的运行资源。

## 第一阶段明确不承诺

- 进程异常退出后的 Job/child 自动恢复、对账或补投；
- 把子代理作为用户级 Session 切换或直接进入其 Session；查看 child context、读取 transcript 和执行控制仍然支持；
- 把子代理作为与 root 平级的用户会话切换；子代理内容查看和控制仍然是第一阶段目标；
- 为所有 Job 强制统一超时、重试、输出大小或执行并发；这些由 producer/Jobs 配置按实际资源需要定义；
- 递归子代理深度、模型轮次或工具调用次数上限；除非未来出现可测量的资源问题并形成独立策略，否则不把它们写进核心；
- UI 尚未具备 Jobs/Subagent 专用展示；当前任务状态可通过模型工具和后台完成 notice 观察，状态投影需要单独实现和验证。

## 评审结论与证据状态

经本次核对，原文的方向符合 Uina 的连续主体、微内核和开放接缝原则。当前已实现 Job Registry、shell producer、增量读取、root runtime notice、通用 AgentFactory 和首版可持续子代理：

- 已确认的事实：当前有 root `Subject`、主 SessionStore、ModelProvider、ToolBroker、前台 Agent Loop、进程内 JobRegistry、shell 后台 producer、AgentFactory 和 Subagent Registry。
- 设计决定：Job 与 Subagent 属于扩展；one-shot child 可由 Jobs 托管，continuable child 由 Subagent Extension 直接持有；root 始终是唯一用户主体。
- 已验证的实现：Job ID、状态、owner 隔离、增量输出、shell 后台 producer、root runtime input 投影和同步/异步测试链路。
- 未验证或未实现：TUI 快照、异常退出恢复和跨重启关闭对账；child transcript 当前通过模型工具输出读取，尚无专用 UI inspector。
- 第一条可审计纵切已通过：root mailbox 接收 runtime notice -> Job Registry 启动 shell 后台任务 -> 返回 Job ID -> 结束后按需 `job_output` -> root 收到短通知。

在这条纵切通过前，不实现多种 Job producer、可恢复 child、Web control stream 或更复杂的全局事件。这样可以验证 DSH 功能是否真的需要新增 Uina 接缝，也能在不改变主 Session 语义的情况下回退或删除候选实现。

## 参考代码

DSH 参考实现：

- `packages/jobs/jobs/src/types.ts`
- `packages/jobs/jobs-local/src/index.ts`
- `packages/jobs/tool-jobs/src/index.ts`
- `packages/subagent/tool-subagent/src/index.ts`
- `packages/subagent/subagent/src/continuation.ts`
- `packages/api/session-controller/src/control.ts`
- `packages/client/ui-jobs/src/client/JobListAction.tsx`
- `packages/client/ui-workspace/src/client/subagent-lineage.ts`

Uina 当前相关边界：

- `src/agent/loop.ts`
- `src/session/types.ts`
- `src/tools/broker.ts`
- `src/tools/loader.ts`
- `src/core/types.ts`
