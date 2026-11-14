# Uina 信息、资源、事件与交互体系收口重构设计（审查修订 v2.1）

> **状态：实施规格，二次审查修订 / 2026-11-14**  
> **源码基线：**[`FanRec/uina-agent@ba74c9631c2085416897398bf815c8be7514b37d`](https://github.com/FanRec/uina-agent/tree/ba74c9631c2085416897398bf815c8be7514b37d)。实施前检查最新 HEAD：已实现的等价能力直接复用；有差异以现行代码为准调整路径，不能回退成熟实现。  
> **交付定位：**在现有 Subject / ExtensionRunner / Context Registry / Composer / Session / Tool Broker / Presentation 上完成一次收口；同时加入**可重新加载的主体 System、资源刷新和 Agent 自用 Reload**。不重建 Harness、World Framework、TTS Bridge 或通用插件平台。

## 1. 目标、定案与边界

本次完成后，初奈应当能够：

1. 把包括操作者在内的真人、其他参与者和世界事件视为**主体之外的真实来源**，不因操作者地位就把发言变成更高层协议指令；模型协议包装与领域身份分离。
2. 通过明确的 MCP Server 用途发现未知能力，按需连接、查具体工具；无持续注入全量 Server 目录。
3. 以稳定 System / Guidance、按需 Skill 和真正影响判断的 Observation 组成单一模型请求；在 `/prompt`、`/context` 准确检查实际提供给模型的信息。
4. 编辑自己的 `system.md`、扩展 Guidance 或 Skills 后，调用 `runtime_reload(scope="resources")`，**当前调用结算后的下一次模型请求**即使用完整的新资源版本，而不重启扩展、不清空会话。
5. 修改项目扩展代码后，调用 `runtime_reload(scope="extensions")` 安排安全换代；明确区分“已安排”与“已完成”，获得最终结果，再继续工作。
6. 在 TUI/远端看见真实发言、行动和事件；输入区优先展示排队消息与当前活动；Live、Replay、Rewind、远端续流保持同一语义。

**本次明确决策：**

| 事项 | 决定 |
| --- | --- |
| 操作者输入 | 保留外部来源与 Event Frame 语义；不因为是操作者而强制转换成原生 User。 |
| 独立 Persona Prompt | 删除 `persona.md` 运行时层；主体身份与行为指导并入唯一可编辑 `system.md`。`profile.json` 的身份和资源绑定继续存在。 |
| System 文件 | 从 `DEFAULT_SYSTEM_PROMPT` 抽离成 Markdown；提供内置默认、工作区、主体 Profile 和 Host 显式覆盖。 |
| Runtime Protocol | 与协议实现绑定；仍由代码保证强制不变量，不允许修改 System 文件绕过 Event Frame 等协议约束。 |
| Reload Tool | 名称 `runtime_reload`，`scope: resources \| extensions` 必填；返回 `applied` / `scheduled` 是**业务阶段**，不是新 ToolResult.status。 |
| MCP 配置 | 用 `mcpServers.<name>.description`，迁移并删掉 `uina.mcpPurposes`；描述不进入执行配置指纹。 |
| MCP 发现 | `mcp.search` 同时搜索配置级 Server 描述与已缓存工具，搜索不启动 Server。 |
| Context Source | 只保留 Guidance / Observation；去掉旧 `kind="capability"` 注入种类，不影响领域 capability 定义。 |
| Cue 合法 ID | **完全归各扩展的 Guidance**；不设计独立 Cue Catalog、Context 注入或通用枚举。Runtime 只负责解析、路由与执行结果。 |

**不做：**自动文件监视、任意配置热替换、全量 Prompt Journal、通用 Tool Search 框架、独立记忆/Skill 执行引擎、维护 Agent、新的事件总线、通用 World 状态面板、完整重写 TUI/声音/Minecraft 引擎。`resources` 不重新加载 Core、Provider 连接/凭据、世界定义或服务进程；`extensions` 仅替换现有项目扩展集，**不会重载内置 World Framework，也不会替代进程重启**。

**交付切分：**S1–S4（System/Reload/Context/MCP）先作为一个可独立验收的运行时改动完成；S5（Presentation/TUI/Sync）基于稳定的事实出口单独实施。二者属于同一目标设计，但**不得要求大规模 TUI 换代成功后才允许发布已验证的 Reload**。Feed 重构也不得反向要求 Core 增加第二套事件事实。

## 2. 真实所有权与系统结构

| 实体 | 权威事实与所有者 | 对模型的投影 |
| --- | --- | --- |
| Actor / Input | 可信接入层确定来源/权限；Subject/Session 负责受理与提交 | 外部 Event Frame 或运行时内部输入 |
| Event | 世界/服务生产真实变化；Runtime 负责传递 | 有必要决策时成为 Input；不等同当前状态 |
| Domain State | Minecraft / Speech / MCP 等领域服务拥有 | 领域查询，必要时 Observation |
| System | Host 管理的当前已发布主体基础指令 | `role=system` 主体段 |
| Runtime Protocol | Projection/Runtime 协议实现拥有 | 与所启用协议匹配的系统说明 |
| Guidance | 扩展拥有方法/操作说明；Context Registry 注册 | System 后稳定 User 前缀，不是操作者消息 |
| Skill | 官方 Skill Runtime 拥有目录、正文、资源与快照 | Catalog Guidance + `read_skill` 按需读取 |
| Observation | 扩展按次提供的事实/证据 | History 后只读参考；不进入 Canonical History |
| Tool/Operation | Broker 持有工具调用结果；领域持有异步任务结果 | Tool Result；领域进度另有独立身份 |
| Request Evidence | Subject 的某次实际准备请求 | Inspector 只读；不伪装成历史或外部事件 |
| Feed Entry | Presentation 从事实生成的人类可视投影 | Message / Operation / Event |

目标请求路径：

```text
Canonical History / Session → Event Frame 协议投影 → History View（Compaction）─┐
                                                                              │
已发布 System 快照 ── Runtime Protocol（与启用的 Projection 对齐）─────────────┤
已注册 Guidance（固定前缀）────────────────────────────────────────────────────┤
请求时 Observation ──────────────────────────────────────────────────────────┤→ Request Composer
Tool Broker.defs + 协议工具声明 ───────────────────────────────────────────────┘       ↓
                                                                       Preflight / Budget
                                                                              ↓
                                                                         Provider + Evidence

源文件 ── 编译候选（System/Guidance/Skills）── 原子发布 Resource Revision ── 下一次请求
项目扩展文件 ── Reload Intent ── 回合安全点 ── ExtensionRunner.reload ── 资源刷新

Runtime Events ── Live Ingest ─┐
Session Journal ─ Replay Ingest┴─ Presentation（唯一归并）─ Feed / Activity ─ TUI / Gateway
                                                Host Queue + Request Evidence ─ Dock / Inspector
```

**不变量：**历史记录真实发生的事；System/Guidance 是当前装配的指导；Observation 是某次请求看到的证据。文件内容更新不能回写历史，也不能把“模型被提供了新提示词”等同于“模型已理解或行为已改变”。

## 3. System 文件化、Profile 收口与协议边界

### 3.1 唯一的主体基础提示词

将 `src/agent/context.ts` 的 `DEFAULT_SYSTEM_PROMPT` **逐字内容**迁移为仓内默认资源 `src/agent/prompts/system.md`，保留 `defaultSystemPrompt()` 的兼容读取接口供内嵌/测试消费，但运行内容的权威来源变为文件。构建产物必须复制至对应 `dist/src/agent/prompts/system.md`；`pnpm start` 与 `pnpm start:dist` 必须从一致的默认文本启动，不能依赖开发机当前工作目录。

内置默认文件是**发布包随附的后备资源**：运行已构建的 `dist` 时读取 `dist` 中的副本；仅修改源码默认文件而未重新构建，不会改变正在运行的 `dist`。需要在现有进程中自行编辑并 Reload，应使用工作区 `.uina/system.md` 或 Profile `system.md`；源文件的永久默认修改随正常构建发布。

配置选择规则（**单文件覆盖，不隐式叠加多个 System 文件**）：

1. `UinaHostOptions.systemPrompt` 显式文本（嵌入方完整覆盖主体 System；资源刷新不覆盖这个值）。
2. 启用 Profile 且 `profiles/<subjectId>/system.md` 存在：使用该文件。
3. 工作区 `.uina/system.md` 存在：使用该文件。
4. 内置 `src/agent/prompts/system.md`：默认值。

上一级文件不存在则继续向下选择；**已存在却不可读、非法 UTF-8 或编译为空应报错，不静默退到下一级**。Reload 期间遇到错误保留旧已发布版本，启动时则直接报告配置错误。显式 Host 文本仍参与版本计算，但文件修改不覆盖该文本。

重用现有 `compilePromptFile(entry, root)` 的 Markdown/UTF-8、`{{include:...}}`、循环/越界/大小限制与来源哈希；System 文件使用**自身所选目录**作为资源根，引用只能在该目录内，不扩充新模板语言。默认内置文件的资源根固定为它所在的打包目录。

### 3.2 删除 Persona 层，但保留 Profile 的业务身份

移除 `SubjectProfile.personaText`、`resolveProfile()` 读取 `persona.md` 和 Host 拼接 Persona 的路径。Profile 仍保留 `subjectId`、`displayName`、排他锁、memory/state/session/skills 资源根和模型设置；资源刷新**绝不再次调用 `resolveProfile()` 抢锁**，而是通过现有 Profile 根读取所选 System 文件。

旧 Profile 的有效 Persona 不可静默丢失。提供**一次性的显式迁移命令/脚本**，不在正常启动或每次 Reload 中自动创建、修改文件：若只有 `persona.md`，使用**迁移时的现行主体 System 正文**加旧 Persona 生成 `system.md`（不复制 Event Frame 协议段）；若已有 `system.md`，报告需要手工合并，绝不覆盖。原 `persona.md` 保留备份，但新运行时不再读取。迁移出的完整 System 是该主体**主动选择的独立覆盖版本**，以后内置默认 System 更新不会暗中覆盖它；在迁移说明中明确这一代价。旧 Persona 非空而新文件尚未迁移时，首次启动应报可操作的迁移提示而非静默丢弃。

### 3.3 Runtime Protocol 不做成另一个 Persona

当前 `EVENT_FRAME_PROMPT` 属于 Event Frame 协议，而非主体人格。**保留其代码/协议归属**；默认投影启用时，Host 将其与所选主体 System 组合成最终 `role=system` 正文。若嵌入方显式提供不同 Projection Policy，不自动附加 Event Frame 专属说明。`options.systemPrompt` 只覆盖**主体段**，不能无意删除默认 Event Frame 协议说明；相应的 Host 组合测试必须更新。为避免两个默认 Prompt 所有者，调整现有 `createEventFrameProfile()`：它只交付投影策略与协议指导，不再自行调用 `defaultSystemPrompt()` 拼完整主体 System；完整正文只在 Host 的同一装配入口形成。`Subject` 独立创建时的 `defaultSystemPrompt()` 兼容回退保留。

核心协议的约束（保留名不可执行、合成帧配对、权限/可信来源、ToolResult 五态等）继续由运行时代码执行，不能因 `system.md` 写了相反的话而解除。可编辑 System 是行为指导，不是修改执行权限的入口。`runtime_reload` 只读取资源，不授予额外文件写入或管理权限；主体修改资源仍须使用现有有权限的文件工具，外部 Actor 的正文不能直接改变 Host 的信任身份。

### 3.4 System 版本与历史

Host 保存当前不可变 `SystemSnapshot { text, sources, revision }`；其中 revision 为最终编译正文的内容哈希，供 `/prompt`、`/context` 显示和无变化判断。不建设版本库。Subject 持有可更新的当前 System 快照，并在**每次请求开始准备时固定该版本**；已经构建或发往 Provider 的请求不可原地改写。Context Snapshot / Request Evidence 携带实际本次版本标识；`/prompt` 区分当前已发布和最近一次准备请求。System、Guidance 改动不写入 Canonical User 消息，也不回写过去的 Tool/外部事件。

## 4. Resources Reload：不重启扩展地更新提示词与知识

### 4.1 `resources` 的确切范围

包括：**当前主体 System 文件（或 Host 覆盖）、通过文件式 `provideContext({file})` 注册的现役 Guidance、Skills 的发现/正文快照与 Catalog**。内联 Guidance 与扩展自身的工具/服务/Hook/Output Tag 定义不在本次范围，它们需要扩展换代。Observation 下一请求仍按现行 `read()` 获取，不在 Reload 时做缓存，也不把当前状态误认成静态资源。MCP 配置继续在 Proxy 操作时按次解析，改描述不要求 `resources`；Provider 连接/密钥、World 源码与正在运行的服务不在范围。

**现状例外必须说明而不能假装支持：**Minecraft 的 `.uina/worlds/minecraft/worlddef/ENV_PROMPT.md` 目前在 World 激活时用 `readFile()` 读取，再作为**内联** Guidance 注册。尽管它来自 `.md` 文件，现有 `resources` 合同仍**不能**刷新它；`extensions` 也不重新载入内置 World Framework。当前阶段修改该文件须重启承载 World 的进程才能生效。若将来希望支持 World Guidance 热更新，应在统一扩展运行时迁移该生产者为真正的文件式注册，而不是让 Resource Reload 猜测任意 `readFile()` 的依赖。

### 4.2 准备—发布—响应合同

```text
resources 请求
    ├─ 读取并编译当前选中的 system.md（或保留 Host 显式文本）
    ├─ 重编译全部现役文件式 Guidance（原有 owner/id/root/entry）
    └─ 重新发现并读取 Skill 快照与 Catalog
           ↓
    所有必需资源均成功编译/读取？
           ├─ 否 → 现行资源完全不变，ToolResult failed + 源路径/原因
           └─ 是 → 在一个发布边界替换 System、Guidance、Skill Catalog/读者快照
                     → 变更 revision
                     → ToolResult succeeded / phase=applied
                     → 下一次请求必然采用新版本
```

这里的“原子”是**对下一次模型请求可见的资源集合一致**，不是跨磁盘文件系统的事务。准备阶段可以异步；发布阶段不得跨 `await` 暴露半更新的 Registry/ToolSet。若发布阶段验证失败应保留旧版本，不留下新 Guidance 搭旧 Skill Reader 的状态。

**Skill 发现沿用现有宽容合同：**`loadSnapshot()` 会跳过单个无效 Skill，并把错误/同名遮蔽作为 `diagnostics` 返回；这不是整个资源装配的致命失败。Resource Reload 应发布**同一次发现所得到的有效 Skill 集 + 对应诊断**，并在返回结果中标明跳过项。只有目录读取/运行时装配等导致无法形成可信候选快照的致命错误才整体拒绝发布。不得为了资源事务把单个坏 `SKILL.md` 改成全局不可用，也不得返回 `applied` 却隐瞒哪些 Skill 未进入目录。

**最小源码接缝：**

- `ExtensionRunner.registerFileGuidance()` 当前编译一次后只留下注销句柄；为现役文件式注册项保存 `(owner, id, entry, resourceRoot, registration)`，允许在**原注册身份**下替换文本与编译来源元数据。Context Registry 可提供小范围 `replace` / `replaceMany` 操作：保留 Scope、key 和旧注销句柄的有效性；不建第二套注册表。被卸载的 Scope 不参与刷新。
- Skills 现有 `refresh()` 已有“加载候选、再发布”基础；将准备与提交分开，供 Resource Reload 在同一次发布边界更新 Catalog、`read_skill` 可见性和读取快照。无 Skill 的结果要正确撤下 Tool 与 Catalog。
- Host 负责选中 System、组织候选、发布版本；Subject 负责按请求固定版本，Composer 仍是 Guidance/Observation 唯一排版者。不新增泛化的 `ConfigManager` 或任意 Source 重新加载接口。
- 对 `prepareProjection()` 在异步 `yieldToLoop()` / Context `read()` 前后可能遇到资源版本变化的问题，增加**请求级版本一致性检查**：若装配期间版本已换，放弃该次候选并从 Canonical History 重新装配；Provider 发送前必须确认 System、工具声明、Guidance/Skill 归属于同一已发布资源版本。持续并发修改时明确失败或有限重试，不能发送混版请求。Inspector Preview 适用同一纪律。

文件更改**不自动生效**。连续 Reload 且资源内容未变化，仍应成功返回，但不产生虚假的版本推进或多次 Tool/Context 注册。允许 Provider 前缀缓存因真实内容改变而自然失效，不实现手动缓存清除或补写历史。

## 5. 原生 `runtime_reload` 工具与 `/reload`

### 5.1 最终模型工具定义（逐字保留简洁性）

工具注册在**内置 runtime-tools**，不属于可被 `extensions` Reload 卸载的项目扩展；名称使用跨 Provider 兼容的下划线，不用带句点的 `runtime.reload`。

```json
{
  "type": "function",
  "function": {
    "name": "runtime_reload",
    "description": "重新加载本地资源或项目扩展，使文件修改生效。不会重启 Uina 或清空会话。",
    "parameters": {
      "type": "object",
      "properties": {
        "scope": {
          "type": "string",
          "enum": ["resources", "extensions"],
          "description": "resources：刷新 System、文件式 Guidance 和 Skills，下次推理生效。extensions：本轮结束后重载项目扩展及资源，可能中断连接。"
        }
      },
      "required": ["scope"],
      "additionalProperties": false
    }
  }
}
```

不加 `force`、`reason`、`target`、`dryRun` 或目标文件参数；Tool 不编辑文件。`executionMode: 'sequential'`，确保同一 Tool Batch 内文件修改与 Reload 不发生并行执行竞争；模型仍需按调用次序先编辑、后 Reload。

### 5.2 结果与 Continuation

保留现有 `ToolExecutionResult.status` 的五态；`applied/scheduled` 放在 `details.phase` 与精简 `result` 正文中，**不添加第六种工具状态**。

| 场景 | ToolResult.status | `details.phase` | 对模型的事实 |
| --- | --- | --- | --- |
| `resources` 已完整发布 | `succeeded` | `applied` | 该调用后的下一次请求使用新资源；可附 System/Guidance/Skills 版本摘要、`unchanged`。 |
| `resources` 读取/编译/发布失败 | `failed` | `unchanged` | 旧版本仍在使用；精确说明失败来源。 |
| `extensions` 已受理 | `succeeded` | `scheduled` | **尚未生效**；提供 `reloadId`，随后另行报告最终结果。 |
| `extensions` 无法安排（关闭/已有不兼容操作） | `not_started` 或 `failed`（按既有合同） | `rejected` | 不得声称已排程。 |

`resources` 工具执行须等待发布完成才返回，之后正常继续本轮模型调用（不设置 `continuation=stop`）。`extensions` 成功安排时返回 `continuation:'stop'`，使 Tool Result 先以正常配对写入 Canonical History，随后结束当前决策回合；不允许在 Tool.run 里 `await pi.reload()` 或 `await subject.waitForIdle()`，否则会等待自己结束。工具回执的 `scheduled` 永不被渲染为完成。**注意：**同一 Provider 响应中的其他工具调用仍依 Tool Broker 的现有批次合同结算，`stop` 并不撤销已返回的其他调用；在全部 Tool Result 写入历史后才进入 Reload 安全点。

### 5.3 `extensions` 的安全点和队列屏障

现行 `Subject.finishTurn()` 在 `afterEnd` 后自动 `resumeQueued()`，而 Host 的 `reloadExtensions()` 只在 Idle 时执行。仅把请求挂到 `waitForIdle().then(runReload)` **不够**：如果队列持续自动续跑，换代可能延迟或发生在后续回合之后。

设计一个**只在已受理扩展重载时启用**的 Host→Subject 暂停续队接缝，不新增通用 Workflow/Scheduler：

```text
Model 调用 runtime_reload(extensions)
  → 持久化正常 Tool Call / Tool Result（phase=scheduled, reloadId）
  → continuation=stop，正常结算当前工具批次与本回合全部 Hook/事件
  → Subject 到达回合尾：暂停自动 resumeQueued，保留原队列及其身份
  → 当前 activeRun 正常结算、真正 Idle
  → Host 在输入准入门内执行 ExtensionRunner.reload()
  → 刷新 System / 文件式 Guidance / Skills（按新激活集合）
  → 发布新资源版本与重载完成/失败事实
  → 解除准入门，恢复原队列处理
```

实现上，Host 持有唯一 `pendingExtensionsReload`；**在受理 Reload Intent 时就设置续队屏障和后续输入的换代准入门**，而不是等到 Idle 后才设置，以免回合尾与新输入抢跑。Subject 复用现有 `turn.afterEnd` 安全点，在“回合已结算、自动续队之前”查询这一条件并跳过自动续队；该 Hook 不得直接等待 Reload，不能在仍持有 `activeRun` 时调用会等待 Idle 的旧入口。释放 `activeRun` 后 Host 使用现有 `runReload` 主路径。外部输入在换代门期间按现有可见错误/拒绝规则处理，不能静默丢弃；原本排队的输入不消费、不重排、不撤回。**须验证成功回合、失败回合和中断回合三条收尾路径，以及没有进入正常 Turn 的直接工具调用路径；非 Turn 发起的重载不得凭空等一个永远不会出现的 `afterEnd`。**

- 同一 Host 并发重复 `extensions` 请求只合并成一个待执行 Reload（返回同一 `reloadId` 或明确“已安排”），避免连续销毁/重建。Host 人工 `/reload` 与模型工具共用该协调器。
- 进入安全点前若回合失败或被中断，已持久化的 `scheduled` 不能无声消失：协调器仍处理该已受理意图，或写入明确的取消/拒绝终态。进程被直接杀死不承诺重启后的自动重放。
- Pre-import 失败沿用 Runner 现有“旧扩展不卸载”逻辑；激活阶段的单扩展失败可能产生**部分成功**，完成回执应列出当前有效扩展/失败项，不能声称全量应用。**扩展换代不承诺全量事务回滚**：如果项目代码已经部分激活而后续资源刷新失败，要报告“扩展有效集已改变、System/Skills/Guidance 各自实际状态”，并在输入门内完成一致的可用集校准；不能宣称“旧版本全部保留”，也不能把已注销旧 Scope 的 Guidance 当成仍有效。纯 `resources` 刷新仍必须全有或全无。
- **最终事实交付：**以稳定 `reloadId` 生成一次内部 `runtime` 来源 Input（而非外部操作者/Event Frame），报告 `completed / partial / failed`、实际生效资源与故障摘要；沿既有 Input Delivery 唤醒初奈。**源代码 Reload 只承诺本进程内的最终通知**：若进程在 `scheduled` 后崩溃，下次启动不能把旧 `scheduled` 当 `completed`，但本次不新增跨进程 Reload 恢复队列。**注意当前 Host 在 `state.reloading` 时拒绝普通输入：**完成报告由 Host 的内部可信路径写入现有队列，先存好回执/身份、保持暂停自动续队，随后解除准入门并恢复队列；不得经会被自身 Reload 门拒绝的扩展 `pi.submitInput()` 路径。必要时只给现有 Subject 队列增加一个“入队但暂不自动启动”的内部接缝，不新建队列。Completion 应保证在下一次模型决策前可见；若有原队列输入，则与其按原有来源/优先级语义合帧或先行送达，不丢、不重排已有输入。Presentation 同时更新相应 Operation/Event。

**人工命令：** `/reload` 保留项目扩展换代，并包含资源刷新；`/reload resources` 只走轻量刷新。人工命令与 Agent Tool 共用 Host 合同，UI 提示阶段必须与真实结果一致。`pi.reload()` 可作为现有扩展侧 API 留存并转接 Host 协调器，**不能**作为模型工具内部同步调用入口。

## 6. MCP 描述、发现与配置实时性

### 6.1 唯一描述位置

采用成熟的每 Server 元数据形式：

```json
{
  "mcpServers": {
    "screen": {
      "description": "观察桌面屏幕、应用窗口及其可见内容",
      "command": "python",
      "args": ["-m", "uina_screen_mcp"]
    },
    "tavily": {
      "description": "搜索互联网、读取网页并核验近期事实",
      "url": "https://example.test/mcp"
    }
  }
}
```

- `description?: string` 由当前配置文件作者提供，**属于发现元数据而非 MCP Wire Protocol 的必需字段**。配置校验支持非空字符串；按 Server 整体原子覆盖规则生效。项目配置覆盖同名全局 Server 时，不隐式继承全局 Server 的 Description。
- `definitionFingerprint`、项目信任记录与连接失效只使用现有**执行/连接字段**，不使用 description。单纯改描述不得触发重新授权、断开连接或工具目录过期；定义真正变化仍照旧重新判定。
- 迁移 `uina.mcpPurposes`：过渡期仅在 Server 本身没有 description 时读取旧映射，且只限原有全局配置作用域；二者都有时以 Server 内字段为准。迁移与测试完成后删除 `mcpPurposes` 解析、注入、旧文档和测试，不永久保留两套事实。

### 6.2 两级发现，一条 Proxy

保留现有 `mcp` 代理工具及 `list/search/describe/call/status`：

| 调用 | 必需行为 |
| --- | --- |
| `list()` | 本地列出已配置 Server 名称、简述、信任/目录状态；零连接、零工具调用。 |
| `search(query)` | 检索配置名称+description，以及缓存中已发现的工具名/title/description；返回 Server 候选和 Tool 候选。**不启动服务**。 |
| `list(server)` | 按需信任检查、连接、`tools/list`，刷新权威 Catalog。 |
| `describe(tool)` | 返回特定工具的定义及 stale 提示；不凭猜测调用。 |
| `call(tool,args)` | 沿既有精确路由、目录校准、权限与结果五态执行。 |

未信任的项目 Server 在显式 `list/search/status` 中可显示**非敏感的候选名、用途和 blocked 状态**，但不能因为被搜索到就获得执行许可；Description 视作低信任数据，不进入高信任 Guidance 或 System。配置已移除的旧 Catalog 项不参与发现；配置变更和 Server 工具变更的 stale 校准逻辑保持原样。返回的文本/结构化 details 不能泄露 env、headers、URL 凭据或 Server Instructions 的敏感内容。

删掉 `.uina/extensions/mcp/index.ts` 现在的 `buildCapabilityIndex()` 和全局 MCP Capability Source；不补一份同内容的静态 Guidance。MCP Proxy 的短描述解释发现流程即可；具体 Server 信息由工具按次读取配置。**MCP 配置修改不要求执行 `runtime_reload(resources)`**；只有扩展自身代码改变才需要 `extensions`。

## 7. Context、Event Frame 与领域输出的收口

### 7.1 Context Source

公共 `ContextSource` 只保留：

```ts
type ContextSource =
  | { id: string; kind: 'guidance'; text: string; requiresTool?: string }
  | { id: string; kind: 'observation'; read(ctx: ContextRead): ContextValue | null | Promise<ContextValue | null> };
```

删除 `kind='capability'` 的 Registry、Composer、Trace、生产者与测试分支，不删除 Minecraft 领域自身名为 capability 的动作定义。Guidance 由 Composer 按 `(owner,id)` 固定顺序放在 System 后的一条 User 参考消息（标 `runtime.guidance`，**不是外部操作者发言**）；文件或扩展换代后改变文本，资源刷新不引入新 Source 类型。Observation 置于 History 后，只读、不消费事件、不改变世界，按现有来源隔离与 JSON 转义；`inspectRequest()` 重复执行不能产生业务副作用。

迁移现有生产者：Minecraft 当前动作资格与必要连接事实改为简短 Observation；Embodiment 删除 `body-cues` 动态列表，合法 Cue ID **仅由各扩展自己的 Guidance** 描述；Skill Catalog 保留 Guidance。Speech 正常发声与每句播放状态不应无条件常驻；但当前 `speech-now` 仅在真实播放时返回一行，**先核实它是否是模型获知「此刻仍在说什么」的唯一低成本事实**，再决定删除或改为按需查询。若删除，必须保证与打断、抢话、播放排队相关的决策仍有足够信息。恢复/诊断用现有领域工具查询，不让每次请求承担全领域状态快照。

`RequestAssemblyTrace` 必须让 Inspector 能**准确对应到最终渲染后的内容**，原始 `chars` 不能冒充渲染后的截取范围。优先复用 Composer 生成的章节文本/来源身份展示；**只有 UI 确实需要在完整消息中定位高亮时**，才增加最终消息索引与 UTF-16 范围。不为未来高亮需求先做覆盖所有图片/转义分支的通用 Offset 引擎。Tool 定义仍作为独立 `tools` 请求字段，不能复制成 User 正文。

### 7.2 操作者与其他外部来源

**外部身份是领域事实，Provider Role 是传输包装。** 所有真实外部输入（包括操作者）都保留 `InputSource` 与 Event Frame 语义；只从可信接入边界确认操作者的身份和权限，正文中自称管理员不能提升权限。

当前 `projectEventFrames()` 根据 `origin`/来源识别外部消息，生成 `external_event_frame` 合成 Assistant Tool Call + Tool 回执；合成帧不入 Canonical Session，也不是 Uina 真正执行的工具。**保留该机制**，保留稳定 `eventId → callId`、工具对原子性、保留名不可执行、仅存在实际帧时声明协议工具以及 Compaction/Provider 校验。

特别说明：在对话首位，现有 `leadingFrameMessage()` 因某些 Provider 不能以 Assistant Tool Call 开场而用**带来源标题和 metadata 的 `role=user`**。这是**不可隐藏的协议权衡**：Uina 的领域身份仍为外部 Actor，但 Provider 确实会看到一个 `user` 角色，来源标题不能保证模型完全忽略该角色的指令优先级。保留现有兼容回退并对首条外部输入做对照验证；不为追求表面一致加入假的前置消息，也不把后续操作者输入永久切为原生 User。Runtime 内部报告仍走自己的内部来源；真实 Tool Call/Result 保持原生工具对。

Presentation 显示真实 Actor/事件，不展示合成的 `external_event_frame` 为主体行动。旧 Journal/Replay 保持按来源重投影；没有可信来源证据时不从发言文字反推操作者身份。

### 7.3 Skill 与 Speech/TTS/Embodiment

- **Skills：**保留现有发现、优先级/同名遮蔽、`read_skill`、资源分页、`/skill`、Catalog 和根路径限制；本轮只加资源刷新所需的候选/发布接缝，不新建 Skill Executor、Script Runtime 或通用维护系统。
- **Speech/TTS：**保留 Output Interpretation、`<speech>`/`<cue>` 解析、Canonical Expression Annotation、Utterance、`speech.say/stop/status/set_muted`、TTS DeliveryLane/SynthesisWorker/AudioSink/PlaybackFeed；“文本表达已受理、音频受理、物理播放完成”严格分离。正常播放分句、RMS/口型进度不进入 LLM 每请求 Observation。
- **故障交付：**真正影响主体决策的服务不可用或播放失败按现有连接/交付权威事实区分故障阶段；同阶段连续失败可合并一次内部 Input，恢复有证据后新故障才重新通知。单次 Tool Result 仍如实返回失败/unknown；不开发无依据的通用后台监控器。静音是用户偏好，不当作错误。
- **Cue：**只保持语法解析、路由、Speech 边界执行、离线/未知回执诊断。**合法 ID 及用法完全由各具体扩展的 Guidance 提供**，不再产生 Body Cue 目录、Capability 注入或独立枚举服务。

### 7.4 Input/Tool/异步任务

保留 Input Delivery 的受理/提交/退休，Tool Result 五态及现有 Queue 批量合帧。`accepted` 仅代表受理，不代表模型已看到；Tool `succeeded` 不代表异步业务任务最终完成。领域有稳定 `operationId` 时 Presentation 才关联进度与结算，不从自然语言回执猜造 ID。未证实执行结果为 `unknown` 时不得改成 `failed` 或 `cancelled`。Reload 本身也是一次受理与应用分阶段的真实操作，沿同一事实原则处理。

## 8. Presentation、TUI、Inspector 与远端

### 8.1 唯一 Feed

在现有 `src/presentation/{projection,ingest-live,ingest-replay,...}` Lifecycle 上形成唯一 Feed（不写第二套 Turn/Tool 状态机）：

```ts
type FeedEntry = FeedBase & (
  | { kind: 'message'; speaker: 'operator'|'subject'|'external'|'unknown'; text: string; images?: readonly ImageContent[]; source?: InputSource; inputId?: string }
  | { kind: 'operation'; category: 'tool'|'compaction'|'domain'|'reload'; label: string; status: string; callId?: string; operationId?: string; summary?: string }
  | { kind: 'event'; category: 'world'|'session'|'runtime'|'extension'; label: string; severity?: 'info'|'warning'|'error' }
);
type FeedChange = { kind:'append'; entries:readonly FeedEntry[] }
  | { kind:'update'; entry:FeedEntry }
  | { kind:'replace'; entries:readonly FeedEntry[] };
```

`status` 在正式实现中复用现有事实联合类型，`reloadId` 作为 Operation 的结构化关联 ID，不从描述文本恢复。Message 的 `source.actor` 必须保留可信的参与者稳定身份和显示名：不能只凭 `speaker='external'` 把所有观众与游戏玩家压成一个人；无身份时明确 unknown，不从正文猜测。Turn、Thinking、Request Evidence、Activity、State、图片、Diff 是 Feed 的内容/关系/视图，不再新增第四种通用 Feed 类型。

- Live/Replay/远端对同一个 Tool `callId` 最多一条 Operation，开始/结果更新同条；真正的外部发言归 Message，世界变化归 Event；不从 Provider 合成帧判断发生了工具操作。
- `commitQueueItem()` 将已消费输入写为 Session `kind='input'`，不保证独立 `kind='message'`：Replay 必须从 committed Input 恢复真实参与者发言，按 `inputId` 去重，未消费 queued 仍只作为待处理项。展示用 `displayText`，模型正文用 `text`，内部 `display:false` 不假装操作者。
- `speech.say` 可能产生可见说话内容，但接收成功不等于物理播放完成；只展示一次主体发言。Transcript 仅消费 Output Interpretation 的语义文本，不重新正则解析标签。
- `runtime_reload(extensions)` 先呈现 scheduled Operation，收到同 `reloadId` 的真实完成/失败才更新终态；`resources` 应直接表现 applied/failed。Reload 期间真实被重新激活的项目扩展/连接状态可检查，但不按每个内部状态更新堆积永久卡片。
- Rewind 后依据现行主线重新投影；工具/外部消息/Compaction/失败与旧版本兼容。无消费者的重复 Delta 文本与 Transcript Journal Walker 在迁移后删除，不删已有终端排版、Renderer、滚动缓存。

### 8.2 `/prompt` 与 `/context`

- **`/prompt`：**只看稳定 System（含 Runtime Protocol）与 Guidance，标识当前已发布资源版本、选用文件、编译来源、最近真实请求版本。已删除 Persona，界面/文档不可再列一个 Persona 层。允许切换“最近准备请求 / 当前资源预览”。
- **`/context`：**看某次完整 RequestProjection：System、Guidance、历史、动态 Observation、工具声明和精确来源片段；明确区分最近真实准备请求与当下纯 Preview。不为回看旧请求重读当前 Source 并冒充当时内容。
- Subject 在 Preflight 完成、Provider 调用前固定 `ActiveRequestObservation`，增加 `preparedAt` 和轻量 `request_prepared` 事件，用实际 `requestId` 关联；未获得 Provider Wire 证据时只说“已准备”，不能称“已发送/模型已理解”。远端同步不广播完整 Prompt、私有 Schema 或凭据。
- Reload 成功后 `/prompt` 立刻显示新版本，`/context` 的“最近准备请求”仍展示其原版本；下次真实请求后更新对应 Evidence。Reload 不伪造一轮 Provider 请求。

### 8.3 输入区 Dock 与远端 Sync

默认单栏 Feed；Message 表示谁说了什么，Operation 表示做了什么和结算情况，Event 表示真实变化。操作可展开参数/结果/代码/Diff/图片；UI 只持有滚动、展开、焦点、选择状态，不成为第二份领域账本。

输入区 Dock 统一管理高度：**输入编辑器与补全 > 排队输入 > 当前活动 > 最近请求情境**。队列一行显示计数/顺序入口，活动至多一行主工作加计数，情境默认一行并可展开 `/context`；终端很窄时先舍弃情境再舍弃活动，排队入口和输入不能消失。队列从 `HostSnapshot` 读事实，不在 Dock 中修改所有权；情境读 Request Trace，不在每次屏幕刷新时触发 Observation。

远端继续使用现有 `snapshot/fact/intent` 协议；Snapshot 必须包含恢复进行中工具/输出所需的最小 Lifecycle 状态，避免重连后重复 Assistant/Tool 节点。Feed 破坏性替换旧 Transcript 时同步提高 `SYNC_PROTOCOL_VERSION` 并更新全部生产/消费方；不要维持两套长期兼容链。stdio 使用同一语义的简洁文本输出，不依赖 TUI ANSI。

## 9. 代码修改范围与实施顺序

| 阶段 | 主要修改位置 | 应完成的事实 |
| --- | --- | --- |
| **S0 现状基线** | `src/agent/loop.ts`、Host/Runner、tests、真实 CLI | 核实 HEAD、现有请求/重载/Queue/Replay 夹具和已有测试失败；先不动业务引擎。 |
| **S1 System 与 Persona 收口** | `src/agent/{context,loop}.ts`、`src/host/{host,profile}.ts`、`src/extensions/event-frames/*`、`scripts/copy-assets.mjs` | 默认 Prompt 移 Markdown、分离协议说明、选择规则、Profile 迁移、当前 System 快照与 Request 版本。**不把操作者改为原生 User。** |
| **S2 Resource Reload 与工具** | `src/extensions/{runner,context-registry,skills,runtime-tools}`, Host、Subject、Tool Broker 接线 | 文件 Guidance 原位替换、Skill 候选发布、System 资源一致性、`runtime_reload` 最终 Schema、`/reload resources`、结果五态；Resources 可由工具在 Busy 时安全应用。 |
| **S3 Extension Reload 安全点** | `src/host/host.ts`、`src/agent/loop.ts`、`src/extensions/runner.ts`、Input Delivery、测试 | scheduled 后停止续推理、当前工具完成、暂停自动续队、Idle 换代、最终内部结果投递、恢复队列；Busy/重复/失败可验收。 |
| **S4 Context / MCP / Speech** | Composer、ContextRegistry、MCP config/proxy/index、Speech/Embodiment、Minecraft Source | 删除旧 capability 注入、MCP Description/冷发现、Speech 无意义状态、Cue 目录；保持真实工具/领域执行语义。 |
| **S5 Presentation / UI（独立交付）** | `src/presentation/*`、`src/ui/*`、`src/cli/frontend-gateway.ts` | Feed 单一事实投影、Replay Input 修复、Reload 状态、`/prompt`/`/context` 与 Dock、远端续流及协议版本；**在 S1–S4 验收后单独合入**。 |
| **S6 删除与发布** | tests、README、`docs/current-runtime.md`、现役文档 | 删除旧 Persona/capability/双展示链与过时测试；工程测试、built CLI、实际 TTY 和必要领域现场验证。 |

允许 Coding Agent 自主决定类/文件命名和普通函数组织；**不得把关键跨层边界留成多个并行实现**。旧文档中的“操作者原生 User”结论与当前方案冲突，应更新或标记失效；任何旧 Tool/Context/Persona 合同不能以兼容名义无限期保留。

## 10. 必须通过的验收条件

| ID | 验收合同 |
| --- | --- |
| A1 | 默认 System 的迁移前后正文一致；启用默认 Event Frame 时协议指导仍完整，`options.systemPrompt` 不能绕掉协议要求；custom Projection 不被强加 Event Frame 说明。 |
| A2 | 无 Profile、Profile System、工作区 System、Host 显式覆盖四种选择正确；非法/空文件报错，明确缺失才回退；开发与 dist 启动读取同一资源。 |
| A3 | 旧 `persona.md` 经一次性迁移保留有效内容，`profile.json` 及排他锁不变；完成迁移后运行时不再加载 Persona。 |
| A4 | Agent 修改 System/文件 Guidance/Skill → `runtime_reload(resources)` 成功返回 `phase=applied` → **下一次真实 Provider Request** 必须使用新版本；现有扩展实例/领域连接/Session 保持。 |
| A5 | System 或已注册文件 Guidance 的编译/读取发生致命错误时，资源全部保持上一发布版本；单个无效 Skill 按现有 Loader 合同跳过并报告 diagnostics，其他有效 Skill 仍可发布；重复成功 Reload 不重复注册或无故推进 revision。 |
| A6 | Reload/Preview/Provider 请求并发时不产生混合 System/Guidance/ToolSet 版本；旧已发送请求不被修改，`/context` 可追溯其实际版本。 |
| A7 | Tool 定义准确为 `runtime_reload` 和唯一必填 `scope`；`resources` 状态为原有 `succeeded/failed`、不强制终止下一次推理；`extensions` 返回 `scheduled + reloadId + continuation=stop`，不可假报 applied。 |
| A8 | `extensions` 在一批 Tool Call/Result 完成后、自动续队**之前**实施；不出现 tool-await-idle 死锁，不丢排队输入、不在换代期间提交旧 Provider Request；合并重复 Reload。 |
| A9 | 扩展预导入失败保留旧扩展；单扩展激活失败如实部分成功；代码已换代但资源加载失败时报告实际有效集；最终 `reloadId` 内部通知恰好一次、能越过自身输入门并在下一模型决策前可见；TTS/MCP 伴生资源按现有所有权结算。 |
| A10 | 操作者第 1 条/第 N 条输入均携带外部来源身份；首帧必要时 `role=user` 是真实的 Provider 协议妥协，不能宣称模型绝无用户角色偏置；世界事件和外部参与者仍正确 Event Frame，合成工具不可调用且不显示为 Agent Operation。 |
| A11 | 删除 Context `capability` Source 后，Guidance/Observation 装配稳定，`inspectRequest` 纯读、外部转义不破、来源范围准确；旧 Journal/Compaction/Rewind/Thinking Replay 仍有效。 |
| A12 | MCP 仅改 description 不改连接指纹、不要求重信任或重连；`mcp.search` 对未发现 Server 只读可搜，`list(server)` 才冷连接；Project blocked、stale、已移除目录与凭据脱敏全部正确。 |
| A13 | Skill 的 `read_skill`、`/skill`、资源分页、宽容发现与 Catalog 不回退；Body Cue ID 仅来自各扩展 Guidance，不存在第二 Cue 目录或动态注入；修改 Minecraft `ENV_PROMPT.md` 不得假报已由 `resources` 生效。 |
| A14 | Speech 每句播放进度、口型/RMS 不污染模型；若移除 `speech-now`，先用抢话、停止播放、排队发声场景证明行为不退化；发声受理、播放完成与 unknown 仍区分；同一故障阶段不重复唤醒，恢复后的新阶段可再次通知。 |
| A15 | Live/Replay/远端中已提交外部 Input、Tool、Reload、Compaction 具有一致身份与数量；队列未提交项不会伪装已发生；Rewind 后投影正确。 |
| A16 | `/prompt` 只检视稳定指导，`/context` 明确实际请求 vs 预览；Reload 后显示新版本但不改写上一请求；Request Evidence 不假称已送达。 |
| A17 | 40/80/120 列与低高度 TTY 中排队消息和编辑器可达；长会话、增量输出、工具详情与鼠标焦点无明显性能/交互退化。 |
| A18 | 按仓库现有脚本运行 `pnpm typecheck:ci`、`pnpm test:ci`、`pnpm build`、`pnpm verify:cli`、`pnpm verify:gateway`、`pnpm bench:ui` 中适用的门；记录未能实测的真实 Minecraft/Paper、TTS 物理设备路径，不以 mock 通过冒充现场通过。 |

测试以 `tests/event-frame-projection.test.ts`、`tests/mcp-config.test.ts`、`tests/mcp-proxy-tool.test.ts`、`tests/mcp-extension-loading.test.ts`、`tests/subject-profile.test.ts`、`tests/extension-runner.test.ts`、`tests/turn-yield.test.ts`、`tests/presentation-sync.test.ts`、`tests/ui-live-replay-equivalence.test.ts` 等现有夹具为起点；对真实跨模块失败补必要测试，不为流程本身造审查代理或重复证据系统。

## 11. 对 Coding Agent 的执行要求

以本设计为**本次变更的唯一目标合同**，先查源码和测试定位与当前 HEAD 的差异。优先复用已有 ResourceScope、Prompt Compiler、Skill Snapshot、Input Delivery、Tool Result、History View、Context Registry、Presentation，而不是创建替代抽象。按 S0–S4 交付并验收核心 Reload/信息合同，S5 的 Feed/TUI/Sync 作为后续独立交付，最后收口 S6；不要只新建类不接到最终请求/实际 CLI。特别核实 Resource Reload 原子发布、Extension Reload 暂停自动续队、Profile 迁移、Provider 首条 Event Frame、MCP Description 指纹、Replay 已提交 Input 与 Inspector 版本。这些是决定成功与否的关键链路。普通工程组织可自行优化，但要保持上述所有权和验收结果。

## 12. 工程依据

- [现行源码基线](https://github.com/FanRec/uina-agent/tree/ba74c9631c2085416897398bf815c8be7514b37d)
- [`src/host/host.ts`](https://github.com/FanRec/uina-agent/blob/ba74c9631c2085416897398bf815c8be7514b37d/src/host/host.ts)：Host 装配、System 创建、`reloadExtensions()`、Skill 刷新。
- [`src/agent/loop.ts`](https://github.com/FanRec/uina-agent/blob/ba74c9631c2085416897398bf815c8be7514b37d/src/agent/loop.ts)：请求装配、Tool Continuation、回合完成、自动队列恢复。
- [`src/extensions/runner.ts`](https://github.com/FanRec/uina-agent/blob/ba74c9631c2085416897398bf815c8be7514b37d/src/extensions/runner.ts)：项目扩展换代、文件式 Guidance 单次编译、Scope 注销。
- [`src/extensions/skills/index.ts`](https://github.com/FanRec/uina-agent/blob/ba74c9631c2085416897398bf815c8be7514b37d/src/extensions/skills/index.ts)：Skill 候选加载与 Catalog 发布。
- [`src/extensions/event-frames/projection.ts`](https://github.com/FanRec/uina-agent/blob/ba74c9631c2085416897398bf815c8be7514b37d/src/extensions/event-frames/projection.ts)：外部输入和首帧 Provider 降级。
- [`.uina/extensions/mcp/config.ts`](https://github.com/FanRec/uina-agent/blob/ba74c9631c2085416897398bf815c8be7514b37d/.uina/extensions/mcp/config.ts)：配置层、指纹、项目授权。
- [OpenAI Function Calling 官方指南](https://developers.openai.com/api/docs/guides/function-calling)：简洁工具合同、工具结果与多调用处理。
- [MCP Tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)：工具发现、描述与调用的协议边界。

**完成判定：**核心阶段不只是文件可编辑、命令可调用；必须实证下一次 Provider Request 获得新 System、**适用的文件式** Guidance 与有效 Skill 快照，扩展换代没有自等死锁或旧队列抢跑，操作者仍是外部 Actor。Presentation 阶段单独实证 TUI 与 Replay 显示真实事实。两个阶段均只保留一条可维护的正式路径。
