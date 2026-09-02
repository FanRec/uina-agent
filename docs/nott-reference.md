# Nott 参考对照（Uina v0）

> 来源：E:/AI_Project_Learn/Nott/nott-csharp（2026-09-02 通读 16 个 cs 文件）
> 定位：C#/.NET 8 + OpenAI 官方 SDK + Spectre.Console 的最小 agent 切片——"会话级终端助手"，无记忆、无长任务、无多通道。

## 结构（四层）

```
CLI（Program/Application：REPL + 一次性提问 + AgentState 驱动渲染）
 → AgentSession（guid + ChatMessageStorage，byte 序列化续聊）
  → AgentLoop（流式循环 + finish reason 分发 + 状态机事件）
   → AgentToolStorage（反射装载 [NottChatTool] 特性方法 → schema 自动推导）
```

## 对 Uina 值得吸收的点

1. **状态反馈渲染**（最值得抄）：AgentState（Action/ReplyingStreaming/ToolCalling/LoopFinished）+ onAgentStateChanged 事件 → CLI 清行/换 spinner/打绿勾。Uina TUI 缺工作状态可见性——"思考中/工具调用:xxx/回复中"。
2. **会话序列化续聊**：完整消息序列（assistant tool_calls 与 tool 结果对应关系）往返序列化，--session 恢复。这是愿景#3 长记忆的第一级台阶（不可变 event log 的雏形）。
3. **exec-command 细节**：stdout/stderr 分捕 + exitCode + UTF8 + 取消时 Kill(processTree)；空命令返回文本而非抛错。我们 shell.ts 已有额外优势：baseDir 沙箱 + 15s 超时 + 输出截断。

## 不借鉴（缺陷）

- FinishReason.Length/ContentFilter → throw，整轮崩溃（违背 f9 错误回注自愈原则）
- 无上下文截断，历史全量入 context（长会话必膨胀）
- System prompt 硬编码在 Application.Run()（与 Uina 同病，待"提示词配置化"一并解决）
- 反射生成 schema 牺牲可观察性/可审计性（TS 下保持显式 schema）

## 对 Uina 的落地清单

- [ ] TUI 加状态反馈渲染（立即，小活）
- [ ] 会话续聊（成长清单：不可变 event log + 投影的第一级）
