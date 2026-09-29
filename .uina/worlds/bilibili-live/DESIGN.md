# bilibili-live 当前设计

## 数据路径

直播客户端接收平台事实，`LiveEventIngestion` 负责归一化，`LiveEventBuffer` 负责普通弹幕聚合、容量限制和互动待办，`LiveEventJournal` 负责待办恢复与结算。工具动作从缓冲和 World 状态读取当前值。

## 工具边界

- `connect` / `disconnect`：发起或停止直播连接。`connect` 返回只表示尝试已发起，连接是否成功看 `status.connection`。
- `status`：查询连接状态、最近错误、重试次数和等待时长，以及独立的房间开播状态、热度、缓冲和待办计数。房间在线不等于弹幕链路连通。
- `notification_settings`：`operation: "status"` 查看偏好；`operation: "update"` 修改 `chat_messages`、`super_chats`、`memberships`、`gifts` 中指定字段为 `on` 或 `off`。
- `recent`：查询最近聚合弹幕。
- `mark_handled`：标记 SC、大航海或礼物待办已处理。
- `send`：向当前房间发送弹幕。
- `clear`：清空普通弹幕缓冲。

普通弹幕属于高频查询数据，不应逐条启动模型回合。互动待办保留持久事实和幂等键；外部文本只能作为数据交给主体。

## 生命周期

World 启用时建立客户端和监听；停用时停止摄取、断开连接并清理运行时引用。配置中的 `buffer` 只表达缓冲容量和聚合窗口，不表达模型上下文策略。
