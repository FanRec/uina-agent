# UI 布局模型重构设计（B1 / B3 / B2）

> 状态：**已实施**（2026-09-09）。范围来自 `docs/history/reviews/2026-09-09-code-review.md` 第七节“仍未处理”中的 B1/B3/B2。验证：`pnpm typecheck` + `pnpm test`（18 文件 / 275 项）+ `pnpm build` 全部通过；新增 `tests/ui-layout.test.ts` 14 项。
> 目标：让 UI 的几何、滚动、命中区与宽度计算各自只有**一个事实来源**，且扩展与内置浮层共享同一套几何契约。

## 1. 问题回顾（根因）

### B1 布局/滚动
- **四份独立的宽度/高度计算**：`scrollToTurn`（ui-host.ts:554,560）、`preserveScrollAnchor`（:631,642）、`renderCurrentFrame`（:1072,1075-1076）、Ctrl+O 分支（:1676-1677）。数值不同源，任何一处改动都会破坏另一处的“巧合一致”。
- **当前轮次的行索引是 render 的第二份实现**：`getThinkingLineIndices`/`getToolLineIndices`（transcript.ts:967,1014）自己重走一遍 offset 累加，且用**全量文本**；渲染（:918）用 **smoothReveal 揭示后文本**。流式期间两者行数不同 → 热区整体错位、被 `absLine` 过滤丢弃。
- **时间线导航量纲错误**：`downTurnN` 把绝对行号 `absLine` 与滚动距离 `maxScroll` 相比（ui-host.ts:1120），导致 ▼ 灰掉或指向已在视口内的轮次。
- **hover 触发全量重绘**：`setHoveredToolId` 等直接 `invalidate()`（transcript.ts:161-203），而 settled 缓存的 key 含 hover 状态（:136-147），鼠标每移动一次就重建全部已结算轮次的 Markdown/高亮。

### B3 Overlay 几何
- 内置浮层全部 `showOverlay(x, undefined, …)`（ui-host.ts:872,891,917,932,951,961,977）→ `overlay.ts:164` 的几何分支对产品 UI 永不生效。
- `offsetY`、`margin.top/bottom` 从未被读取（`:184` 只参与“是否有几何”的判定）；`anchor` 的上下语义被抹平（`:200-204`）。
- 组装侧 `aboveLines = [...].slice(0, maxAboveH)`（ui-host.ts:1065-1067）**从头截断**：最贴近输入框的浮层（栈顶）先被砍掉；而 `overlay.ts:177-179` 内部又按尾部保留 → 两处策略相反。

### B2 宽度
- `visibleWidth` 按 **code point** 迭代（utils.ts:103-111），`charWidth` 对 tab 记 2 列、对组合记号记 1 列。
- 结果：`👍🏽`（基础 emoji + 肤色修饰符）算 4 列（实际 2）、`e\u0301` 算 2 列（实际 1）、tab 与终端 8 列制表位不符 → 边框/光标/鼠标命中列偏移。
- 项目已内置 `graphemeSegmenter`（utils.ts:291，用于方向键移动），可直接复用。

## 2. 设计目标与非目标

**目标**
1. 几何只有一个来源：渲染、滚动跳转、锚点保持、鼠标命中区共用 `computeLayout()`。
2. 行模型只有一个来源：一次遍历同时产出渲染行与定位元数据，流式期与已结算期同一套代码。
3. 命中区与渲染行**逐行对齐**（同一 width、同一揭示后文本）。
4. hover 只重建受影响的卡片；行数不变时原地替换，行数变化时回退全量重建。
5. Overlay 几何字段每个都有确定语义、单测覆盖，内置浮层与扩展共用。
6. 宽度按 grapheme 计算，ANSI 安全，tab 按 8 列制表位。

**非目标**
- 不改渲染架构（仍是即时全帧渲染），不引入保留态组件树或差分缓冲。
- 不改滚动语义（0 = 底部，越大越往上），不引入滚动动画。
- 不追求与终端 100% 一致的 emoji 宽度（终端各异），只保证“同一函数贯穿所有消费者”。

## 3. B1 设计

### 3.1 `computeLayout(): Layout`（ui-host.ts 私有）

把现有 `renderCurrentFrame` 的前半段（输入行、below、above、banner、transcript、视口切片）提取为**纯计算**，返回：

```ts
interface Layout {
  width; height; innerW; margin;
  inputWidth; inputLines; inputH;
  belowLines; belowH;
  aboveLines; aboveH;
  bannerLines; bannerCount;
  transcriptLines; permanentLines; totalPerm;
  safeW; transcriptContentW;
  transcriptH; maxScroll; effScroll; scrollStart; visibleTranscript;
}
```

约定：
- `computeLayout()` **不修改** `scrollOffset`（纯读）；由调用方决定是否夹紧。
- `effScroll = clamp(scrollOffset, 0, maxScroll)`，`scrollStart = totalPerm - transcriptH - effScroll`（totalPerm <= transcriptH 时为 0）。
- 所有消费方（`renderCurrentFrame`、`scrollToTurn`、`preserveScrollAnchor`、Ctrl+O 定位、鼠标命中区）只读 `Layout`。

### 3.2 转录行模型：`ensureModel(width)`

新增内部类型：

```ts
interface LineModel {
  lines: string[];
  turnStartMap: Map<number, number>;
  thinkingLocations: ThinkingLineLocation[];
  toolLocations: ToolLineLocation[];
  compactionLocations: CompactionLineLocation[];
  turnRanges: Map<number, { start: number; end: number }>;
}
```

- `layoutTurn(turn, width, out, sink, opts)` 是唯一的逐轮布局函数：既 `out.push(...)` 行，也把 thinking/tool/compaction 的 `lineIndex/lineCount` 写进 `sink`。已结算轮次与当前轮次共用它，`opts.isCurrent` 只决定文本是否走 `smoothReveal.getRevealedText`。
- `getSettledCache(width)` 缓存已结算部分（key = width + expanded 状态，**不含 hover**）。
- `ensureModel(width)` = settled 缓存 + 当前轮次的 `layoutTurn` 结果；每次调用重建当前轮次（一轮的成本，与现状相同）。
- `render(width)`、`getTurnStartLines`、`getThinkingLineIndices`、`getToolLineIndices`、`getCompactionLineIndices` 全部走 `ensureModel`，删除 967-1064 的重复实现。

### 3.3 时间线导航语义

设 `top = scrollStart`、`bottom = scrollStart + visibleTranscript.length`（不含填充行）：
- `upTurnN` = 最后一个 `absLine < top` 的轮次（视口上方最近）。
- `downTurnN` = 第一个 `absLine >= bottom` 的轮次（视口下方最近）。
- `activeTurnN` = 最后一个 `absLine <= top` 的轮次，回退首轮。

### 3.4 hover 局部重绘

- settled 缓存 key 去掉 hover 三字段，新增 `turnRanges`。
- `render(width)`：若当前 hover 与缓存内嵌状态不同，只重建**受影响的轮次**（通过 `turnRanges` 切片）并替换；若新行数与旧行数不同，回退 `invalidate()` 全量重建（正确性优先）。
- 当前轮次每帧都重建，天然包含 hover 状态。

## 4. B3 设计：Overlay 几何契约

`OverlayOptions` 字段语义（写进类型注释，并作为单测依据）：

| 字段 | 语义 |
| --- | --- |
| `width` / `minWidth` | 数字或百分比字符串；解析后夹在 `[1, available]`；未给 `width` 时取 `available` |
| `maxHeight` | 该浮层自身最大行数，与 `renderAbove` 的预算取较小值 |
| `anchor` | **水平**对齐：left/center/right（`above-editor` 视为 center）；垂直位置恒为“紧贴输入框上方”，由 `offsetY` 微调 |
| `offsetX` | 在水平锚点基础上的列偏移 |
| `offsetY` | 向上偏移行数：正值在浮层**下方**插入空白行（远离输入框），负值从浮层底部裁掉 |
| `margin` | 四边留白：left/right 参与宽度计算，top/bottom 以空白行形式参与高度 |
| `nonCapturing` | 不改变焦点 |

实现要点：
1. `renderAbove(width, maxHeight)` 对**每个** entry 都走几何路径（无 options 时用默认值），因此组件输出一律被 `truncateToWidth(overlayWidth)` 夹紧。
2. 堆叠顺序：`stack[0]` 在最上，`stack.at(-1)` 最贴近输入框。整体超预算时**保留尾部**（贴近输入框的一侧），并保证每个 entry 先各自按 `maxEntryHeight` 截断。
3. `offsetY`/`margin.top/bottom` 以空字符串行实现，保持“一个数组元素 = 一行”的契约。
4. 组装侧 `aboveLines` 改为**保留尾部**（`slice(-maxAboveH)`），使待办队列/联想卡/浮层优先于 aboveEditor 小部件。
5. 内置模态统一传 `{ anchor: "center" }`，从而走几何路径获得宽度夹紧（不改变视觉宽度）。

## 5. B2 设计：grapheme 宽度契约

`visibleWidth(str)`：
1. `stripAnsi`；
2. 逐 grapheme（`graphemeSegmenter`）累加：
   - `\t` → 推进到下一个 8 列制表位（`8 - (col % 8)`）；
   - 控制字符（<0x20、0x7f-0x9f）→ 0；
   - 含 ZWJ（U+200D）或变体选择符（U+FE0F）且首码点在 emoji 区 → 2；
   - 组合记号（U+0300-036F、U+1AB0-1AFF、U+20D0-20FF、U+FE20-FE2F）→ 0；
   - `isFullWidth(首码点)` → 2；
   - 其余 → 1。
3. `truncateToWidth` / `wrapTextWithAnsi` 使用同一 grapheme 迭代，保证不切开一个簇；截断后宽度仍 `<= maxWidth`。

## 6. 实施顺序与验收

| 步骤 | 内容 | 验收 |
| --- | --- | --- |
| 1 | transcript 行模型（layoutTurn/ensureModel） | 现有 UI 测试全绿；流式期热区行号 == 渲染行号 |
| 2 | ui-host computeLayout + 四个消费方 | scrollToTurn 落点与渲染同源；downTurnN 指向视口下方首个轮次 |
| 3 | hover 局部重绘 | 悬停只重建 1 个轮次；行数变化时回退全量 |
| 4 | overlay 几何 | 每个字段有单测；超预算保留贴近输入框一侧 |
| 5 | grapheme 宽度 | 组合字符/ZWJ/tab 三类用例 + 宽度不超限属性测试 |
| 6 | 全量验证 | `pnpm typecheck` + `pnpm test` + `pnpm build` |

## 7. 实施结果

| 步骤 | 结果 |
| --- | --- |
| 1 | `transcript.ts` 新增 `layoutTurn/buildTurnBlock/buildSettledBlocks/assemble/ensureModel`；删除 4 份重复的当前轮次索引实现；流式期热区行号 == 渲染行号（实测 index 56 == 渲染第 56 行） |
| 2 | `ui-host.ts` 新增 `computeLayout()`（纯函数，不改 `scrollOffset`）；`renderCurrentFrame`、`scrollToTurn`、`preserveScrollAnchor`、Ctrl+O 定位全部改用它；`scrollToTurn(3)` 实测把第 3 轮钉在视口顶部 |
| 3 | 时间线导航改为视口语义：顶部时 `downTurnN=2`、底部时 `upTurnN=4`、`scrollToTurn(3)` 时 `up=2/down=6`（实测） |
| 4 | hover 不再 `invalidate()`；settled 块按 width+展开状态缓存，悬停只重建命中轮次（实测 `settledBlocks` 复用、hover 缓存 1 项、行号不变） |
| 5 | `renderAbove` 对每个浮层统一应用几何；`offsetY/margin/anchor/maxHeight` 全部生效；超预算保留贴近输入框的一侧；内置模态改走几何路径 |
| 6 | `visibleWidth/truncateToWidth/wrapTextWithAnsi` 改为 grapheme 迭代 + 8 列制表位；`👍🏽=2`、ZWJ 家庭=2、旗帜=2、`e\u0301=1`、`\t` 按制表位展开；输入框点击/布局改为 code point 安全 |
| 7 | 实测 50/80/120 列终端 + 打开帮助浮层 + CJK/emoji 内容，帧内**无一行超宽** |

## 8. 后续项（2026-09-09 第二轮，已完成）

| 项 | 问题 | 做法 | 实测 |
| --- | --- | --- | --- |
| 编辑器簇级模型 | 输入框按 code point 建 atom，ZWJ 家庭 emoji 占 4~6 列而不是 2 列 | `getVisualLayout` 改为 grapheme 簇 atom（带 `endIdx`）；光标落在簇内部时高亮整簇；`snapCursorToMarkerBoundary` 增加簇边界吸附；`setCursorByClick` 按簇迭代 | 18 个 ZWJ emoji 与 36 列 ASCII 渲染行数相同（3 行）；`snap(1/4)→0`、`snap(8)→8` |
| 增量失效 | `preserveScrollAnchor` 前后各算一次完整布局；展开卡片会重建全部已结算块 | `TranscriptContainer` 增加 `invalidateTurn(n)/invalidateCompaction(i)`，`toggleTool/toggleThinking/toggleCompaction` 只标记受影响块；`buildSettledBlocks` 只重建 stale 块；`UIHost.lastLayout` 复用上一帧几何给 `preserveScrollAnchor/scrollToTurn/Ctrl+O` | 展开一次只重建 1 个块（其余块对象同一引用）；`preserveScrollAnchor` 期间 `transcript.render` 只被调用 1 次 |
| 时间线轨自适应 | 刻度密度硬编码 24、预览卡宽度硬编码 24 列 | 密度改为 `min(可用高度, 90% 视口)`，并暴露 `maxTicks` 选项；预览宽度改为 `clamp(内容宽度 * 0.4, 12, 48)`，并暴露 `previewMaxWidth` | 高度 12/24/46/80 → 刻度 6/18/40/72；预览宽度 40 列终端=19、200 列终端=51 |

## 9. 风险与回滚

- **风险**：布局重构会移动 `(host as any)` 私有断言依赖的行号；缓解办法是让 `computeLayout` 返回结构稳定，并在测试里优先断言公开输出（帧行数组）。
- **风险**：grapheme 宽度会改变若干宽度期望；只更新“新行为更正确”的断言，不做无差别放宽。
- **回滚**：三项改动彼此独立，可按提交粒度回退；`computeLayout` 与行模型都是新增内部函数，不改公开 API。
