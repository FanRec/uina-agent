# Uina 扩展 Prompt 文件机制：设计与实施合同

**实施前提：** 通用信息注入体系已具备 `Context Source → Request Composer → RequestProjection`、请求来源追踪、扩展作用域注销及最终请求检查。实施时以仓库实际接口为准，遵循本文的语义合同。  
**任务范围：** 建立扩展 Prompt 文件编译与固定前缀装配能力；允许对 Composer 的 `guidance` 布局作必要调整。不迁移现有业务扩展，不重构 Agent Loop、Session、Tool Broker、Compaction 或 Provider。  
**交付标准：** 扩展作者能通过一个 Markdown 入口组织多份本地指引；运行时将所有有效扩展指引确定性地装配为 **System 后、会话历史前的一条 `user` 消息**，整个激活期稳定、可检查、可卸载。

## 1. 产品合同

扩展可在自身目录维护模型使用说明，而不必在 TypeScript 中拼接长字符串：

```text
.uina/extensions/speech/
├── index.ts
├── PROMPT.md
└── prompts/
    ├── expression.md
    └── interruption.md
```

```ts
export default async function activate(pi: ExtensionAPI) {
  await pi.provideContext({
    id: "instructions",
    kind: "guidance",
    file: "PROMPT.md",
  });
  // 其他业务能力独立注册。
}
```

`PROMPT.md` 是**明确注册的入口**，不是自动扫描文件。被引用的 Markdown 仅作为该入口的局部片段。扩展不必提供 Prompt；只要内容不影响模型决策，就不应注入。

扩展说明的定位是**能力使用指导**，不是操作者新消息、系统级核心约束、完整业务手册或动态设备状态。扩展无需知道最终 Provider 的消息格式。

## 2. 唯一模型装配合同

### 2.1 请求结构

```text
RequestProjection.messages
  [0] system  — Host 基础合同、主体身份和 Persona
  [1] user    — 固定扩展指南（所有已注册 guidance 合并；可选）
  [...]      — Canonical History / 真实输入 / Tool Results
  [...]      — 当前 capability、observation 等动态上下文

RequestProjection.tools — 当前请求的工具声明（独立于指南）
```

- 有有效扩展 `guidance` 时，Composer **在第一条 System 之后立即插入一条、且仅一条 `user` 消息**。没有有效文本时不创建空消息。
- 所有扩展的文件式与内联式 `guidance` **统一进入这个位置**；不能出现“文件放 User、内联放 System”的双重语义。
- 该消息由 Host 在请求装配时生成，**不进入 Canonical History**，不算真实用户输入，不进入 Input Queue，不触发 Agent Turn，也不在 Compaction 时作为历史被压缩。
- 多扩展内容在同一条 User 消息内分段，**不与历史或其他 Context Source 穿插**。`capability` 和 `observation` 仍使用信息注入体系的动态快照路径，不并入固定前缀。
- 文件内容在成功注册后保持不变，只有扩展重新激活、卸载或显式重新注册 Source 时，后续请求中的固定前缀才变化。`inspection` 不得重新编译文件。
- 固定位置指 **RequestProjection 的逻辑消息位置**。Anthropic 等 Provider 可以合并相邻 User 消息；不为强制物理分隔而伪造 Assistant 回复。Provider Wire 中须保持内容顺序及分段标识。

原有信息注入体系如把扩展 `guidance` 放在 System，本任务应**统一调整该类型的 Composer 路由**；这是本轮必要的基础接缝变更，而非新建一条 Prompt 注入流水线。真正必须遵守的运行时协议仍由 Host System 拥有，不应作为普通扩展 Guidance 注册。

### 2.2 信息角色与权威

| 信息 | 主体语义 | 装配渠道 |
|---|---|---|
| Host 运行时不变量、身份、Persona | 核心运行约束 | System |
| 扩展的稳定用法、惯例、可选建议 | 参考性使用指导 | 固定 User 前缀（`guidance`） |
| 当前可用工具/身体/模式 | 当前能力事实 | 动态 `capability` |
| 世界、设备和活动进度 | 当前观察 | 动态 `observation` |
| 用户请求、外部事件、工具回执 | 已发生的会话事实 | Input / History / Tool Result |

选择 `user` 是为了**不把所有扩展建议提升到 System 权威**，但这不是严格的“软指令”开关：User 文本仍会影响模型行为。Host 应在固定消息首部说明其是运行时提供的扩展指南、不是当前用户命令；扩展作者不应在其中声明与 Host/Persona 冲突的身份、权限或通用规则。外部不可信内容不得通过 Prompt 文件路径装配成受信任指南。

### 2.3 文本布局与排序

所有有效 `guidance` 生成一条内容稳定的 User 消息：

```md
# 已装配扩展指南
以下内容由运行时装配，用于了解扩展能力与使用方式；不是操作者本轮提出的新请求。

## extension:embodiment / instructions
（展开后的指导正文）

## extension:speech / instructions
（展开后的指导正文）
```

- 统一按 `(ownerId, sourceId)` **字典序稳定排序**（不依赖加载先后、读取时序、文件名、注册顺序）。比较方式固定；不要使用随平台区域设置变化的排序。
- 每个 Source 最多一个章节；它内部的 `include` 展开顺序严格由入口文件决定，不再被 Composer 排序。
- 章节标题采用 Registry 中的稳定身份，不暴露绝对路径、激活代次、时间戳、哈希或诊断数据。标题与固定前言由 Host 生成；扩展只负责章节正文。
- 不提供扩展自定义 `role`、`priority`、`before/after` 或全局插槽。内容重叠应由能力所有权和作者修正，不通过排列先后“解决”冲突。
- 保证相同的 Source 集合和相同的文本产生**字节一致的固定 User 内容**。无关的 History、Tool Result、能力快照变化不改变该内容。

## 3. 系统结构与职责

```text
Extension package
  ├─ index.ts ── provideContext({kind:"guidance", file:"PROMPT.md"})
  └─ PROMPT.md ── include ── 本扩展内其他 *.md
                     │
                     ▼
             Prompt File Compiler
              text + metadata
                     │
                     ▼
            Context Source Registry
           owner/id + activation scope
                     │
                     ▼
             Request Composer
          System → Guidance User → History → Dynamic Context
                     │
                     ▼
              RequestProjection
          validate / measure / trace
                     │
                     ▼
               Provider Adapter
```

| 组件 | 唯一职责 | 不承担 |
|---|---|---|
| Extension Loader | 识别扩展入口及可信资源根 | Prompt 解析、角色决定 |
| Prompt File Compiler | 读取本地 Markdown、展开引用、返回内容与来源元数据 | 注入消息、判断在线状态、管理 Prompt 预算 |
| Extension Runner | 绑定扩展作用域、编译后注册 Source、卸载时注销 | 自行改写 System 或构造 User 消息 |
| Context Source Registry | 持有已编译的静态 `guidance` 和源身份 | 读取文件或保管第二份业务状态 |
| Request Composer | 从 Registry 快照装配唯一 User 前缀，保持确定性顺序 | 理解 Markdown 语义、跨扩展自动去重 |
| Request Inspector / Trace | 如实展示前缀正文、来源、位置与 Provider 差异 | 修改请求、写入 Session |

**不新增** Prompt Registry、Prompt Session、Prompt 专用 Context Manager、文件监视服务、Prompt 优先级框架或独立 Provider 注入通道。

## 4. 扩展资源根

文件只允许引用**拥有该 Source 的扩展资源根**下的 Markdown。根目录由 Loader/Runner 在激活时确定，不由 Prompt 自行声明，也不从进程 `cwd` 猜测。

| 扩展形态 | 资源根 |
|---|---|
| 目录扩展：`extensions/speech/index.ts` | `extensions/speech/` |
| `package.json` 的 `uina.extensions` 多入口包 | 对应包目录；入口各有自己的激活作用域、`ownerId` |
| 单独 `.ts/.js` 文件扩展 | 无独占资源根；只可注册内联 Guidance，文件式注册明确失败 |
| 内置扩展 | 仅在装配点明确提供资源根时支持文件式；否则使用内联 Guidance |

保留原 `pi.path`、扩展 ID、单文件加载与既有多入口行为。可给扩展 API 新增只读 `root?: string`，但文件编译器必须使用 Runner 掌握的根，而不是相信扩展提供的任意路径。Loader 可内部新增带资源根的发现描述符，避免大规模修改旧 `discoverExtensions()` 调用方。

根目录与被读取文件均按真实路径检查；根内合法符号链接可用，指向根外的符号链接拒绝。

## 5. 公共 API 与生命周期

复用既有 Context Source 注册，只扩展静态 `guidance` 的内容来源：

```ts
type InlineGuidance = {
  id: string;
  kind: "guidance";
  text: string;
  file?: never;
};

type FileGuidance = {
  id: string;
  kind: "guidance";
  file: string;
  text?: never;
};

interface ExtensionAPI {
  provideContext(source: InlineGuidance): () => void;
  provideContext(source: FileGuidance): Promise<() => void>;
  // capability / observation 的既有注册合同不变。
}
```

实际实现按现有 API 兼容地添加重载；**不让原本同步的内联 Source 注册变为异步**。不允许同时指定 `text` 和 `file`。

注册过程：

1. Runner 校验 Source ID、资源根与文件参数；先完成全部文件读取与编译。
2. 编译成功后，使用原 Registry 原子注册普通静态 `guidance`，仅附加供检查的编译元数据；编译失败不得留下半个 Source。
3. Source 身份为现有 `ownerId/sourceId`；同身份重复注册按 Registry 原规则拒绝，不覆盖、合并或附加一份新消息。
4. 返回的注销函数可提前注销；Runner 同时将其挂到当前扩展 `ResourceScope`，卸载自动释放。异步编译期间作用域若已停用，不得补注册过期 Source。
5. 修改磁盘文件本身不改变已注册文本；扩展 Reload 重新编译、注册和装配。一次已生成的 `RequestProjection` 是不可变快照，不被卸载或 Reload 回写修改。

显式注册的文件发生错误时，Promise 拒绝并给出定位。如果扩展 `activate()` 未捕获，按既有激活失败纪律清理该扩展的注册资源；其他扩展和 Host 继续运行。作者可以自主捕获并降级为内联指导。**不默认静默丢弃错误，也不注入残缺文本**。

### 5.1 注册的职责边界

一个扩展推荐使用单个 `instructions` 文件式 Source 作为入口，其余说明由 `include` 组合；已有 Registry 若支持多个不同 ID 的 `guidance`，仍可使用，最终被合并为同一条 User 消息。没有全局 Prompt 变量命名空间，也没有跨扩展文件包含或隐式依赖。

## 6. Markdown 包含机制

### 6.1 唯一语法

```md
# Speech

{{include:prompts/expression.md}}

{{include:prompts/interruption.md}}
```

语法是**独立成行**的 `{{include:relative/path.md}}`，允许行首行尾空白和 `include:` 后的空格。路径相对于**发起引用的文件目录**解析。一次引用将文件内容**原地展开**；子文件可以再次包含其他文件。

- 只支持本扩展根内的 `.md` 普通 UTF-8 文本文件；不支持绝对路径、URL、glob、环境变量、通用 `{{name}}`、条件/循环表达式、跨扩展路径或任意脚本。
- 根内 `../shared.md` 合法；超出根目录、通过符号链接跳出根目录均拒绝。
- `{{include:...}}` 只有独立成行时展开；嵌在普通句子、行内代码、Markdown 代码围栏（三个及以上反引号或波浪线）中的同形文本为字面量。
- 需在独立一行显示字面指令，可用 `\{{include:...}}`；在围栏之外，编译结果去掉该转义反斜杠而不展开。
- 非 `include` 形式的 `{{...}}` 原样保留，不视为变量引用。
- 同一文件在多个位置被包含，按位置重复展开，**不跨位置自动去重**。包含顺序即作者定义的段落顺序；指令行的前后空白不传递给被包含内容，不自动继承缩进。

### 6.2 编译算法

```ts
async function compile(entry: string, root: string): Promise<CompiledPrompt> {
  // 入口相对可信 root；所有包含文件也必须真实位于 root 内。
  // 每次递归按当前文件追踪调用栈，仅对当前栈检测循环。
  // 逐行扫描围栏与 include，顺序展开，不做跨扩展变量查找。
  // 全部成功后，统一 LF/BOM 归一化、首尾 trim、生成 hash 和 sources。
}
```

- `realpath` 规范化路径后检查根包含关系；循环检测基于**当前递归栈**，不是全局 `visited` 集合。
- 逐行展开并保证引用顺序，不使用会把 Promise 隐式字符串化的异步 `String.replace`。
- 支持 CRLF/LF 输入；统一输出 LF，去除 UTF-8 BOM；保留正文内部 Markdown 空行和缩进。
- 使用严格 UTF-8 解码；拒绝无效编码、目录、缺失文件与其他扩展名。
- 展开过程中累计生成文本超过 **64 KiB UTF-8** 时立即拒绝；这是防止无环重复包含导致意外爆炸的简单上界，**不是建议常驻 Prompt 写到 64 KiB**。Request 的最终 Token 预算仍由既有机制处理。
- 检测到循环、无效引用、缺失文件或过大时，报告入口、触发引用的文件及行号、引用链与原因；**绝不在成环处仅删除占位符，也不产出半成品**。

### 6.3 编译结果

```ts
interface CompiledPrompt {
  readonly text: string;              // 展开后稳定的 Markdown
  readonly hash: string;              // SHA-256(text)
  readonly entry: string;             // 相对扩展根的入口路径
  readonly sources: readonly string[]; // 实际读取文件，按首次访问顺序去重
}
```

这些是编译和诊断信息，**不是新的 Source 类型**。Compiler 可内部保留引用位置以产生错误信息，不设计完整 Source Map 协议。

## 7. Request Composer 与其他机制的协作

### 7.1 精确装配顺序

每次模型请求：

1. 原有 Host/Agent 流程准备 System、History、工具和旧 Hook 结果；既有高级 `turn.transformContext`（包括 Compaction）按已有语义运行。
2. Composer 取得**同一次请求的一份 Registry 快照**，读取已编译 `guidance`，按稳定身份排序，构建或省略固定 User 消息。
3. Composer 将该消息插入**第一条 System 之后、其余消息之前**；再装配动态 `capability` / `observation`，沿用既有动态消息规则。
4. 生成单一 `RequestProjection`，执行原有预算测量、`preflight` 与合法性校验，交给 Provider Adapter。
5. Request Trace 对齐这次实际装配的内容。Provider Wire 若合并相邻 User，保留前缀正文与顺序；不要求物理消息边界一致。

**固定前缀必须位于 Compaction 的历史裁剪范围之外。** `inspectRequest()` 与活动请求复用同一装配函数；空闲预览不冒充某次活动请求。Provider Hooks 仍不能被用作另一条普通 Prompt 注入通路。

这里不要求重写现有 Compaction；若原基础设施将 Source 装配放在旧变换之后，直接复用该时序即可。若实现与此不同，以“Compaction 不能裁掉固定扩展前缀、预算计量必须包含它”为验收约束作最小调整。

### 7.2 稳定性与缓存

- 文件 Prompt 只在扩展激活时读取；普通模型请求和 Inspection 不访问磁盘。
- 同一扩展集合及编译文本下，固定 User 前缀内容逐字稳定；新输入、工具回执、动态观察不得改变它。
- System、扩展指南尽量保持在动态内容之前，有利于支持前缀缓存的 Provider；实际缓存命中还受模型协议、Tool 定义顺序和完整前缀影响，**本任务不做缓存管理器**。
- 多个文件参与编译不意味着模型收到多条消息。Request Token 测量和验证仍只走既有一条路径。

### 7.3 来源与可信度

- Prompt 文件须属于可信的本地扩展资源，路径只能在该扩展根内解析。文件属于运行环境提供的**使用指导**，不是实时世界事实。
- 当前状态、外部聊天、网页、MCP 结果等继续通过原有 Input、Tool Result、`observation` 等渠道交付，不能靠复制到 `PROMPT.md` 自动提高其权威等级。
- `user` 角色不意味着普通用户实际发出了这条消息；Host 的固定标题明确声明来源与用途。
- 若 Prompt 与核心 System 或操作者当前明确请求冲突，应修正 Prompt 的职责边界；不通过 Prompt 内声明优先级或增加隐藏约束来强制覆盖。

## 8. 检查、错误和诊断

沿用既有 Context Source Trace、`inspectRequest()` 与真实请求检查，不新建 Prompt Inspector。

对文件式 Source，开发者能够看到：

| 字段 | 说明 |
|---|---|
| `ownerId/sourceId` | 稳定注册身份 |
| `kind` | `guidance` |
| `entry` / `sources` | 相对扩展根的入口及实际读取文件 |
| `hash` / `chars` | 编译后的内容指纹与长度 |
| `included` | 是否进入当前请求；如无有效文本则说明省略原因 |
| `role` / `position` | `user`；System 后、历史前的固定前缀章节 |
| `renderedText` | 实际展开后参与装配的文本，可通过现有检查能力查看 |

活动 Request Trace 必须能与真正交给 Provider Adapter 的语义请求关联；最终 Wire 追踪可辨别 Provider 是否合并消息或通过 Hook 改写语义内容。**绝对文件路径和编译诊断元数据不写入模型正文或 Canonical Journal**；已存在的诊断界面权限与数据保护策略沿用，不新增遥测上传。

失败只影响本次注册/对应扩展激活；不通过空白占位内容掩盖异常，不阻断其他扩展。编译异常通过已有扩展诊断报告，不需要新增错误队列或状态机。

## 9. 与现有能力的边界及后续减法

本轮**不迁移** Voice、TTS、Embodiment、Live2D、Minecraft、MCP、Skills；不改这些扩展的业务工具、执行状态、事件交付或表演逻辑。文件机制完成后，再按信息性质逐项收敛：

| 当前实现 | 后续收敛方向 | 不可误删的职责 |
|---|---|---|
| `world-framework/world-activation.ts` 的 `registerEnvironmentGuide` / System 字符串追加 | World 获得具名、可激活的 `guidance` Source 后移除专用拼接；若有文件入口，按其 World/扩展资源根装配 | 实时世界观察与异步任务完成通知 |
| `.uina/extensions/mcp/index.ts` 的 `buildCapabilityIndex` / `turn.prepare` 拼接 | 静态 MCP 使用规范可写 `PROMPT.md`；当前服务目录成为动态 `capability` | 服务发现、权限与连接状态 |
| `examples/extensions/skills/index.ts` 的技能目录注入 | 常驻短目录改为 `capability`；完整 Skill 继续按需阅读 | 技能检索、读取和任务级指导 |
| Voice/TTS 把正文朗读、诊断、维护步骤混放在 Tool Description | 稳定表达合同进入 Speech Prompt；工具保留操作契约；运行状态走 `observation` | TTS 交付、播放证据和故障恢复 |
| Embodiment/Live2D 的 `<cue>` 使用指导散落在 Tool Description | 由表达能力所有者维护统一 `guidance`；动态 Cue 目录走 `capability` | 实际动作执行与 Cue 解析 |
| 旧 `turn.prepare` 普通 System/消息拼接 | 所有依赖迁移后删去普通注入用途 | 回合控制与模型选择等独立职责 |
| 旧 `turn.transformContext` 用于普通状态追加 | 迁移到 `capability` / `observation` 后删去该用途 | Compaction 等确需整体改写投影的高级操作 |

`PROMPT.md` 不替代 Input Queue、Event Frame、Session、Tool Result 或 Skills。它只让**静态扩展指导的作者体验和模型装配**更统一，不承诺解决所有能力可见性或工具选择问题。

## 10. 交付范围与实现次序

### 本轮修改

1. **Loader / Runner：** 明确扩展资源根；给 `provideContext` 增加文件式 `guidance` 重载并接入激活作用域。
2. **Prompt File Compiler：** 本地 Markdown 读取、独立行引用、递归展开、循环与路径校验、稳定文本编译、来源元数据。
3. **Context Composer：** 将所有扩展 `guidance` 统一装配为 System 后的单条 User 固定前缀；保持动态 Source 与 History 独立。
4. **Trace / Inspection：** 展示已编译文件来源、固定 User 消息、位置及真实请求差异；复用现有诊断通路。
5. **测试与文档：** 覆盖真实 `RequestProjection`、Provider 适配、编译失败、作用域卸载、Reload、无文件扩展等场景；提供一个小型示例扩展。

### 明确不做

不修改业务扩展的具体 Prompt、工具或事件逻辑；不重写 Agent Loop/Compaction/Provider；不引入全局变量表、跨扩展 include、表达式模板、文件监听、Prompt 搜索、自动语义去重、动态 Markdown 插值、额外 Prompt Journal 或新 Context 框架。

### 建议实施顺序

先对齐实际 `ContextSource` / Composer API，完成 **固定 User 前缀的统一路由及测试**；再实现文件 Compiler 和 Runner 注册；最后补来源 Trace、端到端 Provider 检查与示例。不要把“兼容旧的 System Guidance”做成永久双路，由同一个 Composer 一次性统一语义。

## 11. 验收标准

| 编号 | 可验证事实 |
|---|---|
| A1 | 未注册 `guidance` 时，不新增 User 消息；现有 History、Tool、动态 Source 和其他能力的行为不变。 |
| A2 | 有内联或文件式 `guidance` 时，`messages[0]` 为 System，`messages[1]` 为**唯一的扩展指南 User**，随后才是历史；它不进入 Journal、不触发新回合。 |
| A3 | 同样的源集合无论激活顺序如何，固定 User 的文字、章节顺序和位置完全一致；History、动态状态改变不改变该 User 正文。 |
| A4 | 文件式与相同正文的内联式 Guidance 装配语义一致；多个文件只贡献一个 Source 章节，不为每个 include 创建消息。 |
| A5 | 多级相对包含、根内 `../`、合法重复引用、转义、围栏代码、CRLF 与 UTF-8 BOM 的结果符合合同。 |
| A6 | 循环、缺失引用、无效 UTF-8、非法路径、根外符号链接、文件过大均准确报错；不向模型发送残缺文本。 |
| A7 | 目录扩展、多入口包的资源根正确；单文件扩展使用内联 Guidance 不受影响，使用无根的文件式 Guidance 明确失败。 |
| A8 | 扩展卸载后的**下一次请求**不再含其章节；编辑文件不立即改变已注册内容；Reload 后使用新文本及哈希。 |
| A9 | 任何注册失败都不遗留半份 Source 或悬空注册；其他扩展可正常工作，作用域关闭后不可补注册。 |
| A10 | 固定前缀在 Compaction 历史裁剪之外；预算/`preflight` 计算真实加入前缀后的完整请求；`inspectRequest` 与真实装配函数同源。 |
| A11 | 对 OpenAI 兼容格式、Anthropic 等已支持的 Provider，实际 Wire 保留 System→扩展指南→历史的语义顺序；允许 Provider 合并相邻 User，但不丢正文、改变顺序或伪造 Assistant。 |
| A12 | Trace 能对账 Source、入口文件、依赖、哈希和消息位置；模型正文不包含绝对文件路径或内部诊断信息。 |
| A13 | 没有第二套 Context Composer、Prompt Registry、全局变量池、自动模板求值、热更新监听、提示词权重或额外 Prompt 历史。 |

**完成定义：** 扩展显式注册 Markdown 入口后，文件被一次性编译成普通静态 `guidance`；所有扩展指导稳定、成组地位于 System 之后和会话历史之前的单条 User 消息中；来源、顺序、预算、真实 Provider 语义与扩展生命周期可检查；未迁移的业务扩展继续按原有接口工作。
