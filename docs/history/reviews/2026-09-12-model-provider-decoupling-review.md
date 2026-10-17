# 审查：解耦 Provider（通信凭据端点）与 Model（模型元数据与规格）

- 日期：2026-09-12
- 范围：仅工作树未提交改动（41 个已跟踪文件 + 1 个新测试文件），`git status` 见文末「工作树归属」
- 方法：沿调用链与状态流核实；用可运行探针验证结论（探针脚本已删除，不留痕）；对照 Pi 实际源码
- 结论口径：先给结论与严重度，再给证据、职责归属与方案取舍
- **后续处置（2026-09-12 00:45）**：被审查的这份未提交改动已**整体舍弃**，工作树回到 `HEAD`。
  备份在 `C:\Users\34150\WorkBuddy\2026-09-12-00-24-32\backup-uina-wip-20260912-0045\`（`working-tree.patch` + 未跟踪文件 + 还原说明）。
  本文件保留的价值是：① 该实现的具体缺陷清单，避免重做时再犯；② `models[]` 无需求支撑这一结论的证据。
  注意：其中 P1-2/P1-3（4 条解析路径、伪造 Model/Provider、同名模型 bare id 合并）与 5 个 P0 都是**该改动自身引入**的，HEAD 不存在；
  重新实现时请以 `docs/proposals/provider-model-decoupling-plan.md`（基线为 HEAD）为准。

## 0. 总体结论

方向正确：Provider 持有 baseUrl/apiKey/maxRetries 与传输，Model 持有 id/规格/compat，这与 Pi 的分层一致
（`packages/ai/src/providers/anthropic.ts:42-59`：`createProvider({ id, name, baseUrl, auth, models, api })`）。

但**这一版没有真正解耦，而是把耦合从类型系统挪进了运行时**：

1. Model 上挂了一个接口未声明的 `provider` 实例属性，靠 `as any` 与 `Object.assign` 读写；
2. `resolve()` 造出 `model.model === model` 的自引用，才能满足自定义的 `ResolvedModel`；
3. 一个模型有三把索引键（bare id / `providerId/id` / `providerId`）+ 4 条隐式查找路径 + 1 条伪造分支。

同时这次改动夹带了 **5 个未被现有测试覆盖的行为回归**（P0）和 **2 处 Gemini 协议校验能力的删除**。
`pnpm typecheck` 通过（5 条边界规则 ok），`pnpm test` 344/344 通过，**全绿不代表无回归**——下面每一条 P0 都给出了可复现证据。

---

## P0：行为回归（必须处理）

### P0-1 `maxContextWindow` 静默失效

- 证据（探针实测）：`createModelAndProvider({ modelContextWindow: 32000, maxContextWindow: 16000 })`
  → `model.contextWindow = 32000`，`model.maxContextWindow = 16000`，`Subject.getContextWindow() = 32000`。
- 根因：`src/ai/config.ts` 删除了 `effectiveContextWindow()`（原 `min(modelContextWindow, maxContextWindow)`），
  全仓库再无任何 `Math.min(contextWindow, maxContextWindow)`；
  `src/ai/providers.ts:36` 直接取 `conf.modelContextWindow`，`src/agent/loop.ts:173` 直接写进 `compaction.contextWindow`。
- 影响：配置字段 `maxContextWindow` 变成「校验通过、存进 Model、然后被忽略」的装饰品；用户设的收紧上限不起作用。
- 归属：Model 规格归一化，属 Core/`ai` 层，不是 Extension 策略。
- 新测试 `tests/model-provider-decoupling.test.ts:436` 只断言 `model.maxContextWindow === 16000`，
  没有断言 `Subject` 实际采用的上限，因此这个回归被测试放过了。

### P0-2 事实校验从启动期挪到了首次请求

- 证据（探针实测）：用 `{ type: "anthropic", model: "claude-x" }`（缺 `maxOutputTokens`）构造 `ModelRegistry`
  → **不抛错**；`resolve("a")` 正常返回；直到 `model.stream(...)` 才抛
  `模型 claude-x 使用 Anthropic 协议：/messages 必须显式给出 max_tokens`。
- 根因：`assertProviderFacts()` 现在唯一的调用点是 `createModelAndProvider()`（`src/ai/providers.ts:61`），
  而生产路径 `UinaHost.create` → `new ModelRegistry(config)` → `createEndpointProvider()` **完全不做事实校验**
  （`src/ai/providers.ts:52-57`、`651-678`）。校验只剩 anthropic/gemini 适配器内部的逐请求 `assertModelFacts`（`:82`、`:252`）。
- 影响：非法配置在启动时静默通过，运行时才失败；且 `openai-compatible` 连逐请求校验都没有。
  这与 `assertProviderFacts` 自己的注释「在真实 Provider 创建时调用，因此错误发生在启动阶段」以及
  `docs/history/audits/2026-09-09-uina-deep-audit.md:294` 记录的设计理由直接矛盾。
- 归属：Registry 构造（唯一装配点）负责，不该由适配器兜底。

### P0-3 OpenAI/Qwen 协议的 `includeThinking` 由 false 变成 true

- 证据（探针实测）：`thinkingFormat` 分别为 `"deepseek" / "openai" / "qwen"`、`thinkingLevels: ["off","high"]` 时，
  `createModel(...).includeThinking` 三次都是 `true`；改动前 `createOpenAIProvider` 是
  `includeThinking: conf.thinkingFormat === "deepseek"`，即 openai/qwen 恒为 `false`。
- 根因：`src/ai/providers.ts:40` 的推导式写成
  `providerType === "openai-compatible" && thinkingFormat === "deepseek" ? true : thinkingLevels?.some(level => level !== "off")`，
  else 分支把 anthropic/gemini 的旧规则错误地套到了 openai-compatible 上。
- 影响链：`includeThinking` 同时喂给 `buildContext`（决定 assistant 消息是否携带 thinking，`src/agent/context.ts:50-51`）
  与 `estimateContextTokens`（`src/agent/compaction.ts:90`）；而 `toWireMessages` 只在 `thinkingFormat === "deepseek"`
  时才写 `reasoning_content`（`src/ai/gateway.ts`）。结果是**上下文投影与实际发出的 wire 不一致，token 估算虚高**，
  会提前触发压缩。
- 附带：同一事实在同一文件里有两套公式——`:40` 的推导式与 `:734`（发现模型路径）的 `baseType === "openai-compatible" && base.thinkingFormat === "deepseek"`。
- 归属：这属于「显式事实 vs 推导默认值」的边界问题。按项目规则，`includeThinking` 应由配置/模型目录显式给出，
  不成立时保持未知，而不是由 `thinkingFormat` 反推。

### P0-4 Gemini 工具调用校验与合并被删（与本任务无关的顺手改坏）

对照 `git show HEAD:src/ai/providers.ts:250-266`，本次删除且无替代：

| 被删能力 | 后果 |
| --- | --- |
| `if (functionCall.args !== undefined && !isRecord(functionCall.args)) throw` | 非对象 args 直接写进 `JSON.stringify`，协议异常不再可见 |
| `previous && previous.name !== functionCall.name → throw` | 同 id 对应多个 name 的协议冲突不再报错 |
| `args: { ...(previous?.args ?? {}), ...(functionCall.args ?? {}) }` | 分片下发的同一 id 参数被整体覆盖，只剩最后一帧 |
| `functionCall.thoughtSignature ?? part.thoughtSignature ?? previous?.thinkingSignature` | `functionCall` 级签名丢失，replay 不再完整 |
| `functionCall.name?.trim()` / `functionCall.id?.trim()` | 纯空白 name 通过校验；空串 id 会被当成合法 call id |

对应新代码 `src/ai/providers.ts:309-311`。另外 `:310` 把 `throw` 塞进 `??` 右侧的三元 IIFE，可读性明显低于原来的顺序写法。

### P0-5 `contextWindow` 未知时压缩被静默关闭

- `shouldCompact()` 在 `settings.contextWindow === undefined` 时直接 `return false`（`src/agent/compaction.ts:87`）。
- 改动前 `effectiveContextWindow()` 会在缺少 `modelContextWindow` 时抛
  `模型 X 缺少 modelContextWindow；Uina 不会猜测真实上下文上限`；现在这条路径没了
  （`ModelRegistry` 的发现模型分支仍要求 `discovered.contextWindow`，但配置模型路径不要求）。
- 结果：漏填 `modelContextWindow` 的配置**从「启动报错」变成「静默不压缩」**，直到真的超窗。
- 这与 P0-2 叠加放大：启动期没有任何校验，运行时也没有可见失败。

---

## P1：架构与职责

### P1-1 Model 上挂未声明的运行时属性，再加一层自引用

- `src/ai/providers.ts:7-18` `bindModelToProvider()` **就地改写** 传入对象（`bound.provider = provider; bound.stream = ...`），
  `Model` 接口全 `readonly`（`src/core/types.ts:183-220`），运行时却可变；探针确认调用方对象被改写（`"provider" in callerModel === true`）。
- `src/ai/providers.ts:692/708/743` `Object.assign(model, { model, provider })`：探针确认
  `resolved.model === resolved`，且 `JSON.stringify(resolved)` **抛 "Converting circular structure to JSON"**。
- 风险不在当下而在边界：`src/runtime/guard.ts:54-61` 的 `clone()` 在 `structuredClone` 失败时回退浅拷贝，
  随后 `deepFreeze` 递归子对象；自引用模型一旦进入 `readonlySnapshot` 路径，就是**无限递归 + 冻结活对象**，
  正是 `docs/TODO.md` A04 已记录的那类缺陷。目前 `model_select` RuntimeEvent 只带字符串，所以还是潜伏态，但没有任何护栏。
- `ResolvedModel`（`:640-643`）只是为了「让 return 看起来有个 provider 字段」。按现有用法（`builtin.ts:136` 只读 `.name`）
  它没有存在必要：`Model & { provider: Provider }` 足够，甚至什么都不加也够。
- 对照 Pi：`Model` 是纯数据，`provider: ProviderId` 是**字符串**，传输在 provider 的 `api` 上
  （`packages/ai/src/types.ts:830-857`）。当前实现偏离的正是这一点，其余 P1 缺陷基本都由它派生。

### P1-2 `resolve()` 的 4 条查找路径与伪造分支

`src/ai/providers.ts:680-749`：

1. bare model 命中；
2. 「Direct provider match」：用 `providerId` 现场**伪造**一个 `{ id: providerId, name: providerId, providerId }`
   的 Model，并把 provider id 当作 wire model id。探针确认 `UinaHost.create({ provider })` 得到 `modelName === "just-a-provider"`；
3. `providerId/modelId` 静态扫描；
4. `providerId/modelId` 目录发现（要求 `discovered.contextWindow`）。

- 第 2 条把「未知」变成了「猜一个 id」。按原则应明确失败或要求显式 Model。
  新测试 `tests/model-provider-decoupling.test.ts:611` 反而把这个伪造值固化成了期望。
- 第 1 条的兜底（`:685-690`）：当 registry 里没有对应 provider 时，用 `model.stream` 现场拼一个
  `{ id, stream: (_m, req, ...) => model.stream(req, ...) }` 的伪 Provider——**它的 `stream` 丢弃入参 model**，
  与 `Provider` 合同（以任意 Model 向该端点发起请求）不符。探针确认该分支可命中。
  它被 `tests/tool-pipeline.test.ts` 的 `UinaHost.create({ cwd, model })` 隐式依赖，属于「用假对象让测试过」。

### P1-3 不同端点的同名模型会被 bare id 合并（违反 A06 验收）

- 构造两个 provider，各自声明 `id: "shared-model"`：探针确认 `resolve("shared-model")` → provider **b**（后者覆盖前者），
  而 `resolve("a/shared-model")` → a。
- 根因：`ModelRegistry` 构造时对每个模型写三把键（`:661-662`、`:669-670`、`:706-707`），bare id 无命名空间；
  `registerModel` 同样（`:772`）。
- A06 的验收原文是「不同端点的同名模型不误合并」。当前实现只保证带前缀的键正确，bare 键是**静默的错误命中**。

### P1-4 `ProviderConfig` 仍是端点字段与模型字段混装，校验散在三处

- `src/ai/config.ts:41-44`：`interface ProviderConfig extends ProviderEndpointConfig, Partial<Omit<ModelConfig, "id">>`。
  「解耦」后 Provider 配置里依然住着 `modelContextWindow / maxOutputTokens / thinkingLevels /
  thinkingFormat / thinkingBudgets / geminiToolCallIds / geminiThinkingFormat / includeThinking`。
- 同一批字段被校验三次，规则还不完全一致：
  `validateModelConfig`（`:257-309`）、`assertModelFacts`（`:65-102`）、`assertProviderFacts` 的内联 pick（`:114-122`）。
  其中 `:283` 的 `throw new Error("geminiThinkingFormat 无效")` 连路径、provider、model 都不指名，与相邻错误消息风格不一致。
- 语义裂缝（不只是重复）：
  - `assertProviderFacts` 在 `models[]` 非空时只校验数组元素，**忽略 root 上的同名扁平字段**；而
    `createModel()` 仍然会读 root 字段（`includeThinking`、`name`、`maxOutputTokens`…）——**校验的和使用的不是同一份**。
  - `createModelAndProvider()`（`:59-66`）**完全忽略 `conf.models`**，只用 root 扁平字段建默认模型；
    它是 `tests/*` 与 `scripts/verify-file-events.mts` 唯一依赖的工厂，容易让「多模型配置」在测试里假通过。
  - `ProviderConfig.includeThinking` 在 `validateConfig` 的输出里从未被复制（只有 `validateModelConfig` 会复制），
    即 root 级 `includeThinking` 是声明了但永不生效的字段。
- `src/ai/config.ts:180-186` 新增区块缩进比同级兄弟多一层 tab，同一函数内混用两级缩进。

### P1-5 `compat` 与三个 `@deprecated` 扁平字段是两份真相

`src/core/types.ts:204-209` + `src/ai/providers.ts:27-31,42-45`：`createModel` 同时写 `compat.*` 与
`thinkingFormat` / `geminiToolCallIds` / `geminiThinkingFormat`，消费端统一写 `model.compat?.x ?? model.x`
（`:254`、`:329`、gateway 同形）。这是新代码自己引入的「deprecated 兼容层」，没有历史包袱，
却要求每个读者记住两条读取顺序。另外 `compat` 恒为真值对象（三个字段全是 `undefined`），
会让未来任何 `if (model.compat)` 判断失效。按「每份权威状态一个所有者」，应只留一份。

### P1-6 UI 状态出现两个写者，旧回调变成死接线

- `src/extensions/builtin.ts:168-171` 扩展侧监听 `thinking_level_select` 并写 `ui.setReasoningEffort`；
  `src/ui/tui.ts:294-296` 又监听 HostEvent `thinking_level_select` 写同一个 `reasoningEffort`。
  两条路径的语义还不一样（扩展侧会做 `thinkingLevels.includes` 检查后回落 `undefined`，TUI 侧无条件写 `level`）。
- `BuiltinUI` 的 `setModel?` / `setThinkingLevels?` / `setUsage?`（`src/extensions/builtin.ts:24-26`）
  在本次改动后**已无任何调用点**，但 `src/cli/app.ts:382-385` 仍为它们接线。
  按「无效或未接线机制应删除或明确失败」，这三项应删。
- 反向缺口：模型切换后 TUI 的上下文窗口只在 `model_select` 事件里更新，
  `cli/app.ts` 的 stdio 消费者靠打印一行文本；两条消费路径的能力并不对等（可接受，但值得明确）。

### P1-7 `registerModel` 缺少 teardown 护栏，与 `registerProvider` 不对称

`src/extensions/runner.ts:337-357`：`registerProvider` 把 `stream` 包成 `async (...args) => { assertActive(); ... }`，
`registerModel` 直接把 model 原样交给宿主。扩展卸载后，已注册 Model 的 `stream` 仍可执行扩展代码。
同一份「注册/注销/重载」契约上出现两种生命周期语义，属于接缝不对称。

### P1-8 `Subject.setModel(model, provider?)` 是两个写者 + 只写一半

`src/agent/loop.ts:169-192`：`provider` 参数只做 `Object.assign(model, { provider })`，
**不会重绑 `model.stream`**。于是一旦调用方传入的 model 与 provider 不配对，
`getProvider()`（`:143-145`，`(this.model as any).provider`）报告的是 A，实际执行的是 B。
`bindModelToProvider` 与 `setModel` 都能写 `.provider`，没有单一所有者。
`getProvider()` 的返回类型里还多一层 `as any`——因为 `provider` 根本不在 `Model` 接口上。
另外 `provider?` 参数在生产代码里从未被使用（只有测试用），属于接口噪音。

### P1-9 `Subject` 构造把 hooks 变成可省略，`runtime.ts` 用 `any` 抹掉 usage 契约

- `src/agent/loop.ts:106`：`hooks: LoopHooks = { onToken: () => {} }`。改动前 hooks 是必填参数。
  现在漏接 hooks 不再报错，只会静默收不到任何 token（UI 会表现为「没有输出」）。
- `src/agent/runtime.ts:60`：`onTurnEnd: (turn: number, usage?: any)`。
  `LoopHooks.onTurnEnd` 的 usage 有完整结构（`src/agent/loop.ts` 内定义），这里用 `any` 把契约抹掉了。
  为了通过类型检查而放宽，而不是补齐类型，属于接缝上的质量回退。

### P1-10 `provider.stream(model, ...)` 不校验 `model.providerId === this.id`

端点在拿到任意 Model 时都照发，用 A 的模型 id 配 B 的凭据与 baseUrl 不会被拦。
A06 的验收里正好包含「不同端点不误合并」，这个廉价断言是它的护栏。优先级低于 P0，但应在收敛时一并补上。

### P1-11 `ui-host.setContextWindow()` 复制 `setUsage` 且漏字段

`src/ui/ui-host.ts:441-453` 与 `:534-560` 是同一段逻辑的第二份拷贝（归一化 + `setContextStats` + `contextBar.update`），
唯一的差异是 `contextBar.update` **漏传 `segments`**，而 `ContextBar.update` 是无条件赋值
（`src/ui/components/widgets/context-bar.ts:176-185`：`this.segments = data.segments`）。
后果：切模型后上下文条的分段分布被清空，直到下一次 usage 更新。
参数名 `window` 还遮蔽了全局 `window`。更小的做法是复用 `setUsage`（或让 `setUsage` 的 details 都可选）。

---

## P2：冗余、死代码与不一致

1. `choices()`（`src/ai/providers.ts:804-840`）与 `groups()`（`:842-890`）是同一份枚举的两份实现（约 90 行），
   dedup 语义还不同（全局 `seen` vs 按组判断）。生产调用点只剩 `groups()`（`src/extensions/builtin.ts:236`），
   `choices()` 仅被新测试使用。
2. `listModels()` / `listProviders()` / `ModelRegistry.getModel()` / `getProvider()` 除新测试外无调用者；
   `Model.has()` 无调用者（`:751-753`）。属于「为假想的未来预先设计」的 API 面。
3. `createModel()` 的第 5 个参数 `streamFn` 无任何调用点（`:25`、`:46`）。
4. `createModel()` 的 `providerId` 默认值等于 `id`（`:23`）：`createModel("gpt-4o")` 会得到一个
   `providerId === "gpt-4o"` 的模型，即「擅自把模型名当 provider 名」。这是 A06「Provider 身份与 model id 混用」问题的残留。
5. `tests/helpers/mock-provider.ts` 新增 `scriptedModel` / `mockModel` / `mockPair` / `scriptedProvider` 四个等价工厂，
   其中 `mockPair`、`mockModel`、`scriptedModel` 无任何测试引用；`extensions-hooks.test.ts` 内部另有第 5 份 `makePair`。
6. `src/host/host.ts:183-189` 无条件写 `thinkingLevels: m.thinkingLevels`（可能为 `undefined`），
   与仓库其余地方 `...(x === undefined ? {} : { x })` 的省略风格不一致；新测试 `:525` 因此在 `toEqual` 里显式写了
   `thinkingLevels: undefined`，把「存在但为 undefined」固化成了契约。
7. `src/ai/gateway.ts` 由 `thinkingFormat?: ProviderConf["thinkingFormat"]` 改为 `ModelCompat["thinkingFormat"]`，
   但 `ModelCompat` 与 Model 的三个扁平字段仍是同一语义的两种载体（见 P1-5）。
8. 文档：新增的 `providers.<name>.models[]` 配置形态与 HostEvent `model_select` / `thinking_level_select`
   都没有写进 `docs/current-runtime.md`（该文档的定位是「当前运行事实」）；只改了 `docs/extensions-development.md` 一句。

---

## P2+：测试与验证质量问题

1. `tests/subagents.test.ts` 的改动超出本任务范围，且**把强断言换成弱断言**：
   - 删除：`job_list[0].ownerId === child.id`、`job_output.result` 真的包含 `child-result`、
     `transcript` 里有 `runtime-input`、`subagent_start` 返回的 grandchild、`read` 游标的增量语义、
     `first.output.map(kind) === ["thinking","text"]`、`second.output === []`、用户消息顺序；
   - 替换为：`tools.has("exec_command")`、`tools.has("get_time")`、`list().length`。
     即从「工具真的跑通了」降级为「工具被注册了」。
2. `tests/model-provider-decoupling.test.ts:517` 用 `await (host as any).subject.setModel(...)` 伸进宿主私有状态，
   上方还留着草稿式注释（「Let's verify through subject's setModel triggered via host's internal subject / or extension command」）。
   切换入口应该走真实路径（命令或 UI 事件），否则「任意受支持的切换入口都能更新 UI」这条验收没有被覆盖。
3. 该测试文件的标题语言与仓库其余测试（中文）不一致；`:530` 的用例名 `without false positive` 与后半段的
   `toThrow("maxOutputTokens")` 真阳性断言不符。
4. **未覆盖**：P0-1（上限收紧）、P0-2（启动期失败）、P0-3（includeThinking）、P0-5（无 contextWindow 时的行为）、
   P1-3（同名模型）、P1-7（teardown 对称性）。这几条都是「改之前有测试语义、改之后没有任何断言」的位置。
5. 验证结果（本轮实跑）：`pnpm typecheck` ✅（boundary check 5 rules ok）；`pnpm test` ✅ 24 files / 344 tests。
   探针结论见各 P0 条目；探针脚本已删除，未留在工作树。

---

## 建议的最小收敛路径（总复杂度最低）

1. **索引收敛**：只保留规范键 `providerId/modelId` + 一张 `providerId → defaultModel` 表；
   删除 bare id 索引与「Direct provider match」伪造分支（未知就明确失败或要求显式 Model）。这一步同时消掉 P1-2、P1-3。
2. **绑定显式化**：`Model` 只保留 `providerId: string`；`provider` 要么是接口上声明的
   `readonly provider?: Provider`（构造时一次性写入），要么完全不挂在 Model 上、由持有者（Subject/Registry）保存。
   删除 `ResolvedModel` 与所有 `Object.assign(model, …)`/`as any`。这一步消掉 P1-1、P1-8。
3. **校验单一入口**：把 `validateModelConfig` + `assertModelFacts` + `assertProviderFacts` 合并为
   「规范化 → 校验」一次完成，并在 `ModelRegistry` 构造（唯一装配点）调用，恢复启动期失败。消掉 P0-2、P1-4。
4. **恢复被删的语义**：`min(modelContextWindow, maxContextWindow)`（P0-1）；`includeThinking` 改回显式或未知（P0-3）；
   Gemini 的工具调用校验/合并/签名与 trim 原样恢复（P0-4）；`contextWindow` 未知时不静默关压缩（P0-5）。
5. **删冗余**：`choices()` / `listModels` / `listProviders` / `getModel` / `getProvider` / `has` /
   `createModel(streamFn)` / `Model.compat` 或三个扁平字段（二选一）/ `BuiltinUI.setModel|setThinkingLevels|setUsage` /
   未被引用的 mock 工厂。
6. **补护栏**：`registerModel` 与 `registerProvider` 对称的 `assertActive`；`provider.stream` 校验 providerId 一致；
   `setContextWindow` 复用 `setUsage`（或补 `segments`）。

## 与 Pi 的对照（仅列实际读到的事实）

- `packages/ai/src/types.ts:830-857`：`Model` 是纯数据（`id/name/api/provider: ProviderId/baseUrl/reasoning/
  thinkingLevelMap/input/cost/contextWindow/maxTokens/samplingParams/headers/compat`），**没有 stream**。
- `packages/ai/src/providers/anthropic.ts:42-59`：`createProvider({ id, name, baseUrl, auth, models: Object.values(ANTHROPIC_MODELS), api })`
  ——端点、凭据、传输、模型目录都在 Provider；Model 通过 `provider: ProviderId` 反向引用，是字符串而不是对象实例。
- 结论：Uina 这版「Provider 持有 stream(model, …)」与 Pi 一致；「Model 上再挂 stream + 运行时塞一个 provider 对象」
  是 Uina 自己的选择，也是 P1-1/P1-8 的根因。若保留 `Model.stream`（现有大量测试夹具依赖它），
  至少应把 provider 引用做成声明字段而不是隐藏属性。

## 工作树归属

- 本审查**未修改任何已被 git 跟踪的文件**；未改 `E:/Uina/ThirdParty/pi`；未触碰真实 provider 配置与会话。
- 新增本文件（未跟踪）：`docs/history/reviews/2026-09-12-model-provider-decoupling-review.md`。
- 审查期间临时创建的探针脚本已删除，工作树中除本文件外与审查前一致
  （`M` 41 个已跟踪文件 + `?? .workbuddy/` + `?? tests/model-provider-decoupling.test.ts`）。

