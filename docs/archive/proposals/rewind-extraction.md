# P5 Rewind 提取实验报告

执行稿 v6 P5 交付：划分表 + 裁定理由 + safeTargets 交互说明。方法 = 词汇盘点 → 逐词归属裁定 → 结局判定 → Surface 估算。不预设 100% 提取；结论基于 2026-09-18 代码事实（P4 后，提交 093d051）。

## 1. 裁定：结局 A —— cut 是 canonical 结构事实

**rewind record 留封闭 schema；capability 只拥有命令 / 文案 / 携带策略（后者为可注入候选，见 §4）。**

三条第一性理由：

1. **主线截断是持久事实，不是请求级解释**。rewind record 落盘后，`entries` 主线在该点截断、被放弃切片在 `allEntries` 只增不减——这是 journal 的结构状态，任何一次 replay 都必须复现。若 cut 由 capability 经 custom record 表达（结局 B），Core 不知道"主线被砍"，replay ≡ memory 不变量崩塌；若 capability 借投影缝解释 cut，则违反 P6 已裁定的"capability 不占用 projectHistory"。结局 B 的两条路都被既有裁定堵死，不是本实验重新发明约束，而是约束自然指向 A。
2. **因果完整性校验是 reducer 的结构职责**。checkRewind 的四重校验（ensureSettled / fromId=主线头 / target=主线祖先 / target∈safeTargets）守护的是 journal 合法性——一条切断工具因果的 cut 会让后续记录全部非法（P3b 的 unresolved-operation detection 正为此存在）。这组校验不能下放：capability 可以决定**要不要**回溯、回溯到哪，但不能决定**什么算合法 cut**。
3. **进 CanonicalState 的派生必须确定性**。`carriedInputs` / `effects` / `notice` 结构是 entry payload，每次 replay 从 journal 确定性重算。若携带规则是可变策略，同一 journal 在不同策略下 replay 出不同 semantic state——跨版本虽不违反"同版本内 fold≡memory"，但会破坏"journal 是唯一事实源"的解释稳定性。因此收集规则的**结构**必须 Core 拥有（见 §4 的注入性权衡）。

## 2. 划分表

### 2.1 Canonical 结构事实（Core 拥有，封闭 schema）

| 词 | 现状位置 | 归属理由 |
|---|---|---|
| rewind record schema（kind/fromId/targetId/source/requestId/reason/summary?/compaction?） | session/types.ts:80-85 | journal 结构身份 |
| 主线截断（entries.splice）与放弃切片只增不减（allEntries） | recovery.ts applyRewind | replay 必须复现的持久事实 |
| 四重合法性校验（ensureSettled/fromId=头/祖先/safeTargets 成员） | recovery.ts checkRewind | journal 合法性防线，不可下放 |
| 工具因果状态重置（pendingCalls/openCallIds/finishedEvents） | applyRewind + trackSafety | 因果连续性 |
| recovered: 节点结构性排除 + settlementInvalid 防护 | trackSafety | 恢复窗口安全（§3） |
| carriedInputs/effects 收集与去重（含递归展开先前 rewind） | collectCarriedInputs / summarizeAbandonedEffects | 确定性派生（理由 3） |
| continuity renderable 结构（id:`continuity:*`、customType、details 字段、never-at-tail 注入） | rewindMessages / protectRewindContext | L3"措辞改 renderable"裁定的载体 |

### 2.2 Capability / 主体域语义（已外移或本就在缝外）

| 词 | 现状位置 | 归属 |
|---|---|---|
| session_rewind 工具（含提示词文案） | extensions/session-tools/index.ts:64-100 | capability ✅ 已拥有 |
| /rewind 斜杠命令 + 文案 | extensions | capability ✅ 已拥有 |
| 发起编排（busy 时 scheduled、安全点 commit、requestId 生成） | Subject.requestRewind / commitRewind | 主体域（非 session Core） |
| 预压缩策略（超限先压缩再落盘） | rewind.ts compactProjectionForRewind | 策略已经 ProjectionPolicy/compactor 可注入（P3c） |
| OVERSIZED_REWIND 拒绝文案 | rewind.ts | 文案，agent 域 |

### 2.3 交界处的两个权衡（成文，不裁决为缺口）

- **notice 散文**（buildRewindNotice 的模型可读文案）：落在 entry payload 上，随 replay 重算。文案是"自由参数"的前提是不影响结构不变量——现状满足（字段结构 renderable、散文可随版本演进）。无第二文案 owner，不建注入管道（P3c 先例：无消费者不做承诺）。
- **携带策略**（跳过 runtime source、递归展开、去重）：技术上可注入（确定函数注入不破坏 replay 确定性），但触发条件是出现第二个携带策略 owner（如自定义检查点 capability）。当前唯一消费者是 reducer 自身，注入点属投机接口——成文为候选，沿 ProjectionPolicy 先例在 owner 出现时建立。

## 3. safeTargets 交互说明

**定义与增量规则**（trackSafety 单路径，禁止第二 walker）：压缩/回溯条目清空 `openCallIds`；消息按 assistant(开启调用)/tool(闭合调用) 增量维护；`openCallIds` 为空且条目非 `recovered:` 前缀时加入 safeTargets；`settlementInvalid` 防护 compaction retainedTail 从工具对中间切开（checkRecord 不覆盖的任意载荷）。

**与 rewind 的交互**：

1. **目标准入**：checkRewind 要求 targetId ∈ safeTargets —— 机制上保证回溯永不切断"已发起未闭合"的工具因果，也不会落在恢复窗口上。
2. **回溯后重建**：rewind 条目自身清空 openCallIds 后进入 safeTargets —— **rewind 节点是合法回溯目标**（多级回溯，测试 session-rewind"回溯到前次回溯节点 r1"钉住）。
3. **与 crash 恢复的边界**：planRecovery 落盘的 `recovered:` 工具结果结构性排除出 safeTargets —— 恢补窗口不是人 selectable 的历史位置；新事实记录恢复合法后 safeTargets 随增量规则自然重建。
4. **与嵌入压缩的边界**：带 compaction 的 rewind 重置工具因果状态并从 retainedTail 重建——retainedTail 切断由 settlementInvalid 兜底（P3b 裁定保留的非死代码）。

## 4. Surface 估算（P8 派生测试 #7 前哨）

- **Modification Surface**：新增一个自定义回溯/检查点 capability 所需 Core 改动 = **0 行**。路径：SessionAccess.requestRewind + safeTargets 公开读（CanonicalState）+ ProjectionPolicy/compactor 注入 + SessionStore.appendRewind。无需触碰 reducer。
- **Cognitive Surface**：3 概念 —— rewind record、safeTargets、continuity 结构。达标（≤3 heuristic），且各概念本身足够小（划分表 §2.1 逐项可独立解释）。

## 5. 结论

结局 A 成立且**零迁移**：record 留封闭 schema；命令与文案已在 capability（extensions）；携带策略与 notice 散文为成文候选（触发条件 = 第二 owner 出现，沿 ProjectionPolicy 先例注入）；Core 无回溯业务词汇增殖。P8 七问 #5（Rewind 能否由公开 seam 推导）的前置证据就绪。
