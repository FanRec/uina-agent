# Uina 语音系统架构规范 (Voice Architecture Specification)

状态：**部分实现的架构提案（v1.3 状态表为 2026-09-21 快照）**。当前 Voice 门面工具为 `speak`、`interrupt`、`status`、`manage`；ASR/VAD/麦克风输入仍未实现。源码和模拟测试不证明用户实际听到声音；真实 Vendor、声卡和设备边界见 [Voice/TTS 运行合同](../../voice-tts/voice-tts-runtime.md)与[验证记录](../../voice-tts/voice-tts-verification.md)。  
归属：`docs/proposals/voice/voice-architecture.md`  
定位：定义 Uina 数字主体（Digital Subject）的**独立语音中枢（Voice Extension）**。涵盖 ASR（收音听觉）、TTS（语音表达）、全双工打断（Barge-In）与外部声学解耦接缝。与具身系统（Embodiment）和用户界面（UI）完全正交。

---

## 0. 历史实现现状对照（2026-09-21）

本规范此前多处描述与实现相反。本次校正的原则是：**未实现的部分标注为未实现，不再以设计语气陈述**；设计意图保留，但状态必须可见。

| 章节 | 状态 | 事实 |
| :--- | :--- | :--- |
| §1.1 「对 LLM 暴露 0 个 Tool」 | ❌ **与实现相反** | Voice 对外暴露一个门面工具；当前动作是 `speak`、`interrupt`、`status`、`manage`。旧 `mute`/`unmute` 动作已退役。 |
| §2 对等消费者 | ✅ 成立 | tts 直接从 `HostEvent` 订阅原始文本并自行清洗，不经具身系统转交 |
| §3.1 文本清洗 | ⚠ **实现位置不同** | 清洗落在 tts 侧 `cleanSentence`（含 `<cue>` 线索剥离）；voice 扩展自身没有清洗器 |
| §3.2 双阈值断句 | ⚠ **实现位置不同** | 断句在 tts 侧 `StreamParser`（标点优先 + 长度兜底） |
| §3.3 声学接缝 | ❌ **已改设计** | **不广播 PCM**。改为把电平测量（rms/peak）搭在**现有播放进度事件**上，经既有 SSE 下发；消费端（具身外壳）只提供接收端。见 §3.3 校正 |
| §3.4 全双工打断 | ❌ **零实现** | 全仓无麦克风采集 / VAD / ASR。**人类目前无法用开口打断主体**——打断只能由模型调用 `voice(interrupt)` 或回合中止触发 |
| §4 Level 1 | ⚠ **已改** | 消费**电平事件**而非 PCM 帧；Layer 3 声学微冲随电平接线完成 |
| §4 Level 2（视素/音素对齐） | ❌ 未实现 | 连契约都未定义 |
| §5 代码拓扑 | ❌ **与现实不符** | 见该节校正 |
| 打断断点投影 | ✅ 已实现 | `VoiceSession.interruptedBreakpoint` → 单轮退火 system 消息，次轮蒸发为 0 token |

**核心教训（值得写进规范）**：语音链路的真实断点曾经是"设计与实现分岔而未标注"。§3.3 的 PCM 旁路与 §3.4 的 ASR 闭环都写在规范里、都被引用，但代码里一条是另一条实现、一条从未存在。**规范不得比实现跑得更前，除非显式标注"规划"。**

---

## 1. 架构定位与第一性原则 (First Principles)

### 1.1 核心哲学：语音是无感基础设施，对大模型只需 0 个管道 Tool

- **大模型的天然接口是文本**：大模型说话只需在回合中输出自然文本，Voice 扩展作为后台消费者自发进行断句、合成与播放，**管道本身 0 工具心智开销**；
- **但"意志控制"是一个真实工具**：静音、开麦、立即打断、查询状态需要一个入口，由 `voice` 门面工具承载（4 个子操作）。这不是管道工具，而是主体对自身发声能力的管理入口；
- **配置属于人类，不属于 LLM**：发音人音色（Speaker）、音量（Volume）、语速倍率（Rate）属于用户的本地偏好配置（通过 `config.json`、CLI 启动参数或 UI 设置面板调整），**不浪费 LLM 上下文去装载语音参数控制工具**。

### 1.2 宿主事实对齐：对等消费者（Peer Consumer）
根据 Uina 宿主事件规范 [`src/host/events.ts`](../../../src/host/events.ts)：
> *“主体对外唯一的观察面 = 事实单流……任何消费者（TUI、stdio、未来的 TTS 或远程观察者）都通过 `subscribe()` 收到同一份序列；宿主不知道谁在监听，也不引用任何 UI 类型。”*

TTS 与 Embodiment 是对等的独立事实单流消费者：
- **无代理原则**：TTS 直接从 `HostEvent` 订阅原始文本，通过自身的 `TextSanitizer` 进行发音清洗，**绝不通过 Embodiment 二手转交**。

---

## 2. 总体架构拓扑 (Architecture Topology)

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Uina Host (主体事实单流 / HostEvent Stream)                            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ subscribe(HostEvent)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ [Extension] Voice Pipeline (src/extensions/voice/)                     │
│                                                                        │
│   1. 非发音文本清洗器 (Text Sanitizer)                                  │
│      - 独立剥离不可见标签: <cue id="..."/>、<think>...</think>         │
│      - 过滤代码块、Markdown 特殊符号与数学公式                          │
│                                                                        │
│   2. 双阈值流式断句器 (Sentence Chunker: 标点 + 长度兜底)               │
│      - 标点断句 + 12~15 字无标点强制断句，死守 TTFT <= 350ms 防线      │
│                                                                        │
│   3. 语音合成引擎适配器 (TTS Engine Adapter)                           │
│      - 可插拔适配: Edge-TTS / Piper (本地低延迟) / ChatTTS / CosyVoice  │
│                                                                        │
│   4. 扬声器播放器 (Audio Sink)                                         │
│      - 音频硬件驱动 (PCM 输出至声卡)                                   │
│      - 15ms 快速无爆音淡出 (Anti-pop Fast Fade-out)                    │
└──────────────────┬─────────────────────────────────▲───────────────────┘
                   │                                 │
                   │ 电平随播放进度事件下发           │ 打断信号 (Host interrupt)
                   │ (rms/peak, 既有 SSE 通道)        │
                   ▼                                 │
┌─────────────────────────────────────┐   ┌──────────┴──────────────────┐
│ [具身外壳] 如 Live2D App            │   │ ⚠ ASR / VAD —— 未实现        │
│ - 暴露 voice.levelSink:* 接收端      │   │ - 麦克风实时收音            │
│ - 接收电平，按自身节拍做包络平滑     │   │ - 人类开口瞬间触发 VAD      │
│ - 驱动下颌开合 + 瞬态声学微冲        │   │ - 发送 interrupt 闭环打断   │
│ - 0 语义依赖，0 调度时钟            │   │ （全仓无代码；见 §3.4）      │
└─────────────────────────────────────┘   └─────────────────────────────┘
```

---

## 3. 核心子系统详细设计 (Subsystems Design)

### 3.1 非发音文本清洗器 (Text Sanitizer)

TTS 引擎在合成前对文本执行纯净度清洗，**保证任何大脑思考与具身线索不被发音**：

```typescript
export function sanitizeTextForSpeech(rawText: string): string {
  return rawText
    // 1. 剥离具身动作线索: <cue id="warm_smile"/> 或 <cue id="..." target="..."/>
    .replace(/<cue\b[^>]*\/?>/gi, "")
    // 2. 剥离思考块: <think>...</think>
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    // 3. 剥离代码块: ```lang ... ```
    .replace(/```[\s\S]*?```/g, "代码块已略过")
    // 4. 剥离行内代码与 Markdown 链接
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}
```

---

### 3.2 双阈值流式断句器 (Low-Latency Sentence Chunker)

为了对抗大模型流式生成时长句没有标点引发的 **首字延迟雪崩（Punctuation Starvation）**，采用“标点优先 + 长度兜底”双阈值机制：

1. **标点优先切分**：遇到逗号、句号、问号、感叹号、顿号、分号，且缓冲区长度 $\ge 4$ 字时立即断句；
2. **长度门限兜底 (Fallback Threshold)**：若持续未遇到标点，首句达到 **12~15 个字（或 8 个英文单词）** 且遇到空格或自然分词边界时，**强制切块送入合成**；
3. **指标硬门禁**：通过双阈值机制，保证任何语境下的 **首音发音延迟（Time-To-First-Audio）严格 $\le 350\text{ms}$**。

---

### 3.3 声学接缝：电平测量随进度事件下发 (Level-over-Progress Seam)

> **本节已按实现重写（2026-09-21）。** 原设计为"Audio Sink 在写声卡的同一瞬间广播 `playback:pcm`（Float32Array）"，该方案**已否决并删除**：口型只需要包络，而逐帧 PCM 跨进程传输需要新建二进制通道，收益不成比例。

#### ① 实际形态：电平搭现有进度事件

桥侧播放进度循环（`_run_subtitle_progress_loop`）本就每 tick 从播放器取一次进度快照并 `publish` 出网。电平因此**不需要第二条通道、也不需要新的事件类型**——只要进快照即可随现有事件流动：

```text
AudioPlayback.feed(pcm)   ──► measure_pcm_level()   （锁外，O(样本数)/跨步采样）
        │                            │
        │                     _level_rms / _level_peak
        ▼                            │
  progress_snapshot() ◄──────────────┘
        │
        ▼
  remember_snapshot() → publish(detail={ played_ms, buffered_ms, rms, peak, ... })
        │
        ▼
   既有 SSE (event: tts.playback)  ──►  tts 扩展 subscribeEvents
                                            │
                                            ▼
                                    按前缀筛出 voice.levelSink:* 接收端并推送
```

#### ② 测量与包络的职责分离

- **生产者只报测量**：`rms` / `peak` 是"最近这段音频测到多少"，**不做时间衰减**；
- **消费者做包络**：攻击/释放由消费端按其渲染节拍完成（Live2D 的 `AudioObserver` 在 60Hz tick 中以 80ms 半衰期衰减）。

这样生产者不必替消费者决定"口型多快张开、多快合上"，也不会因渲染节拍差异而需要两套调参。

#### ③ 性能红线（保留自原设计，但约束位置已变）

- **测量必须在缓冲区锁外完成**：`feed()` 在投递线程（非 PortAudio 回调）执行，但仍不得延长 `_buffer_lock` 的持有时间；
- **零依赖、常数级成本**：`memoryview.cast("h")` 零拷贝取样本，整型累加，按 `_LEVEL_MAX_SAMPLES`（1024）跨步采样；
- **异常一律退化**：测量失败返回 `(0.0, 0.0)`，**绝不允许影响发声**。

#### ④ 精度上限（如实标注）

电平是**整段音频的包络**，不是视素对齐：它只能驱动下颌开合幅度，无法区分 A/I/U/E/O 口型。需要精细嘴型请见 §4 Level 2（未实现）。


---

### 3.4 全双工打断闭环 (Full-Duplex Barge-In Loop)

> ⚠ **本节为规划，零实现（2026-09-21 核实）。** 全仓不存在麦克风采集、VAD 或 ASR 代码。**人类目前无法用开口打断主体**：打断只能由①模型调用 `voice({action:"interrupt"})`，或②回合中止（`turn_aborted`）触发。
>
> 本节保留设计意图，供将来单独立项时作为起点。**不要把它当成已有能力引用。**

**目标闭环（未实现）**：

数字主体能够被人类随时开口打断，其闭环路径如下：

```text
[人类开口说话] 
      │
      ▼
本地麦克风收音 (audio-capture) ──> VAD 检测到有效人声 (判定时长 <= 80ms)
                                                │
                                                ▼
                                    向 Uina Host 发送 interrupt 信号
                                                │
                                                ▼
                                   Host 广播 interrupt 事件
                                                │
        ┌───────────────────────────────────────┴───────────────────────────────────────┐
        ▼ (Voice 响应)                                                                 ▼ (Embodiment 响应)
  1. AudioSink 立即执行 15ms 快速无爆音淡出静音                                    1. 端点调用 safeStop()
  2. 取消 TTS 引擎中正在排队与合成的任务 (AbortSignal)                             2. 弹簧阻尼收敛回正
  3. 清空待发音文本缓冲区                                                          3. 视线拉正注视用户
  4. 广播 playback:end 事件
```

---

## 4. 两级口型与表现力演进 (Acoustic Drive Tiers)

```text
Level 1: 声学电平包络 (Universal Level Envelope) - 已实现
- 桥侧在播放侧测量 rms/peak，随**现有播放进度事件**下发（不是 PCM 广播）
- 任何具身外壳只需暴露一个 voice.levelSink:* 接收端即可开箱即用
- 消费端自行把电平映射为下颌/口型开合（Live2D 的 AudioObserver 以 80ms 半衰期做包络）
- 另外提供 : 瞬态（peak 超阈值）可驱动声学微冲，如头部随重音微沉
- 零第三方依赖、100% 引擎通用；代价是无法区分视素（见 Level 2）

Level 2: 视素/音素时间戳对齐 (Viseme / Phoneme Alignment) - 未实现
- 需要高级 TTS（如 Azure Speech / 带音素对齐的 Piper）
- 设想在播放到达对应时间戳时抛出视素事件: "playback:viseme" ({ visemeId })
- 连契约都未定义；当前无任何代码或类型承载
```

---

## 5. 工程代码拓扑（按实现校正）

> 原拓扑描述的 `src/extensions/voice/{text-sanitizer,sentence-chunker,audio-sink,tts/,asr/}` **在实现中不存在**：清洗、断句、合成与播放全部落在 tts 扩展；voice 扩展收敛为"发声意志 + 交付断点"。

```text
.uina/extensions/voice/                 # 实际位置：本地扩展目录（非 src/，不入库）
  ├── index.ts                  # 扩展入口：注册 voice 门面工具与 voice:* 服务、订阅生命周期
  ├── events.ts                 # 声学契约：VoiceLevelEvent、VoiceLevelSink、
  │                             #   VOICE_LEVEL_SINK_EXPOSED_PREFIX、isVoiceLevelSink
  ├── session.ts                # VoiceSession：发声意志 (enabled/muted) + 交付断点状态机
  ├── driver.ts                 # VoiceOutputDriver 向下接缝 + PlaybackBreakpoint/PlaybackStatus
  └── tool.ts                   # voice 门面工具 (speak/interrupt/status/manage)

.uina/extensions/tts/                   # 实际声音生产者
  ├── index.ts                  # 订阅 HostEvent、把电平扇出给具身外壳、注册 voice_driver:*
  ├── client.ts                 # 桥 HTTP/SSE 客户端；PlaybackEvent + readPlaybackLevel
  ├── stream-parser.ts          # 双阈值断句 + cleanSentence（含 <cue> 线索剥离）
  ├── driver-impl.ts            # TtsVoiceOutputDriver：实现 VoiceOutputDriver
  ├── companion.ts              # 伴生 Python 桥的探测/拉起/回收
  └── bridge/                   # Python 桥（GPT-SoVITS）：合成、播放、电平测量、SSE 广播

（未实现）asr/                  # 麦克风采集 / VAD / ASR —— 全仓不存在
```

