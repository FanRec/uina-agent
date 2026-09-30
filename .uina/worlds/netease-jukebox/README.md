# netease-jukebox World

网易云音乐播放器 World，提供 `search`、`play`、`queue`、`playback`、`lyrics`、`library` 六个稳定意图入口。

播放状态由 `PlaybackCoordinator` 持有，并向可选的 `ThirdParty/broadcast-hud` 发布快照。HUD 不可用时不影响播放；播放器连接、搜索和播放会在 World 停用时释放。

队列默认上限 100，历史仅保留本次运行最近 50 首。播放模式支持 `single_once`、`queue_order`、`list_loop`、`single_loop` 和 `shuffle`。播放模式与音量写入 World 的 `preferences.json`，不恢复外部播放器位置或音频队列；旧配置中的 `list_order` 会按 `queue_order` 读取。

`lyrics` 查询完整歌词；设置 `current: true` 时返回当前句窗口。`current_lyrics` 作为旧调用的兼容别名保留。歌词按歌曲 ID 做本次进程内缓存，不处理翻译歌词、逐字歌词或跨进程缓存。

HUD 播放真实 mpv 音频时会让 FFmpeg 解码同一个播放 URL，使用其 PCM 数据计算频谱，因此不会混入浏览器、通知或其他系统声音。需要可执行的 `ffmpeg`，可用 `FFMPEG_PATH` 或 `ffmpegPath` 配置路径；依赖不可用时 HUD 保留播放与歌词状态，频谱显示为 silent。频谱仍是歌曲 URL 的解码分析，不代表 mpv 输出设备的最终混音。

HUD 发布采用最新快照策略；HUD 服务暂时不可用时不会积压旧请求，恢复后从最新播放状态继续。播放时长未知显示为 `--:--`，歌词请求失败会按有限退避重试，仍无歌词时显示无歌词提示。HUD Companion 自动启动失败只会把 HUD 连接标为 degraded，不会阻止点歌机播放。

`library` 提供账号状态、歌单、喜欢、最近播放和评论入口，并支持 `playlist_track_add`、`playlist_track_remove`、`playlist_update` 等歌单写操作。所有写操作必须传入 `confirm: true`；歌单写入前会检查当前账号的可编辑权限，写入后会重新读取歌单验证结果，无法确认时返回 `unknown`。账号库仍依赖本机 loopback `api-enhanced` 的真实登录态。

World 入口只负责资源装配和生命周期；action 参数解析、搜索 ref、歌词缓存与账号库编排位于 `application.ts`。歌单歌曲写入优先使用 api-enhanced 的专用 endpoint，服务不提供时回退到 `playlist_tracks`。
