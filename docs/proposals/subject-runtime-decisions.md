# Subject Runtime 重构决策档案（非规范）

**声明**：本文记录 v1→v6 最终规格的形成过程（八轮评审/修订逐条裁定 + 版本沿革），仅供审计与回溯。**施工规格以 `subject-runtime-plan.md` 为唯一有效版本；两者冲突时以 plan 为准。** 接缝审计已归档至[接缝清点](../archive/proposals/seams-inventory.md)。本文包含当时 Jobs/Subagents 可用的历史陈述；这些能力已于 2026-10-06 从当前运行时移除，不能据此推断仍在装配。P3/P5/P6 的实现过程以历史材料理解，不再继续纸面迭代。

---

## 版本沿革

### v1（初版）
最小内核 + 强直接接缝：三判断对抗性裁定（病灶=边界不干净非东西多）、四形容词→验收判据、内核 allowlist（agent/session/core/tools/runtime）、P0–P5 六阶段、三条"不做什么"（不学 public 可变钩子、不砍 ResourceScope、不开放 journal schema）。

### v2 相对 v1
采纳：语义坍缩；"能力≠插件"；commit 严格/投影自由；四关+第五关；投影接缝；commitHistoryRecord；回放一致性测试；提取实验方法论；journal schema 版本化。拒绝：journal schema 开放化；ToolEffect 重造；大爆炸重写。事实修正：ToolEffect 已开放（Phase 3）；Jobs/Subagents 已在扩展层；内核零工具名知识；投影链已存在（agent/projection.ts）。补充 S1–S5：journal schema 版本化、replay≡memory 守卫、flaky 前置、rewind 文案 renderable、串行重写形态。

### v3 相对 v2
采纳：canonicalReplay/projectHistory 分层（rewind cut=结构/head 归 Core，compaction=呈现归 projector）；事务顺序改为预演 canonicalReplay→落盘→原子换内存；P2 不升级 beforeCompact 公共协议；数据模型原则；Hook≠Event 分类；mailbox claim 原子性留 Core；Core Concept Allowlist。修正：rewind 归属不预设（P5 两结局）；transformContext 保持现位置（convert 之后）；replay 测试归 P3。阶段重排 P0–P8。

### v4 相对 v3
采纳：L6 接缝组合三分类（Replacement 单 owner=Registrations 栈 / Interceptor 有序链 / Observation 多播）；canonicalReplay 纯 reducer 契约（在案证据：safeRewindTargets recovery.ts:611 已是第二个 journal walker）；持久化双原语 appendRecord/commitCanonicalTransition；派生测试 #7 去预设；Cognitive Surface 第二验收维度。细化：custom_message 属 canonical transition、custom_entry 不属；compaction 提交类别由 P6 裁定。

### v5 相对 v4
采纳：终局验收七问替代"功能全部迁移"（读 Subject 不开 Host/Host 层实现、新 capability 0 Core 文件、路径唯一性审计、一句话不可删除、seam 推导实证、减法测试、Manager/Adapter 逐个质询）+ 残酷审查（"今天重写还会主动设计它吗"）+ 预期管理（不追总量轻于 Pi，追局部认知负担对齐 Pi）。

### v6 相对 v5
采纳：canonicalReplay 与 crash recovery 分离（planRecovery 独立，恢复记录经 commitCanonicalTransition 落盘——恢复决策从隐式重算变为被记录事实；在案证据：recoverRecords(settleTail) 即 replay+repair 合体，recovery.ts:62-97）；判别式改静态分类 CanonicalRecord/AuxiliaryRecord（no-op transition 反例否决"输出是否变化"扩展式判别）；Compaction 不占用 projectHistory（改经 prepareTurn+appendRecord+transformContext，v4 P6 的"持久化原语+projectHistory 投影"确认为最大隐患）；Cognitive Surface ≤3 定位 heuristic；flaky quarantine 纪律。最终执行稿重构：正文与决策档案分离（本文）。

---

## 评审裁定记录

### 第一轮（《Uina Core 重设计总纲》+《微内核纠偏》）

| 主张 | 裁定 | 证据 |
|---|---|---|
| HostEvent 第二词表该砍 | 成立 | host/events.ts 14 类；runtime-hooks.ts 转接 |
| registerContextContributor 砍 | 成立 | 三路径并存（inventory §5.1 #2） |
| ToolEffect 改万能 DurableFact | **过时**：Phase 3 已实现等价物且更克制 | core/types.ts:22-31（effectType 开放字符串+externalOperationId?+label?+data?） |
| 删封闭 record 换 appendCustomRecord | **反对**：封闭 schema 是可回放性根基 | recovery.ts isRecord / recoverRecords |
| JobRegistry/SubagentRegistry 移成扩展 | **事实错误**：已在 src/extensions/ | host.ts:11-12,160,204 仅装配 |
| usage/队列/编辑器 claim | 部分：UsageTracker 留（与安全点交织）；队列所有权留（对齐 Pi）；编辑器语义外移成立 | 记录 2026-09-17 |
| DurableFact 泛化警告 / 不强制插件化 / Rewind 不预设结论 / Pi 是标尺 | 采纳 | 化为 L1–L4 |

### 第二轮（5 关键点 + 2 小点）

| # | 主张 | 裁定 |
|---|---|---|
| 1 | projectHistory 与 L3 冲突，拆 canonicalReplay（严格）+ projectHistory（自由） | 采纳+细化：rewind cut=结构/head（Core），compaction=呈现（projector）；recoverRecords≈canonicalReplay 胚胎 |
| 2 | commitHistoryRecord 顺序错误，应预演 replay→落盘→原子换内存 | 采纳；事务只依赖 Core 语义 |
| 3 | P2 不升级 beforeCompact 公共协议 | 采纳；registerCompactor/beforeCompact{cancel?} 冻结不扩约（inventory #3 注记改判） |
| 4 | 零压缩词汇 vs 封闭 schema 矛盾，需数据模型原则 | 采纳原则+修正：rewind 归属不预设，P5 两结局 |
| 5 | Hook≠Event，干预点不进事实事件流 | 采纳；已核实干预语义混在事件名上（events.ts:12,68,70 + host.ts emit* 结果协议） |
| A/B | mailbox claim 原子性留 Core；Core Concept Allowlist | 采纳 |

### 第三轮（4 点 + 1 验收维度）

| # | 主张 | 裁定 | 说明与证据 |
|---|---|---|---|
| 1 | 缺"接缝组合语义"铁律；projectHistory 若可多注册将长出 ProjectorPipeline | 采纳为 L6 | 三分类与现有实践同构（Registrations 栈/emit 链/事件），零新机器；emit 链合并规则（message 累计/后写覆盖/任一取消）随 P1 分类表文档化 |
| 2 | canonicalReplay 防 God Function：pure/deterministic/no I/O/no policy，单 reducer，禁止多函数各自解释 journal | 采纳，在案证据 | safeRewindTargets（recovery.ts:611）已是第二个独立重走 journal 的 walker；裁定并入 reducer 为派生查询。isRecord 保留为逐记录校验（非竞争解释器） |
| 3 | commitHistoryRecord 职责太宽：durable storage ≠ canonical transition | 采纳，一分为二 | appendRecord / commitCanonicalTransition；划分线="reducer 是否消费"而非"capability 与 core" |
| 4 | 派生测试 #7 预设了 P5 结果（预名 head 原语） | 采纳，逻辑矛盾属实 | 改述为"P5 最终裁定留下的 canonical history primitives"，不预名 primitive |
| 5 | 验收需第二维度 Cognitive Surface | 采纳 | Modification Surface + Cognitive Surface 双维度 |

### 第四轮（终局验收与预期管理，非架构主张）

采纳：§终局验收七问（读 Subject 不需打开 Host/ExtensionHost/Session 实现；新 capability 0 Core 文件；路径唯一性审计；抽象一句话不可删除；seam 推导实证；**减法测试**=删官方 capability 后 Subject 仍完整且旧会话可回放；Manager/Adapter 逐个质询）+ 残酷审查 + 预期管理（终态=同等级直接的 Subject Runtime+必要 durable semantics，总量/Session/recovery 仍比 Pi 重是必要成本，验收对象是局部认知负担）。七问关系：#3=L1 机械化审计、#5=派生测试、#7=L5 类型级版本、#2=Cognitive Surface 定量化；新价值在 #6 减法测试（派生测试的加法对偶）与"几分钟看懂主循环"硬门槛。

### 第五轮（3 点 + 2 小点）

| # | 主张 | 裁定 | 说明与证据 |
|---|---|---|---|
| 1 | canonicalReplay 与 crash recovery 混杂：结算不是 replay，塞进 reducer 会重新长成 God Function | 采纳+强化 | 在案证据：recoverRecords(settleTail) 即 replay+repair 合体（closePending 合成 unknown/not_started，recovery.ts:62-97）。planRecovery(未决)→恢复记录→经 commitCanonicalTransition 落盘→再 replay 收口；强化：恢复决策成为被记录的事实。settleTail 参数映射"是否执行 planRecovery" |
| 2 | 判别式"输出是否变化"不可靠：no-op transition 反例；应静态分类 | 采纳+细化 | commitCanonicalTransition(CanonicalRecord) / appendRecord(AuxiliaryRecord)；"只消费"精确为"解释 CanonicalRecord、登记 AuxiliaryRecord（opaque 挂时间线）"——否则 projector 看不到 compaction summary |
| 3 | projectHistory 单 owner 与 Compaction 冲突：压缩若占用投影接缝，Branch/Memory 无位可占→ProjectorPipeline 回归 | 采纳，v4 最大隐患属实 | v4 P6 确写"持久化原语+projectHistory 投影"。修正：Compaction 走 prepareTurn+appendRecord+transformContext；代价显式化（阈值按裁剪后上下文估算、O(全量) 投影 memoization 缓解、性能墙构成 L4 重审证据而非默认占用） |
| A | Cognitive Surface ≤3 不做硬门 | 采纳 | heuristic；评审同时检查概念本身是否够小 |
| B | flaky 隔离不得简单加宽 timeout/标 flaky——可能暴露真 race | 采纳 | quarantine 纪律：原因未确认+专门复现任务+quarantine≠修复 |

### 第六轮（4 冲突 + 文档卫生，最终执行稿动因）

| # | 主张 | 裁定 |
|---|---|---|
| 1 | L3 旧描述与 planRecovery 设计冲突 | 采纳；L3 改为五项强制清单（legality/lineage/工具因果/active canonical state/unresolved-operation detection）；新增原则"**Replay 不能制造事实**" |
| 2 | P6 与派生测试 #3 仍是旧方案（占用 projectHistory） | 采纳；统一为 prepareTurn→判断→生成 summary→appendRecord(uina.compaction/*)→transformContext 裁剪 |
| 3 | 数据模型原则混写 custom_entry/custom_message | 采纳；拆为两行：私有持久态→custom_entry→Auxiliary；有意模型可见→custom_message→Canonical（语义重，禁止当存数据口袋） |
| 4 | event→Canonical 按 envelope kind 太宽 | 采纳；分类到 event name 级（CanonicalEventRecord<EventName extends CanonicalEventName>）；在案证据：applyEvent 对 turn_failed/turn_aborted 即 break（recovery.ts:493-495）——现 reducer 就已按 name 分派；封闭枚举只收 lifecycle facts，诊断/遥测走 auxiliary |
| 5 | 文档卫生：标题/段落版本混乱，历史评审记录混在正文，对施工 AI 危险 | 采纳；拆分为最终执行稿（plan）+ 决策档案（本文），正文只保留当前唯一有效设计 |

**执行事故记录**：v6 修订轮中 4 个编辑（标题/§1 标题/L3/分工句）报成功但被会话回滚吞没，6 个计划内编辑（§3 重写/§4 标题/P0/P6/§5 两处）未执行，导致执行稿出现新旧并存污染——由第六轮评审全部捕获，最终以全文重写收口。教训：多轮编辑同一施工文档后必须全文复读校验一致性，不能信任逐条编辑的成功回执。

### 第七轮（2 实现级漏洞 + 1 补充句，开工前修订）

| # | 主张 | 裁定 |
|---|---|---|
| 1 | appendRecord 缺内存同步语义：规格说 reducer 登记 AuxiliaryRecord 供 projector 消费，但 appendRecord 只定义了"校验→落盘"——运行期落盘后内存 timeline 无此记录，projector 看不到，重启 replay 后突然可见，破坏 replay ≡ memory | 采纳。**CanonicalState 双部分模型**：semantic state（仅 CanonicalRecord 可改）+ auxiliary timeline（AuxiliaryRecord opaque 登记处）；appendRecord = validate → durable append(+fsync) → 原子登记进内存 timeline；登记不是 transition，不改 semantic state。双原语由此闭环 |
| 2 | planRecovery 必须前缀安全 + 幂等：一次 plan 产多条恢复记录，写入 A、fsync、再 crash、B 未写——下一次必须只产生 B；禁止为此发明 Journal Transaction / RecoveryBatch | 采纳。契约：稳定 identity（现 `recovered:${originId}:${callId}` 即胚胎）、已落盘恢复事实不重复生成、任意前缀后再 crash 可续作（纯函数于未决集——已持久化恢复记录缩小未决集，幂等随之成立）、每条恢复记录单独提交后 CanonicalState 合法。事务框架禁令入 §6 |
| 3 | 双原语持久化强度必须相同（均 fsync）：uina.jobs/job_started 虽 Auxiliary 却可能是 capability crash recovery 所依赖的事实，不能"canonical 才 fsync、auxiliary 随便写写" | 采纳。写入双原语契约：唯一区别是语义效果（改/不改 canonical semantics），不是持久化强度 |

评审结论：规格收敛确认（Replay 不能制造事实 / Hook≠Event / Replacement-Interceptor-Observation / Core truth ≠ capability policy / projectHistory 大半径极少使用且 Compaction 不占 / CanonicalRecord-AuxiliaryRecord 静态分类 / P6 流程干净 / 七问验收）。执行稿定稿，待授权开工。

### 第八轮（1 实现问题 + 2 小问题，授权开工）

| # | 主张 | 裁定 |
|---|---|---|
| 1 | commitCanonicalTransition 禁止每次全量 canonicalReplay(candidate)：长期 Subject 下累计 O(N²)。改为 `reduceRecord(state, record) → nextState` 单步增量 + `canonicalReplay = fold(reduceRecord, initialState, records)`（同一 reducer 从头折叠，仅启动/校验/测试），热路径 O(1)/record，不造第二解释器 | 采纳。单 reducer 双形态写入 §2 契约；双原语事务改为增量；P3 交付项与 §6 禁令同步 |
| 2 | Recovery identity 唯一性归 CanonicalState/reducer 结构化管理，不靠 planRecovery 自觉 | 采纳。reducer 维护已接受 recovery identity 索引并拒绝非法重复（recordIds 去重即胚胎）；planRecovery 从 state 派生。幂等=结构保证 |
| 3 | 文档卫生：决策档案"五轮"已过时（实为七轮）；P6 的 `uina.compaction/*` 代码 span 嵌在 bold 内产生 `****` 渲染垃圾 | 采纳。声明改为"八轮评审/修订"；P6 改纯文本命名空间表述 |

**授权**：本轮起评审结束，授权开工（P0 起）。后续不再纸面迭代版本——P3 reducer、P5 Rewind extraction、P6 Compaction extraction 的实现与实验才是下一批真实信息。判据：P3 做完代码更绕=理论错；Subject/Session 明显变薄且能力保持=方向对。
