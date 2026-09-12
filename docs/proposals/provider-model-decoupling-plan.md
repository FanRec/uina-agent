# 重构计划：解耦 Provider（通信凭据端点）与 Model（模型元数据与规格）

- 状态：**基线变更后重写**，待执行
- 基线：`HEAD`（未提交的那份改动已全部舍弃，工作树干净）
- 备份：`C:\Users\34150\WorkBuddy\2026-09-12-00-24-32\backup-uina-wip-20260912-0045\`（含 `working-tree.patch` 与还原说明）
- 基线健康度：`pnpm typecheck` ✅（边界 5 条）、`pnpm test` ✅ 23 文件 / 331 用例
- 依据：`docs/history/reviews/2026-09-12-model-provider-decoupling-review.md`（针对被舍弃改动的审查）、`docs/TODO.md` A06、`README.md:27-52`
- 不做：不碰 `E:/Uina/ThirdParty/pi`、不碰真实配置与会话、不新增权限/轮次/并发/容量上限

## 0. 为什么计划变短了

被舍弃的那份改动里，混了三类互不相关的东西。舍弃之后，计划只剩最后一类：

| 类别 | 在被舍弃改动中的状态 | 在本计划中 |
| --- | --- | --- |
| 5 个 P0 行为回归（`maxContextWindow` 失效、启动期校验丢失、`includeThinking` 协议错位、Gemini 校验被删、`contextWindow` 未知时静默关压缩） | 由该改动**引入** | **不存在，无需修复**。HEAD 本来就是对的（见 §1.2） |
| `models[]` 配置形态 + 迁移脚本 | 由该改动**引入**、无需求支撑 | **不存在，也不要引入**（作为护栏记录在 §4） |
| Provider/Model 解耦本身 | 做了一半，并带来运行时耦合 | **本计划的全部内容** |

## 1. HEAD 的实际形态（代码事实）

### 1.1 缺陷：一个对象同时是三种东西

`src/core/types.ts`（HEAD）只有 `ModelProvider`：`name` + `contextWindow` + `thinkingLevels` + `includeThinking` + `refreshModels` + `stream(req, onDelta, signal)`。

而 `src/ai/providers.ts:8-15` / `src/ai/gateway.ts:createOpenAIProvider` 构造它时，三者被压进同一个对象：

1. **端点与凭据**：`baseUrl`、`apiKey`、`maxRetries`（只存在于闭包里）
2. **模型规格**：`contextWindow = effectiveContextWindow(conf)`、`thinkingLevels`、`includeThinking`
3. **传输**：`stream`

同时 **`.name` 是 model id**（`gateway.ts` 里 `name: conf.model`），而 `ModelRegistry.instances` 又按 **provider 名**索引。身份混用是可观测的：
`src/agent/loop.ts:127` 打印 `provider ${provider.name} 未声明支持 thinking level`，实际输出的是 model id——正是 `docs/TODO.md:77` 记的「Provider 身份与 model id 混用」。

### 1.2 HEAD 已经正确、重构中**不得回退**的行为

| 行为 | HEAD 位置 | 结论 |
| --- | --- | --- |
| `min(modelContextWindow, maxContextWindow)`，缺 `modelContextWindow` 直接抛错 | `config.ts:effectiveContextWindow` | 保留（D1 就是这条） |
| 事实校验发生在 Provider 创建阶段 | `providers.ts:createProvider` 首行调 `assertProviderFacts` | 保留 |
| `includeThinking` 按协议派生 | openai-compatible: `conf.thinkingFormat === "deepseek"`；anthropic/gemini: `Boolean(levels.some(≠off))` | 保留，并在 §3 Phase B 抽成单一函数（D3） |
| Gemini functionCall 的 args 类型校验、同 id 合并、id↔name 冲突检测、`thoughtSignature` 回退、`name/id` 的 `trim()` | `providers.ts` Gemini 分支 | 保留，不得简化 |

### 1.3 HEAD 真正缺的两件事（本计划要做的）

1. **没有 Model 类型**：模型只能通过「再造一个 `ModelProvider`」来表达。`resolve()` 的目录路径（`providers.ts` `ModelRegistry.resolve` 第三支）就是现场复制一份 `baseUrl`/`apiKey`/`modelContextWindow` 再拼一个新对象——**同一端点的每个模型都必须携带一份端点与凭据**。
2. **A06 的两条真实缺口**：
   - 目录覆盖/抹掉显式事实：目录路径里 `modelContextWindow: discovered.contextWindow` 无条件覆盖用户显式配置；`thinkingLevels: discovered.thinkingLevels?.filter(...)` 在目录未报告档位时把显式 `thinkingLevels` 抹成 `undefined`（`docs/TODO.md:78` 的「目录未知不抹掉有效显式事实」）。
   - UI 同步靠内置命令的可选回调：`builtin.ts:138-140` 的 `ui?.setModel?.()` 只有 `/model` 命令会调；目录选择、面板选择、扩展命令等其它入口都不会更新 UI（`docs/TODO.md:77`）。

## 2. 目标与验收（机器可判定）

| # | 验收 | 判定方式 |
| --- | --- | --- |
| V1 | Provider 只持有端点、凭据、传输；模型规格只存在于 Model | `Provider` 类型上没有 `contextWindow`/`thinkingLevels`/`includeThinking`；`Provider.stream(model, req, onDelta, signal)` 签名 |
| V2 | Model 是一等类型，且**不携带端点凭据** | `Model` 上有 `id`/`name`/`providerId`/规格/`compat`；没有 `baseUrl`/`apiKey`；没有运行时塞入的 `provider` 实例属性 |
| V3 | 同一 Provider 下多个 Model 各自规格生效，且**共享同一个 Provider 实例** | 一个 `Provider` 对象连续 `stream(modelA,…)` / `stream(modelB,…)`：wire 上 `model`/`max_tokens`/`thinking` 各按自己的规格；`registry` 中 provider 只有一份 |
| V4 | 目录未知不抹掉显式事实；目录明确不支持不被配置扩张 | `discovered.thinkingLevels === undefined` → 保留显式 `thinkingLevels`；`discovered.thinkingLevels === ["off"]` 且显式 `["off","high"]` → `["off"]`；目录 `contextWindow` 不覆盖显式 `modelContextWindow`（或明确记录谁优先，并有测试） |
| V5 | 身份不再混用 | 报错与事件里的 provider 标识是 provider id，模型标识是 model id/name，二者可分辨 |
| V6 | 任意受支持的模型切换入口都更新 UI；未知保持未知 | 切换走 HostEvent → UI（TUI 与非 TUI 各自消费）；档位未知时不伪造 |
| V7 | 「一个端点 + 一个模型」的 `auth.json` 原样可用，无需迁移 | 用现有配置跑 `pnpm start` / 冒烟测试 |
| V8 | `pnpm typecheck`（含 5 条边界规则）与 `pnpm test` 全绿 | 命令 |

## 3. 阶段计划

每阶段结束跑 `pnpm typecheck && pnpm test`，单独提交。

### Phase A — 引入 Provider 与 Model 两个类型（保留 HEAD 的解析结构）

| 步 | 改动 | 验收 |
| --- | --- | --- |
| A1 | `core/types.ts`：新增 `Provider`（`id`、`type?`、`baseUrl?`、`refreshModels?`、`stream(model, req, onDelta, signal)`）与 `Model`（`id`、`name`、`providerId`、`contextWindow`（已含有效上限）、`maxContextWindow?`、`maxOutputTokens?`、`thinkingLevels?`、`includeThinking?`、`thinkingBudgets?`、`compat?`、`stream`）；删除 `ModelProvider` | V1、V2 |
| A2 | `ai/providers.ts`：`createProvider(name, conf)` → `createEndpointProvider(id, conf)`（只带端点/凭据/传输）+ `createModel(id, conf, providerId)`（只带规格）；两者沿用 HEAD 的 `effectiveContextWindow` 与 `assertProviderFacts` 调用点 | V1、V7 |
| A3 | `ModelRegistry`：保留 HEAD 的三条解析路径**结构不变**（注册实例 → 配置 → `providerId/modelId` 目录），但 `resolve()` 返回 `Model`，内部保存 `providers: Map<id, Provider>` 与 `models: Map<providerId/modelId, Model>`；不再为每个模型复制端点对象 | V3、V7 |
| A4 | 接缝改名：`Subject`、`AgentFactory`、`SubagentRegistry`、`compactHistory` 的 `provider` → `model`；`Subject` 内部调用 `Model.stream`（保留既有接缝，不引入 provider 二参传递） | 测试全绿 |

### Phase B — 修 A06 的两条真实缺口

| 步 | 改动 | 验收 |
| --- | --- | --- |
| B1 | 目录不覆盖/不抹掉显式事实：把「目录值 vs 显式配置」的合并抽成一个纯函数并明确优先级（建议：显式配置优先，目录只补空缺；目录明确不支持时取交集），`resolve()` 的目录路径改用它 | V4 |
| B2 | `includeThinking` 抽成 `protocolCarriesThinking(kind, thinkingFormat)`，openai/anthropic/gemini 三个适配器共用一个来源；`conf.includeThinking` 仍可显式覆盖 | V4、不得回退 §1.2 |
| B3 | UI 同步改为事件驱动：`HostEvent` 增加 `model_select`（带 `thinkingLevels`/`contextWindow`）与 `thinking_level_select`；TUI 与 stdio 各自消费；删除 builtin 里 `selectModel` 的可选 UI 回调更新（`ui?.setModel?` 等），避免同一状态两个写者 | V6 |
| B4 | 未注册 provider 的模型、未知档位、未知上限：保持未知并让错误可见，不伪造默认值（`Subject.getProvider()` 之类只为测试存在的取用口不新增） | V6、V5 |

### Phase C — 测试与文档

1. 现有 331 个用例中以 `{name, contextWindow, stream}` 构造 `ModelProvider` 的夹具改为 `Model`（约 15 个文件，机械替换）。被舍弃那份改动里的 `tests/helpers/mock-provider.ts` 三工厂方案可以借鉴，但只保留真正被引用的（`scriptedProvider` 一个入口）。
2. 新增契约测试（目标 ≤150 行，按 V1–V6 各一条，避免与 `providers.test.ts` 已有协议用例重复）：
   - 同一 Provider 连续服务两个不同 Model，wire 上 `model`/`max_tokens`/`thinking` 各按自己的规格（V3）
   - 目录未知 / 目录明确不支持 / 目录 contextWindow 与显式配置冲突 三态（V4）
   - `model_select` / `thinking_level_select` 事件驱动 UI 更新（V6）
   - Provider 与 Model 的类型边界：`Provider` 无规格字段、`Model` 无凭据字段（V1/V2 可用类型级断言或运行时 key 检查）
3. 文档：`docs/extensions-development.md` 的 Provider 段落改为 `Provider` + `Model` 双类型与 `stream(model, …)`；`docs/current-runtime.md` 补 HostEvent 与 `(Model, Provider)` 流；README 的 `auth.json` 示例**保持不变**（形态不动）。

## 4. 方案取舍

| 议题 | 采用 | 否决 | 理由 |
| --- | --- | --- | --- |
| Model 是否持有可调用 `stream` | 保留（由 Registry 单点绑定） | Pi 式「Model 纯数据 + provider 必传」 | 后者要求 `Subject`/`AgentFactory`/`SubagentRegistry`/`compactHistory` 全改二元组并重写全部夹具；Pi 的 `Model` 无 stream 是因为它把传输放在 provider 的 `api` 上（`packages/ai/src/types.ts:830-857`、`providers/anthropic.ts:42-59`），而 Uina 的既有接缝是「一个可调用的 model」，改动面大而收益只是形式对齐 |
| `providerId` 的表达 | 纯字符串标签（`readonly providerId: string`） | 在 Model 上挂 `provider` 对象实例 | 对象实例会重新引入自引用、`as any`、两处写者；字符串标签 + `stream` 闭包已足够表达绑定 |
| 解析路径 | **保留 HEAD 的三条路径**（实例 → 配置 → 目录），只是返回值从 provider 变 model | 重写为多键索引 + 4 条路径 | HEAD 的解析本来就没有同名合并与伪造分支；重构不该顺手扩大它 |
| `auth.json` 形态 | **保持现状**（一个 provider 条目 = 一个端点 + 一个默认模型），领域类型分离 | 引入 `models: ModelConfig[]` 数组 | `models[]` 由被舍弃的改动引入，HEAD 无此字段、需求文档（A06）也没要求；它会把校验、索引、迁移三处复杂度一起带进来。**本次审查已确认它无需求支撑，作为护栏保留此结论** |
| 同一端点多个显式模型 | 通过目录发现（`refreshModels`）表达 | 配置里声明模型数组 | 真正的目录缺口（如 DeepSeek `/models` 不给 `contextWindow`）属 B02 范畴；HEAD 的替代是再写一个 provider 条目共享 `baseUrl`/`apiKey`，0 新代码 |
| 5 个 P0 的修复 | 不需要 | 在 HEAD 上重做一遍 | HEAD 行为本来就正确（§1.2），它们是被舍弃改动引入的 |

## 5. 行数账（基于 HEAD 实测）

| 口径 | HEAD | 本计划目标 | 说明 |
| --- | --- | --- | --- |
| `src/core/types.ts` | 184 | ~235 | 新增 `Provider` + `Model` 两个类型，删除 `ModelProvider` |
| `src/ai/providers.ts` | 638 | ~700 | 拆成 `createEndpointProvider` + `createModel` + 两表 registry；`resolve` 结构保留 |
| `src/ai/config.ts` | 228 | ~245 | 只有归一化与 `ModelConfig` 拆分 |
| `src/` 合计 | 20508 | **~20750（+1.2%）** | A06 两条缺口修复 + 身份分离 |
| `tests/` | 8873 | ~9050（+2%） | 夹具改名 + 约 150 行契约测试 |

对照被舍弃的那份改动：`src/` 净 +507（+2.5%）、新增测试文件 648 行、未跟踪新文件合计 +1358。
本计划规模约为它的 **1/3**，且不含任何需要迁移的配置变更。

收益仍是结构性的，与行数无关：

| 指标 | HEAD | 目标 |
| --- | --- | --- |
| 同一对象承担的身份数（端点/规格/传输） | 3 | 1（Provider 端点+传输，Model 规格） |
| 表达「同一端点第 N 个模型」的代价 | 复制一份端点与凭据 | 新增一个 Model 记录 |
| 会被目录覆盖或抹掉的显式配置项 | 2（`modelContextWindow`、`thinkingLevels`） | 0 |
| 会更新 UI 的模型切换入口 | 1（仅 `/model` 命令） | 全部（事件驱动） |

## 6. 决策记录

- **D1（沿用 HEAD）**：配置模型必须显式声明 `modelContextWindow`，缺失即创建阶段报错；有效上限 = `min(modelContextWindow, maxContextWindow)`。HEAD 已如此，**保留**。
- **D2 / D4（作废并转为护栏）**：不引入 `models[]`、不需要迁移。被舍弃改动引入的该形态无需求支撑（`git show HEAD:src/ai/config.ts` 无 `models` 字段；消费者只有它自己；A06 验收针对目录而非配置数组）。
- **D3（沿用 HEAD 并抽函数）**：`includeThinking` 由协议派生（anthropic/gemini 携带 thinking、openai-compatible 仅 `thinkingFormat === "deepseek"`），`conf.includeThinking` 可显式覆盖。HEAD 的规则就是如此，本计划只把它抽成单一函数以避免同一事实两处维护。
- **D5（需要确认）**：目录值与显式配置冲突时的优先级。建议「显式配置优先，目录只补空缺」（符合 A06「目录未知不抹掉显式事实」），但 `contextWindow` 是唯一可能「目录比用户更准」的字段——若你希望目录胜出，我在 B1 里按「目录胜出但必须可见（写入日志/事件）」实现。

## 7. 风险与未验证项

- `Subject` 内部改为调用 `Model.stream` 后，扩展注册的 Provider（`registerProvider`）与 Model（是否新增 `registerModel`）的 teardown 语义需要一并明确；本计划建议**先只保留 `registerProvider`**（扩展注册端点即可，模型由配置或目录产生），避免为一个未验证的需求新增第二个注册接缝。
- `docs/current-runtime.md` 与 `docs/extensions-development.md` 描述的是被舍弃改动的形态，Phase C 需要按新形态改写。
- `pnpm dev:baseline`、`pnpm verify:file-events` 需要真实凭据，不作为验收项。
- 未验证：真实 Provider（Anthropic/Gemini/DeepSeek）上的多模型切换行为，只能靠 mock 与冒烟测试覆盖。

## 8. 验证命令与工作树纪律

```text
pnpm typecheck                 # 含 5 条边界规则
pnpm test                      # 当前基线：23 文件 / 331 用例
npx tsx <repo 内临时脚本>       # 一次性探针，验证后立即删除
```

纪律：不修改已跟踪文件的无关内容；临时探针不留工作树；每个 Phase 单独提交；需要那份被舍弃的实现时从
`backup-uina-wip-20260912-0045/working-tree.patch` 取，而不是重新解释一遍需求。
