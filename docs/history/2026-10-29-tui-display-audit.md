# TUI 展示信息审计

日期：2026-10-29。范围：TUI 中所有向用户展示信息的位置。只读审计，未改代码，未启动 TTY 或真实 Provider，未跑测试。

标记：**[核]** 作者读源码核实；**[报]** 子代理报告，未复核；**[推]** 依代码算术或推断，未运行观察。行号以审计时源码为准，修复前需重新定位。

已撤回（核实后不成立）：
- 转录占满时 toast 不可见：`ui-host.ts:1283-1284` 保证 `breathingGap=1`。
- 缓存命中率重复计数：`ai/gateway.ts:375`、`ai/providers.ts:740` 已把 input 规范为不含 cacheRead。仅字段名 `RequestUsage.promptTokens`（`core/types.ts:332`）易误解，可改名。

---

## A. 违反项目硬约束（未知显示成已知，状态被抹平）

| # | 位置 | 问题 | 方向 |
|---|---|---|---|
| A1 [核] | `tool-view.ts:598-599` | 任何非 failed 且无输出的结果显示“(执行完成，无输出)”，含 unknown/cancelled/not_started | 按 status 给出各自文案 |
| A2 [核] | `tool-view.ts:373-382` | unknown/cancelled/not_started 共用黄色 `?` 图标 | 三种状态各自图标和文案 |
| A3 [核] | `tool-view.ts:484` | 取消只认 `obj.cancelled` 字段，不看 status | 以 status 为准 |
| A4 [核] | `tool-view.ts:518` | `exitCode` 缺失默认 0 | 缺失显示未知 |
| A5 [核] | `features.ts:84` | `currentLevel ?? getReasoningEffort() ?? "off"`，思考强度未知时滑块显示“Off✓” | 未知时不预选任何档 |
| A6 [核] | `effort-slider.ts:67-68,152` | 过滤后 tiers 为空时回退全部 7 档默认值，提供模型未声明的档位；“当前模型未声明可用档位”分支不可达 | 空则走未声明提示，不回退 |
| A7 [核] | `help-menu.ts:21` | 写死“Shift+Tab 循环切换思考强度 (off/high/max)”，实际循环模型声明的 thinkingLevels（`agent/loop.ts:577`，未声明时只有 `["off"]`） | 按实际档位生成或去掉括号 |
| A8 [核] | `tui.ts:233-234`、`transcript.ts:821` | `tokensBefore ?? 0`、`retainedTailEntries ?? 0`，显示“压缩前 ~0 tokens”“保留 0 条”；恢复时强制 status 为 completed | 透传 undefined，`cards.ts` 已能处理 |
| A9 [核] | `agent-events.ts` | `elapsedMs \|\| Math.max(1,…)` 编造 1ms；瞬时节点显示 0ms [报]；compaction 节点 `tokens.total = tokensBefore` 混入热点 token 合计 | 未知耗时不显示；不混入 token 统计 |
| A10 [核] | `tui.ts:308-314`、`agent-events.ts:61,86` | `turn_aborted` 不更新 trajectory，thinking/tool 节点在 Esc/Ctrl+C 后永远 running | 中止时结算在途节点为 cancelled/unknown |
| A11 [报] | trajectory-scene 状态图标 | 只区分 completed/failed，cancelled/unknown/not_started/running 同一黄点，并直接打印英文枚举 `[cancelled]`；“completed”与项目的“succeeded”不一致 | 五种状态各自图标和中文 |
| A12 [核] | `branch-inspector.ts:296`、`session/navigation.ts:200` | 分支行 `seq:0` 占位被打印成 `#0`；预览“分支 abc123”与 `id.slice(0,6)` 重复 | 分支行不显示 seq；去重短 id |
| A13 [报] | `branch-inspector.ts:343-352` | tool 消息详情不显示 status、工具名、tool_call_id；缺失 `call.args` 渲染成 `{}`，像“空参数调用” | 显示 status 与 id；缺失显示未知 |
| A14 [报] | `branch-inspector.ts:126-132,276,309` | `tryReadEntry` 吞读取错误，已选中节点显示“(未选中任何节点)”；“(当前筛选无节点)”引用不存在的筛选 | 区分读取失败与空 |
| A15 [报] | `context-card.ts:99,108` | 恢复的提示词卡没有 `previousSystemPrompt`，永远显示“首次建立”，`messageCount ?? 0` | 缺失时不判定首次 |
| A16 [报] | `transcript.ts:866` | 外部输入卡 `receivedAt` 取当前时间；kind 为原始英文 | 用记录时间；未知则不显示 |
| A17 [报] | `transcript.ts` 恢复路径 | 工具名显示为 `tool`；耗时仅取 JSON 里的 elapsedMs；轮次编号与实时不同；中止消息靠文本“已打断”识别（`:893-897`） | 恢复路径保留结构化字段 |
| A18 [报] | `transcript.ts:504-519`、输入区 | 工具图片在自定义 ToolRenderer 下被丢弃（`transcript.ts:504-519`）；输入区无图片附件展示 | 补展示或明确占位 |

---

## B. 用量、速度、缓存

| # | 位置 | 问题 |
|---|---|---|
| B1 [核] | `activity-line.ts:253,263,276` | done 阶段对真实 usage 也写 `~N tokens`；分支间写法不一（“N tok” 与 “~N tokens”）。`~` 应只标估算 |
| B2 [核] | `activity-line.ts` | `~N tps` 用按单一模型标定的常量（STREAM_TOKENS_PER_CJK_CHAR 0.867 等），当事实展示；tps 与 token 总数用的样本集合不同 |
| B3 [核] | `context-bar.ts` | “剩余”在使用量为估算时不加 `~` |
| B4 [核] | `tui.ts` turn_start | `markUsageEstimated` 清掉 `lastUsage`，缓存徽标每轮开始即消失 |
| B5 [核] | `ui-host.ts` formatCacheHitRate | `cacheRead<=0` 返回 undefined，“命中 0%”与“Provider 未报告”不可区分 |
| B6 [核] | `input-line.ts:1146-1153` | 底边 `Math.min` 把用量压到 100%，超限不可见；minimal/low 都显示“低”，xhigh/max 都显示“极高” |
| B7 [核] | `core/types.ts:332` | `RequestUsage.promptTokens` 实际不含 cacheRead，命名误导 |

---

## C. 信息被吞或丢失

| # | 位置 | 问题 | 方向 |
|---|---|---|---|
| C1 [核] | `tui.ts:229`、`builtin.ts:154-160`、`cards.ts:70` | failed/cancelled/noop 压缩只有 3 秒 toast，错误原因随即消失；`cards.ts` 非 completed 分支成死代码 | 失败/取消写入转录卡片 |
| C2 [核] | `ui-host.ts:1024-1037,1410-1420` | toast 单槽，provider_retry、压缩结果、模型切换互相覆盖；复制提示优先于所有 toast | 队列或按级别保留 |
| C3 [核] | `tui.ts:318`、`transcript.ts:709` | `notice` 事件只发 3 秒 toast，转录另有 `ℹ` 通知，同一信息两种形态 | 统一去向 |
| C4 [核] | `ui-host.ts:218,1055-1056` | 扩展 `setStatus` 写入 `statuses` map，无任何读取，状态不可见 | 渲染或移除接口 |
| C5 [核] | `builtin.ts:138-147`、`tui.ts:351,375` | 压缩进度两个写入者（“正在压缩上下文”与“正在压缩上下文：阶段”），另加 toast“正在压缩会话历史…” | 保留一个来源 |
| C6 [核] | `ui-host.ts:1202-1207` | 只显示序号最大的 workingContribution，并替换 ActivityLine | 并列或合并显示 |
| C7 [核] | `ui-host.ts:1196-1201` | provider-retry 头部耗时是整轮耗时，不忙时为 0 | 用本次重试的耗时 |
| C8 [核] | `tui.ts:242-249` | provider_retry 同时写重试行和 toast，内容重复 | 只保留一处 |
| C9 [核] | `ui-host.ts:1484` | 转录行 `truncateToWidth(rawLine, w, " ")` 静默裁掉 | 换行或加省略号 |
| C10 [核] | `cards.ts:254,275`、`context-card.ts:51` | `stripAnsi` 后再用空省略号截断，颜色/加粗全丢，无省略号 | 先截断再上色，保留 ANSI |
| C11 [核] | `format.ts:113,201`、`tool-view.ts:407-408,569`、`cards.ts:30,35`、`agent-events.ts` 的 `slice(0,N)` | 按 UTF-16 长度切片，不按显示宽度，可能切开代理对，无省略号 | 统一用宽度截断 |
| C12 [报] | `branch-inspector.ts:168,178,189,298,313-322` | 宽屏所有 cell 用空省略号截断：36 位 UUID 在 80 列被截尾，无法复制；顶部帮助行丢“[Esc] 关闭” | 换行显示完整 id |
| C13 [报] | `branch-inspector.ts:168,178,298,313-367` | 列表与详情 ANSI 被两次 strip，只剩“❯”标选中，详情颜色丢失 | 保留样式 |
| C14 [报] | `branch-inspector.ts:381-394` | 每段最多 6 行后加裸“…”，无“已截断”提示；按 UTF-16 切；CJK 下 O(n²) | 提示截断并按宽度切 |
| C15 [报] | `trajectory-scene.ts:277` | 热点只显示前 6 项，无“还有 N 项”；`errors`/`totalTokens` 采集但不显示；key 含唯一 label，行从不聚合（count 恒为 1） | 修聚合键，显示错误数 |
| C16 [报] | `trajectory-scene.ts:252-268,322-324` | 宽屏顺序 error>args>result，紧凑为 error>result>args；成功工具的 result 在宽屏永不显示；失败只显示单行 error，无 args | 统一顺序 |
| C17 [报] | trajectory 数据源 | `tui.ts:170` session_rewind 与会话恢复不重建 trajectory；节点不清理 | 恢复时重建 |
| C18 [报] | `ui-host.ts:1239-1280` | widget 宽度处理不一致，`aboveRaw.slice` 静默丢行；`overlay.ts` `renderAbove` 溢出时静默丢标题与上边框 | 溢出给出提示 |
| C19 [报] | `ui-host.ts:268-275`、`utils.ts:487-514` | 剪贴板写失败仍显示复制成功；字数按 UTF-16 | 按真实结果提示 |
| C20 [报] | `ui-host.ts:348,413,1009` | 错误 toast 追加原始英文 `String(error)`，或压缩后的 `constructor.name` | 给可读中文 |
| C21 [报] | `file-candidates.ts:24-47` | SKIP 集静默隐藏 `@dist` 等候选 | 可见或可开关 |
| C22 [核] | `suggestions.ts:81` | 无匹配项时不显示卡片，用户看不到“无结果” | 显示“无匹配” |
| C23 [报] | `providers.ts:1042` | 模型的 contextWindow 未知时被隐藏 | 保持未知并显示 |
| C24 [报] | `model-picker.ts` | 选中 0 模型的分组按 Enter 无反馈 | 给出提示 |

---

## D. 版面与对齐

| # | 位置 | 问题 |
|---|---|---|
| D1 [核] | `suggestions.ts:122-129,152-159` | 命令名、文件路径从不截断，顶破右边框 |
| D2 [核] | `suggestions.ts:163,89,95-96,83` | 类别列英文 file/directory 并用空省略号截；“共 N 项”被截；loading 标题与正文重复；`cardWidth=max(30,columns)` 可超出终端宽度 |
| D3 [核] | `core/utils.ts:68-88` | `isFullWidth` 漏 ⌚☔☕⚽ 等，却把 0x1F300–0x1FAFF 整段当宽字符 |
| D4 [核] | `utils.ts:107` vs `:120` | tab 宽度 charWidth=2、graphemeWidth=1，选择/截断与渲染不一致 |
| D5 [推] | `trajectory-scene.ts:273,280-294` | 热点行宽 `innerW+2`，右边框突出 2 列；表头少 4，标题与数据差约 9 列；时序视图底边多 1 |
| D6 [推] | `model-picker.ts:198-201` | 底部提示使行宽为 boxWidth+1，`╯` 被 `compositeTuiLine`（默认“…”）换成“…” |
| D7 [报] | `ui/core/overlay.ts:22,25,217-218` | 凡宽出 1 列的组件行都会静默丢右边框 |
| D8 [报] | `branch-inspector.ts:324,325,360,366` | rewind 原因/备注、input 文本、custom_message 未经 `plainLines`，内嵌换行破坏边框（同类 bug 已对 message 修复） |
| D9 [报] | `agent-events.ts:45,74,103,132`、`trajectory-scene.ts:247,253,264,322-324` | 用户提问、error、resultPreview 未清洗，含换行/CRLF/ANSI 时破坏边框 |
| D10 [报] | `timeline-rail.ts:169-200` | 预览只折叠 `\r\n`，tab/ANSI 透传；刻度无轮次号，窗口外轮数无提示 |
| D11 [报] | `transcript.ts:1032-1049` | 用户文本未过 `sanitizeRenderText` |
| D12 [报] | `utils.ts:547-562` | `wrapTextWithAnsi` 按字符换行且只保留最后一个 SGR；`truncateToWidth` 在省略号前 reset |
| D13 [报] | `ui-host.ts:1701-1711`、`input-line.ts:1088-1095` | 输入区滚动后视口标签点击热区错位；命中测试假定 2 列提示符（`ui-host.ts:1725,1752`） |
| D14 [报] | `extension-ui-context.ts:292-306,110-113` | 确认框提示插在按钮行前；提示框固定最大 60 列 |
| D15 [核] | `ui-host.ts:1194` | reservedRight 36/10 写死 |
| D16 [报] | `banner.ts` | cwd 静默截断；标语居中 38 vs 鲸鱼 40 |
| D17 [报] | `scrollbar-gutter.ts:83-85,171,174-176` | 250ms 悬停防抖是死代码；chip 百分比（scrollTop/maxScroll）与行数（scrollTop+1 / 总换行数）基准不同 |
| D18 [报] | `input-line.ts:496,540-552,823,916` | 粘贴块 ▾ 看似可点，仅 Ctrl+O 在光标处展开；字数按 UTF-16；≥100 字符/3 行即折叠 |

---

## E. Markdown 与 diff 渲染

| # | 位置 | 问题 |
|---|---|---|
| E1 [核] | `markdown-table.ts:64-66` | 反斜杠被当转义吃掉：`C:\Users\x` 变 `C:Usersx` |
| E2 [核] | `stream-markdown.ts:148-151` | 先判表格后判围栏，``` 内的表格行被渲染成表格 |
| E3 [核] | `diff-view.ts:75,253-258` | 折叠项含所有 same 行，取前 8 条，“还有 N 行变更”把未变行也算入 |
| E4 [核] | `transcript.ts:1116`、`stream-markdown.ts:46` | `startsWith("│")` 守卫永不成立（代码框首行以 ANSI 和“┌”开头），边框前被加“● ” |
| E5 [报] | `diff-view.ts:49-101` | 超过 1000 行的 diff 退化成伪全删全增 |
| E6 [报] | `diff-view.ts:110` | tokenizeWords 的 `\w` 仅 ASCII，中文词级 diff 失效 |
| E7 [报] | `stream-markdown.ts:43,57`、`syntax-text.ts:53-57` | 语法高亮按行处理；伪语言名“code”；缺别名 |
| E8 [报] | `transcript.ts:1139-1158` | `.trim()` 压平嵌套列表，无悬挂缩进；box-drawing 行不换行 |
| E9 [报] | `inline-markdown.ts:16-19`、`stream-markdown.ts:68-94` | 粗体正则会吃 `src/**`；无斜体/删除线/转义；只支持 #/##/### 标题 |
| E10 [报] | `markdown-table.ts:174-183` | 列宽按原始 markdown 测量；仅表头的表格什么都不渲染 |
| E11 [报] | `smooth-reveal.ts`、`transcript.ts:550,553,1285` | 共用 key `turn-${uid}-text` |

---

## F. 操作提示与实际按键不符

| # | 位置 | 问题 |
|---|---|---|
| F1 [核] | `trajectory-scene.ts:292` | 提示“Enter 展开”，无 Enter 处理器（处理器只有 Esc/Tab/←→，见 `:157,162,169-172`） |
| F2 [报] | `trajectory-scene.ts:168,175-182,326` | 热点视图仍写“←→ 移动时序”但 ←/→ 被忽略；紧凑模式“Tab 热点”无效果（`formatCompactLines` 忽略 viewMode）；`e` 键（下一个错误）未文档化且无错误时静默无反应 |
| F3 [核] | `prompt-overlay.ts:19-20,44` | 页脚“↑/↓ 或 j/k 滚动”，实际只处理 PageUp/PageDown/j/k；无位置指示；每次 8 行 |
| F4 [核] | `effort-slider.ts` | ←/→ 即刻生效（onChange），提示写“Enter/Esc 完成”；Esc 不回滚，与 Enter 等价；已选档位的 ✓ 随焦点移动，易误认为未生效 |
| F5 [核] | `help-menu.ts:94,26` | 任意可打印键关闭并吞掉按键；“?”行写“唤起/收起”，菜单内“?”却转为普通输入；未列 Ctrl+L |
| F6 [报] | `help-menu.ts:29-39,68-72,169,186` | 宽屏不可滚动而紧凑页脚宣传 ↑↓/j/k；紧凑模式快捷键与命令混排无标题；“常用斜杠指令”实列全部命令；默认命令表缺 /prompt、/history |
| F7 [报] | `branch-inspector.ts:53-58,75,89,189,230-231,262` | “←→ 翻页详情”在焦点为列表时实为切视图；branch-history 中 Esc 是返回，却写“关闭”；“Enter 选择分支”所有模式都显示；静态“[←/→] 切换视图”在焦点为详情时错；紧凑模式不提 Tab/←→；X/Y 计行数而每次 ←/→ 走 13 行 |
| F8 [报] | `activity-line.ts:589`、`cli/cancel-decision.ts:62-67` | “Esc 打断并发送”措辞误导；快捷键提示固定不随终端变化 |
| F9 [报] | `ui-host.ts:1588-1602` | 帮助浮层任意点击即关闭 |
| F10 [报] | `ui-host.ts:2146-2150,2202-2218` | 建议卡无按键提示；无参命令按 Enter 立即执行 |

---

## G. 语言、术语、格式不统一

| # | 问题 |
|---|---|
| G1 [核] | 英文残留：`tool-view.ts:401,465,610` 的 `Running…`、`… +N lines (ctrl+o to expand)`；`help-menu.ts`、`model-picker.ts` 的 “(Help Menu)”“(Trajectory)”“(History)”“(Providers)”“(off/high/max)”；`diff-view` 的“(diff)”；trajectory 的“时间线 (Timeline)”“性能热点 (Hotspots)”“Turn #n” |
| G2 [报] | 分支检查器的原始枚举：“焦点 list/detail”“类型 message/input/rewind/custom_message”、role、input mode/source；时间戳为原始 ISO，trajectory 用 `toLocaleTimeString()`（随 locale、无日期）；标题嵌套不一（“分支选择 [只读分支]”/“分支历史（只读）”/“废弃分支（只读）”）；branch-history 不显示打开的是哪个分支 |
| G3 [核] | 术语不一：推理强度（滑块标题）/ 思考强度（帮助、/effort）/ 思考档位（features 提示）；同一“未声明”状态，/effort 用“当前 Provider 未提供 thinking 能力元数据…”（warning），滑块用“当前模型未声明思考档位”（info） |
| G4 [核] | `effort-slider.ts:17-23`：档位名英文，描述含英文括号，并编造语义（“推荐日常使用”“适合简单任务”）；[报] `normalizeEffortId` 将未知串映射成 medium，而标签保留原名 |
| G5 [核] | 耗时格式至少 4 种：`format.ts` 的 formatDuration 与 formatElapsed、`tool-view.ts:152`（“3m 12s”）、活动行“0.0s” |
| G6 [核] | stdio 路径（`cli/stdio-render.ts`、`cli/app.ts:376`）用 `format.ts` 的 toolStartLine/toolResultLines（`[工具]`、`⏳`），TUI 用 `tool-view.ts`，同一工具两处外观不同 |
| G7 [报] | `Ctrl+O` 与 `ctrl+o` 大小写不统一；diff 提示中文而工具卡英文；`cards.ts`“保留 N 条”vs“保留 N 条主线记录” |
| G8 [核] | `transcript.ts:724`：中断提示用 modelName 当主体名（“接下来想让 ${name} 做什么？”） |
| G9 [核] | `cards.ts` 的 `parseDiagnosticMessage` 靠文本启发式降级严重度（含“部分”“3/5”“已更新”等即当警告），真实错误会被误判为警告 |
| G10 [核] | `tool-view.ts` extractSummaryArgs 的键名取自其它工具生态（CommandLine、TargetFile 等），Uina 自己的参数名对不上时回退 JSON；类别配色的注释与实现不符（`:388`） |
| G11 [核] | `tool-view.ts:489-495`：isError 无 `obj.error` 时直接输出原始 JSON 字符串；`:478/508/617` “Alt+T 查看轨迹”只在最新失败时出现，unknown/not_started 不出现 |
| G12 [核] | `cards.ts`：渲染失败文本 `✗ [type] 渲染失败: ${String(err)}` 未清洗；BaseCustomComponent.rebuild 恒传 `{expanded:false}` |

---

## H. 架构评价（作者判断，凭印象，未核对真实扩展写法）

结论：分层骨架干净；展示层契约不干净，对扩展作者谈不上好用。

### 做得好
- 依赖方向清楚：`host/` 不依赖 UI，扩展只能走公开 UI contract，UI 不拥有 Subject/Session 权威状态。
- 扩展状态键由 `extensions/runner.ts:766` 加 `${id}:` 前缀，互不冲突。
- 浮层统一走 `OverlayStack`，面板由 `features.ts` 按 action 名派发。
- `check:boundaries` 强制分层，不靠自觉。

### 问题
1. **没有统一的展示槽位抽象。** 扩展要展示信息，须在 working、notify、setStatus、widget、面板、自定义消息、ToolRenderer 中选择，冲突语义各异（working 只显示最新一条；toast 单槽覆盖；setStatus 无人读取；自定义消息无专用组件时回落通用渲染）。作者无法预判信息是否被顶掉，接口也不反馈。对应 A/C 类。
2. **接口存在但接线无保证。** setStatus 写而不读、`cards.ts:70` 非 completed 分支为死代码、滚动条防抖为死代码、“Enter 展开”无处理器。契约未被类型或测试约束，作者分不清“用错”还是“接口本就不生效”。这是最大的问题。对应 C4、C1、D17、F1。
3. **所有权不清。** 压缩进度由 `builtin.ts:138-147` 与 `tui.ts:375` 各写一份，仅因键名不同未冲突；代码无法回答谁负责展示压缩。对应 C5。
4. **UI 层承担业务判断。**
   - 工具耗时由消费者在收到事件时用 `Date.now()` 计算（`tui.ts:274,284-286`），恢复的会话没有耗时。
   - trajectory 投影在 UI 适配器中，不处理 `turn_aborted`，不随会话恢复重建（A10、C17）。
   - 状态映射靠 `obj.cancelled` 而非 `ToolResultStatus`，五种状态在显示层被压成两三种（A1–A3）。
5. **缺少共用布局原语。** 截断、换行、去 ANSI 由各组件自写：空省略号、先 `stripAnsi` 再截断、按 UTF-16 切片。同一根因分散在十几处（C9–C11、D1–D12）。应有一个“按显示宽度把一行安全放进框内”的统一函数。
6. **同一信息两套渲染。** stdio 走 `format.ts`，TUI 走 `tool-view.ts`，外观与用词不同（G6）。

### 判断
核心边界做对了，这是难的部分。展示一侧是逐个机制叠加，缺统一槽位语义和接口生效的测试。只修表面 bug 能缓解症状，但不收敛成少数几种有明确冲突规则的槽位，同类问题会继续出现。

### 不确定
未核实扩展作者实际写法。若真实扩展大多只用 notify 和自定义消息，第 1 点的影响小于上文所述。

---

## I. 本次审计未覆盖的类型（尚未审计，不是已发现的问题）

前文只查了“已显示的信息是否正确”。以下类型未系统检查，列为待查项。全部凭判断列出，未重新读源码；“已知线索”引用前文条目。

| # | 类型 | 待查内容 | 已知线索 | 验证方式 |
|---|---|---|---|---|
| I1 | **漏显示**（该显示而没有显示） | JSONL 写入/flush 失败是否可见；会话恢复时未完成工具被结算成什么状态、是否告知用户；Provider 的 context window、thinking levels 未知时如何表达；当前 Provider/模型及请求重试状态；子代理、后台任务状态 | A5、B3、C1、C4 | 沿事件链逐项核对“是否有对应展示” |
| I2 | **终端输出安全**（不可信内容注入） | 模型输出、工具输出、错误文本中的控制序列是否都被清洗；是否可能经 OSC 序列改标题、写剪贴板、伪造链接 | D8、D9、D11 只发现用户文本、trajectory、分支检查器未清洗；助手正文和工具原始输出的清洗路径未核实 | 读渲染入口 + 构造含 ESC/OSC 的输入做测试。**优先级高：不只是花屏** |
| I3 | **终端兼容与降级** | NO_COLOR/无色终端；非 UTF-8 与传统 Windows 控制台；东亚歧义宽度；窄终端下限；缩放时流式输出和浮层行为；stdio/管道/非 TTY 的完整输出 | D2（`cardWidth=max(30,columns)`）、D3、G6 | 需在真实终端实测 |
| I4 | **性能与规模** | 长会话转录是否全量重渲；流式每个 chunk 是否触发全量换行计算 | C14（O(n²)）、C17（trajectory 节点不清理） | 需实测 |
| I5 | **输入侧显示** | IME 组合态；括号粘贴；CJK/组合字符上的光标位置；多行输入滚动 | D13、D18 为零散 [报] | 需实测 |
| I6 | **文案集中化** | 中文字符串散落在各组件，无统一文案表 | 这是 G 类英文残留与术语不一的根因 | 统计硬编码文案分布 |
| I7 | **缺显示层测试** | 需要快照或宽度断言：给定宽度下每行不超宽、不含未清洗控制字符 | D 类问题修复后无防复发手段 | 补测试 |
| I8 | **文档与实现不一致** | 对照 `docs/current-runtime.md` 中关于 UI 的描述核实 | 未核对 | 文档逐条对源码 |

处理建议：先做 I2、I1（风险高于多数已列出的版面问题）；I3–I5 必须实测；I6、I7 并入 H 节的收敛工作；I8 随修复同步。

---

## 建议处理顺序

1. A、C1–C5：行为级，违反项目硬约束，且影响用户判断。
2. D1、D5–D9、E1–E4：会破坏边框或丢内容。
3. F：提示与按键对齐，改动小。
4. B、G、其余：展示一致性。
5. I2、I1：补审计，先于 B–G 的多数条目（涉及安全和漏显示）。
6. H：架构层面。先补“接口生效”的测试，再收敛展示槽位，最后抽共用布局原语；否则 A–G 的修复会再次散落。

## 未验证与边界

- 全程只读，无 TTY、无真实 Provider、未跑测试。D5、D6 及其它宽度结论是算术推导，未见实际输出。
- 标 [报] 的条目来自子代理（编辑器与 Host、Markdown/卡片/diff、浮层与 rail 三块），作者未逐条复核；修复前应先复现。
- 文档由记忆整理，行号可能随工作树变化而偏移。
- 工作树：本次仅新增本文件。`.uina/tmp-deadexp.mjs`、`.workbuddy-ai/`、`tmp/` 不是本次创建。

