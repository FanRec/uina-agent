# 对话流提示词与注入卡片重构规格

状态：2026-10-14 当前源码已实现本规格的提示词快照、外部注入卡片、顺序回放和 `/prompt` 查询入口。原设计约束仍有参考价值；实现证据与本轮测试结果见[对应实施计划](../plans/2026-10-04-inline-prompt-injection-cards.md)。真实 TTY/IME 效果未验证。

## 目标

把现在难读、信息混杂的 `/context` 诊断面板改成两个更明确的入口：

- 对话流里显示提示词变化卡片、外部运行时注入卡片和可见的扩展自定义消息。
- `/prompt` 只查看当前实际生效的系统提示词和来源摘要。

保留 `context_prepare` 运行时事实，供其他消费者使用；TUI 不再维护一套独立的上下文诊断数据模型。

## 真实生效边界

`UinaHost` 创建 `Subject` 时会固定基座系统提示词。profile 的 `persona.md`、显式 `systemPrompt` 和内置事件帧提示词都属于启动输入。进程运行中编辑这些文件，不会自动改变当前主体，必须重启进程。

`turn.prepare` 扩展钩子在每回合开始前重新执行。后执行的钩子返回的 `systemPrompt` 会覆盖之前的结果。项目扩展改动后，`/reload` 会影响下一回合；核心代码、profile 文件和内置提示词改动必须重启进程。

UI 必须明确区分“当前回合生效”和“进程启动基座”，不能暗示只编辑磁盘文件就已经改变了正在运行的主体。

## 提示词变化检测与回放

Subject 根据最终系统提示词和有序的 `turn.prepare` 来源清单生成稳定指纹。

- 第一次观察到的提示词显示一张完整卡片。
- 指纹相同的后续回合不重复刷完整卡片。
- 提示词正文或来源清单变化时，显示一张新的完整卡片。

只有指纹变化时，才通过现有 auxiliary `custom_entry` 通道保存一份完整快照。快照类型固定为 `uina.prompt.snapshot`，内容包括序号、指纹、最终系统提示词和来源清单。快照不进入模型历史，也不能成为回溯目标。

重开会话时，按照全局 journal 序号把快照卡片插回原来的对话位置，因此可以看到历史上真正生效过的完整提示词。

快照写入失败时，只报告诊断错误，不能阻断当前模型回合；实时卡片仍然显示。

## 对话流卡片

卡片使用现有 ANSI 颜色、宽度测量和转录组件，风格参考 dsh-TUI 的折叠分组：

```text
  ╭─ ◆ 提示词变更 · 当前回合生效 ───────────────╮
  │ 2,184 字符 · 3 个来源 · 新增 1 段             │
  │ ├─ 基座 · 事件帧协议                         │
  │ ├─ cognition · 记忆协议                       │
  │ └─ world-framework · 环境状态                 │
  │ Ctrl+O 展开最终提示词                         │
  ╰──────────────────────────────────────────────╯
```

折叠态只显示图标、变化类型、字符数、来源数和人类可读摘要；展开态显示来源分组、相对上一次快照的变化摘要，以及按终端宽度折行后的完整 system prompt。

提示词卡片拥有独立的展开状态，不复用思考块的折叠状态。普通转录流不显示 transformContext 的内部计数，也不显示 auxiliary 总账。

`origin: external` 的运行时输入显示为单独的“◇ 外部注入”卡片，带来源、类型、时间和经过清理的正文；不能显示成普通人类的 `❯` 消息。内部或明确 `display:false` 的私有运行时输入继续隐藏。已有可见 `custom_message` 保持原渲染器和顺序，重开时保留 `images` 与 `details`。

现有 `input_accepted` 事件继续保持最小结构，不加入正文。对于已持久化、且来源为外部的 runtime 输入，Subject 另发只读的 `external_input` 事件，携带稳定输入 ID、来源、接收时间、正文和图片，供转录消费者显示；它不新增 journal 记录。内部或私有输入不发可见事件。

## `/prompt` 命令

删除旧的 `/context` 命令和 `Alt+G` 快捷键，改为 `/prompt`。

`/prompt` 打开一个小型提示词查看面板，复用对话流卡片的渲染组件，显示：

- 最近一次实际生效的完整 system prompt；
- 所属回合和变化时间；
- 来源贡献行。

没有任何回合准备过提示词时，显示明确的空状态。该命令不再显示 transform ledger、auxiliary 分类或第二套会话浏览器。

## 代码边界

- 在转录组件中增加提示词快照类型、卡片渲染、展开状态和宽度安全换行。
- 让 `InteractiveTUI` 消费 `context_prepare` 和 `external_input`，并将卡片插入当前转录顺序。
- 使用现有 `SessionStore.appendCustomEntry` 保存变化快照，并在恢复时按全局序号合并。
- 保留 `InjectionProvenance`、`ContextPrepareEvent` 和公共运行时事实，供其他消费者使用。
- 删除 `ContextInspectorOverlay`、`ContextIntelPort`、对应 adapter、旧 feature 注册、`/context` 帮助文案，以及仅为旧面板服务的 Host/Runner 读取口。
- 不改变 Provider wire、模型上下文投影和 canonical message journal。

## 验收测试

- 第一次提示词显示一次；相同指纹不重复；提示词或来源变化时显示新的卡片。
- 卡片在窄终端、中文、emoji 和 ANSI 文本下不超宽，展开状态独立于思考块。
- `/prompt` 能显示当前实际提示词；`/context` 和 `Alt+G` 不再存在。
- 外部 runtime 输入在实时和重开后保持相同显示策略，不能变成人类 user 气泡。
- custom message 的顺序、`display:false`、图片和 details 在实时与重开后都保持一致。
- 提示词 auxiliary 快照能按原序回放，且不会进入 `projectAgentHistory` 或 Provider 请求。
- 运行定向 UI/Session/Runtime 测试，然后执行 `pnpm typecheck`、`pnpm test` 和仓库基线命令；真实 TTY/Provider 边界单独报告。

## 已确定的取舍

- 完整提示词只在变化时保存，避免每回合重复写入。
- 快照放在 auxiliary，不污染模型历史和用户对话事实。
- `/prompt` 是当前有效提示词的查询入口；对话流卡片负责展示变化过程。
- 复用现有终端组件和颜色，不引入新的 UI 框架或依赖。
