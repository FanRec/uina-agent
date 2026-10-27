# Uina 点歌 World 与直播 HUD 设计

状态：Implemented incrementally

日期：2026-09-29

阅读约定：本文把内容分为三类。`当前事实`来自现有源码或已检查的旧版实现；`目标`是本设计要实现的行为；`假设`尚未由真实 api-enhanced、mpv、OBS 或生产负载验证，不能当作已完成能力。

实现状态（2026-09-30）：P0 播放、队列、HUD Companion、快照发布和基础 P1 播放模式已经接入；账号库 Gateway、偏好持久化和队列历史已接入代码。真实网易云账号写操作、mpv 自动切歌和 OBS 生产验证仍需现场验收。

2026-10-14 复核：World、播放协调器、队列/模式、library、HUD client 与两个局部 Companion manager 均在当前实现中；测试路径存在但本轮未运行。真实账号、mpv 和 OBS 仍未验收。频谱来源当前只有 `audio | silent`，文中 `synthetic` 选项已不属于当前合同。

## 1. 目标与范围

把 `E:\Uina_Core\extensions\external_adapters\netease_jukebox` 迁移到当前 Uina，保留旧版 OBS Overlay 的 HTML、JavaScript 和 CSS 作为显示资产；重新接入当前 World 运行时和 `E:\Uina\ThirdParty` 中的外部伴生服务。HUD 不属于 Uina Extension，而是可被 Uina 管理、也可独立运行的 Companion。

第一阶段需要形成一条可运行的纵向切片：

```text
Uina World action -> 网易云 API -> 播放器 -> 唯一播放快照
                                      -> broadcast-hud Companion -> OBS Overlay
```

需要支持：

- 搜索、直接播放、暂停、继续、停止、上一首、下一首；
- 播放队列和队列上限；
- 播放模式：单曲一次、队列顺序、列表顺序、列表循环、单曲循环、随机；
- 播放进度、当前歌词、歌词窗口、音量和错误状态；
- 搜索结果、歌单、登录账号相关的网易云操作；
- Overlay 的 dashboard、now-playing、progress、lyrics、queue、wave 路由；
- 为未来的 Uina 演唱 World 保留同形状的 HUD 状态源。

明确不做：Core/Session 音乐特判、自动把播放状态写入会话主线、远程暴露本地桥、把 OBS 页面变成播放器控制面板、第一阶段实现通用媒体平台或音频混音器。

## 2. 当前现实

### 2.1 旧版 ExternalAdapter 已实现的能力

旧版入口为 `E:\Uina_Core\extensions\external_adapters\netease_jukebox\src\main.ts`，主要模块如下：

| 模块 | 事实 |
|---|---|
| `api-client.ts` | 通过 loopback `api-enhanced` HTTP 访问搜索、歌单、歌曲详情、播放 URL、歌词、推荐、账号库、评论和歌单写操作；播放 URL 支持主路径和 302 备选；带超时、重试和 cookie 文件/显式 cookie。 |
| `playback-service.ts` | 自己拥有播放状态机、队列、播放历史、播放模式、进度轮询、歌词窗口、随机上下文和播放器错误状态。网易云 API 不被当作播放器。 |
| `mpv-player.ts` | 通过 mpv IPC 管理真实播放、暂停、停止、seek、音量和结束事件。 |
| `schemas.ts` | 以 Zod 定义 `MusicTrack`、`MusicPlaylist`、`QueueItem`、歌词、播放状态、播放模式和配置。歌曲 ID 使用 `nt:<id>`，歌单 ID 使用 `ntp:<id>`。 |
| `netease-jukebox-adapter.ts` | 维护搜索/歌单/发现/账号视图状态，执行 Action，产生 `music_status` 状态快照，并把失败区分为拒绝、不可用或成功。 |
| `desktop-bridge.ts` | 只监听 loopback；提供 HTTP 静态页和状态快照，WebSocket 首次发送快照并广播后续状态。 |
| `overlay-state.ts` | 把完整播放状态投影为 Overlay 专用 schema，包含播放、歌词、队列、频谱和布局。 |
| `spectrum-analyzer.ts` | 可选 FFmpeg PCM 分析；当前只报告 `audio` 或 `silent` 来源，不合成伪频谱。 |

旧版公开动作覆盖：`search`、`play`、`add_to_queue`、`pause`、`resume`、`stop`、`next`、`previous`、`set_play_mode`、`set_volume`、`adjust_volume`，以及打开歌单、发现歌曲/歌单、我的/创建/订阅歌单、喜欢/取消喜欢、评论、创建/修改/订阅/取消订阅歌单等账号操作。账号写操作要求登录并声明确认要求。

旧版 Overlay 路由为：

```text
/overlay/dashboard
/overlay/now-playing
/overlay/progress
/overlay/lyrics
/overlay/queue
/overlay/wave
```

Overlay 首次 `GET /overlay/state?view=...`，随后连接 `/ws/music` 接收 `{ type: "overlay_state", state }`。页面只渲染状态，不应取得 cookie、播放 URL 或原始 API 响应。

### 2.2 当前 Uina 的事实

当前已有 `.uina/worlds/netease-jukebox` World，包含：

- `NeteaseApiClient`：搜索、歌曲详情、播放 URL、歌词；
- `MpvPlayer`、模拟播放器和不可用播放器；
- `PlaybackSession`：串行播放操作、取消旧加载、当前歌曲和错误；
- `lyrics.ts`：普通 LRC 解析和当前歌词查询；
- World actions：`play`、`pause`、`resume`、`stop`、`volume`、`search`、`lyrics`、`current_lyrics`、`status`；
- `CompanionManager`：按需检测/启动本地 `api-enhanced`。

当前 World 尚无队列、播放模式、上一首/下一首、状态推送、Overlay bridge、账号库和歌单动作。

World framework 已提供 `onStart/onStop`、`worldDataDir`、`emitEvent`、`expose`、`callService` 和 `onHostEvent`。World 启停由 `WorldRegistry` 管理，停用时会关闭其 `ResourceScope` 并执行 `onStop`。`host/`、`agent/`、`session/` 不应知道音乐业务。

当前 `E:\Uina\ThirdParty` 已存在 `api-enhanced` 和 `gpt_sovits_v2pro`。它是外部项目与伴生服务的实际归属位置，不是 Uina Extension 扫描目录。`api-enhanced` 是网易云数据源，`broadcast-hud` 应与它同级：`E:\Uina\ThirdParty\broadcast-hud`。

## 3. 架构决定

### 3.1 归属

采用“Uina World + `ThirdParty/broadcast-hud` Companion”的两层结构。`broadcast-hud` 是独立进程，不进入 Uina Extension 扫描，也不承担音乐业务：

```text
netease-jukebox World
  ├─ Netease API client
  ├─ PlaybackCoordinator + mpv
  ├─ queue / lyrics / account state
  ├─ World actions
  └─ BroadcastHudClient -> localhost `/state`

ThirdParty/broadcast-hud Companion
  ├─ 接收版本化快照（HTTP ingest）
  ├─ loopback HTTP + WebSocket bridge
  ├─ 提供复制的 overlay/ 静态资源
  └─ 只展示快照，不执行播放动作
```

这样做的理由：

1. 播放器和网易云业务属于 World；Overlay 是独立消费者，不应成为播放前置条件。
2. HUD 可以脱离 Uina 启动、测试和服务 OBS；Uina 只提供一个很薄的发布适配器。
3. 点歌 World 和未来演唱 World 都可以向同一个 Companion 发布快照，不互相依赖。
4. Core、Session、Provider 和 UI 不增加音乐概念。

第一阶段只接收网易云 source；第二个真实音频源出现前，Companion 不实现源混合、自动切换或音频路由。

### 3.2 `BroadcastHudClient` 最小契约

第一阶段不新增 npm/workspace 协议包。Uina World 内定义最小类型和 `BroadcastHudClient`，Companion 端复制并校验同一 JSON schema；等第二个真实 producer 出现后，再考虑抽取协议包。协议不放进 Core，也不使用 `WorldExposedRegistry`。World 只发布不可变快照，不把播放控制交给 HUD：

```ts
interface BroadcastHudClient {
  publish(snapshot: BroadcastHudSnapshot): Promise<PublishResult>;
}

interface PublishResult {
  accepted: boolean;
  reason?: "disabled" | "unavailable" | "stale" | "invalid";
}
```

`BroadcastHudSnapshot` 使用 Overlay 所需的稳定数据，不包含控制函数、cookie、URL 或原始响应：

```ts
interface BroadcastHudSnapshot {
  version: 1;
  sourceInstance: string;
  revision: number;
  updatedAt: string;
  source: { id: string; kind: "music"; label: string };
  connection: { status: "connected" | "degraded" | "disconnected"; lastError: string | null };
  playback: {
    status: "idle" | "loading" | "playing" | "paused" | "stopped" | "error";
    playMode: string;
    volumePercent: number;
    currentTrack: { id: string; name: string; artists: string[]; albumName: string | null; durationMs: number | null } | null;
    positionMs: number;
    durationMs: number | null;
  };
  lyrics: { previous: string | null; current: string | null; next: string | null };
  queue: { items: Array<{ id: string; name: string; artists: string[]; albumName: string | null; durationMs: number | null }>; total: number };
  spectrum: { source: "audio" | "silent"; bands: number[]; energy: number; beat: number };
}
```

该协议是播放事实的显示投影，不是新的权威状态。布局、主题、视图和显示开关属于 Companion 本地配置，不由 World 快照决定。第一阶段只有 `music` source；演唱 source 真实出现时再扩展 schema。`sourceInstance` 标识一次 World 运行实例，`revision` 只在该实例内每次发布递增；Companion 对每个 `source.id` 只保留最新实例，再在该实例内按 revision 丢弃旧快照。World 重启必须生成新的 `sourceInstance`，不能复用旧实例的 revision。

### 3.3 模块分工与唯一事实

迁移不复制旧版约 1200 行 adapter 的形状。当前 Uina 只增加以下深模块：

| 模块 | 公开接口 | 拥有的复杂度 |
|---|---|---|
| `JukeboxWorld` | WorldDef 生命周期和六个 action | 注册、配置、启动/停止、投影动作结果 |
| `JukeboxApplication` | 意图动作 -> 结构化结果 | ref 解析、登录/确认规则、错误语义、catalog/playback 编排 |
| `PlaybackCoordinator` | 命令、不可变快照、订阅 | 播放器事实、队列、历史、播放模式、取消代数、进度和歌词窗口 |
| `NeteaseGateway` | 归一化的歌曲/歌单/账号读写 | loopback 校验、HTTP 重试、响应归一化、登录/VIP/不可播放分类 |
| `BroadcastHudClient` | 版本化快照发布、连接重试、停止收束 | 不拥有播放状态，不决定显示内容 |
| `broadcast-hud` | 快照接收、HTTP/WS、stale 处理 | 仅展示状态、慢客户端丢旧快照、静态文件服务 |

`index.ts` 只做装配和 action 注册，不直接解析网易云响应、不决定队列转移、不拼接播放成功文案。`PlaybackCoordinator` 是播放事实唯一拥有者；World `status`、HUD 和未来演唱适配都从同一个快照读取。频谱分析、账号库和搜索结果不塞进 PlaybackCoordinator。

当前只有一个真实播放源，因此不实现多源 arbitration、active lease 或自动抢焦点。`updatedAt` 只用于展示和诊断，不承担顺序。

### 3.4 Overlay 迁移规则

`E:\Uina_Core\extensions\external_adapters\netease_jukebox\overlay\index.html`、`main.js`、`style.css` 直接复制到 `E:\Uina\ThirdParty\broadcast-hud\overlay`。迁移只允许做以下适配：

- 保持现有路由和透明背景行为；
- 将页面请求地址改为 Companion bridge 的同源 `/overlay/state` 和 `/ws/music`；
- Companion 输出必须实际满足旧版 `OverlayState` 字段要求；新协议缺少的 `layout/theme` 由 Companion 本地默认配置补齐，而不是重新让 World 决定显示样式；
- 第一阶段不改变旧页面读取的播放、歌词、队列和频谱字段；新增 source 元数据只能是向后兼容字段。

不在 Overlay 中加入 API 登录、播放控制、队列修改或网易云请求。旧版 bridge 的 action 接收能力不迁移为 Overlay 的公开控制面；播放控制统一走 World action，避免 OBS 页面成为第二个副作用入口。

## 4. 数据流与生命周期

### 4.1 播放控制

```text
模型工具调用 world:jukebox/<action>
  -> WorldActivation scope 校验与取消
  -> Jukebox action
  -> PlaybackCoordinator 串行化状态变更
  -> mpv / api-enhanced 外部副作用
  -> 确认后的状态 patch
  -> BroadcastHudClient.publish(snapshot)
  -> broadcast-hud 广播 snapshot
```

开始播放时先获取歌曲详情和播放 URL，再启动 mpv；未获得 URL 时返回 `failed/unavailable`，不把“已请求播放”写成“播放中”。mpv `end-file`、错误和断开分别驱动完成、错误或停止状态。取消加载时只确认取消了内部操作，不推断外部音频已经停止，直到播放器返回事实。

### 4.2 `broadcast-hud` Companion bridge

- 只监听 `127.0.0.1`、`localhost` 或 `::1`；配置非 loopback 时启动失败并保持播放可用。
- `GET /health` 返回 bridge 状态。
- `GET /overlay/state?view=<view>` 返回当前源的完整 OverlayState。
- `GET /overlay/*` 提供白名单内静态文件，拒绝路径穿越。
- `WS /ws/music` 连接后立即发送一次状态；源状态变化或进度/歌词变化时推送。
- Companion 停止只关闭 HTTP/WS 和 ingest 连接，不停止 World 或播放器；World 自己拥有播放生命周期。
- 没有客户端连接时不做额外轮询；进度刷新由 PlaybackCoordinator 在播放中按配置周期执行，默认 500ms，Companion 只消费内存快照。
- Companion 未运行时，World 的 `BroadcastHudClient` 返回 `unavailable`，但不阻止点歌和播放。
- loopback 端口冲突只让 HUD 降级，不阻止 World 注册或播放。
- Companion 每次收到 `POST /state` 都刷新本地 `receivedAt`；默认 5 秒没有新快照就进入 `disconnected`，清除旧的 `playing` 投影。正常停止可以发送一次 `disconnected`，但不能依赖这条消息。

### 4.3 源选择与未来演唱

第一阶段 `broadcast-hud` 只接收 `jukebox` source，不实现多源仲裁。source 停止发布后，Companion 在 5 秒 stale timeout 后显示 disconnected/idle，不继续把旧的 `playing` 当作当前播放。

第二个 source 真正出现后，再设计显式的 active source 选择规则。不使用“两个 source 交替心跳就自动抢焦点”的隐式规则，避免直播画面抖动。

传输保持单向、低认知负担：producer 向 `POST /state` 发送完整快照，Companion 返回 `accepted` 或明确拒绝原因；OBS 只读 `GET /overlay/state` 和 `WS /ws/music`。Companion 不接受播放控制请求，不需要 producer 注册或双向会话。

## 5. World 能力设计

### 5.1 核心动作

动作按用户意图分组，避免把十几个网易云 endpoint 暴露成模型必须记忆的动作名。World tool 只保留六个稳定入口：

| 动作 | 语义 |
|---|---|
| `search` | 搜索歌曲、打开/浏览歌单或发现内容；结果进入当前 World 视图并产生稳定引用。 |
| `play` | 立即播放 `ref`/歌曲 ID；默认保留已有队列，显式 `replace_queue: true` 才替换。 |
| `queue` | `add`、`list`、`remove`、`clear`；只有明确调用 `queue` 才改变待播列表。 |
| `playback` | `pause`、`resume`、`stop`、`next`、`previous`、`status`、`mode`、`volume`；播放控制和音量集中在一个动作。 |
| `lyrics` | 查询完整歌词或当前歌词窗口；当前歌曲省略 `song_id`。 |
| `library` | 登录账号、喜欢、评论、歌单创建/修改/订阅等低频操作；写操作要求确认和结果验证。 |

直觉规则：说“播放/放一首”只改变当前播放；说“加到队列/接下来播放”才入队；说“停掉”不清空队列，只有 `queue clear` 或 `playback stop(clear_queue=true)` 才清空。旧版十多个动作可以在实现内部保留函数，但不作为模型接口继续扩张。

能力映射如下：

| 新动作 | 旧动作 | 是否保留 |
|---|---|---|
| `search` | `search` | 保留；仍然产生 `search:<n>` 引用。 |
| `play` | `play` | 保留；增加清晰的立即播放/替换队列语义。 |
| `queue` | `add_to_queue` | 保留并扩展 `list`、`remove`、`clear`。 |
| `playback` | `pause`、`resume`、`stop`、`next`、`previous`、`status`、`set_play_mode`、`set_volume`、`adjust_volume` | 全部保留，只改为 `operation` 参数。 |
| `lyrics` | `lyrics`、`current_lyrics` | 全部保留。 |
| `library` | `discover_songs`、`discover_playlists`、`open_playlist`、`get_my_playlists`、`get_created_playlists`、`get_subscribed_playlists`、`show_liked_songs`、`show_recent_songs`、`show_comments`、`like`、`unlike`、`create_playlist`、`add_to_playlist`、`remove_from_playlist`、`subscribe_playlist`、`unsubscribe_playlist`、`update_playlist` | 全部保留；低频账号和歌单操作集中管理。登录/二维码状态也归入此处。 |

旧版的 `show_lyrics`、`hide_lyrics`、`expand_queue`、分页和面板折叠命令不是领域能力，而是 Workspace 面板控制。新 HUD 由状态自动渲染这些区域；若以后 TUI 需要折叠，只应做 UI 本地命令，不进入模型动作。

模型可见的结果也遵循固定句式：成功说明“已完成什么 + 当前事实”；失败说明“没有完成什么 + 原因 + 可执行的下一步”；外部结果未确认时使用 `unknown`，不使用“应该已经播放”。搜索和歌单结果始终返回可引用的 `ref`，播放只接受当前视图中的 `ref` 或明确歌曲 ID，避免模型凭空编造网易云 ID。

### 5.2 网易云数据动作

`search` 和 `library` 内部迁移旧版的打开歌单、发现歌曲/歌单、我的/创建/订阅歌单、喜欢/取消喜欢、评论、创建/修改/添加/移除/订阅歌单。动作分两类：

- 读操作：登录未知时可以返回公开数据；账号专属结果明确为 `login_required`。
- 写操作：必须确认登录身份、目标资源可编辑性和 API 返回结果；未经验证不能返回成功。

所有结果采用当前 World action 的 `string | ToolExecutionResult` 合同，失败、取消和未确认状态不能以普通成功文本替代。

当前没有独立的网易云“列表游标”状态；`list_order` 与 `list_loop` 把当前队列视为列表执行，因此它们不会凭空声称支持跨列表恢复。歌单读取与入队是两件事：`library playlist_open` 用 `offset`/`limit` 直接分页读歌单，不必先进队列；`queue add playlist_id` 才把歌单曲目搬进队列。

### 5.3 持久化

使用 `ctx.worldDataDir` 保存：

- `preferences.json`：播放模式、音量、配置版本；
- 可选的有限歌词缓存或最近查询缓存。

播放队列、播放历史和当前曲目默认是运行态，不跨重启恢复。第一阶段不宣称跨重启音频恰好一次恢复；如果以后需要恢复，必须单独定义“外部播放器未知结果”对账，不从进程退出推断播放成功。

## 6. 错误、降级和容量

- `api-enhanced` 不可用：搜索/详情/歌词返回明确不可用；已在本地播放的歌曲可继续到播放器事实终止。
- mpv 不存在：World 可在 simulation 模式运行测试，但生产状态为 unavailable，不伪造声音输出。
- 歌曲无 URL：记录 `unavailableReason`，不进入 playing。
- 歌词缺失或解析失败：播放继续，歌词字段为 null，并保留可读错误诊断。
- FFmpeg 不可用：频谱来源为 `silent`；当前实现不生成 `synthetic` 频谱。
- bridge 端口冲突：bridge 状态为 error，World 播放和工具仍可用。
- WebSocket 客户端慢：只发送最新快照，不为 OBS 建立无限队列。
- 队列上限默认 100，可配置但必须有限。单曲入队超限拒绝；整张歌单入队时能放多少放多少，并在结果里说明有多少首没进——部分入队仍返回 `succeeded`，用 `failed` 会被当成硬错误重试，在不去重的前提下等于重复入队。
- 歌单读结果必须投影与分页：上游一次返回 232 首约 565 KB（每首 50 余字段，另有 `privileges` 版权对象），模型只需要曲目名、歌手、时长。投影后单首约 143 字节，一页 50 首约 8 KB。结构化事实不截断——截断后的 JSON 是坏对象，比不给更糟。曲目投影对搜索、详情、批量详情与歌单共用一份，不各写一套键名猜测。
- `limit` 的上限按"条目是否已投影"分开：`playlist_open`/`liked_list` 到 200；`recent_list`/`comments_list` 尚未投影（一条评论约 0.8 KB、一条最近播放约 1.5 KB），到 20，且没有分页兜底。放宽这个数字等于放宽一次工具结果的上限，必须先有投影。
- 所有长 IO 透传 `ActionContext.signal`；World 停止通过 scope signal 取消未完成请求和 bridge 订阅。

### 6.1 配置与默认行为

配置必须从 World 数据目录和显式配置得到，不再把 `E:\Uina\...` 之类的机器路径硬编码进实现。`ThirdParty` 是默认安装根，但路径必须可覆盖。默认值以“能解释、不会偷偷产生副作用”为准：

| 配置 | 默认 | 说明 |
|---|---|---|
| `api.mode` | `external` | 使用已运行的 loopback `api-enhanced`；`managed` 才允许 World 拉起指定目录的子进程；`simulation` 只用于测试。 |
| `api.baseUrl` | `http://127.0.0.1:3000` | 只允许 loopback HTTP。 |
| `player` | `mpv` | 找不到 mpv 时明确 unavailable；不自动切到静音模拟。 |
| `queueLimit` | `100` | 有限且可观察。单曲入队超限拒绝；整张歌单入队时截到上限并如实报告未加入的数量。 |
| `broadcastHud.mode` | `manual` | `disabled` 不连接；`manual` 只连接已有 Companion；`auto` 不存在时由 World 启动。 |
| `broadcastHud.dir` | `E:\Uina\ThirdParty\broadcast-hud` | Companion 安装目录，可配置覆盖。 |
| `broadcastHud.port` | `18130` | 只监听 loopback，端口冲突只影响 HUD。 |

模型不需要知道这些配置。`status` 只报告当前可用性和下一步，不暴露 cookie、进程参数或本地文件细节。

### 6.2 Companion 启动所有权

`broadcast-hud` 有独立入口、自己的 package/runtime、`/health` 和自己的测试。World 通过 `BroadcastHudCompanionManager` 管理连接：

```text
mode=disabled -> 不连接、不启动
mode=manual   -> 只连接 localhost:18130，失败则 HUD unavailable
mode=auto     -> 先连接；不可用时从 ThirdParty/broadcast-hud 启动；等待 /health
```

只有 `auto` 模式下由当前 World 成功启动的子进程才由它在 `onStop` 时停止；已由用户或其他进程启动的 Companion 不被误杀。World 停止时先停止 `BroadcastHudClient`，再停止自己拥有的 Companion。Companion 崩溃、端口冲突或 Overlay 无 OBS 客户端都不能影响播放器。

`api-enhanced` 遵循同一规则，但与 HUD 分开配置和管理：它是网易云数据源，播放/搜索依赖它；`broadcast-hud` 只是显示消费者，永远不是播放前置条件。

## 7. 实施阶段

### P0：迁移最小纵向切片

P0 不同时完成所有队列、账号和频谱能力，拆成三个可验收切片：

**P0-A：播放事实。** 将当前 `PlaybackSession` 收窄为 `PlaybackCoordinator`，先支持 simulation player 下的 `search -> play -> state`，集中当前曲目、最小队列、进度和错误事实。

**P0-B：显示消费者。** 复制 Overlay，建立 Companion 的静态资源、`/health`、`GET /overlay/state` 和 WS；用固定 sample snapshot 验证旧页面字段兼容。此时不要求自动启动。

**P0-C：单向接线。** 加入 `BroadcastHudClient`，把 P0-A 的快照发布到 P0-B；完成 `search -> play -> snapshot -> Companion -> Overlay`。HUD 不可用时播放仍可用。

`NeteaseGateway`、完整播放模式、账号库和 `auto` Companion 启动已进入实现；真实账号、mpv 和 OBS 仍按验证计划验收。

### P1：操作完整性

1. 完成 `queue` 与 `playback` 的全部操作、播放模式和持久化偏好。
2. 增加歌单/发现/账号读操作。
3. 增加账号写操作和结果验证。
4. 增加歌词窗口、进度和可选频谱分析。

### P2：未来演唱接缝

1. 演唱 World 使用同一 `BroadcastHudClient` 发布第二个 source。
2. `broadcast-hud` 增加显式 source 选择状态。
3. 为 singing source 增加最小测试，不修改 Overlay 的基础布局。

P2 之前不添加通用媒体混音、媒体资产库、独立数据库或跨进程消息总线。

## 8. 验证计划

### 静态与单元

- `pnpm typecheck`：World/扩展边界、Overlay contract 和现有边界检查；
- `pnpm test`：API 归一化、播放模式、队列上限、歌词窗口、取消和 `BroadcastHudSnapshot` schema；
- Companion `/health`、快照接收、loopback 校验、WS 初始快照和断开清理测试；
- World 停用后不再执行新动作、不再广播状态。
- Companion source stale、revision 单调性和慢客户端只保留最新快照。

### 组合测试

- simulation player 下运行 `search -> play -> add_to_queue -> next -> stop`；
- 在没有消费者时 World 仍能播放并更新状态；
- Companion 先启动或后启动都能接收 World 快照；World 停止后 source 变为 disconnected；
- Companion 无法监听或无法启动时播放动作仍可运行。

### 真实依赖验证

- 隔离配置启动本地 `api-enhanced`，验证搜索、歌曲详情、播放 URL、歌词和登录状态；
- 安装 mpv 时验证真实 IPC 的播放、暂停、结束和错误；
- OBS Browser Source 连接真实 loopback URL，确认透明背景、六个路由、歌词/队列/进度更新；
- 若启用 FFmpeg，确认 Overlay 标记 `source: "audio"`；否则只接受 `silent` 事实。

每项结果必须标为代码实现、模拟测试或真实依赖验证。历史日志和 mock 不足以证明真实网易云、mpv 或 OBS 工作。

## 9. 取舍与删除标准

保留的抽象只有三个稳定 seam：`PlaybackCoordinator`、`NeteaseGateway`、`BroadcastHudClient`。若未来没有第二个音频源，不增加 source arbitration，也不把 snapshot 协议扩展成媒体平台。

出现以下情况时删除或收窄复杂度：

- 第二个源没有真实需求：不实现源混合和自动编排；
- OBS 只需要一个页面：保留 dashboard，路由仍可由 Overlay 兼容但不增加更多组件；
- 频谱分析造成明显 CPU/IO 负担：默认关闭 analyzer，保留 `silent` 状态；
- 账号写操作没有稳定 API 验证：暂时只提供读操作，不能伪造成功。

## 10. 最终决策

实现方向为：**网易云是一个 Uina World；World 内部的 `PlaybackCoordinator` 是唯一播放事实拥有者；`E:\Uina\ThirdParty\broadcast-hud` 是独立 Companion，由 World 通过 `BroadcastHudClient` 可选地自动拉起或连接；未来演唱 World 复用同一快照协议。**

原 P0-A/P0-B/C 阶段清单是迁移前计划，不是当前待办。已存在的 Companion 代码与模拟测试不证明真实 `broadcast-hud` 发布、网易云账号写操作、mpv 自动切歌或 OBS 生产链通过。六个意图动作“降低模型负担”仍是待验证假设；若大型 `operation` schema 造成误调用，应按实际证据调整。Core、Session、Provider 和 UI 不需要为点歌机增加专用接口。
