# Live2D App / Voice / Embodiment 连通性审查报告

状态：**审查报告 v1（未改动任何代码）**
日期：2026-09-21
范围：`.uina/worlds/live2d/`、`.uina/extensions/embodiment/`、`.uina/extensions/voice/`、`.uina/extensions/tts/`、`src/extensions/world-framework/`
基线：`tests/{embodiment-runtime,live2d-app,live2d-motion-core,voice-extension,tts-extension}.test.ts` 共 **100 例全绿**（`--pool=vmThreads`）

---

## 0. 判定摘要

| 结论 | 内容 |
| :--- | :--- |
| **设计层** | 三份规范自洽、边界清晰、概念正交。第一性原理站得住。 |
| **实现层** | 代码基本写全（四层合成器、17 条 cue + 别名表、通道仲裁、反射策略、双阈值断句、防误杀打断），**但四条关键接缝从未接通**。 |
| **测试层** | 100 例绿灯，全部使用 mock 端点与 mock `callService`，**恰好绕过了断裂点本身**。绿灯是假阳性。 |
| **门禁层** | `.uina/**` 不在 `tsconfig` include 内，只因**已 gitignore 的测试**引用而被传递覆盖；`embodiment/index.ts`（含激活装配的整个入口）是本子系统**唯一漏网文件**。 |

一句话：**这不是"功能没做完"，是"零件都造好了、从来没拧在一起，而质检抽查的全是零件本身"。**

---

## 1. 审查对象与边界

三层物理归属，全部在 `src/` 之外：

| 层 | 路径 | 形态 | 入库 |
| :--- | :--- | :--- | :--- |
| 宿主底座 | `src/extensions/world-framework/` | 内置 capability（8 文件） | ✅ 入库 |
| 系统扩展 | `.uina/extensions/{embodiment,voice,tts}/` | 直接接收 `pi` 的 Extension | ❌ gitignored，各自独立 git 仓库 |
| 大模型应用 | `.uina/worlds/live2d/` | 零 `pi` 契约（纯 `WorldDef`） | ❌ 同上 |

**关键结构差异**：App 与 Extension 是两种不同契约——

- Extension 拿 `pi`，可 `on()` 订阅 `RuntimeEvent`、`onHook()` 注册干预、`registerService()` 暴露服务（同进程函数，不经序列化）。
- App 只拿 `ServiceCompanionContext`（纯数据字段），其 `callService` 强制 `structuredClone` 双向。

Live2D 是 App，却需要登记一个**行为对象**（`BodyEndpoint` 的 4 个方法）到 Extension 的注册表里。**这个结构错配就是全部 P0 缺陷的共同根因。**

---

## 2. 事实清单（可复现）

| # | 事实 | 复现方式 |
| :--- | :--- | :--- |
| F1 | `structuredClone(endpoint)` 抛 `DOMException: function random() could not be cloned` | 经 jiti 载入 `runtime.ts`，`new Live2DRuntime().endpoint` 直接克隆 |
| F2 | `callService` 对入参与返回值双向 `structuredClone` | `src/extensions/runner.ts:558-564` |
| F3 | `ServiceCompanionContext` 只有 7 个字段：`signal / submitInput / isBusy / appDataDir / onActivity / callService / hasService`；**无** `audioSink / onHostEvent / bodyRouter / vtsClient` | `src/extensions/world-framework/types.ts:60-75` |
| F4 | 上述四字段在 `Live2DCompanionContext` 有声明，但**全仓无任何填充点** | `runtime.ts:85-90` 声明 vs `app-registry.ts:120-144` 实际构造 |
| F5 | `playback:pcm` 全仓只出现在 design doc 与消费者侧，**零生产者** | 全仓 grep |
| F6 | `StreamParser.feed('<cue id="warm_smile"/>我在这里。')` → `'<cue id="warmsmile"/>我在这里。'` | 经 jiti 载入 `stream-parser.ts` 实测 |
| F7 | 桥侧 `_sanitize_vendor_text` 只放行 Unicode 类别 `L/N/P*`；`<` `>` `=` 均为 `Sm` 被过滤 | `synthesis_handlers.py:133-187` + Python `unicodedata` 实测 |
| F8 | 桥侧**没有任何 RMS / 包络 / 能量计算**；`/v1/tts/events` 只承载 grapheme 级 `revealed_count` | `subtitle_sync.py`、`server.py` grep |
| F9 | 桥侧口型走 `[streaming].mirror_device = "CABLE Input (VB-Audio Virtual Cable)"`，另有 `[lipsync_bridge] enabled = false`（指向 8105，未启用） | `config/service.toml:40,66-75` |
| F10 | `tests/` 下 17 个文件引用 `.uina/`，其中 5 个关键测试被 `.gitignore` 第 28-34 行显式排除 | `git check-ignore -v` |
| F11 | `.uina/**` 不在 `tsconfig.json` include 内；经 gitignored 测试传递覆盖 55 个文件，**仅 `embodiment/index.ts` 与 `pacing-ticker/index.ts` 漏网** | `tsc --noEmit --listFiles` 对比 `find` |
| F12 | 全仓无 ASR / VAD / 麦克风实现（grep `asr\|vad\|whisper\|麦克风` 零命中） | 全仓 grep |

---

## 3. 接缝逐条判定

### S1 端点注册链 — **断（P0）**

```
Live2D 端点实例 ──✕──> embodiment:register_endpoint ──✕──> BodyRouter
```

`Live2DRuntime.start`（`runtime.ts:143-158`）走 `callService("embodiment:register_endpoint", this.endpoint)`。`callService` 对入参 `structuredClone`（F2），而 `BodyEndpoint` 实例持有：

- 原型方法（`affordance/state/emitCue/safeStop/onFocus`）——`structuredClone` 会**静默丢弃**
- 自有属性中的闭包（`ChannelArbiter.cueDispatcher` 由构造函数注入）与原生函数引用（`PhysiologicalNoise.randomFn = Math.random`）——`structuredClone` **直接抛 DataCloneError**（F1）

异常被 `catch` 吞成 `console.warn("[Live2D] 注册到 embodiment 扩展服务失败")`。**端点永不入 router。**

测试为何漏过：`tests/live2d-app.test.ts:553-571` 用 `vi.fn().mockResolvedValue(undefined)` 冒充 `callService`，断言"被调用过、参数含 `bodyId`"——**恰好绕开了真实序列化**。

### S2 cue 词汇注入链 — **断（P0，S1 的因果下游）**

```
BodyAffordance.cues (17 条) ──✕──> turn.prepare 具身视口 ──✕──> 模型系统提示
```

`projectEmbodimentContext`（`context-projector.ts:10-13`）在 `getPrimaryEndpoint()` 为空时返回 `undefined`。router 恒空 → **17 条 cue id 与描述从未进入系统提示**。

后果被放大：模型唯一的信息源是 live2d 门面工具的 description，其中只说"在台词中使用 `<cue id='...'/>`"，**不枚举任何合法 id**。即模型连"有哪些 cue 可以发"都不知道。

### S3 cue 派发链 — **断（P0，S1 的因果下游）**

```
output_update ──✓──> StreamingTagStripper ──✓──> BodyRouter.dispatchCue ──✕──> endpoint.emitCue ──✕──> resolveCueToBeat
```

前半段完全正常（`embodiment/index.ts:48-64` 正确订阅并解析，跨 chunk 切分与 `x < 3` 防误伤都处理了）。派发进空 router 后 `candidates.length === 0` 直接 `return false`。

**代价最大的静默失效**：`Live2DEndpoint.emitCue` → `resolveCueToBeat`（17 条 cue + 全套别名 + 去下划线归一化）→ `playExpressiveBeats` 这条**已完整实现的表现力主线**，在真实运行中从未执行过一次。

### S4 语音意志链 — **通 ✅**

```
语音工具 → VoiceSession → voice_driver:{set_muted,interrupt,get_status} → TtsVoiceOutputDriver → 桥
                           （hasService 探测 + callService 纯数据）
```

设计得干净：`VoiceSession` 权威拥有"意志"（enabled/muted）与"交付断点"，物理播放事实全权代理自 driver，不自建第二状态机。`expectedTraceId` 防误杀竞态也做对了（`session.ts:91-109` + `driver-impl.ts:70-76` 双侧校验）。断点经 `world query()` 单轮退火投影，次轮蒸发为 0 token——这个设计很优雅。

此链路是三条腿里唯一真正跑起来的。

### S5 音频旁路链 — **断（P0）**

```
TTS 播放 PCM ──✕──> playback:pcm ──✕──> AudioObserver ──✕──> 口型 + Layer 3 声学微冲
```

双向都断：

- **生产端不存在**：全仓无 `playback:pcm` 生产者（F5）；`voice/events.ts` 定义了 `AudioPcmChunk` / `VoiceLevelEvent` 两个契约，**两个都无人生产**。
- **消费端接不上**：`runtime.ts:161-172` 绑定 `companionCtx.audioSink`，而该字段无填充点（F3/F4）→ 整段绑定被 `if` 跳过。
- `AudioObserver.processPcmChunk` 与 `processLevel` 全仓**只被测试调用**。
- Layer 3：`MotionComposer.triggerAcousticImpulse` 无真实调用者，`acousticImpulseY` 恒为 0。

**同时暴露一条文档未记录的既有实现路径**：桥把 PCM 镜像到虚拟声卡 `CABLE Input`（F9），由 VTS 自行解算口型。即"口型是动着的"，但走的不是设计文档写的那条路。

### S6 宿主反射链 — **部分断（P1）**

```
HostEvent(turn_start)     ──✓──> onActivity ──✓──> ReflexDirector.onTurnStart
HostEvent(thinking)       ──✕──> 死分支（event.type === "thinking" 不是 RuntimeEvent 词汇）
HostEvent(turn_end)       ──✕──> onHostEvent 未提供
HostEvent(turn_aborted)   ──✕──> onHostEvent 未提供
```

`runtime.ts:175-195`：`onHostEvent` 无填充点（F4）→ 落到 `onActivity`（仅转发 `turn_start`）。**4 个反射策略里 3 个不可达**：`onThinking`（歪头思考姿态）、`onTurnEnd`（体态回归）、`onTurnAborted`（急停）全是死代码。

另注：`event.type === "thinking"` 这个判断本身就是错的——thinking 走 `output_update` 的 `channel: "thinking"`。即使补上 `onHostEvent`，这一支仍然不通。

### S7 打断闭环链 — **未实现（需求缺口）**

voice-architecture §3.4 承诺"人类开口 → VAD ≤80ms → interrupt 闭环"，`§5` 拓扑列出 `asr/{audio-capture,vad,whisper-client}.ts`。**全仓零实现**（F12）。

现状：`interrupt` 只可能由两条路触发——模型自己调 `voice({action:"interrupt"})`，或 `turn_aborted`。**人类永远无法用开口打断主体**。这是设计承诺与实现之间最大的一处空洞。

### S8 身体管理链 — **实现完整，但被 S1 架空**

`BodyRouter` 的 `register/unregister/dispatchCue/setFocus/pause/resume/stopAll` 与 `body` 工具的 5 个 action 都实现了，`pause` 还正确调用了 `safeStop()`。但因为 S1，`endpoints` 恒空：

- `body({action:"list"})` 恒返回 `[]`
- `switch_focus` / `pause` / `resume` 恒返回"未找到有效端点"
- `projectEmbodimentContext` 的"辅助身体"分支永不触发

---

## 4. 死代码与投机接缝清点

分三类，每项按 AGENTS.md「无效或未接线机制应删除或明确失败」给出**三选一建议**。

### 4.1 已实现但从未接线的生产代码

| 对象 | 位置 | 建议 |
| :--- | :--- | :--- |
| `MotionComposer.playClip` / `MotionClip` / `evaluateSegment` / `activeClips` | `motion-composer.ts:13-18,44-51,198-271` | **删除**。Layer 1 无加载器、无 `motion3.json` 解析、无调用者；保留即为"看起来有四层，实际三层"的欺骗性代码 |
| `AudioObserver.processPcmChunk` | `audio-observer.ts:69-93` | 视 §7 B1 裁定 |
| `AudioObserver.processLevel` | `audio-observer.ts:98-110` | **接线**（推荐，见 §7 B1）——这是最经济的口型/微冲通路 |
| `MotionComposer.triggerAcousticImpulse` + `acousticImpulseY` | `motion-composer.ts:57-60,152-157` | 随 B1 同进退 |
| `Live2DRuntime` 的 `audioSink` / `onHostEvent` / `bodyRouter` / `vtsClient` 四个分支 | `runtime.ts:143-195` | **接线**（补 ctx 字段）或**删除**（若判定不需要） |
| `ReflexDirector.onThinking` / `onTurnEnd` / `onTurnAborted` | `reflex-director.ts:42-85` | **接线**——这三个是真实表现力需求，不是装饰 |
| `Live2DCompanionContext` 四个扩展字段 | `runtime.ts:85-90` | 随上项同进退。**声明了却无人填充的契约字段，比没有更糟**——它让读者以为已接通 |
| `Live2DStateTracker` 之外的 `getLive2D*` 兼容访问器（6 个） | `index.ts:17-44` | **删除**。注释自称"向后兼容测试"，即生产零用途 |

### 4.2 无生产调用者的服务面

| 服务 | 注册处 | 建议 |
| :--- | :--- | :--- |
| `voice:register_driver` | `voice/index.ts:15-17` | **删除**。`VoiceSession.registerDriver` 是测试专用注入口，生产走 `voice_driver:*` |
| `voice:set_muted` / `voice:interrupt` / `voice:get_status` | `voice/index.ts:20-37` | **保留但标注**。当前唯一潜在消费者是 tts 的 `tts` 服务（见下），而 `voice` 门面工具直持 session 不经此处。属于"给未来扩展留的口"，可保留但需在注释中写明当前无消费者 |
| `tts` | `tts/index.ts:43-73` | **删除或明确**。它内部转发到 `voice:*`，但自己无人调用——纯转发层 |
| `embodiment:get_router` | `embodiment/index.ts:29` | **删除**。暴露活对象给其他扩展，同样过不了 `structuredClone`；留着只会再招一次 S1 类错误 |

### 4.3 投机性设计（文档有、代码无）

| 设计承诺 | 出处 | 状态 |
| :--- | :--- | :--- |
| `src/extensions/voice/{text-sanitizer,sentence-chunker,audio-sink,tts/,asr/}` 拓扑 | voice-architecture §5 | 实现完全不符：清洗/断句/合成/播放全迁至 tts，voice 只剩"意志 + 断点" |
| 对 LLM 暴露 **0 个 Tool** | voice-architecture §1.1 | 与现实的 `voice` 门面工具直接矛盾 |
| 全双工打断（麦克风/VAD/ASR） | voice-architecture §3.4 | **零实现** |
| Level 2 视素/音素对齐（`playback:viseme`） | voice-architecture §4 | 未实现，且无契约定义 |
| `emitCue(cueId, payload?)` | embodiment-architecture §3.1 | 实现只有 `emitCue(cueId)`，`payload` 不存在 |
| Layer 1「美术级关键帧剪辑 motion3.json」 | live2d DESIGN.md §3 | 未实现（见 4.1） |
| 「双频 Perlin 噪声的身体微小重心晃动」 | live2d DESIGN.md §3.1 | 名不副实：`PhysiologicalNoise` 返回 `ParamBodyAngleX: 0` 硬编码，重心游移实际只体现为头部倾角，躯干不动 |

---

## 5. 额外发现：门禁存在结构性盲区

| # | 发现 | 证据 |
| :--- | :--- | :--- |
| G1 | `.uina/**` **不在** `tsconfig.json` 的 `include`（只有 `examples/src/tests/scripts`） | `tsconfig.json` |
| G2 | 当前 `.uina/**` 有 55 个文件被传递覆盖——**靠的全是 gitignored 测试**（`src/` 从不静态 import `.uina/`） | `tsc --listFiles` + `grep src/` 零静态引用 |
| G3 | 一旦这些测试缺失（全新 clone），`.uina/**` 类型检查覆盖率为 **0** | G1 + G2 |
| G4 | `tsconfig.build.json` 亦不含 `.uina`，`pnpm build` 永不触及 | `tsconfig.build.json` |
| G5 | **`embodiment/index.ts` 是本子系统唯一漏网文件**（测试只 import 了 4 个子模块，没 import 入口） | `tsc --listFiles` 对比 `find` |
| G6 | 该文件正是用了 `(pi as any).on("output_update", ...)` 的类型逃逸处 | `embodiment/index.ts:48,57` |

G5 + G6 不是巧合：**唯一没被类型检查的入口文件，恰好是唯一需要 `as any` 的地方。** 这个 cast 的成因是 handler 参数标注成了可变的 `OutputUpdateEvent`，而槽位提供的是 `DeepReadonly<OutputUpdateEvent>`。去掉 cast 并改用 `DeepReadonly<...>` 即可——但在当前的 `.gitignore` 结构下没人会发现。

---

## 6. 根因分析

### 根因一（P0 全部）：用 IPC 边界传递了活对象

`callService` 的契约是**纯数据双向**（`structuredClone` 入参 + 返回值），这是自设的、正确的不变量。`BodyEndpoint` 本质是**行为对象**（4 个方法 + 闭包）。把行为对象送进纯数据通道，是概念层的不匹配，不是实现疏忽。

证据链闭合：为修这个"不匹配"，代码里出现了 `(pi as any)`、`console.warn` 吞异常、以及 `Live2DCompanionContext` 里四个**声明了但无人填充**的字段——三种不同的"绕过去"手法，指向同一个未解决的结构问题。

### 根因二（S6）：App 契约只暴露极简 `onActivity`，无法承载事件流

`RuntimeEvent` 是主体对外唯一的观察面，Extension 可订阅；App 拿到的 `onActivity` 只抽象成 `{origin: "human"|"external"|"runtime"}`，丢失了 `type`、`channel`、`turnNumber`。Live2D 需要 `thinking` / `turn_end` / `turn_aborted` 来做反射，于是在自己的类型里扩展了 `onHostEvent`——但框架侧没有对应实现。**这是 App 契约的表达力不足，而非 app 越界。**

### 根因三（S5）：两条口型路径并存，文档只承认一条

设计与实现分岔：文档写"PCM 旁路广播 → 外壳自算 RMS"，实现做"PCM 镜像虚拟声卡 → VTS 自算口型"。两条路都合理，但**并列存在且互不知情**，导致消费侧代码写完即死。

### 根因四（品质）：绿灯测试与真实接缝正交

所有相关测试都在**边界内侧**打桩：mock 端点注册进真 router、mock `callService` 接受真端点。**没有一条测试跨越真实边界。** 100 例绿灯与四条断裂接缝并存，正是这个正交性的必然结果——不是测试写得差，是测试的**观测面**选错了。

---

## 7. 修复方案

### 批次 A｜P0 连通性（必须先定架构口径）

**A1 — 活对象的注册通道（架构决策，非 bug fix）**

三条候选，代价递增：

| 方案 | 做法 | 优点 | 代价 |
| :--- | :--- | :--- | :--- |
| **A1-i 框架加同进程函数出口** | `ServiceCompanionContext` 增 `expose?: (name, fn) => void`，App 用它注册 `affordance/state/emitCue/safeStop` 四个入口；embodiment 通过 `pi` 拿到**函数引用**（不经 IPC） | 保持 `callService` 纯数据不变量；对 embodiment 中立；改动最小 | 框架多一个通用能力，需过"第五关"（至少一个高级能力不再修改 Core） |
| **A1-ii App 侧反转：只传纯数据描述 + 命令通道** | App 只交付 `BodyAffordance` 等纯数据；行为留在 App 内，embodiment 通过一个"转发 invoke"桩调用 | 契约最干净 | 需再造一层命令协议（约等于自建 RPC），复杂度最高 |
| **A1-iii Live2D 升格为 Extension** | 从 `.uina/worlds/live2d/` 移到 `.uina/extensions/live2d/`，直接拿 `pi` | 彻底消除结构错配 | 失去 world-framework 的三档视口与门面工具，需自行实现 |

**我的判断：选 A1-i。** 理由：`ServiceCompanionContext` 已经有一个先例——`onActivity` 就是"框架给 App 的一个同进程回调出口"。加一个方向相反的 `expose` 是对称的、概念最小的。A1-iii 会让 Live2D 丢掉整个视口治理体系，代价远超问题本身。

无论选哪个，必须钉住的不变量：**`callService` 保持纯数据；活对象一律走显式的同进程注册通道。**

**A2 — 注册失败必须可观测**
禁用 `console.warn` 吞异常。注册失败应 `pi.reportError` 或让 `onStart` 抛出，使 world-framework 的 `enable()` 失败可见（`app-registry.ts:120-144` 目前不捕获 `onStart` 异常）。

**A3 — 补跨真实边界的集成测试**（这是本批次的价值所在）
必须使用真实 `ExtensionRunner` + 真实 embodiment extension + 真实 Live2D app，断言：
1. 注册后 `body({action:"list"})` 返回含 `live2d_mo` 的数组
2. 向 `output_update` 喂 `<cue id="warm_smile"/>` 后，endpoint 的 `emitCue` 被调用且 cue id 原样到达
3. `turn.prepare` 注入的 systemPrompt 含 17 条 cue id

**A4 — 修门禁盲区**
`tsconfig.json` 的 `include` 加入 `.uina`（或显式列出三块目录）；去掉 `embodiment/index.ts:48,57` 的 `as any`，参数改 `DeepReadonly<OutputUpdateEvent>`。

### 批次 B｜P1 取舍

**B1 — 口型路线**（需你裁定，我的建议与理由见对话正文）

| 选项 | 得到 | 失去/代价 |
| :--- | :--- | :--- |
| 删除自主旁路 | 消除两套口型打架风险 | 失去 Layer 3 声学微冲（VTS 只动嘴，不产头部层反应）；失去 Uina 侧口型主权（`isChannelLocked("mouth")` 失效，`shocked`/`laugh`/`sleepy_yawn` 的嘴型会被 VTS 音频口型覆盖）；口型钉死在 VTS + Windows 音频设备 |
| **接电平（建议）** | 以最小成本拿回 Layer 3 与口型主权 | 桥侧新增一次 O(N) RMS 计算 + 现有 SSE 每 ~30ms 一帧 `{rms,peak}`；无需新传输通道。消费端 `AudioObserver.processLevel` **已实现**，`VoiceLevelEvent` **已定义** |
| 接 PCM | 完全自治、身体可移植 | 需新建 Python→Node 二进制传输（当前只有文本 SSE）；60Hz 广播触及设计自设的"零分配"红线 |

关键事实：**桥侧目前连电平都没算**（F8），而两个契约与两个消费函数都已就位。所以真正的决策不是"要不要写代码"，而是"**生产 `AudioPcmChunk` 还是生产 `VoiceLevelEvent`**"。命名已经暗示了答案——前者贵，后者便宜。

**B2 — 反射事件桥**
在 world-framework 补 `onHostEvent?: (listener) => () => void`，转发 `RuntimeEvent` 的子集（至少 `output_update` / `turn_start` / `turn_end` / `turn_aborted`）。同时修正 `runtime.ts:179` 的死判断（`"thinking"` → `output_update` + `channel === "thinking"`）。

**B3 — cue 洁净度（一行修复，独立于口型决策）**
在 TTS `cleanSentence` 中增加 `<cue .../>` 剥离，保持"TTS 独立清洗、不经 embodiment 二手转交"的无代理原则（voice-architecture §1.2）。

不建议复用 `StreamingTagStripper.cleanText`：那会把 TTS 变成 embodiment 的下游，违背设计自设的无代理原则，且引入跨扩展耦合。

**B4 — 顺带对齐 DESIGN（选择保留的项）**
若保留 `AudioObserver`，其 `reset()` 需在 `playback:end` 之外也挂到 `turn_aborted`；若保留 Layer 1，必须补 `motion3.json` 加载器，否则删除。

### 批次 C｜P2 清扫与文档

- C1：按 §4 清单执行"删除 / 接线 / 明确失败"三选一（每项单独列给你确认）
- C2：修订三份规范——voice-architecture（拓扑、0-tool 承诺、ASR 状态、Level 2）、embodiment-architecture（`emitCue` 签名）、live2d DESIGN.md（Layer 1 状态、重心游移描述）
- C3：裁定 5 个关键测试是否入库。**当前状态下，"具身 + 语音"这个连接最脆弱的层，其测试只存在于本机。**

每批收尾门禁：`pnpm typecheck` + `check:boundaries` + `pnpm test --pool=vmThreads` + `node scripts/crap.mjs --gate`，并以 `git ls-remote` 校验推送。

---

## 8. 未决事项

| # | 事项 | 需要谁定 |
| :--- | :--- | :--- |
| D1 | A1 采用哪个方案（我建议 A1-i） | 你 |
| D2 | B1 口型路线（我建议接电平） | 你 + 需确认 VTS 是否已配置 `CABLE Output` 为音频口型输入 |
| D3 | 5 个关键测试是否从 `.gitignore` 移出入库 | 你 |
| D4 | `embodiment:get_router` 是否保留（我建议删除） | 你 |
| D5 | ASR/VAD 属"待实现需求"还是"应删除的规划残留"（我倾向：删除 `asr/` 目录设计，单独立项） | 你 |

---

## 附录：复现命令

```bash
# 门禁基线（须用 vmThreads 池）
npx vitest run --pool=vmThreads tests/embodiment-runtime.test.ts tests/live2d-app.test.ts \
  tests/live2d-motion-core.test.ts tests/voice-extension.test.ts tests/tts-extension.test.ts
# 期望：5 files / 100 tests 全绿

# typecheck 覆盖范围（对比 find 即可暴露 G5）
npx tsc --noEmit --listFiles | grep "\.uina/"

# 确认测试被 git 排除
git check-ignore -v tests/embodiment-runtime.test.ts tests/live2d-app.test.ts \
  tests/live2d-motion-core.test.ts tests/voice-extension.test.ts tests/tts-extension.test.ts

# 确认 playback:pcm 无生产者
grep -rn "playback:pcm" . --include=*.ts --include=*.py --exclude-dir=node_modules
```
