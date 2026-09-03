# Nott 参考

Nott 是会话级终端助手。Uina 从中借鉴了两个适合当前切片的实现点：工具执行状态反馈，以及会话消息持久化。

## 已吸收

- `LoopHooks` 将 tool start、tool done、error、notice 和 queue 状态交给 UI；UI 不参与状态转移。
- Uina 使用 JSONL 追加日志保存消息和工具生命周期，并在启动时恢复未知工具结果。
- shell 继续采用 stdout/stderr 分流、UTF-8 解码、进程树取消和结构化结果。

## 不照搬

- 不使用反射生成工具 schema，工具保持显式 JSON Schema 并由 Ajv 校验。
- 不把错误 finish reason 当作正常回复。
- 不使用整体 JSON 快照保存会话。
- 不在当前 v0 引入 Nott 未提供真实证据的长期记忆或后台任务。

## 当前限制

Uina 的 readline 输入区是单行编辑器，尚未具备 Pi/Nott 级组件式 TUI。真实 provider、真实终端键盘行为和复杂会话操作需要单独验证。
