# 对话流提示词与注入卡片实施计划

> **给执行代理：** 按任务逐项执行。每个任务先写失败测试、确认失败，再写最小实现；不要把已有脏文件加入提交。

**目标：** 将上下文注入从难读的 `/context` 诊断面板改成对话流中的可读卡片，保留一个简洁的 `/prompt` 查询入口，并修复外部输入回放与 custom message 图片丢失问题。

**架构：** Subject 在 `context_prepare` 处对最终提示词和来源生成指纹，只在变化时写 auxiliary 快照；TUI 将运行时事实投影为独立转录卡片。外部 runtime 输入使用新增 `external_input` 观察事件，不改变原有最小 `input_accepted` 合同。旧 overlay、transform ledger 读取口和 `/context` 命令删除。

**技术栈：** TypeScript、Vitest、现有 ANSI TUI 组件、JSONL SessionStore；不新增依赖，不改变 Provider wire。

**规格：** `docs/superpowers/specs/2026-10-04-inline-prompt-injection-cards-design.md`

## 全局约束

- 基座 `systemPrompt` 和 profile `persona.md` 在进程创建时固定；`turn.prepare` 每回合重新计算。
- 完整提示词只在指纹变化时写入 auxiliary `custom_entry`，类型为 `uina.prompt.snapshot`。
- auxiliary 快照不进入模型历史、Provider 请求或回溯目标。
- 外部 runtime 输入不得显示为人类 `user` 气泡；内部/私有 runtime 输入保持隐藏。
- 保留 `context_prepare` 公共事实；不改变 canonical message journal 和 Provider wire。
- 保留用户已有脏文件，不修改 `E:/Uina/ThirdParty/pi`。

## Review Focus

- 同一提示词连续回合：只出现一次完整卡片；测试放在 Task 1。
- `persona.md`/基座提示词改动但进程未重启：不能伪称已更新；测试放在 Task 1。
- 外部 runtime 输入实时与重开：同样显示为外部卡片，不生成 `❯`；测试放在 Task 2/3。
- custom message 带图片重开：图片元数据仍可见；测试放在 Task 3。
- 窄终端/CJK/emoji/ANSI：卡片不超宽且展开状态不影响思考块；测试放在 Task 2。

### Task 1：运行时事实、指纹和 auxiliary 快照

**文件：**
- 修改：`src/runtime/events.ts`、`src/agent/loop.ts`
- 新增：`src/session/prompt-snapshots.ts`
- 修改：`src/session/types.ts`（仅必要的辅助类型）
- 测试：`tests/context-intel.test.ts`、`tests/input-provenance.test.ts`

**接口：**
- 新增 `ExternalInputEvent = { type: "external_input"; inputId; source; receivedAt; text; images? }`。
- 新增 `PROMPT_SNAPSHOT_ENTRY_TYPE = "uina.prompt.snapshot"`。
- 新增 `isPromptSnapshotData(value)` 与 `listPromptSnapshots(auxiliary)`，只接受合法的指纹、正文、回合号和 provenance 数组。
- Subject 在 `dispatchContextPrepare()` 内比较快照指纹；变化时调用 `store.appendCustomEntry()`，失败只 `reportError`，仍发送 `context_prepare`。

- [ ] 写失败测试：相同提示词不重复写快照；prompt/provenance 变化写新快照；快照不出现在 `projectAgentHistory`。
- [ ] 写失败测试：外部 runtime 输入发 `external_input`，内部 runtime 不发，`input_accepted` 形状不变。
- [ ] 运行定向 Vitest，确认因接口不存在或断言缺失而失败。
- [ ] 实现指纹、快照校验/读取和 Subject 事件发布。
- [ ] 重新运行定向测试，确认通过。

### Task 2：转录上下文卡片与实时事件投影

**文件：**
- 新增：`src/ui/components/transcript/context-card.ts`
- 修改：`src/ui/components/transcript/transcript.ts`、`src/ui/ui-host.ts`、`src/ui/tui.ts`
- 测试：`tests/ui.test.ts`

**接口：**
- `ContextCardData` 区分 `prompt` 与 `external`，携带展开状态所需的完整正文、来源、变化摘要和外部输入元数据。
- `ContextCardComponent.render(width)` 输出折叠/展开卡片，使用现有 `C`、`visibleWidth`、`wrapTextWithAnsi`，不使用普通 `string.length` 做布局。
- `TranscriptContainer.addPromptSnapshot()`、`addExternalInput()`、`toggleContextCard()`。

- [ ] 写失败测试：首次 prompt 卡片、重复指纹抑制、变化摘要、来源分组和完整正文展开。
- [ ] 写失败测试：外部输入卡片不显示 `❯`，内部输入不显示，窄宽/CJK/emoji 不超宽。
- [ ] 运行 `tests/ui.test.ts` 定向用例确认失败。
- [ ] 实现卡片组件、独立展开状态和 TUI event 分发；`Ctrl+O` 只切换当前上下文卡片时调用新的 toggle 入口。
- [ ] 重新运行 UI 定向测试，确认通过。

### Task 3：重开回放、图片修复和序号合并

**文件：**
- 修改：`src/ui/components/transcript/transcript.ts`、`src/cli/app.ts`
- 测试：`tests/ui.test.ts`、`tests/image-content.test.ts`、新建 `tests/prompt-snapshot-replay.test.ts`

**接口：**
- `InteractiveTUI.loadSession()` 接收恢复的 auxiliary 快照，并按 `seq` 与 canonical entries 合并。
- `TranscriptContainer.loadSession()` 对 external runtime `input` 创建 context-only turn/card，不创建普通 user 行；后续 assistant 输出仍挂在该 turn 上。
- 恢复 `custom_message` 时保留 `images` 和 `details`。

- [ ] 写失败测试：快照按全局序号插入正确位置，且不进入模型历史。
- [ ] 写失败测试：external runtime live/replay 显示一致；custom message 图片重开仍渲染图片 MIME 元数据。
- [ ] 运行 replay/image 定向测试确认失败。
- [ ] 实现 auxiliary 合并、external replay 分支和 custom message image 修复。
- [ ] 重新运行定向测试，确认通过。

### Task 4：删除旧诊断面板并改名 `/prompt`

**文件：**
- 删除：`src/ui/features/overlays/context-inspector.ts`、`src/ui/adapters/context-intel.ts`
- 修改：`src/ui/features.ts`、`src/ui/features/overlays/index.ts`、`src/extensions/builtin.ts`、`src/ui/features/overlays/help-menu.ts`、`src/cli/app.ts`
- 视使用情况删除：`src/host/host.ts`、`src/extensions/host.ts` 中只服务旧 overlay 的 transform ledger 读取口
- 测试：`tests/context-intel.test.ts` 改为 prompt card/runtime facts 测试，相关旧 overlay 断言删除

- [ ] 先删除/改名测试断言，确认 `/context`、`Alt+G` 和旧 feature 不再存在。
- [ ] 实现 `/prompt` 命令，打开与 transcript 共用的 prompt card overlay；无快照时显示明确空态。
- [ ] 删除旧 ContextIntelPort 与 transform ledger UI 接线，不删除其他消费者仍使用的公共 runtime 事实。
- [ ] 运行 UI/命令定向测试，确认旧符号无残留。

### Task 5：全量验证与收尾

- [ ] 运行 `pnpm typecheck`。
- [ ] 运行 `pnpm test`；若 Windows ACL 继续阻止 node_modules，记录准确错误，不把未执行说成通过。
- [ ] 运行 `pnpm build`、`pnpm verify:cli`、`pnpm dev:baseline -- --quick`（依赖可用时）。
- [ ] `git diff --check`，确认只包含本功能改动和规格/计划文件；再次确认用户已有删除/修改未被暂存。
- [ ] 按验证结果更新报告，区分源码/本地测试与真实 TTY/Provider 边界。
