# Uina 点歌 World 与直播 HUD 设计

状态：Proposal

日期：2026-09-29

## 1. 目标与范围

把 `E:\Uina_Core\extensions\external_adapters\netease_jukebox` 迁移到当前 Uina，保留旧版 OBS Overlay 的 HTML、JavaScript 和 CSS 作为显示资产；重新接入当前 World 运行时、扩展生命周期和本地状态出口。HUD 是 Uina 的可选扩展能力，服务于当前 Uina 的 Worlds，不提前做成通用媒体平台。

第一阶段需要形成一条可运行的纵向切片：

```text
Uina World action -> 网易云 API -> 播放器 -> 唯一播放快照
                                      -> broadcast-hud 扩展 -> OBS Overlay
```

需要支持：

- 搜索、直接播放、暂停、继续、停止、上一首、下一首；
- 播放队列和队列上限；
- 播放模式：单曲一次、队列顺序、列表顺序、列表循环、单曲循环、随机；
- 播放进度、当前歌词、歌词窗口、音量和错误状态；
- 搜索结果、歌单、登录账号相关的网易云操作；
- Overlay 的 dashboard、now-playing、progress、lyrics、queue、wave 路由；
- 为未来的 Uina 演唱 World 保留同形状的 HUD 状态源。

明确不做：Core/Session 音乐特判、自动把播放状态写入会话主线、远程暴露本地桥、把 OBS 页面变成播放器控制面板、跨进程通用媒体协议、第一阶段实现音频混音器。

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
| `spectrum-analyzer.ts` | 可选 FFmpeg PCM 分析；不可用时使用 synthetic 或 silent 频谱，不能伪称真实音频频谱。 |

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

## 3. 架构决定

### 3.1 归属

采用“Uina World + Uina `broadcast-hud` 扩展”的两层结构。`broadcast-hud` 是当前 Uina 的可选显示能力，不进入 Core，也不承担音乐业务：

```text
netease-jukebox World
  ├─ Netease API client
  ├─ PlaybackCoordinator + mpv
  ├─ queue / lyrics / account state
  ├─ World actions
  └─ expose("broadcast-hud/source/jukebox", source)

broadcast-hud Extension
  ├─ 从 World 暴露表读取 source
  ├─ loopback HTTP + WebSocket bridge
  ├─ 提供复制的 overlay/ 静态资源
  └─ 只展示快照，不执行播放动作
```

这样做的理由：

1. 播放器和网易云业务属于 World；Overlay 是独立消费者，不应成为播放前置条件。
2. HUD 与当前 Uina 的生命周期、World 启停和共享表天然一致；不需要额外的 producer 注册协议。
3. 点歌 World 和未来演唱 World 只需暴露同一只读状态源，不互相依赖。
4. Core、Session、Provider 和 UI 不增加音乐概念。

第一阶段只注册网易云 source；第二个真实音频源出现前，HUD 不实现源混合、自动切换或音频路由。

### 3.2 `BroadcastHudSource` 最小契约

契约属于 `broadcast-hud` 扩展与 World 之间的 Uina 扩展契约，不放进 Core。只传递活引用快照读取和变化通知，不把控制函数交给 HUD：

```ts
interface BroadcastHudSource {
  readonly sourceId: string;
  readonly kind: "music" | "singing";
  snapshot(): BroadcastHudSnapshot;
  subscribe(listener: () => void): () => void;
}
```

`BroadcastHudSnapshot` 使用 Overlay 所需的稳定数据，不包含控制函数、cookie、URL 或原始响应：

```ts
interface BroadcastHudSnapshot {
  version: 1;
  revision: number;
  updatedAt: string;
  source: { id: string; kind: "music" | "singing"; label: string };
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
  spectrum: { source: "audio" | "synthetic" | "silent"; bands: number[]; energy: number; beat: number };
  layout: { activeView: "dashboard" | "now-playing" | "progress" | "lyrics" | "queue" | "wave"; showQueue: boolean; showLyrics: boolean; showWave: boolean };
  theme: { accent: string; backgroundAlpha: number; lineStyle: "sketch" | "clean" | "hybrid" };
}
```

该契约是显示投影，不是新的权威状态。World 内部可以保留更丰富的账号、搜索和播放数据；HUD 只拿到当前可展示字段。

### 3.3 模块分工与唯一事实

迁移不复制旧版约 1200 行 adapter 的形状。当前 Uina 只增加以下深模块：

| 模块 | 公开接口 | 拥有的复杂度 |
|---|---|---|
| `JukeboxWorld` | WorldDef 生命周期和六个 action | 注册、配置、启动/停止、投影动作结果 |
| `JukeboxApplication` | 意图动作 -> 结构化结果 | ref 解析、登录/确认规则、错误语义、catalog/playback 编排 |
| `PlaybackCoordinator` | 命令、不可变快照、订阅 | 播放器事实、队列、历史、播放模式、取消代数、进度和歌词窗口 |
| `NeteaseGateway` | 归一化的歌曲/歌单/账号读写 | loopback 校验、HTTP 重试、响应归一化、登录/VIP/不可播放分类 |
| `broadcast-hud` | source 发现、快照投影、HTTP/WS | 仅展示状态、stale 处理、慢客户端丢旧快照、静态文件服务 |

`index.ts` 只做装配和 action 注册，不直接解析网易云响应、不决定队列转移、不拼接播放成功文案。`PlaybackCoordinator` 是播放事实唯一拥有者；World `status`、HUD 和未来演唱适配都从同一个快照读取。频谱分析、账号库和搜索结果不塞进 PlaybackCoordinator。

当前只有一个真实播放源，因此不实现多源 arbitration。`revision` 在 source 内单调递增；HUD 和 WS 客户端按 revision 丢弃旧快照，`updatedAt` 只用于展示和诊断，不承担顺序。

### 3.4 Overlay 迁移规则

`E:\Uina_Core\extensions\external_adapters\netease_jukebox\overlay\index.html`、`main.js`、`style.css` 直接复制到 `broadcast-hud` 的静态资源目录。迁移只允许做以下适配：

- 保持现有路由和透明背景行为；
- 将页面请求地址改为 `broadcast-hud` bridge 的同源 `/overlay/state` 和 `/ws/music`；
- 保持 `OverlayState` 字段兼容；
- 如需增加演唱来源，只使用 `source.kind/label` 和同一 `playback.currentTrack` 形状。

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
  -> BroadcastHudSource.snapshot() / changed
  -> broadcast-hud 广播 snapshot
```

开始播放时先获取歌曲详情和播放 URL，再启动 mpv；未获得 URL 时返回 `failed/unavailable`，不把“已请求播放”写成“播放中”。mpv `end-file`、错误和断开分别驱动完成、错误或停止状态。取消加载时只确认取消了内部操作，不推断外部音频已经停止，直到播放器返回事实。

### 4.2 `broadcast-hud` bridge

- 只监听 `127.0.0.1`、`localhost` 或 `::1`；配置非 loopback 时启动失败并保持播放可用。
- `GET /health` 返回 bridge 状态。
- `GET /overlay/state?view=<view>` 返回当前源的完整 OverlayState。
- `GET /overlay/*` 提供白名单内静态文件，拒绝路径穿越。
- `WS /ws/music` 连接后立即发送一次状态；源状态变化或进度/歌词变化时推送。
- bridge 停止只关闭 HTTP/WS 和 source 订阅，不停止 World 或播放器；World 自己拥有播放生命周期。
- 没有客户端连接时不做额外轮询；进度刷新由 PlaybackCoordinator 在播放中按配置周期执行，默认 500ms，HUD 只消费内存快照。
- 扩展采用“先订阅暴露表、再同步当前 source”的顺序，兼容 World 先启动、后启动、停用和重新启用；没有 source 时 bridge 仍可提供 idle 页面。
- loopback 端口冲突只让 HUD 降级，不阻止 World 注册或播放；`world_store disable broadcast-hud` 不影响点歌机。

### 4.3 源选择与未来演唱

第一阶段 `broadcast-hud` 只消费 `jukebox` source，不实现多源仲裁。未来演唱 World 启动时通过 `ctx.expose("broadcast-hud/source/singing", source)` 注册第二个 source；扩展监听暴露表变化并重新绑定。source 停止或取消暴露后，HUD 显示 disconnected/idle，不继续把旧的 `playing` 当作当前播放。

第二个 source 真正出现后，再增加显式的 active source 选择规则（默认最近一次有权声明 active 的 source）。不使用“两个 source 交替心跳就自动抢焦点”的隐式规则，避免直播画面抖动。

## 5. World 能力设计

### 5.1 核心动作

动作按用户意图分组，避免把十几个网易云 endpoint 暴露成模型必须记忆的动作名。World tool 只保留六个稳定入口：

| 动作 | 语义 |
|---|---|
| `search` | 搜索歌曲、打开/浏览歌单或发现内容；结果进入当前 World 视图并产生稳定引用。 |
| `play` | 立即播放 `ref`/歌曲 ID；默认保留已有队列，显式 `replace_queue: true` 才替换。 |
| `queue` | `add`、`list`、`remove`、`clear`；只有明确调用 `queue` 才改变待播列表。 |
| `playback` | `pause`、`resume`、`stop`、`next`、`previous`、`status`、`mode`；播放控制集中在一个动作。 |
| `lyrics` | 查询完整歌词或当前歌词窗口；当前歌曲省略 `song_id`。 |
| `library` | 登录账号、喜欢、评论、歌单创建/修改/订阅等低频操作；写操作要求确认和结果验证。 |

直觉规则：说“播放/放一首”只改变当前播放；说“加到队列/接下来播放”才入队；说“停掉”不清空队列，只有 `queue clear` 或 `playback stop(clear_queue=true)` 才清空。旧版十多个动作可以在实现内部保留函数，但不作为模型接口继续扩张。

模型可见的结果也遵循固定句式：成功说明“已完成什么 + 当前事实”；失败说明“没有完成什么 + 原因 + 可执行的下一步”；外部结果未确认时使用 `unknown`，不使用“应该已经播放”。搜索和歌单结果始终返回可引用的 `ref`，播放只接受当前视图中的 `ref` 或明确歌曲 ID，避免模型凭空编造网易云 ID。

### 5.2 网易云数据动作

`search` 和 `library` 内部迁移旧版的打开歌单、发现歌曲/歌单、我的/创建/订阅歌单、喜欢/取消喜欢、评论、创建/修改/添加/移除/订阅歌单。动作分两类：

- 读操作：登录未知时可以返回公开数据；账号专属结果明确为 `login_required`。
- 写操作：必须确认登录身份、目标资源可编辑性和 API 返回结果；未经验证不能返回成功。

所有结果采用当前 World action 的 `string | ToolExecutionResult` 合同，失败、取消和未确认状态不能以普通成功文本替代。

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
- FFmpeg 不可用：频谱为 `synthetic` 或 `silent`，明确标记来源。
- bridge 端口冲突：bridge 状态为 error，World 播放和工具仍可用。
- WebSocket 客户端慢：只发送最新快照，不为 OBS 建立无限队列。
- 队列上限默认 100，可配置但必须有限；超限拒绝入队。
- 所有长 IO 透传 `ActionContext.signal`；World 停止通过 scope signal 取消未完成请求和 bridge 订阅。

### 6.1 配置与默认行为

配置必须从 World 数据目录和显式配置得到，不再把 `E:\Uina\...` 之类的机器路径写进实现。默认值以“能解释、不会偷偷产生副作用”为准：

| 配置 | 默认 | 说明 |
|---|---|---|
| `api.mode` | `external` | 使用已运行的 loopback `api-enhanced`；`managed` 才允许 World 拉起指定目录的子进程；`simulation` 只用于测试。 |
| `api.baseUrl` | `http://127.0.0.1:3000` | 只允许 loopback HTTP。 |
| `player` | `mpv` | 找不到 mpv 时明确 unavailable；不自动切到静音模拟。 |
| `queueLimit` | `100` | 有限且可观察，超限拒绝。 |
| `broadcastHud.enabled` | `false` | HUD 是可选能力；关闭不影响点歌和播放。 |
| `broadcastHud.port` | `18130` | 只监听 loopback，端口冲突只影响 HUD。 |

模型不需要知道这些配置。`status` 只报告当前可用性和下一步，不暴露 cookie、进程参数或本地文件细节。

## 7. 实施阶段

### P0：迁移最小纵向切片

1. 复制 Overlay 静态资源。
2. 将当前 `PlaybackSession` 深化为 `PlaybackCoordinator`，先集中唯一状态快照、队列、模式、进度、歌词窗口和播放器结束/错误处理；不复制旧版全部实现。
3. 将 `NeteaseApiClient` 深化为 `NeteaseGateway`，集中 loopback 校验、重试、响应归一化和不可播放分类。
4. 将 World `index.ts` 收窄为装配，加入 `JukeboxApplication` 处理六个意图动作。
5. 增加可选 `broadcast-hud` 扩展（静态资源、loopback server、World source 订阅），接入网易云 source。
6. 实现 `search -> play -> snapshot -> Overlay` 真实链路。

### P1：操作完整性

1. 增加 `add_to_queue`、`next`、`previous`、播放模式和持久化偏好。
2. 增加歌单/发现/账号读操作。
3. 增加账号写操作和结果验证。
4. 增加歌词窗口、进度和可选频谱分析。

### P2：未来演唱接缝

1. 演唱 World 暴露第二个 `BroadcastHudSource`。
2. `broadcast-hud` 增加显式 source 选择状态和 active source 规则。
3. 为 singing source 增加最小测试，不修改 Overlay 的基础布局。

P2 之前不添加通用媒体混音、媒体资产库、独立数据库或跨进程消息总线。

## 8. 验证计划

### 静态与单元

- `pnpm typecheck`：World/扩展边界、Overlay contract 和现有边界检查；
- `pnpm test`：API 归一化、播放模式、队列上限、歌词窗口、取消和 `BroadcastHudSnapshot` schema；
- bridge 路径白名单、loopback 校验、WS 初始快照和断开清理测试；
- World 停用后不再执行新动作、不再广播状态。
- `broadcast-hud` 先订阅再同步的启停顺序、source 注销、revision 单调性和慢客户端只保留最新快照。

### 组合测试

- simulation player 下运行 `search -> play -> add_to_queue -> next -> stop`；
- 在没有消费者时 World 仍能播放并更新状态；
- HUD 扩展先启动或后启动都能接收 World source 快照；World 停止后 source 变为 disconnected；
- bridge 无法监听时播放动作仍可运行。

### 真实依赖验证

- 隔离配置启动本地 `api-enhanced`，验证搜索、歌曲详情、播放 URL、歌词和登录状态；
- 安装 mpv 时验证真实 IPC 的播放、暂停、结束和错误；
- OBS Browser Source 连接真实 loopback URL，确认透明背景、六个路由、歌词/队列/进度更新；
- 若启用 FFmpeg，确认 Overlay 标记 `source: "audio"`；否则只接受 synthetic/silent 事实。

每项结果必须标为代码实现、模拟测试或真实依赖验证。历史日志和 mock 不足以证明真实网易云、mpv 或 OBS 工作。

## 9. 取舍与删除标准

保留的抽象只有三个稳定 seam：`PlaybackCoordinator`、`NeteaseGateway`、`broadcast-hud` source。若未来没有第二个音频源，不增加 source arbitration，也不把 snapshot 协议扩展成媒体平台。

出现以下情况时删除或收窄复杂度：

- 第二个源没有真实需求：不实现源混合和自动编排；
- OBS 只需要一个页面：保留 dashboard，路由仍可由 Overlay 兼容但不增加更多组件；
- 频谱分析造成明显 CPU/IO 负担：默认关闭 analyzer，保留 synthetic/silent；
- 账号写操作没有稳定 API 验证：暂时只提供读操作，不能伪造成功。

## 10. 最终决策

实现方向为：**网易云是一个 Uina World；World 内部的 `PlaybackCoordinator` 是唯一播放事实拥有者；可选的 `broadcast-hud` 扩展通过 World 暴露表读取只读 source，并提供 loopback bridge；未来演唱 World 暴露第二个 source。**

下一步应先实现 P0，并以 simulation player 完成一条可测的 `search -> play -> state snapshot -> Overlay` 纵向切片，再接入真实 api-enhanced、mpv 和 OBS。Core、Session、Provider 和 UI 不需要为点歌机增加专用接口。
