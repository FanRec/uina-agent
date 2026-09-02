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
  tools/    工具代理 + 内置工具（shell 等）
  mind/     上下文组装 + 前台循环（主体）        ← 决策与表达
  ui/       简易 TUI（流式渲染 + 工具状态反馈）
  main.ts   入口：终端输入 + 组装
```

数据落在 `data/`（gitignore）：`session.json`（会话历史）。长期记忆已移除（见"刻意删除"）。

## 当前切片验证范围

- 流式输出（token 逐段，非整块）
- 工具闭环：模型提议 → 确定性执行 → 结果回注再决策（协议层 wire 转换有单测）
- 工具状态反馈：调用中 `[工具] xxx` → 完成 `✓`（吸收 Nott 的状态可见性）
- `run_shell`：沙箱内执行命令（baseDir 限定、超时、截断；无白名单，属副作用工具）
- `get_time`：同步快工具（无副作用，工具闭环的测试锚点）
- 会话续聊：`--continue` 恢复上次对话历史（吸收 Nott 的会话持久化，最小版）
- 输出期间输入排队，轮末批量注入

## 刻意删除（2026-09-02 reality-pass，详见 DESIGN.md）

事件总线、运行时状态、输出广播代理、后台 Job 演示（`think_for`）、记忆 kind 维度、**整个长期记忆模块（工具对 + 后端 + 自动 recall 注入）**——无真实消费者/演示性机制一律删，主体只剩 hooks 直连的最小环。

> 记忆决策（空纪 2026-09-02 定）：目前先不考虑愿景，从最小 agent 出发，"少即是多"；最小切片的"记忆"= 会话续聊（session.json）。愿景#3 长期记忆待到有真实需求时再迭代回来（届时后端可直接接向量化）。

## 未实现（长大路径，见 DESIGN.md）

1.8s 语音链路、向量记忆（本机已有 bge-m3）、感知通道、能力动态加载、人格/主动性层、提示词配置化。
