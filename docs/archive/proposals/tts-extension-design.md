# Uina 语音发声与打断扩展（TTS Extension）设计规范

## 1. 架构定位与设计哲学

### 1.1 外部扩展形态（Zero Core Intrusion）
TTS 发声能力定位为 **Uina 系统级外部扩展**，独立部署于 `.uina/extensions/tts/`：
- **内核绝对零侵入**：`src/` 核心目录不引入任何关于 Python 路径、GPT-SoVITS 模型权重、CABLE 虚拟声卡或物理端口的业务代码；
- **即插即用（Pluggable）**：在配备 GPU 与语音环境的主机上放入即发声；在纯文本终端或 CI 环境下移除即静默，宿主生命周期不受任何干扰；
- **标准事实流驱动**：完全基于 `ExtensionAPI` 的标准事实事件流（`output_update`、`turn_start`、`turn_end`、`turn_aborted`）闭环驱动。

### 1.2 数字主体具身原则
1. **发声与心理活动分离**：正式对白属于发声器官行为；心理活动、动作描写或给用户的文字附注通过中英文括号 `(...)` / `（...）` 输出，只显文字、绝不发声。
2. **全双工主体自律打断（Full-Duplex Autonomous Agency）**：
   - **拒绝底层暴力硬掐**：用户输入新消息不等于强制掐断发声。新输入到达时，上一轮发声自然继续播放；
   - **主体认知驱动打断（自我打断）**：通过上下文视口向模型投影当前发声状态。由 Agent 结合用户语义自主决定是否调用 `voice.interrupt` 主动闭嘴并记录断点；
   - **非侵入共存**：若用户只是补充信息或倾听，Agent 可用 `(...)` 括号输出独白或等待播放完毕，杜绝机械失语与语音碎片。
   - **物理急停边界**：仅当用户按下 `Esc`（`turn_aborted`）时执行物理级强行急停。
3. **真·字符级认知对齐（Sub-sentence Alignment）**：被主动打断或物理中断时，主体通过底层的毫秒级发声状态精确获知用户听到哪个字，断点通过单轮时效性视口回灌给模型，杜绝假装“我已经全说完了”，也杜绝重复念已经听过的半句话。
4. **单一权威源（Single Source of Truth）**：发声底层（`tts_bridge`）拥有播放状态与物理队列的绝对权威；Node 扩展只负责开闭麦意志、分句缓冲与视口策略，绝不在 Node 端做有状态的镜像队列，消灭分布式状态漂移。
5. **绝对正交与事件流解耦（Producer-Consumer Architecture）**：`tts_bridge` 是纯粹的音频能力提供方，绝不直接调用 OBS（8104）；OBS、Live2D 与 Uina 扩展均作为事件消费者，直接订阅 `tts_bridge` 发布的 `/v1/tts/events` 事件流。
6. **深模块设计原则（Deep Modules over Shallow Classes）**：
   - 拒绝文件碎化与贫血数据结构（Anemic DTO）；
   - 暴露窄小、不可误用的极简接口（如 `feed/flush`、`handleTurnStart/world query`），将跨 Chunk 流式解析、Emoji/Markdown 剥离、数字保护、退火视口与打断时序完整封装在深模块内部。
7. **所有权自律**：伴生进程管理器遵循“谁拉起谁销毁”，连接外部已有服务时退出绝不误杀。

---

## 2. 架构拓扑与目录组织

### 2.1 整体数据流与事件总线拓扑图

```text
               ┌────────────────────────────────────────────────────────┐
               │                  大模型生成输出 (LLM)                  │
               └──────────────────────────┬─────────────────────────────┘
                                          │ 1. 流式输出事件 output_update
                                          ▼
                         ┌─────────────────────────────────┐
                         │   深模块 1: StreamParser        │
                         │   (流式分句、括号拦截、数字保护) │
                         └────────────────┬────────────────┘
                                          │ feed(chunk) -> string[]
                                          ▼
                         ┌─────────────────────────────────┐
                         │   深模块 2: VoiceSession        │
                         │   (voiceState, traceId, 断点)   │
                         └────────────────┬────────────────┘
                                          │ voiceState === "enabled"
                                          ▼
                         ┌─────────────────────────────────┐
                         │   深模块 3: TtsBridgeClient     │
                         │   POST /v1/tts/speak (带 trace) │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │ Python tts_bridge (8102)        │
                         │ - 拥有播放权威与 16ms 进度      │
                         │ - 发布 /v1/tts/events SSE 流    │
                         └────────┬───────────────┬────────┘
                                  │               │
            ┌─────────────────────┴───────┐       └───────────────────────┐
            ▼                             ▼                               ▼
      扬声器硬件播放             CABLE 镜像音频输出           OBS / Live2D / 扩展独立订阅
            │                             │                   (GET /v1/tts/events, 0 延迟打字机)
            │ (遇用户打断 Barge-in)         ▼
            └──► cancel_trace 立即掐断 ──► VTS 嘴型闭合
```

### 2.2 扩展目录结构 (`.uina/extensions/tts/`)

按“深模块”标准收敛后的紧凑目录：

```text
.uina/extensions/tts/
  ├── package.json              # 声明 "type": "module"
  ├── config.json               # 配置文件（端口、伴生路径、标点规则）
  ├── config.ts                 # 配置加载与默认值收敛
  ├── client.ts                 # 深模块 3：底层 Bridge 通信客户端 (HTTP/SSE，向 Python 索取权威事实)
  ├── companion.ts              # 深模块 4：伴生进程生命周期管理 (ensureCompanion: 探测/拉起/自律清理)
  ├── stream-parser.ts          # 深模块 1：流式语音解析器 (内聚 <think>、代码块、括号、标点与数字保护)
  ├── session.ts                # 深模块 2：语音交互会话控制器 (内聚单一事实源、Barge-in、字符断点与退火视口)
  ├── tool.ts                   # 深模块 5：大模型控制门面工具 (voice: mute/unmute/interrupt/status)
  ├── index.ts                  # 扩展激活入口 (组合根：不到 50 行纯装配代码)
  └── README.md                 # 扩展使用与开发文档
```

---

## 3. 深模块规格详解

### 3.1 深模块 1：流式语音文本解析器 (`stream-parser.ts`)

- **设计哲学**：将原来散落在 `sanitizer.ts` 和 `splitter.ts` 中的流式过滤、跨 Chunk 标签、括号状态与标点切词彻底熔铸为一个高内聚深模块。
- **极简接口（Small Interface）**：
  ```typescript
  export interface StreamParserOptions {
    maxSentenceChars?: number; // 默认 20 字长句保底
  }

  export class StreamParser {
    constructor(options?: StreamParserOptions);

    /** 送入流式文本 Chunk，立即返回解析出的一组待播完整句子（已净化、已断句） */
    feed(chunk: string): string[];

    /** 回合结束时调用，吐出尾部未闭合但合法的剩余发音文本 */
    flush(): string[];

    /** 强制重置全部内部状态机（如遇到打断或新回合开始） */
    reset(): void;
  }
  ```
- **内部隐藏的深邃复杂度（Deep Implementation）**：
  1. **跨 Chunk `<think>...</think>` 状态机**：即使 `<think>` 标签被截断在两个 chunk（如 `<thi` 与 `nk>`），内部缓冲区亦能无缝吸收并在思考期完全静音；
  2. **跨 Chunk 代码块替换**：识别 ```` ```...``` ````，输出到屏幕但送入 TTS 替换为 `（代码已生成在聊天中）` 并静音；
  3. **中英文括号深度追踪**：精准跟踪 `bracketDepth`（支持 `(` / `)` 与 `（` / `）`），括号内部心理活动绝对不进入发声队列；`flush`/`reset` 时安全归零；
  4. **数字保护（Adversarial Defense）**：
     - **千分位逗号保护**：`/\d,\d/`（如 `100,000`）绝对不切；
     - **小数与版本号保护**：`/\d\.\d/`（如 `3.14`、`v2.0`）绝对不切；
  5. **标点合并与空串防御**：连续标点（`……`、`...`、`？？？`、`！！！`）原子化合并，过滤纯标点空句子；遇到 `。！？；\n`（或半角 `.!?;`）或超 20 字逗号当场切分。

---

### 3.2 深模块 2：语音交互会话控制器 (`session.ts`)

- **设计哲学**：将原来散落在 `state.ts`、`interruption.ts` 和 `viewport.ts` 中的状态、打断判定、字符断点捕获和视口生成彻底融为一个高内聚会话控制器。消灭贫血 DTO。
- **极简接口（Small Interface）**：
  ```typescript
  export interface BreakpointInfo {
    heardText: string;
    unheardText: string;
  }

  export class VoiceSession {
    constructor(client: TtsBridgeClient);

    /** 麦克风工作意愿模式（唯一由 Node 拥有的权威意愿） */
    readonly voiceState: "enabled" | "muted";

    /** 关麦（后续只打字不发音） */
    mute(): void;
    /** 开麦（恢复发音） */
    unmute(): void;

    /** 核心事件感知：新回合开始（严格对应用户输入） */
    handleTurnStart(turnNumber: number, userText: string): Promise<void>;

    /** 核心事件感知：回合正常结束 */
    handleTurnEnd(): Promise<void>;

    /** 主动/被动打断当前发音 */
    interrupt(): Promise<BreakpointInfo | null>;

    /** 获取当前应投递的 traceId */
    currentTraceId(): string;

    /** 获取当前递增的 segmentIndex */
    nextSegmentIndex(): number;

    /** 渲染视口（常态 0-Token，打断后单轮字符级退火提示） */
    world query(): string;

    /** 权威状态查询（向 Python bridge 索取真实播放状态） */
    getStatus(): Promise<{
      voiceState: "enabled" | "muted";
      playback: "idle" | "synthesizing" | "playing";
      activeTraceId: string | null;
    }>;
  }
  ```
- **内部隐藏的深邃复杂度（Deep Implementation）**：
  1. **单一事实源与生命周期**：Node 端绝不维护物理排队队列 `queue: string[]`，所有播放与队列事实全交由 `tts_bridge` 掌管；
  2. **并发身份与索引协议（Identity & 1-based Indexing）**：每轮对话生成唯一 `trace_id = "turn_${turnNumber}_${Date.now()}"`，`segmentIndex` 严格以 1-based 递增（第 1 句为 1），与 Python 桥接调度内核的 `next_play_index` 与优先级策略严格对齐，底层 `sliding_window.py` 同步具备自适应容错；
  3. **全双工共存，拒绝无差别自动截断**：`turn_start` 到达时，**绝不自动调用 `interrupt()`**。上一轮语音让底层继续自然播放；
  4. **声卡唤醒爬坡保护（DAC Pre-roll Silence）**：底层播放器在每次新流启动的首个分句前自动垫入 120ms 静音，确保 Windows WASAPI / 硬件声卡 DAC 稳定上电，彻底杜绝首句短文本的首字被裁剪；
  5. **真·字符级断点提取（Sub-sentence Alignment）**：仅在 Agent 自主调用 `voice.interrupt` 或用户按下 `Esc`（`turn_aborted`）时触发 `cancel-trace`；向 `tts_bridge` 请求 `subtitle-state`，提取权威 `revealed_text` 与完整文本，计算差量生成精确到汉字的 `BreakpointInfo`；
  6. **时效退火视口与发声状态投影（Context Viewport）**：
     - **常态（开麦且静止）**：返回 `""`（**0 Token**，100% 保护 Prompt Cache 前缀）；
     - **关麦常态**：返回 `"[TTS: 麦克风已关麦(静音模式)]"`；
     - **发声中状态感知态（全双工指引）**：若上一轮或当前语音仍在播放/合成，向模型投影当前身体发声状态：
       ```text
       [发声状态: 你上一轮的语音仍在播放中。
        - 若用户意在打断或切换话题，请显式调用 voice 工具的 interrupt 动作；
        - 若无需打断，请正常处理，说话期间可使用 () 括号输出心理活动/动作（括号内容免播），避免产生重叠发声。]
       ```
     - **打断退火态**：在主动打断后的首个回合返回：
       ```text
       [发声断点: 上轮发声被用户打断。
        用户已听到："我觉得这个方案其实可以"
        用户未听完："进一步优化代码结构……"]
       ```
       次轮自动退火清除，恢复为 `""`（0 Token），上下文不留冗余垃圾。

---

### 3.3 深模块 3：底层 Bridge 通信客户端 (`client.ts`)

- **极简接口**：
  ```typescript
  export class TtsBridgeClient {
    constructor(baseUrl: string, timeoutMs?: number);
    isHealthy(): Promise<boolean>;
    speak(payload: { trace_id: string; segment_id: string; index: number; text: string }): Promise<void>;
    cancelTrace(traceId: string): Promise<void>;
    turnEnd(traceId: string): Promise<void>;
    getSubtitleState(traceId: string): Promise<SubtitleStateResponse | null>;
    subscribeEvents(traceId: string, onEvent: (e: PlaybackEvent) => void, signal?: AbortSignal): Promise<void>;
  }
  ```
- **内部隐藏**：HTTP 连接池复用、超时控制、JSON 序列化、错误安全降级与 SSE 事件解析。

---

### 3.4 深模块 4：伴生进程生命周期管理 (`companion.ts`)

- **极简接口**：
  ```typescript
  export interface CompanionHandle {
    readonly didSpawn: boolean;
    readonly pid?: number;
    stop(): Promise<void>;
  }

  export async function ensureCompanion(
    config: TtsCompanionConfig,
    signal?: AbortSignal,
  ): Promise<CompanionHandle>;
  ```
- **内部隐藏**：
  1. 启动探测：先发 `/health` 请求，通则直接复用已有服务，标记 `didSpawn = false`；
  2. 按需拉起：未通且 `autoSpawn === true` 时拉起 Python 进程，标记 `didSpawn = true`；30s 轮询就绪；
  3. 所有权自律（严禁误杀外部进程）：仅当 `didSpawn === true` 时才在 `signal.abort` 时使用 Windows `taskkill /F /T /PID` 清理进程树。

---

### 3.5 深模块 5：控制门面工具 (`tool.ts`)

暴露极简 `voice` 门面工具，纯委托给 `VoiceSession`：
```typescript
export function createVoiceTool(session: VoiceSession): Tool;
```
- `action`: `"mute" | "unmute" | "interrupt" | "status"`。

---

### 3.6 组合根：扩展激活入口 (`index.ts`)

由于各个深模块已内聚了全部核心逻辑，`index.ts` 蜕变为不到 50 行的纯声明式装配根：

```typescript
export default async function activate(pi: ExtensionAPI): Promise<void> {
  const config = loadConfig(pi.cwd);
  const client = new TtsBridgeClient(config.serviceUrl, config.requestTimeoutMs);
  const companion = await ensureCompanion(config, pi.signal);
  const parser = new StreamParser({ maxSentenceChars: config.maxSentenceChars });
  const session = new VoiceSession(client);

  // 1. 注册门面工具与系统服务
  pi.registerTool(createVoiceTool(session));
  pi.registerService("tts", createTtsService(session));

  // 2. 事实事件流闭环驱动
  pi.on("turn_start", async (e) => {
    parser.reset();
    await session.handleTurnStart(e.turnNumber, e.userText);
  });

  pi.on("output_update", async (e) => {
    if (e.channel !== "content" || session.voiceState === "muted") return;
    const sentences = parser.feed(e.text);
    for (const s of sentences) {
      await client.speak({
        trace_id: session.currentTraceId(),
        segment_id: `${session.currentTraceId()}:${session.nextSegmentIndex()}`,
        index: session.currentSegmentIndex(),
        text: s,
      });
    }
  });

  pi.on("turn_end", async () => {
    const tail = parser.flush();
    for (const s of tail) {
      await client.speak({
        trace_id: session.currentTraceId(),
        segment_id: `${session.currentTraceId()}:${session.nextSegmentIndex()}`,
        index: session.currentSegmentIndex(),
        text: s,
      });
    }
    await client.turnEnd(session.currentTraceId());
    await session.handleTurnEnd();
  });

  pi.on("turn_aborted", async () => {
    await session.interrupt();
    parser.reset();
  });
}
```

---

## 4. 分阶段实施规划

| 阶段 | 核心模块 | 交付成果 | 验收标准 |
| :---: | :--- | :--- | :--- |
| **Phase 1** | **伴生与通信深模块** | `companion.ts` + `client.ts` + `config.ts` | 成功探测或拉起 8102 服务，`didSpawn` 所有权自律生效，单测覆盖 HTTP/SSE 与生命周期。 |
| **Phase 2** | **流式解析深模块** | `stream-parser.ts` | 单元测试验证：跨 chunk `<think>`、代码块替换、括号免播、千分位小数保护、标点合并、长句保底。 |
| **Phase 3** | **会话控制深模块** | `session.ts` | 验证单一事实源、`traceId` 并发控制、Barge-in 打断、从 `subtitle-state` 提取字符级断点、单轮 0-Token 退火视口。 |
| **Phase 4** | **门面工具与装配根** | `tool.ts` + `index.ts` + `README.md` | `voice` 工具与 `registerService("tts")` 系统服务注册验证，端到端事件流串联。 |
| **Phase 5** | **全量集成与质量门禁** | `tests/tts-extension.test.ts` | 真实/Mock 混合验证，全量单测通过，`pnpm typecheck` 0 错误，CRAP < 30。 |
