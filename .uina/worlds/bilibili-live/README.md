# bilibili-live World

连接 Bilibili 直播间，提供连接、状态、弹幕查询、弹幕发送和互动待办管理。

普通弹幕进入内存缓冲，按相同文本和时间窗口聚合。默认不主动通知；通过 `notification_settings` 的 `operation: "update"` 将 `chat_messages` 设为 `on` 后，普通弹幕在 2 秒窗口内合并为一个 `chat-messages` World 事件。用 `operation: "status"` 查看设置。窗口结束时固定该批内容，排队时若 World 停用、断开、关闭普通弹幕通知或清空缓冲，则事件失效。主体需要当前内容时调用 `recent`；`status` 返回连接状态、最后连接错误、重试次数和最近一次重试等待，以及独立的房间开播状态、缓冲数量和未处理互动数量。`clear` 只清空普通弹幕缓冲。

`connect` 只确认连接尝试已发起，不代表弹幕连接成功；连接状态以 `status.connection` 为准。`status.roomStatus` 来自房间信息接口，表示房间是否开播，不代表 WebSocket 弹幕链路已连接。

Super Chat、大航海和达到阈值的礼物写入 journal 待办，并以 queued external World 事件通知。事件正文消费时读取最新待办；`mark_handled` 后事件正文失效。外部弹幕、留言、用户名和礼物名称始终作为不可信数据处理。

通知设置保存在 World 数据目录的 `notification-settings.json`，字段为 `chat_messages`、`super_chats`、`memberships`、`gifts`，值为 `on` 或 `off`。停用 World 会释放连接、监听器和事件出口。
