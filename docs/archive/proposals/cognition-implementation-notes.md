# 认知扩展实施备忘：模块拆分、依赖序与关键结论

> **执行状态（每次开工前更新）**：
> - 阶段 A（M1+M2）：**已提交**（`d95ef87`）。实现：`src/host/profile.ts`（M1：解析/校验/锁）+ Host/CLI/runner/app-registry 五点透传（M2）+ `tests/subject-profile.test.ts`（13 用例含双 Host 集成）。无 --profile 时路径逐字节不变（对照测试锁定）。
> - 阶段 B（M3+M4）：**已提交**（`9876be2`）。实现：`src/extensions/cognition/memory.ts`（M3：单 writer + expectedHash 乐观并发 + revisions 备份 + 抑制遗忘）+ `src/extensions/cognition/index.ts`（M4：三工具，schema 无身份参数）+ `PROMPT.md` + `tests/cognition-memory.test.ts`（15 用例）+ `tests/cognition-tools.test.ts`（4 用例）。
> - 阶段 C（M5）：**已提交**（`32172e9`）。实现：`src/extensions/cognition/context.ts`（createContextInjector 确定性召回 + activateCognition 激活入口）+ `pi.subject` 扩展 `subjectId` 字段（身份显式绑定，不从路径推断）+ `tests/cognition-context.test.ts`（8 用例含真实模型请求集成）。非 tail transformContext 注入；预算估算 CJK≈1token/字。注意：中文无空格查询按整串子串匹配（§3.4 宁可漏），同义漏召回留 F 阶段。
> - 阶段 D（M7 收窄版）：**已提交**（`21ffd8d`）。实现：`pipeline.ts` 返回值增加 `canonical`（原始执行结果）——onDone 观测点（journal tool_finished + tool_result 派发）与 loop 落 journal（`settleToolExchange`）均拿 canonical；模型可见 transformResult 改写只作用于返回值投影。合同更新：tool-pipeline/tool-view/session-facts/extensions-hooks 四处旧断言（改写正文落盘 → 原始正文落盘）。
> - 阶段 E（M6）：**已提交**（`cd757a1`）。实现：`src/extensions/cognition/consolidation.ts`（createConsolidationWorker：水位合并、重复转述合并单份证据、仅 revise/retire patch 经同一 writer 提交、generation guard 拒绝迟到 patch、Provider 取消双轨 fake 验证、水位持久化 cognition.json）。手动触发，automaticConsolidation 默认关闭（plan §8 收益门槛未验证前不开）。
> - **Host 接线**：`host.ts` 内置装配 `cognition`（仅 `this.options.profile` 存在时激活，无 profile 零影响）。A–E 全部完成并接线。剩余：真实模型行为链验收（plan §11/§15）。

实施备注（阶段 A 实际偏离 §6 设计的地方）：
- `subjectsRoot` 实现为 `<cwd>/profiles`（设计文档的 `<subjectsRoot>` 由 Host 装配自由选定，此处选项目内目录以避免污染 home）。
- 锁释放用 WeakMap 持 ownerToken（非持有者对象无法释放他人的锁——语义正确且类型安全）；同一进程对同一 profile 的二次解析会 EEXIST，由“非持有者不碰锁”语义覆盖。
- `--profile` 解析：值分离式（`--profile alice`），不支持 `=` 形式（与 `-m/--model` 一致）。

状态：实施前工作文档（2026-09-22，由实施代理撰写给自己）
规范来源：[认知扩展设计](cognition-extension-design.md) + [开发路线](cognition-extension-plan.md)。本文不复制规范，只记录实施时的**拆分决策、关键事实与已裁定的坑**。冲突时以两份规范为准。

---

## 0. 动工前必做：基线对账（半天）

设计文档基线锚在 `2c0ea3a`，此后已有 4+ 个 commit（含 `287bb27` 事件帧收尾、`ad8863a`/`91947a3` 视口尾部帧迁移）。已确认过时的现状描述：

| 设计文档声称 | 当前事实（已核实） |
|---|---|
| §3 "transformResult 能覆盖 status（pipeline.ts:96）" | **已修复**：`287bb27` 后 status 改写被 `warnIgnoredToolStatus` 丢弃，journal 保原始 status。残余缺口只剩 **result 正文**改写在落盘前发生（阶段 D 范围收窄到这一条） |
| `dev:baseline` 命令 | FACTS.md 声称存在，cognition plan 声称不存在。**实施前跑一次 `package.json` scripts 核实，修正 FACTS** |
| §6.3 "App.render 存在 system 前缀注入路径，需接线审查" | **已完成**：视口已迁 `external_event_frame` 尾部帧（`ad8863a`），systemPrompt 静态。该前置障碍清除 |
| 外部事件帧"未实施" | **已实施并 Host 默认装配**（`287bb27`），设计 §1 状态行已更新，§3 表格其余行未同步 |

对账产出：更新 cognition-extension-design.md §3 表格 + 重锚基线 commit hash。

---

## 1. 模块拆分（深模块视角）

> 拆分原则：每个模块一个不变量，接口窄于实现。不为每个认知名词建包。

| # | 模块 | 位置 | 单一不变量 | 关键接口 |
|---|------|------|-----------|---------|
| M1 | **Profile 装配** | `src/host/profile.ts`（新） | subjectId ↔ 目录绑定不可变；每个数据根恰好一个活动写入进程 | `loadSubjectProfile(cliArg): SubjectProfile`（wx 锁 + ownerToken/PID） |
| M2 | **资源绑定透传** | `runner.ts` + `host.ts` + `cli/*` + `ai/settings.ts` | 扩展拿到的路径只指向自己的 subject 根 | `pi` 增量：只读 sessionId、绑定 stateDir/memoryRoot；settings 函数显式路径参数 |
| M3 | **MemoryStore（权威记录 + 单 writer）** | `extensions/cognition/memory.ts` | 每条记录任意时刻恰好一个当前版本；写路径全串行；hash 不符必冲突 | `search/read/write/close`（MemoryRepository，§12）；write 返回 committed/conflict/rejected **必带 hash** |
| M4 | **记忆工具面** | `extensions/cognition/index.ts` | 模型只见 ID，不见路径/subjectId | memory_search / memory_read / memory_write 三工具；scope 由 Host 绑定注入，不从模型参数读 |
| M5 | **召回与瞬态块** | `extensions/cognition/context.ts` | 注入量 ≤ memoryBudgetTokens；无关不注入；确定性（不调用模型） | transformContext hook handler（**非 tail 注册**，见 §3.1） |
| M6 | **整理 worker**（最后） | `extensions/cognition/consolidation.ts` | 迟到 patch 必被拒；无新材料零模型调用 | 手动触发 → patch 经 M3 writer 提交 |
| M7 | **工具证据正文保全**（可选前置） | `tools/pipeline.ts` + `agent/loop.ts` | journal 保留原始 result 正文 | 唯一碰 Core 的改动；仅"自动归纳工具经验"前必须 |

依赖关系：

```
M1 ──→ M2 ──→ M3 ──→ M4 ──→ M5
              │              ↓
              └──────→ M6（依赖 M3 writer + M2 取消语义）
M7 独立（仅 M6 的自动经验归纳前需要；不阻塞 A-C）
```

阶段映射（对齐 plan）：阶段 A = M1+M2；阶段 B = M3+M4；阶段 C = M5；阶段 D = M7（收窄版）；阶段 E = M6。

## 2. 关键事实（实施时直接引用，免重新考古）

- **接缝已证明**：`tests/helpers/memory-capability.ts` 仅用公开 pi 接缝实现持久记忆（prepare + transformContext + appendEntry）。import 白名单即审计基线。
- **管线层序（当前代码事实，`ad8863a` 后）**：事件帧投影(convertToLlm) → compaction 裁剪 → 非 tail transformContext 注入 → **tail 相位**（视口帧、具身帧）→ 预算门(`estimateRequestTokens`，含 contextTools) → `assertEventFrameContext` 校验。合同由 `tests/projection-order.test.ts` 字节级锁定。
- **compaction 预算不知道链后注入量**：预算 = `availableContextBudget(window) - tools`。视口迁移时裁定 16k `CONTEXT_RESERVE_TOKENS` + 半预算余量足够吸收尾帧（~200 token）；记忆块预算默认 1200 token 同样被余量覆盖，**但 M5 应把注入量实测上报，超预期再加显式 reserve 机制**（不预造）。
- **session/settings 路径现状**：`cli/session-path.ts` → env `UINA_SESSION_PATH` > cwd `data/session.jsonl` > `~/.uina/session.jsonl`；`ai/settings.ts` → `settingsDir(home)` 平面两字段。M2 改造时**保持无 `--profile` 时路径逐字节不变**（plan A 完成判据），`UINA_HOME` 语义不动，新增显式参数而非偷换 home 含义。
- **app 状态路径**：`app-registry.ts` 写 `<cwd>/.uina/worlds.json`、appDataDir 传 `join(cwd, '.uina/worlds', name)`——M2 需让这两者接受 subject 绑定路径，否则 App 可变状态跨人物共享（隔离漏洞，plan A 明列为不兼容即禁止）。
- **exposed-feed 生命周期合同**：world-framework 必须先于消费方扩展激活（`embodiment-endpoint-wiring.test.ts:142` 在案）。若 cognition 需要消费 expose 的端点，激活顺序遵循同一合同。
- **验收样例基建复用**：外部事件帧的隔离会话 + 同模型同工具 + fake/localhost provider 评测模式直接复用，不建第二套评测。

## 3. 已裁定的坑（实施时不得重新辩论）

### 3.1 cognition 记忆块注册为**非 tail** tail 相位是给"每请求必变的瞬态世界快照"用的（视口/具身）；记忆线索是按需注入的稳定度更高的内容，必须在尾帧**之前**，否则被瞬态内容稀释且层序合同被破坏。同时更新 `projection-order.test.ts` 合同注释时预留 cognition 位置。

### 3.2 记忆写入的并发安全 = 乐观并发（expectedHash），不是锁
- 同回合模型连续 revise：第二次必须先拿到第一次返回的**新 hash** 才能构造——`committed` 返回**必带 hash**，这是最容易偷懒砍掉的字段，砍了就是 bug。
- 离线人工编辑：读出时整文件 hash 比对，外部编辑未走 writer → hash 失配 → 冲突而非覆盖。
- 禁止发明跨文件事务/写队列框架（对齐 subject-runtime-plan "不发明 Journal Transaction"）。

### 3.3 遗忘顺序：抑制记录先落盘 → 停召回 → 清理副本 → 来源进整理排除集。顺序反了会把"忘记"变成"假装没发生过"。遗忘 ≠ 删除 journal。

### 3.4 中文匹配器偏精确、宁可漏
误召回污染任务上下文且烧预算，漏召回只损失一次可用性。第一版确定性字符片段匹配，把"同义漏召回"留给 F 阶段触发向量实验（规范 §15 已设止损线）。

### 3.5 Windows 锁文件是阶段 A 最可能的翻车点
- wx 排他创建 + ownerToken + PID 双校验（PID 复用防护）已设计；**必须真的写双进程测试**（Windows 句柄语义：崩溃残留 + unlink 延迟失败是预测的翻车点）。
- 崩溃残留锁明确拒绝启动 + 人工恢复；不做租约/心跳/时间过期偷锁。

### 3.6 Provider 取消语义决定阶段 E 能不能开自动整理
`pi.models.stream` 经 ResourceScope.run 跟踪，deactivate 会 await pending。**不响应 abort 的 Provider promise 会卡住换人/关停**。启用 automaticConsolidation 前必须用"响应/不响应取消"两种 fake 各测一次；后者显示"仍在关闭"、不得释放主体锁。迟到 patch 靠 generation guard 拒绝，不靠取消。

### 3.7 隔离边界的诚实声明（写进用户文档，不许含糊）
官方接口/检索/会话/状态不串 ≠ 敌对代码隔离。受信任扩展与全权限 shell 工具仍可达其他目录。强隔离需求 = OS 用户/容器，本方案不假装提供。

## 4. 测试文件规划（对齐 plan §10，新增裁剪）

| 文件 | 覆盖 | 对应模块 |
|------|------|---------|
| `tests/subject-profile.test.ts` | 身份/路径/锁/双进程/settings 隔离；无 --profile 时路径不变 | M1/M2 |
| `tests/cognition-memory.test.ts` | create/revise 竞争/冲突/遗忘/来源校验/索引降级 | M3 |
| `tests/cognition-tools.test.ts` | 三工具适配 + scope 注入 + 返回五态 | M4 |
| `tests/cognition-context.test.ts` | 召回相关性/预算/中文/与 compaction+帧组合/层序 | M5 |
| `tests/cognition-lifecycle.test.ts` | 取消/迟到提交/水位合并 | M6 |
| `tests/cognition-integration.test.ts` | 双 Host 跨人、跨会话、回溯、真实工具事实 | A-C 集成 |

既有回归门：memory-derivation、projection-seam、session-replay、host-separation、compaction-per-step、compaction-fingerprint、projection-order、event-frame-*、world-framework-*。每阶段先跑对应文件再全量 `pnpm typecheck && pnpm test`。

## 6. 阶段 A 执行方案（固化于 2026-09-22，压缩断点恢复源）

### 6.1 现状事实（已核实源码）

- 路径决策分散三处：`cli/session-path.ts`（env UINA_SESSION_PATH > cwd/data/session.jsonl > ~/.uina/session.jsonl）、`ai/settings.ts`（settingsDir(home)）、`app-registry.ts:73,238`（worlds.json 与 appDataDir 基于 pi.cwd）。
- Host 装配：`UinaHostOptions`（host.ts:52+）已有 cwd/sessionPath/extensionPaths/projection/systemPrompt；`UinaHost.create` 内 settings 恢复用 `loadSettings()` 无路径参数。
- ExtensionAPI：runner.ts:505 的 `cwd: this.options.cwd`；ExtensionRunner options 无资源绑定字段。

### 6.2 M1 设计（src/host/profile.ts 新文件）

```ts
resolveProfile({ profileArg: string, cwd: string }): SubjectProfile
```
- 目录布局：`<subjectsRoot>/<subjectId>/`（subjectsRoot 默认 `<cwd>/profiles`；profile.json 内含覆盖）。
- 校验：subjectId === 目录名；resolve 后路径必须仍在 subjectsRoot 内（防穿越）；非法字符拒绝。
- 锁：`openSync(lockPath, 'wx')` 排他创建 `<stateRoot>/host.lock`，内容 `{ownerToken, pid, acquiredAt}`；正常关闭核对 ownerToken 后 unlink；已存在锁 → 启动失败并提示恢复命令（不自动偷锁）。锁与 Host 生命周期绑定：create 持有、dispose 释放。
- 产出不可变 `SubjectProfile`：identity{subjectId,displayName}、resources{memoryRoot,stateRoot,appDataRoot,cacheRoot}、sessions{sessionId,journalPath}、settingsPath、personaText（读 persona.md，可缺省空）。

### 6.3 M2 设计（最小透传）

1. `UinaHostOptions.profile?: SubjectProfile` → sessionPath/settingsPath 存在 profile 时从 profile 取（**无 profile 时全部现有路径逐字节不变**）。
2. `ExtensionRunner` options 增 `subjectBinding?: { sessionId, memoryRoot, stateRoot }`；ExtensionAPI 增只读 `pi.subject`（缺省 undefined——测试与旧扩展零影响）。
3. `app-registry.ts`：stateFilePath/appDataDir 优先取 `pi.subject?.stateRoot`（存在时 `<stateRoot>/worlds.json`、`<stateRoot>/app-data/<name>`），退回现行为。
4. `ai/settings.ts`：load/saveSettings 已有 home 参数——Host 传 profile.settingsDir（新签名 `settingsDir` 参数语义不变，不偷换 UINA_HOME 含义）。

### 6.4 失败测试清单（tests/subject-profile.test.ts 先行）

1. 无 profileArg → resolveProfile 返回 undefined，启动路径与原先一致（对照测试：sessionPath/settings 路径逐字节相同）。
2. 合法 profile → 目录自动创建（memory/state/cache/app-data/sessions），SubjectProfile 各字段正确，persona.md 读取。
3. subjectId ≠ 目录名 → 拒绝；目录穿越（`../`）→ 拒绝；非法字符 → 拒绝。
4. 锁：首次创建成功；二次启动（未释放）→ 明确报错含锁路径；正常关闭释放；ownerToken 不匹配不删除他人锁。
5. 双 profile 隔离（集成）：A/B 同 cwd 同时持有 Host → sessionPath/settingsPath/worlds.json 全不同；A 写状态 B 不可见。
6. cli 层：--profile 参数解析透传（args.ts 增参）。

### 6.5 执行序

① 写 subject-profile.test.ts 失败测试（§6.4 全部）→ ② M1 实现（profile.ts）→ ③ 单元门绿 → ④ M2 透传（host.ts/runner.ts/app-registry.ts/settings.ts 五点）→ ⑤ 集成门绿 → ⑥ 全量回归 → ⑦ 更新 FACTS/DECISIONS + 备忘执行状态 → ⑧ 提交（阶段 A 一个 commit）。

---


1. 跨主体泄露 = 0（A 的暗号 B 拿不到：搜索/重启/缓存命中均不得泄）。
2. 未经确认的工具结果不得被记忆记为成功。
3. 版本冲突不覆盖、不自动重试。
4. 取消/换人后不提交迟到 patch、不假报成功。
5. "写入 → 新会话召回 → 行为使用 → 纠错"完整行为链跑通才算验收；仅注入字符串不算。
6. 对照基线（无记忆版）在固定样例上可复现收益才默认开启整理；无收益删增强、留记录。
