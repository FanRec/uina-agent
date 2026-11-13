# Uina 表达与声音体系重构：施工设计

> **代码基线**：[`FanRec/uina-agent@c28036d6`](https://github.com/FanRec/uina-agent/tree/c28036d6eaf98fc1772d7007cce028b0b22acabf)。执行前复核最新提交；新代码已落实的等价合同直接复用，不回退。  
> **任务范围**：模型输出解释、Speech/Voice/TTS、Embodiment Cue、Presentation、相关 Context Source，以及最小必要的 Host/扩展接缝。  
> **不做**：Skills、维护脚本、通用工具发现、TTS 运维命令平台、完整音频引擎、全局 Context Injection 旧 Hook 清理。

## 1. 产品目标与基本合同

本次交付的是 **通用输出表达机制 + Speech 领域能力 + 现有声音/具身/展示链路收口**，不是单纯 TTS 修补。

完成后，初奈可以在一条模型输出中自然交错**说话、展示文字和轻量身体线索**，不必为普通发声调用工具；表达在生成时即显示并流式送交执行；播放、字幕、身体与历史展示理解同一份语义。声音不可用时，文字和其他行动仍可继续。Agent 不必持续管理播放队列、轮询进度或反复维修 TTS。

例如：

```xml
<speech>等等……<cue id="surprised"/>这里竟然有钻石！</speech>

发现：钻石矿石 × 3
坐标：120, -54, 32
```

- 聊天正文显示“等等……这里竟然有钻石！”以及后面的发现和坐标，不显示标签；同一句话只展示一次。
- `<speech>` 内的文字才作为普通模型输出的发声意图；标签外仅显示文字，**不自动朗读**。
- `<cue>` 是有限的表现性线索：位于 Speech 内时关联该次声音；位于 Speech 外时按文本事件顺序执行。
- Speech 音频允许时按句段流式合成；**输入关闭不等于声音播完**，本地播完也不等于听众听见。
- 无需说话时可以直接使用工具或保持安静；不以说话、Cue 或工具调用次数衡量成效。

基本约束：**事实只有一个主人；解释只做一次；解释与副作用分离；稳定能力无需 LLM 维护；所有模型可见信息通过已有 Request Composer 装配。**

## 2. 已核实的代码事实与实施边界

| 现状 | 源码位置 | 决定 |
|---|---|---|
| Context Source Registry、Composer、Prompt 文件、请求来源和 Wire 检查已存在 | `src/{agent/composer,extensions/context-registry,extensions/prompt-compiler}.ts` | **复用**。Guidance 是 System 后、History 前的一条运行时 `user` 消息；Capability/Observation 是 History 后的运行时 `user` 参考消息，不得误写成 System 注入。 |
| 旧 `turn.prepare`、`turn.transformContext` 和 Provider Payload 接缝仍存在 | `src/agent/loop.ts`、`runtime/hooks.ts`、`extensions/runtime-hooks.ts` | 本轮只迁移声音/表达相关旧路径；全局 Wiring Cleanup 是独立工作，不重建/复活已删除的 Hook。 |
| 原始模型 `content` 以 `reply: string` 进入 Assistant History，输出事件是原文 | `agent/stream-collector.ts`、`core/types.ts` | Canonical 原文不改；新增唯一结构化解释结果及必要的最小注解。 |
| Host 与扩展分别观察输出，扩展观察者按串行 Promise 队列执行 | `agent/loop.ts::dispatch`、`extensions/host.ts::emitObserved` | 解释必须先在同步路径完成；消费者不可在公共输出观察链上等待 TTS 网络。 |
| Presentation 的 live/replay 都直接吃原始 `assistant.delta` | `presentation/ingest-{live,replay}.ts` | 一律改为语义展示视图；原始输出仅用于记录/诊断，不再重复增加正文。 |
| Voice 提供 `voice.speak/interrupt/status/manage`、`readAssistantText` 及模拟 Event Frame 的 Perception | `.uina/extensions/voice/*` | 以 Speech 取代；保留真实 `muted` 偏好，删除自动正文朗读及旧 Perception。 |
| TTS 解析 `<cue>/<think>`、清洗正文并提交 Bridge；Bridge/Driver 已拥有 Session、Epoch、取消、恢复、字幕、电平 | `.uina/extensions/tts/*` | 表达解释/分句归 Speech；**保留 Driver/Bridge 及其维护能力**，不拆重写。 |
| Embodiment 独立解析 Cue，TUI 再剥一次，TTS/Embodiment 协商 Cue Owner | `.uina/extensions/embodiment/*` | 删除重复原文解析；共同消费结构化事件/播放边界。 |
| 已存在 `tts` 模型维护工具、`tts_generate`、BodyRouter、`live2d`、`exec_command` | 对应扩展和 Tool Broker | 本轮 **保留 `tts` 工具的模型可见性**，不提前剥夺初奈自主维护能力；其余工具按下文收口。 |

源码基线是静态事实，不代表本次重构已经运行或通过测试。遇到更新后的代码，以本文件语义合同为准，不机械照抄旧路径。

## 3. 架构和唯一所有权

```text
                   Provider content stream
                            │
                ┌───────────┴────────────┐
                │                        │
         Canonical raw text       Output Interpretation
           （唯一原文）          （同步、单次、无副作用）
                │                        │
                │                   Expression Events
                │                        │
                │            ┌───────────┼────────────┐
                │            ▼           ▼            ▼
                │       Presentation    Speech     Embodiment
                │        文字视图      Utterance   Cue/BodyRouter
                │                         │            ▲
                │                   Delivery Port      │
                │                         │       播放边界事件
                │                    TTS Driver ────────┘
                │                         │
                │                 Python Bridge / Audio
                │                  ├─ 声音/字幕
                │                  └─ 电平 → Live2D 口型
                ▼
       Assistant canonical +
        最小表达语义注解
                │
       ┌────────┴──────────┐
       ▼                   ▼
  History Presentation   Model History View
       （无副作用）         （Provider 安全投影）

Speech → Guidance, Capability, Observation
Embodiment → Guidance, Capability
                                  ↓
                   既有 Context Source Registry / Composer
                                  ↓
                             Model Request
```

| 所有者 | 负责 | 不负责 |
|---|---|---|
| **Output Interpretation**（通用 Runtime） | 标签语法、流式解码、表达事件、原文区间、语法注册快照 | TTS、动作、网络请求、工具执行、展示策略 |
| **Speech**（扩展） | Utterance、语义分句、主动发声、静音控制、提交与交付事实、必要 Context | 自行重新解析模型原文、直接管理 Vendor/音频播放线程 |
| **TTS Driver/Bridge** | 合成和当前物理播放、Session/Epoch、停止/恢复、音频交付回执、字幕电平 | 决定普通模型正文中哪些应读出、管理 Cue 文本语法 |
| **Embodiment** | Cue Affordance、分发与身体控制；按已知播放边界驱动动作 | 解释模型原文、管理 TTS 源状态 |
| **Presentation** | 从语义内容生成单份可见文字；历史纯回放 | 发声、执行 Cue、重演工具 |
| **Context Source / Composer** | 将表达协议、有效能力、决策相关事实装配进请求 | 持有业务状态、自己决定修复 TTS |

不建立 Expression Journal、Speech 专用 Prompt Manager、通用维护框架、完整 Audio Mixer 或第二条语义事件总线。Audio 在本轮只是现有 Bridge 所提供的交付能力边界，未来真实出现多音源需求时再提炼 Bus/Mixer/Route。

## 4. Output Markup：受限协议

### 4.1 标签及注册

首版仅有两类：

| 类型 | 首批标签 | 合同 |
|---|---|---|
| Block | `<speech>...</speech>` | 标签内为 Speech 文本，可包含 Marker；不能嵌套 Block |
| Marker | `<cue id="nod" target="live2d"/>` | 该位置上的可选表现性动作，不是 Tool Call |

扩展在激活作用域内注册：

```ts
pi.registerOutputTag({ name: "speech", kind: "block" });
pi.registerOutputTag({
  name: "cue", kind: "marker",
  attributes: { id: "required-string", target: "optional-string" }
});
```

实现名称可调整，但合同固定：注册名在一个 Host 内唯一，重名拒绝并报告所有者；扩展卸载释放注册；**每个 content stream 的 `output_start` 冻结其语法快照**。中途卸载不改变该流文本如何解释，但不能延长已卸载扩展的执行授权。新流使用最新注册表。

只有**模型 `content` 通道**进入此解析器；Provider 原生 `thinking`、Tool Result、用户输入、外部网页、历史回放均不进入实时副作用链。 `<think>` 不注册为通用表达标签；若某 Provider 把推理泄漏进 content，由 Provider 兼容层显式处理，不让 TTS 及 Embodiment 各自吞掉。

### 4.2 确定的语法规则

- 识别标签名采用固定大小写规则（首版大小写敏感）；属性只接受双/单引号包裹的字符串；`cue.id` 必需，`target` 可选；未知属性、重复属性、无效属性、无效标签视为**原样文本**，不执行任何副作用。标签与待识别前缀有合理长度上限，超限退化为文本。
- 只识别完整的 `<speech>`、`</speech>` 和已注册自闭合 Marker。未配对的 `</speech>` 为字面文本；在 Speech 内再次遇到 `<speech>` 也作为该 Speech 的字面文本，不创建嵌套块；在 Speech 外的 `</speech>` 不执行任何动作。
- Markdown 代码围栏内、行内反引号代码内、被反斜杠转义的标签均按字面文本处理；围栏识别行首（至多三个前置空格）的连续反引号或波浪线（长度 ≥3），仅由同字符且长度不短于开头的围栏结束；行内代码采用相同数量反引号配对。未闭合代码区域持续按字面文本处理。不实现完整 Markdown，Markdown 字面转义本身由展示层处理，不由 Decoder 私自删改原文字节。
- 未注册标签完整出现时作为普通文本保留；即使它恰好叫 `speech` 或 `cue`，没有对应激活注册就不执行。**Speech 已注册但 TTS 离线时仍正常解释并展示语言文本**。
- Block 外的 `text` 没有 `scope`，Block 内的 `text.scope` 指向当前 `blockId/name`。具体是 Speech 还是其他表达用途由注册该标签的扩展解释，Core 不维护 `speech` 专属文本角色。同一流允许多个依次排列的 Speech Block；Marker 可处于任一位置。
- `output_end` 时，已打开但未闭合的 Speech 以 `ended` 隐式封口；`output_interrupted` 以 `interrupted` 封口；没有收齐的标签前缀在收尾时按原文字面输出。不得吞词、猜测补齐标签或把属性读成命令。
- 不实现任意标签树、DTD/实体、脚本属性或可执行 Marker。表达标签只能产生限制在表现域内的意图，不得绕过 Tool Broker 执行系统动作。

### 4.3 增量事件和原文区间

以下为概念合同，类/字段命名可随仓库习惯调整，但不可更改语义：

```ts
type ExpressionEvent =
  | { kind: "text"; streamId: string; text: string;
      scope?: { blockId: string; name: string }; rawRange: [number, number] }
  | { kind: "block_start"; streamId: string; blockId: string;
      name: string; rawRange: [number, number] }
  | { kind: "block_end"; streamId: string; blockId: string;
      name: string; reason: "closed" | "ended" | "interrupted";
      rawRange?: [number, number] }
  | { kind: "marker"; streamId: string; name: string;
      attributes: Record<string, string>; blockId?: string;
      rawRange: [number, number] };

interface ExpressionDecoder {
  feed(chunk: string): readonly ExpressionEvent[];
  finish(reason: "completed" | "interrupted"): readonly ExpressionEvent[];
}
```

- `rawRange` 是完整原始 `content` 中的 UTF-16 **半开**区间 `[start,end)`；显式关闭标签有区间，隐式收尾**没有**关闭标签区间。文字事件不允许把不相邻原文范围伪装成一个连续区间。
- `blockId` 在同一 `streamId` 中按出现次序稳定确定，不受 Token 分块影响；不同 Stream 相互隔离。事件可以分块输出，**规范化合并相邻同 scope 的连续文本事件后，内容、顺序、区间及标签身份必须与分块方式无关**。
- 解析器可以短暂保留尚不能判定的 `<` 前缀、反引号和代码围栏分隔符；一旦可判定就及时输出，最终必须释放残余字面文本。不得为等待 `</speech>` 缓存整段语音。配置上限只用于处理未完成标签前缀，不截断正常正文。
- `<speech>` 起始标签完整到达后，其后文本立即发出带有 `scope.name="speech"` 的增量；Speech 领域分句器可在标点或现有 `maxSentenceChars` 界限触发提交，不等待关闭标签。
- `ExpressionEvent` 是**结构事实**，不是行动命令。扩展不能在解析器内注入异步工作。

测试等价性示例：`"<spe" + "ech>你" + "好<cue id='nod'/>！</speech>"` 应等价于单块输入，产生 `block_start → text(你好) → marker(nod) → text(！) → block_end`。

### 4.4 唯一接线、事件顺序与持久化

Output Interpreter 由 **Subject 的 Output 分发入口**持有，每个 `streamId` 一份 Decoder。`TurnStreamCollector` 保持生成原始 `output_*` 事件；Subject 在将它们交给 Host/扩展前同步解释 `content`。不另建事件总线。

| 原始事件 | 必须完成的动作（按序） |
|---|---|
| `output_start(content)` | 冻结当前标签注册快照，建立 Decoder，再广播原始生命周期事件。 |
| `output_update(content)` | `feed(text)` 同步生成 `expression` 事件；将语义事件按顺序经**现有 Output 观察分发入口**广播。原始 delta 仍可给日志，但不进入展示/发声的业务解释。 |
| `output_end/content` | 先 `finish(completed)`、广播最后一批语义事件，再广播原始 `output_end` 并释放 Decoder。 |
| `output_interrupted/content` | 先 `finish(interrupted)`、广播收尾语义事件，再广播原始中断并释放 Decoder。 |

- 新 `expression` 事件属于 `OutputEvent` 家族：Subject 的 Host 订阅和 ExtensionHost 的 `emitObserved()` 均走**同一现有分发入口**，扩展队列按派发次序处理 `expression → output_end/interrupted`；不能把它改走另一个异步 `events.emit()` 路径。`ExtensionHost.flush()` 应覆盖这些事件，并在 `turn_end` 之前完成。Host 不持有第二份 Decoder。
- Interpreter 同步、无 IO；**Expression 观察处理器只允许同步推进语义状态、排入 Speech 自有异步队列**，不得 `await` Bridge、文件或网络。Speech 队列自行串行完成 `segment → close/stop`；不得拖慢模型输出或 UI。
- Presentation 对**模型内容流**只根据 `expression.text` 渲染；独立工具 `speech.say` 的可见文字按 §6.3 从已提交的 Tool Result 派生。原始 `output_update(content)` 仅用于记录、诊断和兼容监听，不再另发一份 `assistant.delta`。stdio、TUI、Web、headless 共用语义展示结果。
- **工具执行屏障**：当同一 Assistant 响应既包含 `content` 又包含 `tool_calls` 时，`TurnStreamCollector` 发出该流的结束事件后，Subject 必须在执行这一批模型工具**之前**等待现有 `ExtensionHost.flush()`，保证 Speech/Embodiment 已消费此前的语义事件。否则 `speech.stop` 或 `speech.say(replace:true)` 可能先执行、旧 `<speech>` 后注册并复活声音。`flush` 只等待快速本地入队，不等待音频网络/播放。
- 同流语义事件严格有序，不同流依 `streamId` 隔离。注解由 Decoder **同步**累积，在对应 `StreamCollectorResult` 生成 Assistant 消息时与原始 `content` 一起提交。显式贯通 `streamId → Assistant`；无 canonical Assistant 记录的流不产生孤立注解。**不以异步 Speech 队列是否完成作为注解持久化条件**。
- 冻结语法快照只保证旧流解释稳定；扩展注销后不能继续使用失效业务执行句柄。每个语义事件在消费时检查其能力拥有者仍有效；失效则只保留文字/注解，取消相应动作。

## 5. Speech 表达与交付

### 5.1 Utterance：表达受理与实际交付分离

**Utterance = 一次独立语言表达**，来源是一个 `<speech>` Block 或一次 `speech.say`；不等于 Turn、Stream 或播放器 Task。

```ts
interface Utterance {
  id: string;
  origin: { kind: "model_output" | "tool";
    streamId?: string; blockId?: string; callId?: string; invocationId?: string };
  text: string;
  inputClosed: boolean;
  state: "created" | "queued" | "playing" | "settled";
  settlement?: "completed" | "stopped" | "failed" | "unknown" | "not_played";
}
```

- **表达受理**只承诺 Speech 已记录有效表达意图，文字允许展示；**音频受理**只承诺 Driver/Bridge 已接受某段；**播放完成**必须有本地播放回执。三个阶段不可混称。`output_end` 只封口文本，Turn 结束不停止已封口声音。
- `not_played` 仅用于确定**整次表达没有音频被受理进入交付路径**（静音、明确未提交、全部明确拒绝等）；已受理后确认执行失败用 `failed`，存在未确认提交、停止或播放时用 `unknown`，不猜测。`completed` 只证明本地播放完成，不证明观众听见。
- 由 Speech 持有 Utterance 与其局部待提交文本/Cue；Driver 持有音频 Source/Epoch、提交/停止屏障及播放回执。按 `streamId + blockId → utteranceId → trace + segmentId → playback fact`，或 `session + invocationId → utteranceId` 关联。旧代回执不得修改新代状态。
- `utteranceId` 在实际创建时生成全局唯一值（或由会话身份、Stream/Block/Invocation 身份确定性派生），不得使用会在 Reload 后复用的简单自增编号；一旦写入 Tool Result/表达事实，不再改变。普通进程内同一 `invocationId` 重入只产生一个 Utterance，不能重复排音频。
- 对跨进程崩溃的未知物理副作用，不承诺无事务支持的 exactly-once：已有 Journal/工具恢复路径必须保留 `unknown` 或待核验语义，**不能自动重放不确定的 `speech.say`**。不新增持久化音频任务数据库。

### 5.2 交付端口和单一串行执行者

保持当前 TTS Driver/Bridge 的**合成+播放组合实现**；Speech 只依赖以下业务语义，接口名不强制相同：

```ts
interface SpeechDeliveryPort {
  submitSegment(utteranceId: string, segment: SpokenSegment): Promise<AdmissionResult>;
  closeSource(utteranceId: string): Promise<void>;
  stopSource(utteranceId: string): Promise<StopResult>;
  snapshot(): DeliverySnapshot;
  onPlayback(listener: (fact: PlaybackFact) => void): () => void;
}
```

`SpokenSegment` 至少含稳定片段身份、发音文本及本段 Cue 位置。`AdmissionResult` 至少可区分**受理、明确拒绝、未知**；未知不得按拒绝补播。Source 创建/封口、片段提交和停止由 Speech 为每个 Utterance 维护**同一顺序执行链**；共享输出设备的停止屏障遵循现有 Driver 的权威结果。

- Speech 负责分句、发音文本规范化和 Cue 对齐；TTS 负责物理执行与回执。不得重建 `Synthesizer → AudioChunk → Player` 的新物理分层。
- 已排入 Speech 的任务必须按 Source 顺序受理；公共 `expression` 观察处理器只更新本地状态并入队，不等待网络。Bridge 正常慢速、离线或故障不阻塞原始文本展示。
- 复用 Driver 的 Session/Epoch、维护互斥、提交/停止屏障、字幕、电平和进程所有权。删除 TTS 的第二套 `<cue>/<think>`/Markdown 原文解释；不擅自吞掉用户原本要说的语言。
- 工具 `speech.say` 返回的是**表达受理**结果，音频可以仍处于本地排队/待确认状态；工具结果正文不得写成已经播出。后续异步交付差异按 §7.3 处理。

### 5.3 停止、替换和静音：先关闭资格，再停止物理声音

| 事件 | 作用范围 | 确定行为 |
|---|---|---|
| `output_end(content)` | 此流尚未关闭的 Speech Block | 关闭输入，已受理的音频继续，待播片段正常收束。 |
| `output_interrupted(content)` | 此流尚在活动的 Utterance | 关闭输入并取消**未提交**音频/Cue；已受理音频按该来源停止，已封口的其他 Utterance 不受影响。 |
| `turn_aborted` | 本轮仍在接受输入的 Utterance | 与该来源中断相同，不全局停止既有声音。 |
| 新用户输入 | 无自动作用 | 是否停止由实际交互中断入口决定，不能把“收到文本”当成“音频已停”。 |
| `speech.stop(target)` | 指定 Utterance | 取消其本地待播、停止对应 Driver Source，如实返回边界。 |
| `speech.stop()` | 调用时已存在的所有 Speech 来源 | 冻结目标集合，取消其本地待播及 Cue，并停止这些来源；不触碰无关音频。 |
| `speech.say({replace:true})` | 调用时已存在的 Speech 来源 | 先校验新文本并冻结旧集合，停止确认后才创建/提交新 Utterance。 |
| `speech.set_muted(true)` | 声音偏好和全部 Speech 来源 | **立即禁止后续提交**，持久化偏好，并请求停止当前声音；持久化与物理停止各自报告。 |

**执行纪律：**

1. Speech 接到停止/中断/替换/静音时，**同步**标记目标来源 `inputClosed/cancelled`、递增该来源的本地提交代次，并清除尚未交给 Driver 的 Segment 与 Cue；此后旧队列任务即使醒来也必须检查代次，不得继续提交。上述同步动作不能等待 Bridge。
2. 对同一 Source，串行处理正在途中的提交及后续 `close/stop`：先等待在途提交**有界结算**（超时则结果未知），再按 Driver 所持有的 Source/Epoch 请求停止或阻断后续提交；停止结果未知就保持屏障，不得谎称停止成功。异步提交晚到即使返回 `accepted`，也不能绕过本地代次屏障而继续播旧队列。
3. **停止的返回结果区分 `confirmed / failed / unknown`。** Driver 无法确认停止时，不宣布已停，也不能继续在同一个可能仍在播放的输出路径上提交替换音频；保持现有物理交付屏障，直到 Driver 恢复或核验。普通 `stop(target)` 不妨碍确实独立的其他输出设备。
4. `replace`、`stop(all)`、`set_muted` 等跨 Utterance 控制操作按 Speech 接纳顺序串行；冻结的目标集合不会在 `await` 后扩大到后来创建的新表达。`replace` 未能确认旧输出安全停止时，新 Utterance **不予表达受理**，工具返回真实失败/未知，不显示“已经说了”文字。
5. 用户界面/输入系统的**明确语音打断动作**必须取消相应模型生成、等待先前语义输出进入 Speech 本地状态，再调用 Speech 停止入口；不允许先停音频、再让积压的旧 Expression 事件创建新语音。模型 `output_interrupted` 只证明生成侧中断，已封口但仍在播放的旧 Utterance 不由 `turn_aborted` 擅自杀掉。
6. 静音在内存中立即生效；偏好落盘失败时工具不得声称“已持久化”。解除静音只允许**新的**音频提交，不重播旧内容。

`OutputInterruptedEvent.spokenUntil` 当前其实是模型生成文本的 UTF-16 偏移，不是播放断点：重命名为 `generatedCharOffset` 或移除并修复消费者，禁止拿它描述音频已播位置。播放断点只按 Bridge/Driver 的可信分句事实报告；分句播放中断时不声称该句已完整说出。

### 5.4 Cue：标记位置决定片段边界

**语音中的 Marker 是时间锚点，不是可以任意挪到附近片段的装饰。** Speech 分句器将 Cue 位置视为**强制分段边界**：Marker 到达时，先将其左侧已累积的可发音文本封成片段，再将 Cue 放在右侧下一段的起始边界。即使普通标点分段尚未触发，也按此规则分段。因此流式解析不必提前知道整句全文。

| Cue 位置 | 执行边界 |
|---|---|
| Speech 内，有后续可发音片段 | 下一可发音片段的 `playback_started`；同边界多个 Cue 按原文顺序。 |
| Speech 内，位于结尾且没有后续可发音片段 | 前一可发音片段 `playback_completed` 后；没有前段则按下面的无音频路径。 |
| Speech 外 | 接到 Marker 时按该流语义顺序执行一次，不等待 TTS。 |

- **路由决策按 Utterance 进行。** 若任何音频片段已受理或其提交结果仍未知，Cue 只走音频事实驱动；停止、失败、未知时剩余 Cue 不补执行。只有**确认整次表达没有音频进入播放路径**（包括静音、离线、全部明确拒绝、纯 Cue），且 Block 正常闭合，才按原文顺序执行其未触发 Cue 的文本降级路径。文本路径启动后，此 Utterance 不再转回音频 Cue 路径、也不重新提交旧台词。
- 每个 Marker 的执行身份来自 `streamId + blockId + 原文位置`（工具来源若允许内部 Cue 则取 Utterance 内序号）；执行端对同一身份至多执行一次。消费前验证 Body 能力仍有效、Utterance 未取消、播放 Source/Epoch 匹配。扩展卸载/旧代迟到事件不能重新触发 Cue。
- 字幕用 Speech 文本和真实播放边界同步；口型只接 Speech 语言音频电平，停止和卸载后复位，不由音乐/音效电平推断。保留 BodyRouter、Live2D 动作、`VoiceLevelSink` 及现有 Bridge 播放 Cue 元数据通道；删除重复原文解析、`StreamingTagStripper`、Markdown `strip-cues`、`CUE_PLAYBACK_OWNER_SHARED` 和双解析协商，但不误删其他共享能力。

## 6. 显示、历史与模型历史

### 6.1 Presentation：一个可见文本出口

- **模型流**的实时可见正文只来自 Expression `text` 事件；Block 内外的文本进入同一个聊天文本流，标签不显示，文本保留 Markdown 语义。独立 `speech.say` 的可见表达是另一条合法来源，只从已经提交的 Canonical Tool Result 派生（§6.3）。
- 原始 `output_update(content)` 仍可记录/诊断，但**不得**再由 `presentation/ingest-live.ts` 生成第二份 `assistant.delta`。stdio/TUI/Web/headless 使用同一 Presentation 投影，不各自正则剥标签。
- `<speech>` 文字本身显示一次；字幕作为音频同步呈现可与聊天正文同时存在，但**不得在聊天正文里追加第二份相同台词**。
- 历史回放只从 Canonical + 表达注解得出文字与状态，不调用 Speech、Audio、BodyRouter、Live2D。显示投影与播放结算是两个独立事实层。

### 6.2 新 Assistant 消息：最小注解强制持久化

`AssistantAgentMessage.content` 继续保存**完整原始文本**。对于**新产生、已识别标签**的 Assistant 内容，**必须**同时保存最小 `expression` 注解；没有任何已识别标签的消息可以省略注解。注解仅记录协议版本、合法标签的原始区间/类型/属性、对应 Block 身份与隐式结束状态，**不**再保存一份清洗过的全文：

```ts
type ExpressionTagAnnotation =
  | { kind: "block_start"; name: string; blockId: string; rawRange: [number, number] }
  | { kind: "block_end"; name: string; blockId: string;
      reason: "closed"; rawRange: [number, number] }
  | { kind: "block_end"; name: string; blockId: string;
      reason: "ended" | "interrupted" } // 隐式结束不占原文
  | { kind: "marker"; name: string; blockId?: string;
      attributes: Readonly<Record<string, string>>; rawRange: [number, number] };
interface ExpressionAnnotation {
  version: 1;
  streamId: string;
  tags: readonly ExpressionTagAnnotation[];
}
```

注解必须在 Assistant canonical 提交时与其 `content` **同一条记录**落盘，包括有原文提交的错误/中断流，避免原文与另存元数据的双写竞态。收尾构造必须用准确 `streamId` 对应已经解析的内容；不可猜“最近一条流”。更新 Session v4 的可选字段读写验证/投影即可，**不改 Journal 版本、不建 Expression Journal、不改 Rewind/Compaction 语义**。

历史展示依据注解剔除已识别标签，并保留其他原文；即使相关扩展已经卸载也不能改变当时的可见文字。**旧的无注解 Assistant 历史一律原样显示**：不假设旧代码的正则就是未来语义，也不重新解释旧文本触发动作。这样兼容性有限但确定、不会误删旧代码示例；需要旧历史迁移应另做显式数据迁移，不在回放时猜测。

### 6.3 `speech.say`：表达事实以 Tool Result 为唯一历史来源

`<speech>` 与 `speech.say` 创建同类 Utterance；**工具 `text` 是纯文本，不进入 Expression Decoder**。字符串中的 `<speech>`、`<cue>` 等按普通文字处理，不执行标签；避免出现第二条解释路径。

1. 校验内容后分配基于 `session + invocationId` 的稳定表达身份；同进程同一调用重入只受理一次。若 `replace=true` 且旧声音停止无法确认，则**不受理新表达**、不创建可见台词。
2. 受理成功后，音频异步排入 Speech/Driver；工具**不等待播完**。Tool Result 的 `status:succeeded` 只表示表达受理成功，`result` 正文明确区分音频 `queued / not_played / unknown`，不得写“已经播放”。静音/离线时文字仍可被受理，音频 `not_played`。
3. **仅当工具真实受理且其 Canonical Tool Result 成功提交时**，保存 `details.speech = { version:1, utteranceId, text, accepted:true }`，由 `tool_call_id` 唯一关联来源；Presentation 实时与历史回放均由此生成**一份** Assistant Speech 文字。不得先乐观显示、失败后再猜测回滚；不新建伪 Assistant / Custom Message。
4. 工具执行失败、未受理、未开始的结果不生成“已说”文字。若音频副作用已经发生，但 Tool Result 落盘失败，不自动重试造成重复发声；继续保留真实未决执行事实，通过既有 Journal 恢复/诊断处理。没有原子事务时不能谎称跨崩溃恰好一次。
5. 后续音频完成或失败不会回写已提交 Tool Result。异步异常按 §7.3 的内部事件合同通知，日常详细状态由 `speech.status` 查询。`details` 不可靠进入 Provider Wire，关键受理/交付事实必须写在 `result` 正文。旧无 `details.speech` 的历史不推断曾经说过。

### 6.4 发给模型的历史视图与 Provider 约束

**历史展示**与**送给模型的历史**不是同一个投影。真实 Assistant 原文始终保留；本轮给模型的历史采用确定规则：

- 当活动 Provider 的历史转换支持文本改写、且当前请求的保留历史**不需要原生 Provider/签名回放**时，使用注解将 Assistant 中已识别的表现性标签语义化为普通文本（不改工具调用、工具结果、用户消息或 canonical），减少旧 Cue 被模仿。
- **只要保留历史存在必须原样回放的 `thinkingSignature` / `providerReplay` 或 Provider 的原生前缀完整性限制，整段 Assistant 历史保持原文，不做局部剥离**；不能为了减少标签导致 Provider 400 或损坏思考/工具调用协议。旧无注解历史也保持原文。
- 判断依据为现有 `Model.thinkingReplay` / 转换后的有效回放要求，不建立新 Provider 特例引擎；先实现保守兼容条件，无法确认安全时保留原文。该条件由单次 Model Request 统一决定，不能仅修改有标签的消息而破坏同请求内其他消息的签名。
- 行为实验可以调整未来默认策略，但**不是本次施工的未决选择**。

## 7. LLM 信息环境：复用现有 Context Source

### 7.1 Guidance（扩展静态说明）

Speech 扩展注册文件式 Guidance，使用已存在的 `pi.provideContext()` 和扩展资源根；示例：

```ts
await pi.provideContext({ id: "expression-guide", kind: "guidance", file: "prompts/expression.md" });
```

建议文件正文：

```markdown
## 表达
你可以直接行动或只展示文字，不必每次都说话。
要让听众听见的话放进 <speech>...</speech>；标签外只显示为文字，不朗读。
Speech 内文字也会在聊天中显示，不要把同一句话写两遍。
普通说话不需要调用工具；额外发声或停止旧发言时使用 speech 工具。
```

Embodiment Guidance 只说明 `<cue id="..."/>` 是可选的轻量表现性线索，不把动作映射成每句话必须做的行为。不要重复 Host Persona 的自主性规则、堆叠冗长示例，或将所有设备内部细节写入指南。

**真实 Composer 布局**：Guidance 在 System 之后、History 之前的唯一 `runtime.guidance` `role:user` 消息；不是 System，也不是新的用户命令。Prompt 文件注册后静态编译；动态值不得藏在文件里期待自动刷新。

### 7.2 Capability（只读当前能力）

Speech、Embodiment 分别注册 `kind:"capability"` 的只读 Source，来源是当前 Speech Runtime 与 BodyRouter/Live2D Affordance，而非单独维护的 Prompt 状态。

第一版固定规则：

- Speech 语法在 Guidance 中声明，不每轮重复；正常可用无需展开 Bridge/Vendor/采样率。**音频静音/离线/降级**时 Capability 明确说明“Speech 仍可显示文字，但当前不能播放声音”，状态恢复后自然消失。
- 若当前有主导的在线、未暂停身体，从其 Affordance 中按声明顺序选**最多 6 个**合法 Cue ID；附带已声明的简短含义（如有），没有描述就只显示 ID；无身体则不注入 Cue 目录；不编造动作描述，不把动作列表写成使用频率要求。
- 完整目录、诊断和状态继续通过 `body.status` / `live2d.status`；Capability 不执行 IO、不调用工具、不修改驱动。
- Source 没有有效内容时返回空/`null`，由现有 Registry/Composer 省略，不为了“结构完整”创建空参考消息。

### 7.3 Speech 信息交付：按认知用途，而非按 Driver 数据结构分类

**目标**：初奈知道此刻自己正在表达什么、表达是否发生意外变化、现在是否还能正常发声；除此之外，不因为声音系统正常运作而被打扰。本节替代旧版“积压/未交付/异常三类 Observation”。

| 真实信息 | 唯一首选出口 | 是否进入模型 |
|---|---|---|
| 当前**确实正在播放**的分句 | `observation` | 有可信当前分句时，只呈现一行 |
| 没有声音、正常播放完成、普通待播队列、分句计数、播放百分比 | 无 | 否 |
| 静音、音频能力当前不可用、持续阻塞 | `capability` | 仅异常/限制存在时的极短当前事实 |
| 意外打断、异步播放失败或结果未知、自动恢复后仍持续不可用的重大变化 | 内部 Runtime Input | 仅影响后续认知/行动时，一次事件交付 |
| Agent 主动调用 `speech.stop` / `speech.set_muted` / `tts.recover` | 原有 Tool Result | 由工具回执如实说明，不重复发送事件 |
| 排队详情、失败原因、具体提交/播放断点 | `speech.status` / `tts.inspect` | Agent 主动查询时才给 |
| 真实观众的发言或外部世界事件 | 原有外部输入 / `external_event_frame` | 与 Speech 内部事实严格分开 |

**不存在“全部都发到 Observation 再消费一次”的过渡层。** 内部来源事实与模型传输角色分离；不要新增 Speech 专属 EventFrame 协议、事件 Journal、通知管理器或独立 Tool Call。

#### 7.3.1 Observation：仅当前播放分句

Speech 注册一个 `kind:"observation"` Source。实现是**纯函数读取** Speech/Driver 最近一次可信播放快照；无新数据采样、HTTP 请求、队列消费或状态修改：

```ts
pi.provideContext({
  id: "speech-now",
  kind: "observation",
  read() {
    const line = speech.currentSpeakingLine(); // 纯读取、可返回 null
    return line === null ? null : {
      text: `正在说：「${line}」`,
      source: { type: "speech.playback", origin: "internal" },
    };
  },
});
```

`currentSpeakingLine()` 必须满足：

1. Driver/Bridge 已明确报告 `playback_started` 且当前仍处于 `playing`；排队、已提交、合成中或停止结果 `unknown` 均**不得**显示为“正在说”。
2. 通过 `utteranceId → trace/source → segmentIndex` 与 Speech 保留的源文字核对，呈现当前**实际播放的句段文本**（非整个 Utterance，剔除标签与 Cue）。分句按真实 TTS Segment 计算，不能用 LLM 生成进度估算。
3. 只取足够新的播放事实；连接中断、采样过时、来源身份不匹配或分句文本缺失时返回 `null`，不能沿用上一次“正在说”。现有 Bridge 播放状态/约 1 秒进度探测可复用；首版可用“超过两次预期探测间隔未得到可信更新”作为保守过期判据，具体以实际播放反馈能力验证。
4. Speech 当前只输出一路语言播放时，最多一行；不输出句数、剩余队列、百分比、时间估算、诊断、动作建议，也不重复来源正文中已经写明的其他信息。分句长度过长时按文本自然边界节制截取，不改变词义。
5. 播放结束或音频停止确认后立即变为 `null`；静音/离线/未知播放进度时也为 `null`。`read()` 被 Request Inspection 反复调用不改变快照；只对该次 Model Request 组装时刻的事实负责，不假装能在模型生成期间实时更新。

**当前 Context Composer 已将 Observation 放在 History 之后的 `role:user` 运行时参考区域，来源外壳由 Composer 生成**。扩展只返回正文 `正在说：「……」`，不附带 `[系统]`、强制命令或自行拼装 `user` 消息。正常静默时整个 Source 返回 `null`，不写“语音正常/当前空闲”。

#### 7.3.2 Capability：只提供当前负面限制

本轮继续使用 §7.2 的 Speech Capability：正常音频可用时不报“正常”；静音、无法播放、恢复后仍受阻时给一条短的当前能力事实，例如 `语音暂不可播放；Speech 文字仍会显示。`。**持续状态不放 Observation；原因与维护步骤留给工具查询。** 恢复后 Capability 自然返回 `null`。不要把“本地播放已确认”描述成“直播观众实际听见”。

#### 7.3.3 内部 Runtime Input：只传达值得知道的变化

Speech 内部事件是**已发生的事实**，不是 Observation，也不是 `external_event_frame`。首版只发以下类型：

| 事件 | 发出条件 | 去重范围 |
|---|---|---|
| `speech.interrupted` | 非预期音频中断或外部明确打断，使本来要说的内容未完整交付；已确认停止才能称“已停止”。 | 每 Utterance 最多一个中断终局 |
| `speech.delivery_failed` | 表达已受理后才确认的异步失败，且相应工具回执未覆盖此新结果。 | 每 Utterance 最多一个失败终局 |
| `speech.delivery_unknown` | 实际停止/播放仍不确定，并确实妨碍继续发声或判断上一段是否完成。 | 每个未决交付事实一次；已作为 Tool Result 说明则不再发 |
| `speech.unavailable` | 未静音的声音能力从可用/启动中进入不可用，确定性自动恢复失败；无人时也可唤醒自主维护。 | 每个故障阶段一次，恢复后再发生才开启新阶段 |

普通音频完成、分句切换、普通排队、主动静音及其预期停止均**不发事件**。事件不附修复步骤、不要求模型响应。设备持续不可用的**当前状态**只在 Capability 展示；事件只写发生过的变化。

**同一因果结果只选一个模型入口：**

- Agent 主动执行 `speech.stop/set_muted` 或 `tts.recover`，同步执行结果由 Tool Result 完整说明；Speech 在这一调用的 `invocationId` 下暂存的同一停止/故障事实不再单独发事件。之后真正出现的新异步结果才可再通知。
- 同一 Utterance 的中断、失败、未知可能是同一次交付事故的不同观察阶段；每个阶段只保留一个**最新、可证实**的终局说明，不将一个停止同时报告成中断、失败、未知三件新任务。若先前的未知已经通知，后来得到确认，可以发一次事实更新，但明确指向同一 Utterance，且不重复旧正文。
- 一次设备故障引起 Utterance 失败且同时进入 `unavailable`，本次唤醒优先使用具体表达失败事件；Capability 表达持续受限，不另发同一原因的 `unavailable` 事件。只有没有其他具体事件承担本故障阶段提醒时，才发独立 `speech.unavailable`。
- 当有人通过宿主明确打断音频、而模型尚未从用户输入或工具结果知悉实际停止结果时，可发一条 `speech.interrupted`。收到文本输入本身不构成音频打断事件。是否发消息依据**明确原因及交付事实**，不得在 Speech 内调用 LLM 评判“语义重要程度”。

使用现有 `pi.submitInput({ id, mode:"followUp", source:{kind:"runtime", origin:"internal", type, ref:"speech"}, text })`。Canonical 落 `runtime-input`，默认 Profile 投影成带来源标题的内部 `role:user`；不注册模拟工具。`submitInput` 空闲可唤醒、忙时排队合批，因此只有达到上表条件才调用。来源身份由结构元数据确定，不让正文自称“系统”改变权限。

#### 7.3.4 事件身份、时效和交付保证

- `utteranceId` / `invocationId` 与 Driver Source/Epoch 保持关联；事件 ID 由**真实原因身份 + 事件类型 + 对应阶段修订**稳定派生。故障阶段 ID 使用不跨 Reload 重用的身份。同一事实重复回调不得生成新的 ID；同文但不同真实事件不得按正文哈希合并。
- **先形成事实，再申请交付**。Speech 负责一次因果判断；已有 Mailbox 负责受理、去重、持久化、运行时 Follow-up 合批及会话投影。不要在 `observation.read()` 中消费事件、在 `turn.transformContext` 塞一次性帧，或自造通知 Journal。
- 事件正文使用带事实时间的**过去式**，例如“上一段发言在「……」期间中断；后续音频已确认取消”，不描述一个已经可能恢复的永久“当前状态”。当前限制由 Capability 提供。未知结果必须明确写未知。
- 事件可能排队：可选使用 `AgentInput.render()` 在实际提交历史前**纯判断**此通知是否已被后续事实覆盖；过时则返回 `null`。同时提供自足且准确的 `text`，因为重启后延迟回调不会恢复，现有 Mailbox 仍会按持久 `text` 交付。不得改变已经进入 Canonical 的过去事实。
- 复用宿主已有的输入受理与稳定 ID 去重：已提交的同身份输入由现有 Mailbox/Journal 去重，重复回调不得换 ID 绕过；不宣称跨进程崩溃前未落盘的通知恰好一次。通知提交失败按原 ID 做有限重试/诊断；不能生成新 ID 规避去重。
- 不通过等待同一个 Subject 新回合结束来完成当前 Hook。通知可异步提交，但调用方必须处理其失败；事件发送不改变 Driver 交付结算或 Utterance 生命周期。

### 7.4 Tool Result、按需诊断和可观测性

`Tool Result` 保留 Canonical 与可选 `modelView` 的已有合同。主动工具的结果必须自足说明操作受理、物理播放/停止是否确认及未知处；`accepted` 绝不等于 `played`，也不能将本地播放完成等同听众已听见。普通成功不触发内部事件或新推理；恢复建议不得习惯性附在每个结果里。

以完整实际 Model Request（Request Inspection / Assembly Trace / Provider Wire Observation）验证来源与位置：

- 说话时最多一行当前分句，静默时 `speech-now` 返回 `null`，不携带空容器；纯 `inspectRequest()` 不消费事件。
- 已提交的 `speech.interrupted` 在 Canonical 是 `runtime-input`，在默认 EventFrame Profile 下为内部 `user`；**不是** `external_event_frame` 合成 Tool Call。
- 用户原始外部输入仍保持原本来源与帧合同；不能因为 Speech 参与而改变其权限或角色。
- 已知操作结果只出现一次，Event/Observation/Capability 不互相抄写同一件事。

本轮只改 Speech 及其必需的 Context/事件调用接线。**不新增通用事件系统、消息角色、语义相关性模型、维护框架或 Tool Discovery**。

## 8. Agent 工具、偏好与维护范围

### 8.1 最终工具面

| 当前 | 本轮最终形态 | 决策 |
|---|---|---|
| `voice` | **`speech`** | 替换；普通对话用 `<speech>`，工具用于额外发声、停止、查询与持续静音设置。**不保留 `voice` 同义工具**。 |
| `tts` | **保留原工具及模型可见性** | 继续提供 `inspect/test/recover` 与明确目标重启；仅精简描述，不创建新的 `/tts` 运维体系或按需发现。初奈无人在场时仍可自主维护。 |
| `tts_generate` | **保留** | 仅生成 WAV 文件，不是实时说话渠道；本次可见性不变。 |
| `body` | **保留** | 身体路由/暂停/恢复，去掉重复 Cue 协议解释。 |
| `live2d` | **保留** | 完整动作、姿态、视线、服装；轻量 Cue 由输出协议解释。 |
| `<speech>`、`<cue>` | **表达语法而非工具** | 不以 Tool Call 次数衡量其使用效果。 |

### 8.2 `speech` 工具的确定合同

```ts
type SpeechToolArgs =
  | { action: "say"; text: string; replace?: boolean }
  | { action: "stop"; target?: string }                 // 省略 target = 停止所有 Speech 声音
  | { action: "status" }
  | { action: "set_muted"; muted: boolean };
```

- `say` 的 `text` 只作为**纯文本**，不解析 Output Markup；校验非空内容，确认表达受理后返回 Utterance ID，`status=succeeded` 只表示表达受理。音频可能仍待提交、`not_played` 或 `unknown`，必须在正文里如实说明；`replace=true` 在旧音频停止无法确认时不受理新台词。
- `stop` 按指定身份或 Speech 所管辖全部声音停止，返回确认程度与已知断点；不拿原始模型输出字符数冒充播放进度。
- `status` 默认仅返回当前输出可用性、静音、正在播/待播表达、必要未知事实；不倾倒 Bridge 诊断 JSON。
- `set_muted` 设置**持久偏好**并在静音时尝试停止全部 Speech 音频；偏好保存成功与硬件停止是否确认分别说明。`muted=false` 只允许后续发声，不自动重播已停止的旧内容。
- Tool Schema、说明和回执只谈自己的业务操作；普通说话格式属于 Guidance，当前能力属于 Capability，持续故障限制属于 Capability，必要的新异步结局属于内部 Runtime Input。

### 8.3 配置迁移

沿用现有主体偏好目录及 `muted` 值，保证用户原有静音选择不丢失。删除 `readAssistantText`（旧“自动朗读普通正文”开关）及 `voice.manage.set_text_reading`、`voice_driver:set_text_reading`。**旧 `readAssistantText=false` 不映射成静音**：它并非“禁止主动发声”，而新机制已经默认不读标签外正文。新会话仅使用统一 `muted` 默认值；不要长期维护旧字段和新字段的双轨状态。

### 8.4 维护能力的范围裁决

本轮 **不移除** `tts` 模型维护工具，不新增 Skills、脚本目录、通用 Tool Search、专用运维 CLI 或第二套维护 API。TTS Driver 继续做确定性的自动恢复；初奈遇到持续问题仍可通过现有 `tts.inspect/test/recover` 自主维护。以后单独设计更完整的按需发现与维护知识机制时，再改变工具默认可见性，不在本轮预支该能力。

## 9. 施工顺序、迁移与删除

实施过程中按实际最新代码调整目录与函数组织，**不能调整本文的产品合同、所有权和事件/持久化语义**。普通工程细节由 Coding Agent 决定。

| 顺序 | 施工单元 | 关键修改与删除 | 验收锚点 |
|---|---|---|---|
| **A** | 基线与测试 | 固定 SHA，运行相关现有测试；先补 Expression 语法/流顺序及持久化契约测试。 | 现有行为和新行为均可复现。 |
| **B** | Output Interpretation | 添加唯一 Parser/Tag Registry、`ExtensionAPI.registerOutputTag`、`expression` 归入原有 Output 观察分发、按 Stream 冻结与生命周期；补足 `streamId → Assistant` 注解提交链及 `flush` 顺序。 | 无语音/身体时语义解释仍可独立运行；无重复 Decoder。 |
| **C** | Presentation/History | live 只消费语义文本，replay 读取新注解，扩展 `AssistantAgentMessage` 可选 `expression` 字段及 Session v4 校验；工具结果可见表达恢复。 | 实时/回放/headless 一致；原文与 Tool Canonical 不变。 |
| **D** | Speech | 迁移 `.uina/extensions/voice` 至 Speech 业务；Utterance、幂等 `speech.say`、停止/静音代次屏障、`muted` 偏好和状态 Source。 | 原文 Speech 与独立 `say` 同一领域合同；停止与在途提交无复活竞争，排队与降级可靠。 |
| **E** | TTS 适配 | TTS 输入由 Speech 分句传入；保留 Driver/Bridge、字幕/电平、维护 `tts`、`tts_generate`；删除原始 `output_update` 自动朗读、TTS 的 Cue/Think Parser 与 `readAssistantText`。 | 音频不重复，慢 TTS 不阻塞输出，提交/封口/停止顺序正确。 |
| **F** | Embodiment | 改为消费统一 Marker 和音频事实，保留 BodyRouter/Live2D；删除 StreamingTagStripper、双重 Cue Ownership、TUI strip-cues。 | Cue 位置分段归属确定、至多执行一次；无音频时文本降级，取消不串线。 |
| **G** | Context/工具迁移 | Speech/Embodiment 注册 Guidance/Capability；Speech Observation 仅当前分句；异步重要结局按来源/阶段去重后走已有 runtime/internal `submitInput`；移除旧 VoicePerception Hook+服务；修改 `speech/body/live2d/tts` 工具描述与结果。 | 空闲/正常结束不注入；中断是内部 `user` 输入投影而非假工具回执，不重复 Tool Result。 |
| **H** | 删除与收口 | 删除所有继续生效的旧 Voice/自动正文朗读/原文 Cue 解析路径；更新既有测试与文档，完成平台与设备回归。 | 新旧双轨不并存，全部发布门通过。 |

**唯一切换边界**：旧 TTS 的正文监听和新 Speech 消费不能在同一模型输出流同时启用。可按依赖组合为更少批次，但切换后必须彻底清理旧入口及过时测试假设。若其他分支已完成全局 Context Wiring Cleanup，不可恢复旧 Hook。

保留 `TtsVoiceOutputDriver`、Python Bridge、合成模型、停止屏障/恢复、字幕服务、声学电平、BodyRouter/Live2D 引擎、Context Source/Composer、Session Journal/Rewind/Compaction。只有它们与本次新增合同直接冲突的窄接缝可改变。

## 10. 验证与发布门

### 10.1 确定性测试

1. **Parser**：单块/单字符/随机 Chunk 输入产生同一规范化结果（含 UTF-16 原文区间、Block ID、显式闭合 range、隐式闭合原因）；覆盖合法/非法标签、嵌套、未知属性、重复标签、Markdown 围栏和行内代码、转义、未闭合、多个 Stream、模型中断。`<speech>` 在未闭合前就能流式提交第一段有效可发音文本。
2. **唯一消费**：一次模型 Content delta 的所有消费者取自同一 Interpreter；TTS、Embodiment、TUI/stdio 不各自解析原文；慢 Bridge 不阻塞模型生成和 UI；`output_end` 的最后文字/Marker 早于对应生命周期关闭。工具 `speech.say` 的可见文字只来自已提交 Tool Result，不通过 Interpreter。
3. **同源分发**：`expression` 与原始生命周期经过同一 Output 观察队列；`output_end` 前全部语义事件已排入，`turn_end` 前 `flush` 完成。模型响应同时有 Speech 内容与 `speech.stop/replace` Tool Call 时，必须先 `flush` 再执行工具；模拟慢 Bridge、乱序和多流，验证 Source 不提前关闭或在停止后复活。
4. **注册/Reload**：标签重名拒绝并标明所有者；旧流冻结语法，新流使用新语法；扩展卸载立即失去执行权，历史展示仍由已持久化注解稳定恢复。
5. **Canonical 注解**：新含标签 Assistant 消息的 `content` 原样、`expression` 注解与消息原子持久化；中断但落史的流亦正确；Session v4 读写、Rewind、Compaction 不损坏；旧无注解历史原样、安全展示；历史重放绝不发声音和动作。
6. **Provider 兼容**：含 `thinkingSignature/providerReplay` 的请求历史保持原文与完整 replay；无签名且可改写历史才应用语义模型视图。OpenAI-compatible、Anthropic、Gemini 的正常请求不被模型历史改写破坏。

### 10.2 Speech / UI / Body / TTS 组合测试

| 场景 | 必须验证 |
|---|---|
| `<speech>你好。</speech>` | 聊天即时显示一次、音频只提交一次，无正文自动朗读。 |
| `<speech>前句。<cue id="nod"/>后句。</speech>` | Marker 强制封左侧片段，Cue 绑定右侧 `playback_started`；末尾 Cue 等左段 `playback_completed`；不念标签属性。 |
| 普通正文、代码、未知标签 | 完全不自动朗读；代码里的标签不触发效果。 |
| Speech 外 Cue | 仅触发一次对应轻量动作，不额外触发音频。 |
| 静音/离线 | `<speech>` 和成功受理的 `speech.say` 文字仍可见，音频如实 `not_played`；恢复不重播旧内容。 |
| `speech.say` | `text` 原样、Markup 不执行；同 `invocationId` 重入只受理一次；成功 Tool Result 的显示事实实时/回放一致；Result 未落盘不乐观显示或自动重播。 |
| `speech.stop()` / `stop(target)` | 停止请求先禁止本地待提交；模拟旧 HTTP 提交晚回/超时，确认停止后不复活；未知时保持物理屏障、不放行替换；不误杀新来源。 |
| `set_muted` | 静音立即阻止所有新片段提交，偏好持久化与物理停止分开报告；解除静音不重播旧内容。 |
| 音频尚在播时模型 Tool Call/下一轮 | 输入封口而音频可继续，播放结算不随 Turn End 提前发生。 |
| Model output interrupted / `turn_aborted` | 只停止正在活动的相关来源，不误杀独立 `speech.say` 或旧已封口音频。 |
| 旧回执、重复/延迟 Cue 事件 | 按 Utterance + Segment + Source/Epoch 校验，不跨代或重复执行；音频提交未知不转文本补 Cue。 |
| TTS 慢、失败、未知 | 模型输出和展示继续；交付事实准确；不因普通 accepted 诱导轮询。 |
| Body/TTS 各自离线或卸载 | 其他表现不受影响；没有无主事件、队列或持续唇形。 |
| 运维 | **`tts.inspect/test/recover` 仍为 LLM 可用**，现有自动恢复与 Driver 事实不被破坏。 |

### 10.3 Speech 信息交付专项验收

| 情境 | 预期 Model Request / 行为 |
|---|---|
| 正常空闲、TTS 正常 | Speech Observation 与 Capability 均 `null`，没有空壳标题、正常完成通知、修复建议。 |
| TTS 正在播放第二分句 | Observation 仅 `正在说：「当前分句」`；不报分句总数、剩余数量或百分比。 |
| 只有待播、刚提交、进度过时、停止未知 | 不冒充“正在说”；不存在可信当前播放句时返回 `null`。 |
| 正常播放完成 / 普通排队 | 不发内部事件、不产生 Agent Turn。 |
| 非预期中断且已确认停止 | `runtime/internal` 的 `speech.interrupted` 单条输入；准确指出中断时句段，后续仅在确认取消时声明不再播放。 |
| 中断停止结果未知 | 不说“已停止”，以一次有真实身份的内部事件报告未知；当前播放位置无法确认则不显示。 |
| `speech.stop` 工具已返回完整结论 | 同一 `invocationId` 内的同期停止事实只通过 Tool Result；后来新失败才允许事件。 |
| 未静音，启动/恢复后仍不可用 | Capability 呈现当前限制；每个不可用阶段最多一次内部事件；已有表达失败事件承担通知时不再重复发送 `unavailable`；普通 Probe 失败不造成事件风暴。 |
| 恢复正常 | Capability 消失，无周期性的“恢复正常”或“语音空闲”通知；旧事件是过去事实而非当前状态。 |
| 延迟事件已过时 | `render()` 可在提交前取消通知；重启丢失回调后持久正文仍是真实的过去式事实。 |
| Preview / Preflight / Compaction / Reload | Observation 只读；不消费或重复事件。Event 经过 Canonical Input、`runtime-input`、内部 `user`，正常外部输入仍为原有 `external_event_frame`。 |
| LLM 认知对照 | 固定模型、语境比较无/有当前分句 Observation 的任务行为、无谓 `speech.status`、重复发言和中断率，不以更多音频工具调用为正向指标。 |

### 10.4 Context 与行为验证

使用真实 Request Inspection、Assembly Trace、Provider Wire Observation 检查 Guidance 位置、Capability/Observation 的当前事实、内部 Runtime Input 的 `user` 投影、外部 `external_event_frame` 的来源边界、工具名称/Schema/顺序、历史语义投影及 Provider 最终发送内容。不能把预览当作已发送请求。

固定模型、输入和能力条件，对照测试普通对话、Minecraft 持续行动、Live2D 自然 Cue、声音中断/积压、设备降级；加入无 Speech Observation / 极简当前分句 Observation 的消融对照，检查模型是否过度关注音频：评估 Speech 标签遵循、无意义工具调用、重复发言、动作过密、排障过度、真实任务完成和声音延迟。**不以工具调用数或 Cue 频率越高越好**。若实际结果退化，记录真实 Request 与执行链定位，而不是继续追加泛泛 Prompt。

### 10.5 工程门

按当前 `package.json` 执行相关 Vitest、Python Bridge 协议/播放测试、`pnpm typecheck:fast`、`pnpm check:boundaries`、`pnpm test:dev`，Presentation/Web 改动需验证相应构建；设备级实际听音、字幕/Live2D/停止验证单列。记录基线与重构后真实结果及不可运行原因，不以“新增测试”冒充通过。

提交前全局检查：**无继续生效的原文自动朗读、双 Cue Parser、VoicePerception 注入、`readAssistantText` 运行开关、旧 `voice` 工具或多重正文展示**；有任何遗留的 TTS 维护工具是**本轮有意保留**，不是清理失败。全局 Context Wiring Cleanup 若仍存在旧 Hook，不属于本轮验收失败。

## 11. 非目标与完工判定

不开发 Skills/维护脚本、按需工具发现、Audio Mixer、音乐/音效混音、Hearing、通用事件管理器或新的 Context 注入平台；不删除现有 `tts` 维护工具。

可沿一条真实输出追踪 `Canonical 原文 → 唯一 Expression 语义及注解 → 唯一文字展示 → Speech Utterance → Driver/Bridge 播放事实 → 字幕/Cue/口型 → 必要的 Capability / 当前分句 Observation / 内部事件`；工具 `speech.say` 独立沿 `Tool Call → Utterance → Canonical Tool Result → 展示/回放` 闭环。停止后旧任务不复活，播放结果未知不被猜成成功，正常运行不打扰模型。

## 参考

- [仓库实施基线](https://github.com/FanRec/uina-agent/tree/c28036d6eaf98fc1772d7007cce028b0b22acabf)
- [既有 Context Injection 设计](https://github.com/FanRec/uina-agent/blob/c28036d6eaf98fc1772d7007cce028b0b22acabf/docs/refactor/Uina-LLM-Context-Injection-Refactor-Design.md)
- [既有 Extension Prompt Files 设计](https://github.com/FanRec/uina-agent/blob/c28036d6eaf98fc1772d7007cce028b0b22acabf/docs/refactor/Uina-Extension-Prompt-Files-Design.md)
- [当前 Voice/TTS 业务合同](https://github.com/FanRec/uina-agent/blob/c28036d6eaf98fc1772d7007cce028b0b22acabf/docs/voice-tts/voice-tts-runtime.md)
- [Lost in the Middle (TACL 2024)](https://aclanthology.org/2024.tacl-1.9/)
- [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
