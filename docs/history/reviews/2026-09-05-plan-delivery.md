# S2—S4 交付与证据

日期：2026-09-05。基线：`6b24c80` 加本次会话已完成的 S1 工作区改动。环境：Windows x64、Node v24.13.1、pnpm 11.5.2。未修改真实 auth 配置或真实会话数据；验证使用临时目录。长期记忆、TTS、持续宿主仍是后续候选。

## 实现结果

| 阶段 | 结果 | 证据 |
| --- | --- | --- |
| S2.1 | 手动 compact 占用主体活动及 AbortSignal，等待与 dispose 覆盖其完成；压缩期间拒绝冲突的历史修改；成功提交领域摘要后接续排队输入 | `activity-lifecycle.test.ts`：真实临时 JSONL，取消后历史不变，dispose 不早于 Provider 结束 |
| S2.2 | 取消控制抛错保留 stopping 和诊断，不抢占 producer.done 的结论；close 等待真正终态 | 同一测试验证后来 completed/failed 均保留真实结果 |
| S2.3 | AgentHandle、SubagentRegistry 从主体活动派生 running/idle；Registry 只维护关系、输出及释放原因 | 忙碌时追加子 Agent 输入仍为 running/busy=true，关闭后 settled/busy=false |
| S2.4 | 移除默认 10 个 Job 限额；显式 maxActivePerOwner 仍可配置 | 默认接受 12 个待完成 producer |
| S3.1/2 | finish 后保留 usage-only 尾；非法后续内容仍报错；Usage 缺字段保持缺失，不合成完整实测总量 | Provider 协议测试、部分输入计量与上下文估算测试 |
| S3.3/5 | thinking 开关及力度有实际编码；已知能力与配置取交集；未知 UI 不补 off；setter/slider 不扩大档位；字符估算 token/TPS 标 `~` | thinking/provider/UI 测试及真实 DeepSeek 三档调用 |
| S3.4 | Gemini 签名位于 Part；Anthropic/Gemini 保留 adapter 自有有序块及签名，Core 仅传递不解释的 providerReplay | 签名层级、有序 text/thinking/redacted-thinking 回放测试 |
| S3.6 | 一次性错误退出非 0；构建复制 native 资源，加载失败可见 | 编译 CLI 独立 cwd 验收、x64 native 实际加载 |
| S4 | 普通扩展通过 submitInput 提交真实文件事件，后台结果共用入口；来源持久化；可读结果、保持安静、响应用户、取消与卸载 | 文件/子进程组合测试及真实 DeepSeek 场景 |

`ToolExecutionResult` 新增可选 `continuation: "stop"`：工具结果完成记录后结束当前决策，已排队的其他输入仍保留。该接缝来自安静场景的实际失败，不在 UI 中过滤回复文字。普通扩展还获得带来源的 `reportError`；本地扩展仍默认受信任。

运行时输入现在从统一 `input` 记录投影为隐藏 custom 领域消息，不再另留一份仅本轮有效的 runtimeInputs 状态。Provider 端使用标明“运行时事件”的内容；不会在会话或 TUI 中伪装成人类发言。

## 真实联调

Provider：默认配置的 `deepseek`，模型 `deepseek-v4-flash`，官方 `api.deepseek.com`。只读取现有凭据，未将其写入证据。

同一简单算术请求的实测：

| thinking | 回复 | 思考字符数 | 首段文本 | 总耗时 | usage |
| --- | --- | --- | --- | --- | --- |
| off | 42 | 0 | 779 ms | 871 ms | input 14、output 1、total 15 |
| high | 42 | 24 | 545 ms | 570 ms | input 93、output 16、reasoning 14、total 109 |
| max | 42 | 115 | 692 ms | 693 ms | input 106、output 31、reasoning 29、total 137 |

另一次 high 流式请求在 430 ms 收到首段输出后发出取消，7 ms 后观察到取消结算。此证据确认本次客户端取消路径，不证明远端计费已经立即停止。

文件事件完整场景使用同一真实模型、off 档。验收前目标：事件到模型请求小于 1 秒，普通用户首段回复小于 5 秒，用户在 6 秒后台命令结束前收到答复，shell 取消结算小于 5 秒。目标用于本次场景，不是生产环境新增的超时或额度。

实测完整时间线保留在 [s4-real.json](2026-09-05-plan-evidence/s4-real.json)。文件变化到模型请求为毫秒级；后台运行期间用户答复在 **715 ms** 到达。IGNORE 事件调用 watch_silence 后没有回复文本；实际 `exit 7` 失败得到通知并读取结果；取消后台 sleep 在 **523 ms** 后确认为 killed；卸载后再次修改文件未产生新输入。

该场景曾失败两次，原因与修正保留如下：

- 模型启动后台任务后调用同步 wait，用户回复延迟约 7.7 秒。示例改为即时结果快照与完成通知，通用 Job 等待能力仍保留。
- 模型把“不输出文本”的要求复述出来。增加显式安静工具及结束当前决策的生命周期接缝，随后真实场景通过；没有隐藏已生成的文本。

这些结果证明了这条具体的开放接缝与行为，不证明人格、自主意志或任意模型均能达到同样效果。

## 验证命令与边界

- `pnpm typecheck`：通过，包含 Core/Runtime 对扩展依赖的边界检查。
- `pnpm test`：15 文件、251 项通过。新增验证集中在活动、协议事实与文件事件的组合，不把 fixture 当真实模型。
- `pnpm build`：通过，示例与 native 资源进入 dist。
- `pnpm exec tsx scripts/verify-built-cli.mts`：compiled CLI 工具闭环 2 次请求、退出 0；协议断流错误可见、退出 1；Windows x64 native 导出实际加载成功。
- `pnpm exec tsx scripts/verify-file-events.mts`：真实模型、文件、后台进程、用户输入、安静、失败、取消、卸载全部通过。

没有验证真实 Anthropic/Gemini/Qwen 服务、真实 TTY/IME、Windows ARM native 的实际加载、跨平台 shell、实际断电、跨重启 producer 对账或长期负载。同步等待工具仍可能占用前台；本次事件示例用异步 producer 和通知保持交互，不声称所有工具组合都有统一延迟保证。

## 协议依据与兼容

thinking 编码与限制对照 [DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/)、[Gemini generateContent thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking)、[Gemini 3](https://ai.google.dev/gemini-api/docs/generate-content/gemini-3)、[Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[Qwen 深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)。不同 Gemini 协议档位可显式配置 `geminiThinkingFormat: "budget" | "level"`；已列出的 Gemini 3 型号使用 level，其余预算编码不等于自动证明模型支持。未声明的能力保持未知。

旧项目工具需迁移到 `{ result, status }`，hook 使用 status。新日志仍保留 v2 header，但旧 reader 不接受 input 记录、缺字段的 usage，也不能正确保留新增的 Provider 回放元数据。回退代码时使用升级前日志备份或隔离会话；本轮没有批量改写既有日志。新增真实验收脚本是显式调用工具，不在日常测试中自动访问外部 API。
