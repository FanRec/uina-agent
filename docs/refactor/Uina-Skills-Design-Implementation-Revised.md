# Uina Skills：设计与重构实施规格

**目标仓库**：https://github.com/FanRec/uina-agent  
**审查基线**：`main`，Git tree `f1c2aef21af90ee56ad396b112e7a61b2783fc5e`；实施前核对实际代码，按职责映射而非行号施工。  
**参考**：[Agent Skills Specification](https://agentskills.io/specification)、[Agent Skills 集成指南](https://agentskills.io/client-implementation/adding-skills-support)、[Pi Skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)、[Pi 源码](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/skills.ts)、[Claude Code Skills](https://code.claude.com/docs/en/skills)。

## 1. 产品合同

Uina 提供跨项目、主体和扩展的 **Skill 发现、渐进式读取、手动调用与资源刷新**。模型只常驻可用 Skill 的简短索引，需要时读取正文及附属资源；操作者可明确指定 Skill，随后仍由现有 Agent、Tool、Activity 完成实际工作。无 Skill 时，现有输入、请求和工具行为保持不变。

| 概念 | 所有者与职责 |
| --- | --- |
| Skill | `SKILL.md` 与附属文件；可复用的程序性知识，**不是执行实例** |
| Skill Source | 某个资源根及其来源/优先级；由 Host 装配 |
| Skill Snapshot | 一代已发现且解析完成的 Skill 定义；由 Skill 扩展持有 |
| Skill Read | 通过只读工具获取正文或附属文本，结果仍是普通 Tool Result |
| Agent | 决定是否参考 Skill、怎样使用 Tool 和完成目标 |
| Activity / Task | 承担工作进度、执行与结果；不由 Skill 建立或调度 |
| Extension | 可以交付 Skill，但普通 Skill 不必是可执行 Extension |

**边界**：Skill 不增加权限，不自动执行脚本，不创建子 Agent，不持有任务状态，不修改模型系统提示词，不拥有新的队列、历史或 Compaction 系统。现有工具执行能力保持唯一权威。

## 2. 架构与代码所有权

以 **官方内置 Extension** 交付 Skill；Host 只负责来源与生命周期的编排；已有 Core 机制只做必要的通用扩展。

```text
UinaHost
 ├─ 工作区 / 用户全局 / SubjectProfile? / 活跃 Extension 资源根
 ├─ ExtensionRunner
 │    └─ builtin:skills
 │         ├─ Loader → SkillSnapshot（不可变代次）
 │         ├─ Catalog → 一条固定 Guidance
 │         ├─ Reader  → read_skill（普通工具）
 │         └─ Commands → /skill、/skills
 └─ Subject → 既有 Input / Queue / Journal / Projection / Tool Broker
```

建议在 `src/extensions/skills/` 中组织发现解析、快照解析、资源读取、目录格式化与内置激活入口；具体文件拆分交给实现者。纯领域逻辑不依赖 TUI、Provider、Subject、WorldRegistry。**不创建** `SkillRuntime`、`SkillRunner`、`SkillExecution`、`SkillManager`、`registerSkill()` 或独立 Resource Loader。

本次可接受的通用接缝仅有：

1. ExtensionRunner 向 Host 暴露当前有效的扩展资源根。
2. Command Router 能将命令结果转换成**一条操作者输入**，不自行注入运行时消息。
3. 输入保留真实模型正文与独立展示正文，贯穿实时流和回放。
4. Context Source 能根据本次最终工具声明判断固定 Guidance 是否可用。
5. Host 在原有启动/重载边界刷新 Skill 资源。

以上接缝不改变工具、会话和上下文的基本所有权。

## 3. 文件格式与兼容语义

唯一自动发现形态是符合 Agent Skills 标准的目录：

```text
my-skill/
├── SKILL.md
├── references/          # 可选
├── scripts/             # 可选
└── assets/              # 可选
```

`SKILL.md` 包含 YAML Frontmatter 和 Markdown 正文。**必需**：`name`、`description`。标准可选字段：`license`、`compatibility`、`metadata`、`allowed-tools`。使用成熟 YAML 解析器；支持 UTF-8 BOM、LF/CRLF、块标量及多行描述。`name` 用小写字母、数字、短横线，长度 1–64，不以短横线开头/结尾，不含相邻短横线；描述非空且不超过 1024 字符；`compatibility` 不超过 500 字符。

**兼容策略：规范输出、适度宽容输入。** `name` 与实际父目录名不一致时记录警告，但使用 Frontmatter 中的合法名称；`name` 缺失而父目录名合法时，可用目录名作为兼容回退并警告（不将其称为严格符合标准）；缺描述、无法解析的 YAML、无合法可引用名称则跳过该项并给出诊断。可选字段类型不合法时忽略该字段并诊断，不让单项问题阻断其他 Skill。未知非执行性键可以忽略，不建立一套自定义 Manifest。暂不自动把普通 `.md` 文件当成 Skill；旧示例需迁移为目录式 `SKILL.md`。

支持以下常用扩展字段：

| 字段 | Uina 语义 |
| --- | --- |
| `disable-model-invocation: true` | 不在模型 Catalog 出现，模型不能主动加载该 Skill **正文**；用户仍可调用 |
| `user-invocable: false` | 用户不能显式调用；模型仍可按前一开关使用 |
| `argument-hint` | 本地命令帮助与参数提示 |
| `when_to_use` | 如果存在，作为简短发现条件合并到模型目录描述中，不突破目录预算 |
| `arguments` | 可选的位置参数名称映射，用于 `$name` 替换 |
| `allowed-tools` | 可以保留与诊断，**绝不授予、提升或缩减实际工具权限** |

两个调用开关默认均为允许。二者均禁止时该 Skill 不进入可调用集合，仅可出现在诊断中。布尔字段只接收真正的 YAML 布尔值，不把字符串 `"false"` 当作 true。

`context: fork`、`agent`、`model`、`effort`、`background`、`hooks`、`disallowed-tools` 等会改变执行位置、权限或副作用的扩展能力**不实现**。对于出现这些字段且要求实际行为的 Skill（例如 `context: fork`、`agent: Explore`、`background: true`、`hooks`、`disallowed-tools`、指定模型或推理档位），跳过并报告不兼容；`background: false` 等不要求额外行为的值可忽略。Claude Code 的动态命令注入语法 ``!`command` ``不执行；明确使用该语法的 Skill 同样标记不兼容，不把命令原样冒充已执行后的内容。`compatibility` 仅用于说明环境要求，不声称已自动满足。此处只兼容选定字段语义，不宣称完全兼容 Claude Code 执行框架。

## 4. 资源来源、优先级、冲突

Host 生成只读 `SkillSource[]`，Skill Loader 不读取 Profile、Extension 或 World 内部对象。

| 顺序（高→低） | 来源 | 条件 |
| --- | --- | --- |
| 1 | Host 显式指定的 Skill 根 | 明确指定时；按声明顺序，先声明者优先 |
| 2 | `<cwd>/.uina/skills/` | 默认 |
| 3 | 从 `<cwd>` 到 Git 根之间的 `.agents/skills/` | 默认；**越靠近 cwd 越优先**；不在 Git 仓库时只扫描 cwd |
| 4 | `<profile.root>/skills/` | 指定 `--profile` 时；目录不预创建 |
| 5 | Uina 用户全局目录 `(<UINA_HOME> 或 homedir)/.uina/skills/` | 默认，复用 `src/ai/settings.ts` 等已有的 Uina 配置根语义 |
| 6 | 用户全局 `~/.agents/skills/` | 默认；跨客户端共享 |
| 7 | `<activeExtensionRoot>/skills/` | 该扩展激活成功且有独占资源根 |

不自动扫描 `.claude/skills/` 或 `.pi/skills/`；可通过显式来源装配。非必需目录缺失正常忽略；显式来源不可用报诊断。`~/.agents/skills/` 始终指系统用户目录，**不**随 `UINA_HOME` 改变。来源顺序确定后，同级以规范化真实路径稳定排序，真实文件去重。

递归扫描目录，发现含 `SKILL.md` 的文件夹即作为一个 Skill，不继续将其附属树中的 Markdown 当作新 Skill；跳过 `.git`、`node_modules` 和隐藏目录。允许有效符号链接，但用真实路径识别重复与环；不为此实现完整 Git ignore 引擎，必要时可使用现有成熟库。默认扫描避免无意义的依赖树遍历；错误信息包含来源与文件路径。

同名：先按上述顺序选择**唯一胜出项**，再应用调用开关。禁止模型调用的高优先级 Skill 不得隐式回退到低优先级同名 Skill。冲突诊断包含胜出与被遮蔽的来源、实际文件路径；第一版不增加动态命名空间或限定名命令。

扩展资源根由 `ExtensionRunner.activeResourceRoots(): readonly {ownerId: string; root: string}[]` 供 Host 查询。仅返回成功激活、仍有效且拥有资源根的 Extension；多入口共享根按真实路径去重。单文件 Extension 没有资源根时不猜其目录。当前旧 World Framework 的 World 并非普通 Extension，不为其新增 Skill 专用接口；需要 Minecraft Skill 可放项目根，后续 World 迁为 Extension 时自然携带。

## 5. 快照与资源读取模型

```ts
interface SkillSource {
  ownerId: string;
  directory: string;
  priority: number;
}
interface SkillEntry {
  id: string;                // 来源身份 + 规范化真实路径
  name: string;
  description: string;
  root: string;              // Skill 目录真实路径
  file: string;              // SKILL.md 真实路径
  sourceId: string;
  revision: string;          // 已读取 SKILL.md 的哈希
  body: string;              // 不含 Frontmatter；发现时缓存
  modelInvocable: boolean;
  userInvocable: boolean;
  argumentHint?: string;
  argumentNames?: readonly string[];
  whenToUse?: string;
  license?: string;
  compatibility?: string;
  metadata?: Readonly<Record<string, string>>;
  allowedTools?: string;      // 仅诊断/保留，不参与授权
}
interface SkillSnapshot {
  generation: number;
  entries: readonly SkillEntry[];
  diagnostics: readonly SkillDiagnostic[];
}
```

Loader 为解析 Frontmatter 已读取 `SKILL.md`，因此在**发现时同时缓存正文**。完整正文仅在实际调用时进入模型上下文，仍满足三层渐进加载。所有解析、冲突处理和 Catalog 文本都从**同一不可变 Snapshot** 派生。Skill 文件修改在 `/reload` 前不改变正文或元数据；附属文件按需实时读取，**不谎称其内容与 `SKILL.md` 同版本冻结**。

纯操作建议：`loadSnapshot(sources)`、`resolve(snapshot, name, purpose)`、`renderCatalog(snapshot)`、`read(snapshot, name, resource?)`、`expandInvocation(snapshot, name, args)`。不持久化另一个 Skill 数据库；`generation` 是内存代次，实际内容身份以 `revision` 判别。已提交的显式调用保留当时展开的原文，重启后不重新读取新版 Skill。

刷新时先完整构建候选快照及 Guidance 文本，之后在 Host 请求安全边界一次性发布新可见集。单项无效或单个来源不可读，只省略相应资源并报告诊断，其他有效资源照常发布。若项目扩展的预导入失败且**尚未卸载旧扩展**，可以保留旧 Snapshot；一旦扩展集合实际改变，则必须基于**现存有效来源**发布新快照。若发生无法完成发布的异常，保持重载门关闭直到撤下过时的 Skill Tool/Guidance 或恢复为与当前来源一致的完整快照，再向调用方报告失败。禁止用已卸载 Extension 的旧 Catalog 假装刷新成功；不会出现半更新的模型请求。

## 6. 模型发现：单一 Guidance 与工具可见性

当前 `ContextSourceRegistry` 与 `Request Composer` 已支持稳定的固定 Guidance 注入：它位于 System 后、历史前的合成 `role:user` 前缀消息中，带 `runtime.guidance` 标记，不写入 Canonical History。复用这一位置，**不改 System、Composer 排版、角色、排序，也不走 Observation 或 `turn.prepare`**。

全部模型可调用的 Skill 集中成 `builtin:skills / catalog` 一条 Source：

```xml
<available_skills>
  <skill>
    <name>minecraft-building</name>
    <description>用于规划和核验 Minecraft 建筑。</description>
  </skill>
</available_skills>
```

统一说明只需一句：任务匹配描述时通过 `read_skill` 加载正文，再按需读取附属资源。Catalog 不注入完整正文，不列绝对路径；名称、描述经 XML 转义，优先压缩冗长而低价值的描述。模型调用被禁的 Skill 不出现在目录中。目录为空时不创建空 Guidance。对目录的描述应强调**适用条件**，不是重复提醒模型必须频繁调用工具。

为保证模型目录与**同一次最终请求的工具声明**一致，做一个最小通用接缝：

- `ContextRead` 增加 `availableToolNames: readonly string[]`，来自本次 `turn.transformContext` 完成之后的 `merged.tools`，不取静态 Broker 名单。
- 固定 Guidance Source 可选 `requiresTool?: string`；`ContextSourceRegistry.collect()` 不满足时省略该 Source，并记录普通省略诊断。
- `builtin:skills / catalog` 的条件为 `read_skill`。`Subject` 仅传真实最终工具名单，不引入 Skill 判断。

因此 Tool View 或高级投影逻辑隐藏 `read_skill` 时，Catalog 同时消失。这里的一致性指 **Provider Wire 转换前的语义 `RequestProjection`**；任意扩展若在更低层 `provider.transformPayload` 直接改写工具载荷，仍须自己承担其一致性责任，Skill 层不另建 Wire 级补偿。`read_skill` Tool Definition 尽可能**保持不随具体 Skill 名单变化**，避免资源变化引起工具 Schema 频繁膨胀；名称由目录发现、Reader 校验，不动态生成枚举。

## 7. `read_skill`：正文、资源、调用权限

注册**一个**普通只读工具：

```ts
read_skill({
  name: "minecraft-building",
  resource?: "references/shelter.md",
  offset?: 1,
  limit?: 200
})
```

读取行为：

1. 无 `resource`：返回快照中缓存的 Skill 正文，不附 YAML Frontmatter；给出名称、来源、`revision`、可供既有工具引用的 Skill 真实目录，以及简短的附属资源列表。相对引用基于此目录。
2. 有 `resource`：从对应 Skill 根目录读取指定的 **UTF-8 文本文件**，包括 Markdown、JSON、脚本源码等；`SKILL.md` 及其真实路径别名一律进入正文读取规则，不能绕过快照取得新版全文。
3. 附属文件列表按路径排序，**仅列目录项，不预读内容**；排除 `SKILL.md`，跳过常见依赖/隐藏目录，对大目录设置合理的数量与深度上界，并明确标记截断。二进制资源不假装成文本；其他工具能否读取图片、执行脚本，由那些工具自己的权限决定。
4. 大文本遵循 Uina 现有 `read_file` 的分页与截断习惯，返回总行数或继续读取提示；不得静默丢失末尾。工具调用走既有 Broker、取消、结果与会话记录。
5. 所有 `resource` 都是相对路径；拒绝绝对路径、路径穿越、非普通文件，以及经符号链接越出 **Skill 根真实路径** 的访问。`SKILL.md` 别名不得突破缓存和调用开关。只需 `realpath`、`relative` 和文件类型检查，不发明虚拟文件系统。

**必须区分“自动激活正文”和“读取已安装资源”。** 下表是本次权限契约：

| Skill 状态 | 模型 Catalog | `read_skill(name)` 正文 | `read_skill(name, resource)` 附属文本 | `/skill name` |
| --- | --- | --- | --- | --- |
| 两种入口均允许 | 有 | 允许 | 允许 | 允许 |
| `disable-model-invocation: true` | 无 | **拒绝** | **允许**（供手动调用后的正文引用） | 允许 |
| `user-invocable: false` | 有 | 允许 | 允许 | 拒绝 |
| 两种入口均禁止 | 无 | 拒绝 | 拒绝 | 拒绝 |

**注意**：手动专用 Skill 的附属资源读取不等于模型能主动激活该 Skill；正文仍由操作者调用时注入。`disable-model-invocation` 是调用策略、**不是保密或隔离控制**，因此第一版不为附属资源增加“当前激活 Skill”状态机。若未来产品确实要求资源也只能在已授权的活动会话中读取，应设计独立资源权限，而不是把调用开关冒充安全边界。只要存在任一可调用 Skill（包括仅手动调用），工具可提供此资源读取能力；只有没有可用 Skill 时才撤下工具。仅手动 Skill 不生成模型 Catalog，但可保留读取工具以保证手动流程闭环。

`read_skill` 不接受用户任务参数，不自动执行 `scripts/`，不为脚本授予 `exec_command` 等权限。调用结果的文本包装应明确其为**Skill 资源**，不是新系统指令；模型已有任务由当前会话提供。

## 8. 操作者调用、队列与展示回放

入口：

```text
/skill minecraft-building 建造一座两层木屋
/skill:minecraft-building 建造一座两层木屋    # Pi 兼容别名
/skills                                            # 本地查看名称、来源与诊断
```

不为每个 Skill 注册裸 `/name` 命令，以免覆盖官方或其他扩展命令。`/skill:name` 通过通用 Router 解析“已注册命令 + 冒号子名”，不是在 CLI 硬编码 `skill:`。Router 必须保留参数原始字符串（不能通过普通空白拆分后重新拼接），未知或不允许的 Skill 给出明确失败且不落成普通 Prompt。

**通用命令协议**：Handler 可返回 `void`（原有本地管理行为），或返回 `{ kind: "agent-input", text, data? }`。Router 只返回结构化处理结果，不直接给 Subject 发消息。`UinaHost.submitOperatorCommand(rawText, mode, source)` 负责：等待 `startCompletion`、执行命令、将结果交给原有 `Host.send()` → `Subject.accept()`。`Host.send()` 本身也补齐启动等待。异常应通过同一结果/异常语义让本地消费者显示、让 Gateway 返回拒绝；不能在 Router 内悄悄吞掉再向网关报告成功。

模式：提交时空闲则沿用原有立即启动；忙时 `direct` 按现有行为转为 `steer`，明确的 `steer` / `followUp` 保持各自纪律。由 Host 为命令生成输入 ID，保留真实 `InputSource`（本地或 Gateway 的操作者）；不伪造成 `runtime` 事件，不创建第二队列，不在消费时用不会持久化的 `AgentInput.render()` 再展开。

`expandInvocation` 使用提交时的 Snapshot，将去 Frontmatter 的正文、Skill 名称/`revision`/资源目录、操作者参数包装成**真实模型输入**。与模型主动读取的结果一样，展开内容还必须附带**附属资源路径清单**以及使用 `read_skill({name, resource})` 读取文本的方法；仅手动可调用的 Skill 不能依赖模型再次调用 `read_skill(name)` 才发现 references。附属资源仍按需读取，不内联全文。支持 `$ARGUMENTS`（未改动的原始参数串）、`$ARGUMENTS[n]`、`$n`（0 起）、以及由 `arguments` 声明的 `$name`；引号包裹的参数按一个位置参数处理；引号不平衡则明确报错。未提供的索引占位符保留原文；**仅当正文没有有效参数占位符时**，才把非空原始参数串附在末尾作为任务要求，避免重复输入。单次替换、支持 `\$` 字面转义；不做 Shell 展开、递归模板或表达式求值。

### 8.1 必须补齐真实正文与显示正文分离

当前 `AgentInput.data` 虽进入待处理/Journal 输入记录，但 `src/session/recovery.ts:projectInputMessage()` 构造普通 `UserAgentMessage` 时不保留该数据，而实时 `turn_start.userText` 使用提交的完整正文。**因此不能只把原始命令塞进 `data`，然后声称 TUI 会自动显示它。**

新增一个**通用、可持久化**的可选输入字段（建议名 `displayText`）：

- `text`：模型真正接收的展开正文，进入 Canonical User Message 的 `content`。
- `displayText`：操作者原始 `/skill name args`；用于 User Message 的终端、远端、回放及 `turn_start` 展示。
- `data`：Skill ID、`revision`、来源及原始调用等机器可读上下文；沿现有输入记录持久化，不替代展示字段。

沿 `AgentInput → QueuedMessage/QueuedInput → Session Input Record → projectInputMessage → 展示事实` 将 `displayText` 传递。普通 UserAgentMessage 可以带非模型字段（例如 `displayText`），**但 `convertToLlm()` 必须继续只投影真实 `content`，绝不把 `displayText` 再次插入 Provider 请求**。实时 `turn_start`、队列展示、回放 `ingestReplay` 统一从展示字段取值，缺省回退 `text`。取消、Rewind、队列恢复必须显示同一原始命令；模型上下文始终是展开正文。不要用 Skill 专属 PresentationNode 重做整个 TUI。

### 8.2 多前端

TUI、非 TTY stdin、交互初始 Prompt 和 `-p` print 输入统一经过 Host 操作者入口。Gateway 继续禁止远端提交任意斜杠命令；只新增明确定义的 `skill.invoke` Intent（`name`、`arguments`、`mode`），在 `presentation/actions.ts`、`presentation/sync.ts` 完成结构校验后，经 Host 的**同一展开函数**处理，保留 Gateway 原有认证、来源、长度限制、错误回执。这个 Intent 不允许调用 `/reload`、`/quit`、任意其他命令。`/skills` 至少可在本地查询，错误信息包含 Skill 名称和来源。TUI 的显示样式与布局不在本次范围。

## 9. 启动、重载、卸载的时序合同

### 启动

```text
Host.start(): 设置 startCompletion 装配门
→ 激活 builtin:skills（注册命令和刷新入口；初始无 Catalog）
→ 其他内置能力
→ ExtensionRunner.load()（项目扩展完成激活）
→ Host 收集工作区/全局/Profile/实际活跃 Extension SkillSources
→ Skills.refresh(sources)（构建快照，发布 read_skill 和固定 Guidance）
→ 计算 Context Snapshot
→ 解除装配门，允许首次真实模型请求
```

### 显式 `/reload`

```text
Host 进入已有 reload 安全边界（等待 Subject 空闲与在途直调）
→ ExtensionRunner.reload()（不重新激活内置扩展）
→ 读取真正仍激活的资源根
→ Skills.refresh()（更新已发布 Snapshot、Tool、Guidance）
→ getContextSnapshot()
→ 允许新的模型请求
```

重要事实：当前 `Host.assertAccepting()` 会阻止部分 Host 输入，但 Extension Runner 的 `onInput/onInputs` 直接通向 `Subject.accept/acceptBatch`。实施时应复用同一 Host 重载准入门覆盖这些入口，使重载期间没有新的 Agent 回合穿越资源替换边界；需要拒绝时返回明确错误/结果，让交付方按原有规则处理，不静默丢失输入。无在途真实模型请求、工具与 Catalog 一致后才解除重载门。并发输入的处理不应通过“文件监控 + 后台延时刷新”规避。

`Skill Support` 内置作用域持续存在；只更新当前快照与注册项，不为 `/reload` 再创建一份内置扩展实例。更新固定 Guidance 应先构建候选文本，在受保护边界撤下旧 Source 并登记新 Source；旧/新工具注册变化同步完成。重载失败必须能指认：扩展预导入失败但旧扩展保留时可继续旧 Catalog；扩展集已经改变时，Catalog **必须反映新有效集或收缩撤下失效来源**，不能继续向模型公布不存在的 Extension Skill。

关闭时由已有 `ResourceScope` 撤下工具、Guidance、命令和服务；不新增 Watcher、独立锁或额外状态数据库。

## 10. 长任务、Compaction 与权限

Skill 正文通过普通 Tool Result（模型主动读取）或普通 User Input（操作者显式调用）进入历史；不因曾读取就变成 System、固定 Guidance 或永久状态。现有 Compaction 可以压缩旧正文。

**长任务必须仍可继续**：`read_skill` 返回可辨识的 Skill 名称、版本和正文包装；操作者显式调用也带同样可辨识的来源与版本。压缩摘要应保留**当前未完成任务仍依赖的 Skill 名称、未完成步骤及关键限制**，而不是保留所有曾经加载的 Skill 全文。实现时优先复用/精简调整现有 Compaction 总结指引，使其保留正在使用的外部方法和引用；之后模型可再次调用 `read_skill` 获取完整内容。旧任务不再相关时不携带历史 Skill。第一版不做固定 N 个 Skill 重注入、激活状态表或专属压缩器。

需要真实跨 Compaction 场景证明：加载 Skill → 执行部分步骤 → 压缩 → 继续任务，仍能定位并复用方法。如果原有摘要已经满足则**不修改 Compaction**；若不满足，仅为通用摘要增加一条指导：**“保留未完成任务仍依赖的外部方法/文件的名称、版本或定位方式，以及已完成步骤、待办步骤和关键限制；不复制已失效任务的全部正文。”** 不给 Skill 建隐藏注入管道。重复读取不是逻辑错误，是否值得优化须以实测 Token/质量为依据。

`allowed-tools` 不提升权限；`disable-model-invocation` 与 `user-invocable` 不等于文件系统加密。Skill 作者提供的内容可能包含不可靠指令，不能绕过现有工具权限和输入来源区分。真实动作、脚本执行、网络访问仍由被调用工具决定。外部 Skill 需要被实际操作者信任，当前不为此增设完整项目信任框架。

## 11. 修改范围与旧实现清理

| 代码区域 | 必需改造 |
| --- | --- |
| `src/extensions/skills/*` | 新增 Loader、Snapshot/Resolver、Reader、Catalog Formatter、官方激活入口 |
| `src/extensions/runner.ts` | Host 可查询的有效资源根；作用域所有权不变 |
| `src/host/host.ts` | 来源装配、首次/重载刷新、通用操作者命令入口、`send` 装配门、统一重载准入边界 |
| `src/extensions/commands.ts`、`src/extensions/ui-contract.ts` | 通用 `CommandResult` / 参数保真 / 可传播错误 |
| `src/core/types.ts`、`src/extensions/context-registry.ts`、`src/agent/loop.ts` | 最小 `requiresTool` 与最终工具名透传；`AgentInput/QueuedInput` 增加通用 `displayText` 与传播 |
| `src/session/recovery.ts`、必要的 Session/Presentation 投影 | 展示正文持久化、恢复、实时与回放一致；Provider 投影仍只用 `content` |
| `src/cli/app.ts`、`src/presentation/actions.ts`、`src/presentation/sync.ts`、`src/cli/frontend-gateway.ts` | 所有操作入口使用同一命令展开；远端受限 `skill.invoke` |
| `examples/extensions/skills/index.ts` | 删除旧每轮 `turn.prepare` Skill 注入/`skills.discover/v1`/依赖 `read_file` 的示例机制；迁移为新标准示例或删除 |
| `package.json`、lockfile | 引入成熟 YAML 解析器；不自己写 YAML 引擎 |

不顺手重构 World Framework、Voice、TTS、Provider、Tool Broker、TUI 布局或 Agent Loop 通用推理逻辑。原则是**清理被替代路径，不保留并行 Skill 机制**。已有文件读取、注册、Context Trace、会话持久化功能应复用。

## 12. 验收合同

| 验证场景 | 必须通过的行为 |
| --- | --- |
| 标准 `SKILL.md`、多行 YAML、CRLF/BOM | 索引正确，正文去 Frontmatter，来源可定位 |
| 非法 YAML、缺描述、非法名称、缺名称、目录名不符 | 不能解析/缺描述/无合法名称跳过；仅缺名称可回退合法目录名并警告；名称不符可警告加载；其他有效项不受影响 |
| 项目、近层/远层 `.agents`、Profile、UINA_HOME、全局、Extension | 确定性优先级、归属清晰；A/B Profile 无交叉 |
| 同名/重复 realpath/symlink/深层目录 | 唯一胜出、清晰冲突记录、不循环、不把附属资源误识别为 Skill |
| 无 Skill / 仅手动 Skill / 仅模型 Skill | 无 Skill 时无工具/目录；手动专用无目录但**保留资源 Reader**；模型专用不能 `/skill` |
| 模型目录、工具视图、Context Trace | 最终语义投影的工具被隐藏则目录不出现；当前目录中的可用名称可实际加载 |
| `read_skill` 的正文与附属资源 | 返回资源列表，正文与快照版本一致；附属文本按需读取并分页；二进制/越界拒绝 |
| 仅手动调用的 Skill 含 references | `/skill` 后模型可通过 `read_skill(name, resource)` 继续读附属内容，但不能自行加载其正文 |
| `/skill name args` / `/skill:name args` | 参数、引号、索引/具名占位符正确，错误不变普通 Prompt |
| TUI、stdin、print、Gateway | 同一展开和输入模式；Gateway 不开放任意 Slash；错误可见 |
| `displayText` / 模型正文 | 实时、队列、Rewind、重启回放只显示原命令；真实 Model Request 含完整正文且没有重复原命令注入 |
| Busy 输入、Direct/Steer/FollowUp、输入恢复 | 无重复、无丢失、无消费时读取新版本 |
| 修改 Skill 后 `/reload` | 旧快照在重载前不变；重载后目录与正文同步切换；Extension 卸载不留幽灵目录 |
| 重载期间 Extension 输入 | 不穿越资源替换界限；拒绝/受理事实准确、不会静默丢消息 |
| 跨 Compaction 的持续任务 | 摘要保留仍在进行的 Skill 依赖，可重新读取，任务不因正文被压缩而失去方法 |
| 不兼容执行型 Frontmatter / 动态注入 | 明确诊断，不谎称支持 fork、权限提升或 Shell 注入 |
| 原有 Agent、工具、Compaction、Session 测试 | 无无关行为退化 |

测试必须检查**真实 RequestProjection、Tool Broker 调用、Host 输入事实与 Session 恢复**，不能只比较 Formatter 字符串。优先复用 `tests/context-injection-integration.test.ts`、`tests/extension-runner.test.ts`、`tests/extension-composition.test.ts`、`tests/subject-profile.test.ts`、`tests/input-provenance.test.ts`、`tests/frontend-gateway.test.ts` 等现有测试基础。提交前跑项目现有类型检查、边界检查、相关测试和构建；不为本次开发额外创建证明流程。

对模型使用效果做三个最小对照（固定模型、任务、其他上下文、实际工具权限）：A）**System** 内目录附路径 + 普通 `read_file`（Pi 风格）；B）**System** 内目录附名称 + `read_skill`；C）Uina 固定 **Guidance** 内目录附名称 + `read_skill`。逐项测模型主动正确加载率、误加载率、方法遵循、附属资源读取成功率、额外 Token 与回合数；包含不相关闲聊、领域技能、手动调用与长任务 Compaction。模型效果未经实测不得宣称优于 Pi。

## 13. 完成定义

交付正式内置 Skill 能力、唯一的资源发现和读取路径、通用命令→输入与展示合同、Profile/Extension 来源支持、可用的 `/reload`、旧示例清理及可运行测试。

最终核对五条不变量：**①** 当前请求的 Catalog 与 `read_skill` 工具一致；**②** 同一代次的名称/描述/正文来自同一快照；**③** 手动调用的实际模型正文、操作者展示和 Journal 可以各自准确恢复；**④** 手动专用 Skill 在不开放自动加载正文的情况下仍可读取其 references；**⑤** Extension 卸载或重载后不会向模型暴露幽灵 Skill。

这些不变量闭合后结束施工；不提前实现子 Agent、自动记忆、Skill Workflow、额外资源框架或持续监控。
