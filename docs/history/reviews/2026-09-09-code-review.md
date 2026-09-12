# Uina 全仓代码审查报告（2026-09-09）

> 基线：HEAD `d85a43f`（工作区干净，仅 docs/history/audits/2026-09-09-uina-deep-audit.md 为未跟踪的历史审查稿）。
> 方法：全量静态阅读（src 全部 79 个文件）+ 定向实证（`pnpm typecheck`、`pnpm test` 15 文件/251 用例、`pnpm build` 均通过；用 tsx 探针实跑 JSONL 恢复、边界正则、Node 信号语义、Buffer spread 上限）+ 与既有审查稿逐条对照（标注"已修复/仍存在"）。
> 证据等级：**已确认**＝代码链路或实跑可判定；**疑似**＝需特定运行条件；**未验证**＝缺少环境。

---

## 一、这个项目是什么、目标是什么

**Uina v0 是一个运行在本机终端里的最小 Agent 运行时（微内核 + 扩展）。** 不是框架、不是平台、不是产品套件。

- 定位证据：`package.json`（name uina / version 0.1.0 / private / type module / engines node>=22）、`README.md:1-4`（"一个运行在本机终端中的最小 Agent"）。
- 目标（从 README + docs/current-runtime.md 归纳，且有代码结构支撑）：
  1. 打通一条**可验证的最小纵向切片**：输入 → Subject 活动轮次/队列 → 上下文投影 → Provider 流式 → 工具校验执行 → 结果回注 → JSONL 持久化 → UI/stdio 投影（`docs/current-runtime.md:7-18`）。
  2. **确定性代码拥有状态**：模型只产出文本与结构化工具意图；队列、schema 校验、外部副作用、取消、持久化、生命周期由确定性代码持有（`docs/current-runtime.md:18`）。
  3. **能力全部经扩展激活注册**（builtin 与项目扩展共用 ActivationScope），不搞工具目录扫描/动态旁路（`README.md`、`docs/extensions-development.md`）。
  4. **拒绝伪造事实**：不猜模型上下文上限、不猜 thinking 档位、usage 缺失字段保留缺失、未完成的工具恢复为 unknown（`docs/current-runtime.md:46,76`）。
  5. **明确划出非目标**：长期记忆、语音、视觉、RPC、权限审批、跨重启 Job/Subagent 对账、分布式运行时（`README.md` 末段、`docs/current-runtime.md:94,102`）。
- 规模：src 约 1.4 万行 TypeScript（最大单文件 `src/ui/ui-host.ts` 1925 行），tests 约 6 千行；零运行时框架依赖（仅 ajv + cli-highlight）。

**一句话评价目标达成度**：纵向切片真实可跑、边界声明诚实、文档质量罕见地高；但**"UI 不伪造事实""所有能力经扩展注册""waitForIdle 结算一切"等若干对外承诺，在实现里仍有可举证的破口**（见下文）。

---

## 二、审查出的"部分"划分

按代码所有权与问题颗粒度，全仓可切成 11 个部分：

| # | 部分 | 主要文件 | 规模 |
|---|---|---|---|
| A | Agent 主循环 / 队列 / 上下文 / 压缩 | src/agent/* | 4 文件 ~1400 行 |
| B | Provider 适配 / wire / SSE / 模型事实 | src/ai/* | 4 文件 ~1100 行 |
| C | 会话持久化与恢复 | src/session/* | 3 文件 ~860 行 |
| D | 工具 Broker 与内置工具 | src/tools/broker.ts, src/extensions/runtime-tools/* | 5 文件 ~600 行 |
| E | 扩展系统（宿主/生命周期/命令/UI 接缝） | src/extensions/{host,runner,builtin,commands,runtime-hooks}.ts, src/ui/extensions/* | 8 文件 ~1000 行 |
| F | Job 与 Subagent | src/extensions/{jobs,subagents}/* | 5 文件 ~700 行 |
| G | CLI 组装与进程生命周期 | src/cli/app.ts, src/main.ts, src/ui/core/terminal.ts | ~560 行 |
| H | UI 宿主 / TUI / 适配器 | src/ui/{ui-host,tui,index,format}.ts, src/ui/adapters/* | 7 文件 ~2100 行 |
| I | UI 组件与渲染核心 | src/ui/core/*, src/ui/components/* | ~50 文件 ~7000 行 |
| J | 测试 / 工程化 / 脚本 | tests/*, scripts/*, tsconfig, package.json | ~6500 行 |
| K | 文档与声明一致性 | README.md, docs/* | ~3000 行 |

---

## 三、逐部分问题清单

### A. Agent 主循环 / 队列 / 上下文 / 压缩

| # | 级别 | 状态 | 问题 | 证据 | 影响 / 建议 |
|---|---|---|---|---|---|
| A1 | P2 | 已确认 | **手动 `/compact` 只保留最后一条消息** | `src/agent/loop.ts:210,233` 传入 `keepRecentTokens: 0`；`compaction.ts:94-114` 的 `findKeepFrom(history, 0)` 立即命中末条 | 自动压缩保留 20000 token 的尾部，手动压缩却把除末条外的全部历史压成 ≤200 字摘要，行为严重不对称。建议只覆盖 `contextWindow`，不要清零 `keepRecentTokens` |
| A2 | P2 | 已确认 | **会话写失败会永久毒化写队列** | `src/session/jsonl-store.ts:123-130`：`this.tail = this.tail.then(...)`，一次 reject 后所有后续 append 全部以同一错误 reject，且无 reopen/retry | 一次磁盘/句柄瞬时错误后，本进程所有后续轮次都失败（`loop.ts:818-821` 的 appendMessage 直接抛）。建议：保留首个错误、提供显式 reopen，或让每次 append 独立失败 |
| A3 | P2 | 已确认 | **`pushInput` 浮空 Promise，写失败即 unhandled rejection** | `src/cli/app.ts:327,427` 调用后既不 await 也不 catch；`loop.ts:286-288` 会返回被 reject 的 promise | Node 默认 unhandled rejection = 进程崩溃退出 1。建议统一 `void …catch(report)` |
| A4 | P2 | 已确认 | **工具结果被持久化两次** | `loop.ts:670-677` 写 `tool` message（含完整 result），`loop.ts:769-774` 又写 `tool_finished` 事件（同一 result） | 每个工具输出在 JSONL 里存两份（50KB 输出 → 100KB），恢复时还会把全部结果驻留内存。建议事件只存状态与摘要，正文只留 message |
| A5 | P2 | 已确认 | **`tokensBefore` 两处公式不同** | `compaction.ts:49-54`（beforeCompact 上报：`Σ(len+16)/4`）vs `compaction.ts:174`（写入 compaction 记录：estimateContextTokens + estimateRequestTokens） | 扩展看到的压缩前 token 与日志/UI 展示的不是同一个数。建议只保留一个计算函数 |
| A6 | P3 | 已确认 | 无效参数工具跳过 `tool_result` hook 与 onToolStart | `loop.ts:744-754`：`prepared.error` 分支直接 execute + onToolDone，未走 `runtimeHooks.tools.transformResult`，也没有 onToolStart | 扩展无法改写/审计这类结果；UI 也拿不到开始时间（见 A8）。建议与正常路径合并 |
| A7 | P3 | 已确认 | 被拦截/无效工具的耗时被显示为精确 `0ms` | `cli/app.ts:69`（无 callId → ts undefined → elapsed 0）+ `src/ui/format.ts:45`（0 → "0ms"） | 把"未知耗时"呈现为实测 0ms。建议耗时未知时不显示数字 |
| A8 | P3 | 已确认 | `buildContext` 的 runtimeInputs 分支是死代码 | `context.ts:9,109-111,123-127`；全仓只有 `tests/context-hygiene.test.ts:14` 使用 | `<runtime_events>` 注入路径在生产中永不执行（docs/history/reviews/2026-09-05-plan-delivery.md:21 也承认已改用 input 记录）。建议删除或接线 |
| A9 | P3 | 已确认 | 自动压缩与手动压缩写入的历史角色不一致 | `compaction.ts:72` 注入 `{role:"user", content:"[历史摘要] …"}`；`loop.ts:247-250` 用手写 `role:"compactionSummary"` | 内存角色不同 → `findKeepFrom`/`estimateRequestTokens` 走不同分支。建议统一 |
| A10 | P3 | 已确认 | `before_agent_start` 注入的消息位置与持久化不一致 | `loop.ts:485-489`：`[...buildContext(history), ...convertToLlm(beforeMessages)]` | 注入内容被追加在**历史末尾**（甚至排在最新 tool 结果之后），且不进会话历史 → 模型看到的上下文与持久化历史不同。建议明确注入语义（前插 + 标注来源） |
| A11 | P3 | 已确认 | 输出事件契约有空档 | `runtime/events.ts:32-35` 声明 `channel:"tool"` 与 `reason:"external"|"self"`；`loop.ts:506-523` 只产生 content/thinking 与 cancelled/error | 死契约，扩展按声明写的分支永不触发 |
| A12 | P3 | 已确认 | `estimateRequestTokens` 不计 providerReplay | `context.ts:130-151` 只累加 content/thinking/tool_calls | Anthropic 的 thinking signature 块可能很大，上下文估算偏低 |
| A13 | P3 | 已确认 | 回合间隙的 interrupt 静默无效 | `loop.ts:312-320`：`if (!this.activity) return;` | 一轮刚结束、下一轮尚未置 activity 的窗口内按 Esc/Ctrl+C 无效果 |
| A14 | P2 | 已确认 | 输入队列无深度/年龄/容量观测 | `agent/queue.ts` 只有数组与 order | 持续输入 + 慢 Provider 时无背压可见性（旧审查同项仍成立） |

### B. Provider 适配 / wire / SSE / 模型事实

| # | 级别 | 状态 | 问题 | 证据 | 影响 / 建议 |
|---|---|---|---|---|---|
| B1 | P2 | 已确认 | **缺少可靠总量时仍合成 totalTokens，并被 UI 当"实测"** | `ai/gateway.ts:280`：`next.totalTokens = total ?? (input+output+cacheRead)`；`ai/providers.ts:421` 同逻辑；`loop.ts:431` `actual: last?.totalTokens !== undefined` | Anthropic 从不返回 total_tokens → 永远走合成分支 → UI 标记为 actual。与 `docs/current-runtime.md:76`"缺少可靠总量时显示估算"直接矛盾。建议 totalTokens 只在 Provider 明确给出时设置 |
| B2 | P2 | 已确认 | 严格要求 finish_reason **且** `[DONE]` | `gateway.ts:185-191` | 兼容端点（部分网关/自建服务）不发 `[DONE]` 时会被判协议错误，整轮失败。建议把 `[DONE]` 视为可选、以 finish_reason 为准 |
| B3 | P2 | 已确认 | Anthropic `max_tokens` 硬编码 | `providers.ts:40`：`Math.max(8192, thinking+1024)` | 高 thinking 档（xhigh/max=16k/32k）会请求 17k~34k 输出上限，部分模型直接 400；且不可配置 |
| B4 | P2 | 已确认 | 无请求超时、无 max_tokens/温度等采样参数 | `gateway.ts` 仅靠调用方 signal；`fetchWithRetry` 只处理重试 | 上游挂死时只能靠用户中断；采样参数完全不可控 |
| B5 | P2 | 已确认 | 模型目录无法为"未知 contextWindow"的 Provider 引导 | `providers.ts:590` 需 `createProvider` → `config.ts:57` 要求 `modelContextWindow` 才能构造 | 无 modelContextWindow 时 refreshModels 必然失败，形成鸡生蛋；discovery 能力因此只对已配置上限的 Provider 有效 |
| B6 | P2 | 已确认 | Gemini API key 放在 URL query | `providers.ts:196,211` | key 会进入代理/网关日志与错误信息。建议改用 `x-goog-api-key` 头 |
| B7 | P3 | 已确认 | OpenAI 适配器不使用 providerReplay | `gateway.ts:293-339` 只按文本/工具重建 | Anthropic/Gemini 走 replay，OpenAI 走重建，两套持久化语义并存 |
| B8 | P3 | 已确认 | thinking 请求参数与档位表硬编码 | `gateway.ts:286-291`（deepseek 的 reasoning_effort 直传档位名）、`config.ts:29-48`（硬编码 gemini/deepseek 型号表） | 与"不根据模型名猜测能力"的声明有张力；模型改名即失效 |
| B9 | P3 | 已确认 | 强制 apiKey 非空 | `config.ts:165-176` | 本地/免鉴权端点（Ollama 等）必须填假 key |
| B10 | P3 | 已确认 | `abortableDelay` 不清理 abort 监听器 | `gateway.ts:232-239` | 每次重试向 signal 追加一个监听器 |
| B11 | P3 | 已确认 | 实例键混用 provider id 与 model name | `cli/app.ts:37` 用 `provider.name`（=model）注册；`providers.ts:578-583` choices 同时列 configured(id) 与 registered(model) | 模型选择器出现重复条目；`/model <model-name>` 与 `/model <provider>` 语义混在一起 |

### C. 会话持久化与恢复

| # | 级别 | 状态 | 问题 | 证据 | 影响 / 建议 |
|---|---|---|---|---|---|
| C1 | P2 | 已确认 | 反向依赖：session → agent | `session/recovery.ts:2` import `agent/context.js`；`projectModelHistory`（recovery.ts:196）仅被 tests 使用 | 违反 `docs/current-runtime.md:26` 声明的所有权，且边界脚本不检查该方向。建议把该投影移出 session |
| C2 | P2 | 已确认 | `close()` 在写失败后必然抛错，且调用点未兜底 | `jsonl-store.ts:116-121`；`cli/app.ts:373-375` `void shutdown(false)` | 退出路径变成 unhandled rejection |
| C3 | P3 | 已确认 | 中间损坏记录直接拒绝启动，无导出/修复路径 | `jsonl-store.ts:224-226` | 一条坏行 = 会话不可用；建议提供 `--repair`/导出 |
| C4 | P3 | 已确认 | 恢复对 `input` 记录要求严格前置 `queue_enqueued` | `recovery.ts:73` | 手工编辑/旧实现留下的日志无法打开（设计如此，但无诊断说明） |
| C5 | P3 | 已确认 | 无会话轮转/大小上限 | `cli/app.ts:23-24` 单文件 `data/session.jsonl`（当前已 569 行、3 次压缩） | 长期使用单文件无限增长，启动时全量读入内存 |
| C6 | 事实 | — | 当前会话可正常恢复 | 实测：569 行 / 0 坏行 / 376 message + 189 event + 3 compaction；66 个工具结果（56 succeeded、9 unknown、1 failed），`recoverRecords` 无异常 | 恢复逻辑在真实数据上成立 |

### D. 工具 Broker 与内置工具

| # | 级别 | 状态 | 问题 | 证据 | 影响 / 建议 |
|---|---|---|---|---|---|
| D1 | P2 | 已确认 | **`exec_command` 描述硬编码"当前平台为 Windows"** | `extensions/runtime-tools/exec-command/index.ts:120` | 该字符串直接进入模型上下文；在 Linux/macOS 上模型会得到错误的环境事实（而 `process.ts:66-67` 实际用 /bin/sh） |
| D2 | P2 | 已确认 | 后台命令收集器失败时 Job 已结算但进程未杀 | `exec-command/index.ts:97-106`：catch 里只 `resolveDone({status:"failed"})`，不 abort/kill | 子进程继续跑，registry 已终态，副作用失控（旧审查 P2 仍在） |
| D3 | P2 | 已确认 | Shell spill 临时文件无 owner / 无清理 | `exec-command/output.ts:84-91` 写 `tmpdir()/uina-exec-*.out.txt`，从不删除；smoke 测试每次泄漏约 1.1MB | 长期运行磁盘泄漏，且会话重启后无法追溯引用 |
| D4 | P2 | 已确认 | 前台命令无超时，且 `close` 可能永不触发 | `exec-command/process.ts:41-53`（`close` 依赖管道关闭；只有 abort 时才用 `exit` 兜底） | 命令派生守护进程持有管道时，工具永不返回 → 整轮卡死 |
| D5 | P3 | 已确认 | 流回调里做同步文件 I/O | `output.ts:42,90` `appendFileSync/writeFileSync` | 大输出阻塞事件循环（含 UI 渲染） |
| D6 | P3 | 已确认 | `pending.push(...buf)` 大 chunk 会 RangeError | `output.ts:130`；实测 64KB 通过、200KB 抛 `Maximum call stack size exceeded` | 当前 Node 管道 chunk 上限 64KB 侥幸不触发，属潜伏缺陷 |
| D7 | P3 | 已确认 | `outputLimits` 导出无使用方 | `exec-command/index.ts:172` | 死代码 |
| D8 | P3 | 已确认 | Broker 在 signal 已 abort 时把任何异常统一报 unknown | `tools/broker.ts:124-130` | 工具自身真实错误可能被掩盖为"结果未知"（保守但信息丢失） |
| D9 | P3 | 已确认 | 无执行超时、无并发上限、无观测 | `tools/broker.ts` | 与"本地扩展受信任"取向一致，但缺少度量与上限接缝 |

### E. 扩展系统

| # | 级别 | 状态 | 问题 | 证据 | 影响 / 建议 |
|---|---|---|---|---|---|
| E1 | P1 | 已确认 | **`registerProvider` 可能静默无效** | `extensions/runner.ts:191`：`this.options.onProvider?.(...)` 可选；缺回调时无返回、无报错、无登记 | 扩展以为能力已接入（旧审查 P1 仍在）。建议改为必需 port 或 fail loud |
| E2 | P2 | 已确认 | `sendMessage` / `appendEntry` 在宿主未提供回调时静默 no-op | `runner.ts:192-193` `await this.options.onCustomMessage?.(...)` | 扩展"追加消息"成功返回但什么都没发生 |
| E3 | P2 | 已确认 | 扩展失败状态不可运营 | `runner.ts:126-128` `list()` 只暴露 active 项；激活失败只 emitError | 无法查询"已声明/可加载/失败/最后错误"，也没有 retry 入口 |
| E4 | P2 | 已确认 | UI 注册的 cleanup 无限累积 | `runner.ts:216-220`：每次 `setStatus/setWidget/setHeader/setFooter/showOverlay` 都 `own(...)` 追加到数组 | 频繁更新状态的扩展会让 cleanup 数组无限增长（每帧一次即失控） |
| E5 | P2 | 已确认 | 非 TTY 的兜底 UI 给出"假答案" | `runner.ts:226-233` `createPrintUI`：`select→undefined`、`confirm→false`、`input→undefined` | 扩展在管道模式下拿到的回答是静默编造的，无法区分"用户拒绝"与"无 UI 能力" |
| E6 | P2 | 已确认 | `/reload` 只刷新入口模块 | `runner.ts:138` `?uinaReload=Date.now()`；依赖模块不重新加载 | 文档已承认（extensions-development.md:78），但这是"重载"语义的破口；旧模块也常驻内存 |
| E7 | P3 | 已确认 | 命令名大小写不一致 | `ui/extensions/registry.ts:32-39` 原样存；`extensions/commands.ts:11` 查 `name.toLowerCase()` | 注册 `/MyCmd` 后永远无法分发 |
| E8 | P3 | 已确认 | `getGutterMode/setGutterMode` 声明了但不可达 | `ui/extensions/types.ts:103-107` 与 `ui/extensions/context.ts:356-362` 有实现；`runner.ts:202-224` 的 dynamicUI/ownedUI 白名单未转发 | 扩展实际拿到的 ctx 永远没有这两个方法 |
| E9 | P3 | 已确认 | `RuntimeEvent` 的 `ContextEvent` 从不 emit | `runtime/events.ts:23` 在联合类型里；`host.ts:233` 只在内部构造给 handler | 死契约 |
| E10 | P3 | 已确认 | guard 的 clone 在 structuredClone 失败时退化为浅拷贝 | `runtime/guard.ts:54-61`；`host.ts:394-401` 同 | 冻结/隔离承诺在含函数或循环引用的载荷上失效 |
| E11 | P3 | 已确认 | 扩展发现只扫顶层 `.ts/.js/.mjs/.cjs` | `runner.ts:91-99` | 文档已声明；无 manifest/包化扩展支持 |

### F. Job 与 Subagent

| # | 级别 | 状态 | 问题 | 证据 | 影响 / 建议 |
|---|---|---|---|---|---|
| F1 | P1 | 已确认 | **子 Agent 能力被硬编码剥夺为只有 `get_time`** | `extensions/runtime-tools/index.ts:36-40` `createChildTools` | 子 Agent 无法使用 shell/Job/项目扩展工具；该差异没有来自配置或 capability 的显式声明（旧审查 P1 仍在） |
| F2 | P1 | 已确认 | **子 Agent 输出无限累积且记录永不释放** | `extensions/subagents/registry.ts:83-85`（每个 token/thinking/工具事件入数组）、`:146`（snapshot 每次 `outputs.at(-1)`）、`records` map 无驱逐 | 长会话内存与 UI 读取成本持续增长（旧审查 P1 仍在） |
| F3 | P2 | 已确认 | 子 Agent 使用启动时捕获的 provider | `cli/app.ts:141-142` 传的是启动时 `provider`；`builtin.ts:135-143` 的 `/model` 只改 `subject` | 切换模型后新建的子 Agent 仍用旧模型，且无提示 |
| F4 | P2 | 已确认 | Job 输出淘汰对"首次读取"不可见 | `extensions/jobs/registry.ts:176` `outputLost = cursor > 0 && …`；`examples/file-events.mts:36` 默认 cursor=0 | 第一次读就静默拿到被截断的尾部（除非 producer 自己标 truncated）。建议 cursor=0 时也报告已淘汰 |
| F5 | P2 | 已确认 | `job_output` 静默把等待时间截到 600s | `extensions/jobs/tools.ts:40` `Math.min(requested, 600_000)` | 调用方无法得知请求被改写（旧审查 P1 仍在） |
| F6 | P2 | 已确认 | JobRegistry 无保留/驱逐策略 | `jobs/registry.ts:102` jobs Map 只增不减；每个任务最多缓存 50KB/2000 行 | 长会话内存与看板列表无限增长 |
| F7 | P2 | 已确认 | `close()` 可无限等待不合作的 producer | `jobs/registry.ts:233-240` | `/quit` → `extensionHost.dispose()` → `jobs.close()` 挂死，只能强退（旧审查 P2 仍在） |
| F8 | P2 | 已确认 | 扩展无法向宿主 Job 注册表投递任务；看板只显示 owner=root | `ui/adapters/jobs.ts:9`（ownerId 默认 root）、`examples/file-events.mts:17`（示例自建第二个 JobRegistry） | 扩展的后台工作对内置看板/工具完全不可见，且要复制一套 registry |
| F9 | P2 | 已确认 | 正常 `waiting` 的子 Agent 不通知父 Agent | `subagents/registry.ts:130` 只在 failed/interrupted 时 notify | 父 Agent 无法自然被唤醒读取已完成输出（旧审查 P2 仍在） |
| F10 | P3 | 已确认 | `subagent_send` 阻塞到子 Agent 整轮结束 | `subagents/registry.ts:55-60` → `Subject.accept` 在空闲时直接 `startRun` 并 await 全轮 | 父 Agent 的工具调用被长时间占用，且无超时 |
| F11 | P3 | 已确认 | `accepted` 状态与 `parentId` 无人使用 | `subagents/types.ts:3,14,41`；`createSubagentTools` 从不传 parentId | 死状态/死字段 |
| F12 | P3 | 已确认 | Subagent 的 `outputLost` 恒为 false | `subagents/registry.ts:41-46`（无淘汰，first 恒为 1） | 字段存在但永不触发，属误导性契约 |
| F13 | P3 | 已确认 | `job_output` 取消等待时报 unknown | `broker.ts:124-130` + `jobs/registry.ts:196` | 纯读操作被标为"外部副作用未知" |

### G. CLI 组装与进程生命周期

| # | 级别 | 状态 | 问题 | 证据 | 影响 / 建议 |
|---|---|---|---|---|---|
| G1 | P1 | 已确认 | **`process.on("SIGINT", handleInterrupt)` 收到信号名 → 立即强退** | `cli/app.ts:334` + `:252-262`（`force` 真值 → `handleExit(true)`）；Node 官方文档：信号监听器**第一个参数是信号名**（已核 `doc/api/process.md`） | 管道/非 raw 模式下 Ctrl+C（或任何外部 SIGINT）会走 `process.exit(0)`：跳过 `subject.waitForIdle`、`extensionHost.dispose`、`jobs.close`、`store.close`，并以退出码 0 掩盖未完成工作。建议改成 `process.on("SIGINT", () => handleInterrupt(false))` |
| G2 | P1 | 已确认 | 模块导入即劫持 SIGTERM/SIGHUP 并直接 exit | `ui/core/terminal.ts:141-152` | 任何 import UI 的进程都被接管；外部终止跳过全部关闭生命周期（旧审查 P1 仍在）。建议由 CLI 显式安装/卸载 |
| G3 | P2 | 已确认 | `!command` 绕过 ToolBroker / 工具事件 / 扩展 hook | `cli/app.ts:6,284-307` 直调 `execCommandDirect` | 内置 shell 能力与项目扩展不在同一接缝；无 tool_call/tool_result 事件（旧审查 P2 仍在） |
| G4 | P2 | 已确认 | 非 TTY 下 UI 类内置命令静默 no-op | `extensions/builtin.ts:57,63,69,79,128,157,210,216,222`（`ui?.`） | `/help /think /clear /model /tasks /subagents /trajectory` 在管道模式返回成功但无任何输出（旧审查 P1 仍在） |
| G5 | P2 | 已确认 | 队列消息重新投递时会按命令解析 | `cli/app.ts:206-214` `onUserLine(allTexts[i], …)` | 以 `/` 或 `!` 开头的排队文本会被当作命令/ shell 执行（例如排队中的 `/quit`）。建议投递走"纯文本"通道 |
| G6 | P2 | 已确认 | 强制退出无"丢弃工作"标记 | `cli/app.ts:178-183` | 退出后无法从会话判断哪些 Job/Subagent/写入被中断（旧审查 P2 仍在） |
| G7 | P2 | 已确认 | `nonTTY` close → `void shutdown(false)` 无 catch | `cli/app.ts:373-375` | store.close 失败即 unhandled rejection（见 C2） |
| G8 | P3 | 已确认 | `DATA_DIR` 固定在 cwd | `cli/app.ts:23-24` | 与 `UINA_HOME` 配置目录不一致；换目录启动即换会话（且 data/ 已被 .gitignore，安全） |
| G9 | P3 | 已确认 | 启动时 `refreshModels` 的 stderr 输出可能污染 TTY | `cli/app.ts:38-40` | 与全屏渲染竞争 stdout/stderr |
| G10 | P3 | 已确认 | 单个 `execAbort` 无法取消尚未启动的 `!` 命令 | `cli/app.ts:284-307,322-325` | 取消请求落在队列中还没创建 controller 的命令上时无效 |
| G11 | P3 | 已确认 | SIGINT 监听器从不移除 | `cli/app.ts:334` | 重复 start/嵌入场景无法恢复原状 |

### H. UI 宿主 / TUI / 适配器

| # | 级别 | 状态 | 问题 | 证据 | 影响 / 建议 |
|---|---|---|---|---|---|
| H1 | P1 | 已确认 | **`setFooter` 是彻底空转 API** | `ui/ui-host.ts:802-808` 只往 `footerContainer` 加子组件；`ui-host.ts:1203-1208` 组帧只用 header/transcript/input/below 行；`footerContainer` 仅出现在 83/326/803/805 | 扩展 API 承诺的 footer 永远不显示且无报错（子代理实测帧中无标记）。`rootContainer/editorContainer` 同样从不参与渲染 |
| H2 | P2 | 已确认 | `downTurnN` 量纲错误 | `ui-host.ts:1116`（绝对行号 `absLine`）vs `:1079`（滚动距离 `maxScroll`） | ▼ 按钮在底部时灰掉、或指向已在视口内的轮次（子代理实测） |
| H3 | P2 | 已确认 | `scrollToTurn` 与渲染器不同源 | `ui-host.ts:554,560`（78 列 / rows-8）vs `:1071-1072,1068`（77 列 / 减去 aboveH） | 跳转落点不准，且以宽度为 key 的渲染缓存被反复失效 |
| H4 | P2 | 已确认 | 流式轮次内工具卡热区行号错位 | `transcript.ts:1030/985` 用全量 `it.text` 累加行数，`:915` 渲染用 `smoothReveal` 揭示后文本 | 正在生成的轮次里工具卡无法点击/悬停（子代理实测 lineIndex=60 vs 实际第 13 行） |
| H5 | P2 | 已确认 | 浮层/联想卡未按宽度裁剪 | `ui-host.ts:1061-1063` 对 aboveLines 不做 truncate；`:1048` 把 `innerW` 传给联想卡（`suggestions.ts:350` `max(30, columns)`） | 80 列终端写出 80 宽行 → 触发终端延迟换行 → 整帧错位、输入框被顶出（子代理实测） |
| H6 | P2 | 已确认 | 子代理下钻后 modal 归属丢失 | `ui-host.ts:948-965`：drilldown 先 `handle.hide()` 触发 dispose `close()`（此时 detailHandle 仍为 null） | 再按 Alt+A 会叠第二个看板（子代理实测栈深 1→2） |
| H7 | P2 | 已确认 | `setStatus` 劫持工作行 + `setWorkingVisible(true)` 空转 | `ui-host.ts:768-769,782-786` + `widgets/activity-line.ts:195` | 空闲时永久 spinner + 0.0s；setStatus(undefined) 会清掉正在显示的工作消息；后者只泄漏 60ms 定时器而无任何可见效果（实测） |
| H8 | P2 | 已确认 | 定时器 unref/清理不一致 | `ui-host.ts:743` 有 unref；`:204-207`、`:1628-1631` 无 unref 且 `stop()`(`:398-410`) 不清理 | 空闲按 Ctrl+C 后进程被拖 3 秒无法退出；stop 后仍有回调 |
| H9 | P2 | 已确认 | `openModelPicker` 吞掉异步失败 + currentModel 语义错 | `ui-host.ts:882` `void onPick(name)`；`:879` 用 `modelName`（=model），`builtin.ts:127` 传 `getModel().name`，候选 id 却是 provider id | 切换模型失败变成 unhandled rejection 且无反馈；"当前模型 ✓"永不匹配 |
| H10 | P2 | 已确认 | 全局快捷键先于捕获型浮层 | `ui-host.ts:1566-1724` 全部 return 后才到 `:1726-1738` 的 `topCapturing` 分发 | 任意 modal 打开时按 Alt+A/J/T 会叠出第二个 modal，Esc 需多次 |
| H11 | P2 | 已确认 | Job/Subagent 面板在空闲时不刷新 | `ui-host.ts:1426-1431` 动画只由 setBusy/setWorkingVisible 启动；`task-dashboard.ts:157,167` 用 `Date.now()` 与"实时输出"文案 | 后台任务天生在空闲时运行 → 时长与 tail 停在打开那一刻 |
| H12 | P2 | 已确认 | UI 钩子抛错会被 agent 当轮次失败 | `agent/loop.ts:551` 的 onThinking 有 try/catch，而 `:568`(onToken)/`:755`(onToolStart)/`:775`(onToolDone) 没有 | 一个渲染异常（如 `agent-events.ts:87` 的 JSON.stringify 环引用）就会中断整轮 |
| H13 | P2 | 已确认 | `toolCallMap` 无清理 + callId 丢失 | `tui.ts:224-225` 生成兜底 id，`:243` 却传 `m.callId ?? ""`；turn_end/turn_aborted 不清 map | 被中断的工具永久驻留（内存），同名同毫秒覆盖导致耗时取错；轨迹节点可能挂错 |
| H14 | P3 | 已确认 | 死代码/不可达分支一批 | `ui-host.ts:1474-1490`（`thinking-`/`tool-` 前缀永不命中）、`:1874`（Alt+Up 不可达）、`:116`+1010（lastTps 只读不写）、`setSpeedStats` 写入的 tps/elapsed 从未被 input-line 渲染读取 | 维护者无法区分稳定 API 与残留 |
| H15 | P3 | 已确认 | 剪贴板失败仍报"已复制" | `ui-host.ts:225-244` 空 catch + 无条件 toast | 把未验证结果当成功 |
| H16 | P3 | 已确认 | `loadSession` 不重置状态 | `ui-host.ts:594-597` → `transcript.ts:530-635` 直接追加并重置 turnN | 二次调用产生重复轮次与编号冲突 |
| H17 | P3 | 已确认 | 渲染函数带副作用 | `ui-host.ts:1085,1089,1161-1164` 在渲染中写 scrollOffset/last* | 滚动语义依赖"上一次渲染是否已发生" |
| H18 | P3 | 已确认 | usage 分段保留过期值 | `ui-host.ts:529-531` 仅在 details.segments 存在时更新；切模型只传两参 | 上下文分段条显示上一个模型的分布 |
| H19 | P3 | 已确认 | `format.ts` 注释与事实不符 | `ui/format.ts:2` 称"TUI 与 stdio 共用"；实际只有 `cli/app.ts` 用，TUI 走 `tool-view.ts` | 两套工具卡片实现并存 |
| H20 | P3 | 已确认 | 适配器 owner 硬编码 + 取消结果被布尔化 | `ui/adapters/jobs.ts:9,17-20`、`adapters/subagents.ts:19` | 非 root owner 的 job 在看板不可见；用户无法区分"已请求取消"与"早已结束" |

### I. UI 组件与渲染核心

| # | 级别 | 状态 | 问题 | 证据 | 影响 / 建议 |
|---|---|---|---|---|---|
| I1 | P1 | 已确认 | **Ctrl+A 全选后 Ctrl+C 不复制，`copySelection()` 不可达** | `input-line.ts:421-425` 先处理 ctrl+c 并清全选返回；`:452-456` 的复制分支永不执行 | 类注释 `input-line.ts:12` 承诺"Ctrl+A 全选并自动复制"，`utils.ts:178` 的剪贴板通路实际死代码 |
| I2 | P1 | 已确认 | **overlay 几何参数对内置浮层全部失效 + 头部截断** | `core/overlay.ts:164-166` 无 options 时直接 `component.render(width)` 且不裁 `maxHeight`；内置调用点 `ui-host.ts:872,891,917,932,951,961,977` 全传 `undefined`；真实裁剪在 `ui-host.ts:1062` `slice(0, maxAboveH)` 从**头部**截断 | `maxHeight/offsetY/margin.top/bottom/anchor` 在产品 UI 中不生效；`offsetY` 只参与 `hasGeometry` 判定（`overlay.ts:185`）却不参与布局；浮层底边框被静默丢弃。注意：扩展 API `ui/extensions/context.ts:337` 会转发 options，故该分支仅对扩展可达 |
| I3 | P2 | 已确认 | 子代理详情/日志多行内容未拆行 | `components/overlays/subagent-detail-scene.ts:106-114`（对比 `task-dashboard.ts:129` 已正确 split） | 一个含 `\n` 的元素多占一行 → 其后所有行下移，光标/鼠标热区/滚动全错位 |
| I4 | P2 | 已确认 | diff 静默截断并当全量事实 | `transcript/diff-view.ts:46-50`（`MAX_DIFF_LINES = 1000`）；`:114-115`（词级 diff 只算前 200 token，其余永不在 `aSame` 集合） | 大文件 diff 的 +N/-M 与实际改动不符，长行整段标为"已变更" |
| I5 | P2 | 已确认 | 工具卡把 unknown/cancelled/not_started 渲染成与成功同款 | `transcript/tool-view.ts:327-340`（`isError = status === "failed"`），状态只以 dim 后缀追加（`:372`） | 五态退化为两态；被中断的工具视觉上与成功无异 |
| I6 | P2 | 已确认 | "释放 ~N tokens" 实为压缩前总量；`turnsCount` 语义矛盾 | `transcript/compact-view.ts:119` + `transcript.ts:578` + `extensions/builtin.ts:195`（`tokensSaved = e.tokensBefore`）；`compact-view.ts:89` 与 `:119` 对同一字段的两种解读 | 把估算当事实；实时路径"已归档 N 轮"错、重放路径"保留最近 N 轮"错 |
| I7 | P2 | 已确认 | **Alt+Enter 换行永不生效** | `input-line.ts:487-496` 用 `matchesKey(data, Key.alt("enter"))`；`core/keys.ts` 的 43 个 case 里没有 `alt+enter` → 落到 `:235-236` 的 `data === keyId` | 与 README 的"Alt+Enter 进入 followUp 队列"、组件注释都不符；实现里的 followUp 实际是 **Tab**（`input-line.ts:514-515`） |
| I8 | P2 | 已确认 | 多行输入框点击定位错行 | `input-line.ts:768-779` `setCursorByClick(clickCol)` 只收列；调用方 `ui-host.ts:1376-1378` 只传 `col-2` | 折行/多行时点到第 3 行会落在第 1 行对应列 |
| I9 | P2 | 已确认 | 宽度计算一批错误 | `core/utils.ts:8-10`（ANSI 正则不覆盖私有模式前缀 `\x1b[>1u` 等，而 terminal.ts 自己就发这些）、`:82`（Emoji 修饰符/ZWJ 重复计宽）、`:96`（Tab 记 2 列而终端按 8 列）、`:95-100`（组合字符记 1 列）、`:284-288`（注释"留 2"与默认 slack 4 矛盾） | CJK/Emoji/粘贴代码/组合字符场景下边框与光标列错位 |
| I10 | P2 | 已确认 | 鼠标解析与事件吞吐问题 | `core/mouse-selection.ts:170` 用 `/^…$/` 要求整块只含一个事件（而 terminal.ts:52 开了 `?1003h` 全事件跟踪）；`:291` 未识别按钮返回 handled:true 静默吞掉；`:178-184` 拖拽期间滚轮破坏选区映射 | 多事件合并时 click/motion 被丢弃；右键/中键被吞；滚动后高亮与复制文本错位 |
| I11 | P2 | 已确认 | context-bar 把 chars/4 估算称为"真实数据" | `widgets/context-bar.ts:1-8,106-109` vs `agent/context.ts:179-248`（按字符分桶再按总量比例缩放） | 同屏中总 token 带 `~`、分段却不带；中文按 chars/4 会低估约 4 倍 |
| I12 | P2 | 已确认 | 悬停触发整份转录全量重渲染 | `transcript.ts:160-201`（cache key 含 hover 状态）+ `ui-host.ts:1473-1503`（每次鼠标移动） | 大会话鼠标移动即重建所有轮次的 Markdown/高亮 |
| I13 | P2 | 已确认 | 组件底部提示行普遍比正文宽 1 列 / 不按 innerW 截断 | `model-picker.ts:191-192`、`subagent-dashboard.ts:143-144`、`subagent-detail-scene.ts:135-136`、`task-dashboard.ts:180-181`、`trajectory-scene.ts:284-285`；`model-picker.ts:164-166`、`subagent-dashboard.ts:121-133` 正文不截断 | 窄终端必然溢出（与 H5 叠加放大） |
| I14 | P2 | 已确认 | 已结算行的行布局有三份重复实现 | `transcript.ts:811,813-852,906-935,977-1003,1024-1058` | 任何一处改动都会让热区/滚动锚点错位（本文件最大维护风险） |
| I15 | P3 | 已确认 | 终端转义注入未被拦截（疑似） | TUI 渲染路径无控制字符过滤；只有 stdio 路径 `cli/app.ts:57` 与 `format.ts:43` 调 `sanitizeTerminalText`；`stripAnsi` 仅用于鼠标选择/复制（`mouse-selection.ts:310,408,504,554`、`transcript.ts:743`） | 模型输出或工具输出（如 `type` 一个含 ANSI 的文件）里的转义序列会原样写入终端，可造成清屏/光标劫持/OSC52 剪贴板写入。建议在渲染入口统一剥离 |
| I16 | P3 | 已确认 | 未接线/死代码一批 | `core/types.ts:27`(wantsKeyRelease)、`:93`(UinaUIMsg)、`keys.ts:25,241-271`(Key.space/parseMouseEvent/isPasteStart/End)、`terminal.ts:88-127`(7 个公开方法 0 调用)、`scrollbar-gutter.ts:28,61-66`、`timeline-rail.ts:40,106`、`trajectory-scene.ts:148,174-178,204`、`custom-message.ts:22`/`custom-entry.ts:22`(setExpanded 无调用方)、`primitives/text.ts`+`spacer.ts`(无实例化)、`tool-view.ts:161-162`(DIFF_BODY_MAX_LINES/SPLIT_DIFF_MIN_COLS，实际阈值硬编码 80 在 `diff-view.ts:294,386`)、`overlays/effort-slider.ts:10`(EffortTierId) | 公开 API 与历史残留混在一起 |
| I17 | P3 | 已确认 | 组件边界与异常 | `custom-entry.ts:58` `JSON.stringify(data)` 无 try/catch（环引用直接打断整帧）；`custom-message.ts:60-70` 多行未分行且 boxW 下限 24 溢出；`compact-view.ts:65-79` 折叠行不截断；`markdown-table.ts:110-124,143-148` 降级模式不截断/列宽下限使总宽超预算；`banner.ts:129,180` 40 列硬编码 | 单点数据即可破坏整帧 |
| I18 | P3 | 已确认 | scrollbar chip 定时器不触发重绘且无清理 | `scrollbar-gutter.ts:69-93,172`；`ui-host.ts:1524-1528` 只在 setHover 返回 true 时渲染 | 250ms 防抖形同虚设（`:172` 已直接用 hoverRow），组件销毁后仍有悬空定时器 |
| I19 | P3 | 已确认 | `formatDuration` 5 份实现且格式不一，119.6s 显示为 `1m 60s` | `tool-view.ts:150-157`、`task-dashboard`、`trajectory-scene.ts:52-58` 等 | 同一时长在不同面板不同口径 |

### J. 测试 / 工程化 / 脚本

| # | 级别 | 状态 | 问题 | 证据 | 影响 / 建议 |
|---|---|---|---|---|---|
| J1 | P1 | 已确认 | 测试里重写生产逻辑（假阳性） | `tests/ui.test.ts:3022-3024` 逐字符复制 `cli/app.ts:168` 的回填逻辑；真实函数是未导出闭包 | 该用例永远通过，无法发现回填回归 |
| J2 | P1 | 已确认 | 空断言 | `tests/ui.test.ts:2505` `some(l => l.includes("a"))`——卡片标题 `run_command` 与折叠提示 `expand` 都含 'a' | stdout 的 "a" 行未渲染也通过 |
| J3 | P1 | 已确认 | 验收脚本"只打印不断言" | `scripts/verify-built-cli.mts:61` 只把 `successMarker` 放进 JSON 打印；`scripts/verify-file-events.mts:75` 的 `verified:[…]` 是硬编码字面量 | "编译产物完成工具闭环/7 项行为已验证"这两个结论没有断言支撑 |
| J4 | P2 | 已确认 | 边界检查既可绕过又误报，且范围过窄 | 实测 `scripts/check-boundaries.mjs:5` 正则：`from "../extensions"`、副作用导入、`require()` 全部 **漏检**；注释里出现 `ExtensionHost` **误报**。roots 只有 core/runtime/agent/ai/session/tools，不含 ui/cli（ui 有 16 个文件 import extensions） | 与 `docs/current-runtime.md:72` 的边界承诺不匹配 |
| J5 | P2 | 已确认 | 两个 verify 脚本不在任何门禁内 | 不在 `package.json:10-18` 的 script、不被 vitest 收集、实测也不在 `tsc --listFilesOnly`（tsconfig include 无 scripts） | 关键端到端验收实际从未自动执行 |
| J6 | P2 | 已确认 | 假 Provider 不接收 signal → 取消路径无覆盖 | `tests/helpers/mock-provider.ts:24` `async stream(req, onDelta)`；另有 4 套并行 fixture（thinking/subagents/extensions-hooks/session-facts） | 所有用 scripted provider 的 Subject 用例都无法验证协作式取消 |
| J7 | P2 | 已确认 | 无 vitest 配置（默认 5s 超时）、无 lint/format/CI | 全仓无 vitest.config.*、无 eslint/prettier/biome、无 .github | 慢机随机超时；2 万行 TS 只有 tsc 把关 |
| J8 | P2 | 已确认 | 关键行为零覆盖 | 手工压缩成功路径（`loop.ts:251-252`）、job 输出淘汰（`jobs/registry.ts:255-259`）、真实 JSONL 写失败（`session-facts.test.ts:134` 猴补）、真实 TTY/resize/信号（tests 中 SIGINT/SIGTERM/process.exit 命中 0）、UI 真实 stdout 字节流（8 处 `write: vi.fn()`） | 现有 251 个用例证明的是"内存/假 Provider 边界" |
| J9 | P2 | 已确认 | `file-events.test.ts:23` 硬编码 PowerShell 且无平台守卫 | 而 `process.ts:66-67` 在非 win32 用 /bin/sh | Linux/macOS 上必然失败 |
| J10 | P2 | 已确认 | 弱断言与资源泄漏 | `smoke.test.ts:411-415` 只断言 `length > 0`；`:400-409` 每次运行写 1.1MB 临时文件且不清理 | 用例名声称的"保留有用后缀"未被验证 |
| J11 | P2 | 已确认 | 72 处 `as any` / 53 处 `!`；tsconfig 缺 `noUncheckedIndexedAccess` 等 | `tests/ui.test.ts` 67 处 `(host as any)` 直接读写私有字段 | 测试与实现强耦合，公共契约未被独立验证 |
| J12 | P3 | 已确认 | tsconfig 死配置 | `tsconfig.json:17` include 的 `tools` 不存在；`:18` exclude 的 `src/ui_new`、`tests/ui_new.test.ts` 不存在 | 误导 |
| J13 | P3 | 已确认 | 用例名与断言不符 | `subagents.test.ts:89-97`（声称验证 root 历史隔离，实际只断言 notices 为空）；`thinking.test.ts:82-86`；`ui.test.ts:2073-2104`（标题"逼真计算"，未断言 token 值） | 用例名制造虚假信心 |
| J14 | P3 | 已确认 | 固定睡眠/无上限轮询同步 | `subagents.test.ts:37-39`（5ms 轮询无上限）、`smoke.test.ts:19-27`、`file-events.test.ts:52` 等 | 慢机不稳定 |
| J15 | 事实 | — | 基线可复现 | 实测 `pnpm test` = 15 文件 / 251 用例通过；`pnpm typecheck`、`pnpm build` 退出码 0 | 与 README/docs 的声明一致 |

### K. 文档与声明一致性

| # | 级别 | 状态 | 问题 | 证据 |
|---|---|---|---|---|
| K1 | P2 | 已确认 | README 的按键说明与实现不符 | `README.md`："TTY 流式期间 Alt+Enter 进入 followUp 队列"；实现是 Tab（`input-line.ts:514-515`），Alt+Enter 不可达（`keys.ts` 无该 case） |
| K2 | P2 | 已确认 | "缺少可靠总量时显示估算"不成立 | `docs/current-runtime.md:76` vs `gateway.ts:280`/`providers.ts:421` 合成 totalTokens + `loop.ts:431` 标 actual |
| K3 | P3 | 已确认 | "所有能力经 ActivationScope 注册"有旁路 | `docs/current-runtime.md:64-70` vs `cli/app.ts:284-307` 的 `!command` |
| K4 | P3 | 已确认 | 声明的所有权与依赖不符 | `docs/current-runtime.md:26,31` 称 session 不依赖 agent、UI 不拥有能力事实；实际 `session/recovery.ts:2` → `agent/context.ts`，`ui-host.ts` 直接持有 Job/Subagent port |
| K5 | P3 | 已确认 | 旧审查稿仍在仓库且已过时 | `docs/history/audits/2026-09-09-uina-deep-audit.md` 标注"进行中"；其中 loadSession 状态伪造（`:232`）、Job 并发上限 10（`:49,59`）、UI 扩思考档位（`:91,100`）在当前代码中已不成立（见第四节） |
| K6 | P3 | 已确认 | 示例转接路径只在仓库内成立 | `examples/README.md:10` 的 `../../dist/examples/file-events.mjs` 仅在"用户项目根 == Uina 仓库"时正确 |

---

## 四、相对旧审查（docs/history/audits/2026-09-09-uina-deep-audit.md）已变化的部分

| 旧结论 | 当前事实 |
|---|---|
| Job 并发上限硬编码 10（P1） | **已修复**：`jobs/registry.ts:109-120` `maxActivePerOwner` 可选，CLI 不传即无上限 |
| 会话重放把 unknown 工具显示为 completed（P1） | **已修复**：`transcript.ts:628` `status: msg.status ?? "unknown"` |
| UI 的 setReasoningEffort 会扩张 thinkingLevels（P1） | **已修复**：`ui-host.ts:443-448` 对未声明档位直接抛错 |
| usage 缺失字段补 0（P1） | **部分修复**：Usage 字段已改可选；但"缺 total 时合成 totalTokens 并标 actual"仍在（B1） |
| token/TPS 无估算标记（P1） | **已修复**：`activity-line.ts:207,209,219` 均带 `~`；但 context-bar 分段仍无标记（I11） |
| Overlay offsetY 死配置（P2） | **仍在**，且已扩展到 maxHeight/margin.top/bottom/anchor 整体失效（I2） |
| session → agent 反向依赖（P2） | **仍在**（C1） |
| job_output 十分钟截断（P1） | **仍在**（F5） |
| SIGTERM/SIGHUP 绕过关闭（P1） | **仍在**，并新增 SIGINT 参数误用（G1/G2） |
| 子 Agent 只有 get_time（P1） | **仍在**（F1） |
| Subagent 输出无限累积（P1） | **仍在**（F2） |
| 非 TTY 命令静默 no-op（P1） | **仍在**（G4） |

---

## 五、修复优先级建议

**第一梯队（事实伪造 / 生命周期破坏，建议立即修）**
1. G1 SIGINT 参数误用（一行修复，影响面最大）
2. B1 totalTokens 合成当实测
3. I6 "释放 N tokens" 与 turnsCount 语义
4. H1 setFooter 空转（要么接线要么删 API）
5. I1 copySelection 不可达 / I7 Alt+Enter 不可达（文档与实现二选一）
6. J1/J2/J3 三个"永远通过"的测试与脚本

**第二梯队（数据丢失 / 卡死 / 越界）**
7. A2 会话写队列毒化 + A3/C2 浮空 promise
8. D2 后台进程失控、D4 前台命令可能永不返回
9. F1/F2 子 Agent 能力与内存、F4 Job 输出静默丢失
10. H5/I13 超宽行破坏整帧（叠加 I3 的多行未拆）
11. I15 终端转义注入（安全）

**第三梯队（契约与可运营性）**
12. E1/E2/E3 扩展注册静默失效与状态不可见
13. H12 UI 异常导致轮次失败
14. J4/J5/J7/J8 门禁与覆盖缺口
15. K1-K4 文档与实现对齐（或反过来改实现）

---

## 六、仍未验证的边界

- 真实厂商端点（DeepSeek 之外的 Anthropic/Gemini 服务端）、真实 TTY/IME、Windows 之外的 shell、断电恢复、跨重启 Job/Subagent 对账。
- 本次未能复现但代码链路确定的项：I15（转义注入）、I8（多行点击）、H5（80 宽行实际换行表现）、A13（回合间隙中断）。
- 实证记录：Node 信号监听器首参为信号名（官方文档 + 本机 probe 因 Windows 不支持向自身发 SIGINT 未能直接复现，改以文档为准）；`Array.prototype.push(...buf)` 在 200KB 时抛 RangeError（本机实测）。
---

## 七、修复与重构记录（2026-09-09）

> 原则：极简内核、扩展性强、开放、少限制、大胆重构；能抄 Pi 可靠实践的优先抄，其余给出最适合本项目的方案。验证：`pnpm typecheck` + `pnpm test`（16 文件 / 261 项）+ `pnpm build` + 真实 CLI one-shot 冒烟全部通过。

### 抄自 Pi 的实践（附 Pi 证据位置）

| Uina 问题 | Pi 依据 | 落地方式 |
| --- | --- | --- |
| 会话写队列一次失败即永久中毒 | `packages/agent/src/harness/session/jsonl/storage.ts:258-265` 的 `enqueue`（tail 吞掉结果、reject 交回调用方） | `jsonl-store.ts` 改为 `this.tail = result.then(()=>undefined, ()=>undefined); return result` |
| 信号在模块导入时接管、SIGINT 被当 force | `modes/print-mode.ts:50-66`、`modes/interactive/interactive-mode.ts:4027-4072` | `terminal.ts` 只导出 `installTerminalGuards()`；`cli/app.ts` 安装零参 SIGINT + 平台裁剪的 SIGTERM/SIGHUP，先优雅关闭再以 143/129 退出，关闭时卸载 |
| 前台命令可能永不返回、无超时、子进程失控 | `utils/child-process.ts:38-136`、`utils/shell.ts:196-247`、`core/tools/bash.ts:29-40` | `process.ts` 实现 exit 后 stdio 空闲收敛、PID 登记与 `killTrackedDetachedChildren`、System32 taskkill、`timeout` 参数非法即抛错 |
| 手写 UTF-8/GBK 解码 + 同步 spill 写 | `core/tools/output-accumulator.ts` | `output.ts` 改用流式 `TextDecoder` + `createWriteStream` + `close()`，删除 `createByteDecoder` |
| 手动 `/compact` 丢掉保留窗口 | `agent-session.ts:1939-1955` 用同一套 settings | `loop.ts` 只覆盖阈值，保留 `keepRecentTokens`；短历史手工压缩保留末条 |
| Provider 注册静默无效 | `runner.ts:357-413` 必有回退目标 + 失败上报 | `registerProvider`/`sendMessage`/`appendEntry` 缺宿主入口即抛错；`diagnostics()` 暴露 failed 状态 |
| UI 注册 disposer 无限累积、白名单漏转发 | `interactive-mode.ts:2209-2249` 按 key 覆盖、`runner.ts:441-451` 展开转发 | `ActivationScope.ownKeyed` + `dynamicUI`/`ownedUI` 改为 Proxy 转发；`ExtensionUIContext` 全必选并新增 `hasUI()` |
| 子 Agent 被硬编码剥夺能力 | 显式 capability 过滤而非隐式剥离 | `createChildTools(source, {include,exclude})` 默认继承父级，组装层显式排除 subagent_* |
| 输出截断对首次读取不可见 | Pi 的 tail 裁剪 + 显式截断元数据 | Job/Subagent `outputLost` 去掉 `cursor > 0` 前置条件；子 Agent 输出 256 KiB 预算、Job 结算后按最旧释放 |
| `job_output` 静默截断等待 | `core/tools/bash.ts:29-40` 非法值直接报错 | 上限改为 setTimeout 上限，超过即报错 |
| UI 每行必须恰好等于宽度 | `tui/src/tui.ts:1148-1152` 兜底裁剪、`tui-main-screen.ts:516-543` 运行时断言 | `renderer.renderFrame` 对每行按终端宽度裁剪并把光标列夹紧 |
| 控制字符注入 | `coding-agent/src/utils/shell.ts:160-190` `sanitizeBinaryOutput` | `format.ts` 新增 `sanitizeBinaryOutput`/`sanitizeRenderText`，接入模型文本、思考、工具卡、diff、custom message/entry |

### 本项目自定的修复（Pi 无对应实践）

- **事实伪造**：Provider 未上报 total 时不再合成 `totalTokens`（`gateway.ts`/`providers.ts`）；压缩卡文案由“释放 N tokens”改为“压缩前 ~N tokens”；工具卡为 `unknown/cancelled/not_started` 使用独立 `?` 图标与警告色。
- **分层**：`projectModelHistory` 从 `session/recovery.ts` 移到 `src/agent/projection.ts`，消除 session → agent 反向依赖，并把该规则写入边界检查脚本。
- **Job/Subagent 可运营性**：JobRegistry 的 owner 过滤改为可选（宿主 UI 看全部 Job）；新增 `diagnostics()`；子 Agent 的 provider 改为 thunk，切换模型对新子 Agent 生效。
- **UI 正确性**：`setFooter` 真正参与组帧；子代理详情多行内容按行拆分；Ctrl+A 后 Ctrl+C 可复制；Alt+Enter 成为 followUp（空闲时换行），Shift+Enter 只负责换行。
- **健壮性**：agent 侧所有 UI hook 调用加 try/catch（渲染异常不再中断轮次）；CLI 用户输入、oneshot、队列重投递不再产生浮空 Promise；队列重投递不再把历史文本重新解析成命令/ shell。
- **工程门禁**：新增 `vitest.config.ts`（30s 超时）、`scripts` 纳入 tsconfig、清理死 include/exclude、`verify:cli`/`verify:file-events` 进入 npm scripts、`verify-built-cli` 的成功标记改为断言、`verify-file-events` 的 `verified` 列表由实际断言生成、`file-events.test.ts` 改为跨平台命令。
- **测试可信度**：`ui.test.ts` 的回填用例改用生产函数 `combineQueuedDraft`（不再复制逻辑）、工具卡行数断言改为匹配真实正文行；新增 `tests/hardening.test.ts` 10 项覆盖写队列恢复、job/subagent 输出丢失、子代理工具继承、registerProvider fail-loud、hasUI、Alt+Enter、渲染宽度夹紧。

### 已完成的后续重构（2026-09-09 第二轮）

B1 布局/滚动、B3 overlay 几何、B2 grapheme 宽度已按 `docs/history/reviews/2026-09-09-ui-layout-refactor.md` 实施并验证：`ui-host.ts` 抽出唯一 `computeLayout()`（渲染/滚动/锚点/命中区共用），`transcript.ts` 抽出唯一 `layoutTurn/ensureModel` 行模型（流式热区与渲染行号一致），hover 只重建命中轮次，`renderAbove` 统一几何（offsetY/margin/anchor/maxHeight 全部生效且超限保留贴近输入框一侧），宽度改为 grapheme + 8 列制表位。新增 `tests/ui-layout.test.ts` 14 项；50/80/120 列实测无超宽行。

第二轮补完三项遗留：**编辑器簇级模型**（`getVisualLayout` 按 grapheme 簇建 atom、光标吸附簇边界，ZWJ 家庭 emoji 在输入框中占 2 列而非 4~6 列）、**布局增量失效**（`invalidateTurn/invalidateCompaction` 只重建受影响块；`UIHost.lastLayout` 让 `preserveScrollAnchor` 只渲染一次）、**时间线轨自适应**（刻度密度随视口高度伸缩并可配置 `maxTicks`，预览卡宽度随内容宽度伸缩并可配置 `previewMaxWidth`）。`tests/ui-layout.test.ts` 扩到 19 项，全量 281 项通过。

### 仍未处理（有意保留或需要更大改动）

- `/reload` 的传递依赖热重载（Pi 靠 jiti，Uina 不宜引入）、`!command` 的 ToolBroker 旁路、SIGTERM 关停时的写队列超时兜底、子 Agent 正常 waiting 的父级通知：需要新的端口或明确产品决策。
- 会话中间坏行的容错（当前策略是拒绝启动）：Pi 的两种策略（coding-agent 跳过 / agent v4 严格）各有取舍，Uina 采用严格校验 + 末行修复，属有意选择。

