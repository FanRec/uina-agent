# 12-Factor Agents 对照

## 已采用

1. 自然语言到结构化工具调用：模型只提出调用，ToolBroker 负责校验和执行。
2. 自有 prompt：system prompt 位于 `src/agent/context.ts`，可通过 Subject 选项替换。
3. 自有 context：loop 组装消息、工具声明和 compaction，不把上下文控制交给框架。
4. 自有 control flow：Subject 明确处理队列、工具循环、中断、错误和压缩。
5. compact errors：模型错误和工具错误以结构化消息/事件进入历史并显示给用户。
6. 追加式状态记录：JSONL session 保存消息、工具生命周期、队列和 compaction 事件。

## 有意保持最小

- 当前只有一个 foreground Subject，不引入多 Agent 拓扑。
- 没有通用事件总线、后台 Job、传感器、长期记忆或 RPC，因为 v0 没有真实消费者。
- 没有审批、沙箱、超时和并发上限，遵循已选择的可信工作区模型。

## 未实现边界

- provider 重试和复杂降级；
- 多模态输入；
- 动态能力筛选和 skill/template 系统；
- 完整 Pi session 分支/fork/search；
- 人类审批、外部通道和长期记忆。

这些不是当前完成度的隐性承诺，只有出现可复现的用户场景后才单独设计。
