# Uina

运行在本机终端里的**数字主体运行时**：一个主体、一条连续记忆、一组可插拔能力。TypeScript / Node.js。

它的长期目标是开放式数字主体，但当前版本只承诺能被代码与测试验证的东西：

- **连续记忆**：跨目录、跨重启续写同一条会话主线，可查看节点与回溯；模型与思考度也随重启保持。
- **显式优先**：上下文上限、思考档位、协议字段全部由配置声明。缺了就报错并指出字段，绝不替模型发明默认值；能力未知就显示未知。
- **机制与策略分离**：Core 提供运行机制，能力与策略归扩展和组合根。

当前运行边界与未验证项见 [docs/current-runtime.md](docs/current-runtime.md)。

## 目录

- [快速开始](#快速开始)
- [配置：`~/.uina/auth.json`](#配置uinaauthjson)
- [数据落盘与恢复](#数据落盘与恢复)
- [环境变量](#环境变量)
- [命令行](#命令行)
- [交互](#交互)
- [内置工具](#内置工具)
- [会话与回溯](#会话与回溯)
- [扩展](#扩展)
- [项目结构](#项目结构)
- [开发](#开发)
- [当前边界](#当前边界)
- [排错](#排错)

## 快速开始

### 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 22 |
| 包管理器 | pnpm（仓库带 `pnpm-lock.yaml`；`corepack enable` 即可获得） |
| 终端 | 交互界面需要真 TTY；Windows / macOS / Linux 均可运行 |

Windows 附带 x64 / arm64 预编译原生附件，仅用于识别物理 Shift / Ctrl 键（区分 `Shift+Enter` 与 `Enter`）；其他平台自动跳过，不影响使用。

### 1. 克隆

```bash
git clone https://github.com/FanRec/uina-agent.git
cd uina
pnpm install
```

### 2. 配置

Uina 启动时读取 `~/.uina/auth.json`；文件不存在会直接报错并打印它要找的路径，不会静默退化。

```bash
mkdir -p ~/.uina
```

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force "$HOME\.uina"
```

最小可用配置（照抄后替换 `apiKey`）：

```json
{
  "default": "deepseek",
  "providers": {
    "deepseek": {
      "type": "openai-compatible",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-...",
      "model": "deepseek-chat",
      "modelContextWindow": 65536
    }
  }
}
```

不想把密钥写进文件，就留空 `apiKey` 并改用环境变量：

```bash
export UINA_API_KEY_DEEPSEEK=sk-...
```

```powershell
$env:UINA_API_KEY_DEEPSEEK = "sk-..."
```

### 3. 运行

```bash
pnpm start                      # 进入交互界面
pnpm start "帮我看下这个仓库"    # 带任务启动，自动执行
```

进入后输入 `/help`，可查看全部命令与快捷键。

### 4.（可选）安装为全局命令

不想每次 `cd` 进仓库再 `pnpm start`，可以把它注册成全局命令 `uina`：

```bash
pnpm build        # 先构建出 dist/
npm link          # 在全局 bin 目录创建指向本仓库的软链接
```

之后在任意目录直接运行：

```bash
uina              # 任意目录进入交互会话
git diff | uina "总结这次改动"   # 管道也一样可用
```

几点说明：

- `npm link` 的工作方式：在系统的全局 `node_modules` 里创建一个指向**本仓库目录**的软链接（不是复制）。因此在仓库里 `git pull` 或改完代码后，只需重新 `pnpm build`，全局 `uina` 立即用上新版——不用重新 link。
- 仓库移动、重命名或删除后，软链接会失效，重新执行 `npm link` 即可。
- 卸载：回到本仓库目录执行 `npm unlink -g uina`（或任何目录 `npm rm -g uina`）。
- Windows 首次 `npm link` 后如果提示 `uina` 不是命令，新开一个终端让 PATH 生效即可。
- 如果你不想动全局环境，替代方案是在 shell 配置里加一个 alias：`alias uina="node <仓库路径>/dist/src/main.js"`（同样需要先 `pnpm build`）。

## 配置：`~/.uina/auth.json`

一份配置可以声明多个 provider，`default` 指定启动时用哪一个。配置在启动阶段完成结构校验，错误会指名 provider 与字段。

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `default` | string | 是 | 默认 provider 名，必须存在于 `providers` |
| `providers` | object | 是 | `{ "<名字>": { ... } }`，名字即 provider 名 |
| `thinkingLevel` | string | 否 | 启动时的思考档位，取值见下 |

思考档位取值为 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。

### provider 字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | **是** | 写入请求的模型 id |
| `baseUrl` | string | 见说明 | `openai-compatible` 必填；`anthropic` / `gemini` 可省略，用官方端点 |
| `apiKey` | string | **是** | 可用环境变量 `UINA_API_KEY_<名字大写>` 覆盖 |
| `modelContextWindow` | number | **是** | 模型真实上下文上限。Uina 不猜，缺失即报错 |
| `type` | string | 否 | `openai-compatible`（默认）/ `anthropic` / `gemini` |
| `maxContextWindow` | number | 否 | 你的自设上限；生效值取它与 `modelContextWindow` 较小者 |
| `maxOutputTokens` | number | 见说明 | 输出上限；**Anthropic 协议必填**（`/messages` 要求 `max_tokens`） |
| `maxRetries` | number | 否 | 请求重试次数，非负整数 |
| `thinkingLevels` | string[] | 否 | 该模型支持的思考档位。省略即「未知」，界面显示未知而不是猜一个 |
| `thinkingBudgets` | object | 见说明 | 档位 → 数值预算（如 `{ "high": 8192 }`）。Anthropic，或 Gemini 且 `geminiThinkingFormat: "budget"` 时，非 `off` 档位必须有对应值 |
| `thinkingFormat` | string | 否 | openai-compatible 的思考载体：`openai` / `deepseek` / `qwen` |
| `geminiThinkingFormat` | string | 见说明 | `level` 或 `budget`；Gemini 声明了 `thinkingLevels` 时必填（`level` 仅能表达 `minimal`/`low`/`medium`/`high`） |
| `geminiToolCallIds` | boolean | 否 | 仅当已确认该模型要求 function call 携带调用 id 时置 `true` |
| `imageInput` | boolean | 否 | 置 `false` 时拒绝图片输入；省略时保持未知，不阻拦请求 |
| `includeThinking` | boolean | 否 | 是否把思考历史投影进上下文；省略时按协议推导 |

已被移除的旧字段：`contextWindow`。请改用 `modelContextWindow`，需要自设上限再叠加 `maxContextWindow`；写旧字段会在启动时明确报错。

### 三种协议的示例

**OpenAI 兼容**（DeepSeek、Qwen、本地推理服务等）：

```json
{
  "default": "deepseek",
  "providers": {
    "deepseek": {
      "type": "openai-compatible",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-...",
      "model": "deepseek-chat",
      "modelContextWindow": 65536,
      "maxOutputTokens": 8192,
      "thinkingLevels": ["off", "high", "max"],
      "thinkingFormat": "deepseek",
      "thinkingBudgets": { "high": 8192, "max": 16384 }
    }
  }
}
```

**Anthropic**（`maxOutputTokens` 与各档位预算都不能省）：

```json
{
  "default": "claude",
  "providers": {
    "claude": {
      "type": "anthropic",
      "apiKey": "sk-ant-...",
      "model": "claude-sonnet-4-5",
      "modelContextWindow": 200000,
      "maxOutputTokens": 8192,
      "thinkingLevels": ["off", "low", "high"],
      "thinkingBudgets": { "low": 4096, "high": 16384 }
    }
  }
}
```

**Gemini**（声明档位就必须说明 wire 形式）：

```json
{
  "default": "gemini",
  "providers": {
    "gemini": {
      "type": "gemini",
      "apiKey": "AIza...",
      "model": "gemini-2.5-pro",
      "modelContextWindow": 1048576,
      "maxOutputTokens": 8192,
      "thinkingLevels": ["off", "low", "high"],
      "geminiThinkingFormat": "budget",
      "thinkingBudgets": { "low": 2048, "high": 8192 }
    }
  }
}
```

### 多 provider 与切换

界面里用 `/model` 打开选择面板，或 `/model <名字>` 直接切换；命令行用 `-m <名字>` 临时指定。名字可以是 provider 名（`deepseek`），也可以是 `provider/model` 形式（`deepseek/deepseek-chat`）。

## 数据落盘与恢复

| 路径 | 内容 | 谁来写 |
| --- | --- | --- |
| `~/.uina/auth.json` | 凭据与 provider 配置 | 你（手工维护） |
| `~/.uina/settings.json` | 会话偏好：模型、思考档位 | 界面自动写，重启自动恢复 |
| `~/.uina/session.jsonl` | 会话主线记忆 | Uina 逐条追加 |

会话偏好优先级：命令行 `-m` > `settings.json` > `auth.json` 的 `default`。`settings.json` 里的值失效（模型删了、档位不支持）会被静默忽略，不阻塞启动；也可以手工编辑，但一般不必。

会话路径优先级：`UINA_SESSION_PATH` > 当前目录 `data/session.jsonl`（存在则沿用，便于在源码仓库里开发）> `~/.uina/session.jsonl`。加 `--no-session` 则只在内存里跑，不读历史也不留痕迹。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `UINA_HOME` | 配置根目录，默认 `~`；实际读取 `$UINA_HOME/.uina/…` |
| `UINA_API_KEY_<名字大写>` | 覆盖对应 provider 的 `apiKey` |
| `UINA_SESSION_PATH` | 显式指定会话日志路径 |
| `UINA_ONESHOT_MSG` | 一次性提问：打印回答后退出，等价于 `-p` |

## 命令行

```text
uina [选项] [prompt...]
```

| 参数 | 说明 |
| --- | --- |
| `prompt...` | 初始任务；进入交互界面后自动执行 |
| `-p`, `--print` | 批处理模式：流式打印回答后立即退出 |
| `-m`, `--model <名字>` | 临时覆盖本次会话的模型 |
| `-e`, `--extension <路径>` | 加载扩展文件或目录，可重复 |
| `--no-session` | 纯内存模式：不读历史、不写盘 |
| `-v`, `--version` | 打印版本 |
| `-h`, `--help` | 打印帮助 |

几个常用形态：

```bash
uina                                   # 交互会话
uina "重构 src/agent 的队列逻辑"        # 带任务启动
uina -m deepseek/deepseek-chat         # 指定模型
uina -p "生成一个随机密码"              # 一次性输出，适合脚本
git diff | uina "总结这次改动"          # 管道内容作为上下文
```

非 TTY 环境下带 prompt 会自动进入打印模式。

## 交互

### 输入与队列

空闲时 `Enter` 直接开始新一轮；正在运行时，输入不会打断当前回合，而是排队等送达时机。

| 操作 | 行为 |
| --- | --- |
| `Enter`（空闲） | 发送并开始新一轮 |
| `Enter`（运行中） | 进入 steer 队列，下一次模型请求前送达 |
| `Tab` / `Alt+Enter`（运行中） | 进入 followUp 队列，本轮结束后依序处理 |
| `Ctrl+Enter` | 打断当前回合并立即投递 |
| `Shift+Enter` | 换行（空闲时 `Alt+Enter` 同效） |
| `Esc` | 收起浮层；运行中打断并递送待办 |
| `Ctrl+C` / `/stop` | 运行中打断当前回合；空闲时退出 |
| `!command` | 直接用当前账户权限执行，不进模型上下文 |
| `?`（空行） | 唤出 / 收起帮助面板 |

被打断时未处理的消息会保留在输入行，重新提交后继续。

### 快捷键

| 快捷键 | 面板 |
| --- | --- |
| `Alt+H` | 会话历史与分支检视 |
| `Alt+J` | 后台任务与进程 |
| `Alt+A` | 子智能体 |
| `Alt+T` | 审计轨迹时序 |
| `Shift+Tab` | 循环切换思考强度 |
| `Ctrl+O` | 展开 / 收起光标处内容（粘贴标记、思考、会话卡片） |
| `Alt+O` | 全展开 / 全折叠思考链 |
| `Alt+↑` / `Alt+Q` | 撤回待办队列到草稿 |

### 斜杠命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 全部命令与快捷键 |
| `/model [名字]` | 无参打开模型面板；有参直接切换 |
| `/effort [档位]` | 无参打开强度滑块；有参直接设定 |
| `/compact [要求]` | 压缩会话历史，释放上下文空间 |
| `/session` | 查看用量与上下文构成 |
| `/history`、`/branches` | 会话历史与分支 |
| `/tasks` | 后台任务看板 |
| `/subagents` | 子智能体看板 |
| `/trajectory` | 审计轨迹时序 |
| `/rewind <节点 id> <原因>` | 回溯主线（不撤销文件与后台任务） |
| `/think` | 展开或折叠深度思考 |
| `/clear` | 清空屏幕转录 |
| `/gutter` | 切换右侧导航轨样式 |
| `/reload` | 重载项目与本地扩展 |
| `/quit` | 等待当前轮次与写入完成后退出 |

## 内置工具

模型可调用以下工具，全部通过与其他扩展相同的注册接口挂载：

| 工具 | 说明 |
| --- | --- |
| `read_file` | 读 UTF-8 文本，可按 `offset` / `limit` 读片段 |
| `write_file` | 覆盖写入文件 |
| `edit_file` | 精确文本替换：`edits[]` 中每个 `oldText` 必须在文件中唯一，一次调用可携带多个不相交编辑；自动适配 LF/CRLF 行尾并保留 BOM || `read_image` | 按文件签名读取 PNG / JPEG / GIF / WebP |
| `exec_command` | 执行系统命令（Windows 走 PowerShell / `cmd`，Unix 走 `/bin/sh`） |
| `get_time` | 当前日期时间 |
| `job_list` / `job_output` / `job_kill` | 后台任务：列出、读取增量输出、取消 |
| `subagent_start` / `subagent_list` / `subagent_status` / `subagent_output` / `subagent_messages` / `subagent_send` / `subagent_interrupt` | 子智能体：启动、观察、追问、中断 |
| `session_list` / `session_read` / `session_rewind` | 读取历史节点并回溯 |

`exec_command` **没有**审批、沙箱、超时或白名单，权限等同于当前进程账户；请自行判断在什么目录下运行。工具结果必须显式给出 `succeeded` / `failed` / `cancelled` / `unknown` / `not_started`，Uina 不解析正文猜测成败。

## 会话与回溯

会话逐条追加写入 `session.jsonl`：首行是 header，之后每行是消息、压缩或生命周期事件，写入即 flush。

启动时重放日志。末行若是未完成的写入会被原子修复；中间记录损坏则拒绝启动。工具已启动但没有完成记录时，恢复为 `unknown`，不推断为成功。

回溯（`/rewind` 或模型的 `session_rewind`）只改会话主线，**不会**撤销文件修改、后台任务或已发出的外部调用；被放弃分支启动的后台任务完成时会明确标注来源。详见 [docs/session-rewind.md](docs/session-rewind.md)。

## 扩展

项目扩展放在工作目录的 `.uina/extensions/`，在默认导出的 `activate(api)` 里注册工具、命令、服务或压缩策略：

```ts
export default function activate(api) {
  api.registerCommand({
    name: "hello",
    description: "打个招呼",   // 会出现在 /help 里
    handler: () => api.ui.notify("hello"),
  });
}
```

同一个文件里也可以注册工具、服务与上下文贡献者。TypeScript 类型入口是 `src/extensions/index.js`（`ExtensionAPI`），仓库内可加载的示例见 `examples/extensions/`。

临时加载可复用示例：`uina -e examples/extensions/skills`。契约与取舍见 [docs/extensions.md](docs/extensions.md)、[docs/extensions-development.md](docs/extensions-development.md)，示例见 [examples/README.md](examples/README.md)。

## 项目结构

```text
src/
  main.ts        进程入口
  cli/           组合根：建宿主、接一个消费者、处理信号与退出
  host/          主体生命周期所有者，对外只有输入入口与事件流
  agent/         前台循环、上下文投影、压缩、steer / followUp 队列
  ai/            配置、provider 适配、wire 转换、SSE 解析
  session/       JSONL 追加日志、恢复、损坏尾行修复
  tools/         工具注册、schema 校验与执行
  extensions/    扩展契约、加载、内置能力（运行时工具 / 任务 / 子智能体）
  ui/            终端消费者：渲染、输入、焦点、组件组合
  core/          跨层类型
docs/            运行时事实、提案与历史审查
examples/        可加载的示例扩展
```

## 开发

```bash
pnpm start          # 源码直接运行（tsx）
pnpm dev            # watch 模式
pnpm test           # 全量测试（vitest）
pnpm typecheck      # 类型检查 + 分层边界检查
pnpm build          # 构建到 dist/
```

其他验证脚本：`pnpm verify:cli`（编译产物冒烟）、`pnpm verify:file-events`（文件事件扩展，需要真实运行环境）。

## 当前边界

诚实起见，把「已验证」与「未验证」分开：

- **已验证**：类型检查、全量测试、构建；协议层在 localhost 上覆盖 OpenAI 兼容 / Anthropic / Gemini；真实 DeepSeek 验证过思考控制、usage、取消，以及「文件事件 → 后台任务 → 结果回注」的完整往返。
- **未验证**：其他真实服务；真实终端下的 IME 与键位；macOS / Linux 实机。
- **不在当前范围**：长期记忆、语音、视觉、动态能力筛选、权限审批、RPC。

## 排错

报错都指名了 provider 与字段。按字面对应处理即可：

| 报错 / 现象 | 处理 |
| --- | --- |
| `找不到配置 <路径>，请按仓库 README 创建 ~/.uina/auth.json` | 还没建配置文件，见[快速开始](#快速开始) |
| `模型 <名> 缺少 modelContextWindow；Uina 不会猜测真实上下文上限` | 补上该 provider 的 `modelContextWindow` |
| `provider "x" 缺少 apiKey（请在 … 填写，或用环境变量 UINA_API_KEY_X 提供）` | 填 `apiKey`，或设 `UINA_API_KEY_X` |
| `… 使用了已移除的 contextWindow；请改为 modelContextWindow 和可选 maxContextWindow` | 换新字段名，旧名不再接受 |
| `… 使用 Anthropic 协议：/messages 必须显式给出 max_tokens，请在配置中提供 maxOutputTokens` | 补 `maxOutputTokens` |
| `… 声明了 thinkingLevels 但缺少 geminiThinkingFormat（"budget" 或 "level"）` | 声明档位就得说明 wire 形式 |
| `… 的 geminiThinkingFormat: "level" 无法编码档位 <档位>；请改用 "budget" 或修正 thinkingLevels` | `level` 只能表达 `minimal`/`low`/`medium`/`high` |
| 界面显示「未声明思考档位」 | 该 provider 没写 `thinkingLevels`；Uina 不猜可用档位，写上才有 |

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/current-runtime.md](docs/current-runtime.md) | 当前运行事实与边界 |
| [docs/extensions.md](docs/extensions.md) | 扩展设计与权衡 |
| [docs/session-rewind.md](docs/session-rewind.md) | 会话与回溯设计 |

## 许可证

[MIT](LICENSE)。
