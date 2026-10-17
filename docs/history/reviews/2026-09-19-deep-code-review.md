# Uina 全项目对抗式深度代码审查与精炼报告

> **审查日期**：2026-09-19  
> **核心原则**：第一性原则（First Principles）、对抗式审查（Adversarial Review）、奥卡姆剃刀（Occam's Razor）、深模块标准（Deep Module - John Ousterhout）、高内聚低耦合。  
> **审查目标**：揪出潜在逻辑缺陷与死锁盲区、剃除冗余抽象与过度防御代码、精简接口消除浅模块穿透、大道至简。

---

## 模块依赖拓扑与审查顺序

项目全量 144 个源码文件，经静态分析与拓扑排序，划分为以下 10 大核心模块，严格自底向上推进审查：

```text
[1. core]  ──►  [2. runtime]  ──►  [3. session]  ──►  [4. tools]
   ▲                 ▲                   ▲                  ▲
   │                 │                   │                  │
   └──────────┬──────┴─────────────┬─────┴──────────────────┘
              │                    │
         [5. ai]               [6. agent]
              ▲                    ▲
              │                    │
              └──────────┬─────────┘
                         │
                  [7. extensions]
                         ▲
                         │
                      [8. ui]
                         ▲
                         │
                     [9. host]
                         ▲
                         │
                     [10. cli]
```

---


## 一、Module 1: core（基础核心与领域类型）深度审查

### 1.1 模块定位与职责（第一性原则）
`src/core` 是整个系统的纯叶子节点，零运行时依赖。
它应当只承载真正跨层共享的核心领域概念（规范消息类型、模型交互请求与响应协议、副作用标准与基础设施通用工具）。
概念 Allowlist 要求其作为最稳定的底座，任何污染都会顺着依赖树逐级向上扩散。

### 1.2 审查发现的问题与对抗式剖析

#### 【设计概念漂移】`Model` 接口中多重语义字段冗余污染
- **定位**：`src/core/types.ts:222-225`
- **现象**：`Model` 接口同时定义了 `contextWindow`、`maxContextWindow`、`modelContextWindow` 三个可选数字字段。
- **深层根因与批判**：
  在 `ai/config.ts` 中，用户配置里区分了模型原生窗口（`modelContextWindow`）和人工硬上限（`maxContextWindow`）。但在模型运行时规格上，真正有效的上下文窗口在任何时刻只有一个最终确定的有效值 `Math.min(modelContextWindow, maxContextWindow ?? modelContextWindow)`。
  配置解析层的中间计算概念，未经裁剪直接泄露并污染了核心领域模型 `Model`。运行时消费方（如 `Subject.contextWindow`、UI 渲染、Compaction 裁剪）全都在用 `model.contextWindow`，其余两个字段成了历史残留包袱，造成维护者困惑与语义漂移。
- **改进建议**：`Model` 上只需保留最终生效的 `contextWindow`（以及如确需调试可收拢至元数据或单独的 config snapshot）。

#### 【接口隔离违背】`ChatMsg` 携带执行层私有状态
- **定位**：`src/core/types.ts:187-193`
- **现象**：用于直接发给大模型 Provider Wire 的 `ChatMsg` 类型中，`tool` 角色居然包含了 `details?: unknown` 和 `status?: ToolResultStatus`。
- **深层根因与批判**：
  `ChatMsg` 对应的是大模型传输协议（如 OpenAI / Anthropic / Gemini 的 Wire Request Messages）。Provider 只需要 `tool_call_id` 和 `content`。
  `status`（如 succeeded/failed/cancelled）和 `details`（扩展传递给 UI 的私有数据）属于本地会话层/审计层（`ToolAgentMessage`）的关注点。将它们塞入 `ChatMsg`，导致 Provider 适配器不得不在组装 wire payload 时做无谓的过滤或承受类型泄露风险，违背了接口隔离原则（ISP）。

#### 【性能隐患与过度防御】图片 Base64 校验采用全量长字符串正则
- **定位**：`src/core/content.ts:9-25`
- **现象**：`validImages` 对整个 base64 字符串执行全量正则表达式检测：
  ```typescript
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)
  ```
- **深层根因与批判**：
  一张 2MB-5MB 的普通截图经过 base64 编码后达到 2,800,000 ~ 7,000,000 字符。
  在 JavaScript 单线程 Event Loop 中，对数百万字符的超长字符串执行全量复杂的正则表达式匹配，会引发可感知的毫秒级甚至秒级线程阻塞（Event Loop Lag）以及潜在的正则回溯风暴！
  这属于典型的“脱离场景的过度防御”。图片如果非法，底层网络请求或模型端解码自然会报错拒绝；内存中若要简单校验，仅需抽样检查前几个字符以及长度模 4 即可，无需遍历数兆字符。
  同时，`["image/png", ...].includes(image.mimeType)` 每次调用都在动态分配数组，应提取为模块级 `Set`。

#### 【注册契约潜在破坏】`Registrations.delete` 粗暴抹杀栈式历史
- **定位**：`src/core/registrations.ts:31-33`
- **现象**：`delete(name: string): void { this.entries.delete(name); }`
- **深层根因与批判**：
  `Registrations<T>` 的核心设计意图是“支持显式 replace，注销时恢复上一个存活实现（栈结构）”。
  通过 `register()` 返回的注销函数遵循了从数组中剔除本项的正确做法。但公开方法中的 `delete(name)` 却直接把 Map 中的整条 key 及其整个历史栈连根拔起！如果某层误调了 `delete`，下层的所有默认注册将永久丢失而无法被恢复。
  此外，`entriesList()` 和 `values()`（第 26、29 行）先调用 `this.keys()` 再重复 `this.get(name)`，进行了无谓的二次哈希查表与非空断言。

### 1.3 核心精简与深模块建议
- **复杂度评价**：纯数据定义居多，CRAP 极低，结构较为扁平。
- **深模块度**：`Registrations<T>` 接口小巧，但对“栈恢复”特性的封装不够完备（直接暴露了粗暴 delete）；`content.ts` 属于工具函数，应当移除昂贵的大正则。


## 二、Module 2: runtime（运行时钩子与事件协议）深度审查

### 2.1 模块定位与职责（第一性原则）
`src/runtime` 定义了系统的双向协议底座：
1. **干预流（Hooks）**：系统向扩展发起的同步/异步干预协商（如 `turn.prepare`、`tools.beforeCall`），必须定义严格的确定性合并策略。
2. **事实流（Events）**：单向状态机广播（系统向外部宣告“某事已发生”），订阅方无权改变事实。

### 2.2 审查发现的问题与对抗式剖析

#### 【高频路径严重性能损耗】`readonlySnapshot` 的深度克隆与递归冻结
- **定位**：`src/runtime/guard.ts:8-10, 42-44, 75-79`
- **现象**：
  ```typescript
  export function readonlySnapshot<T>(value: T): DeepReadonly<T> {
  	return deepFreeze(clone(value)) as DeepReadonly<T>;
  }
  ```
  在 `guardRuntimeHooks` 中，无论是 `hooks.events.emit` 还是高频的 `hooks.events.observe`，每一个事件都被施加了 `readonlySnapshot`：
  1. 先走 `clone`：高频调用 `structuredClone`，失败时走 `try...catch`。
  2. 再走 `deepFreeze`：递归遍历对象的每一个属性执行 `Object.freeze`。
- **深层根因与批判**：
  - 流式打字机输出（`output_update`）每秒可能产生几十至上百次事件。
  - 回溯事件（`session_rewind`）携带包含数千条历史消息的 `entries` 数组。
  - 对这些高频或大体量的事实事件，每次都做全量 `structuredClone + deepFreeze`，在运行时造成惊人的 CPU 和 GC 垃圾内存开销！
  - 这属于典型的“为了理论上的绝对不可变，牺牲了系统的真实吞吐”。在内部可信流转路径上，TypeScript 编译期 `DeepReadonly<T>` 已经足以约束外部代码；即使要防扩展篡改，也只需在暴露给不可信插件层做浅拷贝或按需 Proxy，而非在内核层无差别全局递归深冻结。

#### 【概念口径与接口结构冲突】L1 铁律“Hook ≠ Event”与接口混居
- **定位**：`src/runtime/hooks.ts:96-100`
- **现象**：在 `RuntimeHooks` 接口中，居然嵌入了：
  ```typescript
  readonly events: {
  	emit(event: RuntimeEvent): Promise<void>;
  	observe(event: OutputEvent): void;
  	flush(): Promise<void>;
  };
  ```
- **深层根因与批判**：
  代码注释中用“铁律 L1”严正声明：*“Hook ≠ Event，两个词表不得混居，混居会让扩展作者无法分辨自己在影响系统还是在观察系统。”*
  然而在接口定义上，`RuntimeHooks` 却把整个事件总线（`events`）塞了进去！
  这导致 Subject 既把 `RuntimeHooks` 当做拦截器链，又把它当成事件广播中心。这种设计既不内聚，又破坏了单一职责原则。
  正确的深模块设计应该是：`RuntimeHooks` 专注于干预点（prepare/transform/intercept）；事件发布中心应当作为独立的端口或总线注入，不应该寄生在 Hook 契约下。

#### 【重复定义的用量结构】`TurnEndEvent` 与 `UsageUpdateEvent` 缺乏复用
- **定位**：`src/runtime/events.ts:33-42, 61-70`
- **现象**：两个事件各自手写了一遍包含 8 个相同属性的匿名 usage 结构。
- **改进建议**：提炼为统一的 `TurnUsageSnapshot` 类型，消除重复定义并保证字段一致。

#### 【污染对象的防重入标记】`guardRuntimeHooks` 中的 Symbol 属性注入
- **定位**：`src/runtime/guard.ts:20-25`
- **现象**：使用 `Symbol("guardedRuntimeHooks")` 直接挂载在返回对象上，并强制断言 `as RuntimeHooks & { [GUARDED]?: boolean }`。
- **改进建议**：使用私有 `WeakSet<RuntimeHooks>` 进行已守卫标记，完全避免对返回对象的动态属性破坏与类型断言。

### 2.3 核心精简与深模块建议
- **复杂度评价**：`guard.ts` 的深拷贝与递归冻结逻辑增加了隐性复杂度，且在高频 IO 上是潜在性能瓶颈点。
- **深模块度**：`events` 接口寄生在 `RuntimeHooks` 内部，造成概念倒挂，应在后续演进中拆解为正交的 `EventSink`。


## 三、Module 3: session（持久化日志、事实恢复与回溯状态机）深度审查

### 3.1 模块定位与职责（第一性原则）
`src/session` 是系统持久化与事实真相的权威单一来源（Single Source of Truth）：
- 采用仅追加（Append-Only）JSONL 日志格式（v3 规范）。
- 绝不依赖 `agent/` 或模型推断（边界检查严格限制）。
- 双模型设计：`CanonicalRecord`（驱动主线/工具因果状态机）与 `AuxiliaryRecord`（展示与审计时间线）。
- 纯确定性恢复：重开会话时结算未完成工具为显式事实（`planRecovery`），绝不凭空猜测外部副作用已成功。

### 3.2 审查发现的问题与对抗式剖析

#### 【启动阶段性能地雷】读取全量日志时重复触发 Base64 昂贵正则
- **定位**：`src/session/jsonl-store.ts:312-314`、`src/session/recovery.ts:697, 703, 727`
- **现象**：
  在 `openJsonlSession` 的 `readSnapshot` 循环中，每一行 JSON 解析后都会进入 `isRecord`。
  `isRecord` 在检查 `input`、`custom_message` 和 `message` 时，均调用了 `validImages(message.images)`，对其中的每一个 base64 字符串执行数百万字符的全量正则表达式扫描！
- **深层根因与批判**：
  若一个长期运行的会话日志中包含多张图片，当用户重新启动 CLI 时，系统在进入交互界面前，会在主线程单核上连续对几十兆 Base64 字符串执行全量正则匹配，导致启动卡顿达数秒，甚至引发 UI 冻结。
  磁盘读取本应是纯粹的反序列化；既然写入时已经保障了图片格式，重开日志时根本没有必要重复执行这种沉重的防御性正则。

#### 【磁盘 I/O 放大漏洞】`appendFinalNewline` 全量重写整个大文件
- **定位**：`src/session/jsonl-store.ts:325-332`
- **现象**：
  ```typescript
  async function appendFinalNewline(path: string, content: string): Promise<void> {
  	const temp = `${path}.${process.pid}.${Date.now()}.newline.tmp`;
  	await writeFile(temp, `${content}\n`, "utf8");
  	await rename(temp, path)...
  }
  ```
- **深层根因与批判**：
  当打开一个末尾缺少换行符的会话文件时，程序为了在末尾补一个换行符 `\n`，竟然把整个 `text`（可能几十兆）读入内存，写出一个完整的临时文件，再做 `rename` 覆盖！
  第一性审视：向文件尾部追加一个字符，标准做法是以追加模式向原有文件末尾写入一个字节即可，耗时 0 毫秒。全量重新写盘是典型的“用最重的代价解决最小的问题”。

#### 【写入链路中过度冗余的 `structuredClone`】
- **定位**：`src/session/jsonl-store.ts:119, 123, 137, 141, 154, 189`
- **现象**：
  在 `JsonlSessionStore` 的对外 append 方法中（如 `appendInput`, `appendCustomMessage` 等），入参已经被 `structuredClone` 了一次；
  紧接着在核心的 `append(record)` 方法内，落盘成功后又执行了一次：
  `this.records.push(structuredClone(record));`
- **深层根因与批判**：
  写入一条记录，经历了：调用端 clone → 组装对象 → JSON.stringify 编码字节写入磁盘 → 内存 push 前再次 clone！
  纯 JSON 数据在序列化写入后，本身在内存中就已经是无副作用的；在同一链路中连续深拷贝 2~3 次，在高频日志记录场景下造成完全不必要的垃圾回收压力。

#### 【深模块优秀设计与亮点肯定】
- **两相提交与崩溃截断**：`checkRecord` 先行，非法记录拒绝落盘；磁盘写入若异常中断，使用 Windows/POSIX 均兼容的 `truncate(size)` 回退到上一次稳定记录边界；无法回退则置为 `writeFailure`，宁死不写脏数据。
- **残损尾部修复（Torn Tail Repair）**：`isTornTail` 精确识别进程断电造成的未闭合花括号，并能安全截断半行坏数据，展示了极强的工业级可靠性。
- **恢复事实稳定标识**：`recovered:${originId}:${callId}` 赋予未决工具调用唯一的终态身份，彻底消除了重放时的歧义。

### 3.3 核心精简与深模块建议
- **复杂度评价**：`recovery.ts` 逻辑极其紧密严谨，状态转移与回溯不变量清晰，复杂度高但属于必要业务复杂度。
- **深模块度**：深模块典范——对外仅暴露 `SessionStore` 与几个纯投影函数，内部封装了复杂的时间线分叉、祖先查找与残卷修复。优化点在于剔除启动阶段无谓的大正则与末尾补换行时的文件重写。


## 四、Module 4: tools（工具注册、Schema 校验与执行流水线）深度审查

### 4.1 模块定位与职责（第一性原则）
`src/tools` 负责工具的生命周期管理：
- Schema 编译与参数校验（AJV JSON Schema 验证）。
- 工具注册表（基于 `Registrations<T>` 支持覆盖与恢复）。
- 权限与作用域视图（`ScopedToolView`，按 include/exclude 隔离工具可见性并透传执行者身份上下文）。
- 统一条目执行流水线（`pipeline.ts`），封装取消、拦截、执行与结果改写。

### 4.2 审查发现的问题与对抗式剖析

#### 【浅模块代码克隆】`ScopedToolView` 与 `ToolBroker` 重复样板逻辑
- **定位**：`src/tools/broker.ts:141-159` 与 `broker.ts:270-300`
- **现象**：
  `ScopedToolView` 并没有将核心执行委托给底层 Broker 的统一私有方法，而是在自己的 `execute` 中重新复制了一整套：
  1. 检查 `prepared.error` 并构造 `status: "not_started"` 错误 JSON；
  2. 检查工具是否在卸载后被调用，并构造同样的未启动错误 JSON；
  3. 重复调用 `executeToolCore`。
- **深层根因与批判**：
  `ScopedToolView` 本质是一个基于白名单/黑名单和 Caller 身份上下文的**装饰器（Decorator）**。
  它应当只做两件事：过滤名称与注入上下文。让它重新实现一遍 Broker 的核心执行前置校验，违背了单一职责原则，增加了未来修改执行错误格式时的同步脆弱性。

#### 【异常边界未收口】Hook 抛错直穿流水线导致核心崩溃风险
- **定位**：`src/tools/pipeline.ts:81-99`
- **现象**：
  在 `executeToolPipeline` 中，调用扩展的 `transformResult` hook 时：
  ```typescript
  const transformed = await hooks?.transformResult?.(...);
  if (!validImages(transformed?.images)) throw new Error("tool_result hook 返回无效图片");
  ```
  若外部注册的扩展在 `transformResult` 中抛错，或者返回了格式不对的图片，该异常直接向外抛出，完全没有在 pipeline 内部被捕获为 `failed` 或 `unknown`。
- **深层根因与批判**：
  核心工具已经执行完毕（可能具有真实的外部副作用，如已写入文件或已启动进程）。
  此时仅仅因为一个第三方的展示/变换 Hook 抛出了异常，就导致整个流水线未捕获异常中断，既没有正常触发 `observers?.onDone`，也没有将工具执行事实合规写入日志，严重违反了“系统对外副作用必须有确凿终态记录”的铁律！
  应在此处对后置 Hook 执行增加安全隔离，即便 Hook 失败也应降级保留工具的核心成功事实，并把 Hook 错误记录进日志或 warning，绝不能击穿执行流水线。

#### 【模块亮点与优秀设计】
- **统一流水线抽取（`pipeline.ts`）**：将工具调用的取消时序、前后拦截、执行与广播彻底标准化，彻底解耦了工具层与 Agent Loop 的调度耦合。
- **确凿的状态机（`ToolResultStatus`）**：严格区分 `succeeded`、`failed`、`cancelled`、`unknown`、`not_started`，杜绝无依据猜测外部执行成功。

### 4.3 核心精简与深模块建议
- **复杂度评价**：流水线设计清晰，CRAP 指标良好。
- **深模块度**：`executeToolPipeline` 具有强大的编排能力；重构时应精简 `ScopedToolView` 为轻量装饰器，并强化 Hook 边界的异常隔离。


## 五、Module 5: ai（模型配置、适配器与 SSE 通信网关）深度审查

### 5.1 模块定位与职责（第一性原则）
`src/ai` 承载真实外部大模型通信的协议转换与网络边界：
- Provider 静态凭据配置与会话偏好持久化（`config.ts`, `settings.ts`）。
- 跨厂商协议标准化（OpenAI-compatible / Anthropic / Gemini）。
- 流式事件帧解析（`parseSSE`）与抗抖动网络重试机制（`fetchWithRetry`）。
- 多 Provider 模型目录发现与动态注册表（`ModelRegistry`）。

### 5.2 审查发现的问题与对抗式剖析

#### 【角色语义错位】工具结果中的图片被强制注入为假冒 User 消息
- **定位**：`src/ai/gateway.ts:367-372, 405, 415`
- **现象**：
  在 `toWireMessages` 将内部消息投影为 OpenAI Wire 格式时：
  ```typescript
  if (message.role === "tool") {
  	if (message.images?.length) toolImages.push({ type: 'text', text: 'Images from tool call ' + message.tool_call_id }, ...imageParts(message.images));
  	...
  }
  flushImages(); // wire.push({ role: 'user', content: toolImages });
  ```
- **深层根因与批判**：
  OpenAI 原生协议中 `role: "tool"` 消息只接受字符串内容。为了规避此限制，当前实现将工具输出中的图片缓存起来，并在工具轮次结束后伪造成一条 `role: "user"` 消息灌入 wire。
  这带来了双重风险：
  1. **协议结构破坏**：某些严格遵循 OpenAI 规范或第三方大模型代理（如 Ollama、Anthropic 桥接等）对 `assistant(tool_calls) -> tool` 之后的上下文有严格状态机要求，突然插入一条假的 user 消息会导致服务端直接报 HTTP 400 格式错误。
  2. **模型认知混淆**：大模型接收到这条消息时，会把工具执行生成的图片事实误认为是人类用户刚刚上传的输入，干扰了工具与用户的因果责任链。

#### 【同名模型别名冲突】`ModelRegistry` 双写注册导致的顺序敏感性
- **定位**：`src/ai/providers.ts:667-668, 728-734`
- **现象**：
  在注册模型时，`ModelRegistry` 既注册了全局复合键 `${providerId}/${model.id}`，又以 `replace: true` 注册了裸 `model.id`。
- **深层根因与批判**：
  当用户在 `auth.json` 中配置了两个 Provider 且存在同名模型时（例如同时配置了官方 OpenAI 和中转服务商的 `gpt-4o`），后初始化的 Provider 会强行覆盖裸 `gpt-4o` 的引用。
  如果调用方只通过短名称 `resolve("gpt-4o")`，其命中的实际端点完全取决于对象遍历的随机顺序，失去了确定性。应在设计上强制要求内部解析以 `providerId/modelId` 复合身份为第一公民。

#### 【配置解析层样板膨胀】70 行手写逐属性解构与类型强转
- **定位**：`src/ai/config.ts:152-232`
- **现象**：`validateConfig` 中堆砌了数十个 `if (provider.xxx !== undefined) { ... as number }`，代码冗长重复。
- **改进建议**：提取配置属性白名单映射表，或使用单点验证器遍历，代码量可从 80 行压缩至 20 行以内。

#### 【模块亮点与优秀设计】
- **绝不猜测事实（Reality-First）**：`assertProviderFacts` 拒绝在 wire 缺失时脑补 `maxOutputTokens` 或 Gemini `thinkingFormat`，错误在启动期精确拦截并指出字段名。
- **高质量 SSE 解析器（`src/ai/sse.ts`）**：状态机完整覆盖 CRLF/LF/CR，妥善处理了跨 chunk 边界截断，且取消时保证 reader 与事件监听器无泄漏。
- **重试退避监听器卫生**：`abortableDelay`（`gateway.ts:292-309`）显式管理了 `removeEventListener`，有效杜绝了高频重试下的事件监听器泄漏警报。

### 5.3 核心精简与深模块建议
- **复杂度评价**：协议转换不可避免具有分支复杂度，但各 Provider 适配器边界清晰。
- **深模块度**：`createProvider` 和 `createModel` 隐藏了底层 fetch、SSE、JSON 流合并的复杂网络细节，接口小巧强大。


## 六、Module 6: agent（Subject 核心循环、队列邮箱与上下文投影）深度审查

### 6.1 模块定位与职责（第一性原则）
`src/agent` 是整个系统的执行核心（Kernel Core）：
- 主体执行循环（`Subject.decide`）拥有前台回合调度、模型流式监听、工具结果回注与取消传播。
- 邮箱与队列管理（`InputQueues`）：多模式投递（`direct` / `steer` / `followUp`）与保序调度。
- 上下文投影与清洗（`context.ts`）：在模型请求边界消除工具孤儿调用与幽灵帧，保持协议强合法。
- 回溯状态转换（`rewind.ts`）：在安全点提交历史截断并失效用量缓存。
- AgentHandle 句柄与生命周期包装（`runtime.ts`）。

### 6.2 审查发现的问题与对抗式剖析

#### 【双轨制输入入口】`pushInput` 与 `accept` 的冗余分裂
- **定位**：`src/agent/loop.ts:400-449`
- **现象**：
  `Subject` 对外提供了两套几乎平行的输入投递方法：
  - `pushInput(text: string, options?: QueueInputOptions)`：面向纯文本、由 Host/CLI 调用的输入入口。
  - `accept(input: AgentInput)`：面向结构化对象（携带 `id`、`source`、`images`、`data`）、由 `AgentHandle.send` 调用的输入入口。
- **深层根因与批判**：
  在系统内部，输入本质上都是一条带属性的 `QueuedMessage`。
  两套入口导致了：
  1. 队列调度逻辑分裂：入队、检查 busy、空闲时唤醒在两个方法中写了两遍微小的变体逻辑（例如 `accept` 中带着复杂的 `needsEnqueueEvent` 补丁）。
  2. 概念冗余：外层调用者常常困惑何时该调 `pushInput`，何时该调 `accept`。
  **重构方案**：将 `pushInput` 收拢为 `accept` 的轻量便捷重载（Overload），底层统一收口至单一投递管道，消除状态分支分裂。

#### 【上下文投影三遍全量扫描】`convertToLlm` 的重复遍历与 GC 压力
- **定位**：`src/agent/context.ts:41-118`
- **现象**：
  在每次向大模型发起请求前，`convertToLlm` 依次执行：
  1. 遍历全部消息，抽取 `toolResponses` Set；
  2. 遍历全部消息，生成 `intermediate` 数组；
  3. 遍历全部消息，抽取 `validToolCallIds` Set；
  4. 遍历全部消息，过滤出最终的 `cleaned` 数组。
- **深层根因与批判**：
  在一个数百轮长会话中，对同一个历史消息数组连续进行 4 次全量扫描与 2 次 Set 分配。
  实际上，通过倒序扫描或者单遍成对关联，完全可以在 1~2 遍内完成工具调用与响应的闭合匹配，避免频繁的数组复制与垃圾回收毛刺。

#### 【无限循环熔断兜底缺失】`decide` 缺乏可观测的死循环防卫
- **定位**：`src/agent/loop.ts:691-762`
- **现象**：
  `decide` 的多轮工具调用循环是一个无边界的 `for (;;)`。
  系统明确遵循“不凭空增加轮次限制”的原则，完全依赖大模型自主结束或外部 `shouldStop` 钩子。
- **潜在风险**：
  若模型出现严重的结构化死循环（例如反复调用同一个报错工具且不看报错），系统将在毫秒级间隔内无限轮询调用模型，直至用户耗尽 Token 额度或手动按下 Ctrl+C。
  建议：即便不硬编码死限制，也应增加单轮异常高频循环检测（例如连续 100 次工具调用无文本输出时上报 warning 事件）。

#### 【模块亮点与优秀设计】
- **流式残损工具参数容错**：`TurnStreamCollector.handleDelta` 遇到因 token 截断导致的坏 JSON 参数时，优雅降级标为 `argsValid: false`，随后由 Broker 统一转化为 `not_started` 错误回注，绝不导致核心进程崩溃。
- **回溯前后用量缓存失效纪律**：在回溯提交或模型切换时，严格同步执行 `this.forgetUsage()`，从根本上杜绝了回溯后 UI 底栏残留上一分支虚假 Token 计数的诡异 Bug。
- **邮箱领取原子性（Claim Synchronously）**：在 `drainQueuedInputs` 中，在第一个 `await` 产生前同步将所有待处理项从队列移除，彻底杜绝了并发输入重入消费或被外部撤回的竞态冲突。

### 6.3 核心精简与深模块建议
- **复杂度评价**：`loop.ts` 承担了核心状态机调度，代码行数达 1099 行。
- **深模块度**：`Subject` 对外封装了极度复杂的工具交换与回溯状态机；重构应优先合并 `pushInput` 与 `accept`，精简上下文扫描逻辑。


## 七、Module 7: extensions（扩展系统、能力装配与生命周期隔离）深度审查

### 7.1 模块定位与职责（第一性原则）
`src/extensions` 负责将外部/内置能力接入核心，并严格防范资源泄漏：
- 严格遵循**宿主与扩展单向依赖**：扩展只能使用公开的 `ui/core` 表现原语，绝不可反向 import 具体的 UI 实现。
- 采用 **ResourceScope** 隔离每一个扩展的生命周期：注册的工具、命令、服务、UI 组件和监听器自动归属于 Scope；卸载时严格倒序（LIFO）清理，不留残余。
- 内置核心功能（Shell 执行、时间、Job 后台任务、Subagent 子代理、工作区文件操作、上下文压缩）均作为内置扩展（Builtin Capability）装配，保持核心 Subject 代码极致小巧。

### 7.2 审查发现的问题与对抗式剖析

#### 【过度包装的性能与调试损耗】UI 暴露端双重 Proxy 嵌套
- **定位**：`src/extensions/runner.ts:741-809`
- **现象**：
  扩展调用 `pi.ui` 时，该对象被包裹了整整两层 ES6 Proxy：
  1. `dynamicUI`：动态捕获最新的宿主 UI 实例；
  2. `ownedUI`：拦截每一个方法调用前置执行 `assertActive()`，并将组件自动按扩展 ID 命名空间注入。
- **深层根因与批判**：
  双重 Proxy 嵌套虽然带来了理论上的完美防御（扩展卸载后立即切断任何 UI 调用的可能），但在开发体验上，它使得控制台打印与调试堆栈深度增加了多层 Proxy 内部跳转，并且在频繁更新高频 UI 时造成无谓的反射查找损耗。
  完全可以通过扁平的原型委托或简单的闭包类实现相同语义，而无需无节制使用双重动态 Proxy。

#### 【异步观察者尾部积压风险】`observedTail` 链条无界增长
- **定位**：`src/extensions/host.ts:87, 194-205`
- **现象**：
  `private observedTail: Promise<void> = Promise.resolve();`
  在观察输出流事件（如 `output_update`）时，所有事件通过 `this.observedTail = this.observedTail.then(...)` 串行排队。
- **深层根因与批判**：
  若某个扩展注册了高频的 `output_update` 事实订阅，且在回调内部执行了缓慢的异步操作（例如写磁盘或网络调用），`observedTail` 的 Promise 链会在单轮回合中迅速积压数千个闭包，导致微任务队列堵塞和内存暂留激增。
  对于纯事实观察流（Observer），应明确界定为**尽力而为（Best-effort / Fire-and-forget）**，或者提供固定容量的缓冲丢弃策略，严禁在主事件广播总线上无界串联持久化 Promise 尾巴。

#### 【模块亮点与优秀设计】
- **完美对齐 Pi 生命周期（ResourceScope）**：这是整个扩展系统的工业级灵魂所在。扩展抛错、崩溃或热重载时，注册的 Tool、Command、UI 槽位、AbortSignal 全部能精准自毁与回滚，从未出现过幽灵工具残留。
- **热重载预检机制（`reload` 三阶段）**：在卸载现有扩展前，先对新文件执行语法与顶层执行预检；预检失败则保护现有系统不中断，保障了长驻进程的开发可用性。
- **真机可靠性与状态诚实（`exec_command`）**：非零退出码严格定性为 `failed`，超时严格定性为 `failed (超时)`，取消严格定性为 `killed`，绝不把“子进程正常退出”当成“命令执行成功”。

### 7.3 核心精简与深模块建议
- **复杂度评价**：扩展生命周期调度与状态管理复杂，但封装极度完备。
- **深模块度**：`ExtensionAPI` 接口极其干净，扩展开发者只需一个 `activate(pi)` 即可获得完备的能力，且不需要操心底层的垃圾回收与注销细节。


## 八、Module 8: ui（终端渲染原语、TUI 调度与组件系统）深度审查

### 8.1 模块定位与职责（第一性原则）
`src/ui` 属于系统的表现层与交互消费者：
- 作为宿主（Host）的纯观察者与输入源，**绝不拥有 Subject、SessionStore 或生命周期状态转移**。
- 提供控制台原子差量渲染（`MainScreenRenderer`）、双缓冲帧对比，防止真实终端闪烁。
- 封装键盘按键分发、鼠标选区交互与 SGR 1006 滚轮支持。
- 组装 Transcript 转录流、多行编辑器输入框、用量与上下文仪表盘、面板遮罩层（ModelPicker、TaskDashboard 等）。

### 8.2 审查发现的问题与对抗式剖析

#### 【上帝类膨胀】`UIHost` 超两千行代码职责过度堆砌
- **定位**：`src/ui/ui-host.ts`（总行数 2058 行）
- **现象**：
  `UIHost` 汇集了：
  1. 终端物理尺寸监听与全屏差量渲染编排；
  2. 鼠标 SGR 协议解析、自动滚屏定时器、拖拽碰撞检测；
  3. 终端框线反向正则清洗与剪贴板桥接；
  4. 键盘快捷键路由与焦点系统；
  5. 8 个弹出面板与覆盖层状态管理；
  6. 状态栏、活动行、打字机动画聚合。
- **深层根因与批判**：
  `UIHost` 产生了明显的类膨胀（God Class 异味），其圈复杂度居全仓之首。
  尤其是鼠标事件解析与热区注册（约 400 行代码）完全属于可拆分的独立子系统（如 `TerminalMouseDispatcher`）。将协议层、布局层、组件层全部混在一个类中，给阅读、单测和演进带来了极大的心智负担。

#### 【剪贴板边框剔除的启发式副作用】`cleanCodeBlockSelection` 误伤合法内容
- **定位**：`src/ui/ui-host.ts:283-297`
- **现象**：
  用户用鼠标划选代码复制时，代码试图通过正则：
  ```typescript
  lines.filter((line) => !/^\s*[┌└]─+.*[┐┘]\s*$/.test(stripAnsi(line)))
  ```
  剔除渲染时的框线，还原纯代码。
- **深层根因与批判**：
  这是典型的“在已经渲染成像素/字符的下游，用启发式正则反猜语义”。
  若用户代码本身或大模型输出的内容中包含 Markdown 表格、ASCII 图表或类似的制表符（如 `│`），这些合法内容会被当做终端 UI 框线被错误裁剪甚至整行丢弃！
  深模块的正确做法是从上游组件的 `LineModel` 或消息块数据源直接取干净文本，而不是在屏幕行快照上用正则切除。

#### 【模块亮点与优秀设计】
- **严格单向依赖**：`host/` 模块零导入 `ui/`（由静态边界检查强校验）；UI 仅作为事件流的消费者，随时可拔插、可销毁，断开后主体继续运行。
- **动态按需心跳（Heartbeat Convergence）**：`updateHeartbeat` 聚合动画、打字机渐进揭示与后台任务状态，状态归零时立即清除定时器（`stopHeartbeat`），闲时绝对零 CPU 占用。
- **无 UI 优雅降级（`createPrintUI`）**：在无终端、CI 或管道重定向场景下，UI 契约全部无缝降级为标准输出或空操作，不会抛出未定义异常。

### 8.3 核心精简与深模块建议
- **复杂度评价**：`ui-host.ts` 属于全仓 CRAP 最高的重型文件，逻辑紧密交织。
- **深模块度**：底层 `ui/core` 表现原语封装极佳；后续应将 `UIHost` 中的鼠标调度、选区反色与快捷键注册剥离为独立的子系统。


## 九、Module 9: host（主体生命周期总线与装配中心）深度审查

### 9.1 模块定位与职责（第一性原则）
`src/host` 是系统的总调度与装配核心：
- **主体生命周期的唯一所有者**：组装并持有 Provider、ModelRegistry、JobRegistry、SubagentRegistry、ExtensionRunner、SessionStore、ToolBroker 和 Subject。
- **零 UI 依赖不变量**：完全隔离于 UI 层（由自动化边界检查脚本强制守卫），对外仅暴露出**单流有序事件订阅**（`subscribe`）、**受控输入入口**（`submitText` / `send`）与**一站式状态快照**（`snapshot`）。
- 消费者（TUI、stdio、自动化测试）随时接入或断开，主体的持续执行与持久化事实不受任何影响。

### 9.2 审查发现的问题与对抗式剖析

#### 【Subject 双轨入口引发的宿主转发冗余】
- **定位**：`src/host/host.ts:312-350`
- **现象**：
  由于底层 `Subject` 分裂为 `pushInput` 与 `accept`，宿主对外衍生出三个重叠的输入方法：
  - `send(input: AgentInput)`
  - `submitText(text: string, mode)`（执行忙闲升级策略）
  - `pushInput(text: string, mode)`（原样透传）
- **深层根因与批判**：
  外层消费者（如 CLI、自动化脚本）面对三个相似的方法常常无法明确意图。
  第一性审视：输入投递只应分为“人机交互提交（交互默认 direct，忙时升级为 steer）”与“程序化投递（显式带身份）”两种本质语义，应当与底层统一。

#### 【静态装配工厂异常时的资源泄漏风险】
- **定位**：`src/host/host.ts:111-297`
- **现象**：
  `UinaHost.create` 是一个长达近 200 行的静态异步组装函数。
  在第 161 行成功打开会话文件（`store = opened.store`）并持有文件句柄后，后续还会继续执行大量扩展与模型的初始化代码（第 162-295 行）。
- **深层根因与批判**：
  若在后续扩展预检、模型初始化或依赖装配过程中抛出异常，此时已经打开的 `store`（持有 Node.js FileHandle）没有被进入 `try...catch` 释放，导致文件句柄处于悬挂状态（在 Windows 平台上可能引发文件锁无法释放）。
  应在 `create` 过程中增加失败回滚块：一旦后续装配失败，立即关闭已打开的 `store`。

#### 【模块亮点与优秀设计】
- **深模块架构典范**：`UinaHost` 完美隐藏了跨模块极其繁琐的装配细节（Provider、Session、Extensions、Subagent 级联装配），外部无论是什么消费者，只需 `host.subscribe()` 和 `host.snapshot()` 即可完成交互。
- **孤儿后台子进程清理**：在 `dispose()` 阶段通过 `killTrackedDetachedChildren()` 强制回收外部命令启动的分离子进程，保证进程退出不留僵尸。
- **并发写配置的保序锁**：偏好持久化（`settingsSaveTail`）采用 Promise 串行队列锁，彻底解决了两次背靠背快速切换模型时的文件写入竞态。

### 9.3 核心精简与深模块建议
- **复杂度评价**：装配逻辑集中，职责划分极为明确。
- **深模块度**：全仓最典型的深模块接口设计——极小、极窄的对外 API，包裹了全系统最庞大的组装状态。


## 十、Module 10: cli & Entry（组合根、命令行解析与进程生命周期）深度审查

### 10.1 模块定位与职责（第一性原则）
`src/cli` 与 `src/main.ts` 是全进程的组合根（Composition Root）：
- **极小的主入口**：`main.ts` 仅 9 行代码，只负责启动并捕获最高层级的未捕获异常。
- **纯粹的组合根职责**：`cli/app.ts` 严格只做四件事：解析命令行参数与标准输入管道、实例化 `UinaHost`、按终端环境挂接单一消费者（TUI 或 stdio）、安装进程级信号与流错误守卫。
- **优雅退出治理**：拦截 SIGINT、SIGTERM、SIGHUP，先执行主体的有序反向析构（取消在途轮次、杀掉分离子进程、清理扩展、刷盘并关闭日志），再按 POSIX 惯例以 0/143/129 退出。

### 10.2 审查发现的问题与对抗式剖析

#### 【打断时序边界】`deliverQueuedNow` 中的异步竞态保护
- **定位**：`src/cli/app.ts:218-233`
- **现象**：
  ```typescript
  const deliverQueuedNow = (extraText?: string): void => {
  	const token = ++interruptSeq;
  	if (host.isBusy() || (tui && tui.host.isBusy())) host.interrupt();
  	void host.waitForIdle().then(async () => {
  		if (interruptSeq !== token) return;
  		...
  	});
  };
  ```
- **深层根因与分析**：
  这里使用了 `interruptSeq` 令牌机制来防止连续快速按打断键（如快速连敲多次 Esc）时的乱序投递竞态。
  不过，如果 `host.waitForIdle()` 正在等待一个耗时较长的网络超时或死锁工具，连续点击打断虽然能递增令牌，但所有排队的闭包仍然挂在 Promise 链上。应确保在打断时底层 AbortSignal 能够无条件第一时间截断网络/进程等待。

#### 【模块亮点与优秀设计】
- **人机工程学区分 Esc 与 Ctrl+C**：
  - 按 `Esc`：打断当前轮次并立即处理队列中的排队指令（`deliverQueuedNow`）；
  - 按 `Ctrl+C`：打断当前轮次并将尚未执行的排队消息全部安全撤回至输入栏（`restoreQueueToEditor`），防止用户输入的内容丢失。
- **EPIPE 错误免疫**：在标准输出/错误流上捕获并忽略 `EPIPE` 错误（`src/cli/app.ts:205-208`），完美兼容了 `uina -p "xxx" | head -n 5` 等 UNIX 管道下游提前关闭的常见场景。
- **零外部依赖命令行解析（`args.ts`）**：遵循奥卡姆剃刀原则，使用约 100 行纯 TS 代码实现了位置参数、布尔开关、键值覆盖与 `--` 边界截断，彻底淘汰了重型第三方 CLI 库（如 commander / yargs）。

### 10.3 核心精简与深模块建议
- **复杂度评价**：组合根架构清晰，完全没有跨层越权，符合单一职责原则。
- **深模块度**：`runApp` 将复杂的终端检测、输入模式调度和信号捕捉完全包裹在内，是极其优秀的组合根实现。


## 十一、测试套件对抗式审查与重构总结

### 11.1 测试套件现状扫描与坏味道（Code Smells）剖析
Uina 的测试套件整体质量较高，涵盖了 670+ 个测试用例，深入覆盖了状态机调度、事件分发、TUI 帧缓冲渲染、会话崩溃恢复与真实 CLI 等关键链路。但在奥卡姆剃刀与高内聚视角下，依然存在以下明显坏味道：
1. **测试控制台 ANSI 逃逸码污染**：
   - `tests/tps-wiring.test.ts` 在测试中直接调用 `createInteractiveUI({ modelName: "TestModel" })`，未注入虚拟终端。因此直接使用了默认绑定真实的 `process.stdout`，在测试跑动时狂刷上百行全屏 ANSI 逃逸字符与 Banner，既污染测试终端，又无谓增加了 I/O 阻塞。
2. **测试文件碎片化（Fragmentation）**：
   - 存在多个仅几十行的碎片单测文件（例如 `tests/branch-inspector-crlf.test.ts` 仅 37 行、`tests/search-node-matcher.test.ts` 仅 51 行）。这些文件是因历史局部排错而单独创建的，脱离了被测主体的主测试文件，导致根测试目录被琐碎文件撑大。
3. **回归测试的“大杂烩垃圾桶”效应**：
   - `tests/refactor-regression.test.ts` 将文本 Diff、UI 滑动窗口面板、网络重试延迟、错误字符串解析等完全无关的 5 个异构模块的测试强行塞在同一个文件内。随着时间演进，当开发者重构某一模块时极易遗漏这里的断言，破坏了测试的高内聚与可维护性。
4. **异步等待的脆弱性（Flaky Tests 风险）**：
   - 部分用例存在硬编码 `setTimeout(resolve, 60)` 或假时钟与微任务交织的情况，在 CI 机器高负载或 Windows 进程调度抖动时容易偶发超时。

### 11.2 本次实施的测试重构行动
为了提升测试套件的内聚度、整洁度与执行确定性，本次实施了以下重构：
1. **彻底消除控制台终端输出污染（`tps-wiring.test.ts`）**：
   - 为该用例注入静音的 `fakeTerminal()`，完全剥离对真实终端标准输出的依赖。测试从刷屏 300+ 行 ANSI 字符变为纯净的 `✓ tests/tps-wiring.test.ts (5 tests) 8ms`。
2. **高内聚合并碎片测试文件**：
   - 将 `branch-inspector-crlf.test.ts` 的 Windows 换行符专项回归用例完整合入 `branch-inspector.test.ts`，并安全删除旧文件；
   - 将 `search-node-matcher.test.ts` 的正则构建与行匹配纯内核用例完整合入 `search-tools.test.ts`，并安全删除旧文件；
   - 测试文件总数从 52 个紧凑收敛至 50 个，且**未丢失任何一个测试用例断言**。
3. **全量断言守卫验证**：
   - 运行全量 `pnpm check:boundaries`（6 条内核边界隔离规则全部通过，零架构破窗）；
   - 运行全量 `tsc --noEmit`（零类型错误）；
   - 运行全量 50 个测试文件（672 passed, 1 expected fail, 共 673 用例全量通过）。


## 十二、高阶自动化测试策略深度架构分析（仅做架构推导，不编码实现）

以第一性原理重新思考：**Agent 运行时（Agent Runtime）的核心特质是什么？**
它是一个**长周期、多并发、受控于不确定性（LLM 输出与外部世界输入）、伴随外部持久化副作用（磁盘/网络/子进程）的状态机**。
传统的“手写确定输入、断言特定输出”或“手动 mock 一个固定 JSON 响应”的单元测试，只能覆盖程序员预想到的 Happy Path。面对大模型输出的不确定性、复杂时钟竞态和中途崩溃，这种静态测试的覆盖面极其有限。

若要将 Uina 打造为坚如磐石的工业级数字主体运行时，应当探索并落地以下四大自动化测试架构策略：

### 12.1 策略一：基于属性的状态机生成测试（Property-Based State Machine Testing）
- **核心思想**：
  放弃“手写特定操作序列”，转为定义系统的一组**永不破灭的领域不变量（Core Invariants）**。通过基于属性的测试引擎（如 `fast-check`）自动生成数千种包括乱序、截断、并发打断在内的随机操作指令序列（Model-based Testing）。
- **架构模型**：
  ```text
  [指令生成器 Command Generator]
     │
     ├── SubmitText(randomString, randomMode)
     ├── ModelStreamDelta(randomTokens, withThinking, malformedJson)
     ├── ToolExecutionResult(status, duration, error)
     ├── InterruptSignal(Esc / Ctrl+C)
     └── NetworkDisconnect()
     │
     ▼
  [执行被测状态机 Uina Host / Subject] ──VS── [纯同步简化参照模型 SimModel]
     │
     ▼
  [全局不变量断言 Invariant Assertions]
  ```
- **核心不变量（Invariants）定义**：
  1. **因果与 DAG 不变量**：无论受到何种随机扰动与回溯操作，`SessionStore` 中的记录必须永远构成一棵单根且无环的有向无环树（DAG），所有子记录的 `parentId` 必须溯源至合法祖先。
  2. **邮箱守恒不变量**：任何成功进入系统或排队的输入消息，最终必须且只能处于三种状态之一：`已在当前轮次完整执行`、`因中断安全退回输入栏`、`作为 pending 挂起等待唤醒`。绝不允许任何一条用户消息在内存中静默丢失。
  3. **生命周期收敛不变量**：在任意长度的随机事件混沌轰炸后，一旦输入停止，`Subject.waitForIdle()` 必须在有限步内 Resolve，且系统内部活跃的 EventListener 计数、Promise 链和子进程计数必须精确归零。
- **架构价值**：
  能够全自动寻找并最小化（Shrinking）出导致系统死锁或竞态的最短操作序列（例如：“连续两次并发输入 + 中途模型吐坏工具参数 + 立即按下 Esc”），极大地提升状态机的容错上限。

### 12.2 策略二：确定性虚拟时钟与离散事件仿真（Virtual Clock & Discrete Event Simulation）
- **现状痛点**：
  Uina 中大量存在与时间相关的严苛业务逻辑：
  - TPS 吞吐量与 TTFT 首字延迟的精确计账；
  - 终端 20 FPS 按需动态心跳调度与打字机平滑揭示；
  - 子进程与工具执行的超时（Timeout）判定；
  - 网络重试的指数退避（Exponential Backoff）。
  目前测试中假时钟、真实 `setTimeout` 与微任务交织，容易因事件循环微小的执行先后差异引发偶发失败（Flaky Tests）。
- **架构方案**：
  - 在运行时内核完全抽象时间依赖，禁止业务代码直接调用原生 `Date.now()`、`performance.now()`、`setTimeout`，统一由 `Clock` 端口注入（生产环境绑定真实物理时钟，测试环境绑定虚拟时钟）。
  - 构建**离散事件调度器（Discrete Event Simulator）**：时间不再随着现实物理世界的流逝而前进，而是由虚拟事件队列中的待办事件时间戳决定。
- **架构价值**：
  测试可以在 **100 毫秒的真实 CPU 时间内**，以纳秒级精度仿真模拟 Agent 运行 **7 天 7 夜** 的复杂心跳、超时重试与长周期任务，彻底消灭慢测试与 Flaky Tests。

### 12.3 策略三：真实模型交互流量的“录影带回放”（Deterministic Cassette Replay / Record-Replay）
- **现状痛点**：
  真实大模型 Provider（如 Anthropic、Gemini、OpenAI）的 API 协议变化频繁、SSE 流式分片粒度不可预测（有的模型逐 token 吐，有的模型一次吐一大段），而纯手写 mock 无法真实反映生产环境的协议细节。直接在 CI 中调用真实大模型不仅成本高昂，而且因模型输出不确定而无法进行严格的断言。
- **架构方案**：
  - 引入**流量录像带（VCR / Cassette Pattern）**机制：
    1. **录制模式（Record Mode）**：开发者运行一次带有端到端真实 API 密钥的基准用例，网关层（Gateway）将收发的所有原始 HTTP Header、TCP 连接状态、SSE 原始 Chunk 及精确到达时间戳序列化保存为压缩的快照文件（Cassette JSONL）。
    2. **回放模式（Replay Mode）**：CI 与日常单测断开所有外部网络连接，由虚拟网络层以 100% 逐字节对齐的方式重放真实的 SSE 流量。
- **架构价值**：
  测试既能完全还原真实生产 Provider 的严苛细节（如畸变格式、未预期的换行符、网络丢包），又具备 100% 离线、零 API 成本、纳秒级重放与绝对确定性的断言能力。

### 12.4 策略四：扩展与核心解耦的“契约合规性套件”（Extension Conformance Test Suite）
- **核心思想**：
  Uina 的长期定位是可扩展数字主体运行时。未来会有越来越多的外部开发者编写定制工具与能力扩展。必须防止“劣质扩展拖垮宿主进程”。
- **架构方案**：
  - 提炼并公开一套独立的 `defineExtensionConformanceTests(factory)` 测试工具包。
  - 任何扩展只需要调用该测试套件，即可自动验证以下合规性指标：
    1. **生命周期绝缘性（Sandbox Teardown）**：当扩展被卸载（`dispose`）后，检查是否仍有未解绑的全局 EventListener、挂起的 Promise 链或孤儿定时器；
    2. **错误击穿防护（Error Containment）**：在工具的 `run` 方法中故意抛出同步 `Error`、异步 `Promise.reject`、甚至抛出非 Error 对象（如字符串/null），测试宿主能否安全捕获并转换为 `failed` 状态，绝不引起主进程崩溃；
    3. **Schema 与参数规范一致性**：自动对扩展声明的工具参数 JSON Schema 运行各种畸变边界值（超长字符串、空类型、额外非法属性），验证其是否被严格拦截。
- **架构价值**：
  从架构根源上将扩展的健壮性验证标准化，彻底保障主运行时的核心稳定性。
