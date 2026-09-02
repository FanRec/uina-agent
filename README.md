# Uina — 最小 Agent（切片 v0）

住在计算机里的独立个体。TypeScript，自研轻量 Agent 循环，OpenAI 协议模型。

## 运行

```bash
pnpm install
pnpm start               # 终端对话（/quit 退出）
pnpm start -- --continue # 恢复上次会话的对话历史
pnpm test                # 冒烟 + gateway 测试
```

一次性提问（真实模型冒烟/回归）：

```bash
UINA_ONESHOT_MSG="你好" pnpm start
```

## 配置

模型走 OpenAI 协议，配置在 `~/.uina/auth.json`（镜像 pi 的 `~/.pi/agent/auth.json`）：

```json
{
  "default": "deepseek",
  "providers": {
    "deepseek": { "baseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-...", "model": "deepseek-chat" }
  }
}
```

apiKey 也可用环境变量 `UINA_API_KEY_DEEPSEEK` 覆盖，避免写盘。

## 目录结构（边界）

```
src/
  ai/       模型网关（OpenAI SSE 流式）、配置   ← 外部模型边界
  tools/    工具代理（broker） + 自动发现（loader）
  mind/     上下文组装 + 前台循环（主体）        ← 决策与表达
  ui/       简易 TUI（流式渲染 + 工具状态反馈）
  main.ts   入口：终端输入 + 组装
tools/               ← 工具目录（pi 同款自动发现：顶层 .ts 或子目录 index.ts）
  get-time/          默认导出 Tool（get_time）
  exec-command/     默认导出 Tool（exec_command）
```

数据落在 `data/`（gitignore）：`session.json`（会话历史）。长期记忆已移除（见"刻意删除"）。

## 添加新工具（3 步）

1. 在 `tools/` 下新建一个文件或子目录（`tools/你的工具/index.ts`）
2. 默认导出 `Tool` 对象：`{ def: { type: "function", function: { name, description, parameters } }, run: async (args) => string }`——参数描述写在内联 JSON Schema 里（`properties.command.description`），对齐 pi 的显式声明风格；也可默认导出 `Tool[]` 或注册函数 `(registry) => void`（pi registerTool 形态）
3. 重启即自动发现注册（启动日志显示工具数）；无需改 main.ts

引擎只有两个约束：工具 `name` 全局唯一（重名报错）；`run` 必须返回字符串（返回给模型的结构化结果）。

## 当前切片验证范围

- 流式输出（token 逐段，非整块）
- 工具闭环：模型提议 → 确定性执行 → 结果回注再决策（协议层 wire 转换有单测）
- 工具状态反馈：调用中 `⏳ [工具] xxx 参数` → 完成 `✓ name` + 结果折叠区首屏（stdout 摘要几行、error 红字/取消黄字、耗时；对齐 pi 展示形态）
- `exec_command`：执行一条系统命令（PowerShell）（全盘；无超时/无白名单——对齐 pi，且系副作用工具，模型提议、放行决策留给未来授权层；输出截断 50KB/2000 行，超限留临时文件指针）
- `get_time`：同步快工具（无副作用，工具闭环的测试锚点）
- 工具自动发现：`tools/` 目录扫描加载（loader，对齐 pi 的 extensions 机制；三种导出形态 + 坏模块隔离有单测）
- 会话续聊：`--continue` 恢复上次对话历史（吸收 Nott 的会话持久化，最小版）
- 输出期间输入排队，轮末 drain 循环持续消费到空（防滞留：批量段期间到达的输入也必被处理）
- 错误成环：轮处理出错进历史（模型下轮可见可纠正）+ onError 钩子结构化显示
- 强制中断：`Ctrl+C`（有轮→中断/空闲→退出）+ `/stop` 命令 + 工具/LLM 请求 abort（杀进程树 + 切断流式请求）
- `!` 命令：强制终端执行（`!npm test` 直跑 shell，经不经模型，不进上下文；执行中 Ctrl+C 可杀；模型处理中拒绝执行防输出交错）
- 管道输入：`echo "你好" | pnpm start` 非 TTY 下同样可用（行到位即处理，EOF 后落盘退出）

## 刻意删除（2026-09-02 reality-pass，详见 DESIGN.md）

事件总线、运行时状态、输出广播代理、后台 Job 演示（`think_for`）、记忆 kind 维度、**整个长期记忆模块（工具对 + 后端 + 自动 recall 注入）**——无真实消费者/演示性机制一律删，主体只剩 hooks 直连的最小环。

> 记忆决策（空纪 2026-09-02 定）：目前先不考虑愿景，从最小 agent 出发，"少即是多"；最小切片的"记忆"= 会话续聊（session.json）。愿景#3 长期记忆待到有真实需求时再迭代回来（届时后端可直接接向量化）。

## 限制取舍（2026-09-02）

第一刀（空纪反馈：限制太多影响体验）：删 `baseDir` 沙箱（软限制防不住逃逸却锁正常使用）、放宽输出截断/工具轮/历史条数——只留硬护栏。

**第二刀（空纪指令：限制条件严格对齐 pi——pi 没有的 Uina 不能有，pi 取多少取多少）**：

| 项 | 对齐后状态 | pi 依据 |
| --- | --- | --- |
| 命令超时 | **无**（exec 不设 timeout，挂死靠用户打断） | pi 的 bash 无超时 |
| 工具轮上限 | **无**（模型产出 tool_calls 即继续） | pi 无轮/调用上限 |
| 历史条数 | **无硬截断**；上下文用 compaction 管理 | pi 无条数截断 |
| compaction | token 估算超 `contextWindow(64K) − reserve(16384)` 时，保留最近 `keepRecentTokens(20000)`，更旧的让模型压缩成摘要（迭代上下文） | pi：reserve=16384、keepRecent=20k（可配置） |
| 工具输出截断（工具层） | 50KB / 2000 行，先到为准，保尾；截断时标记 + 完整输出存临时文件给路径 | pi 内建工具 limit：50KB / 2000 行，truncateTail 策略，temp file 指针 |
| 工具消息进上下文/会话（序列化层） | 截断到 2000 字符 + 标记 | pi：tool results serialized 2000 chars |
| 工具失败 | 结构化结果回注（不抛） | pi：result{output,exitCode,cancelled,truncated,isError} |
| 密钥 | ~/.uina/auth.json + 环境变量覆盖，不进 git | pi：~/.pi/agent/auth.json + env |
| 权限模型 | 运行进程的用户账户权限（不做进程内拦截） | pi：同款信任模型 |

## 未实现（长大路径，见 DESIGN.md）

1.8s 语音链路、向量记忆（本机已有 bge-m3）、感知通道、能力动态加载、人格/主动性层、提示词配置化。
