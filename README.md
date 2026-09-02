# Uina — 最小 Agent（切片 v0）

住在计算机里的独立个体。TypeScript，自研轻量 Agent 循环，OpenAI 协议模型。

## 运行

```bash
pnpm install
pnpm start        # 终端对话（/quit 退出）
pnpm test         # 冒烟 + gateway 测试
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
  core/     事件总线、运行时状态、公共类型      ← agent 形态无关的地基
  ai/       模型网关（OpenAI SSE 流式）、配置   ← 外部模型边界
  memory/   记忆端口（write/recall/use/correction，文件后端）
  tools/    工具代理 + 内置工具（shell 等）
  mind/     上下文组装 + 前台循环（主体）        ← 决策与表达
  main.ts   入口：终端输入通道 + 组装
```

数据落在 `data/`（gitignore）。

## 当前切片验证范围

- 流式输出（token 逐段，非整块）
- 工具闭环：模型提议 → 确定性执行 → 结果回注再决策
- `run_shell`：沙箱内执行命令（baseDir 限定、超时、截断；无白名单，属副作用工具）
- `remember`/`recall`/`forget`：记忆 write/read/correction，跨进程持久（重启仍在）
- `think_for`：后台 Job，完成以 `job_done` 事件唤醒主体
- 输出期间输入排队，轮末批量注入

## 未实现（长大路径，见 DESIGN.md）

1.8s 语音链路、向量记忆（本机已有 bge-m3）、感知通道、能力动态加载、人格/主动性层。
