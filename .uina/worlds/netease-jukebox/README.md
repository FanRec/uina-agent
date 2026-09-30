# netease-jukebox World

网易云音乐播放器 World，提供 `search`、`play`、`queue`、`playback`、`lyrics`、`library` 六个稳定意图入口。

播放状态由 `PlaybackCoordinator` 持有，并向可选的 `ThirdParty/broadcast-hud` 发布快照。HUD 不可用时不影响播放；播放器连接、搜索和播放会在 World 停用时释放。

队列默认上限 100，历史仅保留本次运行最近 50 首。播放模式支持 `single_once`、`queue_order`、`list_order`、`list_loop`、`single_loop` 和 `shuffle`。播放模式与音量写入 World 的 `preferences.json`，不恢复外部播放器位置或音频队列。

`lyrics` 查询完整歌词；设置 `current: true` 时返回当前句窗口。`current_lyrics` 作为旧调用的兼容别名保留。歌词按歌曲 ID 做本次进程内缓存，不处理翻译歌词、逐字歌词或跨进程缓存。

`library` 提供账号状态、歌单、喜欢、最近播放和评论入口，并支持 `playlist_track_add`、`playlist_track_remove`、`playlist_update` 等歌单写操作。所有写操作必须传入 `confirm: true`；歌单写入前会检查当前账号的可编辑权限，写入后会重新读取歌单验证结果，无法确认时返回 `unknown`。账号库仍依赖本机 loopback `api-enhanced` 的真实登录态。

World 入口只负责资源装配和生命周期；action 参数解析、搜索 ref、歌词缓存与账号库编排位于 `application.ts`。歌单歌曲写入优先使用 api-enhanced 的专用 endpoint，服务不提供时回退到 `playlist_tracks`。
