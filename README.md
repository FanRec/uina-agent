# Uina v0

一个运行在本机终端中的最小 Agent。当前版本使用 TypeScript、Node.js 和流式 provider 适配器。

当前运行时边界、已验证行为与未验证项见 [docs/current-runtime.md](docs/current-runtime.md)；提案、参考和历史审查见 [docs/README.md](docs/README.md)。

## 运行

```bash
pnpm install
pnpm start
pnpm test
pnpm typecheck
pnpm build
```

一次性模式：

```bash
UINA_ONESHOT_MSG="你好" pnpm start
```

`pnpm build` 输出到 `dist/`。运行时源码通过 `tsx` 执行。

## 配置

配置文件为 `~/.uina/auth.json`，也可以通过 `UINA_HOME` 指定配置根目录：

```json
{
  "default": "deepseek",
  "thinkingLevel": "off",
  "providers": {
    "deepseek": {
      "type": "openai-compatible",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-...",
      "model": "deepseek-chat",
      "modelContextWindow": 65536,
      "maxContextWindow": 48000
    }
  }
}
```

`apiKey` 可由 `UINA_API_KEY_DEEPSEEK` 覆盖。配置会在启动时进行结构校验。

`modelContextWindow` 是模型真实物理上限，必须显式声明；`maxContextWindow` 是可选的用户限制，最终有效上限取两者较小值。旧 `contextWindow` 已移除。`type` 可选为 `openai-compatible`、`anthropic` 或 `gemini`，省略时使用 `openai-compatible`。Anthropic 和 Gemini 可以省略 `baseUrl`，使用各自官方 endpoint。思考等级支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，但可用档位必须由 `thinkingLevels`、可信模型目录或 Provider 明确提供；Uina 不再根据模型名称猜测。能力未知时只使用 `off`，界面显示未知而不是虚构默认值。TTY 默认显示思考流，非 TTY 可通过 `UINA_SHOW_THINKING=1` 显示。

Gemini 若某个已确认的模型要求在 function call/function response 中携带调用 ID，可显式设置 `geminiToolCallIds: true`；省略时不猜测模型能力，也不会自动添加协议字段。

## 目录

```text
src/
  agent/    前台循环、上下文、compaction、steer/followUp 队列
  ai/       配置、provider 适配、wire 转换和 SSE 协议解析
  core/     跨层类型
  session/  JSONL 追加日志、恢复和损坏尾行修复
  tools/    工具注册、schema 校验和执行
  extensions/runtime-tools/  内置工具实现，由 builtin activation 注册
  ui/       终端渲染
  cli/      入口组装和退出生命周期
  main.ts   程序入口
```

## 会话

会话保存在 `data/session.jsonl`。文件首行为 header，之后每行是消息、compaction 或生命周期事件。事件按顺序追加并同步 flush。

启动时会重放 JSONL。最后一行如果只是未完成的 JSON 写入，会通过原子替换修复；中间损坏记录会拒绝启动。工具已启动但没有完成记录时，恢复为 `unknown`，不会推断其成功。

旧版 `data/session.json` 不再读取，也不再生成。

## 输入和中断

- 空闲时输入直接开始一轮。
- TTY 流式期间普通 Enter 进入 `steer` 队列，在下一次模型请求前送达。
- TTY 流式期间 Alt+Enter（或 Tab）进入 `followUp` 队列，当前运行结束后送达；空闲时 Alt+Enter 在编辑器中换行。
- Shift+Enter 在编辑器中换行。
- 管道输入进入 `followUp` 队列。
- `/stop` 或 Ctrl+C 只中断当前模型/工具。待处理消息保留并显示在输入行中，用户重新提交后才继续。
- `/quit` 等待当前轮次、shell 命令和 session 写入完成后退出。
- `!command` 直接使用当前账户权限执行，不进入模型上下文；多个 `!` 命令串行执行。

TTY 输入区支持多行编辑与粘贴折叠，恢复多个队列消息时按换行分隔显示，顺序不变。

## 工具

所有工具都由 ActivationScope 注册。内置工具位于 `src/extensions/runtime-tools/`，通过 `builtin:runtime-tools` 激活；项目扩展位于 `.uina/extensions/`，在 `activate(pi)` 中调用 `pi.registerTool()`。Uina 不再扫描 `tools/` 目录或从资源事件动态加载工具文件。

工具声明包含 OpenAI function schema。启动时编译 schema，调用前使用 Ajv 校验参数。工具名必须全局唯一，`Tool.run` 返回 `{ result: string, status: ToolResultStatus }`。状态为 `succeeded`、`failed`、`cancelled`、`unknown` 或 `not_started`，由工具明确给出，Broker 不解析结果正文猜测成败。例如：`return { result: "done", status: "succeeded" }`。`tool_result` hook 同样使用 `status`，替代原来的 `isError`；仅修改正文时会保留原状态。

S1 新增 JSONL `input` 记录，以一次提交完成队列到会话的移交。新代码仍能读取原有合法 v2 日志，但旧代码不能读取包含新 `input` 记录或 S3 部分 usage 的日志，也不能正确回放新增的 Provider 块元数据。回退时应使用升级前备份或独立会话目录；不要直接让旧代码打开已经写入新记录的会话。具体合同与验证见 [当前运行时](docs/current-runtime.md)。

`exec_command` 通过 PowerShell 7、Windows PowerShell 5.1 或 `cmd.exe` 执行 Windows 命令，Unix 使用 `/bin/sh`。它不提供审批、沙箱、超时或白名单，权限等同于当前进程账户。

stdout/stderr 各自限制展示为 50 KB 或 2000 行，并保留尾部；超过限制后完整输出持续写入临时文件。

## 当前边界

当前已通过类型检查、281 项测试和构建；localhost 覆盖 OpenAI-compatible、Anthropic、Gemini 协议。真实 DeepSeek v4 Flash 已验证思考控制、usage、取消，以及文件事件 → 后台工作 → 结果回注、用户响应与安静决定。其他真实服务和真实 TTY/IME 仍未验证。详情见 [交付记录](docs/history/reviews/2026-09-05-plan-delivery.md)。

真实 DeepSeek、Ollama、真实终端 IME 和跨平台 shell 仍需在对应环境单独验证。长期记忆、语音、视觉、动态能力筛选、后台 Job、RPC 和权限审批不属于 v0。
