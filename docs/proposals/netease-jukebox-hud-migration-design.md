# 网易云点歌与音频 HUD 迁移设计

状态：Proposal

日期：2026-09-29

## 1. 目标与范围

把 `E:\Uina_Core\extensions\external_adapters\netease_jukebox` 迁移到当前 Uina，保留旧版 OBS Overlay 的 HTML、JavaScript 和 CSS 作为显示资产；重新接入当前 World 运行时、扩展生命周期和本地状态出口。

第一阶段需要形成一条可运行的纵向切片：

```text
Uina World action -> 网易云 API -> 播放器 -> 播放状态
                                      -> audio HUD 状态桥 -> OBS Overlay
```

需要支持：

- 搜索、直接播放、暂停、继续、停止、上一首、下一首；
- 播放队列和队列上限；
- 播放模式：单曲一次、队列顺序、列表顺序、列表循环、单曲循环、随机；
- 播放进度、当前歌词、歌词窗口、音量和错误状态；
- 搜索结果、歌单、登录账号相关的网易云操作；
- Overlay 的 dashboard、now-playing、progress、lyrics、queue、wave 路由；
- 为未来的 Uina 演唱插件保留同形状的音频 HUD 状态源。

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

采用“Uina World + 独立 OBS 显示器”的两层结构。显示器暂定名为 **`obs-media-overlay`**，它不是 Uina 扩展，也不导入 Uina runtime：

```text
netease-jukebox World（Uina 内）
  ├─ Netease API client
  ├─ PlaybackService + mpv
  ├─ queue / lyrics / account state
  ├─ World actions
  └─ MediaOverlayPublisher -> localhost obs-media-overlay

obs-media-overlay（独立本地程序/包）
  ├─ 接收通用 MediaOverlayState
  ├─ 提供复制的 overlay/ 静态资源
  └─ 只发布 OverlayState，不执行播放动作
```

这样做的理由：

1. 播放器和网易云业务属于 World；Overlay 是独立消费者，不应成为播放前置条件。
2. Overlay 不依赖 Uina，可以被 OBS、其它本地播放器或其它 Agent 复用。
3. 点歌 World 和未来演唱插件都是 producer，只需发布同一状态协议，不需要互相依赖。
4. Core、Session、Provider 和 UI 不增加音乐概念。

第一阶段只实现网易云 producer；第二个真实音频源出现前，Overlay 不实现源混合、自动切换或音频路由。

### 3.2 `MediaOverlayState` 最小协议

协议是独立包中的纯数据 schema，不放进 Uina Core。Overlay 不接收活引用，只接收带版本的状态快照：

```ts
interface MediaOverlayPublisher {
  publish(state: MediaOverlayState): Promise<void>;
}
```

`MediaOverlayState` 使用 Overlay 所需的稳定数据，不包含控制函数、cookie、URL 或原始响应：

```ts
interface MediaOverlayState {
  version: 1;
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

### 3.3 Overlay 迁移规则

`E:\Uina_Core\extensions\external_adapters\netease_jukebox\overlay\index.html`、`main.js`、`style.css` 直接复制到 `obs-media-overlay` 的静态资源目录。迁移只允许做以下适配：

- 保持现有路由和透明背景行为；
- 将页面请求地址改为 `obs-media-overlay` bridge 的同源 `/overlay/state` 和 `/ws/music`；
- 保持 `OverlayState` 字段兼容；
- 如需增加演唱来源，只使用 `source.kind/label` 和同一 `playback.currentTrack` 形状。

不在 Overlay 中加入 API 登录、播放控制、队列修改或网易云请求。旧版 bridge 的 action 接收能力不迁移为 Overlay 的公开控制面；播放控制统一走 World action，避免 OBS 页面成为第二个副作用入口。

## 4. 数据流与生命周期

### 4.1 播放控制

```text
模型工具调用 world:jukebox/<action>
  -> WorldActivation scope 校验与取消
  -> Jukebox action
  -> PlaybackService 串行化状态变更
  -> mpv / api-enhanced 外部副作用
  -> 确认后的状态 patch
  -> MediaOverlayPublisher.publish(snapshot)
  -> obs-media-overlay 广播 snapshot
```

开始播放时先获取歌曲详情和播放 URL，再启动 mpv；未获得 URL 时返回 `failed/unavailable`，不把“已请求播放”写成“播放中”。mpv `end-file`、错误和断开分别驱动完成、错误或停止状态。取消加载时只确认取消了内部操作，不推断外部音频已经停止，直到播放器返回事实。

### 4.2 `obs-media-overlay` bridge

- 只监听 `127.0.0.1`、`localhost` 或 `::1`；配置非 loopback 时启动失败并保持播放可用。
- `GET /health` 返回 bridge 状态。
- `GET /overlay/state?view=<view>` 返回当前源的完整 OverlayState。
- `GET /overlay/*` 提供白名单内静态文件，拒绝路径穿越。
- `WS /ws/music` 连接后立即发送一次状态；源状态变化或进度/歌词变化时推送。
- bridge 停止只关闭 HTTP/WS，不停止任何 producer 或播放器；producer 自己拥有其生命周期。
- 没有客户端连接时不做额外轮询；进度刷新由 PlaybackService 在播放中按配置周期执行，默认 500ms，HUD 只消费内存快照。

### 4.3 源选择与未来演唱

第一阶段 `obs-media-overlay` 只消费一个 producer。producer 启动时通过本地 publisher 注册 `source.id`，之后按状态变化和进度周期发送完整快照；服务端维护每个 source 的最后快照和最后接收时间。超过 stale timeout 未收到更新时，源标记为 `disconnected`，不会继续把旧的 `playing` 当作当前播放。

未来演唱插件可以作为另一个 producer 向同一 localhost publisher 发布 `kind: "singing"` 的状态。Overlay 服务负责按 `source.id` 保存最近快照，选择规则为“最近一次声明 active/playing 的源，其次最近更新源”。没有 active 源时显示 idle。

producer 不需要知道对方是 Uina World、Uina Extension 还是独立程序；它只依赖协议包和本地 publisher 地址。第一阶段不自动叠加两首歌，也不把 TTS 音频误标为歌曲；`kind: "singing"` 只用于来源标签和未来样式选择。

## 5. World 能力设计

### 5.1 核心动作

保留当前动作名称并扩展为：

| 动作 | 语义 |
|---|---|
| `search` | 查询并保存当前搜索结果，返回可引用的 `search:<n>`。 |
| `play` | 直接 ID 或当前 World 结果引用播放；默认替换队列，可显式 `replace_queue: false`。 |
| `add_to_queue` | 将 ID 或引用加入队列，超过上限明确失败。 |
| `pause` / `resume` / `stop` | 播放器控制；`stop` 可选 `clear_queue`。 |
| `next` / `previous` | 按当前播放模式切换；上一首在阈值内回到当前歌曲开头，否则使用历史。 |
| `set_play_mode` | 设置六种播放模式并持久化偏好。 |
| `set_volume` / `adjust_volume` | 设置或调整 0-100 音量并持久化偏好。 |
| `status` | 返回播放、队列、播放器可用性、API/bridge 状态和最后错误。 |
| `lyrics` / `current_lyrics` | 完整歌词或当前歌词窗口；歌词缓存按歌曲 ID 保存于进程内。 |

### 5.2 网易云数据动作

迁移旧版的搜索、打开歌单、发现歌曲/歌单、我的/创建/订阅歌单、喜欢/取消喜欢、评论、创建/修改/添加/移除/订阅歌单。动作分两类：

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

## 7. 实施阶段

### P0：迁移最小纵向切片

1. 复制 Overlay 静态资源。
2. 抽取当前 `PlaybackSession` 为支持队列、历史、模式和进度的 `PlaybackService`。
3. 将旧版 `api-client` 的 loopback 校验、重试和响应归一化迁移到 World 内部。
4. 增加独立 `obs-media-overlay` 包（静态资源、loopback server、publisher 协议），接入网易云 producer。
5. 实现 `search -> play -> mpv -> overlay state` 真实链路。

### P1：操作完整性

1. 增加 `add_to_queue`、`next`、`previous`、播放模式和持久化偏好。
2. 增加歌单/发现/账号读操作。
3. 增加账号写操作和结果验证。
4. 增加歌词窗口、进度和可选频谱分析。

### P2：未来演唱接缝

1. 演唱 producer 发布第二个 `MediaOverlayState` 源。
2. `obs-media-overlay` 增加源选择状态和 active 源规则。
3. 为 singing source 增加最小测试，不修改 Overlay 的基础布局。

P2 之前不添加通用媒体混音、媒体资产库、独立数据库或跨进程消息总线。

## 8. 验证计划

### 静态与单元

- `pnpm typecheck`：World/扩展边界、Overlay contract 和现有边界检查；
- `pnpm test`：API 归一化、播放模式、队列上限、歌词窗口、取消和 `MediaOverlayState` schema；
- bridge 路径白名单、loopback 校验、WS 初始快照和断开清理测试；
- World 停用后不再执行新动作、不再广播状态。

### 组合测试

- simulation player 下运行 `search -> play -> add_to_queue -> next -> stop`；
- 在没有消费者时 World 仍能播放并更新状态；
- Overlay 先启动或后启动都能接收 producer 快照；producer 停止后源变为 stale/disconnected；
- bridge 无法监听时播放动作仍可运行。

### 真实依赖验证

- 隔离配置启动本地 `api-enhanced`，验证搜索、歌曲详情、播放 URL、歌词和登录状态；
- 安装 mpv 时验证真实 IPC 的播放、暂停、结束和错误；
- OBS Browser Source 连接真实 loopback URL，确认透明背景、六个路由、歌词/队列/进度更新；
- 若启用 FFmpeg，确认 Overlay 标记 `source: "audio"`；否则只接受 synthetic/silent 事实。

每项结果必须标为代码实现、模拟测试或真实依赖验证。历史日志和 mock 不足以证明真实网易云、mpv 或 OBS 工作。

## 9. 取舍与删除标准

保留的抽象只有三个稳定边界：`PlaybackService`、`MediaOverlayState`、`obs-media-overlay` bridge。若未来没有第二个音频源，协议仍然只是一个小的显示投影，不继续扩展成媒体平台。

出现以下情况时删除或收窄复杂度：

- 第二个源没有真实需求：不实现源混合和自动编排；
- OBS 只需要一个页面：保留 dashboard，路由仍可由 Overlay 兼容但不增加更多组件；
- 频谱分析造成明显 CPU/IO 负担：默认关闭 analyzer，保留 synthetic/silent；
- 账号写操作没有稳定 API 验证：暂时只提供读操作，不能伪造成功。

## 10. 最终决策

实现方向为：**网易云是一个 Uina World，播放状态由 World 内部 PlaybackService 拥有；复制的 Overlay 由完全独立的 `obs-media-overlay` 本地程序通过 loopback bridge 展示；World 作为 producer 发布 `MediaOverlayState`；未来演唱插件以第二个 producer 接入。**

下一步应先实现 P0，并以 simulation player 完成一条可测的 `search -> play -> state snapshot -> Overlay` 纵向切片，再接入真实 api-enhanced、mpv 和 OBS。Core、Session、Provider 和 UI 不需要为点歌机增加专用接口。
