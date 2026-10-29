# 展示层重构规划（TUI 为首个 Surface）

日期：2026-10-29
状态：设计提案，未授权施工
输入：[TUI 展示信息审计](../../history/2026-10-29-tui-display-audit.md)
范围：新增 `src/presentation/`（平台中立展示核心）、`src/ui/`（TUI Surface 适配器）、`src/extensions/ui-contract.ts`、`src/extensions/runner.ts`、`src/extensions/builtin.ts`、`src/host/events.ts`、`src/host/host.ts`、`src/ai/providers.ts`（仅 C23）、`src/cli/stdio-render.ts`（print/stdio Surface）
目标：修复审计问题，并留下可替换展示面的接缝；本规划不实现 Web。
依据：本次对当前源码逐条核查。文档与源码冲突时以源码为准。

---

## 0. 一页结论

**该不该重构：该做。要害不在“修 114 个显示 bug”，而在四个结构性缺口；本次再加一个面向后续展示面的开放接缝。**

- 审计条目化后共 114 条（A–G、I 用原文编号，H 按六个判断拆分）。核查结果：成立 90、部分成立 16、保留现状 1、不成立 3、未验证 4（另含审计文首自撤回 2 条，未计入）。
- 约八成问题可归入四个根因：
  1. **没有单一事实源**：实时路径用 `Date.now()` 现算耗时，恢复路径另写一套事实；`turn_aborted` 不结算在途节点，`session_rewind` 不重建轨迹。
  2. **没有统一布局原语**：截断、换行、去 ANSI、宽度测量由十几个组件各自实现，导致 `?? 0`、UTF-16 切片、空省略号、边框静默丢失。
  3. **槽位没有契约与反馈**：`working` 只显示最新一条，toast 单槽覆盖，`setStatus` 写而不读，widget 溢出静默丢行；扩展作者无法预判内容是否可见。
  4. **同一信息双渲染**：stdio 走 `format.ts`，TUI 走 `tool-view.ts`，外观、用词、状态语义分叉。
- 另有第五个横切问题：**契约没有测试约束**。死分支、“Enter 展开”无处理器、提示写 `↑/↓` 实际只收 `PageUp/PageDown` 都属于此类。
- 第六个不是当前 TUI 的可见 bug，而是第二个展示面的结构成本：**展示层被终端假设锁死**。Host 事件流与生命周期已经中立，但 `UIHost` 同时拥有终端、布局、输入、浮层、槽位与渲染；`Component.render(width): string[]`、必填的 `TerminalUIContext`、返回 `Component` 的 `MessageRenderer`/`ToolRenderer` 都把“展示”等同于“终端行”。Web/远程/语音/具身 surface 今天只能重写语义或抓 ANSI 帧，二者都会产生第二事实源。

**推荐路线：先把展示语义收成平台中立的 Presentation Core，再让 TUI 成为第一个 Surface 适配器。**

```text
HostEventRecord ─┐
                 ├─► Facts ─► Projection ─► Composition ─► PresentationController
Journal ─────────┘                                             │
                          ┌────────────────────────────────────┼────────────────────┐
                          ▼                                    ▼                    ▼
                     TUI Surface                        print/stdio Surface   future Web/remote
              layout · keymap · renderer              text renderer          DOM · transport
```

优先顺序：W0 基线 → W1 事实 → W2 投影（含 W2e 控制器）→ W3 布局 → W4 槽位 → W5 键位 → W6 格式/文案 → W7 输入/终端安全 → W8 清理归档。W3 可在 W1 后与 W2 并行；W6 的 Markdown 数据损坏项可插队先修。**若后续要接第二个 surface，关键路径是 W0 → W1 → W2e → W4 的 Composition 中立化；W3/W5/W7 是 TUI 质量，不是 Web 前置。**

**开放不是现在写 Web。** 本次只留三类接缝：

1. **语义接缝**：Facts / Projection / Composition 不 import 终端、ANSI、宽度、进程模块；只允许 type-only 引用 Host/Session/Core 的公开契约。
2. **动作接缝**：surface 把用户操作归一为 `PresentationIntent`；TUI 只负责 key → intent，Web 只负责 DOM event → intent。
3. **能力接缝**：surface 声明 `SurfaceCapabilities`；扩展按能力降级，不靠 `hasUI()` 猜；`terminal` 从必填 facet 改为可选 facet。

**最大收益**

- 用户：五种工具状态不再被压成“完成/失败”；恢复会话的耗时、轮次、工具名与实时一致；失败压缩不再只闪 3 秒；扩展写入的内容要么可见、要么明确告知被谁顶掉。
- 开发：新增展示信息只需选一个槽位并声明冲突策略；所有提示由键位表生成，不再靠手写；宽度/注入/等价性由测试兜底，同类 bug 不再散落复发。
- 后续展示面：新增 Web/远程/语音/具身 surface 时，复用事实、状态矩阵、耗时、压缩、轨迹、槽位冲突与文案；只需重写该 surface 的布局、输入与渲染。不是“换个 renderer”，但也不再重抄一套业务语义。

**最大风险**

- W2 牵动 `transcript.ts`（约 1350 行）、`tui.ts`、`agent-events.ts`、`tool-view.ts`、`cards.ts`。控制手段：稳定节点 ID、live/replay 等价测试、按 a–e 五批提交、每批可独立 revert。
- 开放接缝变成过度抽象：本次只定义 3 个契约（Controller、Composition、Capabilities），不写 DOM/React、不做通用跨 surface widget 协议、不做远程协议；超出即停止复盘。
- TUI 假设泄漏进 Presentation Core：用 `check:boundaries` 新规则 + fake surface 测试兜底；`fitLine`/`FrameLayout`/ANSI 只能留在 `src/ui/`。
- 不引入 UI 框架，不改 `core/` 概念 allowlist，不做完整 CommonMark/i18n/主题系统。

---

## 1. 评估总表

处置口径：

- **重构**：需要改结构或契约，单点修补会复发。
- **修复**：局部行为错误，结构可留。
- **删除**：无读取端、死代码或编造数据。
- **保留**：经核实是设计意图。
- **误报**：不成立或已撤回，不改。

必要性分级：

- **P0**：违反项目硬约束、数据损坏或终端安全，必须做。
- **P1**：可信度与可维护性，建议做；不做会让同类问题继续复发。
- **P2**：一致性打磨，可延后；不影响正确性。

| 类别 | 条目 | 成立/部分 | 必要性 | 结论 | 主收益 | 归属 |
|---|---:|---:|---|---|---|---|
| A 硬约束 | 18 | 14 / 4 | P0 | 重构 | 状态不再撒谎；恢复不伪造 | W1、W2 |
| B 用量/速度 | 7 | 7 / 0 | P1 | 重构+修复 | 估算与事实分离；缓存未知可辨 | W2 |
| C 信息吞没 | 24 | 21 / 2（保留 1） | P0/P1 | 重构+删除 | 失败可见；写入有回执 | W2–W4 |
| D 版面/对齐 | 18 | 14 / 3（不成立 1） | P0 | 重构 | 边框不丢；长内容可读 | W3、W7 |
| E Markdown/diff | 11 | 7 / 2（不成立 2） | P1（E1–E4 为 P0） | 修复为主 | 路径不被吃；围栏正确；计数可信 | W6 |
| F 提示/按键 | 10 | 9 / 1 | P1 | 重构 | 提示即键位，不再说谎 | W5 |
| G 术语/文案 | 12 | 10 / 2 | P2 | 修复+集中 | 中英、术语、耗时统一 | W6 |
| H 架构 | 6 | 6 / 0 | P0/P1 | 重构 | 扩展可预期；契约可验证 | W0–W4 |
| I 未覆盖项 | 8 | 2 / 2（未验证 4） | P0（I2）/P1 | 补测+加固 | 注入安全；性能有基线 | W0、W7 |

**判断**

- A、C、D 是用户直接感知的错误，且违反项目硬约束，必须做。
- B、F、G 是可信度问题，成本低，收益直接。
- E 中只有 E1–E4 属于数据损坏，必须修；其余是能力边界，按 bug 修，不扩语法。
- H 是本次重构的真正对象；只修 A–G 会让同类问题继续出现。
- I2（终端注入）风险高于多数版面问题，必须在 W7 前置完成。

**横切目标（非审计条目）**

- **展示面开放接缝**：必要性 P1。它不新增用户功能，但约束 W2/W4/W5 的接口形状；不做不会立刻报错，但第二个 surface 会重写语义。
- 归属：W2e（Controller + 判别联合）、W4（Composition 中立化 + capabilities）、W5（Intent/ActionId）。
- 不改变 A–I 的处置与计数；审计条目仍是 114 条。

---

## 2. 现状事实

### 2.1 体量与耦合

| 文件 | 规模 | 现状 |
|---|---:|---|
| `src/ui/ui-host.ts` | 2047 行 | 帧布局、槽位、toast、working、status、输入命中、浮层、建议卡全部内联 |
| `src/ui/components/transcript/transcript.ts` | 1350 行 | 同时拥有条目状态、耗时推导、Markdown 缓存、恢复渲染 |
| `src/ui/components/editor/input-line.ts` | 1111+ 行 | 编辑器、粘贴、chip、命中测试、底边状态 |
| `src/ui/components/transcript/tool-view.ts` | 621 行 | 工具卡渲染，状态语义与 `format.ts` 分叉 |
| `src/ui/core/utils.ts` | 581 行 | 宽度、ANSI、换行、剪贴板混在一起 |
| `src/ui/components/transcript/cards.ts` | 约 500 行 | 思考/压缩/自定义卡片，含死分支与文本启发式 |
| `src/ui/features/overlays/*` | 300–400 行/个 | 每个浮层自带按键处理与手写提示 |
| `src/ui/features.ts` | 133 行 | 按 action 派发，但无统一的浮层/键位契约 |
| `src/ui/tui.ts` | 347 行 | Host 事件 → UIHost 的消费者适配器；仍持有工具开始时刻与轨迹投影 |
| `src/extensions/ui-contract.ts` | 171 行 | 中性方法 + 必填 `terminal` facet；自定义渲染器返回 `Component` |
| `src/cli/app.ts` | 组合根 | Host 生命周期独立于 TUI；stdio 是第二个消费者 |

### 2.2 根因与证据

**R1 展示层没有单一事实源**

- 工具耗时由消费者收到事件时用 `Date.now()` 计算（`src/ui/tui.ts`），恢复路径只能从 JSON 取 `elapsedMs`。而 journal 其实已经持久化了 `tool_started` / `tool_finished`（含 `timestamp` 与 `status`，见 `src/session/types.ts`、`src/agent/loop.ts`），真实耗时可得。
- `turn_aborted` 不更新 trajectory（`src/ui/tui.ts`），Esc/Ctrl+C 后节点永远 running。
- `session_rewind` 只重放转录，不重建 trajectory。
- 恢复时强制 `status: "completed"`、`tokensBefore ?? 0`、`receivedAt` 取当前时间。

**R2 缺少统一布局原语**

- `truncateToWidth(rawLine, w, " ")` 静默裁切（`ui-host.ts`）。
- 工具参数按 UTF-16 `.slice(0, 120)`（`tool-view.ts`），可能切开代理对且无省略号。
- `stripAnsi` 后再用空省略号截断，颜色与省略标记同时丢失（`cards.ts`、`context-card.ts`、`branch-inspector.ts`）。
- `wrapTextWithAnsi` 只保留最后一个 SGR；`truncateToWidth` 在省略号前 reset。
- `isFullWidth` 漏 `⌚☔☕⚽`，却把 `0x1F300–0x1FAFF` 整段当宽字符；`charWidth` 与 `graphemeWidth` 对 tab 取值不同。
- `OverlayStack` 对超宽行默认用 `…` 替换，直接吃掉右边框。

**R3 槽位没有契约与反馈**

- `workingContributions` 只取序号最大一条（`ui-host.ts`）。
- `notificationToast` 单槽，后到覆盖先到；复制提示优先级最高。
- `statuses` 只写不读；`ExtensionUIContext.setStatus` 在 `src/extensions` 内无实际调用者。
- `WidgetSlots.render` 逐组件拼接，无宽度约束；`aboveRaw.slice` 静默丢行。
- `notify` 返回 `void`，扩展无法知道内容是否被顶掉。

**R4 双渲染路径**

- `src/cli/stdio-render.ts` 用 `format.ts` 的 `toolStartLine` / `toolResultLines`，TUI 用 `tool-view.ts`。同一工具两套图标、两套状态文案、两套截断规则。

**R5 契约无测试约束**

- `cards.ts` 非 completed 压缩分支无调用者。
- trajectory 页脚写“Enter 展开”，处理器只有 Esc/Tab/←/→/e。
- `prompt-overlay` 页脚写“↑/↓ 或 j/k”，实际只处理 PageUp/PageDown/j/k。
- `branch-inspector` 静态写“←/→ 翻页详情”，实际是切视图。
- `scrollbar-gutter` 250ms 悬停防抖疑似死代码。
- 现有可能只是部分死代码，但它们共同说明：**接口是否存在、是否生效，没有机制保证**。

**R6 展示面被终端假设锁死（开放接缝缺口）**

- 事实流已经中立：`src/host/events.ts` 明确任何消费者（TUI、stdio、未来 TTS 或远程观察者）订阅同一序列；Host 不知道监听者，也不引用 UI 类型。
- 生命周期已经中立：`src/cli/app.ts` 明确 TUI 关闭、换成 stdio、或接入第二个观察者，都不影响主体是否继续存活。
- 但展示层没有中立核心：`UIHost` 同时拥有布局、输入、浮层、槽位与渲染；`Component.render(width): string[]`；`TerminalUIContext` 必填；`MessageRenderer`/`ToolRenderer` 返回 `Component`；`hasUI()` 只有布尔。
- 结果：Web/远程/语音/具身 surface 今天要么在各自实现里重抄状态、耗时、压缩、轨迹语义，要么把 ANSI 帧转成别的形状。二者都会产生第二事实源。
- 这不是当前 TUI 的用户可见 bug；它是“第二个展示面”的结构性成本，因此作为横切目标处理，不新增审计编号。

### 2.3 审计可信度修正

已核实不成立或不应按原方向修：

| 条目 | 核查结论 |
|---|---|
| D6 model-picker 底边超 1 列 | 不成立。`bottomTag + bottomFill` 总宽等于 `boxWidth`。 |
| E11 共用 `turn-${uid}-text` | 不成立。key 含每次生成的 uid，不冲突。 |
| E9 粗体正则吃掉 `src/**` | 不成立。正则要求闭合并列星号，`src/**` 不匹配。其余“无斜体/删除线”是能力边界，不是错误。 |
| E10 仅表头的表格什么都不渲染 | 部分不成立。当前零数据行仍渲染表头与网格。列宽按原始 markdown 测量成立。 |
| A15 `messageCount ?? 0` | 部分不成立。恢复卡已有缺失处理；真正成立的是缺 `previousSystemPrompt` 时误判“首次建立”。 |
| D12 “wrapTextWithAnsi 逐字符换行” | 部分不成立。已按 cell 扫描；成立的是“只保留最后一个 SGR”和省略号前 reset。 |
| D2 类别英文列 | 已陈旧，当前无独立类别列。成立的是 `cardWidth = max(30, columns)` 可超终端宽。 |
| C21 SKIP 集隐藏候选 | 保留。静默过滤是设计意图；仅注释提到 `.uina` 而代码未含，修注释即可。 |
| G10 `:388` 类别配色注释不符 | 行号漂移，当前该位置不是该逻辑；修注释，不改行为。 |
| 审计文首自撤回 2 条 | 转录占满时 toast 不可见、缓存命中率重复计数，均不成立。 |

### 2.4 已经存在的接缝（本次要留好，而不是重造）

| 接缝 | 源码事实 | 对本次规划的意义 |
|---|---|---|
| Host 事件流 | `src/host/events.ts` 的注释明确：任何消费者（TUI、stdio、未来 TTS 或远程观察者）都通过 `subscribe()` 收到同一份序列；Host 不知道监听者 | Presentation Core 可以直接消费，不必改 Host 协议 |
| 生命周期 | `src/cli/app.ts` 的注释明确：TUI 只是 subscribe 到宿主事件流的一个消费者；关闭 TUI 不影响主体 | Surface 可插拔，组合根决定挂哪个 |
| 动作 | `src/ui/intents.ts` 的 `TuiIntent` 注释即“cross from the terminal surface into the application”；`BuiltinUIActions` 注释是“independently of terminal layout” | 已经是平台中立动作的雏形；迁入 Presentation Core，TUI 只做 key → intent |
| 扩展契约 | `ExtensionUIContext` 与 `TerminalUIContext` 已分离；前者只有 `terminal` 是平台专属 | 中性方法可跨面复用，终端 facet 保持可选 |
| 无头 surface | `src/extensions/runner.ts` 的 `createPrintUI` 返回 `hasUI: false` 的 no-op 上下文 | 第二个 surface 已经存在，只是没有共享 Controller |
| 边界检查 | `scripts/check-boundaries.mjs` 已有规则与自测样本（host 不依赖 UI、extensions 只依赖 `ui/core`） | 可新增 Presentation Core 规则，并用自测证明规则会失败 |

**结论：** 开放接缝不是从零发明一套框架；现有代码已经把 Host、生命周期、动作、扩展契约分开了。缺的是把这些中立的“事实与动作”收进一个不依赖终端的 Presentation Core，并让 TUI 降为适配器。

---

## 3. 目标架构

### 3.1 五层与所有权（前三层中立）

先分清两个东西：

- **Presentation Core** = Facts + Projection + Composition + actions + copy；平台中立，不碰终端。
- **Surface Adapter** = 一个具体展示面（TUI、print/stdio、未来 Web/远程/语音/具身）；拥有自己的布局、输入、渲染与能力声明。

| 层 | 拥有 | 不拥有 | 归属 |
|---|---|---|---|
| **Facts** | 事件规范化、时间戳、`unknown` 表示、来源（live/replay） | 布局、颜色、文案 | Presentation Core |
| **Projection** | 语义节点、状态、聚合、稳定 ID、typed payload | 终端宽度、ANSI、焦点 | Presentation Core |
| **Composition** | 槽位、优先级、TTL、冲突策略、可见性回执、贡献描述 | 行渲染、终端宽度 | Presentation Core |
| **Layout** | 几何、截断、换行、边框不变量 | 业务状态、事件顺序 | TUI Surface |
| **Renderer** | 行合成、差量输出、终端写入 | 任何判断与默认值 | TUI Surface |

**术语固定**：本规划中的 **Surface** 指平台展示面（TUI/Web/print），不再指槽位层；槽位层统一叫 **Composition**。`src/ui/` 是第一个 Surface Adapter；`src/cli/stdio-render.ts` 是第二个（文本面）；`createPrintUI` 是无头第三面。Web 只是第四个 adapter，不进入 Core。

### 3.2 七条硬规则（每个工作流都用它验收）

1. **单一事实源**：任何显示值必须能追溯到一条 Fact 或一个显式常量。
2. **未知保持未知**：禁止 `?? 0`、`?? "completed"`、`|| Math.max(1, …)` 这类填充。未知有专门表示。
3. **live/replay 同投影**：同一 journal 必须产生同一节点序列（除 `origin` 与时间戳）。
4. **布局集中（Surface 内）**：Surface 自己的组件不得自行 `truncate` / `sanitize` / `wrap`；TUI 只能调用 `layout/fit.ts`。Presentation Core 不提供布局函数。
5. **写入有回执**：每个对外展示接口必须有读取端、冲突策略和测试；无读取端的接口删除。
6. **提示即键位（TUI）**：TUI 所有页脚/提示由 keymap 生成，测试断言“提示中的每个键都有绑定”。其他 surface 用自己的输入声明，不复制 TUI 键位表。
7. **中立层不碰终端**：`src/presentation/` 不得 import `src/ui`、`src/cli`、`src/extensions`、`src/ai`、`node:tty/process/fs`；Host/Session/Core 只允许 `import type`。布局、按键字节、终端能力只能出现在 Surface Adapter。

### 3.3 目录与接缝

```text
src/presentation/                    Presentation Core（平台中立）
  facts.ts                           Fact 类型、FactStore（append / replaceAll）
  sanitize.ts                        sanitizeExternal（OSC/DCS/CSI/C0/C1/bidi）
  controller.ts                      PresentationController、view、intent sink
  ingest-live.ts                     HostEventRecord -> Fact[]
  ingest-replay.ts                   SessionEntry[] -> Fact[]
  projection/
    transcript.ts                    Fact[] -> PresentationNode[]
    tools.ts                         工具节点与状态矩阵
    turns.ts                         轮次边界、中止结算
    trajectory.ts                    轨迹节点、聚合键、环形上限
    activity.ts                      用量、TPS、缓存、重试
  composition/
    slots.ts                         SlotContribution、SlotAck、SlotRegistry
    toasts.ts                        ToastQueue（等级、去重、TTL）
  actions.ts                         BuiltinUIActions、PresentationIntent、ActionId
  surface.ts                         SurfaceCapabilities、SurfaceAdapter
  copy.ts                            术语、状态文案、耗时格式（不放 i18n 框架）

src/ui/                              TUI Surface Adapter
  layout/
    frame.ts                         computeFrame(input) -> FrameLayout（纯函数）
    panel.ts                         renderPanel(spec, width, height)
    fit.ts                           fitLine / wrapLine / measure
  keys/
    keymap.ts                        KeyToken -> ActionId、hintsFor（复用 core/keys.ts 的 matchesKey）
  composition/
    render.ts                        SlotContribution -> 行
  render-text.ts                    ToolModel -> 文本行（TUI/print 共用）
  components/                        现有组件
  ui-host.ts                         TUI host
  tui.ts                             Host 消费者 + TUI mount

src/cli/stdio-render.ts              print/stdio Surface（文本面）
```

**所有权迁移表**

| 现状 | 迁移后 |
|---|---|
| `UIHost` 的私有 `layoutFrame()` | `src/ui/layout/frame.ts` 的 `computeFrame()` |
| `TranscriptContainer` 的耗时/状态推导 | `src/presentation/projection/transcript.ts` |
| `agent-events.ts` 的 trajectory 聚合 | `src/presentation/projection/trajectory.ts` |
| `trajectory-scene.ts` 的 `TrajectoryNode` 类型 | `src/presentation/projection/trajectory.ts`（UI 只引用） |
| `tool-view.ts` 的状态判定 | `src/presentation/projection/tools.ts`（渲染只读节点） |
| `WidgetSlots` 的无约束拼接 | `src/presentation/composition/slots.ts`（冲突/预算）+ `src/ui/composition/render.ts`（行渲染） |
| 各浮层手写按键与页脚 | `src/ui/keys/keymap.ts` + 每个浮层的 `keymap` |
| `format.ts` 的工具文本渲染 | `src/ui/render-text.ts`（TUI/stdio 共享文本面） |
| `BuiltinUIActions` | `src/presentation/actions.ts`；`src/extensions/ui-contract.ts` 继续作为扩展作者的公开导入点 |
| `TuiIntent` | `src/presentation/actions.ts` 的 `PresentationIntent`；TUI 只负责 key / DOM 事件到 intent 的映射 |
| `ExtensionUIContext.terminal` 必填 | 改为可选 facet；新增 `capabilities()` |

### 3.4 关键接口草案

```ts
// src/presentation/facts.ts
export type FactOrigin = "live" | "replay";

export interface FactMeta {
  seq: number;
  origin: FactOrigin;
  at?: number;              // 未知则不填，禁止补当前时间
}

export type PresentationFact =
  | ({ kind: "turn.started"; turn: number } & FactMeta)
  | ({ kind: "turn.ended"; turn: number; reason: "completed" | "aborted" | "failed" } & FactMeta)
  | ({ kind: "thinking"; turn: number; text: string } & FactMeta)
  | ({ kind: "assistant.delta"; turn: number; text: string } & FactMeta)
  | ({ kind: "tool.started"; callId: string; name: string; args?: unknown } & FactMeta)
  | ({ kind: "tool.finished"; callId: string; status: ToolResultStatus; result?: unknown } & FactMeta)
  | ({ kind: "usage"; usage: RequestUsage; estimated: boolean } & FactMeta)
  | ({ kind: "compaction.started"; id: string } & FactMeta)
  | ({ kind: "compaction.ended"; id: string;
      status: "completed" | "failed" | "cancelled" | "noop";
      summary?: string; tokensBefore?: number; retainedTail?: number } & FactMeta)
  | ({ kind: "notice"; level: "info" | "warning" | "error"; text: string; dedupeKey?: string } & FactMeta)
  | ({ kind: "retry"; attempt: number; delayMs?: number } & FactMeta)
  | ({ kind: "rewind"; toEntrySeq: number } & FactMeta)
  | ({ kind: "external"; source: string; kindLabel?: string; text: string } & FactMeta);

export interface FactStore {
  append(fact: PresentationFact): void;
  replaceAll(facts: readonly PresentationFact[]): void;   // rewind / resume
  list(): readonly PresentationFact[];
}
```

```ts
// src/presentation/sanitize.ts
/** 外部文本入口：去 OSC/DCS/CSI、C0、C1、bidi 控制符；只保留 \n 与普通文本。 */
export function sanitizeExternal(text: string): string;
```

```ts
// src/presentation/projection/transcript.ts
export interface PresentationNodeBase {
  /** 稳定标识：turn:${n}:tool:${callId} / turn:${n}:msg:${index}。跨重渲染、恢复、rewind 不变。 */
  id: string;
  turn?: number;
  status?: ToolResultStatus;
  startedAt?: number;
  durationMs?: number;
  tokens?: { input?: number; output?: number; total?: number; estimated: boolean };
  provenance: FactOrigin;
}

export type PresentationNode =
  | (PresentationNodeBase & { kind: "user"; payload: { text: string; images?: readonly ImageContent[] } })
  | (PresentationNodeBase & { kind: "assistant"; payload: { text: string; streaming?: boolean } })
  | (PresentationNodeBase & { kind: "thinking"; payload: { text: string; collapsed?: boolean } })
  | (PresentationNodeBase & {
      kind: "tool";
      status: ToolResultStatus;
      payload: {
        name: string;
        callId?: string;
        args?: unknown;
        resultText?: string;
        errorText?: string;
        details?: unknown;
        images?: readonly ImageContent[];
      };
    })
  | (PresentationNodeBase & { kind: "notice"; payload: { level: "info" | "warning" | "error"; text: string } })
  | (PresentationNodeBase & {
      kind: "compaction";
      payload: {
        status: "completed" | "failed" | "cancelled" | "noop";
        summary?: string;
        tokensBefore?: number;
        retainedTail?: number;
      };
    })
  | (PresentationNodeBase & { kind: "rewind"; payload: { toEntrySeq: number } })
  | (PresentationNodeBase & {
      kind: "external";
      payload: { source: string; kindLabel?: string; text: string; images?: readonly ImageContent[] };
    });

export function projectTranscript(facts: readonly PresentationFact[]): PresentationNode[];
```

```ts
// src/presentation/controller.ts
// HostEventRecord / SessionEntry 只以 import type 进入本层。
export interface ActivityView {
  busy: boolean;
  elapsedMs?: number;
  outputTokens?: number;
  tps?: number;
  retry?: { provider: string; attempt: number; delayMs: number };
  working: readonly SlotContribution[];
}

export interface SurfaceSessionView {
  modelName: string;
  thinkingLevel?: ThinkingLevel;
  usage?: RequestUsage;
  context?: ContextSnapshot;
  queueDepth: number;
}

export interface PresentationView {
  transcript: readonly PresentationNode[];
  trajectory: readonly TrajectoryNode[];
  activity: ActivityView;
  composition: readonly SlotContribution[];
  session: SurfaceSessionView;
}

export type PresentationChange =
  | { kind: "append"; nodes: readonly PresentationNode[] }
  | { kind: "update"; node: PresentationNode }
  | { kind: "replace"; view: PresentationView };

export interface PresentationController {
  /** 冷启动/重连：HostSnapshot 是初始稳定事实，不产生历史节点。 */
  applySnapshot(snapshot: HostSnapshot): void;
  ingest(record: HostEventRecord): void;
  replaceAll(entries: readonly SessionEntry[], reason: "resume" | "rewind"): void;
  view(): PresentationView;
  /** 流式路径只发 append/update，不允许每个 delta 全量重投影。 */
  subscribe(listener: (change: PresentationChange) => void): () => void;
  dispatch(intent: PresentationIntent): void;
  onIntent(sink: (intent: PresentationIntent) => void): () => void;
}
```

```ts
// src/presentation/composition/slots.ts
export type SlotId =
  | "header" | "footer" | "notice" | "activity"
  | "toast" | "above" | "below";

export type SlotPayload =
  | { kind: "text"; text: string; level?: "info" | "warning" | "error" }
  | { kind: "activity"; label: string; startedAt?: number; detail?: string }
  | { kind: "notice"; text: string; level: "info" | "warning" | "error"; dedupeKey?: string }
  | { kind: "custom"; customType: string; data?: unknown };

export interface SlotContribution {
  id: string;
  slot: SlotId;
  priority: number;
  ttlMs?: number;
  dedupeKey?: string;
  payload: SlotPayload;
}

export interface SlotAck {
  accepted: boolean;
  reason?: "shadowed" | "expired" | "overflow";
}

export interface SlotRegistry {
  /** at 由 surface 提供；Registry 不自行读时钟。 */
  publish(c: SlotContribution, at?: number): SlotAck;
  retract(id: string): void;
  /** 由 surface 心跳调用，返回本次过期并移除的贡献 id。 */
  expire(at: number): readonly string[];
  snapshot(slot?: SlotId): readonly SlotContribution[];
}
```

```ts
// src/presentation/actions.ts
// BuiltinUIActions 从 extensions/ui-contract.ts 迁入；后者继续 re-export 给扩展作者。
export type PresentationIntent =
  | { type: "input.submit"; text: string; mode: "direct" | "steer" | "followUp" }
  | { type: "turn.cancel"; source?: "escape" | "ctrl+c" }
  | { type: "turn.interruptAndDeliver"; text: string }
  | { type: "queue.pullBack" }
  | { type: "thinking.cycle" }
  | { type: "ui.interaction" }
  | { type: "feature.open"; action: BuiltinUIActionRequest };

export type ActionId =
  | "input.submit" | "turn.cancel" | "turn.interruptAndDeliver" | "queue.pullBack"
  | "thinking.cycle" | "ui.interaction"
  | `ui.${keyof BuiltinUIActions}`;
```

```ts
// src/presentation/surface.ts
export interface SurfaceCapabilities {
  readonly interactive: boolean;
  readonly richText: boolean;
  readonly images: boolean;
  readonly overlays: boolean;
  readonly pointer: boolean;
  readonly clipboard: boolean;
  readonly notifications: boolean;
}

export interface SurfaceAdapter {
  readonly id: string;
  readonly capabilities: SurfaceCapabilities;
  /** 接管 controller 的视图与意图；返回 detach。 */
  attach(controller: PresentationController): () => void;
}
```

```ts
// src/ui/layout/fit.ts（TUI 专用，不进入 Presentation Core）
export type FitPolicy = "ellipsis" | "clip" | "wrap" | "middle-ellipsis";

/** 唯一允许的显示宽度截断入口；保留 SGR，输出宽度 <= width。 */
export function fitLine(line: string, width: number, policy?: FitPolicy): string;
```

```ts
// src/ui/keys/keymap.ts（TUI 专用；ActionId 来自 Presentation Core）
export type KeyToken = string;   // "escape" | "ctrl+o" | "?" 等

export interface Binding {
  keys: readonly KeyToken[];
  action: ActionId;              // 不再携带 run() 闭包
  label: string;                 // 用于生成提示，如 "Esc 关闭"
  when?: () => boolean;
}

export interface Keymap {
  capturing: boolean;            // 捕获态：未绑定键不向编辑器透传
  bindings: readonly Binding[];
}

export function resolve(map: Keymap, data: string): ActionId | undefined;
export function hintsFor(map: Keymap, width: number): string;
```

### 3.5 平台开放接缝（现在只留形状，不实现第二个 surface）

**开放的定义**：展示层不是“给 TUI 换一层皮”，而是把“展示什么、什么状态、谁的动作、哪条贡献可见”收成平台中立的语义合同；每个具体展示面只负责自己的几何、输入与输出。开放的对象是**语义、动作、能力、贡献**，不是布局。

| 类别 | 开放内容 | 不开放内容（属于具体 Surface） |
|---|---|---|
| 语义 | 节点种类、状态矩阵、耗时、用量、上下文、压缩、轨迹、轮次 | 行宽、换行、边框、ANSI、颜色、焦点、滚动 |
| 动作 | `PresentationIntent` / `ActionId` | 键位字节、DOM 事件、触摸、语音识别 |
| 能力 | `SurfaceCapabilities` | 终端 TTY 探测、浏览器 API、远程传输协议 |
| 贡献 | `SlotContribution`（payload 中立、带优先级与回执） | 行渲染、浮层几何、widget 组件实现 |

**复用 / 重写矩阵（新增第二个 surface 时）**

| 项 | 复用 | 重写 |
|---|---|---|
| Facts、时间戳、来源 | ✅ Presentation Core | — |
| Projection：状态矩阵、耗时、轨迹、压缩、轮次 | ✅ Presentation Core | — |
| Composition：槽位、优先级、TTL、冲突、回执 | ✅ Presentation Core | — |
| 文案与术语（`copy.ts`） | ✅ Presentation Core | 局部措辞按渠道微调 |
| 动作语义（intent） | ✅ Presentation Core | 输入映射 |
| 布局、截断、换行、边框 | — | 每个 surface 自建 |
| 浮层、滚动、焦点 | — | 每个 surface 自建 |
| 渲染输出、编码 / 转义 | — | 每个 surface 自建 |
| 能力降级策略 | 契约共享 | 每面实现降级动作 |

**Web 最小工作清单（未来接入时，按此顺序即可，不需要再改 Core）**

1. 实现 `SurfaceAdapter`：`attach(controller)` 订阅 `PresentationChange`，把 `PresentationNode` 映射为 DOM/组件（typed payload 已给出结构，不需要解析文本）。
2. 实现 DOM event → `PresentationIntent` 的映射；`ActionId` 复用，不复制业务判断。
3. 实现 `SlotContribution.payload` → 页面区域的渲染（`text`/`activity`/`notice`/`custom` 各自一个组件）。
4. 声明 `SurfaceCapabilities`；扩展据此降级（例如无 `overlays` 时不提供选择浮层，改走行内表单）。
5. 处理输出编码：Web 端一律 HTML escape；`sanitizeExternal` 已在 Core 完成一次。

**为什么不做通用跨 surface UI 框架**

- 共享几何需要抽象出“与终端无关的布局树”，再为每个 surface 实现布局引擎；成本高于各面自建，收益只在第三个以上 surface 出现。
- 共享组件协议会把 TUI 的行/宽/焦点假设固化进公共类型，正好是本规划要消除的耦合。
- 本次只定义 3 个契约（Controller、Composition、Capabilities）+ 1 个类型联合（`PresentationNode`）。超出这个范围的设计一律视为范围外，需重新复盘。

**边界自证**：`src/presentation/` 不得 import `src/ui`、`src/cli`、`src/extensions`、`src/ai`、`node:tty`、`node:process`、`node:fs`；只允许 `import type` 引用 Host/Session/Core 的公开类型。由 `check:boundaries` 新规则与 `tests/ui-presentation-boundary.test.ts` 双向验证。

### 3.6 扩展契约的开放面（W4 实施）

| 现状 | 目标 | 理由 |
|---|---|---|
| `hasUI(): boolean` | 新增 `capabilities(): SurfaceCapabilities`，`hasUI()` 由 `capabilities().interactive` 派生 | 布尔无法表达“有 UI 但不能显示图片/浮层”；扩展只能猜 |
| `readonly terminal: TerminalUIContext`（必填） | `readonly terminal?: TerminalUIContext` | 无头与未来 surface 不该被迫伪造终端 facet；TUI 适配器注入真实实现 |
| `notify(...) : void` | 返回 `SlotAck` | 扩展需要知道是否被顶掉/过期；只承诺“已受理”，不承诺像素可见 |
| `setWorking(...) : void` | 返回 `SlotAck` | 同上；`working` 单槽覆盖问题由回执暴露 |
| `Component` / `MessageRenderer` / `ToolRenderer` 返回 `Component` | 标注为 **TUI-only**，由 `TerminalUIContext` 提供；`ExtensionUIContext` 不再承诺自定义组件渲染 | 组件是终端行模型；Web 端应由该面自己的组件系统渲染 `PresentationNode.payload` |
| `BuiltinUIActions` 定义在 `extensions/ui-contract.ts` | 定义迁入 `presentation/actions.ts`；`ui-contract.ts` 继续 re-export | 保持扩展作者导入路径不变，同时让 Core 拥有动作词汇 |
| `setStatus` | 删除 | `src/extensions` 内无调用者，且 `statuses` 只写不读（R3） |

**兼容策略**：`terminal` 改为可选会让现有扩展的 `ui.terminal.x` 直接类型报错。这是有意的：扩展必须显式处理“无终端”分支，或在 `activate` 早期用 `capabilities()` 判断。不提供隐式 no-op terminal 兜底——那正是 R3“写而不读”的成因。

---

## 4. 工作流

### W0 基线、护栏与契约测试

**必要性：P0（前置，不可跳过）。** 没有基线，W1–W8 无法证明“等价”与“不回归”；现有测试覆盖宽度，但没有 live/replay 等价、状态矩阵、键位一致性。

**收益**

- 用户：后续每一批改动都有可回滚的行为证据。
- 开发：同类问题第一次有防复发手段；重构不再靠肉眼。

**设计**

1. 冻结 6 组 fixture：普通回合、工具五状态、长 CJK/emoji、ANSI/OSC 注入、表格+代码块、压缩+重试。
2. 新增 `tests/ui-frame-invariants.test.ts`：宽度 20–200，断言每行 `visibleWidth <= width`、无 C0/CR/LF、SGR 平衡。
3. 新增 `tests/ui-live-replay-equivalence.test.ts` 骨架（当前 skip 或 known-fail，W2 转绿）。
4. 新增 `tests/ui-keymap-conformance.test.ts` 骨架：从浮层页脚提取键位 token，断言存在绑定（当前 F1/F3/F5/F7 会失败）。
5. 新增 `scripts/ui-frame-bench.ts`：1000 节点转录，宽 80/120/200 的单帧耗时；只记录，不设门槛。
6. `scripts/check-boundaries.mjs` 新增 Presentation Core 规则：`src/presentation/` 不得 import `src/ui`、`src/cli`、`src/extensions`、`src/ai`、`node:tty`、`node:process`、`node:fs`；同时往 `selfTestSamples` 加至少 2 个违例样本，证明规则会失败。
7. 新增 `tests/ui-controller.test.ts` 骨架：在测试内用 fake controller + fake surface 喂 `HostEventRecord`，断言 `view()` 稳定、`subscribe` 只发增量、`dispatch` 到达 intent sink（W2e 接真实实现后转绿）。
8. 基线数值与 known-fail 清单写入本文档附录 B。

**验收**

- 不变量测试能运行并给出结果；失败项逐条链接审计编号。
- `check:boundaries` 的自测证明新规则可失败，且当前代码通过（`src/presentation/` 尚未建立时视为空集通过）。
- 基线数据可复现（同一 fixture、同一命令）。

**风险**：golden 快照对 ANSI 脆弱。对策：快照前把 ANSI 规范化为 token，只比结构。

---

### W1 事实层

**必要性：P0。** A8、A9、A10、A16、A17、B4、C7 都是“事实在 UI 里现算”的直接后果；不先修事实，投影只能继续猜。

**收益**

- 用户：恢复会话的耗时、状态、轮次与实时一致；中止后不再有永远转圈的节点。
- 开发：UI 不再持有 `Date.now()` 推导；新增展示只消费 Fact。

**设计**

1. `src/host/events.ts` 新增 `HostEventRecord { at: number; event: HostEvent }`；Host 在统一派发点生成记录，保留现有 `onEvent` 回调不变，新增 `onEventRecord`。`RuntimeEvent` 与 `HostEvent` 的定义不动。
2. `src/presentation/ingest-live.ts` 把 `HostEventRecord` 转成 Fact。无时间字段的 RuntimeEvent 使用 `record.at`；未知仍为 `undefined`。
3. `src/presentation/ingest-replay.ts` 把 `SessionEntry[]` 转成 Fact。`tool_started` / `tool_finished` 自带 `timestamp`，直接得到开始、结束与状态；缺 `tool_finished` 时不生成完成 Fact，节点保持 `unknown` 或 `not_started`（由 recovery 的结算结果决定）。
4. `src/presentation/FactStore.replaceAll` 支持 `session_rewind` 与会话恢复。
5. usage Fact 保留 `estimated` 标志；新一轮开始时估算只影响 token 数，不清空上一轮真实 usage 与 cache 字段（B4）。
6. `RequestUsage.promptTokens` 只加注释说明“不含 cacheRead”，不改字段名（见 B7 处置：持久化风险优先）。
7. 归属：Fact 类型与两个 ingest 都在 `src/presentation/`；对 `host/session/core` 只允许 `import type`，不 import 任何实现（Host 事件与 journal 类型是公开契约，不反向依赖）。
8. `src/presentation/controller.ts` 的 `PresentationController.ingest()` 是唯一实时入口；Host 只多一个 `onEventRecord` 回调，不知道 Presentation Core 的存在。

**验收**

- 固定 journal fixture：replay 产生的工具 Fact 含真实 `durationMs`，且等于 `finished.timestamp - started.timestamp`。
- live fixture 与 replay fixture 产生相同 Fact 序列（除 `origin`/`seq`）。
- 任何 Fact 缺 `at` 时，投影不得生成耗时。
- Fact 不包含任何由 UI 现算的时间；缺 `at` 保持 undefined。
- `src/presentation/` 内无 `Date.now()`、无 `node:tty`/`node:process`/`node:fs` import，`check:boundaries` 通过。

**连锁**

- `tui.ts` 删除事件到达时的耗时推导；`agent-events.ts` 改为纯投影。
- `transcript.ts` 恢复路径不再用 `receivedAt` 当前时间。

**风险**：Host 事件包装影响所有消费者。对策：新增回调，不替换旧回调；先接线 TUI，再迁移 stdio。

**回滚**：W1 独立可 revert；旧路径仍在，只是不再被 TUI 使用。

---

### W2 投影层

**必要性：P0。** 这是“单一事实源”真正落地的地方；A 类大部分、C1/C15/C16/C17、B1–B5 都在这里收口。

**收益**

- 用户：五种状态有各自图标/文案/颜色；失败压缩进入转录而非只闪 toast；中止后轨迹结算；恢复会话完整。
- 开发：`transcript.ts` 从“状态机 + 渲染器”降为“节点渲染器”；新增事件只改投影。

**设计：五个批次，逐批可 revert**

| 批次 | 内容 | 主要条目 |
|---|---|---|
| W2a 工具与轮次 | 工具节点、状态矩阵、稳定 ID、轮次编号、恢复字段 | A1–A4、A8、A17、A18 |
| W2b 轨迹 | 中止结算、rewind/恢复重建、聚合键、详情顺序、环形上限 | A9–A11、C15–C17 |
| W2c 计量与活动 | usage 估算/真实、缓存未知、重试本次耗时、压缩 token 不混入 | B1–B5、C1、C7 |
| W2d 容器改造 | `TranscriptContainer` 消费 `PresentationNode[]`，删除自有状态推导；接通非 completed 压缩卡分支 | R1、R5、C1、G12 前置 |
| W2e 控制器与开放接缝 | `PresentationController`、`PresentationView`、判别联合 payload、`PresentationChange`、intent sink；TUI 降为 adapter；fake surface 测试转绿 | H3、R6、开放接缝 P1 |

**工具状态矩阵（TUI、轨迹、分支检查器共用）**

| status | 图标 | 文案 | 颜色 | 无输出时 | 依据 |
|---|---|---|---|---|---|
| `succeeded` | ✓ | 完成 | green | 执行完成，无输出 | result 成功 |
| `failed` | ✗ | 失败 | red | 失败，无输出 | result 失败 |
| `cancelled` | ⊘ | 已取消 | yellow | 已取消，无输出 | status |
| `unknown` | ? | 结果未知 | yellow | 结果未知 | 已开始但无结算 |
| `not_started` | ○ | 未执行 | gray | 未执行 | 未开始（排队/前置失败） |

规则：

- `cancelled` 只认 `status`，不认 `obj.cancelled` 字段。
- `exitCode` 缺失不显示 0；显示“退出码未知”。
- 自定义 `ToolRenderer` 路径同样输出图片提示，不允许因自定义渲染丢掉附件。
- 稳定 ID：`turn:${n}:tool:${callId}`；消息：`turn:${n}:msg:${index}`；压缩：`compaction:${id}`。展开状态按 ID 记忆，修复“每次 rebuild 都折叠”。

**轨迹规则**

- `turn_aborted`：所有在途 `thinking` / `tool_call` / `model_stream` 节点结算为 `cancelled`（用户主动）或 `unknown`（恢复缺口）。
- `session_rewind` 与恢复：`replaceAll(replayFacts)` 后重建，不保留旧节点。
- 聚合键：`${kind}:${name}`，不再用含唯一 `Turn #n` 的 label。
- 显示 `errors` 与 `totalTokens`，或从数据结构中删除；不允许“采集但不展示”。
- 节点上限：保留最近 5000 个明细节点，更早的折叠为聚合行（防长会话内存增长）。

**计量规则**

- `~` 只用于估算；真实 usage 不带 `~`。
- TPS 若仍按常量估算，必须标“估算”；否则删除该字段。
- 缓存：`未报告` 与 `命中 0%` 分开；`cacheRead <= 0` 不再一律 undefined。
- 压缩：`tokensBefore` 缺失不显示 0；压缩 token 不混入热点 token 合计。
- provider retry：显示本次重试耗时，不显示整轮耗时。
- 压缩失败/取消/noop：写转录卡片，toast 仅作即时提示。

**验收**

- 状态矩阵测试：5 状态 × 3 展示面语义一致。
- live/replay 等价测试转绿（节点序列 deep equal，除 `origin`/`at`）。
- 中止测试：`tool.started` 无 `finished` + `turn_aborted` → `cancelled`；恢复缺口 → `unknown`。
- 恢复耗时等于 journal 时间戳。
- 压缩失败出现在转录。
- 展开状态在流式重渲染与恢复后保持。
- W2e：`PresentationNode` 的 `switch` 在 TUI 渲染处穷尽（`never` 兜底），新增 kind 编译期报错。
- W2e：fake surface 只依赖 `PresentationController`，能拿到 view、收到 change、发出 intent；不 import 任何 `src/ui` 模块。
- W2e：`src/presentation/` 不 import `src/ui`，`check:boundaries` 通过。

**连锁**

- `tui.ts` 事件处理缩为“追加/替换 Fact”；`consume()` 变为 `controller.ingest()` 的薄适配层。
- `agent-events.ts` 删除轨迹聚合与耗时推导。
- `transcript.ts` / `cards.ts` / `tool-view.ts` 改为只读节点。
- `smooth-reveal` 的 key 改用稳定节点 ID，避免流式期间重复创建。
- `presentation/controller.ts` 成为 TUI 与 print/stdio 的共同上游；两个 surface 只做订阅与渲染。

**风险**

- 流式性能：每次 delta 不能全量重投影。对策：`assistant.delta` 走增量追加，Markdown 段落缓存以 `id + width + text 长度` 为 key。
- 恢复与实时字段不一致：用等价测试先暴露，再决定补 journal 还是补投影。
- 判别联合迁移面大（`payload: unknown` → 每 kind 明确结构）：先加类型与穷尽 switch，再逐 kind 收窄；不允许保留 `unknown` 兜底。
- TUI 假设回流：任何“宽度/行/关键帧”字段出现在 `PresentationNode` 即视为违规，测试拒绝。

**回滚**：按 a/b/c/d/e 五批提交；每批 `pnpm typecheck` + 目标测试绿。

---

### W3 布局与面板

**必要性：P0。** D 类 18 条、C9–C14/C18、R2 都指向“没有统一布局原语”。不抽出来，修完仍会散落。

**归属：W3 全部属 TUI Surface。** `layout/frame.ts`、`layout/fit.ts`、`layout/panel.ts`、宽度表、`OverlayStack` 都在 `src/ui/`；不进入 Presentation Core，也不作为 Web 的复用对象。Web 用自己的 CSS/布局；共享的是 `PresentationNode` 与槽位语义，不是 `fitLine` 或 `FrameLayout`。

**收益**

- 用户：任何宽度下边框不丢、长内容有省略或换行而不是静默消失；浮层不因一行超宽被 `…` 吃掉角。
- 开发：新增组件不再复制截断代码；宽度错误由断言而不是截图发现。

**设计**

1. 把 `UIHost` 的私有 `layoutFrame()` 抽成 `layout/frame.ts` 的 `computeFrame(input): FrameLayout`。输入是纯数据，输出是纯几何；`UIHost` 只负责组装。
2. `layout/fit.ts` 成为唯一截断/换行/清洗入口：
   - `ellipsis`：消息、列表项、路径短段。
   - `middle-ellipsis`：cwd、长 ID。
   - `wrap`：浮层正文、详情。
   - `clip`：只用于已知精确宽度的边框内部，且由 `PanelFrame` 保证。
3. `layout/panel.ts` 的 `renderPanel` 统一标题、内宽、页脚、提示；每行宽度必须精确等于 `boxWidth`，否则开发态抛错、生产态裁剪并计数（不再用 `…` 替换边框）。
4. `OverlayStack` 的 `compositeTuiLine` 遇到超宽行时：开发态输出诊断（overlay id、行号、超出列数），运行态裁剪并保留右边框。
5. 修正宽度表：单一 `charWidth` 来源，统一 tab 宽度；补齐漏判符号，收窄 emoji 宽段；CJK/组合字符按 grapheme 计算。
6. `reservedRight` 不再写死 36/10，由 activity/context 组件的 `measure(width)` 计算。
7. 组件禁止直接调用 `truncateToWidth`；测试用 grep allowlist 约束（只允许 `layout/fit.ts` 与 `markdown-table` 内部）。

**验收**

- `ui-frame-invariants` 在 20–200 列全绿。
- 浮层边框测试：所有行精确 `boxWidth`，`╯` 不再变 `…`。
- 面板页脚始终包含关闭键（与 W5 联调）。
- 源码中 `truncateToWidth` 调用点只剩 allowlist。
- 帧基准相对 W0 劣化不超过 10%。

**连锁**：所有 widget/overlay 的 `render(width)` 签名与测试；`banner`、`suggestions`、`branch-inspector`、`trajectory-scene`、`model-picker`、`prompt-overlay`、`extension-ui-context` 的框架。

**风险**：宽度表修正会改变换行位置，快照差异需逐条审阅，不盲接受。

---

### W4 槽位与扩展契约

**必要性：P1（建议做，收益集中在扩展作者体验与信息可见性）。** C2–C6、C22–C24、H1/H2；对个人项目，扩展作者就是自己，收益是“下次写扩展不用猜”。

**收益**

- 用户：三个通知不再互相覆盖；压缩进度只有一个来源；后台工作可并列看到；模型列表不再静默缺项。
- 开发：每个 `set*` 有回执；冲突策略显式；无读取端的接口直接删除。

**设计**

1. 槽位表：

| 槽位 | 写入者 | 可见性 | 冲突策略 | 上限 |
|---|---|---|---|---|
| `header` | 扩展 | 常驻 | 最新覆盖，回执 `shadowed` | 1 |
| `footer` | 扩展 | 常驻 | 同上 | 1 |
| `notice` | Host/扩展 | 常驻 | 进转录，按 `dedupeKey` 去重 | 无 |
| `activity` | Host/扩展 | busy 或显式 | 按 priority 并列 | 3 + “+N” |
| `toast` | 任意 | 瞬时 | 队列、按 `dedupeKey` 去重、按等级排序 | 3 |
| `above` / `below` | 扩展 | 常驻 | `measure(width)` + 高度预算，溢出显示“还有 N 项” | 预算内 |

2. 中立层：`src/presentation/composition/slots.ts` 实现 `SlotRegistry`，只处理 `SlotContribution`（id、slot、priority、ttlMs、dedupeKey、中立 `payload`）与 `SlotAck`；不 import `Component`，不接收 `render(width)`，也不自行读时钟——TTL 由 surface 心跳调用 `expire(at)` 推进。
3. TUI 层：`src/ui/composition/render.ts` 把 `SlotPayload` 映射为终端行（`text`/`activity`/`notice` 各有渲染函数；`custom` 交给扩展注册的 TUI 组件，仅 TUI 支持）。
4. 删除 `ExtensionUIContext.setStatus`、`UIHost.statuses`、`runner` 中的 scoped 包装与 no-op。核实结果：`src/extensions` 内无实际调用者。
5. `notify` 与 `setWorking` 返回 `SlotAck`（加法变更）。本地扩展不受影响；调用方可选择忽略返回值。回执只表示“已被 Registry 受理/被顶掉/已过期”，不承诺像素可见。
6. `ExtensionUIContext` 新增 `capabilities(): SurfaceCapabilities`；`hasUI()` 改为 `capabilities().interactive` 的派生；`terminal` 改为 `readonly terminal?: TerminalUIContext`。TUI 适配器注入真实 facet，`createPrintUI` 不再伪造 terminal。
7. `setWidget` 强制 `render(width)` 与 `measure(width)`；溢出不再 `slice` 静默丢行。`MessageRenderer` / `ToolRenderer` / `Component` 明确标注 TUI-only，由 `TerminalUIContext` 提供；`ExtensionUIContext` 不再承诺自定义组件。
8. 压缩进度单一写入者：`builtin.ts` 负责阶段，`tui.ts` 不再重复写；toast 只在开始与终态各一次。
9. `provider_retry` 只保留 activity 行，不再同时发 toast（C8）。
10. 模型发现（C23，`ai/providers.ts`）：`contextWindow` 未知的模型也进入候选，UI 显示“窗口未知”；`model-picker` 空分组给出明确提示，而不是 Enter 无反应（C24）。
11. 建议卡空结果返回“无匹配”卡片（C22）。
12. `runner.ts` 的 scoped `terminal` Proxy 按 optional 重写：`base.terminal === undefined` 时不再创建 Proxy；`setWidget` / `setHeader` / `setFooter` / `showOverlay` 在无终端 surface 走 `SlotAck` 或明确 no-op，不静默成功。

**验收**

- 槽位契约测试：枚举所有对外 `set*`，断言存在读取端；`setStatus` 删除后全仓无引用。
- 三条通知同时到达：全部可见或按队列显示，覆盖率为 0。
- widget 超预算：显示“还有 N 项”，不丢行。
- 模型列表含 `contextWindow` 未知项，选择后不崩溃。
- fake surface：声明 `interactive:false, overlays:false, images:false`，扩展的 `notify`/`setWorking` 得到 `SlotAck`；`hasUI()` 为 false；`ui.terminal` 访问要么类型报错、要么在 `capabilities()` 判断后走降级路径。
- `src/presentation/composition/` 无 `src/ui` import，`check:boundaries` 通过。

**风险**

- 删除 `setStatus` 是破坏性变更。核实无调用者后再删，不留兼容层。
- `terminal` 改 optional 会让现有扩展类型报错。对策：这是有意的显式失败；一次改完，不提供 no-op terminal 兜底。
- `custom` 槽位只有 TUI 能渲染。对策：扩展必须用 `capabilities().overlays` 或 `richText` 判断，不能假设自定义组件在所有 surface 可见。

---

### W5 浮层键位与提示

**必要性：P1。** F 类 10 条；改动小、用户感知直接。W3 提供面板后，键位表可一次收口。

**收益**

- 用户：提示写什么，按键就做什么；Esc/Enter 语义明确；帮助不再任意键关闭。
- 开发：新增浮层只写 keymap，不再手写页脚。

**设计：每个浮层声明 `Keymap`（TUI 专用）**

归属：`src/ui/keys/keymap.ts` 只负责 key token → `ActionId`；字节解析复用现有 `src/ui/core/keys.ts` 的 `matchesKey`，不重写按键识别。`ActionId` 与 `PresentationIntent` 在 `src/presentation/actions.ts`。`Binding` 不再携带 `run()` 闭包；执行由 TUI 把 `ActionId` 映射为 intent 后交给 controller，或由 surface 自行处理界面内状态（如滚动、移动焦点）。

| 浮层 | 捕获 | 键位 | Esc | Enter | 提示来源 |
|---|---|---|---|---|---|
| help | 是 | `?`/Esc 关闭；↑↓ 滚动 | 关闭 | 无 | keymap |
| effort | 是 | ←→ 预览；Enter 提交；Esc 回滚 | 回滚 | 提交 | keymap |
| prompt | 是 | ↑↓ 1 行；PgUp/PgDn 8 行；j/k | 关闭 | 无 | keymap |
| trajectory | 是 | ←→ 移动；Tab 视图；`e` 下一错误；Enter 详情 | 关闭 | 展开/收起 | keymap |
| branch | 是 | Tab 焦点；←→ 按 X/Y 计行翻页；Esc 返回/关闭 | 返回 | 选择分支 | keymap（按焦点） |
| suggestions | 否（内联） | ↑↓ 选择；Enter/Tab 接受；Esc 取消 | 取消 | 接受 | 编辑器 |

具体修正：

- **effort**：←/→ 只预览，Enter 提交，Esc 回滚；`✓` 标已提交值，焦点另用高亮；删除 `DEFAULT_EFFORT_TIERS` 回退；未声明档位时不预选任何项（A5/A6）。
- **help**：关闭键限定 Esc/`?`；其他可打印键不再关闭也不再吞掉；思考档位文案按实际 `thinkingLevels` 生成；补 Ctrl+L（A7/F5）。
- **trajectory**：实现 Enter 详情，或删除“Enter 展开”；hotspot 的 ←/→ 要么生效，要么提示隐藏；compact 模式 Tab 生效或提示隐藏；`e` 写进提示（F1/F2）。
- **branch**：提示按焦点生成；history 模式 Esc 写“返回”；“Enter 选择分支”只在分支选择模式显示；翻页行数与 X/Y 计数一致（F7）。
- **prompt**：实现 ↑/↓ 或改页脚；补位置指示。
- **suggestions**：补键位提示；无参命令 Enter 执行时提示写明“立即执行”。
- **help 点击**：捕获态浮层点击外部不关闭；仅关闭按钮/Esc 生效（F9）。

**验收**

- 键位一致性测试：渲染页脚 → 提取 token → 每个 token 有绑定；对绑定注入按键 → 产生声明效果。
- 键位表只引用 `ActionId`，不引用函数；同一 `ActionId` 可由 fake surface 直接 `controller.dispatch()` 触发。
- slider：Esc 后回到原档位；Enter 后才写回。
- help：输入普通字符不关闭，`?` 关闭。
- 每个浮层有显式 `capturing` 标志与测试。

**风险**：键位语义变化会改变肌肉记忆。对策：文案在 help 中同步更新；一次只改一个浮层。

---

### W6 Markdown、diff、工具文本与文案

**必要性：E1–E4 为 P0（数据损坏），其余 P1/P2。** E1 会把 Windows 路径吃掉，E2 会把代码块里的表格渲染成表格，E3 的“还有 N 行变更”不可信，E4 给代码框边框前加“●”。

**收益**

- 用户：复制路径不再丢反斜杠；代码块内容不被误渲染；diff 计数可信；中英、耗时、状态文案统一。
- 开发：stdio 与 TUI 共用一套工具渲染；新增工具只写一个渲染函数。

**设计**

| 项 | 修法 |
|---|---|
| E1 反斜杠 | `splitMarkdownCells` 只把“反斜杠 + 竖线”当转义，其他反斜杠原样保留 |
| E2 围栏优先 | `feedLine` 先判围栏，再判表格 |
| E3 diff 计数 | 变更计数只统计 add/del；折叠项只含变更行 |
| E4 边框守卫 | 先 `stripAnsi`，再判 `┌`/`│` 前缀 |
| E5 大 diff | 超 LCS 帽时显式标“已简化显示”，不再伪装全删全增 |
| E6 CJK 分词 | 按码点/词边界分词，`\w` 不作为唯一依据 |
| E7 伪语言 | `code` 改为“文本”；按行高亮改为按块；别名表已存在，不扩 |
| E8 缩进 | 保留嵌套列表缩进，box-drawing 行允许换行 |
| E10 表格宽度 | 列宽按渲染后宽度测量；仅表头不渲染空网格 |
| G6 双渲染 | stdio 消费同一 `renderToolBlock(model, width)`；删除 `format.ts` 的工具展示函数 |
| G9 诊断严重度 | 用结构化 severity；删除文本启发式降级 |
| G10 参数摘要 | 键名对齐 Uina 工具参数；修注释 |
| G11 错误回退 | 无 `obj.error` 时显示清洗后的结构化摘要，不直接吐原始 JSON |
| G12 rebuild | 保留 `expanded`；渲染失败文本先清洗 |
| C20 错误文案 | 统一 `toReadableError(error)`，不输出 `String(error)` 或构造器名 |
| C21 SKIP | 保留过滤；修 `.uina` 注释与代码一致 |
| A12/A13 分支详情 | 不显示 `seq:0` 占位；tool 详情补 status/name/call_id；缺失 args 显示“参数未知” |

**文案表 `src/presentation/copy.ts`**

- 只做常量与格式化函数，不做 i18n 框架。
- 平台中立：术语、状态词、耗时格式、大小写、错误可读化都在这里；不含任何 ANSI、宽度或终端判断。
- TUI/stdio 各自把文案嵌进自己的渲染；Web 未来可以直接复用同一文案。
- 统一术语：选“思考档位”（help、/effort、slider 一致），或统一为“推理强度”；一次选一个，全仓替换。
- 统一耗时：一个 `formatDuration(ms, style)`，删除四套写法。
- 统一状态词：完成/失败/已取消/结果未知/未执行。
- 统一大小写：`Ctrl+O` 全仓一致。
- 英文残留：`Running…`、`(ctrl+o to expand)`、`(Help Menu)`、`(Timeline)`、`(diff)` 等改为中文；保留必要的技术名词。
- 中断提示主体：不再用 `modelName` 冒充主体名（G8）。

**工具模型**：`ToolModel` 在 `src/presentation/projection/tools.ts`，只含名称、参数、状态、结果、错误、图片计数、耗时；`renderToolBlock(model, width)` 属文本 surface（TUI 与 print/stdio 共用），Web 用自己的组件渲染 `PresentationNode.payload`，不复用该函数。

**验收**

- Markdown fixture：`C:\Users\x` 原样；围栏内表格不渲染；diff 计数只含变更；1000+ diff 有“已简化”。
- 文案测试：可见文本无原始枚举/英文（白名单除外）。
- 同一 ToolModel 在 TUI 与 stdio 的输出快照一致。

**风险**：文案替换面广，易漏。对策：`copy.ts` + 文案测试扫描可见字符串。

---

### W7 输入、终端与注入安全

**必要性：I2 为 P0（安全）；其余 P1。** 模型输出、工具输出、错误文本、文件名都可能含 OSC/CSI；当前用户文本与轨迹未统一清洗。

**收益**

- 用户：恶意/意外的控制序列不能改标题、写剪贴板、伪造链接；点击位置与光标一致；粘贴块字数可信。
- 开发：清洗只在入口做一次，渲染器不再各自补。

**设计**

1. `sanitizeExternal` 在 `src/presentation/sanitize.ts`，于 Fact 入口统一执行：去除 OSC、DCS、CSI（含 SGR）、C0（保留 `\n`）、C1、DEL、bidi 控制符。需要样式的内部文本由渲染器重新上色。各 surface 仍负责自己的输出编码：TUI 防 ESC，Web 必须 HTML escape，远程协议必须拒绝控制字符。
2. 注入测试向量：OSC 8 超链接、OSC 52 剪贴板、CSI 改标题、DCS、裸 ESC、CR、DEL、U+202E、零宽字符、半个代理对。
3. 输入命中测试改用布局产出的 `InputMetrics { promptWidth, cursorCol }`；删除 `col - 2` 硬编码与 `graphemeWidth / 2` 比较。
4. 粘贴：marker 按显示宽度与字素计数；`▾` 要么可点，要么去掉；`[已粘贴 #id +N行/Y字]` 的“字”按 grapheme。
5. 建议卡：宽度不超终端；名称/路径截断；loading 单行；“无匹配”可见。
6. banner：cwd 用中间省略；标语与鲸鱼按同一内宽居中。
7. scrollbar：百分比与行数使用同一基准；250ms 防抖若实测无效果则删除。
8. 剪贴板：`copyToClipboardUnified` 返回结果；失败 toast 明示；字符数按 grapheme。
9. 终端能力：`NO_COLOR`/`TERM=dumb` 下零 SGR；非 UTF-8 控制台启动时提示；窄终端有明确下限与降级。
10. 性能：流式 chunk 只投影增量；Markdown 段落缓存 key 含宽度；trajectory 有上限。

**验收**

- 注入套件：帧内无 ESC/OSC/C1/bidi；宽度不变量仍成立。
- 命中测试：提示符与光标区每一列点击都命中正确 grapheme。
- `NO_COLOR=1` 运行输出零 SGR。
- TTY 手测清单通过（见 §6）。
- 帧基准在预算内。

**风险**：剥离工具输出颜色会改变观感。对策：外部内容一律视为不可信，先清洗再由 Uina 上色；这是有意取舍。

---

### W8 清理、文档与归档

**必要性：P1（收尾）。** 不做这一步，旧路径会以死代码形式留下，下一次修改继续分叉。

**内容**

1. 执行 §7 删除清单。
2. 更新 `docs/current-runtime.md` 的 UI 描述：写明 `src/presentation/` 是平台中立展示核心，`src/ui/` 是 TUI Surface Adapter，`src/cli/stdio-render.ts` 是 print/stdio Surface。
3. 更新 `AGENTS.md` 代码地图：加入 `src/presentation/`（facts、controller、projection、composition、actions、copy），并把 `src/ui/` 行改为“TUI Surface Adapter：布局、按键、渲染、输入”。
4. 在 `docs/proposals/INDEX.md` 标注本规划状态；审计文档保留为历史证据。
5. 跑 `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm verify:cli`；补 TTY 手测记录。
6. 复核：审计 114 条逐条有处置；不成立项写明理由。
7. 复核 B.4 开放接缝清单：9 项全部有源码或测试证据，缺项回到对应工作流，不口头声称完成。

**验收**

- 全仓无被删符号引用；`pnpm typecheck` 绿。
- 文档与源码一致；审计条目处置可追溯。
- 没有“临时兼容层”。

---

## 5. 阶段门与复盘机制

### 5.1 阶段门

| 门 | 时机 | 通过条件 | 不通过怎么办 |
|---|---|---|---|
| G0 | W0 后 | 基线/不变量/known-fail 清单齐全；`check:boundaries` 新规则与违例自测通过 | 补 fixture，不进入 W1 |
| G1 | W1 后 | live/replay Fact 等价；无 `Date.now()` 投影；`src/presentation/` 仅 type-only 依赖 | 先补 journal 字段，不改投影 |
| G2 | W2 后 | 状态矩阵、等价、中止、恢复耗时、展开保持全绿；判别联合 switch 穷尽；fake surface 通过 | 缩小批次，回到 W2a |
| G3 | W3 后 | 20–200 列不变量、浮层边框、grep allowlist | 修宽度表，不进入 W4 |
| G4 | W4 后 | 槽位回执、读取端枚举、toast 队列、widget 溢出；`SlotContribution` 无渲染函数；`capabilities()` 生效；`terminal` optional；fake surface 能力降级 | 删除无读取端接口，不保留 |
| G5 | W5 后 | 键位一致性全绿；每个浮层有 capturing；`ActionId` 可被 fake surface 直接 dispatch | 先补 keymap，再改提示 |
| G6 | W6 后 | Markdown/diff/文案 fixture 全绿；TUI/stdio 同源；`copy.ts` 平台中立 | 回退单项，不扩语法 |
| G7 | W7 后 | 注入套件、NO_COLOR、命中测试、TTY 清单；`sanitizeExternal` 在 Core、输出编码在 surface | 阻断发布，先修安全 |
| G8 | W8 后 | 全量测试/构建/CLI 验证；文档一致；B.4 清单逐项有证据 | 保留旧路径，不算完成 |

### 5.2 “随时审视”机制

- **开工前细化卡**（≤10 行）：范围、涉及文件、测试、回滚点。只细化当前工作流，不提前细化后续。
- **收工复盘四问**：
  1. 这一批改变了哪些事实？是否引入第二事实源？
  2. 删除了什么？是否还有旧路径被调用？
  3. 哪些测试能证明？失败意味着什么？
  4. 还有什么未知？是否需要回到粗框架重评估？
- **立即重评估的触发条件**：
  - 单批改动超过声明的源文件数 50%（默认 12 个）。
  - 同一个门连续两次失败。
  - 需要修改 `core/` 或新增概念（当前设计不应发生）。
  - live/replay 等价无法用现有 journal 达成。
  - 帧基准劣化超过 20% 且无法在当批修复。
- **决策日志**：写在本文档附录 B，追加式，不覆盖历史。

### 5.3 提交策略

- 一个批次一个可编译提交；测试红不提交。
- 按 W2a→W2b→W2c→W2d→W2e 顺序，不合并成一个大提交。
- 不引入运行时开关；回滚靠 revert 批次，不靠兼容分支。

---

## 6. 测试矩阵

| 测试 | 文件 | 断言 | 生效 |
|---|---|---|---|
| Presentation 边界 | `scripts/check-boundaries.mjs` + `tests/ui-presentation-boundary.test.ts` | `src/presentation/` 不 import `ui/cli/extensions/ai`、无终端/进程/文件模块；规则自带违例自测 | W0 起常驻 |
| 控制器 | `tests/ui-controller.test.ts` | fake surface：`view()` 稳定、`subscribe` 只发增量、`dispatch` 到达 intent sink、`replaceAll` 后旧节点清空 | W2e |
| Surface 能力 | `tests/ui-surface-capabilities.test.ts` | `capabilities()` 与 `hasUI()` 一致；无 `terminal` 时扩展降级不崩；`notify`/`setWorking` 返回 `SlotAck` | W4 |
| 帧不变量 | `tests/ui-frame-invariants.test.ts` | 每行 `visibleWidth <= width`；无 C0/OSC；SGR 平衡 | W0 起常驻 |
| live/replay 等价 | `tests/ui-live-replay-equivalence.test.ts` | 节点序列 deep equal（除 `origin`/`at`） | W2 |
| 状态矩阵 | `tests/ui-status-matrix.test.ts` | 5 状态 × 工具卡/轨迹/分支一致 | W2 |
| 稳定 ID | `tests/ui-node-identity.test.ts` | 重渲染、恢复、rewind 后 ID 不变 | W2 |
| 浮层边框 | `tests/ui-overlay-frame.test.ts` | 所有行精确 `boxWidth` | W3 |
| 槽位契约 | `tests/ui-slot-contract.test.ts` | 每个 `set*` 有读取端；冲突可见；payload 无渲染函数 | W4 |
| 键位一致性 | `tests/ui-keymap-conformance.test.ts` | 页脚 token ⊆ 绑定 | W5 |
| 文案一致 | `tests/ui-copy.test.ts` | 可见文本无原始枚举/英文（白名单） | W6 |
| Markdown fixture | `tests/ui-markdown-fixtures.test.ts` | 路径、围栏、diff 计数、大 diff 标注 | W6 |
| 注入 | `tests/ui-injection.test.ts` | 注入向量不改变帧结构 | W7 |
| 输入命中 | `tests/ui-input-hit-test.test.ts` | 每列点击命中正确 grapheme | W7 |
| 性能 | `scripts/ui-frame-bench.ts` | 80×24 ≤ 16ms；200×60 ≤ 33ms；1000 行 | W0 基线、W3 复核 |

**TTY 手测清单（W7 必须执行）**

- 80×24、120×40、40×15 三种尺寸：主界面、浮层、建议卡、粘贴块。
- `NO_COLOR=1`：零 SGR，布局不塌。
- 中文输入法组合态：光标、候选、提交后位置。
- 括号粘贴 1 行/3 行/100 字符/超大文本：折叠、展开、字数。
- 流式输出中缩放终端：不闪断、不丢边框。
- help/effort/prompt/trajectory/branch 五个浮层：提示与按键逐项对照。
- `Ctrl+L`、`Ctrl+O`、`Alt+O`、Esc、Ctrl+C：实际效果与提示一致。
- 会话恢复 + rewind：耗时、轮次、工具名、状态与实时一致。

**性能预算说明**

- 预算基于本机 W0 基线，不对外承诺；超过 20% 触发复盘。
- 单帧布局必须一次完成；不允许为对齐而二次全量扫描。
- 流式路径只允许增量投影；Markdown 缓存必须含宽度。

---

## 7. 删除清单

| 符号/文件 | 原因 | 替代 | 批次 |
|---|---|---|---|
| `ExtensionUIContext.setStatus` | 无读取端 | 删除 | W4 |
| `UIHost.statuses`、`setStatus` | 同上 | 删除 | W4 |
| `runner.ts` 的 scoped `setStatus` 包装与 no-op | 同上 | 删除 | W4 |
| `DEFAULT_EFFORT_TIERS` 回退 | 编造未声明档位 | 未声明提示 | W5 |
| trajectory “Enter 展开” | 无处理器 | 实现详情或删提示 | W5 |
| `format.ts` 的 `toolStartLine` / `toolResultLines` | 双渲染 | 共享 `renderToolBlock` | W6 |
| `parseDiagnosticMessage` 文本启发式 | 误降级严重度 | 结构化 severity | W6 |
| `scrollbar-gutter` 250ms 防抖 | 疑似死代码 | 实测后删 | W3 |
| `reservedRight 36/10` | 写死 | `measure(width)` | W3 |
| `.uina` SKIP 注释 | 与代码不符 | 修注释 | W6 |
| `ExtensionUIContext.terminal` 必填约束 | 无头/未来 surface 被迫伪造终端 | 改为 optional facet | W4 |
| `createPrintUI` 的伪造 `terminal` facet | 无读取端 | 删除伪造，保留 no-op 上下文 | W4 |

**不删除**

- `SKIP` 候选过滤：设计意图，只修注释。
- `smooth-reveal`：有效机制，改用稳定 ID。
- prompt snapshot：已有 `/prompt` 消费者。
- `stdio-render`：保留入口，改为消费共享投影。
- `Component` / `TerminalUIContext`：仍是 TUI Surface 的合法渲染模型，只是不再冒充平台中立契约。
- `createPrintUI`：仍是第三面（无头）的合法实现，只是不再伪造 terminal。

---

## 8. 风险登记

| 风险 | 概率 | 影响 | 缓解 | 回滚 |
|---|---|---|---|---|
| W2 投影改造引入流式回归 | 中 | 高 | 增量投影 + 段落缓存含宽度 + 帧基准 | 按 W2a–e revert |
| 恢复 journal 缺字段，等价测试无法通过 | 中 | 高 | 先补 journal（W1），不改投影猜 | 回到 W1 |
| 宽度表修正导致大面积快照变化 | 高 | 中 | 逐条审阅差异，只接受可解释变化 | revert W3 宽度子批 |
| 删除 `setStatus` 破坏本地扩展 | 低 | 中 | 全仓 grep 无调用者再删 | revert W4 |
| 文案替换漏改 | 中 | 低 | `copy.ts` + 文案测试 | 单条修 |
| 布局断言在真实终端过严 | 中 | 中 | 断言只约束宽度与 ESC，不约束字形 | 放宽断言 |
| 范围蔓延到 Markdown 引擎重写 | 中 | 高 | W6 只修清单项，不扩语法 | 停止并复盘 |
| 开放接缝过度抽象 | 中 | 中 | 只定义 Controller / Composition / Capabilities 三个契约；不写 DOM/React/远程协议；超出即复盘 | 删除超出契约，保留已证实接缝 |
| TUI 假设泄漏进 Presentation Core | 中 | 高 | `check:boundaries` + fake surface + 代码评审关键词（width/line/ANSI/tty） | 移回 `src/ui/` |
| `terminal` 改 optional 使现有扩展类型报错 | 中 | 中 | 有意显式失败；一次改完；文档写明降级路径 | revert W4 的契约子批 |
| 判别联合 payload 迁移面大 | 高 | 中 | 先类型与穷尽 switch，再逐 kind 收窄；每 kind 一个提交 | 按 kind revert |
| 第二个 surface 需求提前到来 | 低 | 中 | W2e/W4 是关键路径；W3/W5/W7 可后置 | 只做 W0/W1/W2e/W4 |

---

## 9. 不做什么

- 不实现 Web、DOM、React、远程协议或第二个 surface；本次只留接缝，不交付新展示面。
- 不做通用跨 surface widget 协议、布局树、动画或主题系统。
- 不把布局、宽度、ANSI、按键字节、TTY 探测、终端能力放进 Presentation Core。
- 不为未来 surface 增加运行时开关或配置项；接缝靠类型与边界检查，不靠开关。
- 不在 `core/` 增加展示概念；`src/agent`、`src/session`、`src/core`、`src/tools`、`src/runtime` 的 allowlist 不动。
- 不引入 React / Ink / blessed 等 UI 框架。
- 不把 Markdown 重写成完整 CommonMark；只修 E1–E4 等清单项。
- 不做主题系统、i18n 框架、插件市场。
- 不修改真实 Provider 配置、真实会话、用户认证。
- 不为误报项改代码（D6、E9 主要指控、E11 等）。
- 不保留旧展示路径的兼容层；W8 直接删除。
- 不做长期愿景功能；本规划只解决展示层事实、布局、槽位、键位、安全与开放接缝。

---

## 10. 实施顺序

| 顺序 | 工作流 | 前置 | 独立回滚 | 说明 |
|---|---|---|---|---|
| 1 | W0 基线 | 无 | 是 | 先有证据；含边界规则与控制器骨架 |
| 2 | W1 事实 | W0 | 是 | Host 事件包装 + Fact；只进 `src/presentation/` |
| 3 | W2 投影 | W1 | 按 a/b/c/d/e | 核心收敛；W2e 是开放接缝关键 |
| 4 | W3 布局 | W0（可与 W2 并行） | 是 | 纯 TUI 几何，不进入 Core |
| 5 | W4 槽位 | W3 | 是 | Composition 中立化 + capabilities |
| 6 | W5 键位 | W3 | 是 | 提示依赖面板；ActionId 归 Core |
| 7 | W6 格式/文案 | W0（可插队） | 按项 | 数据损坏项先修 |
| 8 | W7 输入/安全 | W3 | 是 | 清洗在 Core，编码在 surface |
| 9 | W8 清理 | W1–W7 | 否 | 收尾 |

**关键路径（只做开放接缝时）**：W0 → W1 → W2e → W4。W3/W5/W7 是 TUI 质量与终端安全，不是 Web 前置；W6 的数据损坏项可随时插队。

**可插队快修（不等待架构，且不会被后续重写）**

- E1 反斜杠、E2 围栏优先、E3 diff 计数。
- C22 无匹配提示、C24 空分组反馈。
- 这些修复会被 W6/W4 的测试覆盖，但不必等整条流水线。

---

## 附录 A：审计条目处置表

列说明：**结论**（成立/部分/保留/不成立/未验证）；**处置**（重构/修复/删除/保留/误报）；**归属**（主工作流）。单条必要性由处置表达；单条收益 = 所在工作流的收益 + 说明列给出的直接效果。

### A. 硬约束（18）

| # | 结论 | 处置 | 归属 | 说明 |
|---|---|---|---|---|
| A1 | 成立 | 重构 | W2 | 无输出文案按 status 分流 |
| A2 | 成立 | 重构 | W2 | 五状态各自图标与文案 |
| A3 | 成立 | 重构 | W2 | 取消只认 status |
| A4 | 成立 | 修复 | W2 | exitCode 缺失不显示 0 |
| A5 | 成立 | 重构 | W5 | 未知档位不预选 |
| A6 | 成立 | 删除 | W5 | 删 7 档回退 |
| A7 | 成立 | 修复 | W5 | 档位文案按实际 levels |
| A8 | 成立 | 重构 | W2 | undefined 透传，恢复不伪造 |
| A9 | 成立 | 重构 | W1/W2 | 不编造 1ms；压缩 token 不混入 |
| A10 | 成立 | 重构 | W2 | 中止结算在途节点 |
| A11 | 成立 | 重构 | W2 | 五状态图标 + 中文 |
| A12 | 部分（待复现） | 修复 | W6 | 不显示 seq:0；短 ID 去重 |
| A13 | 部分（待复现） | 修复 | W6 | tool 详情补 status/name/id |
| A14 | 部分（待复现） | 修复 | W6 | 读取失败与空态分离 |
| A15 | 部分 | 修复 | W2 | 缺 previous 不判“首次” |
| A16 | 成立 | 修复 | W1 | 用记录时间，不取当前 |
| A17 | 成立 | 重构 | W2 | 恢复保留结构化字段 |
| A18 | 成立 | 重构 | W2/W4 | 自定义渲染器也提示图片 |

### B. 用量、速度、缓存（7）

| # | 结论 | 处置 | 归属 | 说明 |
|---|---|---|---|---|
| B1 | 成立 | 修复 | W2 | `~` 只标估算 |
| B2 | 成立 | 修复 | W2 | TPS 标估算或删除 |
| B3 | 成立 | 修复 | W2 | 剩余量估算加 `~` |
| B4 | 成立 | 重构 | W2 | 估算不清空真实 usage |
| B5 | 成立 | 修复 | W2 | 未报告与 0% 分开 |
| B6 | 成立 | 修复 | W7 | 超限可见；档位名不合并 |
| B7 | 成立（命名） | 保留 | W1 | 只加注释，不改持久化字段 |

### C. 信息被吞或丢失（24）

| # | 结论 | 处置 | 归属 | 说明 |
|---|---|---|---|---|
| C1 | 成立 | 重构 | W2 | 失败/取消压缩进转录 |
| C2 | 成立 | 重构 | W4 | toast 队列 + 去重 |
| C3 | 成立 | 重构 | W4 | notice 单一去向 |
| C4 | 成立 | 删除 | W4 | 删 setStatus/statuses |
| C5 | 成立 | 重构 | W4 | 压缩进度单一写入者 |
| C6 | 成立 | 重构 | W4 | working 并列显示 |
| C7 | 成立 | 修复 | W2 | 重试显示本次耗时 |
| C8 | 成立 | 修复 | W4 | 重试行与 toast 去重 |
| C9 | 成立 | 修复 | W3 | 不静默裁切 |
| C10 | 成立 | 修复 | W3 | 先截断后上色 |
| C11 | 成立 | 重构 | W3 | 统一宽度截断 |
| C12 | 部分 | 修复 | W3 | 宽屏换行显示完整 ID |
| C13 | 待复现 | 修复 | W3 | 保留样式，不二次 strip |
| C14 | 成立 | 修复 | W3 | 截断提示 + 按宽度切 + 线性 |
| C15 | 成立 | 重构 | W2 | 聚合键修正；显示 errors |
| C16 | 成立 | 修复 | W2 | 统一详情顺序 |
| C17 | 成立 | 重构 | W2 | 恢复/rewind 重建轨迹 |
| C18 | 成立 | 重构 | W3/W4 | 溢出可见，不静默丢行 |
| C19 | 成立 | 修复 | W7 | 复制结果真实；字数按字素 |
| C20 | 成立 | 修复 | W6 | 可读中文错误 |
| C21 | 保留（设计） | 保留 | W6 | SKIP 有意过滤；仅修注释 |
| C22 | 成立 | 修复 | W4 | 显示“无匹配” |
| C23 | 成立 | 修复 | W4 | 未知 contextWindow 也显示 |
| C24 | 成立 | 修复 | W4 | 空分组有反馈 |

### D. 版面与对齐（18）

| # | 结论 | 处置 | 归属 | 说明 |
|---|---|---|---|---|
| D1 | 成立 | 修复 | W3 | 名称/路径截断 |
| D2 | 部分 | 修复 | W3 | cardWidth 不超终端；类别列已陈旧 |
| D3 | 成立 | 修复 | W3 | 修正全宽表 |
| D4 | 成立 | 修复 | W3 | tab 宽度统一 |
| D5 | 成立 | 修复 | W3 | 热点行宽修正 |
| D6 | 不成立 | 误报 | — | 总宽等于 boxWidth |
| D7 | 成立 | 重构 | W3 | 超宽行显式失败/裁剪 |
| D8 | 成立 | 修复 | W3/W7 | 内嵌换行统一清洗 |
| D9 | 成立 | 修复 | W3/W7 | error/result 清洗 |
| D10 | 成立 | 修复 | W3 | rail 清洗 + 刻度 |
| D11 | 成立 | 修复 | W7 | 用户文本清洗 |
| D12 | 部分 | 修复 | W3 | 省略号前 reset；换行已按 cell |
| D13 | 成立 | 重构 | W7 | 命中测试用真实布局值 |
| D14 | 成立 | 修复 | W3 | 提示插在按钮前；宽度按可用空间 |
| D15 | 成立 | 重构 | W3 | reservedRight 由测量得出 |
| D16 | 成立 | 修复 | W3 | cwd 截断可见；对齐基准统一 |
| D17 | 部分 | 修复 | W3 | 百分比/行数同基准；防抖实测去留 |
| D18 | 成立 | 修复 | W7 | 粘贴字数按字素；▾ 可点或去掉 |

### E. Markdown 与 diff（11）

| # | 结论 | 处置 | 归属 | 说明 |
|---|---|---|---|---|
| E1 | 成立 | 修复 | W6 | 反斜杠不再被吃 |
| E2 | 成立 | 修复 | W6 | 围栏优先 |
| E3 | 成立 | 修复 | W6 | 变更计数只算增删 |
| E4 | 成立 | 修复 | W6 | strip 后判边框前缀 |
| E5 | 成立 | 修复 | W6 | 大 diff 显式标简化 |
| E6 | 成立 | 修复 | W6 | CJK 分词 |
| E7 | 部分 | 修复 | W6 | 伪语言名/按行高亮；别名已存在 |
| E8 | 成立 | 修复 | W6 | 保留缩进与悬挂 |
| E9 | 不成立（主要指控） | 误报 | — | `src/**` 未被吃；无斜体/删除线是能力边界，不扩语法 |
| E10 | 部分 | 修复 | W6 | 列宽按渲染宽度；空表不渲染网格 |
| E11 | 不成立 | 误报 | — | key 含 uid |

### F. 提示与按键（10）

| # | 结论 | 处置 | 归属 | 说明 |
|---|---|---|---|---|
| F1 | 成立 | 重构 | W5 | Enter 实现或删提示 |
| F2 | 成立 | 修复 | W5 | 热点/紧凑提示按实际能力 |
| F3 | 成立 | 修复 | W5 | 实现 ↑/↓ 或改页脚 |
| F4 | 成立 | 重构 | W5 | 预览/提交/回滚分离 |
| F5 | 成立 | 修复 | W5 | 关闭键限定；补 Ctrl+L |
| F6 | 部分 | 修复 | W5 | 宽屏滚动/紧凑提示/命令表 |
| F7 | 成立 | 重构 | W5 | 提示按焦点生成 |
| F8 | 成立 | 修复 | W5 | 措辞与快捷键提示 |
| F9 | 成立 | 修复 | W5 | 捕获态点击不关闭 |
| F10 | 成立 | 修复 | W5 | 建议卡补键位提示 |

### G. 语言、术语、格式（12）

| # | 结论 | 处置 | 归属 | 说明 |
|---|---|---|---|---|
| G1 | 成立 | 修复 | W6 | 英文残留中文化 |
| G2 | 成立 | 修复 | W6 | 枚举中文化；时间格式统一 |
| G3 | 成立 | 修复 | W6 | 术语统一 |
| G4 | 成立 | 修复 | W6 | 档位名/描述去编造 |
| G5 | 成立 | 修复 | W6 | 统一耗时格式 |
| G6 | 成立 | 重构 | W6 | stdio/TUI 同源 |
| G7 | 部分 | 修复 | W6 | 大小写/中英混排统一 |
| G8 | 成立 | 修复 | W6 | 中断提示不用 modelName |
| G9 | 成立 | 删除 | W6 | 删文本启发式降级 |
| G10 | 部分 | 修复 | W6 | 参数键名对齐；修注释 |
| G11 | 成立 | 修复 | W6 | 错误回退不吐原始 JSON |
| G12 | 成立 | 修复 | W6 | rebuild 保留展开；错误清洗 |

### H. 架构（6）

| # | 结论 | 处置 | 归属 | 说明 |
|---|---|---|---|---|
| H1 | 成立 | 重构 | W4 | 统一槽位抽象与回执 |
| H2 | 成立 | 重构 | W0/W5 | 契约测试保证接线生效 |
| H3 | 成立 | 重构 | W1/W2 | 事实与业务判断移出 UI |
| H4 | 成立 | 重构 | W2 | 耗时/轨迹/状态由投影负责 |
| H5 | 成立 | 重构 | W3 | 抽共用布局原语 |
| H6 | 成立 | 重构 | W6 | 单一渲染路径 |

### I. 未覆盖项（8）

| # | 结论 | 处置 | 归属 | 说明 |
|---|---|---|---|---|
| I1 | 部分成立 | 重构 | W1/W4 | 补漏显示：flush 失败、恢复结算、模型未知 |
| I2 | 成立（高风险） | 重构 | W7 | 入口统一清洗 + 注入测试 |
| I3 | 未验证 | 补测 | W7 | TTY 手测清单 |
| I4 | 未验证 | 补测 | W0 | 帧基准与流式性能 |
| I5 | 未验证 | 补测 | W7 | IME/粘贴/命中 |
| I6 | 成立 | 重构 | W6 | `copy.ts` 集中文案 |
| I7 | 部分（已有测试） | 补测 | W0 | 已有宽度测试；补等价/状态/键位 |
| I8 | 未验证 | 修复 | W8 | 文档逐条对源码 |

### 审计自撤回（不计入 114）

| 条目 | 结论 | 处置 |
|---|---|---|
| 转录占满时 toast 不可见 | 不成立 | 不改 |
| 缓存命中率重复计数 | 不成立 | 不改 |

---

## 附录 B：基线记录与决策日志

### B.1 W0 基线（施工时填写）

```text
日期：2026-10-29
提交：8babedf（W0 测试、基准与基线数据同批提交）
fixture：tests/ui-frame-invariants.test.ts 的 populate()（CJK/emoji、ANSI/OSC 注入、Markdown 表格+代码块、工具五状态、失败压缩卡、3 条 toast、working、pending queue）；scripts/ui-frame-bench.ts 的 seedNodes()（250 回合 × 4 节点）
尺寸 80×24 单帧：p50 0.081 ms / p95 0.150 ms
尺寸 120×40 单帧：p50 0.235 ms / p95 0.370 ms
尺寸 200×60 单帧：p50 0.269 ms / p95 0.553 ms
1000 节点转录 80×24：p50 0.260 ms / p95 0.693 ms（全量失效后 p50 0.226 ms）
已知失败：
  - tests/ui-keymap-conformance.test.ts（todo 骨架）-> 审计 F1、F3、F5、F7（W5 转绿）
  - tests/ui-controller.test.ts（todo 骨架）-> W2e 接真实 controller 后转绿
  - 帧内仍可见 OSC payload 残片（“覆盖ttps://evil…”）-> 审计 I2/D9；旧路径未接 sanitizeExternal，W2 接线后消失
基线复现：`pnpm exec tsx scripts/ui-frame-bench.ts`；宽度不变量：`pnpm exec vitest run tests/ui-frame-invariants.test.ts`
```

### B.2 决策日志模板（追加式）

```text
[W?_?] 日期
决策：
证据：
影响文件：
回滚点：
遗留未知：
```

[W1] 2026-10-29
决策：Host 的事实订阅用 `onEventRecord(listener)`，与 `subscribe()` 并列挂在同一派发点；不改 `HostEvent` 自身的形状。规划说 Host 有 `onEvent` 回调，与源码不符（源码只有 `subscribe`）。
证据：tests/host-separation.test.ts「事实记录订阅与事件订阅共享同一派发点与同一时刻」。
影响文件：src/host/events.ts、src/host/host.ts。
回滚点：95a477d 之前。
遗留未知：无。

[W1] 2026-10-29
决策：ingest-replay 的输入是 `ReplayInput{entries, auxiliary?}`。工具事实（name/args/status/时间戳）只在 journal 的 `SessionEventRecord`（`store.state.auxiliary`），`SessionEntry` 没有工具事件；规划假定只吃 `SessionEntry[]` 与源码不符。
证据：tests/ui-live-replay-equivalence.test.ts 断言工具耗时应等于 journal 时间戳之差；无 journal 且无消息 status 时为 `unknown`。
影响文件：src/presentation/ingest-replay.ts。
回滚点：95a477d 之前。
遗留未知：旧会话若 auxiliary 缺失，工具状态只能 `unknown`（不伪造）。

[W1] 2026-10-29
决策：`thinking.delta` / `assistant.delta` / `tool.*` 不携带 turn；投影按最近 `turn.started` 归属。规划 §3.4 的 payload 草案含 turn，但流式通道在 HostEvent 上本就不带 turn id。
证据：src/presentation/facts.ts、src/presentation/ingest-live.ts。
影响文件：src/presentation/facts.ts、src/presentation/ingest-live.ts。
回滚点：95a477d 之前。
遗留未知：若将来 HostEvent 带上 turn id，再补字段；当前不预支。

[W1] 2026-10-29
决策：恢复回合的终局：journal 有 `turn_aborted` / `turn_failed` 时按其结算；否则在下一条 user 消息或回放结束时发 `turn.ended`（`at` 为 undefined，表示“已不活跃”，不伪造完成时间与用量）。journal 不持久化正常 turn_end，规划未覆盖此空白。
证据：src/presentation/ingest-replay.ts 的 `closeTurn()`。
影响文件：src/presentation/ingest-replay.ts。
回滚点：95a477d 之前。
遗留未知：无。

[W0] 2026-10-29
决策：G0 的 controller / keymap 一致性测试以 `it.todo` 骨架交付，列出验收条款与审计编号（F1/F3/F5/F7）；真实断言分别在 W2e、W5 替换并删除 todo。理由：当前没有 controller 与 keymap 模块，写成 fake 断言会制造假绿。
证据：tests/ui-controller.test.ts、tests/ui-keymap-conformance.test.ts、B.1 已知失败清单。
影响文件：上述两个测试。
回滚点：8babedf。
遗留未知：W2e/W5 必须删除 todo，否则 G2/G5 不通过。

[W2a 预] 2026-10-29
决策：稳定节点 ID 用 `turnUid`（`turn:${uid}:tool:${callId}`）而不是回合序号 `turn:${n}`。恢复后 turnSeq 会重排，序号 ID 会与上一段投影碰撞；规划 §W2 写的是 `turn:${n}`。
证据：src/presentation/ingest-replay.ts 的 turn 计数与 live 的 turn id 不同源。
影响文件：W2a 的投影键。
回滚点：W2a 提交。
遗留未知：待 W2a 用测试证明 live/replay 的 ID 一致。

[W2 执行规则] 2026-10-29（用户纠正后追加）
决策：每个批次先设计细化卡，再**先删除该批次要替换的旧实现**（含调用方参数与测试），然后写新实现；同一批次内不允许旧推导与新投影双轨并存。W1 的 `onEventRecord` / ingest 目前只有测试消费者，W2a 必须把新事实层接入实时路径，否则视为未完成。
证据：用户指出“一直在新增代码行数，旧代码没有清理”；git show 8babedf/95a477d 无删除。
影响文件：W2a–W2e 各批次。
回滚点：按批次 revert。
遗留未知：删除旧实现会让中间态不可运行，因此删除与重写必须在同一提交内完成，测试绿后才提交。

[W2a 预·撤回] 2026-10-29
决策：撤回上一条“用 turnUid 替代 turn 序号”的预支。W1 的 Fact 只有 `turn: number`；恢复与回溯走 `replaceAll` 会清空旧节点，`turn:${n}:tool:${callId}` 不会跨段碰撞。按规划原文执行，不新增字段。
证据：src/presentation/facts.ts 的 `turn.started` / `turn.ended` 只带数字；会话回溯计划用 replaceAll。
影响文件：W2a 投影键。
回滚点：W2a 提交。
遗留未知：若同一进程内 rewind 后 turn 编号重新从 1 开始且未 replaceAll，则需再评估；W2b 的 rewind 测试会覆盖。

[W2a] 2026-10-29
决策：工具终态词汇只有 `ToolResultStatus` 五态；图标/文案/语气集中在 `src/presentation/tool-status.ts`，TUI 只做语气→颜色映射（`TOOL_TONE_COLORS` 留在 tool-view.ts）。删除旧的“从结果对象猜取消”、`⚠` 终态文案与文本启发式中止判断。
证据：tests/ui-projection.test.ts「覆盖且只覆盖 ToolResultStatus 五态」；tests/ui-format.test.ts 终态行直接引用矩阵；tests/ui.test.ts 失败首行改用 `C.error`。
影响文件：src/presentation/tool-status.ts、src/ui/format.ts、src/ui/components/transcript/tool-view.ts、src/cli/stdio-render.ts。
回滚点：W2a 提交前。
遗留未知：无。

[W2a] 2026-10-29
决策：投影输入放宽为 `ProjectionInput = FactPayload & {at?}`，不要求 `seq/origin`；序号与来源属于事实流，不参与归并。投影因此与 FactStore 解耦，测试可构造最小事实。
证据：tests/ui-projection.test.ts 的 `project()` 直接吃字面量事实；`applyLive` 仍接收 `PresentationFact`。
影响文件：src/presentation/projection.ts。
回滚点：W2a 提交前。
遗留未知：无。

[W2a] 2026-10-29
决策：`durationMs = 两端都有 ? max(0, ended-started) : undefined`；只有完成事实的恢复缺口生成 endedAt-only 节点；replay 回合缺结束时间戳时 `endedAt` 保持 undefined。禁止以当前时钟补齐。
证据：tests/ui-projection.test.ts「缺开始时间不产生耗时」「恢复缺口」「live 与 replay 工具节点等价」，并显式断言 replay 回合 `endedAt` 为 undefined。
影响文件：src/presentation/projection.ts、src/presentation/ingest-replay.ts。
回滚点：W2a 提交前。
遗留未知：journal 不持久化正常 turn_end 时间；回合耗时显示需 W1 补 journal 记录。

[W2a] 2026-10-29
决策：`session_rewind` 后是否仍有活动回合由事件载荷 `turnNumber` 决定；缺失则不 `continueTurn`，保持重放派生的归属，不猜回合号。
证据：src/ui/tui.ts 的 `if (m.turnNumber !== undefined)`。
影响文件：src/ui/tui.ts。
回滚点：W2a 提交前。
遗留未知：无。

[W2a] 2026-10-29
决策：stdio 与 TUI 共用同一状态矩阵与同一事实时间；stdio 的 `toolStartedAt` Map 是按 `record.at` 的合法记账，不属于旧推导，保留。
证据：tests/cli-run-mode.test.ts 断言 `✓ exec · 完成` / `✗ exec · 失败`。
影响文件：src/cli/stdio-render.ts、src/cli/app.ts。
回滚点：W2a 提交前。
遗留未知：无。

[W2a] 2026-10-29
决策：exec 类工具缺退出码时显式显示“退出码未知”，不伪造成 0。
证据：tests/ui.test.ts 行数预算 fixture 需补 `exitCode: 0` 才保持原行数。
影响文件：src/ui/components/transcript/tool-view.ts。
回滚点：W2a 提交前。
遗留未知：无。

[W2a 遗留→W2d] 2026-10-29
决策：`TranscriptContainer.loadSession` 仍自行从 journal 推导工具状态与耗时，与 `ingestReplay → PresentationProjection` 并行。这是 W2d 的删除目标，不在 W2a 删除：删除会让恢复会话失去唯一渲染路径。W2a 提交时该双轨可见、可追踪；W2d 完成前不得再新增第三条恢复路径。
证据：src/ui/components/transcript/transcript.ts 的 `collectJournalTools` 调用与 duration 计算（约 913–935 行）。
影响文件：W2d 的 transcript.ts。
回滚点：W2d 提交。
遗留未知：无。

[W2a 遗留→W2b] 2026-10-29
决策：`TrajectoryProjection` 仍用 `Date.now()`、自增节点 ID 与 label 聚合键（含 `Turn #n`）。W2b 先删除这些，再改为消费 `PresentationNode` 的 `startedAt/endedAt/durationMs`。
证据：src/ui/adapters/agent-events.ts 的 `turnStartTime`、`nextNodeId`、`aggregate`。
影响文件：W2b 的 agent-events.ts。
回滚点：W2b 提交。
遗留未知：无。

[W2b] 2026-10-29
决策：一条事实可结算多个节点（`turn.aborted` 关闭思考并结算该回合全部在途工具），因此 `PresentationProjection.apply` 返回 `readonly PresentationNode[]`，顺序即展示顺序（结算工具在前、回合在后）。思考块成为独立节点 `ThinkingNode`，ID 为 `turn:${n}:thinking:${i}`。
证据：tests/ui-projection.test.ts「思考增量累积到同一块」「回合中止把在途工具结算为 cancelled，正常结束缺完成事实标为 unknown」。
影响文件：src/presentation/projection.ts。
回滚点：W2b 提交前。
遗留未知：无。

[W2b] 2026-10-29
决策：删除 `TrajectoryProjection` 的挂钟、自增节点 ID、回合生命周期方法与无人调用的订阅（`subscribe/listeners/notify` 全仓无消费者）。改为只消费节点：`apply` upsert、`replaceAll` 重建、`onError/onCompaction` 由调用方传入事实时刻。`model_stream` 由回合节点的时间/用量派生；聚合键 `${kind}:${name}`；超过 5000 的节点折叠进聚合总量。
证据：tests/ui-projection.test.ts「聚合键不含回合号」「5000 上限淘汰后聚合仍累计历史总量」「replaceAll 丢弃旧节点并按回合尾部补出 model_stream」；tests/ui.test.ts 轨迹测试改节点驱动。
影响文件：src/ui/adapters/agent-events.ts、src/ui/features/overlays/trajectory-scene.ts。
回滚点：W2b 提交前。
遗留未知：无。

[W2b] 2026-10-29
决策：TUI 删除 `currentThinkingId` 状态机与全部 8 个旧轨迹调用；`ingest` 统一投喂投影节点，恢复与回溯经 `replaceFacts` 收口到 `replaceAll`，不再保留旧节点。压缩 token 不再以 `?? 0` 伪造。
证据：src/ui/tui.ts 的 `ingest`/`replaceFacts`；`pnpm typecheck` 与 tests/ui.test.ts 179 例全绿。
影响文件：src/ui/tui.ts。
回滚点：W2b 提交前。
遗留未知：无。

[W2b] 2026-10-29
决策：轨迹详情顺序统一为 参数 → 结果 → 错误（宽屏与紧凑共用），状态图标/文案来自 `statusGlyph`；波形带过滤无时间节点，缺时间显示“时间未知/耗时未知”。热点表展示 errors 与 tokens，压缩 token 不并入热点合计。
证据：src/ui/features/overlays/trajectory-scene.ts；tests/ui-crap-c2.test.ts fixture 补 `name`。
影响文件：src/ui/features/overlays/trajectory-scene.ts。
回滚点：W2b 提交前。
遗留未知：无。

[W2b] 2026-10-29
决策：为“单一事实源”增加静态扫描测试：`src/presentation` 不得出现 `Date.now`/`performance.now`/`setInterval`/`setTimeout`/`process.`/`node:fs`/`node:process`/`node:readline`。布局与计时只能在 Surface。
证据：tests/ui-projection.test.ts「展示层静态约束」。
影响文件：tests/ui-projection.test.ts。
回滚点：W2b 提交前。
遗留未知：无。

[W2c] 2026-10-29
决策：token 与 TPS 的估算来源成为显式必填事实：`ActivityHeaderMetrics.tokensEstimated/tpsEstimated`，`~` 只在对应值为字符折算时出现；完成态与运行态统一用 `tok`。组件按 step 记录“结算总量中估算部分”与“速度账本中估算部分”，真实 usage 到达后同一 step 立即转为事实。TPS 的分母仍只含可度量解码窗口（成批到达的 step 不进账本），因此速度与 token 总数样本集合天然不同。
证据：tests/ui.test.ts「完成时输出耗时、Token数与火花线」「运行态…TPS 仪表盘」；`addRealOutputTokens(80)` 后断言 `80 tok` 且无 `~80 tok`。
影响文件：src/ui/components/widgets/activity-line.ts。
回滚点：W2c 提交前。
遗留未知：无。

[W2c] 2026-10-29
决策：缓存命中率区分“Provider 未报告”（`cacheRead === undefined` → 不显示）与“命中 0%”（报回 0 → `0.0%`）。上下文剩余容量在估算读数前加 `~`；`turn_start` 只把读数标为估算，不再清空 `lastUsage`，缓存徽章保留到下一次真实 usage 到达；会话回溯仍显式清空（旧请求属于被丢弃的未来）。retry 状态行显示本次重试耗时，起点取 `HostEventRecord.at`。
证据：tests/ui-cache-wiring.test.ts「turn_start 只把上下文读数标为估算」「session_rewind…重置」；tests/ui.test.ts「formatCacheHitRate…」「Provider 重试状态…1.2s」与「ContextBar 对估算用量…~」。
影响文件：src/ui/components/widgets/context-bar.ts、src/ui/ui-host.ts、src/ui/tui.ts。
回滚点：W2c 提交前。
遗留未知：无。

[W2c] 2026-10-29
决策：压缩终态失败/取消/noop 由 TUI 消费同一 `session_compact` 事件写转录卡片，正文取真实 `error`（缺省时明确写“未提供错误原因/压缩被中止”）；toast 只作即时提示。`cards.ts` 的非 completed 分支由此成为唯一活路径。
证据：tests/ui.test.ts「InteractiveTUI 从 RuntimeEvent 驱动压缩进度显示，所有终态清除」断言卡片含“压缩失败”与真实错误文本；tests/ui.test.ts「失败的压缩记录不显示为已压缩摘要」。
影响文件：src/ui/tui.ts、src/extensions/builtin.ts（仅注释）、src/ui/components/transcript/cards.ts（无改动，死分支转活）。
回滚点：W2c 提交前。
遗留未知：无。

### B.3 当前待决问题

1. `RequestUsage.promptTokens` 是否存在于持久化记录？若存在，改名需要迁移；本规划默认只加注释。
2. trajectory 节点上限 5000 是否合适？以 W0 基线的长会话内存曲线为准。
3. 工具输出中的 ANSI 颜色是否一律剥离？当前建议剥离后由 Uina 重新上色。
4. 术语最终选“思考档位”还是“推理强度”？W6 开工前定一个。
5. stdio 路径的用户占比是否值得继续维护？当前保留，因为验证脚本依赖它。

### B.4 开放接缝核查清单（W8 逐项签字）

- [ ] `src/presentation/` 存在，且只含 facts / sanitize / controller / ingest / projection / composition / actions / surface / copy。
- [ ] `src/presentation/` 不 import `src/ui`、`src/cli`、`src/extensions`、`src/ai`、`node:tty`、`node:process`、`node:fs`；`check:boundaries` 规则与违例自测通过。
- [ ] `PresentationNode` 是判别联合，TUI 渲染处 switch 穷尽；无 `payload: unknown` 兜底。
- [ ] `PresentationController` 有 `applySnapshot` / `ingest` / `replaceAll` / `view` / `subscribe` / `dispatch` / `onIntent`，并被 TUI 与 print/stdio 共同使用。
- [ ] `SlotContribution` 无 `render(width)` / `Component`；TUI 的行渲染只在 `src/ui/composition/render.ts`。
- [ ] `ActionId` 定义在 Presentation Core；`Binding` 不携带 `run()`；fake surface 可直接 dispatch。
- [ ] `ExtensionUIContext.capabilities()` 存在，`hasUI()` 由其派生；`terminal` 为 optional；`notify` / `setWorking` 返回 `SlotAck`。
- [ ] `sanitizeExternal` 在 Core 入口执行一次；各 surface 自行负责输出编码（TUI 防 ESC，Web 需 HTML escape）。
- [ ] `copy.ts` 与 `ToolModel` 平台中立；`renderToolBlock` 明确属文本 surface，Web 不复用。
- [ ] 上述清单均有测试或源码证据；口头描述不算通过。

### B.5 已定决策（本规划采纳）

1. **Web 非近期目标，但接缝保留**：本次不实现 Web；只保证 Facts / Projection / Composition / 动作 / 文案可复用，布局与渲染由各 surface 自建。
2. **`terminal` optional + `capabilities()`**：无头与未来 surface 不伪造终端 facet；扩展用能力声明降级，不用 `hasUI()` 猜。
3. **`BuiltinUIActions` 迁入 Presentation Core，`ui-contract.ts` 继续 re-export**：扩展作者导入路径不变，动作词汇归 Core。
4. **不共享几何**：`fitLine`、`FrameLayout`、ANSI、按键字节、TTY 探测全部留在 `src/ui/`。
5. **只定义 3 个契约**：Controller、Composition、Capabilities；不做通用跨 surface UI 框架。
