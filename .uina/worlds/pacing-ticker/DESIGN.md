# pacing-ticker World 当前设计

pacing-ticker 提供自主节拍机会和节拍状态查询。它负责计时、主体忙碌检查、人类活动冷却、退避、次数限制和持久化。

符合条件时发送一个 `pacing-opportunity` 事件：`queued`、`internal`、`channel: "world"`，事件 ID 使用 `pacing-opportunity:` 前缀加 UUID，跨进程重启和扩展重载保持唯一。主体忙碌、刚与人交互、外部活动退避、每日次数达到上限时不会发送。

节拍器的内部计时变化、下一次触发时间和冷却变化不是主体事件，只通过 `status` 查询。停用时取消计时器、监听器和后续事件出口。
