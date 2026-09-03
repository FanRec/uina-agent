# Uina TUI 架构与开发设计文档 (proposal)

> 本文档设计已在 `src/ui/` 中全面落地并正式接入真实 CLI 入口（`src/cli/app.ts`）。

> **目标**：打造一个具备商业级 Claude Code / DeepSeek Harness 视觉质感，同时具备工业级底层性能、零重型框架依赖、完美兼容中文输入法（IME）的自主 Agent 终端交互前端。  
> **核心战术**：**“以 dsh-TUI 为面子（视觉排版/交互形态），以 pi 为里子（模块化架构/差量渲染引擎）”**。

---

## 1. 外部参考源与绝对路径索引

本设计直接基于本机已存在的两套顶级参考代码库，开发时可直接跳转阅读对应文件：

| 参考工程 | 绝对路径 | 角色分工 | 关键源码位置 |
|---|---|---|---|
| **pi** | `E:\Uina\ThirdParty\pi` | **【里子】** 底层架构、差量渲染器、IME 硬件光标同步、键位解析、插槽扩展 | - `packages/tui/src/tui.ts`<br>- `packages/tui/src/tui-main-screen.ts`<br>- `packages/tui/src/utils.ts`<br>- `packages/tui/src/keys.ts`<br>- `packages/tui/src/components/editor.ts`<br>- `packages/coding-agent/src/core/extensions/types.ts` |
| **dsh-TUI** | `E:\Uina\ThirdParty\dsh-TUI` | **【面子】** Claude Code 风格视觉、流光扫光状态行、蓝白上下文进度条、思考流展开折叠 | - `src/components/ActivityLine.tsx`<br>- `src/components/ContextBarView.tsx`<br>- `src/components/ThinkingToggle.tsx`<br>- `src/components/shimmer.ts`<br>- `src/components/Whale.tsx`<br>- `src/components/PromptInput.tsx` |

---

## 2. 为什么这样组合？（抄什么 vs 不抄什么）

### 2.1 从 `pi` 抄什么？为什么？
* **抄的资产**：
  1. **原子组件契约**：`Component { render(width: number): string[]; handleInput?(data: string): void; }`。零 Virtual DOM，只返回纯字符行数组。
  2. **主屏幕差量渲染器（`tui-main-screen.ts`）**：计算上一帧与当前帧的变动行，光标跳转精准覆写，消灭终端闪烁；保留终端原生滚轮历史与鼠标划词复制。
  3. **DEC CSI 2026 原子同步输出**：用 `\x1b[?2026h` ... `\x1b[?2026l` 包裹渲染帧，彻底消灭输出撕裂。
  4. **全角字符与 ANSI 算法库（`utils.ts`）**：`visibleWidth`（中文 2 字符/Emoji 宽度正确计算）、`truncateToWidth`（ANSI 截断不破坏转义控制符）、`wrapTextWithAnsi`（折行后新行自动续接上一行 ANSI 颜色）。
  5. **键位协议中枢（`keys.ts`）**：标准化 ANSI 转义序列与 Kitty 键盘协议解析，易读的 `Key.enter`、`Key.ctrl("c")`。
  6. **中文 IME 硬件光标同步**：候选实现参考 pi 的光标标记与坐标同步；必须在 Windows Terminal 和实际输入法上验证，不能从源码或单测推导出 100% 保证。
  7. **小部件插槽体系（`aboveEditor` / `belowEditor`）**：允许状态行、后台任务、进度条以 Widget 形式声明式插入输入框上下方。
* **坚决不抄的内容**：
  * Kitty / iTerm2 内联图片协议（上千行，初期无用）；
  * LaTeX 数学排版、AltScreen 全屏搜索、庞大复杂的设置列表等。
  * **策略**：**外科手术式抽取其最坚硬的 4~5 个核心纯 TS 模块（~700 行）**。

### 2.2 从 `dsh-TUI` 抄什么？为什么？
* **抄的资产**：
  1. **`ActivityLine`（实时工作状态行）**：冰蓝流光扫光动画（Shimmer Sweep），动态展示 `⠋ Thinking · 1.8s · 45 tps`，任务结束平滑转为静态摘要。
  2. **`ContextBarView`（上下文用量条）**：按比例精确分段渲染（已用 Token、总 Token、空闲百分比），直观展示上下文压力。
  3. **`ThinkingToggle`（思考流折叠）**：DeepSeek-R1 思考流以暗灰流式展示，支持一键折叠为单行 `▶ 思考过程 (展开/折叠)`。
  4. **工具调用原地坍缩**：工具执行时显示动态，完成后原地覆写为绿勾 `✓` 与耗时，不留废行。
  5. **首屏 ASCII 艺术 Banner**：启动时的极客仪式感。
* **坚决不抄的内容（生死雷区！）**：
  * **绝不抄其底层 React 19 / Ink / Yoga 布局引擎代码**。
  * `dsh-TUI` 包含上百个 TSX 文件、数万行 Virtual DOM 代码。我们只**提取其视觉规范与数学计算公式**（如扫光颜色渐变、Token 宽度划分），用 `pi` 的 `render(width): string[]` 纯函数重新实现。

---

## 3. 总体架构拓扑

整个 TUI 位于 `src/ui/`，分为四层：

```text
┌────────────────────────────────────────────────────────────────────────┐
│ [外部调用] src/main.ts                                                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 监听输入 / 消费 Subject Hooks
┌───────────────────────────────────▼────────────────────────────────────┐
│ [控制器门面] src/ui/tui.ts (UinaTUI)                                    │
│   - 管理生命周期、输入模式切换、事件派发                                 │
│   - 维护 Active Viewport 与 Widget 插槽 (aboveEditor / belowEditor)    │
└──────────────┬──────────────────────────────────────────┬──────────────┘
               │ 挂载组件                                 │ 帧更新触发
┌──────────────▼──────────────────────────┐    ┌──────────▼──────────────┐
│ [组件层] src/ui/components/             │    │ [渲染核心] src/ui/core/ │
│ ├─ activity-line.ts (dsh 流光状态行)    │    │ ├─ renderer.ts (差量渲染)│
│ ├─ context-bar.ts (dsh 上下文进度条)    │    │ ├─ terminal.ts (CSI 2026│
│ ├─ thinking-view.ts (思考链折叠)        │    │ ├─ utils.ts (字符/ANSI) │
│ ├─ tool-view.ts (工具原地坍缩展示)      │    │ └─ keys.ts (按键协议)   │
│ ├─ stream-view.ts (流式 Markdown 格式化)│    └─────────────────────────┘
│ └─ banner.ts (启动 ASCII Logo)          │
└──────────────┬──────────────────────────┘
               │ 挂载到底部输入槽
┌──────────────▼──────────────────────────┐
│ [输入引擎] src/ui/editor/               │
│ └─ input-line.ts                        │
│    - 单行/多行编辑器                     │
│    - CURSOR_MARKER 硬件光标对齐 (保 IME) │
│    - 大段粘贴自动折叠 [paste #1 +50 lines]│
└─────────────────────────────────────────┘
```

---

## 4. 目录与文件职责清单

```text
src/ui/
├── core/
│   ├── types.ts          # Component, Focusable, CURSOR_MARKER, WidgetSlot 契约
│   ├── terminal.ts       # 终端底层 I/O：rawMode 开关、光标控制、CSI 2026 同步包裹
│   ├── utils.ts          # 移植自 pi：visibleWidth, truncateToWidth, wrapTextWithAnsi
│   ├── keys.ts           # 移植自 pi：ANSI/Kitty 按键协议解析与 matchesKey
│   └── renderer.ts       # 移植自 pi：MainScreen 差量渲染器（行级 diff、原地覆写）
├── components/
│   ├── activity-line.ts  # 复刻 dsh：冰蓝流光扫光状态行 (支持 TPS、状态、用时)
│   ├── context-bar.ts    # 复刻 dsh：分段蓝白上下文比例条
│   ├── thinking-view.ts  # 复刻 dsh：思考过程流式输出与折叠收拢
│   ├── tool-view.ts      # 升级版工具输出折叠 (原地由 ⏳ 覆写为 ✓，防刷屏)
│   ├── stream-view.ts    # 流式文本解析 (Markdown 代码块暗灰染色)
│   └── banner.ts         # 首屏启动极简 ASCII 艺术
├── editor/
│   └── input-line.ts     # 移植自 pi editor 精简版：保 IME 光标、粘贴折叠、历史记录
├── format.ts             # 保留原 format.ts 并适配新核心
└── tui.ts                # UinaTUI 统一控制门面
```

---

## 5. 核心模块具体设计与算法

### 5.1 差量渲染引擎 (`src/ui/core/renderer.ts`)
* **核心机制**：
  1. 维护 `previousLines: string[]`（上一帧屏幕最后 N 行的内容）；
  2. 每一帧调用根容器生成 `currentLines: string[]`；
  3. 计算变化起点（第一个内容不一致的行索引）；
  4. 用 ANSI 控制码 `\x1b[nA` 光标上移，清除下方内容 `\x1b[J`，按行覆写新内容；
  5. 整个刷新过程被 CSI 2026 同步包裹：`\x1b[?2026h` + 写入 + `\x1b[?2026l`。

### 5.2 中文输入法（IME）保护机制 (`src/ui/editor/input-line.ts`)
* **原理**（源自 `pi` 的杀手级设计）：
  1. 终端进入 `rawMode(true)` 接管按键；
  2. 隐藏真实硬件光标（`\x1b[?25l`）；
  3. 自绘假光标（如反色字符 `\x1b[7m \x1b[27m`）；
  4. 在假光标文字前插入零宽转义标记：
     `export const CURSOR_MARKER = "\x1b]1337;CursorMarker\x07";`
  5. 渲染器在向终端输出字符串前扫描该标记，记录其所在的 `(col, row)` 坐标；
  6. 渲染完毕后，用 `\x1b[row;colH` 将**真正的物理光标移动到该位置**；
  7. 操作系统中文输入法窗口依靠物理光标位置浮动；该方案只提供可验证的坐标同步机制，实际效果仍需真实终端和输入法验收。

### 5.3 冰蓝流光状态行算法 (`src/ui/components/activity-line.ts`)
* **视觉来源**：`dsh-TUI/src/components/ActivityLine.tsx` & `shimmer.ts`
* **纯 TS 算法**：
  * 周期设定 $T = 1200\text{ms}$。设文字长度为 $L$。
  * 扫光中心位置：$\text{center} = \lfloor ((t \bmod T) / T) \times (L + 10) \rfloor - 5$。
  * 对字符串的每个字符索引 $i$，计算与 $\text{center}$ 的距离 $d = |i - \text{center}|$：
    - $d \le 1$：极亮白色 (`\x1b[38;2;255;255;255m`)
    - $d \le 3$：冰蓝色 (`\x1b[38;2;125;190;255m`)
    - 其余：暗灰色 (`\x1b[90m`)
  * 每 60ms 刷新一次该行，呈现流光拂过文本的极致视觉。
  * **TPS 计算**：在组件内维护 `tokenCount` 和 `startTime`，每秒刷新一次 `tps = Math.round(tokenCount / ((now - startTime) / 1000))`。

### 5.4 上下文进度条算法 (`src/ui/components/context-bar.ts`)
* **视觉来源**：`dsh-TUI/src/components/ContextBarView.tsx`
* **纯 TS 算法**：
  * 接收：`usedTokens` 与 `contextWindow`（如 24k / 64k）。
  * 设进度条可用宽度为 $W = \text{width} - 16$（右侧预留数字空间）。
  * 填充块数：$\text{fill} = \text{clamp}(\lfloor (used / contextWindow) \times W \rfloor, 0, W)$。
  * 拼装字符串：
    `[深蓝/青色]█...█[暗灰]░...░ [重置] 24.0k/64.0k (37.5%)`
  * 占用 1 行，放置在 `aboveEditor` 插槽。

### 5.5 思考链流式展示与折叠 (`src/ui/components/thinking-view.ts`)
* **视觉来源**：`dsh-TUI/src/components/ThinkingToggle.tsx`
* **交互规则**：
  * 捕获到模型正在输出思考内容时，行头打印暗淡前缀 `▶ 思考中 (Ctrl+O 展开/收起)`；
  * 默认收起态：仅流式展示最新的一行思考文本（超宽截断）；
  * 快捷键 `Ctrl+O` 触发切换：展开态展示完整思考块，并加深灰色左侧边框（`│ `）。

---

## 6. 与外部其他模块的微小联动契约

开发时需要对外部做出的微小配合（仅 2 处，保持系统高度稳定）：

### 6.1 [src/main.ts](file:///e:/Uina/Uina/src/main.ts)
* 引入新的 `UinaTUI` 替代 `SimpleTUI`：
  ```ts
  const tui = new UinaTUI();
  tui.onUserInput((text) => subject.pushInput(text));
  tui.onInterrupt(() => handleInterrupt());
  ```
* 将 `subject` 原有的 hooks 转发给 `tui`：
  ```ts
  const subject = new Subject(provider, tools, {
    onToken: (text) => tui.appendToken(text),
    onTurnStart: (n, text) => tui.handleTurnStart(n, text),
    onTurnEnd: (n, usage) => tui.handleTurnEnd(n, usage),
    onToolStart: (name, args) => tui.handleToolStart(name, args),
    onToolDone: (name, result) => tui.handleToolDone(name, result),
    onError: (msg) => tui.handleError(msg),
    onNotice: (msg) => tui.handleNotice(msg),
  });
  ```

### 6.2 [src/mind/loop.ts](file:///e:/Uina/Uina/src/mind/loop.ts)
* `LoopHooks` 的 `onTurnEnd` 扩展一个可选的用量参数：
  ```ts
  onTurnEnd?: (n: number, usage?: { usedTokens: number; contextWindow: number }) => void;
  ```
  `Subject` 在本轮结算后，将计算出的当前 Token 估算数顺手透出给 UI。

### 6.3 [src/ai/gateway.ts](file:///e:/Uina/Uina/src/ai/gateway.ts) (可选)
* 如果模型包含 `reasoning_content`，抛出思考增量：
  ```ts
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    onDelta({ kind: "thinking", text: delta.reasoning_content });
  }
  ```

---

## 7. 实施步骤与验收路径 (Reality-First 迭代)

新会话开始开发时，严格按以下步骤推进，每步必须有运行证据支持：

### 第一步：移植 Core 骨架（~1.5h）
1. 从 `E:\Uina\ThirdParty\pi\packages\tui\src\utils.ts` 抽取核心算法，保存为 `src/ui/core/utils.ts`；
2. 从 `keys.ts` 抽取键码解析器，保存为 `src/ui/core/keys.ts`；
3. 从 `tui-main-screen.ts` 抽取差量渲染核心，编写 `src/ui/core/renderer.ts`；
4. 编写组件接口与 `CURSOR_MARKER` 声明在 `src/ui/core/types.ts`。
5. **验收标准**：写一个微型脚本，终端输出 5 行文本并原地动态跳秒刷新，无闪烁、无换行堆叠。

### 第二步：移植 InputLine 编辑器（~1.5h）
1. 基于 `pi/packages/tui/src/components/editor.ts` 精简实现 `src/ui/editor/input-line.ts`；
2. 接入 `CURSOR_MARKER` 硬件光标对齐；
3. 加入 Bracketed Paste 大段粘贴折叠。
4. **验收标准**：在终端输入中文拼音，输入法候选框紧贴光标处；粘贴 50 行代码，自动折叠为 `[已粘贴 50 行]`。

### 第三步：复刻 dsh-TUI 视觉挂件（~2h）
1. 实现 `src/ui/components/activity-line.ts`（移植 Shimmer 扫光公式，计算实时 TPS）；
2. 实现 `src/ui/components/context-bar.ts`（移植蓝白分段条）；
3. 实现 `src/ui/components/thinking-view.ts`（折叠思考链）；
4. 实现 `src/ui/components/tool-view.ts`（原地覆写工具状态）。
5. **验收标准**：挂件在 `aboveEditor` 槽位正常刷新，随模型空闲平滑隐藏。

### 第四步：门面组装与联调（~1h）
1. 完成 `src/ui/tui.ts` 统一调度；
2. 改造 `src/main.ts`；
3. 执行现有 `pnpm test`，确保 29 个既有单测继续保持全绿通过；
4. 启动真实终端验证整体视觉。

---

*本文记录候选方向。实现以当前入口、测试和真实运行证据为准，不能由本文单独授权大规模迁移。*
