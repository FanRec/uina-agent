# Uina TTS Bridge 重构设计与实施规格

**基线：** `FanRec/uina-agent`，`main@f1c2aef21af90ee56ad396b112e7a61b2783fc5e`（2026-11-13；相比旧基线 `c28036d` 前进 2 个提交）。  
**范围：** `.uina/extensions/tts/bridge/` 为主，按必要边界修复现有 `tts_delivery:*`、TS Driver 与 Speech 交付状态；不重新实现 Expression/Speech。  
**性质：** 一次性主线重构与性能整治；本文既是目标设计，也是 Coding Agent 的施工合同。

## 1. 定位与完成标准

把当前“按句提交、层层排队、逐句排空”的 Bridge，收敛为**单路有序合成、连续 PCM 播放、来源级精确停止、真实播放事实输出**的语音交付引擎。优先改善首声延迟、句间连续性、长发声稳定性和可维护性；删除本身制造等待、竞争和错误状态的保护机制。

业务使用方式保持：上游提交可朗读片段，收到受理回执后即可继续生成文字；播放独立推进；真实进度及结果异步回传。**接收成功不代表合成成功，合成成功不代表播放结束，更不代表听众确实听见。**

完成标准：

1. 合法的连续句段可共享一次打开的声卡流；下一句 PCM 已就绪时，不经历逐句排空、固定 90ms 等待或重新预缓冲；没有就绪数据时如实计为欠载/等待。
2. 保持**已经落地**的 Speech 异步投递：`expression` 观察者同步入队即返回，`block_end` 将尾句与 `seal` 追加到同一 Utterance 链，后台严格先提交后封口；不得在 TTS 侧重建解析器或提交队列。
3. 同一来源连续的 Segment index 按序受理、朗读（乱序索引明确拒绝），独立来源按首次受理顺序 FIFO；普通新输入不暗中打断旧声音。停止旧来源绝不截断新来源。
4. 正常排队不会因为从受理时刻开始计时而失败；容量限制在受理边界生效，执行超时只约束真正开始的工作。
5. Python Bridge 内只有一个交付事实所有者、一个合成执行者和一个连续播放消费者；TS Speech 保留表达事实，TS Driver 保留请求身份/交付投影，各自不复制物理播放权威。
6. TTS 发生错误，文本交流仍可继续；字幕、Live2D 电平、OBS/镜像设备异常不使主声卡交付失败。
7. 保留生成 WAV、健康检查、按需测试/恢复、进程归属及已存在的交付协议能力；迁移结束删除无用调度与旧兼容逻辑，不保留两套生产路径。
8. Speech→TTS→Bridge 的状态映射正确：未知受理可目标性停止；拒绝/失败不谎报封口；尚未关闭的 Speech 不被第一句完成事件提前结算。
9. 有真实设备与真实 Vendor 的延迟、句间停顿、声音完整性和打断对照数据；不得将模拟 Bridge 测试写成真实听感通过。

**不在本次实现：** 更换/微调 TTS 模型、通用 Audio Bus/混音器、多音源混音、多端同步、SSML/表达语法扩展、重新设计 Voice/Speech/Embodiment 或 Agent Loop。它们属于各自项目。不要为了未来场景先做抽象框架。

## 2. 产品边界与已有设计的关系

| 所有者 | 责任 | 不做什么 |
|---|---|---|
| **Speech（已实现）** | 选择实际要说的文字、切句、Utterance 语义与按 Utterance 有序异步投递、`seal/stop` | 不控制声卡，不推断已播放帧数 |
| **TTS TS Adapter/Driver（已实现）** | `utteranceId → trace` 映射、端口状态转换、Session/Epoch 和受理/停止请求，对 Bridge 播放事实做只读投影 | 不解析 Expression、不重建 Speech 任务或物理播放真值 |
| **Bridge** | 接收命令、拥有 Source/Segment 交付事实、按序推理与播放、结果发布 | 不解析 `<speech>`/`<cue>`，不决定模型是否该说话 |
| **VendorAdapter** | 启停 GPT-SoVITS（仅有归属时）、流式/批量合成、Vendor 请求与取消 | 不维护播放队列或字幕 |
| **DeliveryLane** | 本进程唯一受理表、来源 FIFO、合成任务顺序与播放推进 | 不操作 PortAudio 回调，不重复管理 Vendor 进程 |
| **AudioSink** | PCM 输出缓冲、设备打开/关闭、实际播放所有权、样本时钟、电平、停止 | 不理解文本、字幕、模型回合 |
| **PlaybackFeed** | 将 AudioSink 的位置和 Lane 的终局状态投影成 SSE/按需快照 | 不通过定时器假装发生播放，不持有第二本播放账 |
| **字幕/口型/镜像** | 消费真实播放数据或尽力输出副本 | 不回压/阻塞主音频、不决定交付成功 |

已落地的上游设计以仓库 `docs/refactor/Uina-Expression-Speech-Refactor-Design.md` 及当前代码为准：`src/agent/expression.ts` 解码表达事件，`.uina/extensions/speech/session.ts` 维护 Utterance 与每来源 Promise 链，`.uina/extensions/speech/segmenter.ts` 切句，`.uina/extensions/tts/index.ts` 暴露 `tts_delivery:*` 并转发播放事实。旧 Voice 扩展、TTS 原文 `output_update` 朗读、`stream-parser.ts` 已删除。**这些是本次施工的既有资产，禁止复活或平行重建。** 本文重构其下游 Python Bridge，并对已经发现的跨端口状态不一致做必要的窄范围修复。

保留 Python 同进程中的 GPT-SoVITS 客户端与音频输出，不把 PCM 经 Node.js 转运到新的 Audio Server。未来真的出现独立音效/音乐混音需求时，再以 `AudioSink` 的小接口为起点扩展，而不是本次预建全局 AudioRuntime。

## 3. 最新代码问题、证据和处置

以下都来自当前提交的实现；源码位置为施工入口，不能按文件名机械照搬新结构。

| 证据位置 | 当前问题 | 必须处理 |
|---|---|---|
| [`audio_playback.py:336-419`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/audio_playback.py#L336-L419)、[`:486-504`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/audio_playback.py#L486-L504) | 每次回调发现排空都重新创建并取消 `threading.Timer`；同时在实时回调中进行不可预测的线程操作。 | 排空只产生一个状态转换/通知；闲置关流由普通设备控制线程执行，且只调度一次。 |
| [`audio_playback.py:562-572`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/audio_playback.py#L562-L572)、[`service.py:2014-2188`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/service.py#L2014-L2188) | 每句 `finish_stream`、排空、额外等待 DAC 尾部、下一句 `resume`，导致人为句间间隙。 | 改为同一来源/声卡流的连续 PCM 队列，按样本标记结算句段。 |
| [Speech `index.ts:56-88`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/speech/index.ts#L56-L88)、[`session.ts:514-564`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/speech/session.ts#L514-L564) | **已修复旧热路径**：Expression 观察同步入队，网络提交和尾句封口由 Speech 自己的链执行；TTS 已不再直接消费原文输出。 | 保持这条既有路径；只加跨端到端回归，不在 TTS 扩展建第二套投递队列，不改 Host `observedTail`。 |
| [Driver `driver-impl.ts:244-259`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/driver-impl.ts#L244-L259)、[Speech `delivery-port.ts:7-14`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/speech/delivery-port.ts#L7-L14) | Driver 网络受理未知返回 `uncertain`，Speech 端口只承认 `unknown`；[Speech 的交付链](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/speech/session.ts#L514-L544) 因此可能丢掉受理不明的来源，后续停止无法覆盖潜在正在播放的音频。 | 在 TTS 端口归一化为 `unknown`，保留确定的 `traceId`/taskId；Speech 对未知受理保留来源并可目标性停止，不将未知当明确拒绝。 |
| [Driver `driver-impl.ts:128-146`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/driver-impl.ts#L128-L146)、[TTS `index.ts:159-169`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/index.ts#L159-L169) | 失败提交把 Source 的 `closed` 置 true，而 `endSource` 直接提前返回；端口可能报告 `sealed`，Bridge 却未收到 `turn-end`。 | 区分禁止再提交与远端确已封口；已有受理段应真正 `turn-end` 或明确取消，只有确认动作结果才返回 `sealed`。 |
| [Speech `session.ts:189-210`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/speech/session.ts#L189-L210) | Segment `completed` 只比较当前 `segmentSeq`，不检查 Utterance 是否已结束输入；第一句先播完、模型仍在输出时，可能将整次发言提前 `settled`。 | 完成判定必须同时满足输入已封口、已受理的段均完成、无待定提交/封口；输出后续仍到来时不能提前结算。 |
| [`service.py:581-658`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/service.py#L581-L658)、[`:178-208`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/service.py#L178-L208) | Dispatcher、ThreadPool、Playback Worker、多处 `10/20/50ms` 轮询和不可执行任务重新入队；多线程竞争同一合成锁。 | 一个合成执行者 + 一个设备输出消费者；使用条件通知或队列阻塞唤醒，不轮询旋转。 |
| [`service.py:1047-1091`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/service.py#L1047-L1091) | 排队超过 60s 被当作失败，并连带 poison 来源。 | 排队无执行时限；只对正在进行的 Vendor 请求/设备停止设置合理超时；准入时显式限制待处理积压。 |
| [`streaming_engine.py:194-315`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/streaming_engine.py#L194-L315) | 已有有界 PCM Queue，同时又将全部 PCM 复制到无限增长的 `audio_buffer`；为无须全量音频的进度/镜像保留重复数据。 | 正常朗读只保留有界 PCM；用计数器记录时长；只有明确的 WAV 导出需求才收集完整音频。 |
| [`audio_playback.py:421-466`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/audio_playback.py#L421-L466) | 主设备 `feed` 同步执行镜像设备 `feed`；镜像缓冲背压可能阻塞主音频。 | 镜像独立有界队列、非阻塞投递；镜像溢出允许丢旧副本并记录一次诊断，不丢主流数据。 |
| [`vendor_runtime.py:175-208`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/vendor_runtime.py#L175-L208) | `iter_bytes(chunk_size=4096)` 会重新攒出固定大小块，可能推迟小 PCM 首包；chunk 间距统计也混入 HTTP 分块行为。 | 优先使用到达即交付的 `iter_bytes()`/`iter_raw()`；适配 PCM 对齐与背压，不以网络包边界当“模型片段”边界。 |
| [`service.py:729-753`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/service.py#L729-L753) | 同 `task_id` 的已失败/取消任务仍答复 `accepted`。 | 回重复受理请求时如实返回当前状态；任务 ID 与内容不一致明确冲突，不重复合成。 |
| [`runtime_components.py:15-55`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/runtime_components.py#L15-L55) | `TaskRegistry` 无视传入锁且暴露内部 dict，服务层多处绕过该包装直接修改任务。 | 单一 Lane 状态表和一把锁；删掉无意义包装，跨线程交付只用有界队列/通知。 |
| [`subtitle_sync.py:25-97`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/subtitle_sync.py#L25-L97) | 旧 `emit()` 实际是空操作，但遗留 `emit_*` 协议和推进接口。 | 删除空操作旧事件通道；进度与字幕直接消费唯一 PlaybackFeed。 |
| [`adaptive_engine.py`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/adaptive_engine.py)、[`synthesis_scheduler.py`](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge/synthesis_scheduler.py) | 保留多种适配状态和决策通道，而当前部署为 `fixed_streaming`；策略越多，首声优先级与后续预取越难解释。 | 默认只保留一条可测的流式路径；批量合成是明确的导出/故障前回退路径，不做按 Trace 自动摆动的策略引擎。 |

已验证的重要资产不得“为了清爽”删除：`PlaybackLease` 的目标所有权思想；`session/epoch` 的旧执行隔离；来源级 FIFO；幂等 `segment_id`；音频真实消费进度和电平；`tts_generate` 的无播放合成；所有权明确的 Vendor/Bridge 进程停止。

## 4. Bridge 内部模型：一个交付事实所有者，两个执行域

### 4.1 实体

```text
BridgeRuntime
  ├─ VendorAdapter       // 唯一 Vendor 进程与请求入口
  ├─ DeliveryLane          // 唯一 Source/Segment 事实表和 Source FIFO
  │    ├─ Source[]       // 按首次受理顺序，当前 head 可交付
  │    └─ Segment[]      // Source 内按 index 单调递增
  ├─ SynthesisWorker     // 单路 Vendor 推理；可与 AudioSink 播放重叠
  ├─ AudioSink           // 唯一主声卡流、PCM 缓冲、输出样本时钟
  └─ PlaybackFeed        // 事件/快照；无权发起播放
       ├─ SSE / subtitle-state
       └─ 可选镜像、字幕、口型消费者
```

`DeliveryLane` 是唯一可以更改任务业务状态的地方；`AudioSink` 是物理播放位置与设备停止结果的唯一权威。对外 `TaskStatus`、`SubtitleState` 和 SSE 都由这两处快照派生，不能分别维护可互相矛盾的真值。

**避免概念重复：** `DeliveryLane` 不是 TS 现有 `SpeechSession` 的替代，也不是第二条文本任务队列。Speech 的 Promise 链负责“这次表达先交第 1 句、再交第 2 句、最后封口”；Python Lane 负责“哪些片段已经被 Bridge 受理、哪路音频此刻拥有设备”。TS Driver 原有 `admissionTail` 若用于跨来源 HTTP 受理顺序可以保留，但不允许再复制一套 TTS 文本语义。

```text
Source {
  id, sessionId, epoch, generationId,
  input: open | sealed | cancelled,
  lastAcceptedIndex, sealedLastIndex?,
  segments: ordered Segment[],
  terminalReason?
}
Segment {
  id, index, normalizedText, originalText,
  synthesis: queued | running | finished | failed | cancelled,
  playback: pending | playing | completed | cancelled | failed | unknown,
  pcmStartFrame?, pcmEndFrame?, // 累计有效语音样本位置，不含补静音
  error?, timings?
}
```

**合成和播放不是单线性状态机。** 合成第二块时第一块可能已经播放；流式 Segment 可以 `synthesis=running` 且 `playback=playing`。`seal` 是“后续不再提交”而非“已播放完毕”。避免用 `state=completed` 同时表示合成完成与播放完成。

状态操作只依次遵循：成功受理 → 进入合成 → 持续追加 PCM → 合成结束；播放进度可在任一合成阶段开始。Segment `playback=completed` 只能由真实已播放样本越过结束位置后置位。Source 仅当 **已封口且所有已受理 Segment 已终结且音频尾部已排空/确认停止** 才释放 FIFO head。空来源直接结束，不占队列。

### 4.2 来源 FIFO 与合成调度

- Source 由**首次成功受理**加入全局 FIFO；Source 内 `index` 必须从 1 起连续。相同 `segment_id` 的重试不增加序号。
- 当前 Source head 的 Segment 按 index 推进；只有当前 head 的 PCM 可以进入主 AudioSink。其他来源允许受理并排队，正常情况下不抢占 head。
- Vendor 只能执行一个推理请求。`SynthesisWorker` 消费已受理的下一片段并逐块写入有界音频缓冲；写入与播放并行。下一句的合成不等待上一句物理播放结束，但要遵守缓冲上限。
- **不需要第二层 SlidingWindow、多个合成 worker 或首包优先锁。** 单 Vendor 串行已天然保证第 1 句优先；若头句尚未产生首包，不准先开始下一句的 Vendor 推理。
- 有序队列存在可执行工作或取消/封口时被通知；不可执行工作保留在原位置，不反复出队入队或空转睡眠。
- **Backpressure：**缓冲 PCM 只允许有限未播放时长（建议初始 2s，可测后调整），超过容量时合成生产者阻塞等待 AudioSink 消费；即使 Vendor 一次产生大于容量的 chunk，也应拆为可容纳的帧块分次写入，不能一次突破有界容量；等待不是合成失败，取消可立刻解除等待。待提交文本也须有可控容量（按来源总字符数/片段数，采用简单固定上限即可），在**受理前**明确拒绝超限，而不是受理后按年龄清除。正常短回复不能触发该上限。
- `tts_generate`（只生成 WAV，不播放）和预热同样通过唯一 Vendor 入口串行；实时讲话优先于**尚未开始**的导出/预热工作。不强行中断已在执行的 Vendor 调用，也不为此建设多级通用优先级框架。

**已受理任务不得靠排队时间失败。** 分开记录 `acceptedAt`、`synthesisStartedAt`、`firstPcmAt`、`playedAt`、`terminalAt`。超时从真正开始的 I/O 或等待可判定失效的设备操作计时；Vendor 网络空闲/总时限各有职责。**生产者因正常有界背压等待 AudioSink 消费时不消耗“Vendor 无进展”预算**；否则长句只因人声正常播放较慢而被错误定为超时。队列容量和未知停止状态是唯二应在准入边界阻止工作的条件。

### 4.3 连续音频：一条 PCM 时间线

本次最大行为变化：**句段是时间线上的区间，而不是一场独立的声卡播放事务。**

1. Source head 获得当前物理输出所有权，按需要打开主 `RawOutputStream`；同设备同采样率的后续句子持续复用。
2. `SynthesisWorker` 将 PCM 数据按产出顺序追加到同一个有界队列；为每个 Segment 记录累计有效 PCM 的 `[startFrame, endFrame)`（`endFrame` 在该片段生成结束时才确定）。
3. AudioSink 回调从队列取帧；上一句后紧接下一句的 PCM 如果已在队列中，回调直接跨越区间，不产生逐句 `finish/drain/sleep/prebuffer`。
4. PCM 不足时补静音并累加欠载时长/次数。补静音不推进“有效语音样本位置”，因此不会虚报字幕、Cue 和 Segment 完成。缓冲恢复后继续；不得擅自丢弃未播 PCM 来追上墙钟。
5. 播放中的区间到达 `endFrame` 的实际 DAC 估计时刻才产生 Segment `completed`。下一个区间如已开始可在同一次回调内跨过边界，先完成旧段、再开始新段，保证因果顺序。
6. Source `seal` 后仍可继续缓冲与播放。仅所有 Segment 完成/停止后，Source 才交棒给下一来源。设备无任务时由**普通控制线程**按一次空闲超时关闭；不要在实时回调里启停流或安排 `threading.Timer`。

继续采用设备实际支持的 PCM 格式；流式 `raw` 所用采样率必须与 Vendor 实际输出一致。批量 WAV 的采样率以文件头为准，若与当前 AudioSink 不同，应在非实时线程完成一次有质量保证的转换，或在来源边界重开设备。**不得把不同采样率的原始字节直接混在一个流中。**

### 4.4 实时回调与音频时钟

- 回调只做：从已准备的 PCM 数据结构复制帧、必要时填静音、更新简单帧计数/时间戳、通知轻量状态。不得在回调中创建线程、定时器、记录文件、HTTP、Python 大对象计算或阻塞等待。
- 保留当前 `try_acquire(False)` 的非阻塞策略作为初始实现；锁争用导致的静音计为可诊断欠载。若实测仍有明显爆音，再考虑 C 层 ring buffer/无锁方案；**现在不预设新 native 依赖**。
- 以 PortAudio `outputBufferDacTime` 估计实际输出时间；该值仍是驱动时序估计，不是外部麦克风实测。维护 `dac_estimated` / `submitted_samples` 的质量标记；回调已提交、但 DAC 尚未输出的尾部不得提前标记 completed。无可用 DAC 时按提交帧、设备延迟及最终排空事实保守估计，不声称“精确听见”。
- 仅真实 PCM 样本推进音量窗的语音帧位置。RMS/peak 可由生产者按 20ms 或其他固定小窗计算，回调只维护最小映射；下游按快照自行平滑。不要在回调内重新遍历音频或聚合字幕字符。
- Windows 设备首声目前固定注入 120ms 静音、首句预缓冲 300ms、常规预缓冲 340ms；这些是**待测参数**，不能作为不可删除的正确性公理。只有真正打开设备时才可能需要预热，不应每句话插入。以首音节完整性/欠载/实际首声延迟的实测决定值。
- 物理设备关闭仅在全队列排空、无活动输出且无后续工作时发生。关流前用 DAC 输出尾部的可确认时序结算最后样本；不要每段固定睡 90ms。

### 4.5 镜像与旁路消费者

主声卡为唯一正常交付成功依据。VB-CABLE 等镜像输出是 best-effort：

- PCM 在非实时线程复制至独立、**有界**的镜像输入队列；主音频生产者绝不等待镜像队列腾空间。
- 镜像慢/设备不可用：丢弃镜像旧包或关闭镜像并记录有限诊断，不丢主流 PCM；主设备时间线不会因镜像失配而改变。
- 采样率转换必须正确维护跨块连续性。现用 `audioop` 不能假设所有 Python 版本存在（Python 3.13 已移除）；选择当前环境已有的可靠流式重采样实现，否则显式禁用镜像而非把 32kHz PCM 冒充 48kHz 输出。
- `lipsync_bridge.enabled=false` 当前部署无需保留流式全量 PCM 缓存。保留独立接收消费者的必要接口即可；不启用时不分配工作队列和缓存。

## 5. 对外协议和正确性契约

### 5.0 已实现的 Speech ↔ TTS 交付端口（必要接口修复）

不得另建 Bridge Protocol、语义总线或第二个 Speech Adapter。现有调用链为：

```text
ExpressionEvent
  -> SpeechSession.emitSegment / finalizeUtterance（每 Utterance 链）
  -> SpeechDeliveryPort.submitSegment / sealSource / stopSource
  -> tts_delivery:* 服务（utteranceId ↔ traceId）
  -> TtsVoiceOutputDriver（admissionTail、session/epoch、HTTP）
  -> Python Bridge（任务受理、Vendor、AudioSink）
  -> SSE / snapshot -> Driver 状态投影 -> speech_delivery:on_playback
```

跨端口必须统一以下事实合同，不允许靠 TypeScript 强制转换掩盖运行时值：

| 情形 | SpeechDeliveryPort 接收的规范结果 | 必须采取的行为 |
|---|---|---|
| Bridge 已原子受理 | `accepted` + `traceId`/`taskId` | 记录来源与段身份，不将其说成已播完。 |
| 已确认没有受理 | `rejected` 或 `not_started`（无任务生效） | 不自动重试；如之前同来源有已受理句段，需真正封口或取消。 |
| 网络响应丢失/真实状态未确认 | `unknown` + 已创建的 `traceId`/`taskId`（若存在） | Driver 当前 `uncertain` **在适配边界**统一映射为 `unknown`；保留 Source 供目标停止与查询，不按拒绝丢弃，也不盲目补播。 |
| 已知来源被取消 | `cancelled`，带取消归属 | 不继续提交；未确认的物理停止另外报告。 |
| 来源已封口 | `sealed` | 必须有远端 `turn-end` 成功确认，不能因为本地 `closed=true` 便宣称 `sealed`。 |
| 封口未知 | `unknown` | 可通过同身份幂等查询/重发 `turn-end` 核对，或进入现有 recovery；不得直接放行可能仍占队首的来源。 |

`Source` 本地的“禁止新提交”与“远端已封口”必须分开记账：前者可以在失败后立即设置，后者只能由 Bridge 回执或有效对账确认。对于至少一个成功受理、后续句段明确拒绝的来源，**不得静默跳过终止动作**；如果已确认整来源失败并释放 FIFO，无须再补做无意义的封口，但要以 Bridge 的终局证据作结论。

Speech 收到 `unknown` 时，即使没有确认某段被受理，也须记录已经创建的 Source 身份；`stop/replace/set_muted` 对它发出目标性停止，或返回真实 `unknown`。避免当前 `record.traceId === undefined` 时直接 `no_op` 的漏停。`tts_delivery` 的可用能力与网络调用不需要加新全局监视器。

**Utterance 完成条件：**只有 `inputClosed=true`、本来源的提交链已完成（含最后一个 Segment 的结果）、封口已确认，且所有**确已受理**片段收到播放终局 `completed`，才能设为 `completed`。最后一段完成可能先于 `block_end`；此时只更新片段事实，等输入封口后再结算。若有拒绝、失败、取消或未知，按事实落对应非成功结果。不要因为最后一个*当前已知*句段播完就结算未来仍会增长的 Utterance。修复仅限 `SpeechSession` 的交付结算条件，不重写其语法、工具或偏好。

**资源回收：** TTS 的 `utteranceSources` 当前仅追加映射；在来源终局且不再用于停止/对账后回收双向关联，保留短期内必要的幂等查询信息。不为此引入后台清理服务或数据库。

本次不重新设计 HTTP API。保持现有 TS Bridge Client 实际调用的 `/health`、`/v1/tts/speak`、`/turn-end`、`/cancel-trace`、`/reconnect`、`/reset`、`/events`、`/subtitle-state`、`/generate`、`/test`、`/restart`。按需保留 `/tasks/{id}`、`/tasks/batch-status` 用于对账；未被生产路径使用的旧端点与内部包装在清理后删除。现有协议版本如有语义改变，明确更新 `voice_protocol_version` 与 TS Client 检查，不能让旧 Client 假兼容。正常施工应尽量保持现有 JSON 字段以缩小改动范围。

### 5.1 受理、封口与恢复

`POST speak` 只在输入合法、当前 epoch 有效、队列容量可接受、任务原子登记成功后返回 HTTP 202 `accepted`；**不等待 Vendor、首包或播放**。

- `segment_id` 是稳定幂等键：相同 ID + 相同来源/index/原文重放只能返回原任务的**当前真实受理/终局状态**；冲突 ID + 不同内容返回明确 409；绝不再合成一遍。同步调整 TS Client/Driver：重复响应为 `playing/completed/failed/cancelled` 时按事实合并，而不是凡非 `accepted` 一律视为新拒绝。
- 受理事实和加入 Source FIFO 在同一锁的事务内完成；取消不能在登记与发布之间生成活着的“幽灵任务”。
- `turn-end/seal` 幂等关闭来源输入，标明最后合法受理的 index；后到的新 Segment 拒绝。`seal` 返回 `accepted` 只表示停止接收新句，不表示已经说完；缺失尾句回执时不得用未曾受理的索引制造永久等待。
- `reconnect` 查询当前会话 epoch；网络回执丢失时先按任务 ID 与 Source 快照核对，而不是盲目重播旧台词。`seal` 自身必须可用同样参数幂等重发：网络回执丢失后查询来源是否已封口，若未封口可重发**封口命令**（不重发语音），避免永久占住来源 FIFO；确实无法联系旧进程时再走既有 reset/recover。
- 保留 `sessionId + epoch` 作为运行代次：旧进程/旧会话的回执不覆盖新代次；调用已知旧 epoch 的请求明确 stale。进程重启后不假定旧声卡进程必然已停止。
- Source 收尾/Task 记录回收由一个 owner 完成。当前 `TTL/最多保留任务数` 可归并为**一个有界终局记录保留策略**，不再同时维护多处孤儿记录清扫器。已取消或已失败任务保留到足以让客户端核对，不让已过期 ID 在短期内被悄悄复用。

### 5.2 停止与来源隔离

| 请求/情形 | 行为 |
|---|---|
| `cancel-trace(A, immediate)`；A 在队首、当前正播 | 原子标记 A 取消；阻止后续 A PCM 进入缓冲；由 AudioSink 只停/丢弃 **A 的未播放样本**；确认旧物理所有权结束后释放队首。 |
| `cancel-trace(A)`；A 尚未播放 | 从待交付队列废弃 A；不操作声卡，不影响当前 B。 |
| A 刚播完且 B 已接管，再收到旧的 cancel(A) | 目标所有权不匹配，返回 no-op/已取消事实；**绝不能**执行全局 `cancel_all()`。 |
| `segment_boundary` | 停止新合成和后续片段，允许当前已开始的片段完整到达尾样本，再取消剩余；不依赖静态 30s sleep 轮询。 |
| 设备停止失败/无法确定物理状态 | 对受影响物理输出返回 `unknown`，保留设备所有权/停止门禁，不开始下一路可能叠音的播放；允许显式设备恢复/重启来解除。 |
| HTTP 受理回执丢失，但设备停止状态确定 | 只把**该任务的受理**标为不明，允许通过 ID 查询对账；不因为一个丢包永久封锁所有独立 Source。 |
| 新模型回合或普通用户新输入 | 不自动取消旧声。是否抢话属于上游 Speech/交互策略，不在 Bridge 猜测。 |

停止顺序必须保证同一物理输出的 **检查所有权 → 设备停止/裁剪 → 释放所有权** 不会与下一来源接管交错。既有 `PlaybackLease` 是成熟的正确方向，可保留其关键思想并把操作收敛进 AudioSink/Lane 协同，不保留第二套 `_playback_lock`、`_stop_lock`、`_active_lease` 竞争路径。

### 5.3 失败、超时与重试

- Vendor 在首个 PCM **交给 AudioSink 之前**失败，允许做一次明确、可记录的非流式回退（若配置开启）；一旦任何可播放 PCM 已进入实际输出路径，禁止用批量重新合成并从头发声，以免重复半句话。
- Vendor 中途异常：当前 Segment failed，当前来源剩余尚未播放内容 cancelled；不取消其他来源；物理已播部分保留事实，不说成“完全没说”。
- 音频欠载不是立即失败，只记录等待；Vendor 总时限/闲置超时到达后才判故障并收束。区分“队列里合法等待”与“活跃任务无进展”。
- 对网络/设备无法证明结果的操作返回 `unknown`，不自动重放、不暗中宣布停止成功。只有物理停止未知才阻止后续会叠音的播放，不把所有 `unknown` 统一变成全局 barrier。
- 恢复、维护、测试不能更改用户 `muted` 偏好。进程归属明确，Bridge 只管理自己拉起的 Vendor；外部已存在 Vendor 不能由 Bridge 擅自重启或杀死。

### 5.4 播放事实、字幕、口型和事件

保留一个 **PlaybackSnapshot** 和少量不可重复的转换事件：`accepted`、`synthesis_started`、`playback_started`、`completed`、`cancelled`、`failed`、`unknown_stop`。流动位置、电平、缓存时长是刷新覆盖的**快照**，不是每 33ms 都追加一次“播放开始”。

```text
PlaybackSnapshot {
  sourceId, epoch, generationId, segmentId?,
  physicalOwner?, playbackId?,
  state: idle | buffering | playing | stopping,
  playedFrames, positionMs, durationMs?,
  rms, peak, clockQuality,
  underruns, bufferedMs, revision
}
```

- `playback_started` 只在该片段的首个有效样本被提交到输出、达到可定义的实际播放位置时发布一次；`completed` 只在最后一个样本越过播放时钟后发布一次。生成完成和封口不是这两个事件。
- 对字幕可按已播放样本/该段实际总样本估计 grapheme 揭示位置，**只称估计**。流式 Segment 尚未结束、总 PCM 时长未知时，保留一个简单的历史每字时长 EMA 作为临时分母（这是时长估算，不是继续保留自适应合成策略）；实际 `endFrame` 确定后改用真实总帧数，避免估算到点就把整句显示成已完成。文字与合成文本清洗不一致时必须有字符映射；不能把原文 UTF-16 偏移冒充“已念出的字”。逐字进度仍可能有韵律误差，终局不能早于末样本。
- 对 Cue 仅交付播放进度和句段边界；真正 Cue 执行由上游已设计的单一 Expression/Speech Timeline 所有者完成。**不得在 Bridge、TTS 和 Embodiment 各触发一次动作。**
- SSE 断连可能漏掉瞬时事件，权威状态始终可按需读取；事件流高频位置可以最新值覆盖，终局转换不与进度争夺同一个易丢队列。断线重连从快照收敛，不需要复杂持久事件日志。
- OBS 字幕服务、Live2D `VoiceLevelSink` 是消费者。它们的处理与网络 I/O 不回调并阻塞主声卡或 Vendor 生产线程。声学电平继续使用真实播放 PCM，不使用模型 token 速度模拟口型。

## 6. 关键性能与质量决策

### 6.1 首声路径

区分四个时间：`speech_text_ready → accepted → vendor_first_pcm → first_dac_audio`。每阶段单独统计，不用“HTTP 请求耗时”代替“人实际听到首字的等待”。

优先处理：

1. 去除 Host 观察者中的 HTTP `await`；仅有序异步投递。
2. `VendorRuntime.synthesize_stream` 去掉强制 `iter_bytes(chunk_size=4096)` 聚合，消费实时抵达的数据。奇数字节 PCM 要跨包暂存至完整 frame，不能凭 HTTP chunk 边界裁切音频样本。
3. Vendor/模型启动后后台准备，但**不允许预热与已排队真实讲话争同一锁并无限优先**。冷启动慢只能如实记录；预热不能反向阻止首个真实请求。可以沿用已存在的后台 warmup，而不是增加完整健康探测框架。
4. 取消与真实环境不符的固定首句静音/过大预缓冲，只在真实设备 A/B 测试证明必要时保留。首字完整性优先于极限低缓冲。

### 6.2 GPT-SoVITS 的策略选择

目前部署的 v2Pro `api_v2` 使用 `fixed_streaming`，常规 `streaming_mode=2`，首句/短句优先 `mode=3`（`first_chunk_min_chunk_length=16`，`fragment_interval=0.03`；常规为 32/0.05）。上游 GPT-SoVITS API 定义模式 2 为质量/速度折中，模式 3 更快但质量较低；**不要未经试听就让所有短句走模式 3**。

本次产品默认先**固定一套流式模式**（建议以模式 2 作质量基线），在相同声音模型、参考音频、句子样本上比较模式 2/3、最小 chunk、fragment_interval；只有确有可听收益和延迟收益时才选择首句单独的快速 profile。删除按 trace 自动在 batch/streaming 间来回摆动的复杂 AdaptiveStrategyEngine；保留可复用的**离线诊断命令**用于 A/B，而不是运行时实时调参。

### 6.3 文本、参考音频与自然度

- Bridge 不重新解释表达标签，也不吞“模型可能不想读”的括注。上游 Speech 负责何处需要说话和语言单元切分；Bridge 只做 Vendor 确需的字符规范化，并保留原文以便字幕/回执对照。
- 当前 `.uina/extensions/speech/segmenter.ts` 默认 `maxSentenceChars=20`，在长无标点文本上可能触发硬切，且保留全角括注清除策略。这些是**真实新上游**决定的语音质量输入。对照实验应同时记录实际送往 Bridge 的完整 Segment 文本、边界与标准化结果；如果出现短句割裂/情绪不自然，只在 Speech 分句器和明确的表达规则处修复，不在 Bridge 重切词、更改文本意图或用额外排队掩盖。
- 第一段优先尽快在自然断点交付，后续避免过碎短句；不能把 `maxSentenceChars=20` 当成音质默认最优。保持可配置的简短最大长度兜底，但以句末/停顿标点为优先，分别测首声和自然度。**本次不在 Bridge 中实现独立文本分句器**。
- 检查 `preset.ref_audio_path` 与 `prompt_text` 是否确实对应、语言标注是否正确；以同一句中/英混合、感叹、低音量、快速表达的听感比较参考样本。优先改善输入/参考数据，不靠更多后处理掩盖发音问题。
- 不新增未经验证的音频降噪、变调、静音修剪或跨句交叉淡入淡出：它们都可能破坏字尾、呼吸和原本的韵律。

### 6.4 必须留存的诊断量

`acceptedAt`、`synthStartAt`、`firstPcmAt`、`firstDacAt`、`synthEndAt`、`lastDacAt`；queue wait、TTFA (text-ready→DAC first voice)、句间空隙、缓冲欠载、输出真实数据量、推理耗时、有效播放耗时、停止到静音时间、设备关闭成功与否。按源/段汇总即可，开发调试时可看详细数据，**不把常规遥测塞进 LLM 上下文**。统计应清楚区分驱动时钟估计与声卡 loopback 实测。

## 7. 迁移/删除策略

**单轨切换**：允许在开发中用临时 mock 对照行为，最终代码只有一个正式调度与播放路径，不能通过配置回到旧双队列引擎。现有 TS/Python API 合同在迁移中保持可执行，不预先删除仍被调用的端点。

| 顺序 | 改造和完成条件 | 删除/收敛 |
|---|---|---|
| 1. 锁定语义和基线 | 对当前协议、测试和真实设备采集一次基线：首声、连读、打断、镜像、无设备情况；加“定时器不反复创建”“现有 Speech 投递语义不回归”“状态接线无虚假成功”等失败用例。 | 不新增设计框架。 |
| 2. 收口现有 Speech/TTS 接口 | 使用现有 `SpeechSession` 的同步表达受理与每 Utterance 异步提交链；修复 `uncertain→unknown`、未知 Source 目标停止、本地 `closed` 与远端 `sealed` 混淆，以及提前完成的 Utterance；`block_end` 尾句先于封口。 | **不再**修改 TTS `output_update/output_end`（旧朗读处理器已删除），不新增 TTS 提交队列，不更改全局 Host 事件分发。 |
| 3. 改造 AudioSink | 连续 PCM、按样本范围分句、单次空闲关闭、真正的 DAC 尾部处理；主镜像隔离；无锁等待回调路径。 | 删除逐句 `finish → drain → 90ms sleep → resume`、每 callback 定时器、新句重置首声缓冲等旧逻辑。 |
| 4. 改造 DeliveryLane | 合并 TaskRegistry/GenerationSession/Source FIFO/待播记录为单一状态表；一个 Vendor 工作者、单一设备输出消费者；原子受理、封口、取消、失败及容量控制。 | 删除 `_delivery_queue` 旋转、重复 ThreadPool worker、`SlidingWindowState`、`SynthesisScheduler`、首 chunk gate、排队年龄毒化。 |
| 5. 收敛播放事实 | 从 AudioSink 与 Lane 派生 `/events`、`/playback/events`、`/subtitle-state`；按实际输出刷新电平与字幕；统一任务回执与重连对账。 | 删除空操作 `SubtitleSyncEmitter.emit_*` 旧链路、重复任务/字幕真值、每帧假 `playback_started`。 |
| 6. 收敛 Vendor 与模式 | 单进程启动/停止入口；调整 HTTP chunk 读取；真实请求优先于尚未开始的预热；统一 `tts_generate` 与流式推理的 Vendor 串行所有权。 | 删除无调用分支、无效 `adaptive` 运行时切换、仅为旧分支存在的配置与状态。 |
| 7. 终验与清理 | 通过协议、真实声卡、SSE、音质/延迟对照；搜索旧名引用、配置、文档与测试；更新 README/操作指令。 | 不保留兼容外壳、已删除机制的代理类、独立的老测试断言和无用配置字段。 |

### 必须明确回收或替代的文件/符号

- `service.py`（目前约 3000 行）拆为最少几个真有独立职责的模块；不是将方法机械搬到更多 `*_handlers.py`。新主服务应以装配/HTTP 用例转发为主，而非持有所有锁、线程与状态。
- `runtime_components.TaskRegistry`、`sliding_window.SlidingWindowState`、`synthesis_scheduler.SynthesisScheduler`、`adaptive_engine.AdaptiveStrategyEngine`：按上述目标取消生产职责；如果某个文件只剩空转发则删除文件。
- `StreamingSynthesisEngine` 可保留 Vendor 数据流读取与 PCM 计数，不再握住 `service=self` 反向读取所有 Runtime 状态；改用小而明确的输入/取消端口。
- `playback_coordinator.PlaybackCoordinator` 中有效的 FIFO 和 lease 语义转入 DeliveryLane 与 AudioSink；不保留两套播放顺序账。
- `subtitle_sync.py` 只保留实用的进度/字符映射计算（可合并进 feed），删除已是空操作的旧发送路径。
- `lipsync_bridge_client.py`、音频镜像功能：若仍对真实生产消费者有价值，就做隔离适配；不要假装其已启用并把残留缓存留在热路径。
- 配置统一使用可部署的资源相对路径/覆盖值；当前绝对 `E:/Uina/...` 只属于机器本地环境，不应作为跨机器默认正确路径。删除不再生效的策略参数，保证实际 `/health` 生效配置与文件一致。
- TS `client.ts`/`driver-impl.ts`、`tts/index.ts`：保留既有 Session/Epoch、Driver 受理顺序与 `tts_delivery:*` 服务；统一规范结果并修正关闭/封口合同；不复制 Python 的合成和播放状态，不另造复杂 barrier。
- 现有 `.uina/extensions/speech/session.ts` 只修复“未知来源停止”和“整次表达完成”的跨边界判定；`.uina/extensions/speech/segmenter.ts` 的切句参数属于**上游音质实验变量**，如确需调参，在 Speech 一处修改，绝不让 Python Bridge 又切一遍语义句。

## 8. 验收：以真实行为而不是保护数量通过

### 8.1 自动化硬性用例

1. **来源与顺序**：同来源按 1/2/3 连续索引受理；越序 index 明确拒绝，不让队列形成永远缺失的空洞；不同来源按首次受理顺序 FIFO；A `seal` 后新段拒绝；空 Source 不阻塞后续。
2. **连续输出**：合成模拟器预先给出两句 PCM，主设备实际写出字节序列与串接结果完全一致；中间无额外固定静音、无重复预缓冲、无逐句关流；句段结束事件各触发一次。
3. **欠载**：生产者短暂停顿，输出补静音且 PCM 不丢，播放样本位置不推进；恢复后所有真实样本恰好播放一次；欠载只记指标。
4. **取消所有权**：取消 A 且 B 已接管时，B 连续播放不被切断；取消当前 A 后旧生产者迟到的数据不能写入 B/新代次；停止失败则不允许 B 叠音。
5. **长来源**：封口前按顺序投入较多句段、持续慢合成，合法排队不会被“60s 已受理过期”毒化；容量上限仅在受理前判定，已受理任务结果可对账。
6. **幂等和未知**：相同 ID 相同内容重复受理不重复生成；旧失败/取消返回真实终局；同 ID 不同正文 409；丢响应后客户端按 ID 查询，不自动重播；重启后的 stale epoch 被拒绝。
7. **新 Speech 接线不回归**：将 Bridge HTTP 延迟/断连，连续 `expression` 与 `output_end` 不被网络阻塞，Speech 仍按段先提交再 `seal`；`turn_aborted` 不投递迟到内容；TTS 侧不存在原文朗读监听器。
8. **设备生命周期**：声卡空闲时不会反复创建 Timer；重开后第一句只初始化一次；关闭失败上报；镜像输出挂起/报错不阻塞主播放。
9. **事件与投影**：每句 `playback_started/completed` 各最多一次；独立状态拉取与 SSE 在断连重订后收敛；字幕/电平只跟随有效语音样本进度，不受 HTTP chunk 边界影响。
10. **跨端口状态与早完成**：Driver 网络未知返回规范 `unknown` 且 Speech 保留 `traceId` 可停止；确定拒绝且前段已受理时仍有终局/远端封口；本地 `closed` 不冒充远端 `sealed`；第一段播放完成但 Speech Block 尚在生成时，Utterance 不提前 `settled`。
11. **无物理声卡**：只生成 WAV 的工具仍可工作；音频不可用明确报告而不宣称已播放；纯文本 Agent 主流程不受影响。

沿用现有 `test_service_cancel.py`、`test_audio_playback.py`、`test_review_races.py`、`test_runtime_hardening.py` 及 TS 侧 `tts-*`、`speech-session.test.ts`、`expression-subject.test.ts` 测试中真实有效的边界；旧断言若是在验证已删除的调度流程，应替换为最终用户可观察行为，不为旧实现留特例。

### 8.2 真实设备 A/B

保持同一机器、声卡、GPT-SoVITS 权重、音量和参考音频，固定若干短句/长句/中英混合/高情绪表达，运行旧基线与新版本。至少记录：首个真实 DAC 音频 P50/P95、句间静音 P50/P95、欠载率、丢尾音/爆音、打断到静音、整段完成率。参数探索（mode2/mode3、预缓冲、首声静音、切句）每次只改变一个主要变量，报告主观听感和延迟，不得把最短毫秒自动当最优解。

**发布门：**关键正确性无回归；连读没有代码主动插入的逐句 90ms 等待；音频连贯性与首声延迟在相同测试条件下得到改善或清楚解释取舍；不能确认的实际硬件表现明确保留为待设备验收。若出现模型推理限制导致的语音间隙，应归因到 Vendor 产出速度，而不是为掩盖它添加新的异步控制层。

## 9. 实施边界与交付定义

- 允许直接重建 `.uina/extensions/tts/bridge/`，无需兼容它内部的旧 Python 类/字段；外部 TS 使用的协议与实际功能必须可用。可依据目标重构测试，但不得通过删除失败测试宣布通过。
- 第一优先级为**正确交付事实、连续播放、来源级取消**；第二是删除重复调度、重复状态和错误超时；第三是测量后调整推理模式、文本切分和设备参数。
- 不引入分布式消息系统、数据库、音频微服务、插件式通用驱动层、泛化恢复调度器、逐任务 watchdog 或新一轮全局 Hook/Context 重构。单机内存队列、标准库同步原语及现有 httpx/sounddevice 已足够。
- 仅对确有失败路径的信任边界保留检查：受理身份、幂等 ID、物理停止归属、Vendor 进程所有权、PCM 格式正确性、退出时资源释放。其它重复兜底和互相补偿优先删掉。
- 交付结果包括：实际代码、相关测试、精简配置与 README、真实设备 A/B 指令及运行结果（能实际运行时）；**不用额外写架构汇报、证明文档或版本迁移故事**。如环境无法运行真实硬件验证，明确说明未验证，不伪造性能数字。
- 新的目标架构是职责与事实所有权的**合同**，具体文件数、类名、普通函数边界由 Coding Agent 按当前语言及依赖习惯自主实现，不能为了逐字匹配示意结构再制造一层转发抽象。

## 参考依据

- [当前 Uina Bridge 代码（固定提交）](https://github.com/FanRec/uina-agent/tree/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts/bridge)
- [当前 Speech 交付端口（固定提交）](https://github.com/FanRec/uina-agent/tree/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/speech)
- [Expression/Speech 已落地设计](https://github.com/FanRec/uina-agent/blob/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/docs/refactor/Uina-Expression-Speech-Refactor-Design.md)
- [当前 Uina TTS 扩展（固定提交）](https://github.com/FanRec/uina-agent/tree/f1c2aef21af90ee56ad396b112e7a61b2783fc5e/.uina/extensions/tts)
- [GPT-SoVITS 官方 `api_v2.py`（流式模式、chunk 参数）](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py)
- [PortAudio API — 回调实时约束与时间戳](https://portaudio.com/docs/v19-doxydocs/portaudio_8h.html)
- [PortAudio — Buffering, Latency and Timing Guidelines](https://github.com/PortAudio/portaudio/wiki/BufferingLatencyAndTimingImplementationGuidelines)
- [HTTPX — Streaming Response](https://www.python-httpx.org/quickstart/#streaming-responses)
