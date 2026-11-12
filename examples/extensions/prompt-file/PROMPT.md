# 示例扩展使用指南

这是扩展 Prompt 文件机制的示例入口。运行时在扩展激活时把它一次性编译为静态
guidance，装配到 System 之后、会话历史之前的固定 User 前缀里。

## 写作约定

- 只写"能力使用指导"：这个扩展能做什么、惯用法、注意事项。
- 不写实时状态（走 `capability` / `observation`）、不写系统级约束（归 System）、
  不声明与 Host 或 Persona 冲突的身份与权限。
- 需要展示指令字面量时，独立一行写 `\{{include:...}}`。

## 局部片段

{{include:prompts/tone.md}}
