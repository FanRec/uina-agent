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
| JSONL session | v2 最小实现 | header、追加 record、custom_message/custom_entry、重放、torn tail 修复、unknown recovery |
| 完整 Pi JSONL v4 | 未实现 | 暂不包含分支、fork、lane、operation ledger、搜索 |
| TUI 组件系统 | 已实现并接入 CLI | 采用自包含 Pi 契约架构（Component、Container、FocusManager、OverlayStack），接入真实 CLI 入口 |
| 项目本地扩展 | 已实现 | `.uina/extensions/*.ts|js`、`activate(pi)`、dispose/reload、旧 ctx 失效、资源归属清理 |
| 扩展 UI 契约 | 已实现 | `ctx.ui` 与注册 API 分离；CustomMessage 进模型上下文，CustomEntry 仅持久化/转录 |
| 图片和多模态 | 未实现 | v0 只有文本输入 |
| provider 重试 | 已实现 | OpenAI-compatible、Anthropic、Gemini 共用可取消指数重试；真实服务端策略仍需凭据 smoke |
| Anthropic/Gemini 协议闭环 | 已实现 localhost | 严格终止原因、usage 合并、工具名称回放、拒绝/未知错误与 CLI 纵切已有 fixture；真实服务端仍未验证 |
| 审批/权限策略 | 未实现 | 采用当前账户权限的可信工作区模型 |
| 后台 Job | 已实现 | `src/extensions/jobs` 提供 JobRegistry、输出游标、取消和完成通知 |

## 参考原则

- Pi 的控制流可读性、双队列送达点、默认并行工具和 JSONL 追加记录值得复用。
- Pi 的完整 session 分支模型只有在 Uina 出现 fork、搜索或多会话需求后再引入。
- 当前不增加 Pi 没有实际需求支撑的超时、审批、工具轮次或 Core 并发上限；DSH 已验证的 Jobs Extension per-owner 准入配置除外，且不得外溢为通用限制。
