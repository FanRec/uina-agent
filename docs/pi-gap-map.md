# Pi 参考差距

本文只比较当前 Uina v0 与 Pi 已观察到的机制，不把未实现能力写成当前架构。

| 机制 | Uina v0 | 说明 |
| --- | --- | --- |
| 前台循环 | 已实现 | Subject 控制模型请求、工具回注和结束条件 |
| steer/followUp | 已实现 | 两条队列，明确送达点；中断后恢复到输入区 |
| 流式 OpenAI 网关 | 已实现 | 严格 SSE framing、finish reason 和 wire 转换 |
| 工具注册 | 已实现 | 顶层 `.ts`、子目录 `index.ts`、Tool/Tool[]/注册函数 |
| 工具 schema | 已实现 | Ajv 编译和执行前校验 |
| 工具默认并行 | 已实现 | 可用 `executionMode: "sequential"` 覆盖 |
| 工具取消 | 已实现 | AbortSignal，shell 终止进程树 |
| shell 输出 | 已实现 | stdout/stderr 独立尾部截断，超限保存完整临时文件 |
| compaction | 已实现 | provider contextWindow、reserve、keepRecent 可配置 |
| JSONL session | 最小实现 | header、追加 record、重放、torn tail 修复、unknown recovery |
| 完整 Pi JSONL v4 | 未实现 | 暂不包含分支、fork、lane、operation ledger、搜索 |
| TUI 组件系统 | 未实现 | 当前使用 readline 单行编辑器 |
| 自定义扩展事件 | 未实现 | 当前只动态加载工具，不提供通用 hook bus |
| 图片和多模态 | 未实现 | v0 只有文本输入 |
| provider 重试 | 未实现 | 失败直接回注并通知，不自动重试 |
| 审批/权限策略 | 未实现 | 采用当前账户权限的可信工作区模型 |
| 后台 Job | 未实现 | 当前工具均在前台 turn 内完成 |

## 参考原则

- Pi 的控制流可读性、双队列送达点、默认并行工具和 JSONL 追加记录值得复用。
- Pi 的完整 session 分支模型只有在 Uina 出现 fork、搜索或多会话需求后再引入。
- 当前不增加 Pi 没有实际需求支撑的超时、审批、并发上限或工具轮次上限。
