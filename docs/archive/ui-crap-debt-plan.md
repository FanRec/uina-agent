# ui/cli CRAP 欠账清偿执行稿

状态：**全部完成**（2026-09-19，批次 1-5：ae3e0da → eafd171 → 11607d7 → ff5805a → 3fccf6d，均推送验证；CRAP gate 全绿 0 欠账）。

## 环境注意（2026-09-19 实测）

宿主沙箱不再放行 vitest 默认 forks/threads 池（所有文件在 describe() 处报 "failed to find current suite"），**唯一可用池 = `--pool=vmThreads`**；且 vmThreads 下：① extension-runner / extension-composition / file-events 三文件 10 例伪失败（VM 上下文动态 import 扩展文件、fs.watch 类），② **运行有失败时覆盖率 json 不落盘**——覆盖跑必须先排除上述三文件保证全绿。跨池覆盖归因有差异（vmThreads 比 forks 基线归因更宽），门禁基线在 forks 恢复后需重测。另：仓库根新建目录（coverage-raw 等）会被 FS 吞，覆盖产物须写入已存在目录并即时消费。

## 背景

CRAP gate（`node scripts/crap.mjs --gate --files=…`）的拦截口径是**圈复杂度 ≥ 8 且行覆盖率 = 0 的函数**。公式 `CRAP = comp² × (1−cov) + comp` 意味着两条清偿路线等价有效：

1. **拆分降 comp**：把单函数 comp 压到 < 8，即使覆盖率仍为 0 也过门——适用于薄 IO 胶水（为它们写 mock 测试是测 mock 而非测逻辑）。
2. **补测试提覆盖**：分支逻辑值钱的纯内核，直接单测——顺带把 comp 高的问题一起解决（拆出的纯函数每个 comp < 8 且被覆盖）。

17 个既有欠账的共性根因只有两类：**分支集中**（平台/模式/键位 switch）与 **副作用耦合**（process/TTY/fetch/spawn/剪贴板/FS 直摸）。清偿手法因此收敛为三板斧：

- **纯内核提取**：解析/决策/计算提为纯函数 + 表驱动单测；副作用壳只做胶水。
- **注入边界**：fetch/spawn/fs 操作作为参数传入壳函数，测试用假实现。
- **表驱动编排**：mode→runner 映射表替代三态大 if 链。

## 批次

| 批次 | 目标函数（comp） | 手法 | 验收 |
|---|---|---|---|
| 1 | ✅ 完成 | `ui/format.ts` toolResultLines(23) | parseToolResult（纯解析，含 tryParseObject/classifyTerminalStatus/字段抽取）+ renderToolResult（按 kind 渲染，stderr/stdout/keys 各自小函数）+ 新增 `tests/ui-format.test.ts` 18 例全分支覆盖 | typecheck/boundaries 绿；vmThreads 全量 44 文件 0 失败（3 文件池伪失败单独记录）；gate 实测残留 6 项 ⊆ 基线；导出签名不变（调用点仅 cli/app.ts 两处）；ae3e0da 已推送 |
| 2 | ✅ 完成 | `extensions/builtin.ts` gutter handler(18) | resolveGutterAction 纯函数（GutterAction 中立结果 + 模式/样式标签表驱动），handler 剩四行胶水；新增 `tests/builtin-gutter.test.ts` 9 例 | 三门绿（vmThreads）；gate 残留 6 项不变；eafd171 已推送 |
| 3 | ✅ 完成 | `rg-installer.ts` downloadRgInner(19) + `search-core.ts` grepWithNode(12) | resolveRgAsset 纯矩阵 + binaryCandidates + writeArchive/extractArchive 小函数（comp 19→4）；buildLineMatcher/matchLines/walkGrep/searchSingleFile（comp 12→7）；新增 2 测试文件 12 例 | 三门绿（vmThreads）；gate 残留 6 项不变；11607d7 已推送 |
| 4 | ✅ 完成 | `cli/app.ts` runApp(24) + renderStdio(19) + shutdown(9) | run-mode.ts（resolveRunMode/composeInitialPrompt/formatStartupBanner/resolveExitCode）+ stdio-render.ts（STDIO_LINES 表驱动 + tool 行格式化）+ attachConsumer/runPrintPhase 收编；comp 24→6 / 19→5 / 9→6；新增 15 例 | 三门绿（vmThreads）；gate 残留 6→3（cli/ 清零）；ff5805a 已推送 |
| 5 | ✅ 完成 | gate 实测残留 3 项：subagent-dashboard handleInput(10)/formatLines(8)、extension-ui-context confirm handleInput(12)（其余计划内小型项在 vmThreads 归因下已被既有测试覆盖或 comp<8，不在 gate 拦截面） | detailKeyAction 纯 reducer + formatDetailTabBar/sliceContentWindow/flattenLines；isMouseReport/isToggleKey/confirmChoice；新增 tests/overlay-keys.test.ts 16 例 | **三门绿；CRAP gate 全绿（2040 函数 0 欠账，17 项基线清偿完毕）；3fccf6d 已推送** |

## 纪律

- 每批：typecheck（含 boundaries）+ vitest 全量 + CRAP gate 三绿才提交；gate 欠账数**只减不增**（不许清一个旧账同时制造新账）。
- 拆分以**保持外部可观察行为逐字节等价**为准：现有渲染语义（样式分支、截断阈值、回退行）一律由测试钉住后再动手。
- 导出签名尽量不动；调用点需要同步时在批次内一并完成。
- 本文档属 docs/proposals/（整体 gitignored），只记当前有效设计。
