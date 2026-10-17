# Subject Runtime 重构提案 v6 · 最终执行稿

状态：**提案 v6，已授权；P5–P8 已完成**。本文仍是唯一有效施工规格；这些阶段表记录的是重构计划与完成情况，不表示后台任务/子代理仍存在。决策档案见 `subject-runtime-decisions.md`（非规范，仅供审计）；历史接缝审计已归档至[接缝清点](../archive/proposals/seams-inventory.md)。当前接口还应结合 `docs/current-runtime.md` 核对，例如现行 `turn.preflight` 接缝。

目标：把 Uina 重构为**最小、稳定、可持久化、具有强直接接缝的 Agent/Subject Runtime**——让未来出现今天完全没想到的能力时，尽量不需要修改 Core。

---

## 1. 架构铁律

| #  | 铁律                                                                                            | 说明                                                                                                                                                                                                                                                                                                             |
| -- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 | 一个语义只有一个**干预入口**；一个事实只有一个权威表示与**观察出口**                                                        | **Hook ≠ Event**：Hook = 系统问扩展"你要不要影响这件事？"；Event = 系统告诉世界"这件事已经发生了"。`before_*`/`should_stop` 等干预形状不得混入事实事件流                                                                                                                                                                                                     |
| L2 | 能力 ≠ 插件：标准是**不依赖 Core 特权**                                                                    | 内置能力 = preinstalled capability，与第三方同 API 面；但 Rewind 可依赖 lineage/安全点/原子历史转换这类 Session 基本语义                                                                                                                                                                                                                      |
| L3 | **事实严格，解释自由**                                                                                 | canonicalReplay（Core，不可替换）强制：**record legality / lineage / 工具因果 / active canonical state / unresolved-operation detection**。crash 后需要追加什么事实是 planRecovery 的决策，且必须持久化后才成为 canonical fact。projectHistory / transformContext / convertToLlm 是自由接缝（每请求态），失败只报 provider 错、不伤 journal                                |
| L4 | 进 Core 过四关：不可避免性 / 通用性 / 正交性 / 最小性；成公开接缝过第五关：派生能力                                             | 派生能力 = 至少一个真实高级能力不再修改 Core                                                                                                                                                                                                                                                                                     |
| L5 | 路径审查：Extension → Direct Seam → Primitive → Canonical Event/Fact                               | 中间 Adapter/Host/转发层逐层质询"删掉我损失哪一种无法表达的语义"；"解耦/统一管理/以后方便"不算答案                                                                                                                                                                                                                                                    |
| L6 | **接缝必须三选一**：Replacement（整层机制替换，同时只有一个 owner）/ Interceptor（有明确顺序与合并规则的链）/ Observation（多播，无返回值） | projectHistory / convertToLlm / streamFn 属 Replacement——只许一个 history policy owner，**不做 contributor chain、不造 ProjectorPipeline**；transformContext / beforeToolCall / transformResult / turn.prepare 属 Interceptor（merge 规则写入各自契约）；Events 属 Observation。单 owner 的执行机制 = 现有 Registrations 栈式 replace + dispose 恢复 |

**分工一句话**：Core 管真相；Capability 管策略；Projector 管整层解释；Interceptor 管局部组合；Event 只报告已发生的事实。

**Replay 不能制造事实。** replay 只解释已经发生的；修复与补偿是 Recovery 的决策，且必须持久化后才成为事实。

## 2. 目标内核形态

**目录 allowlist**：agent / session / core / tools / runtime 五目录，禁止 import host/extensions/ui/ai 配置层。  
**Core Concept Allowlist**：Subject、Mailbox、Model invocation、Tool execution、Canonical history、Durable journal、Hooks、Events。（目录门拦不住 core/ 变垃圾桶，概念门拦得住。）

**canonical 链**：

```text
Journal Records
      ↓
canonicalReplay(records) → CanonicalState     ← Core，严格，不可替换
                                               解释 CanonicalRecord；登记 AuxiliaryRecord（opaque）
      ↓
CanonicalState（含未决操作）───→ planRecovery()   ← pure，crash 修复决策，不进 reducer
      ↑                                │
      └──── 恢复记录经 commitCanonicalTransition 落盘
      ↓
projectHistory(时间线条目, canonicalState)    ← Replacement seam，单 owner，大半径极少使用
      ↓
Agent History
      ↓
convertToLlm()                                ← Replacement seam（provider 边界）
      ↓
transformContext()                            ← Interceptor seam（每请求最后触；
                                               Compaction / Memory / RAG 在此共存）
      ↓
provider
```

**canonicalReplay 契约**：pure、deterministic、no I/O、no hooks、no extension code、no model、no policy；**一个 reducer、一个事实状态机**——内部可拆函数但只服务同一 reducer；派生查询（safeTargets、settled、queue state）一律从 CanonicalState 计算，**禁止第二个 journal walker**。它**解释** CanonicalRecord、**登记** AuxiliaryRecord（opaque 挂时间线，供 projector 与展示消费），**不做修复**。

**单 reducer 双形态（增量 vs 折叠）**：`reduceRecord(state, record) → nextState` 是**唯一解释器**——legality 校验内嵌于步骤（非法即 throw SessionFormatError，不产出非法状态）；`canonicalReplay(records) = fold(reduceRecord, initialState, records)`，即**同一个 reduceRecord 从头折叠**，仅用于启动、校验与测试，不构成第二解释器。热路径一律增量：正常运行 O(1)/record；全量 fold 只发生在启动与不变量测试。

**planRecovery 契约**：输入 = CanonicalState 中的未决操作；输出 = 恢复记录（如 `tool_finished(status=unknown)`、合成 tool 消息）；pure、deterministic、no I/O，**独立于 reducer**；产出必须经 commitCanonicalTransition 持久化、再 replay 收口——恢复决策因此成为被记录、可审计的事实，而非每次回放隐式重算。现 `recoverRecords(records, settleTail)` 的拆分蓝图：replay 部分进 reducer，`settleTail`/`closePending` 部分进 planRecovery。

**planRecovery 前缀安全 + 幂等**：一次 plan 可能产生多条恢复记录；每条必须有稳定 identity（现 `recovered:${originId}:${callId}` 即胚胎），已落盘的恢复事实不得重复生成；执行计划的**任意前缀**后再 crash，下一次 replay + planRecovery 必须能从该处继续（planRecovery 是未决状态的纯函数——已持久化的恢复记录缩小未决集，幂等随之成立）；且**每条恢复记录单独提交后 CanonicalState 都必须合法**。**幂等是结构保证而非算法自觉**：已接受 recovery identity 的索引归 CanonicalState/reducer 管（现 recordIds 去重即胚胎，recovery.ts:268-271），reducer 拒绝非法重复，planRecovery 从 state 派生、天然不再生成已落盘项。禁止为此发明 Journal Transaction / RecoveryBatch——前缀安全 + 幂等就够了，事务框架是 Core 膨胀。

**持久化双原语**——静态分类，分类单位是 record kind **与 event name**，不是 envelope；**两者持久化强度相同（均 durable append + fsync）**，唯一区别是语义效果：

| 记录                                                                                                            | reducer 行为                                            | 原语                                  |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| message / input / custom_message / rewind                                                                     | 解释                                                    | `commitCanonicalTransition(record)` |
| event：queue_enqueued / queue_consumed / queue_restored / tool_started / tool_finished（**CanonicalEventName**） | 解释                                                    | `commitCanonicalTransition(record)` |
| event：turn_failed / turn_aborted                                                                              | 仅登记（现 `applyEvent` 对二者即 break，recovery.ts:493-495 在案） | `appendRecord(record)`              |
| custom_entry 与 capability namespaced 记录（如 `uina.compaction.summary`，P6 落地）                                  | 仅登记                                                   | `appendRecord(record)`              |
| compaction                                                                                                    | legacy：迁移期由 legacy 读取器解释，新写不产生（随 P6 裁定）               | —                                   |

**CanonicalState 双部分模型**：**semantic state**（仅 CanonicalRecord 可改）+ **auxiliary timeline**（AuxiliaryRecord 的 opaque 登记处，供 projector 与展示消费）。

事务（**增量语义，禁止每提交全量 replay**）：`commitCanonicalTransition(record)` = validate(schema) → `next = reduceRecord(currentState, record)`（预演：纯计算，失败即 throw、不落盘）→ durable append(+fsync) → 原子 swap(next)；`appendRecord(record)` = validate(schema) → `next = reduceRecord(currentState, record)`（semantic state 不变，仅 auxiliary timeline 追加）→ durable append(+fsync) → 原子 swap(next)。热路径 O(1)/record；全量 canonicalReplay fold 仅用于启动、校验与不变量测试（长期 Subject 下每提交全量 replay 累计 O(N²)，禁止）。事务只依赖 Core 语义；自由接缝永远不能破坏 durable truth。

**appendRecord 的内存同步语义**：落盘后必须同步登记进内存 timeline——否则运行期 projector 看不到该记录、重启 replay 后突然可见，直接破坏 replay ≡ memory。登记**不是** transition：不改变 semantic state，只同步 opaque timeline。双原语由此闭环。

**event 粒度规则**：类型形态为 `CanonicalEventRecord<EventName extends CanonicalEventName>`——分类到 name 级。封闭 event 枚举只收 canonical lifecycle facts；telemetry / 扩展诊断 / UI audit / provider timing 一律走 auxiliary namespaced record，**禁止包装成 event record 混入 canonical 词汇**。

**数据模型原则**：

| 意图                        | 记录形态                        | 分类                         | 原语                        |
| ------------------------- | --------------------------- | -------------------------- | ------------------------- |
| Core 语义事实                 | 封闭 SessionRecord            | Canonical（event 按 name 分派） | commitCanonicalTransition |
| Capability 私有/持久状态（模型不可见） | namespaced **custom_entry** | Auxiliary                  | appendRecord              |
| Capability 有意让模型看见的消息     | **custom_message**          | Canonical                  | commitCanonicalTransition |

**custom_message 语义重**：它改变 Agent 所认为的对话事实——禁止当"方便存点数据"的口袋用；存数据一律 custom_entry。extraction 证伪的 Core record → legacy 只读兼容 + 新写 namespaced（P0 迁移器承接）。

## 3. 分阶段实施（每阶段独立提交、全量门 + CRAP gate 保持）

| 阶段                         | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 验收                                                 | 风险                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------- |
| P0 冻结+前置                   | 基线跑绿；双 allowlist（目录+概念）入 AGENTS.md + boundary 门；**flaky 处置纪律**：quarantine 允许，但必须记录"原因未确认" + 建专门复现任务 + 明示 quarantine ≠ 修复——重构的恰是并发/队列/持久化/crash/tool lifecycle，flaky 可能是真 race 的报警器；journal schema version + 迁移器骨架（行为不变）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 门生效；schema version 就位；flaky 台账建立                   | 无                      |
| P1 事件词表归一（Hook≠Event）      | HostEvent 14 类退役；27 变体分类表（干预形状转 hook 专属词汇 + **各 Interceptor 链合并规则文档化**、事实变体留单流）；消费者迁移                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 双词表消失；干预/事实各一词表；每条链组合语义成文（L6）                      | UI 消费者迁移面大             |
| P2 语义去重（不新增公共承诺）           | registerContextContributor 退役（并入 turn.prepare hook / transformContext）；runtime-hooks 适配层压扁评估（guard/freeze 保留）；BuiltinServices/BuiltinUI 并入 pi 面；takeQueuedForEditor → mailbox peek/claim/release 原语 + UI 组合；Compaction 仅内部路径收敛（旧压缩器槽与 beforeCompact hook 冻结不扩约；P6c 已整体退役）                                                                                                                                                                                                                                                                                                                                                                                                                         | inventory #2#5#6 清零；无新 API 债务                      | 扩展兼容迁移                 |
| P3 canonical replay + 投影接缝 | canonicalReplay 落地（recoverRecords 泛化为单 reducer + **safeRewindTargets 并入为派生查询**；**解释/登记分离**；纯度契约生效）；**reduceRecord 增量形态**（热路径 O(1)/record，canonicalReplay=同一 reducer 的 fold，仅启动/校验/测试）；**planRecovery 分离**（crash 结算决策独立于 reducer，恢复记录经 commitCanonicalTransition 落盘——从隐式重算变为可审计事实；**前缀安全 + 幂等**：稳定 identity、任意前缀后 crash 可续作、逐条提交后 state 合法；recovery identity 索引归 reducer 结构化管理）；**CanonicalRecord / AuxiliaryRecord 静态分类**双原语（event 到 name 级；appendRecord 含内存 timeline 同步）；projectHistory / convertToLlm 可注入（**Replacement 单 owner**，先只做测试双实现）；**replay ≡ memory 不变量测试**（每个 commitCanonicalTransition 与 appendRecord 提交点均成立，覆盖 semantic state 与 auxiliary timeline；定期全量 fold 抽查对照）；rewind 连续性提示措辞改 renderable | 双路径漂移有机器守卫；journal walker 唯一；恢复决策可审计；热路径无全量 replay | 最敏感一阶段                 |
| P4 Host/UI 组合清理            | 生命周期守卫/进程追踪挂点外移 host；编辑器队列语义迁 UI；内核行数复核                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 宿主编排零残留                                            | 低                      |
| P5 Rewind 提取实验             | ✅ 已完成（2026-09-18，报告：rewind-extraction.md）。裁定**结局 A**：cut=canonical 结构事实（主线截断是持久事实+因果校验是 reducer 职责+进 CanonicalState 的派生必须确定性），record 留封闭 schema；命令/文案已在 capability；携带策略与 notice 散文为成文候选（第二 owner 出现时沿 ProjectionPolicy 先例注入）；safeTargets 交互四条成文；Mod-Surface=0 行 / Cog-Surface=3 概念 | 实验报告 + 全量门绿 ✅ | 中；journal 兼容由 P0 迁移器兜底 |
| P6 Compaction 提取实验 ✅      | 默认压缩端到端下沉 official compaction capability。**终态语义（P6b/c 裁定，勿回退）**：唯一入口 = `turn.transformContext` 每请求裁剪——超预算时按 keepRecent 语义裁剪当前请求上下文，滚动摘要紧随 leading system 注入；摘要 = `uina.compaction.summary` custom entry（Auxiliary，锚定主线头 entry id，rewind-proof），journal 保留全量历史、不写 canonical compaction record；手动 /compact = capability 命令（force + instruction，无下一请求则无压缩对象）；阈值体检按**裁剪后上下文**估算（否则反复触发）；与 Memory/RAG 经同一条 Interceptor 链共存，**不占用 projectHistory**；core/compaction.ts 与 agent/compaction.ts 全删，registerCompactor/beforeCompact 退役，hook 词汇九→八条 | Core 零压缩词汇；projectHistory 无 capability owner | 依赖 P3 |
| P7 Jobs/Subagent 特权审计 ✅   | 不搬代码：证明无 Core 特权——import 审计（零 SessionStore/journal/投影内部访问）、无专属 hook/后门（0 onHook/registerCommand，能力面全经宿主装配注入）。**事实通道（§5.9 裁定修订原稿）**：任务事实 = ToolEffect（task.dispatch + externalOperationId）声明 + 宿主装配消费 generic effects（回溯放弃集合 collectAbandonedTaskIds）；不使用、也不需要 uina.jobs/* custom record——jobs 是进程内 in-flight 状态而非 durable 状态，crash 后不伪造恢复（L3：Replay 不能制造事实）；未来真 durable 需求由 capability 经 pi.appendEntry（custom entry，Auxiliary）自恢复，Core 零改动 | 审计报告（§5.9）；派生测试 #8 过（Mod=0 Core 文件，Cog=3 概念） | 低（已达标）               |
| P8 清算+终验 ✅                | 遗留抽象删除（含 legacy record 清理策略）；L4 五关走查全部接缝；派生测试清单（§4）**双维度报告**；**终局验收七问 + 残酷审查（§5）**；思想实验；行数预算复核（结果指标）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 七问全过                                               | 无                      |

## 4. 派生测试验收清单（双维度）

每个故事只准用接缝讲完实现路径，讲不完 = 接缝缺口，改接缝不改 Core 逻辑。**每个故事报告两个维度：Modification Surface（改多少 Core）与 Cognitive Surface（须理解多少 Core 概念）。Cognitive Surface ≤3 是 heuristic 不是硬门**——评审同时检查每个概念本身是否足够小（一个巨大的 UinaContext 也算"一个概念"是自欺）。

1. 成本切换：运行中按预算换模型/换档 → turn.prepare
2. 工具中途注入上下文/拦截危险调用 → transformContext + tools.beforeCall
3. 自定义压缩策略/接管 → capability 经 **turn.transformContext 每请求裁剪 + pi.models.stream 生成摘要 + pi.appendEntry 落 Auxiliary entry**（不占用 projectHistory；P6 实证）
4. 远程/无头消费同一会话 → 事实事件单流订阅 + SessionStore 可插拔
5. 全新工具形态（MCP 桥、远端执行）→ registerTool + Operations 级替换 + 投影 seam
6. 重启后行为一致 → journal 回放（replay ≡ memory 不变量测试）
7. 分支/检查点：只经 **P5 最终裁定留下的 canonical history primitives** + 公开投影/持久化接缝实现；Core 不出现 branch/checkpoint 特定语义
8. 后台任务 crash 恢复：任务事实 = ToolEffect（task.dispatch）声明 + 宿主装配消费 generic effects（回溯放弃集合）；jobs 为 in-flight 非 durable，重启不伪造恢复——**不发明 Core GenericJobProtocol**（P7 实证，§5.9）

## 5. 终局验收：七问 + 残酷审查（P8 执行，替代"功能全部迁移"作为最终标准）

编码质量不会因架构正确自动变好。重构完成的验收不是"功能迁完了"，而是：

| # | 问题 | 通过标准 |
| - | -- | ---- |


| 1 | 读 Subject 主循环，需要同时打开 Host / ExtensionHost / Session 的实现吗？ | 自上而下几分钟可读：input → prepare → canonical history → project context → model → tools → continue/stop 一屏讲完；Session/Host 仅以类型引用出现，控制流不依赖其实现 |  
| 2 | 实现一个新 capability，通常要改几个 Core 文件？ | 常规 **0**；确需新接缝时只改接缝定义、不改 Core 逻辑（且过 L4 第五关） |  
| 3 | 同一行为有没有第二种实现路径（context 注入 / 事件 / 压缩 / UI）？ | 原则上没有——L1 的机械化审计：逐行为列出实现路径，路径数 >1 即病 |  
| 4 | 每个 Core abstraction 能否一句话解释它为什么不可删除？ | 解释不了就继续删；一句话必须落到具体语义，"解耦/统一管理/职责清晰"不算答案 |  
| 5 | Rewind、Compaction、Jobs、Subagent 能否主要由公开 seam 推导出来？ | 最重要的实证；由 P5/P6/P7 实验报告 + §4 派生测试回答 |  
| 6 | 删掉某个官方 capability 后，Subject 本身是否仍然完整成立？ | **减法测试**（派生测试的加法对偶）：内核可启动、可跑回合、工具可用、journal 持久。既有会话中的 rewind/compaction 记录仍由 canonicalReplay / legacy 读取器正确回放——删 capability 不断旧会话 |  
| 7 | 代码里还有大量"为了架构而存在的类"吗（Manager / Coordinator / Adapter / Bridge / Service）？ | 逐个质询，每个类型过 #4 的一句话测试；不是名称有罪，是解释不出具体语义才有罪 |

**残酷审查（最后一步）**：对每个类型/接口/层问——"假设今天重新写 Uina，它还会被主动设计出来吗？"答案若是"主要因为历史兼容 / 当前实现已经这样了"，继续清理。

**预期管理（防错误目标函数）**：终态**不是**"比 Pi 更简单的 Uina"。Pi = 极干净的 Agent Harness；Uina = 同等级直接的 Subject Runtime **+ 一层必要的 durable semantics**。源码总量、Session、recovery 大概率仍比 Pi 重——这是持久语义的必要成本，不是失败。验收对象是**局部认知负担**：turn.prepare / projectHistory / transformContext / tools.beforeCall / tools.transformResult / 事件订阅——看见接缝，就知道在哪里改。这比总代码量重要得多。

## 6. 不做什么

- 不学 Pi 的 public 可变钩子字段（与 guard 所有权纪律冲突）；不砍 ResourceScope/guard
- **不开放 journal schema**（封闭事实类型 + 开放 custom kinds + event name 级分类是可回放性根基）
- 不追 Pi 的系统规模；不做大爆炸重写（P1→P6 本身就是按能力切片的串行重写）
- 不把 ToolEffect 改成第二套万能事实（开放 effectType + data 已足够）
- 不发明 Core GenericJobProtocol / DurableActivity / Task DAG
- 不为投影自由放弃 canonicalReplay 校验；不为将退役的概念升级公共协议
- 不做机械单事件词表（Hook 与 Event 各一词表、各一出口，混居才是病）
- **不造 ProjectorPipeline**：projectHistory 是 Replacement seam，单 owner（Registrations 栈执行），不做 contributor 化
- **不让所有持久事实都走 canonical transition**：durable storage 与 canonical conversation transition 是两个原语，强行绑定既浪费又错误
- **planRecovery 不进 reducer**：replay 解释已发生的事实，recovery 决定因 crash 还需追加什么事实——合体就是下一个 God Function
- **不发明 Journal Transaction / RecoveryBatch**：恢复计划以前缀安全 + 幂等达成，任意前缀落盘后 state 仍合法——不需要事务框架
- **不做每提交全量 replay**：热路径只走 reduceRecord 增量步（O(1)/record）；canonicalReplay 全量 fold 仅启动/校验/测试
- **projectHistory 保持大半径、极少使用**：普通 capability（含官方 Compaction）默认不占它；占用它 = 宣告"我要替换整层历史解释"
