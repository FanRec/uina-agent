# 实时语音字幕服务设计

日期：2026-09-30  
状态：服务、协议、呈现控制器与 TTS 伴生管理代码已实现；本文保留原设计和验收边界，不代表 OBS/真实音画同步已通过。当前源码还支持无 cue 的 `typewriter` 时长估算，与本文“不以字符数/总时长生成 cues”的精确同步原则不同。该模式应明确视为近似视觉进度，还是移除，仍待裁决；在裁决前不能将它描述为逐词或音频时钟对齐。  
项目暂名：Realtime Subtitles（`realtime-subtitles`）。

## 1. 用户目标与决定

在 OBS 中显示正在播放的 TTS 对白。字幕应清楚、稳定、少打扰，启动和配置步骤应尽量少；语音、字幕服务和 OBS 可以独立运行、断开和重启。

采用**独立本地服务 + 一个透明 Overlay + 一个设置与预览页面**。字幕服务订阅语音生产者的播放事实流。Uina 是语音的一个来源，不是字幕服务的运行前提。

上一代 `E:/Uina_Core/services/obs_bridge` 只提供问题与行为参考。此次重新实现，不迁移它的代码、目录、接口、配置或事件兼容层。服务不属于 Extension、World 或 Core，也不增加字幕 World 或模型工具。

拟定位置：

| 内容 | 位置 | 所有权 |
|---|---|---|
| 独立服务源码、资源、测试、构建产物 | `E:/Uina/ThirdParty/realtime-subtitles/` | 第一方独立项目，单独 Git 仓库 |
| 当前设计规格 | `E:/Uina/Uina/docs/proposals/voice/realtime-subtitle-service-design.md` | 本次集成设计，供审阅 |
| TTS 播放事实接缝 | 当前 TTS Bridge 内部 | 语音生产者 |
| 服务设置 | 服务目录下 `data/settings.json` | 字幕服务 |
| 会话字幕与连接状态 | 内存 | 字幕服务，不持久化 |

`ThirdParty` 在此是本机外部程序工作区，不表示项目必须来自第三方。独立服务在别的位置克隆后应同样能运行；不把此绝对路径编译进程序。

独立项目的 README 和协议文件随实现一并维护。此次只创建当前仓库的本地设计文件，遵守 `docs/proposals` 的 Git 忽略约定；不创建项目、不迁移旧服务、不修改运行配置。

## 2. 现实依据与需要修正的旧设计

以下是当前源码事实，尚未进行真实声卡与 OBS 同步测量：

| 观察 | 来源 | 对设计的影响 |
|---|---|---|
| 旧服务接收 sentence 与播放进度两种输入，并通过 grace timer 竞争回退 | 旧 `src/service.ts` | 删除双轨输入与时间竞争 |
| 旧状态保存整个 history，Overlay 每次清空 DOM 后重建 | 旧 `subtitle-state.ts`、`overlay/main.js` | 只保留当前字幕，按身份更新 DOM |
| 旧 Overlay 用每秒字符数追赶，`needsAnimation` 根据总字数判断 | 旧 `overlay/main.js` | 进度停止时可能继续空跑；新版本不自建字符时钟 |
| 已存在的 TTS 事实流可独立订阅 | 当前 `bridge/runtime_components.py`、`server.py` | 字幕服务作为消费者接入 |
| 当前 TTS SSE 没有全局初始快照及有序 revision；订阅队列满时忽略消息 | 当前 `PlaybackEventHub` | 不能直接把现有 SSE 当成可靠字幕协议 |
| 当前进度事件没有完整字幕与时长，状态接口要求 trace_id | 当前 `service.py`、`server.py` | 补充全局“当前物理播放”投影，避免消费者拼接任务历史 |
| 当前播放器主要以开始后的经过时间减去重缓冲时间估算位置 | 当前 `audio_playback.py` | 不能称为 DAC 精确时钟 |
| subtitle_sync 仍存在同步 HTTP POST，但当前配置 enabled=false | 当前 `subtitle_sync.py`、`config/service.toml` | 不继承 OBS 专用推送；不声称现在线上一定受其阻塞 |
| 当前 voice 门面没有暂停、恢复动作 | 当前 TTS 扩展 README 与客户端 | 控制台不提供虚假的播放控制按钮 |

`producerInstance` 只表示生产者进程身份，不参与新旧排序：UUID 和进程标识没有天然时间顺序，不能比较字符串或解析墙钟来决定谁更新。连接层用实例身份绑定连接，用实例内 revision 判断消息顺序；实例变化必须通过新的 bootstrap 确认。

## 3. 收敛范围与方案取舍

| 方案 | 优点 | 成本或限制 | 决定 |
|---|---|---|---|
| 字幕服务订阅播放器事实流 | 生产者不认识 OBS；声音与展示独立 | 需要完整、可恢复的播放快照接缝 | 采用 |
| TTS 向字幕服务 POST 状态 | 服务输入简单 | 生产者承担外部 URL、请求重试与关闭生命周期 | 第一版不做 |
| 合并进点歌机 broadcast-hud | 复用一个端口和网页壳 | 扩大音乐 HUD 协议与生命周期，故障范围变大 | 暂不合并 |

服务第一版只连接一个配置的语音生产者，可连接任意数量的 OBS 页面。保留通用协议，但不实现插件注册表、多生产者仲裁、字幕混流或通用事件总线。

第一版提供：自动连接与重连、整段字幕、可用时的时间标记高亮、布局配置、延迟校准、预览、字幕开关、当前字幕清空、连接诊断。

不提供：TTS 合成、音频播放、麦克风识别、翻译、音频录制、字幕历史数据库、OBS 场景控制、音乐信息、频谱、远程账号体系、自动改写或润色对白。

实现收敛为三份权威状态：播放器拥有 `PlaybackSnapshot`，字幕服务拥有 `PresentationSnapshot`，浏览器拥有 `RenderState`。`sourceInstance`、`revision`、连接 generation 和 TTL 是传输层机制，不得在三层各自复制一套业务状态。

服务内部保留一个 `PresentationController` 作为状态核心。它只接收 `onPlayback(snapshot)`、`setSettings(settings)`、`setEnabled(enabled)`、`clear()`、`disconnect()` 和 `tick(now)`，输出 `PresentationSnapshot`。不再按功能拆出 `PlaybackStateManager`、`HoldManager`、`DelayScheduler`、`ClearManager` 或 `ConnectionStateManager`；连接重试、版本检查和旧回调失效都封装在 `SourceConnection` 或浏览器连接层。

业务层只处理 `playback.id` 是否变化、播放状态和终止原因。`sourceInstance`、`revision` 和 connection generation 不向 `PresentationController` 或 Renderer 泄漏。

## 4. 用户从启动到使用的完整路径

1. 双击独立项目的 `start.cmd`，或运行 `pnpm start`。
2. 程序显示“设置与预览地址”和“OBS 字幕地址”。端口冲突时明确提示端口占用，不自动换到另一个端口。
3. 打开设置页。默认语音服务地址为 `http://127.0.0.1:8102`；可连接性与协议能力分别检查。
4. 页面展示字幕预览，并提供“复制 OBS 地址”“复制推荐尺寸”。
5. 在 OBS 添加浏览器源，粘贴 URL，设置与画布一致的尺寸。
6. 正常使用 TTS。以后 OBS 与 TTS 可以任意先启动；字幕服务自行恢复连接。

无需 OBS 插件、OBS WebSocket 密钥、复制自定义 CSS 或配置多个服务地址。Overlay 不输出音频，TTS 仍走用户现有的 OBS 音频捕获路径，避免双重播放。

服务可以由用户或现有本机启动器启动。谁启动谁负责退出，复用外部进程时不关闭它；Uina 不因字幕不可用停止启动或播放。第一版不新增 Uina 自动伴生进程管理器。

`start.cmd` 在当前终端运行，不弹出额外隐藏守护进程。没有安装依赖或构建产物时给出可执行提示。服务正常启动才打印 ready；健康接口不能因为 HTTP 正在监听就宣称 TTS 或 OBS 已连接。

## 5. 页面与视觉设计

### 5.1 设置与预览页：一页完成常用操作

页面从上到下：

```text
实时字幕                                      字幕：开启

[语音已连接] [字幕源可用] [OBS 页面：1]        复制 OBS 地址

┌────────── 当前画布预览，背景可切换 ──────────┐
│                                            │
│             这是正在说的一句话。            │
└────────────────────────────────────────────┘

画布：横屏 / 竖屏    字号    位置    最大宽度
样式：清晰描边 / 柔和底板    主色    高亮色
显示：整段 / 自动高亮    停留时间    字幕延迟

[保存设置] [恢复默认] [清空当前字幕]
展开：连接地址、协议状态、重连、布局诊断
```

第一屏使用“等待说话”“语音服务未连接”“字幕接口需要升级”等人能理解的文案。实例 ID、revision、时钟质量放在展开诊断中。

编辑在预览中即时反映，按“保存设置”后才影响直播；未保存修改有提示。保存原子写入，失败保留原配置并展示原因。恢复默认同样先预览、再保存。

字幕开关只隐藏字幕，不改变 TTS 静音或播放。开关持久化，清空不持久化。服务用 `suppressedPlaybackId` 表达手动清空：`clear()` 将它设为当前 `playback.id`，同一 playback 的心跳和位置更新继续隐藏；新的播放身份开始时清除 suppression。不要用无法说明身份的 `wasManuallyCleared` 布尔值。

预览样例只在设置页面本地渲染，明确标记“样例”，不注入正式 Overlay，不自动发声。真实状态预览与正式 Overlay 共用渲染器。

### 5.2 OBS Overlay：默认只显示当前对白

默认透明背景、当前段落居中置于画布下部，最多两行。上一段、下一段、连接文字、进度条、任务 ID 都不显示。直播观众不应看见故障调试面板。

默认样式：

- 1080p 画布字号 48px，行高 1.35，字重 700，深色描边 3px，轻阴影。
- 字体栈为 `Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif`，不请求外部字体。
- 横屏文字框宽 80%，底部安全距离 6%；竖屏文字框宽 88%，底部安全距离 12%。
- 720p 与窄画布按短边缩放，设置页预览和 OBS 使用相同画布尺寸。
- 两个预设：清晰描边为默认；柔和底板增加局部半透明背景，不增加光晕、波形或大面积装饰。
- 出现与替换不播放打字机动画；正常结束保留 1200ms，再用 150ms 淡出。新对白立即取代旧对白，不等待动画。
- 取消、失败、源断开、手动清空立即隐藏，不展示剩余未播放内容。

可用性优先于装饰。启用减少动画偏好时不淡入淡出。

### 5.3 长文本的明确退化

视觉换行和 TTS 分句是两件事。不能为填满屏幕重新组织对白或用墙钟猜测什么时候翻页。

按字体实际宽度测量与换行，使用 grapheme 边界，不拆 emoji 组合。数字、英文词、标点尽量保持完整；超长 URL 等无空格串可以断行。

一般保持两行。超出时先缩小至画布基准字号的 75%，再扩展至最多四行；仍超出则启用完整文本滚动区域，依据已测量的内容高度和播放位置作滚动定位，明确标记布局退化。时长未知且没有 cues 时保持静态、手动预览可滚动，并显示布局警告；不伪造分页时序，也不静默省略正文。已知位置的比例滚动只是长文本的视觉退化，不称为词级对齐；正文不能完整装入画布时，设置页必须提示缩短生产者段落或增大字幕区域。

设置页提供长句、中文英文混排、数字和 emoji 样例。正常生产者应优先提供能在默认两行内显示的短段落；当前 TTS 的短句分段可以直接利用，不为字幕改变合成策略。

## 6. 两个独立事实：播放位置与词级时间标记

### 6.1 播放位置由播放器拥有

字幕服务和浏览器不能把“文本提交”“合成完成”当作“已说出口”，不能用 LLM token 到达节奏驱动字幕。

当前 TTS 对真实位置的最低改进要求：

- 按播放身份记录段起点，连续声卡流的累计位置转换为当前段内位置。
- 有可用 DAC 时间时，结合回调中的帧偏移映射到输出时间；最后一帧进入回调缓冲不等于已输出。
- 回调提供给设备的采样数是较弱证据，需注明为 submitted_samples，并处理输出缓冲延迟。
- 合成预缓冲、重缓冲和静音填充不增加对白音频位置；对白音频中的自然静音仍占时间。
- `clockQuality=dac` 只有在已经建立“当前播放段帧 → 音频回调帧 → DAC 输出时间”的映射时才允许使用；仅仅因为设备 API 提供 `outputBufferDacTime` 不足以宣称 DAC 精度。否则使用 `submitted_samples`、`estimated` 或 `unknown`。
- 播放段身份由播放器在实际接受为 current segment 时生成；合成任务、文本切句和排队阶段没有 playback identity。
- 音频回调只记录必要标量；JSON 序列化、网络 IO、字体测量都在回调之外。
- 下一段开始前结束旧段的进度观察器，确保旧线程不会读到新段位置并标记旧段完成。
- 播放自然完成需要输出尾部完成证据；取消和失败不得把未播放字符补齐。

sounddevice 定义了 `outputBufferDacTime`、`currentTime` 等流时钟，并要求回调避免阻塞操作。这只提供可用接缝，具体 Windows 设备的准确性仍需录制验证。[官方文档](https://python-sounddevice.readthedocs.io/en/latest/api/streams.html)

### 6.2 默认整段显示；有时间标记再高亮

整段模式：当前段在播放器确认开始输出后完整显示，随物理段切换。可提前阅读已开始的句子，这是普通字幕行为，不宣称每个字已被听到。

自动高亮模式：整个段落的几何布局保持固定，有有效 cue 时按播放器确认的位置高亮已到达的词。没有 cue 时显示完整段落，设置页提示“当前语音源没有词级时间标记，使用整段字幕”。

不使用字符数/总时长生成假 cues，不用每秒字符数追赶，不因某段结束把所有尚未达到的词高亮。精确音频时钟与精确词级对齐是两个独立能力；缺任一方都不能声称逐词准确。

仅 clockQuality=dac、positionMs 已知且 cue 有效时启用高亮；submitted_samples、estimated、unknown 使用整段，并在设置页说明时间精度限制。第一版实现 cue 校验和渲染，但不新增强制对齐模型、ASR 或合成依赖来制造 cues。现有 TTS 无 cue 时，整段模式即可完成交付。

## 7. 协议：一个事实快照流，一个展示快照流

### 7.1 语音生产者 → 字幕服务

生产者提供：

```text
GET /v1/playback/events
Content-Type: text/event-stream
event: playback.snapshot
```

这是拟新增的通用观察接口，不是当前桥已实现的接口。第一帧必须是完整当前状态，后续每帧也为完整快照。字幕服务只配置 baseUrl，不需要 Uina 会话 ID。

示例：

```json
{
  "version": 1,
  "sourceInstance": "43d76f23-665d-4dce-bbd0-ec46f9d3bd91",
  "revision": 214,
  "state": "playing",
  "playback": {
    "id": "turn-42:g3:segment-2",
    "positionMs": 840,
    "durationMs": null,
    "clockQuality": "dac",
    "caption": {
      "text": "这是正在播放的内容。",
      "cues": null
    }
  },
  "finishReason": null,
  "endedPlayback": null
}
```

字段规则：

| 字段 | 规则 |
|---|---|
| version | 固定 1，不兼容版本明确报错 |
| sourceInstance | 每次生产者进程启动生成的 opaque ID，不排序 |
| revision | 实例内安全整数递增；只在业务快照发生变化时递增，心跳重复原 revision |
| state | idle / playing / buffering / paused |
| playback | 非 idle 必须存在；idle 必须 null |
| playback.id | 对当前物理播放段唯一；跨回合、新 generation、新段必须变化 |
| positionMs | 有限非负数或 null，段内音频位置；未知时必须 null，同一播放身份的已知位置不得回退 |
| durationMs | 有限正数或 null；两者已知时 position 不超过 duration |
| clockQuality | dac / submitted_samples / estimated / unknown |
| caption.text | 实际送入 TTS 的清洗后对白，不是模型原文，不包含心理活动或代码 |
| caption.cues | null 或完整 cue 数组；streaming 尚无完整对齐时为 null |
| finishReason | null / completed / interrupted / failed；仅 idle 携带终止原因 |
| endedPlayback | 刚刚终止的播放段身份和 caption 快照；取消/失败可为 null，绝不是历史字幕 |

cue 用 `{ charStart, charEnd, startMs, endMs }`，字符偏移为 Unicode grapheme 索引；在文本范围内、时间合法、按时间和文本顺序排列、不重叠。跨语言不用 JavaScript UTF-16 length 对照 Python codepoint length。

状态转换和字幕内容变化立即发布；其余位置更新最多每 50ms 一次。无位置变化时每 1000ms 发完整心跳，包括 idle/paused。语音活动不能依赖是否有订阅者。

全局快照必须从播放器当前所有者派生，而不是从“最后一条任务事件”派生：取消排队中的另一个 trace 不能清空仍在播放的对白，模型 turn_end 不能提前结束正在响的声音。`PlaybackSnapshot` 必须由播放器在同一个锁或原子投影边界内一次生成，不能分别读取 `playback.id`、位置、状态和 caption，否则会得到跨段混合快照。

`playback.id` 由播放器在物理播放段被接受为当前段时生成或绑定；合成任务创建、文本切句和排队都不能提前创建它。这样不会把“计划播放”误报为“正在播放”。

初始快照和订阅注册必须在同一一致性边界完成；更新发生在两者之间也不能丢失。每个订阅者保留最新快照，不积累历史进度。订阅者慢或断开不阻塞音频；资源关闭必须唤醒读取方。

现有 `/v1/tts/events` 仍服务当前消费者，不在本项目中改成另一种 wire shape。本项目不提供旧 OBS POST 兼容层。需要调整 TTS 时只增加通用观察投影，不引入字幕服务地址或启动依赖。

### 7.2 源连接恢复与排序

字幕服务每次连接尝试拥有本地递增 connectionGeneration；关闭连接即使 generation 失效。所有回调检查自己的 generation。

第一帧完整快照绑定 sourceInstance；同一连接后续帧必须匹配实例且 revision 不回退。实例变化要求重连重新 bootstrap，不能按实例字符串大小接受。重复或旧 revision 不修改状态、不续期。连接层 generation 只用于让旧异步回调失效，不进入 `PresentationController`。

新连接第一帧采用生产者当前实例与当前完整状态，取消旧待显示帧和旧终止停留；idle bootstrap 不根据 `endedPlayback` 重新播放结束停留；旧连接迟到的帧不得覆盖它。源地址变更也使用这套失效规则。

因为 SSE 自带完整 bootstrap，不增加“先 HTTP 获取、再订阅”路径，不依赖 Last-Event-ID 或事件历史恢复。生产者协议不满足要求时明确提示“需要升级字幕接口”，不回退到猜测模式。心跳只是重复当前 envelope 以证明连接仍活着，不改变业务 revision、playback、hold 或 suppression，也不能重新触发终止停留。

### 7.3 字幕服务 → OBS 页面

```text
WS /ws/subtitles
GET /api/state
```

WebSocket 第一帧也是完整状态。展示投影包含：

```json
{
  "version": 1,
  "serviceInstance": "80c5beb4-cd91-419c-a4b2-0a936b3b9c84",
  "revision": 108,
  "source": { "status": "connected", "clockQuality": "dac" },
  "presentation": {
    "enabled": true,
    "state": "visible",
    "playbackId": "turn-42:g3:segment-2",
    "text": "这是正在播放的内容。",
    "highlightEnd": null,
    "scrollProgress": null,
    "holdRemainingMs": null
  },
  "settingsRevision": 7,
  "settings": {
    "fontSize": 48,
    "preset": "outline",
    "delayMs": 0
  }
}
```

presentation.state 为 visible / holding / hidden，source.status 为 connecting / connected / disconnected / incompatible。scrollProgress 为播放器已知 positionMs/durationMs 的 [0,1] 比值，未知时 null；仅供超长文本的布局退化，浏览器不自行推进它。完整 settings 实际包含本规格中的全部样式配置，此处只展示部分字段。

`PresentationSnapshot` 本身不携带 `serviceInstance`、输出 `revision` 或浏览器 connection generation；这些只存在于服务到浏览器的 envelope 与浏览器连接实现中。Renderer 只接收已经通过版本检查的投影，执行 connect、bootstrap、accept、render 和 stale/disconnect clear，不重新推导 holding、播放转换、延迟或高亮进度。

生产者的播放状态、来源连接状态、展示开关是不同事实，不合并成一个 degraded 状态机。关闭字幕不代表声音停了；源断开不代表音频自然播完。

服务 projection revision 在字幕、连接、停留结束、设置改变或开关变化时递增。输出每 1000ms 一个心跳，心跳可复用 revision，只表示服务连接仍活跃，不续期上游状态。

浏览器每次重连拥有自己的连接 generation，接受新 WebSocket bootstrap 时绑定 serviceInstance，再检查实例内 revision。初次 HTTP 获取只在尚未接受 WS bootstrap 时生效；bootstrap 后取消或忽略所有该次 HTTP 结果。服务重启不比较 UUID，旧页面请求和旧 WS 回调通过 generation 隔离。

## 8. 完成、打断、断线与过期

| 场景 | 音频权威事实 | 字幕行为 |
|---|---|---|
| 文本生成、音频尚未播放 | 不构成开始 | Overlay 保持空白 |
| 新物理段开始 | 新 playback.id | 立即替换当前句 |
| 正常完成 | idle + completed | 当前句停留 1200ms，随后清空 |
| 下一句已经开始 | playing + 新 id | 不等待旧句停留 |
| 重缓冲 | buffering + 原位置 | 保留文本，停止高亮推进 |
| 暂停（生产者支持时） | paused + 原位置 | 同上；页面不提供 TTS 暂停命令 |
| 取消或失败 | idle + interrupted/failed | 立即清空，不补完 |
| 源 SSE 明确关闭/错误 | 源连接失效 | 立即清空，页面说明原因并重连 |
| 源没有数据 | 3000ms 无有效快照 | 过期清空，断开连接并重连 |
| OBS WS 明确关闭/错误 | 展示通道失效 | 页面立即清空，不重放旧字幕 |
| OBS WS 无数据 | 3000ms 无帧 | 页面清空并重连 |
| 源或服务重启 | 新连接 bootstrap | 只显示当下完整状态 |
| 切场景后页面重建 | 新 OBS 连接 | 恢复当前句，不重播整段历史 |

续期使用各进程自己的单调时钟，不使用跨进程 expiresAtMs 或电脑墙钟排序。系统时间调整不影响播放、停留与过期。

终止转换以 `sourceInstance`、`endedPlayback.id` 和 `finishReason` 识别，不能仅凭心跳 revision 增加判断又结束了一次。正常完成停留的截止时间由服务首次观察该终止转换确定；重复心跳不能延长停留。新客户端按剩余时间接收 holding，不能重新开始 1200ms。

重连间隔为 500ms、1s、2s、4s，之后最多 8s，附少量 jitter；有效 bootstrap 后归零。一直重试直到停止或用户修改来源，不因重试次数用尽永久放弃。

## 9. OBS 音画校准

字幕实际需要对齐 OBS 录制/直播中的音轨。扬声器播放位置准确也不保证虚拟声卡、OBS 捕获和滤镜后的时间一致。

第一版提供“字幕延迟”0～2000ms，默认 0。正数表示晚显示字幕；不提供负值，因为没有未来已确认播放状态时不能保证提前显示正确。

校准流程：播放用户明确发起的短测试对白，录制 OBS 中的声音和字幕，确认哪个先到；字幕偏早则增加字幕延迟，声音偏早则调整用户现有音频路由或 OBS 音频延迟。保存后给出当前校准值，设置页不把 0 当成已校准。

延迟使用服务单调时钟，在服务内部调度完整展示帧：

- 只在启用 delayMs 时使用有界时间窗口。窗口保存不可合并的离散转换（如 `playing A`、`buffering A`、`completed A`、`playing B`），连续位置更新只保留延迟窗口所需的最新值；资源上限是保护措施，不是业务语义。
- delayMs<=2000，源采样最多20Hz，窗口最多保存 96 个采样或转换项；超限不得丢掉尚未显示的离散终态后继续假装同步，而是清空窗口并报告“延迟调度过载”，等待新当前状态重新建立。
- 显式取消、失败、关闭字幕、清空和任何断线立刻取消所有待显示帧。
- 源连接重建也清空旧窗口；恢复当下状态即可，不回放断线期间的短句。
- 这与网络订阅的 latest-only 背压不同；默认 delayMs=0 时不保存这条时间窗口。

延迟会增加字幕显示时间，验收数字应区分系统传输延迟与用户设定的校准延迟，不能混成“字幕同步误差”。

## 10. HTTP、配置与独立实现

服务默认 `127.0.0.1:18140`，与旧 8104 服务及点歌机 HUD 分开。语音来源默认 8102，可编辑；旧 obs_bridge 不需要退出才能预览新服务。

| 接口 | 用途 |
|---|---|
| GET / | 设置与预览页 |
| GET /overlay/ | OBS 透明画面 |
| GET /health | 进程状态与来源能力、连接诊断 |
| GET /api/state | 完整展示投影 |
| GET /api/settings | 持久化设置 |
| PUT /api/settings | 校验、保存并应用全部设置 |
| POST /api/presentation/clear | 清空当前展示，不停止音频 |
| WS /ws/subtitles | 完整展示状态与心跳 |

API 不提供“已被 OBS 渲染”的成功标记。WebSocket 连接数只代表页面连接数，普通预览页面也是客户端；设置页将角色登记为 preview，Overlay 登记为 overlay，仍只标为“Overlay 页面数”，不能由此推断正在直播。

配置只使用一份 JSON，不混用 TOML、环境变量、URL 参数和 CSS 四种持久化来源。命令行只覆盖启动参数 host/port/data-dir，覆盖项在页面可见，不悄悄写回设置。Overlay URL 保持固定，不需要每次改字号重新粘贴 URL。

非法配置在启动时明确报错并保留文件；首次运行不存在配置才使用默认值。只持久化源地址和呈现设置，不保存字幕正文、播放身份、源连接或实例 revision。

输入限制：HTTP/SSE 单消息64KiB、正文最多2048 grapheme、cues最多2048，数值必须有限。超长实际对白明确报告不支持；不截短后宣称原句完整。cue 非法时该段退化为整段并报告对齐不可用；基本结构非法时拒绝快照并不续期。

默认 loopback，设置写操作要求本机 Host 与同源 Origin，不启用 CORS；静态资源使用固定路由映射；用户文本只用 textContent 和安全 span，CSS 设置采用类型化值，不接受任意 HTML 或 CSS 注入。第一版不承诺公网部署安全。

实现建议：Node.js 22+、TypeScript、标准 HTTP、成熟 ws 库、原生 HTML/CSS/JS；配置与协议校验为集中纯函数，不引入 React、数据库、DI 容器或插件框架。独立 package 拥有 start/build/typecheck/test/check:overlay 脚本。服务与音频回调都不运行每帧网络请求。

拟定代码结构：

```text
realtime-subtitles/
  src/
    main.ts          启动、配置、退出
    source.ts        SourceConnection：SSE bootstrap、校验、单调排序、重连
    state.ts         PresentationController：呈现状态、结束停留、清空、延迟窗口
    server.ts        HTTP、WS、同源检查、慢连接处理
    protocol.ts      两条 wire schema 与纯校验
  web/
    overlay.html
    control.html
    renderer.js      两页面共享的布局与高亮
    connection.js    页面 bootstrap 与版本检查
    styles.css
  tests/
  data/              本地配置，Git 忽略
  package.json
  start.cmd
  README.md
```

按职责分文件，不为每个状态或动作再创建一个 manager。ws 慢连接只保留最新待发投影；写缓冲超过64KiB则关闭该客户端，让它重新 bootstrap。一个消费者不得拖住其他消费者。

## 11. 可观察性与失败恢复

健康响应分别包含 process.ready、source.status、source.protocolVersion、source.ageMs、clockQuality、overlayConnections、invalidSnapshots、staleSnapshots、reconnects。服务已运行但源不可用时 HTTP 仍可用，process.ready=true、source.connected=false；不把两者合并成 healthy=true。

页面故障文案与动作：

| 现象 | 文案 | 可做的事 |
|---|---|---|
| 源地址不通 | 语音服务未连接 | 修改地址 / 立即重连 |
| 健康可用、快照接口不支持 | 语音服务需要升级字幕接口 | 查看协议要求 |
| 无词级时间标记 | 使用整段字幕 | 无需处理 |
| 时钟 unknown | 播放时间不可确认，已关闭高亮 | 查看来源诊断 |
| 没有 Overlay 页面 | 尚未连接 OBS 字幕页面 | 复制地址 |
| 配置保存失败 | 设置未保存 | 查看错误 / 重试 |
| 字幕暂停显示 | 字幕已关闭，声音继续播放 | 开启字幕 |

只记连接、身份、状态转换与错误类别，默认不记录正文或源音频。诊断保留内存最近50条，避免持续重连刷屏；连接恢复记录一次，不为每个位置更新写日志。

停止服务时 abort SSE/重连、取消展示计时器/窗口、关闭 WS、关闭 HTTP并等待句柄释放；重复停止幂等。测试进程停止只能影响测试自身，不能关闭用户的 TTS、OBS 或 Uina。

## 12. 实施顺序与证明边界

这是一份设计规格，以下是实施先后关系，不是逐文件 TDD 施工计划：

1. 先完成独立服务与可控协议生产者，证明版本、断线、停留、清空、预览与 Overlay 使用同一规则。
2. 给当前 TTS Bridge 增加全局物理播放快照接缝，保留原有消费者接口；补齐输出时钟及尾部完成语义。
3. 接入真实播放，在 OBS 录制中校准，不把假生产者测试当成音画验收。
4. 完成设置持久化、长文本与竖屏视觉验收、单独启动和重启验收。
5. 只有来源实际提供 cues 时，验收高亮精度；无 cues 的引擎按整段模式交付，不额外引入模型。

Uina 仓库只需承担 TTS Bridge 接缝变化和相关测试；独立服务有自己的提交与测试。不开启 World 高频事件，不修改 Pi、真实 Provider、账号或会话。

## 13. 验收清单

### 自动验证

- 源连接第一帧能恢复进行中的播放、paused、idle；idle bootstrap 不重新展示历史 `endedPlayback`，只有本连接实际观察到完成转换才开始停留；bootstrap 与注册之间没有丢失更新。
- UUID 不作时间排序；旧连接、旧 revision、旧播放观察器均不能覆盖当前状态。
- 取消排队 trace 不清空其他正在播放的 trace。
- cue Unicode 索引正确，位置回退、NaN、超长正文与 malformed 输入明确处理。
- HTTP 初始响应迟到不会覆盖 WS 状态；服务重启时 revision 重置仍可恢复。
- 上下游3秒心跳失效清空；正常停留不被重复心跳续期。
- pause/buffering 高亮冻结；cancel/failure不补完、迟到消息不复活。
- 清空同一句后心跳不复活，下一句可显示；字幕关闭与恢复不操作音频。
- 开启校准延迟后短句不被后一句吃掉，取消会清空所有定时帧。
- 慢页面、重连与长时间闲置不存在无限队列、持续 RAF 空跑和资源泄漏。
- 设置原子保存、损坏文件保留、HTML文本安全渲染。
- 独立服务运行 typecheck、test、build、check:overlay；TTS 修改在当前 Uina 运行对应 Python测试与必要 TS回归，完整门禁结果单独报告。

### 真正 OBS 与音频验收

在实际 OBS Browser Source 与实际捕获音轨录制下验证；普通浏览器只能证明页面行为。

- 横屏1280×720/1920×1080、竖屏720×1280与窄字幕条，换句不跳版、中文英文混排不越界、emoji不拆。
- 50次正常短句的开始对齐：在已校准路径、delayMs=0下，录制测得绝对误差 P95<=150ms；未满足记录设备、时钟质量与音频路径，不称为通过。
- 网络/展示传输延迟以音频生产者确认段开始到浏览器接收首帧计，P95<=100ms；这个指标不等于实际声音误差。
- 自然结束保留1200ms；下一句及时覆盖；打断没有尾句补齐。
- OBS断开30秒、切场景、关闭页面、服务重启、TTS重启均能恢复当前句，没有断线历史重播。
- 有真实暂停能力的播放器测试暂停3秒不推进；当前 TTS 不支持时，模拟测试仅证明协议，不报告真实暂停已实现。
- 字幕服务/Overlay故障时TTS音频继续；对照录制中不得新增可归因于字幕的音频 underrun。
- 持续播报30分钟确认队列有界、连接数量回落、内存不随句数线性增长。
- cue 精度另按提供方与录制样例验收，不从段落同步的通过推导逐词准确。

Browser Source 支持按配置在隐藏时卸载页面，或场景激活时刷新。因此默认建议关闭这两项以减少无谓重建，但两项开启也必须通过恢复测试；恢复依赖 bootstrap，不依赖网页一直存活。[OBS 官方说明](https://obsproject.com/kb/browser-source)

## 14. 最终边界

一个独立进程只做语音事实的字幕呈现：生产者拥有声音，服务拥有展示状态，OBS 页面拥有绘制。第一版的实际价值是“能直接用、断了会恢复、显示可信”，不以时间标记、复杂动画或架构层数作为完成标准。

这份规格替代本次讨论中沿用旧 Uina_Core 目录、按实例时间排序、TTS向OBS同步POST及估算打字机的建议。实现前应以本文件为设计审阅对象，后续施工计划再拆出具体测试与改动；不会凭这份文档宣称新服务已经实现。
