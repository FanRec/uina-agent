# netease-jukebox World

网易云音乐播放器 World，提供 `search`、`play`、`queue`、`playback`、`lyrics`、`library` 六个稳定意图入口。

播放状态由 `PlaybackCoordinator` 持有，并向可选的 `ThirdParty/broadcast-hud` 发布快照。HUD 不可用时不影响播放；播放器连接、搜索和播放会在 World 停用时释放。mpv 与频谱 ffmpeg 由宿主 spawn 并登记到宿主子进程兜底表（`world-framework/child-process-registry`）：宿主退出时——包括优雅清理超时的非优雅路径——会同步击杀这些由它自己启动的子进程；api-enhanced 有意不登记，宿主退出后继续存活，下次启动直接复用健康实例。

队列默认上限 100，历史仅保留本次运行最近 50 首。`queue add` 给 `playlist_id` 时走批量路径：只发一次歌单详情，把整张歌单按顺序入队，超上限的部分不加入并把剩余数量写进结果；单曲入队超限仍然拒绝。批量路径只对本次新增发一次快照，不为每首歌各推一版。播放模式支持 `single_once`、`queue_order`、`list_loop`、`single_loop` 和 `shuffle`。`previous` 在当前曲目已播放超过 5 秒时回到曲目开头，否则回退历史。自动续播遇到加载失败的曲目会将其移出队列并跳过，连续失败 3 次后停止并保留剩余队列。播放模式与音量写入 World 的 `preferences.json`，不恢复外部播放器位置或音频队列；旧配置中的 `list_order` 会按 `queue_order` 读取。

`lyrics` 查询完整歌词；设置 `current: true` 时返回当前句窗口。歌词按歌曲 ID 做本次进程内缓存，不处理翻译歌词、逐字歌词或跨进程缓存。

HUD 播放真实 mpv 音频时会让 FFmpeg 解码同一个播放 URL，使用其 PCM 数据计算频谱，因此不会混入浏览器、通知或其他系统声音。需要可执行的 `ffmpeg`，可用 `FFMPEG_PATH` 或 `ffmpegPath` 配置路径；依赖不可用时 HUD 保留播放与歌词状态，频谱显示为 silent。频谱仍是歌曲 URL 的解码分析，不代表 mpv 输出设备的最终混音。

HUD 发布采用最新快照策略；HUD 服务暂时不可用时不会积压旧请求，恢复后从最新播放状态继续。播放时长未知显示为 `--:--`，歌词请求失败会按有限退避重试，仍无歌词时显示无歌词提示。HUD Companion 自动启动失败只会把 HUD 连接标为 degraded，不会阻止点歌机播放。

`library` 提供账号状态、歌单、喜欢、最近播放和评论入口，并支持 `playlist_track_add`、`playlist_track_remove`、`playlist_update` 等歌单写操作。所有写操作必须传入 `confirm: true`；歌单写入前用登录账号（`/login/status` 的 `data.account.id`）自查归属，只提交自己的歌单或上游标记 `editable` 的歌单，写入后用完整的 `trackIds`（不受读路径分页影响）重新读取歌单验证结果，无法确认时返回 `unknown`。`playlist_update` 未提及的字段按歌单当前值补齐——上游把名称、简介、标签当成整份状态一起提交，缺省即清空。账号库仍依赖本机 loopback `api-enhanced` 的真实登录态。

歌单与红心列表按投影后的可读曲目分页返回，不再把上游响应整份交给模型。`playlist_open` 的 `offset`/`limit` 省略为 0/50，上限 200；`declaredTotal` 与 `playableTotal` 不等时用 `missing` 如实报出上游没给的曲目数，翻页只按实际曲目数推进，不伪造占位曲目。`liked_list` 先取 id 序列再补当前页详情，按 id 序列重排后返回（批量详情不保证顺序），第二段失败时仍报出红心总数。`recent_list` 与 `comments_list` 未做投影（一条评论约 0.8 KB、一条最近播放约 1.5 KB），因此 `limit` 最多 20 条，不放宽到 200。曲目字段统一为 `id`/`name`/`artists`/`durationMs`/`album`，搜索、详情、批量详情与歌单四处共用同一份投影。

World 入口只负责资源装配和生命周期；action 参数解析、搜索 ref、歌词缓存与账号库编排位于 `application.ts`。歌单歌曲的增删只用 `playlist_tracks`（`op=add|del`）一个接口：上游另有 `/playlist/track/add`、`/playlist/track/delete`，名字更像，但那是视频歌单用的，对普通歌曲歌单恒回 401「无权限操作歌单」。

搜索结果使用 `ref=song:<歌曲ID>`，同一 World 生命周期内后续搜索不会让已有 ref 改指其他歌曲。读取请求遇到 HTTP 502/503/504 或瞬时连接错误时最多重试一次，并受原请求总超时与调用取消信号约束；持续失败会返回状态码和尝试次数。歌单写入遇到 5xx、超时或网络错误时结果可能未知，不自动重发——副作用可能已经发生，重发会有第二份。

`/song/url/v1` 默认走 xeapi 加密通道，该通道依赖 `os.tmpdir()/xeapi_public_key`。服务只在进程启动时拉取一次公钥，失败后端口仍然健康、搜索正常，但所有 xeapi 接口会返回由内部异常合成的 `404 Not Found`。`CompanionManager` 在拉起服务前检查该文件，缺失时调用服务自带的 `generateConfig` 补一次（失败只写入 stderr，不阻断启动）；播放地址请求遇到这类合成 404 时改用 `crypto=weapi` 再请求一次，上游真实的 404 不降级。
