# RuntimeHooks：纠正 ExtensionHost 依赖方向

状态：已实现；真实 Provider 服务端与 child 专属 scope 的产品接入仍未验证。

本文记录 Uina 对 RuntimeHooks 的最终设计决策。这里的“一劳永逸”指依赖方向和所有权不再反复调整，而不是以后永远不增加 hook。

## 最终决策

> 保留 Pi 式扩展 API；建立唯一、内核定义、无状态的 `RuntimeHooks` 接缝；`ExtensionHost` 只作为它的一个适配来源；能力由组合层显式注入，生命周期继续由 `ActivationScope` 管理。

## 当前问题

当前存在三条反向依赖：

```text
Subject -> ExtensionHost
ModelRequest -> ExtensionHost
Provider adapters -> ExtensionHost
```

具体表现为：

- `SubjectOptions` 持有 `extensionHost`；
- `ModelRequest` 暴露完整 `ExtensionHost`；
- Provider 可以访问扩展注册、UI、scope 等远超自身需要的能力；
- child 是否继承 root 扩展能力取决于有没有拿到这个全局对象；
- 将来替换 ExtensionHost 会迫使 Agent 和 Provider 一起修改。

根因不是类名，而是 Core 得到了一个能力过大的具体宿主对象。

## 最终架构

```text
Project/Builtin Extension
          │
          ▼
 ExtensionRunner
 ActivationScope
 ExtensionHost
          │
          ▼
 createRuntimeHooks(host)
          │
          ▼
      RuntimeHooks
       ├─ turn
       ├─ tools
       ├─ provider
       └─ events
          │
      ┌───┴──────────┐
      ▼              ▼
   Subject       Provider adapter
```

依赖方向固定为：

```text
core
  ↑
runtime hooks
  ↑
agent / ai
  ↑
extensions
  ↑
cli composition
```

硬性规则：

- `core/agent/ai/runtime` 不得 import `extensions`；
- `extensions` 可以依赖内核合同；
- `cli` 是唯一能够同时认识 Runtime、Extensions、UI 的组合根；
- UI 不参与 RuntimeHooks 的状态转移；
- Jobs/Subagents 继续属于扩展，不进入 RuntimeHooks 的业务类型。

## RuntimeHooks

新增：

```text
src/runtime/hooks.ts
src/runtime/noop.ts
```

建议合同：

```ts
interface RuntimeHooks {
  readonly turn: TurnHooks;
  readonly tools: ToolHooks;
  readonly provider: ProviderHooks;
  readonly events: RuntimeEvents;
}
```

所有输入应尽可能使用 `readonly` 数据；transform 必须返回下一值或明确返回原值，不能依赖原地修改对象来绕过 hook 顺序与所有权。

### TurnHooks

只负责 Agent 回合的可变换接缝：

```ts
interface TurnHooks {
  prepare(input: Readonly<{
    prompt: string;
    systemPrompt: string;
  }>): Promise<{
    systemPrompt?: string;
    messages?: readonly ChatMsg[];
  }>;

  transformContext(messages: readonly DeepReadonly<ChatMsg>[]): Promise<ChatMsg[]>;

  beforeCompact(input: Readonly<{
    tokensBefore: number;
  }>): Promise<{
    cancel?: boolean;
  }>;
}
```

### ToolHooks

只负责工具执行边界：

```ts
interface ToolHooks {
  beforeCall(input: Readonly<{
    callId: string;
    name: string;
    args: DeepReadonly<Record<string, unknown>>;
  }>): Promise<{
    block?: boolean;
    reason?: string;
  }>;

  transformResult(input: Readonly<{
    callId: string;
    name: string;
    args: DeepReadonly<Record<string, unknown>>;
    result: string;
    status: ToolResultStatus;
  }>): Promise<{
    result?: string;
    status?: ToolResultStatus;
  }>;
}
```

扩展只能显式返回 `block` 才能阻止工具。handler 抛错不能被解释为 block，也不能伪造工具成功或失败。

### ProviderHooks

这是唯一可以进入 `ModelRequest` 的 facet：

```ts
interface ProviderHooks {
  transformHeaders(
    provider: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<Record<string, string>>;

  transformPayload(
    provider: string,
    payload: DeepReadonly<unknown>,
  ): Promise<unknown>;

  observeResponse(input: Readonly<{
    provider: string;
    status: number;
    headers: Record<string, string>;
  }>): Promise<void>;
}
```

`ModelRequest` 从：

```ts
extensionHost?: ExtensionHost;
```

改成：

```ts
providerHooks: ProviderHooks;
```

Provider 只能看到 transport middleware，无法访问扩展列表、UI、命令、scope 或 runner。

内建 OpenAI、Anthropic、Gemini 必须遵守该合同。第三方 Provider 若拥有原始 HTTP transport，也应调用这些 hook；没有可暴露 transport 的远程 Provider 可以合法忽略不适用的阶段，不能伪造调用。

### RuntimeEvents

事件分成两类：

```ts
interface RuntimeEvents {
  emit(event: RuntimeEvent): Promise<void>;
  observe(event: OutputEvent): void;
  flush(): Promise<void>;
}
```

`RuntimeEvent` 是关闭的联合类型，仅包含真实运行事实：

- model selected；
- thinking level selected；
- agent start/end/settled；
- turn start/end；
- compaction completed/failed。

`OutputEvent` 只包含高频输出生命周期：

- output start；
- output update；
- output end；
- output interrupted。

这里的 `emit()` 不是公开事件总线：

- 不能接受任意字符串；
- 不能由扩展发明 Runtime 事件；
- 事件类型只能由内核合同定义；
- Project Extension 仍通过 `pi.on()` 消费这些事件。

`observe()` 保持非阻塞；`flush()` 必须在 `activeRun` 结算前完成。

## No-op 实现

提供唯一不可变实例：

```ts
export const NO_RUNTIME_HOOKS: RuntimeHooks;
```

规则：

- transform 返回原值；
- decision 返回空决定；
- events 不做任何事；
- flush 立即完成。

`Subject`、`AgentFactory` 不再接受 `undefined` hook，也不散落 `?.`：

```ts
runtimeHooks: RuntimeHooks = NO_RUNTIME_HOOKS;
```

这样无扩展 Agent 是一等运行模式，不是特殊兜底。

## ExtensionHost 与 Adapter

不把 Adapter 做成有状态类。只需要一个纯适配函数：

```ts
function createRuntimeHooks(host: ExtensionHost): RuntimeHooks;
```

它负责：

```text
turn.prepare
  -> host.emitBeforeAgentStart

turn.transformContext
  -> host.emitContext

tools.beforeCall
  -> host.emitToolCall

tools.transformResult
  -> host.emitToolResult

provider.*
  -> 对应 provider events

events.emit/observe/flush
  -> host lifecycle dispatch
```

Adapter 不得：

- 缓存 handler；
- 保存 activation；
- 复制错误记录；
- 保存 Agent 状态；
- 创建第二个事件队列；
- 推断 Job/Subagent 状态；
- 持有 UI。

它始终调用当前 Host，因此 reload 后：

- 已卸载 extension 不再执行；
- 新 activation 立即生效；
- root Agent 和 Provider 无需重新创建；
- source attribution 仍由 Host 保证。

未来 child 专属能力不能创建第二个 Host；应由当前 Host/Runner 产出按 scope 过滤的 RuntimeHooks view。这样仍然只有一个 handler、错误和 activation 状态 owner。

## ExtensionHost 的职责

ExtensionHost 保留：

- typed handler 注册与顺序；
- handler transform 链；
- handler 异常隔离；
- extension source attribution；
- observed output 队列；
- flush；
- Extension API 的事件面。

ExtensionRunner/ActivationScope 保留：

- builtin/project 加载；
- tool/command/provider/renderer 注册；
- disposer；
- reload；
- scope ownership；
- UI contribution 清理。

RuntimeHooks 不负责注册；它只是“运行时调用扩展能力”的窄出口。

## 扩展作者体验

公开扩展 API 保持 Pi 风格：

```ts
export default function activate(pi) {
  pi.on("context", async (event) => {
    return { messages: event.messages };
  });

  pi.on("tool_call", async (event) => {
    if (...) return { block: true, reason: "..." };
  });

  pi.registerTool(...);
  pi.registerCommand(...);
  pi.registerProvider(...);
  pi.ui.setWidget(...);
}
```

普通扩展不认识：

- RuntimeHooks；
- Adapter；
- Subject；
- Provider request internals；
- ActivationScope 实现；
- CLI composition。

因此扩展开发复杂度不会高于 Pi。

只有新增一种能够改变 Agent 确定性执行语义的能力，才需要修改 RuntimeHooks。这属于内核 API 变更，必须经过明确设计，而不是让扩展通过全局 Host 偷渡。

## root 与 child scope

`AgentCreateOptions` 增加：

```ts
runtimeHooks?: RuntimeHooks;
```

实际构造时归一化为 no-op。

### root

CLI 负责：

```text
create ExtensionRunner
create RuntimeHooks adapter
create root Subject(runtimeHooks)
```

### child

默认：

```text
DefaultAgentFactory
  -> NO_RUNTIME_HOOKS
```

child 不隐式继承 root 扩展。

未来需要 child 专属扩展时：

```text
Subagent Extension
  -> 由现有 Runner 创建 child-scope RuntimeHooks view
  -> AgentFactory.create({ runtimeHooks: childHooks })
```

是否继承能力由 Subagent Extension 明确决定，不由全局对象可见性决定。这吸收 DSH 的 scope-local capability 思路，但不引入 Cordis Container。

## Provider 注册

`registerProvider()` 继续接收 `ModelProvider`，不强制引入 Provider Factory。

Provider 每次收到 `ModelRequest.providerHooks`：

- 内建 Provider 必须使用；
- 项目 Provider 可使用；
- Provider 不能获得完整 RuntimeHooks；
- Provider 不能反向调用 Agent、UI、Job 或 ExtensionRunner。

如果未来远端 Provider 没有可编辑的 raw payload，它只执行适用阶段。不要为统一表面而制造假 header/payload。

只有未来出现构造期 transport、共享连接池或协议客户端生命周期需求时，再独立引入 Provider Factory；当前不提前实现。

## 快路径与慢路径

该重构不增加：

- 模型调用；
- 网络请求；
- 工具轮次；
- 队列；
- 状态副本；
- 并发限制；
- 自动重试。

快路径仍然是：

```text
input
 -> prepare/context hooks
 -> provider
 -> first token
```

原有 hook 本来就在路径中，Adapter 只增加一次普通函数调用。

高频 `output_update` 继续走 Host 已有的非阻塞 observation 队列；不逐 token await extension handler。最终 `flush()` 仍由 `activeRun` 等待。

Jobs、Subagents、compaction、资源刷新继续属于慢路径，不借本次重构扩张功能。

## 错误规则

必须冻结为合同：

- 单个 extension handler 抛错：Host 报告来源，其他 handler 继续；
- transform handler 抛错：保留上一个有效值；
- tool preflight 抛错：不自动 block，也不执行伪造结果；
- provider transform 抛错：错误必须可见；是否保留原值沿用当前 Host 语义并写入测试；
- Adapter 自身抛错：视为运行时基础设施错误，不静默吞掉；
- observer 抛错：不改变已提交的 Agent/Tool/Provider 事实；
- flush 失败：`activeRun` 必须完成资源结算，但向用户报告诊断；
- UI listener 失败：不得改变 Agent 业务结果。

不得添加“为了安全”而吞错、回退成功或制造默认结果的分支。

## 迁移顺序

基线：`9838057`。

### 阶段一：行为定格

先为当前行为补 characterization tests：

- context handler 顺序；
- before-agent-start patch 合并；
- tool block；
- tool result 链式变换；
- provider headers/payload/response；
- lifecycle emit 顺序；
- output observe + flush；
- handler error source；
- reload 后旧 handler 失效。

测试证明当前行为，不在这里重设计事件语义。

### 阶段二：合同与 Adapter

新增：

```text
src/runtime/hooks.ts
src/runtime/noop.ts
src/extensions/runtime-hooks.ts
```

Host 继续原样工作，Adapter 映射现有行为。

### 阶段三：Subject

- `SubjectOptions.extensionHost` 删除；
- 改为 `runtimeHooks`；
- 所有直接 Host 调用改为对应 facet；
- compaction、tool、lifecycle、output 顺序保持不变。

### 阶段四：Provider

- `ModelRequest.extensionHost` 删除；
- 改为 `providerHooks`；
- OpenAI、Anthropic、Gemini 全部迁移；
- Subject 只把 `runtimeHooks.provider` 交给 Provider。

### 阶段五：AgentFactory 与 composition

- AgentFactory 支持显式 RuntimeHooks；
- root 注入 Adapter；
- child 默认 no-op；
- CLI 保持唯一 composition root。

### 阶段六：删除旧路径

一次删除：

- 所有 `extensionHost` request/options 字段；
- agent/core/ai 对 extensions 的 import；
- 临时适配；
- 旧测试 helper；
- 文档中的旧依赖图。

不保留 deprecated alias、兼容参数或双 dispatch。

## 架构质量门

加入一个有实际意义的边界检查：

```text
src/core      禁止 import src/extensions、src/ui、src/cli
src/runtime   禁止 import src/extensions、src/ui、src/cli
src/agent     禁止 import src/extensions、src/ui、src/cli
src/ai        禁止 import src/extensions、src/ui、src/cli
src/extensions 可以 import core/runtime/agent/ai/tools
src/cli       可以组装全部模块
```

建议用轻量 import-boundary 测试或脚本，不引入完整 lint 框架。

该检查纳入统一验证命令，防止未来重新把 Host 塞回 ModelRequest。

## 验收证据

必须通过：

- `pnpm typecheck`；
- `pnpm test`；
- `pnpm build`；
- import boundary check；
- OpenAI-compatible 本地 SSE；
- CLI one-shot；
- tool call/result 回注；
- context transform；
- provider request transform；
- 取消与 partial output；
- output channel 成对结束；
- extension reload；
- child 默认不继承 root hook。

静态证明：

```text
rg ExtensionHost src/core src/runtime src/agent src/ai
```

结果必须为空。

不宣称完成：

- 真实 DeepSeek/Anthropic/Gemini 服务端验证；
- 远端 Provider transport；
- child extension inheritance；
- 跨进程 extension host；
- DSH 式服务容器。

## 风险与停止条件

主要风险：

- hook 顺序改变；
- transform 错误语义变化；
- output flush 提前或延后；
- root hook 泄漏到 child；
- Provider 忘记调用 middleware；
- Adapter 逐渐长出状态。

停止并重新收缩的条件：

- RuntimeHooks 出现 `registerTool`、`registerCommand`、UI 或 extension path；
- Adapter 保存 handler/scope/Agent 状态；
- RuntimeHooks 接受任意字符串事件；
- Jobs/Subagents 业务状态进入 Port；
- 普通项目扩展必须直接使用 RuntimeHooks；
- 为兼容旧代码长期保留 `extensionHost` 字段。

## 最终决策

实施这套方案。

它比把 `ExtensionHost` 换成同名接口更彻底，但比引入 DSH/Cordis Context、服务容器或完整 Provider Factory 克制得多。

最终取舍是：

- 外部扩展体验学习 Pi；
- scope 与能力可见性学习 DSH；
- Runtime 内核保持 Uina 自己的连续主体模型；
- 只有一个 Host 状态 owner；
- 只有一个内核扩展接缝；
- 只有 CLI 负责组装；
- 不留新旧双路径。
