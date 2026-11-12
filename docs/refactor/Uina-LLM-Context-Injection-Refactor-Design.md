# Uina LLM 信息注入体系重构设计

**版本：** 1.0  
**源码基线：** `FanRec/uina-agent` `main` @ `d0c4e0f9b0662e8806d9efa9eb1d9c3b3b9fed25`（2026-11-08）  
**性质：** 本轮可执行的基础设施设计与重构合同。业务扩展迁移另行实施。

## 1. 目标与本轮范围

让 Uina 对每一次模型请求都能准确回答：**哪些事实和能力由谁提供、为什么此刻可见、处于什么位置、是否仍有效、最终实际发送了什么。**

本轮交付四项基础能力：

1. **Context Source：** 扩展以声明方式提供稳定指引、当前能力、即时观察，不再需要自行构造模型消息。
2. **Request Composer：** 按确定规则把基础指令、会话历史、扩展贡献、工具定义装配成唯一 `RequestProjection`；保留现有请求校验及预算门。
3. **Request Observation：** 为一次真实模型请求建立来源追踪，区分预览、实际语义请求和 Provider 最终发送载荷。
4. **Tool Result Model View：** 让工具执行事实与模型可见结果投影真正分离，并在历史恢复后保持一致。

**本轮包括：** 上述能力的 Core 契约、扩展注册接缝、Host 装配、Provider 追踪、必要的 Tool Result 投影修复、独立测试与文档清理。

**本轮不包括：** Voice/TTS/Speech、Embodiment/Live2D、Minecraft、MCP、Skills 等业务扩展迁移；不重做其提示词、工具描述和状态推送；不重构 `external_event_frame` 协议；不改变 Minecraft 队列/Completion；不实现新记忆系统、输出 XML/Expression Parser、工具搜索/推荐引擎；不改变 Compaction 算法、Journal 事实模型或现有 Agent Loop 的行为控制。

**运行兼容原则：** 业务扩展源码零修改，已安装扩展继续通过旧 Hook 工作。新接口作为今后唯一推荐的信息贡献入口；下一轮完成迁移后删除旧 Hook 的普通注入用途。不要为了“彻底清理”在本轮破坏旧扩展的启动与请求能力，也不要构建一套无限期双轨体系。

## 2. 现状与必须纠正的边界

已确认的调用链：

```text
Host base system + Persona
       │
turn.prepare              ← 可替换 systemPrompt / 追加 messages / 改模型
       │
Session History → ProjectionPolicy / convertToLlm
       │
RequestProjection(messages, tools, thinkingLevel)
       │
turn.transformContext     ← 可替换整个请求；当前 World、Voice、Compaction 等使用
       │
measure → turn.preflight → budget/validation
       │
Provider Adapter → provider.transformPayload → HTTP
```

当前问题不在于缺少统一的请求结构，而在于：

- `turn.prepare.messages`、`turn.prepare.systemPrompt`、`turn.transformContext`、`sendMessage`、`submitInput` 都可承担信息注入；**没有相同粒度的语义与生命周期合同**。
- World/MCP 等扩展直接拼接 System 字符串；动态状态与能力说明难以稳定去重、归属及下线。
- `ModelContextMeta` 是内部来源信息，Provider 序列化时不会天然带过去；**内部知道来源不等于模型知道来源**。
- 现有 `tools.transformResult` 返回模型视图，但 `settleToolExchange` 把原始 `canonical` 结果写入历史；随后模型请求默认从原始历史重建，**模型可见改写可能丢失**。
- `inspectRequest()` 是当前状态的重建预览，不等于活动回合的精确 Request；`provider.transformPayload` 还能改变实际 Wire。
- `external_event_frame` 在 `tools` 里占一个声明但不可执行；这是当前历史投影协议，不应误认为普通可执行工具。

对应源码：`src/agent/loop.ts`、`src/agent/context.ts`、`src/agent/projection.ts`、`src/runtime/hooks.ts`、`src/extensions/host.ts`、`src/extensions/runner.ts`、`src/extensions/world-framework/world-activation.ts`、`src/extensions/event-frames/*`、`src/tools/pipeline.ts`、`src/ai/gateway.ts`。

## 3. 架构与所有权

```text
                    ┌─────────────────────────┐
                    │ Canonical History        │
                    │ input / tool / session   │
                    └────────────┬────────────┘
                                 │ History Projection
 Host System / Persona ──────────┤
                                 │
 Legacy turn.prepare ────────────┤（本轮保留，待迁移）
 Legacy transformContext ────────┤（本轮仍执行 Compaction 等）
                                 ▼
 Context Source Registry ──→ Request Composer ←── Tool Definitions
  guidance/capability/observation │              (+ context tools)
                                 ▼
                        RequestProjection
                        + Assembly Trace
                                 │
                   measure / preflight / validate
                                 │
                         Provider Adapter
                                 │
                      provider final wire
                                 │
                     Wire Observation（只观察）
```

严格划分所有权：

| 所有者 | 拥有什么 | 不拥有什么 |
|---|---|---|
| Session / Input | 用户输入、外部事件、工具执行结果等持久事实 | 每请求临时能力快照 |
| 扩展/能力 | 本领域事实、操作工具及其模型可见贡献 | 修改其他扩展信息、操作整个请求的普通权利 |
| Context Source Registry | 带作用域的 Source 定义与注销 | 业务状态、历史、记忆 |
| Request Composer | 确定性位置、渲染、去重、来源报告 | 内容生成、语义理解、重要度评分 |
| Subject | 每次请求的装配时机、模型和上下文预算、预检、最终发送 | Speech、Minecraft 等领域知识 |
| Provider Adapter | 将模型语义请求转成具体 Provider 协议 | 自主追加业务事实与提示词 |
| Request Observation | 检查本次真实请求的语义与 Wire | 向会话注入消息、修改 Session |

**事实持久化、当前快照、工具声明、上下文解释和模型请求是不同责任；不建统一的 `inject(anything)`。**

## 4. Context Source 合同

### 4.1 扩展注册 API

扩展运行时提供 `pi.provideContext(source): () => void`，由激活作用域自动管理生命周期。示意 TypeScript 合同：

```ts
export type ContextSource =
  | {
      id: string;
      kind: "guidance";
      text: string; // 注册时确定；只允许受信任的扩展自身指引
    }
  | {
      id: string;
      kind: "capability" | "observation";
      read(ctx: Readonly<ContextRead>): ContextValue | null |
        Promise<ContextValue | null>;
    };

export interface ContextRead {
  readonly modelKey: string;
  readonly signal: AbortSignal;
}

export interface ContextValue {
  readonly text: string;
  readonly images?: readonly ImageContent[];
  readonly source: {
    readonly type: string;
    readonly origin: "internal" | "external";
    readonly ref?: string;
  };
  readonly observedAt?: string; // 有真实观察时间才填写
  readonly revision?: string;   // 诊断/变化追踪；不参与事实真实性判定
}
```

合同要点：

- `guidance`：扩展作者写下的**稳定、可信的用法/协议**；不随在线状态、请求内容和播放进度频繁变化；不允许把网页、游戏聊天、工具返回等外部数据转换成此类型。
- `capability`：**当前能做什么**；动态状态、可用入口、少量 Affordance。不可用时返回简短真实状态或 `null`，不保留上次成功值。
- `observation`：**此刻提供给模型的事实或证据**；包括当前外部/内部世界快照，也可在未来承载已检索的记忆片段（用 `source.type="memory.recall"` 标出）；可包含文本与图像，必须保留 `origin` 和实际可得的来源信息。**检索证据不等于当前发生的事件**，须在正文中保留原始时间语义。
- `read()` 是**只读快照**：允许按需执行可取消的读取，但不得持久写入、推进游标、消费事件、触发模型请求、产生业务副作用。`inspectRequest()` 调用它不会导致状态消失。
- 返回 `null` 表示本次没有贡献；返回失败不得被伪装成“环境无变化”。失败记录于 Request Trace，非核心 Source 不阻断正常请求。
- Source `id` 只在自身扩展内命名；Registry 实际主键为 `activation-scope + id`。相同激活范围内重名拒绝，注销即时撤下；同一请求开始时固定注册快照，热重载不得把旧 Source 的前半次读取和新 Source 的后半次读取混入同一请求。若已冻结的旧作用域在读取中失效，省略其贡献并记录注销原因。
- Registry 注入真实的扩展 owner；扩展无法通过字符串伪造其他扩展的 Source 身份。来源对外展示由 Composer 负责，而不是让每个 Source 自己拼一层 `[系统]` 前缀。
- `revision` 只用于显示和对照，不实现按 revision 缓存/跳过本次投影的复杂机制；当前 Source 返回值就是权威快照。

**为何三种类型足够：** `guidance` 负责行为协议，`capability` 负责可用行动，`observation` 负责当下事实；新输入走 Input，历史走 Session，工具结果走 Tool Result。它们不是“第四种上下文源”。

### 4.2 典型使用（仅示例，业务扩展本轮不改）

```ts
pi.provideContext({
  id: "expression-protocol",
  kind: "guidance",
  text: "需要说给听众听的文字使用 <speech>...</speech>。",
});

pi.provideContext({
  id: "speech-state",
  kind: "observation",
  read: () => {
    const state = speech.snapshot();
    if (!state.affectsNextDecision) return null;
    return {
      text: state.summary,
      source: { type: "speech.delivery", origin: "internal" },
      observedAt: state.observedAt,
    };
  },
});
```

不为此另建 Speech Context Manager、World Context Manager 或统一信息缓存。

### 4.3 Core 与扩展运行时之间的唯一新接缝

Registry 由**每个 Host 的 ExtensionRunner** 持有，不让 `src/agent` import 扩展实现。`ExtensionAPI.provideContext()` 注册/注销 Source，由 `ResourceScope` 自动持有释放句柄。

在既有 `RuntimeHooks` 中增加一条只读端口（命名可按仓库惯例调整）：

```ts
interface RuntimeHooks {
  // existing turn / tools / provider / events ...
  context: {
    collect(input: ContextRead): Promise<readonly ContextContribution[]>;
  };
}
```

`ContextContribution` 是注册表补齐 `owner/id/kind` 后的不可变值，不是 `ChatMsg`。最小形状如下；`guidance` 的值只有 `text`，另外两种使用 `ContextValue`：

```ts
type ContextContribution = Readonly<{
  key: string;            // 扩展激活身份 + Source 局部 id
  owner: string;          // Registry 填入，不由 Source 自报
  kind: ContextSource["kind"];
  value: { text: string } | ContextValue;
}>;
```

Host 只转交数据，不负责排版模型文本。无扩展时返回空数组，更新 `runtime/noop.ts`、`runtime/guard.ts` 和扩展适配层。Composer 只依赖这条端口，不直接访问 Registry 或扩展的业务服务。此处不再新增第二条 `onHook("context...")` 链，避免“注册 Source”与“Context Hook”两种重复写法。

## 5. Request Composer：确定性装配规则

### 5.1 主路径中的确切顺序

**本轮新 Source 安排在旧 `turn.transformContext` 之后、`measure/preflight` 之前。** 这是为兼容现有 Compaction、World 和 Voice 的必要边界。不能先加入新快照，再让旧 Compaction 把它归入历史摘要。

每次实际模型请求：

1. 使用既有 `turn.prepare` 决定回合参数（只执行当前原有语义，不迁移旧扩展）。
2. 基于 System、Persona、canonical history 和临时 `beforeMessages` 构造基础 `RequestProjection`。
3. 运行现有 `turn.transformContext`（包括原 Compaction），保留旧行为。整个请求级变换只作为**遗留高级接缝**。
4. 读取新的 Source 注册快照；静态 guidance 与动态 `read()` 按固定规则生成贡献。
5. `RequestComposer` 将贡献写入该请求的相应位置，生成 `AssemblyTrace`。原有 `tools` 声明沿用 `ToolBroker.defs() + ProjectionPolicy.contextTools`，不在本轮动态筛选。
6. 对**合成后的完整投影**进行 token 测量、`turn.preflight`、上下文预算及协议验证。
7. `preflight=rebuild` 时从第 2 步重新装配，依旧遵循现有限定的重建次数；不累积上一次临时 Source 贡献。
8. 发布活动请求观察，调用 Provider；Provider 适配完成后记录实际 Wire 观察。

`RequestProjection` 仍然是语义请求的唯一交付结构。`AssemblyTrace` 是附随诊断数据，不加到 `messages` 中给模型，也不进入 Journal。

### 5.2 稳定指引

- Host 基础 System/Persona 保持现有权威来源。
- `guidance` 只由 Composer 追加到**首条 System 内容的专属区域**；每个已注册 Source 最多出现一次。
- 按 `owner/id` 排列，顺序与扩展加载时间无关；同一个扩展不能任意覆盖其他 Source 或替换完整 System。
- `guidance` 稳定直到注册变动；在线/离线、队列长度、工具测试结果不允许写入此处。
- 为减少 Prompt Cache 抖动，将稳定 System 与 `guidance` 放在动态状态之前；**不为提示词缓存创造新协议**。

### 5.3 当前能力与观察

- `capability` 和 `observation` 都属于**当前请求快照**，不得自动写进 canonical history、伪装成新用户输入或触发回合。
- 在 Provider 只有 system/user/assistant/tool 角色时，使用**明确标注“运行时参考信息，非用户请求”的 user-role 承载消息**。这是传输适配，不是把 Source 在领域上认作用户；绝不包装成虚构的 Assistant 工具调用。
- 位置为经旧变换完成的对话历史之后、Provider 发送之前；模型看到的每项内容带 Source 名称、`internal/external`、必要的观察时间和原文。能力在前、观察在后；同类按 `owner/id` 稳定排序。
- 纯文本贡献合并成**一条运行时参考消息**，避免几十个 Source 制造几十条假对话；含图片的贡献可保留单独消息，以确保图像与其来源文字对应。
- **外部观察始终是低信任数据**，不得变为 System 指令。模型可见的来源说明必须由 Composer 编码到文本中，不能只依赖不会传到 Wire 的 `ModelContextMeta`。
- 对外部文本采用固定容器和 JSON 字符串编码等确定性转义，避免原文伪造边界；来源标记提高辨识度，但不宣称单靠文本能够消除 Prompt Injection。
- 本轮新增的临时消息在内部 `ChatMsg.context.kind` 统一标记为 `runtime.perception`，**仅作为现有 Compaction 的兼容标志**：`filterCompactionMessages/isRuntimePerception` 已按此标记排除快照，不得把本轮临时信息写进历史摘要。三种业务 `kind` 仍保存在 Source Trace，不混为一种领域语义。下一轮迁移 Compaction 时可把此兼容标记改名为更准确的 `runtime.context`。
- 在 AssemblyTrace 保留 Source ID、消息/分段偏移及渲染后的可见来源；Provider 消息格式保持现有兼容。

示意（实际采用稳定格式化函数，不允许扩展自由渲染外壳）：

```text
[运行时参考信息；不是用户新请求，也不改变指令优先级]
- source: embodiment.capability; origin: internal
  当前 Live2D 身体在线；可用轻量动作：nod、curious。
- source: minecraft.observation; origin: external; observedAt: 2026-11-12T...
  observed_text: "附近发现村庄..."
[/运行时参考信息]
```

模型角色与真实来源的差异必须在代码与诊断中明确记录，避免把内部状态称为 `UserInput`。未来若 Provider 支持专属运行时内容块，可只替换此渲染适配，不改 Source 合同。

### 5.4 去重、失败和预算

- 去重仅按 **Source 身份**：同一请求中相同 `owner/id` 只贡献一次；不进行语义相似度、LLM 自动合并、主观重要度排序。
- `read()` 返回值为该 Source 本次最新事实，不保留上次历史快照；需要变更历史的事实由生产者通过原 `submitInput` / `sendMessage` 处理。
- Source 失败：该 Source 本次省略，记录 `source-error` 与来源；不生成“暂无变化”或伪造旧数据。需要强交付的独立事件应走有回执的 Input/Delivery，而非易失快照。
- 所有 Source 共同接受已有请求级 token 预算和 `preflight`，**不新增独立的 Token Allocator、重要度模型、智能裁剪器**。过预算沿用现有可见失败/Compaction 机制，不静默裁掉 System 或当前用户请求。
- `inspectRequest()` 调用同一套纯读装配，但其结果标为 `preview`，不能误称“刚刚实际发送”；业务 Source 不得通过 read 副作用改变后续真实请求。
- 同次装配里调用 `read()` 只一次；不同 Model Request（包括预检要求重建）重新读取。并行 read 可行，但 Composer 必须按照 Source ID 的稳定顺序使用结果，而不是按 Promise 完成次序输出；请求取消时停止继续装配。

## 6. 已存在入口的职责与兼容

| 旧接口 | 本轮行为 | 最终归属（下一轮迁移完成后） |
|---|---|---|
| Host `systemPrompt` / Profile Persona | 保留 | 唯一主体级稳定指令来源 |
| `turn.prepare` 的 `model/thinkingLevel` | 保留 | 回合级模型/策略控制 |
| `turn.prepare` 的 `messages/systemPrompt` | **保留兼容，不让新代码使用** | 普通扩展说明迁至 Context Source；不再允许扩展任意改完整 System |
| `turn.transformContext` | **保留兼容，包括 Compaction** | 仅留给少数整体投影机制（如压缩），普通信息禁止使用 |
| `submitInput` / `submitInputs` | 保留 | 真正需要进入主体会话、可能唤醒/推进的外部输入 |
| `sendMessage` / `appendCustomMessage` | 保留 | 需要成为长期对话事实的扩展消息 |
| `registerTool` | 保留注册与 Provider 可见声明 | 工具定义属于行动能力；未来可单独加 Tool View，**本轮不改变默认工具集合** |
| `tools.transformResult` | 修复“可见投影未进入请求” | 工具事实 → 模型可见回执的单独投影 |
| `ProjectionPolicy` | 保留既有 owner | Session→Model History 形塑；不再承担普通扩展临时注入 |
| `provider.transformPayload` | 保留高级适配兼容 | 只做 Provider 协议字段适配，不能成为隐藏 Prompt 注入入口；本轮增加 Wire 追踪 |
| `external_event_frame` | 原样保留 | 当前外部事件历史表示，未来可单独评审；不是 Context Source |
| Compaction | **不迁移，不改算法** | 会话历史投影与预算控制的独立能力 |

**本轮不是建一套新 API 然后同时鼓励旧 Hook 继续用于注入。** 新实现与文档只展示 `provideContext`；旧行为仅为保证原扩展能运行。旧接口取消普通注入能力的时点明确设为“依赖扩展迁移完成后”。

## 7. Tool Result：事实与模型视图必须一致

当前 `tools.transformResult` 只在工具执行后改变一次返回对象，而 `settleToolExchange` 把原始 `canonical` 写入 history；在默认请求链上改写不一定继续进入模型。这是本轮必须修复的基础设施错误。

**决定：** 原始执行事实只保存一份，模型改写结果作为同一条 Tool 消息的**可选模型视图**随该消息持久化，不创建第二份 Tool Message 或另一套 Tool Journal。

```ts
// 在既有 ToolAgentMessage 增加可选字段；旧记录不包含时回落 content/images。
interface ModelToolView {
  readonly content: string;
  readonly images?: ImageContent[];
  readonly details?: unknown; // 内部投影信息，不保证 Provider 会序列化
}
interface ToolAgentMessage {
  // existing: content, images, status, details, tool_call_id, ...
  readonly modelView?: ModelToolView;
}
```

规则：

1. Tool Core 产出 `canonical`（`status`、receipt、实际副作用归它），`tools.transformResult` 允许沿用已有 Hook 合同改写 `result/images/details`，但 **Provider 真正能看见的是 `result/images`**；`details` 只是内部投影元数据，不能冒充模型已读到的内容。绝不允许改执行状态。
2. `settleToolExchange` **一次写入** canonical Tool Message；若存在实际变更，附带 `modelView`。不得只把 `modelView` 放在易失对象里。
3. `convertToLlm`、默认历史投影及 `external_event_frame` 历史转换沿用单一规则：工具结果发给模型时使用 `modelView.content/images ?? canonical.content/images`（字段级回退；`modelView.details` 仅供内部投影）；`status` 仍来自 canonical。
4. Session replay、rewind、Compaction 处理该 Tool Message 时保留模型视图的含义；旧 v4 记录没有该字段则自然回落，不修改 Header 版本或另造迁移器。
5. UI/开发者检查执行事实仍使用 canonical；模型视图可在 Request Inspection 中并列查看。模型视图不得伪称原始执行事实。
6. **若执行原始结果没有被改写，不写冗余 `modelView`。**

本轮只修复通用结果投影链，不调整 Voice/TTS/Minecraft 工具的任何业务回执。

## 8. Request Observation：真实请求可对账

保留现有 `RequestProjection`、`ContextSnapshot`、`inspectRequest()`，补充统一的只读 `RequestAssemblyTrace` 与真实 Wire 观察。

### 8.1 同一请求的三种视图

| 视图 | 来源 | 允许的表述 |
|---|---|---|
| `preview` | 手动 `inspectRequest()` 或 idle 测量 | 按当前状态预测的请求；不承诺曾发送 |
| `active_semantic` | 真实 `decide()` 中 preflight 完成、即将调用 Provider 的 `RequestProjection` | 本次实际交付给 Provider Adapter 的语义请求 |
| `provider_wire` | `provider.transformPayload` 执行后、HTTP 序列化前 | 本次真正准备发送的 Provider 载荷 |

三个视图由同一 `requestId` 关联；`preview` 使用独立 ID，不伪装成活动请求。为避免用消息正文猜测关联，在 `Subject` 创建请求时建立 `requestId`，通过 `ModelRequest` 上的内部诊断字段传到各内置 Provider Adapter，再传到 `sendModelStreamRequest`；该 ID **不进入 Provider 网络载荷**。Provider 的真实发送阶段只观察，不新增可以改写请求的新 Hook。

### 8.2 必须追踪的内容

- 具体 Model 与请求身份；System 的来源段；历史进入与裁剪范围；最终工具名称、顺序及 Schema 指纹。
- 每个新 Source：`owner/id`、`kind`、是否返回内容、`revision/observedAt`、注入到哪条消息和哪个片段、被省略/失败的原因。
- 旧 `turn.prepare` 与 `turn.transformContext`：沿用现有 InjectionProvenance 记录，标记为 **legacy、粒度有限**；不得假称已经得到逐 Source 完整来源。
- Compaction / 重建：前后 Message 数、工具数、Token 测量，实际被发送的最终版本。
- `provider.transformPayload` 前后载荷指纹与结构差异；至少能区分内容、工具声明等模型语义区域是否改变。
- Provider Wire 的实际内容调试：默认只记录摘要和哈希；显式开发者检查时提供经适当脱敏的内容，不在普通 Session Journal 中持久化原始请求、API Key 或敏感 Header。

注意：当前 `inspectRequest()` 不执行活动回合的全部 `turn.prepare`，因此必须维持 `preview` 标记；不能用它代替 `active_semantic`。

### 8.3 Provider 语义边界

- 正常信息贡献必须在 `RequestProjection` 校验与预算检查**之前**完成。
- `provider.transformPayload` 不得作为新的通用注入渠道。保留已有 Hook 的兼容能力，但要在 Trace 中如实显示其修改；不能把改写前的语义请求称作最终 Wire。
- 对已有内置 Provider（OpenAI 风格、Anthropic、Gemini）写集成测试，确认 Wire 观察发生在**最后一次 payload transform 之后**，实际发送之前。未知自定义 Provider 只保证语义请求与其暴露的 Wire 观察边界，不宣称能检查不可见的第三方内部发送行为。
- 不在本轮设计复杂的跨 Provider 逆向解析器；只对已知字段产生必要结构差异。

## 9. 与依赖方的迁移地图（**不在本轮执行**）

| 现有依赖 | 下一轮目标 | 本轮要求 |
|---|---|---|
| Voice `VoicePerception` | `observation`；删除一次性三消息包装 | 继续原路径，源码不改 |
| Speech 输出协议（未来） | `guidance` + 当前 `capability` | 本轮不实现 `<speech>` Parser |
| Live2D / Embodiment | `guidance`、动态 Cue `capability`、必要 `observation` | 工具、Cue 逻辑不动 |
| Minecraft `environmentGuide` | `guidance` | Guide 继续走 `turn.prepare` |
| Minecraft `provideRequestContext` | `observation` 或有回执 `submitInput`，按事实性质选择 | 当前 World/事件链不动 |
| MCP 能力索引 | `capability`；详细内容仍经 MCP 查询 | 原 MCP 扩展不改 |
| Skills 示例 | `capability`（短目录），详细 Skill 按需读取 | 示例和已装扩展不改 |
| Compaction | 长期继续是专业历史投影能力 | 现有 `turn.transformContext` 完整保留 |
| Event Frames | 未来单独评审事件表现形式 | 本轮保持协议兼容和历史对账 |
| 工具选择/暴露 | 未来在 Tool Broker 之上定义 Tool View | 本轮模型工具集合和执行规则不变 |

## 10. 生命周期与关键边界

1. **每次 Model Request 重新取动态快照。** `turn.prepare` 仍然只按原回合时机运行；后续工具回合能看到新的 Capability/Observation。
2. **静态 Guidance 随扩展激活。** 卸载后下一次请求立即不再出现；同一次已生成请求的内容不随中途卸载而被局部改写。
3. **即时快照不持久化、也不自动启动 Agent。** 需要可靠告知/回执的事件依然走 Input/Delivery；不能用易失 Context Source 代替任务完成通知。
4. **外部资料与可信指令分离。** 扩展的代码受到 Host 信任，不等于它读到的所有外部文本都能升级为可信指令。
5. **不保留“上一条正常快照”作为失败回退。** 未知明确标未知；必要时使用来源自己维护且标注时间的权威缓存，而不是 Composer 猜。
6. **断开 Session 与上下文快照。** Session rewind 只改变历史投影；下个请求从当前 Source 重新读取当前真实状态。外部世界不会因 rewind 自动回滚。
7. **全局原始工具定义不变。** 若未来增加 Tool View，模型提交的调用必须与该请求实际暴露的工具集关联校验；本轮不新增过滤与发现策略。
8. **扩展没有普通的请求整体控制权。** 新 Source 只能交出受限内容，不能修改 `model/turn/tools/history`。高级 Hook 是迁移期例外，不是新合同的一部分。

## 11. 实施步骤与修改边界

Coding Agent 可按实际仓库选择文件划分，不要求为了命名搭建空壳类。但要保留以下实质边界：

1. **基础合同与 Registry**：在 Context 领域加入 Source 类型、激活范围内的注册/释放、来源身份、快照读取；在 `ExtensionAPI` 暴露 `provideContext`。新增测试扩展验证注册、撤销、热重载、同 ID 去重。
2. **Request Composer**：将现有 `prepareProjection` 的信息组织步骤收敛到可测试纯函数（或小模块）；保留原 `turn.prepare` 与 `turn.transformContext` 的执行时序；**在旧变换之后插入新 Source 装配**；保持后续测量/预检使用合成结果。
3. **Tool Result View 修复**：在 Tool 消息存储与历史转换间打通 `modelView`，用真实的两次模型请求、JSONL 关闭重开验证；不动工具业务逻辑和权限。
4. **Request Trace**：建立 Source/legacy/工具集合的装配报告，活动请求与 preview 分离；复用现有 Context Inspector 能力，不另建第二套 UI。
5. **Provider Wire 观察**：在实际 `transformPayload` 之后捕捉安全可检查的最终发送事实，建立 `requestId` 关联；为内置 Provider 添加可验证测试。Provider Hook 兼容保留。
6. **集成收口**：统一导出公共合同，清理重复的内部装配函数及过时说明；保留所有旧扩展 Hook，**不逐个迁移业务扩展**。

建议优先改动范围：`src/agent/{context,projection,loop}`、`src/runtime/{hooks,events}`、`src/extensions/{runner,host,runtime-hooks}`、`src/core/types`、`src/tools/pipeline`、`src/session` 的 Tool 消息投影、`src/ai/{gateway,providers}` 的请求观察，以及相应测试。不得将 Speech、Minecraft 或 MCP 的业务内容写入 Core。

## 12. 验收与发布门

以下为**必须通过的行为测试**，不以“新增类/接口数量”作为完成标准：

| # | 可验证结果 |
|---|---|
| A1 | 无新 Source 注册时，既有业务扩展生成的 Model Request（忽略诊断 ID）与基线保持一致；Legacy Hook 时机、System、Tools、Input/History、Compaction 行为不变。 |
| A2 | 注册一份 `guidance`、两份动态 Source，模型实际请求只出现各自一次；位置、顺序与扩展加载顺序无关；能力和观察的 `origin` 在 Wire 正文中可读。 |
| A3 | Source 返回 `null`、发生异常、扩展注销后，下次请求无旧内容残留；读取途中热重载不会混合两个激活代次；诊断能说明失败原因，不能凭空把异常改为“无变化”。 |
| A4 | 纯 `inspectRequest()` 读取不会推进/消费 Source 状态；预览和活动请求有不同标识。 |
| A5 | 同一 Agent Run 内发生两次模型请求，第二次能看到新快照，而不会重复累积前次临时注入。 |
| A6 | `preflight=rebuild` 后再次装配、测量、校验；不会同时出现旧快照与新快照；Compaction 手动 stage、自动 preflight 及已有 checkpoint 均不把新动态 Source 压进历史摘要（验证 `runtime.perception` 兼容标记）。 |
| A7 | `submitInput` 的外部事件与 Context Source 不混淆：前者仍持久入队/落史，后者既不唤醒 Agent 也不产生 Journal 消息。 |
| A8 | 工具结果被 `tools.transformResult` 改写时，canonical 仍保存原文；**下一次模型请求实际收到改写正文**；关闭并重开 JSONL 后依旧得到相同模型视图。没有改写时旧记录不受影响。 |
| A9 | `external_event_frame` 原有合成调用/回执仍完整配对；不能被新 Source 解释成可执行工具，Runtime 来源信息不冒充用户命令。 |
| A10 | 活动 `RequestProjection`、Provider 实际 Wire、来源 Trace 能通过 ID 对账；`transformPayload` 修改文本或工具时，报告必须可观察到差异。 |
| A11 | OpenAI 风格、Anthropic、Gemini 适配及无扩展启动路径通过回归；历史 rewind、Compaction、工具调用、图片消息、Provider 原生 thinking replay 不回退。 |
| A12 | 代码中没有新增通用 Prompt 优先级打分、额外事实 Journal、通用语义去重模型、无限新 Hook 链；所有新增 Source 均可通过激活生命周期自动注销。 |

**完成定义：** 新 Source 已由真实 `decide()` 请求链消费；legacy 依赖未迁移但可运行；Tool Result 视图与 Provider Wire 观察可端到端验证；新增文档只向扩展作者推荐新合同，下一轮迁移边界清晰。

## 13. 下一轮迁移后应删除的遗留能力

本轮不删除，但应在代码里明确标为迁移期入口，并用测试限制新用法：

- 扩展以 `turn.prepare.messages/systemPrompt` 直接贡献常规指南、能力和状态的惯用用法。
- 扩展以 `turn.transformContext` 拼接普通环境观察/声音状态的惯用用法。
- 各扩展自行构建临时的虚拟 User/Assistant/Tool 消息作为“状态通知”的通用方案（持久外部事件协议另行决策）。
- 手工在多个工具描述、System 和 World Guide 中复制同一份能力目录。

**不是要删除 `turn.prepare`、`turn.transformContext` 或 Event Frame 本身**：模型切换、Compaction、真正外部事件仍需要各自独立且边界明确的机制。

---

设计依据与对照：[Uina 当前源码](https://github.com/FanRec/uina-agent/tree/d0c4e0f9b0662e8806d9efa9eb1d9c3b3b9fed25)；[Pi Extension Hooks](https://pi.dev/docs/latest/extensions)；[OpenAI Agents 配置与动态指引](https://developers.openai.com/api/docs/guides/agents/define-agents)。外部实现仅作边界与机制对照，不引入其整套框架。
