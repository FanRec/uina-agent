# DeepSeek Harness 后台工作参考

状态：参考实现分析，不代表 Uina 已实现这些能力。

本文记录 `E:\Uina\ThirdParty\deepseek-harness` 中与后台任务、子代理和前端会话活动展示有关的实现。它用于 Uina 后续设计时查阅，不作为直接迁移方案。

## 总体分层

参考项目没有把所有后台工作强行统一成一种状态机，而是分成两类：

```text
一次性后台工作
  -> ctx.jobs / JobRegistry

长期可交互子代理
  -> ctx.subagents / 持久 Session / Agent activation
```

普通 Job 适合 shell、一次性子代理和其他可托管工作。Continuable subagent 有自己的 Session、inbox 和 Agent Loop，不创建中间 Job。

## 普通 Job

### 核心接口

参考位置：

- `packages/jobs/jobs/src/types.ts`
- `packages/jobs/jobs-local/src/index.ts`

生产者通过 `JobStart` 注册工作：

```ts
interface JobStart {
  kind: JobKind;
  label: string;
  owner?: Agent;
  run(): JobHooks;
}
```

`run()` 同步返回运行控制句柄：

```ts
interface JobHooks {
  cancel(reason?: string): void;
  done: Promise<JobOutcome>;
  readOutput?(): string;
}
```

Registry 管理身份、状态、权限、等待和通知；生产者负责真正启动和释放进程、子代理或其他外部资源。

### 状态

```text
running -> stopping -> completed | killed | failed
```

`stopping` 表示已经请求取消，不表示外部工作已经停止。只有生产者的 `done` 完成后，Registry 才记录最终状态。

`JobSnapshot` 保存：

- Registry 分配的 Job ID；
- 类型和展示标签；
- owner session；
- 当前状态；
- detail、开始时间和完成时间；
- 是否已经被读取、等待、取消或通知处理。

### 创建流程

以后台子代理为例，生产代码在 `packages/subagent/tool-subagent/src/index.ts`：

```text
模型调用 subagent 工具
  -> 解析父 Agent、Provider 和请求选项
  -> jobs.start({ kind, label, owner, run })
  -> Registry 分配 jobId 并保存记录
  -> run 内启动子代理
  -> 工具立即返回 jobId
```

Shell 工具 `tool-bash`、`tool-pwsh` 和 `tool-terminal` 使用相同的后台模式：`run_in_background: true` 时立即返回 Job ID，进程继续在后台运行。

关键顺序是：

```text
Job 记录注册成功
  -> 启动可托管工作
  -> 监听 hooks.done
```

Registry 在注册时会检查 owner、控制器、任务类型、标签和活跃任务数量，并在 owner 或服务销毁时取消和等待任务。

### 结束流程

`hooks.done` resolved 后进入 `settle(job, outcome)`：

```text
写入终态、detail、output、finishedAt
  -> 释放 waiters
  -> 标记 settled
  -> 通知 jobs changed
  -> 通知完成监听器
```

先提交快照，再通知观察者。这样前端或其他消费者收到通知后重新读取时，看到的是已经提交的状态。

如果 `done` promise reject，Registry 会记录警告并将 Job 转为 `failed`，避免等待者永久挂起。

## 完成结果回传给主 Agent

参考位置：`packages/jobs/tool-jobs/src/index.ts`。

完成监听器 `onJobDone` 不会直接调用模型，而是创建一条有明确来源标记的运行时通知：

```text
后台 Job 完成
  -> onJobDone(snapshot, owner)
  -> 构造短 completion notice
  -> owner idle：followup，唤醒 Agent
  -> owner busy：inject，进入 next-step inbox
  -> Agent 下一步读取通知
  -> 模型按需调用 job_output(jobId)
```

通知只包含 Job ID、状态摘要和收集指引，不自动注入完整输出：

```text
background job bash-1 ... finished ...
Read its output with job_output.
```

这将“知道任务结束”和“读取大结果”分开，避免后台输出直接撑大模型上下文。

`job_output` 支持：

- 流式 Job：读取上一次读取之后的新输出；
- 最终结果 Job：结束后读取最终 output；
- `wait: true`：等待终态，但超时只返回当前状态，不取消任务。

`job_kill` 只请求取消，立即返回 `cancellation-requested`；最终结果仍由 producer 的 `done` 决定。

## 前端后台任务展示

参考位置：

- `packages/api/session-controller/src/control.ts`
- `packages/api/session-controller/src/types.ts`
- `packages/client/ui-jobs/src/client/JobListAction.tsx`

前端不直接订阅 `onJobDone`。Session Controller 订阅 `onJobsChanged`，为每次连接提供：

```text
baseline
  - queues
  - jobs
  - projections

之后：
  - queue replacement
  - jobs replacement
  - projection update
```

Job 发生创建、状态变化、完成或移除时，服务端重新读取该 owner 可见的完整 Job 列表，发送一个 `jobs` replacement frame。前端只维护列表镜像，不自行推断任务状态机。

会话头部只有在该 Session 存在 Job 时显示任务入口。列表展示 running、stopping、completed、killed、failed、标签、类型、状态详情和耗时。

这个模式同时解决了重连和删除问题：重新连接先获得完整 baseline，后续变化直接替换对应 Session 的列表。

## Continuable 子代理

参考位置：`packages/subagent/subagent/src/continuation.ts`。

长期子代理不走普通 Job Registry，而是拥有：

```text
持久 childId
持久 Session
自己的 Agent activation
自己的 inbox
自己的 Agent Loop
```

其 residency 状态由 Agent quiescence 和子代理关系推导：

```text
running
  -> waiting：自身空闲但仍持有未结束的子代理
  -> settled：自身和所有后代都结束，释放 activation
```

它可以在多次回合中继续接收消息，因此不能把一个长期子代理简化为“启动一次、返回一次结果”的 Job。

## 子代理前端展示

参考位置：

- `packages/client/ui-workspace/src/client/subagent-lineage.ts`
- `packages/client/ui-workspace/src/client/rows/Rows.tsx`

Session summary 保存 `origin: subagent`、`parentId` 和 `running`。前端沿 `parentId` 向上聚合后代数量和运行数量：

```text
Session summaries
  -> parentId lineage projection
  -> runningCount
  -> 父 Session 侧边栏显示 “N subagent running”
```

这与 Job 列表是两种不同的展示：Job 显示可收集的后台工作；Session lineage 显示可导航、可继续交互的子代理。

## 子代理完成回传

Continuable manager 自己负责把子代理结束通知送回父 Agent。它不依赖外部 `subagent/end` 监听器，因为监听器触发时 child handle 可能已经释放，无法可靠完成父级投递。

运行时通知使用独立来源：

```ts
{
  kind: "subagent-settled",
  form: "notice",
  summary: string,
  senderSessionId: SessionId
}
```

它与子代理主动发送的：

```text
agent-message / relay
```

明确区分，避免把 Runtime 的状态说明错误归因给子代理。

## 对 Uina 的可借鉴原则

1. 一次性后台工作与长期子代理应保持不同抽象。
2. 后台启动返回稳定 ID，完成通知只发短摘要，完整结果按需读取。
3. Agent 忙时把通知放入下一步队列，Agent 空闲时才唤醒；不强行打断正在进行的模型回合。
4. 前端用完整 baseline 加列表 replacement 同步权威状态，不自行维护第二套生命周期。
5. 运行状态、持久化历史、UI projection 和 Agent 通知分开。
6. 生产者负责外部资源，Registry 负责身份、所有权、取消和终态发布。
7. `stopping` 不等于已经停止，必须等待生产者确认。

## 可直接借鉴的运行策略

### Job 数量上限

`jobs-local` 默认每个 owner 最多 10 个活跃 Job。作为成熟 Harness 的运行策略，这个限制可以作为 Uina 的默认参考；实现时仍应把它放在 JobBroker 配置中，而不是写死进 Agent Loop。它保护的是单个 owner 的资源占用，不改变 Job 的生命周期语义。

### Job Registry 的进程内存储

参考实现的普通 Job Registry 是 process-local。这个轻量边界适合作为 Uina 第一版普通 Job 的实现；进程重启后的任务恢复则应作为后续能力单独增加。需要跨重启时，必须定义持久化、对账和 `unknown` 状态，不能从进程静默推断任务失败或取消。

### 终态集合

参考普通 Job 主要使用 `completed`、`killed` 和 `failed`。Uina 可以沿用这组清晰的常规终态；涉及已经发出外部副作用但无法确认结果的场景，再扩展 `unknown`，防止伪造成功、失败或取消。

### 完成通知的预算

参考项目对 completion notice 和输出读取有生产者提供的字节限制。这个做法可以直接作为 Uina 的输出保护策略，具体预算保持在 Job producer 或 JobBroker 配置，不泄漏成 Agent Loop 的上下文规则。

这些策略都允许 Uina 借鉴 DSH 的成熟实现，但仍要区分：

```text
Job 生命周期语义：稳定接口和不变量
运行策略：数量、输出、等待和存储配置
```

前者应保持统一，后者可以按照 Uina 的设备、Provider 和部署容量调整。

## Uina 后续设计提示

Uina 可以先实现内部 `JobBroker`，而不是立即增加三个全局事件：

```ts
start(spec): JobId;
get(id): JobSnapshot;
list(owner): JobSnapshot[];
read(id): JobRead;
cancel(id): Promise<CancelReceipt>;
wait(id): Promise<JobSnapshot>;
onChanged(listener): Dispose;
onResolved(listener): Dispose;
```

只有当多个独立扩展确实需要订阅统一 Job 生命周期时，再将 `accepted`、`update`、`resolved` 提升为公共事件。事件应是 Registry 的发布面，不应成为第二套 Job 状态机。

## 代码依据

本记录主要依据以下当前源码：

- `packages/jobs/jobs/src/types.ts`
- `packages/jobs/jobs-local/src/index.ts`
- `packages/jobs/tool-jobs/src/index.ts`
- `packages/subagent/tool-subagent/src/index.ts`
- `packages/subagent/subagent/src/continuation.ts`
- `packages/subagent/subagent/src/lifecycle.ts`
- `packages/api/session-controller/src/control.ts`
- `packages/api/session-controller/src/types.ts`
- `packages/client/ui-jobs/src/client/JobListAction.tsx`
- `packages/client/ui-workspace/src/client/subagent-lineage.ts`
- `apps/web/tests/background-job-list.e2e.ts`
- `apps/web/tests/sidebar-subagent-activity.e2e.ts`
