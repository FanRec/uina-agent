# bilibili-live 当前设计

## 数据路径

直播客户端接收平台事实，`LiveEventIngestion` 负责归一化；`DanmakuWindow` 负责普通弹幕的原始有界窗口、覆盖计数、紧凑展示和唯一未结算输入；`LiveEventBuffer` 只负责 SC、大航海、礼物待办及其 journal；`LiveEventJournal` 负责待办恢复与结算。

普通弹幕不写持久 journal。它是实时感知窗口：默认最多 16 条原始消息，`buffer.maxItems` 可配置。展示压缩不改变容量；只有本批连续同一用户、同一文本才显示 `×N`。普通弹幕主动通知只保留一个 deferred World 输入，首次渲染时冻结正文，直到 Subject 发出 `input_settled` 才释放投递槽位。输入写入失败时重试同一正文，不创建替代批次。

## 工具边界

- `connect` / `disconnect`：发起或停止直播连接。`connect` 返回只表示尝试已发起，连接是否成功看 `status.connection`。
- `status`：查询连接状态、最近错误、重试次数和等待时长，以及房间开播状态、普通弹幕窗口和待办计数。房间在线不等于弹幕链路连通。
- `notification_settings`：`operation: "status"` 查看偏好；`operation: "update"` 修改 `chat_messages`、`room_status`、`super_chats`、`memberships`、`gifts`。
- `recent`：只读查询最近普通弹幕，不推进主动通知。
- `mark_handled`：标记 SC、大航海或礼物待办已处理。
- `send`：向当前房间发送弹幕。
- `clear`：清空普通弹幕窗口和小额礼物暂态池，不清除持久待办。

## 主体接缝

World Framework 使用 `emitEvent` 把普通弹幕作为 `queued/external/world` 输入交给 Subject。Subject 的 `input_settled` 事实只表示该输入已经进入 canonical history 或永久退役，不表示模型已经回复，也不表示外部副作用成功。Bilibili 只监听自己登记的输入 ID。

## 生命周期

World 启用时建立客户端和监听；停用时停止摄取、断开连接并清理运行时引用。手动切房、断开、清空和关闭普通弹幕通知会使未结算观察失效；自动重连不改变房间周期。配置中的 `buffer.maxItems` 是原始消息容量，`aggregationWindowMs` 只控制展示时相邻重复消息的压缩窗口。
