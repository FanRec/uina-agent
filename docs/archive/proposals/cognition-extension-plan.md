# Uina 认知扩展开发路线

状态：规划，尚未实施。规范：[认知扩展设计](cognition-extension-design.md)。输入格式前置：[事件帧计划](external-event-frame-plan.md)。

本路线建议顺序实施，以保持接口一致并控制开发成本。先交付“隔离＋明确记忆”，验证有效后才进入后台整理和外部记忆库。不把后续阶段提前做成空框架。

## 1. 最终交付切片

同一份程序以两个 profile 启动。A 在 `qq:dm-42` 会话中明确记住偏好，A 的另一个 `project-x` 会话按作用域决定是否使用；B 完全不知道。A 收到修正后更新认识，旧缓存不能复活旧内容。关闭认知扩展后，普通 Agent、真实工具和历史仍能运行。

这一切片通过后，再验证后台整理能减少错误和冗余，同时不拖慢交互、不覆盖新写入。

## 2. 实施纪律

- 先检查 git status，保留现有用户文件；实现时按 AGENTS.md 与 subject-runtime-plan.md 执行。
- 所有测试用临时 profile、会话、文件和 fake/localhost Provider。
- 不修改真实凭据或迁移旧会话；默认入口不加 profile 时行为不变。
- 先写关键行为失败测试，再实现对应路径；每阶段单独验证和提交。
- 不因一个文案或浅层包装创建新模块；新增公开 Core 接缝必须说明真实派生能力。
- 不添加默认周期唤醒、Agent 轮数限制、数据库/向量依赖或第二套后台框架。
- 不把“可运行”报告为“长期认知有效”。

## 3. 统一装配接口

Host 内部新增不可变配置视图，具体路径只在 Host 解析一次：

```ts
interface SubjectProfile {
  identity: { subjectId: string; displayName: string; templateVersion?: string };
  persona: { text: string; memoryPolicyText?: string };
  cognition: {
    memoryBudgetTokens: number;
    automaticConsolidation: boolean;
    defaultScope?: string;
  };
  sessions: { sessionId: string; journalPath: string };
  resources: {
    workspace: string;
    memoryRoot: string;
    stateRoot: string;
    appDataRoot: string;
    cacheRoot: string;
  };
  runtime: {
    model?: string; // 现有 registry 的模型身份引用，不存密钥
    extensionPaths: readonly string[];
    toolPolicy?: string;
  };
}
```

profile.json 最小例子：

```json
{
  "subjectId": "uina-main",
  "displayName": "Uina",
  "workspace": "E:/Uina/Uina",
  "cognition": {
    "memoryBudgetTokens": 1200,
    "automaticConsolidation": false
  }
}
```

stateRoot 来自已选目录，不接受 JSON 改写到另一个主体；personaText 从该目录 persona.md 读取。subjectId 必须与选定目录匹配。改显示名不改 ID。

认知能力使用 factory 闭包拿到已绑定资源，不把全局 subject 列表交给模型：

```ts
createCognitionCapability({
  subjectId,
  memoryRoot,
  stateFile,
  personaText,
  historyReader,       // 仅查询此主体的 sessions
  memoryBudgetTokens,
  automaticConsolidation,
});
```

返回普通 ExtensionActivation。historyReader 的只读合同是 `read(sessionId, entryId)` 和 `isApplicable(ref)`；不暴露任意文件路径或 SessionStore 写权限。使用现有 journal reader，不另写 replay reducer；只读读取旧会话不得触发恢复写入。

`ExtensionAPI` 可增量暴露只读当前 session ID 与绑定的 stateDir。路径和身份属于 Host/Extension API，不增加 Core 人格类型。认知工厂所需跨会话查询由 Host 私有装配，第二个真实消费者出现前不扩成通用全局历史服务。

## 4. 阶段 A：来源与身份底座

**范围**

- 完成现有事件帧方案所需路径；不将事件编码再实现一遍。
- 新增 `src/host/profile.ts`，负责配置解析、目录约束、不可变视图与主体独占。
- 修改 `src/cli/args.ts`、`src/cli/app.ts`、`src/cli/session-path.ts`，增加显式 --profile。
- 修改 `src/host/host.ts`，传入 session/state/settings 路径及能力资源。
- 修改 `src/ai/settings.ts`，支持显式 settings 文件路径；当前 home 参数含义不能被悄悄改成文件路径，新增具名 options 或独立内部函数，旧默认调用保持语义。
- 修改 `src/extensions/runner.ts`、world-framework 的 registry/types，使共享代码位置与可变 appDataDir 分开。

**失败测试**

- A/B 同一个 cwd，profile、settings、session、worlds.json、memoryRoot 和 appDataDir 都不同；A 的两个 session journal 也不同但共享 A 的长期记忆。
- A 写入状态后创建 B，B 没有继承这些状态；同一 subjectId 换模型仍恢复自己的状态。
- 同一主体二次启动拒绝写入；原子创建锁失败不继续装配能力；正常关闭核对 ownerToken；崩溃残留明确拒绝并提供恢复方式，不靠盲目过期偷锁。
- 不传 --profile 时 session/config 路径与原先一致；不复制旧数据。Profile 与 sessionId 的组合键必须可诊断，不能只显示一个模糊目录名。
- 非法 subjectId、目录穿越、指向其他主体目录的配置在启动前失败。
- TUI/stdio/oneshot/无 UI 四种入口使用同一身份绑定；一次切换不得在旧 Host 活动期间生效。

**完成判据**：证明人物隔离覆盖可变状态，不只是 systemPrompt 或 memory namespace。外部 App 仍自行写固定共享路径时列为不兼容并禁止声称该 App 已隔离，不能默默运行后算成功。

## 5. 阶段 B：可修订文件记忆与三个工具

**范围**

新增 `src/extensions/cognition/memory.ts`、`index.ts`、`PROMPT.md`；用明确工具写入，先不自动整理。

MemoryRecord 对应设计 §7。写入操作为：

```ts
type MemoryChange =
  | { op: 'create'; record: NewMemoryRecord }
  | { op: 'revise'; id: string; expectedHash: string; record: RevisedMemoryRecord }
  | { op: 'retire'; id: string; expectedHash: string; reason: string };
```

NewMemoryRecord 提供 type/basis/scope/sources/title/body/pinned；id、revision、subject 绑定由服务生成。RevisedMemoryRecord 修改上述内容但不能改变主体归属或 ID。MemoryWriteResult 返回 committed（id/hash/revision）、conflict（当前 hash）、rejected（明确原因），由工具适配为真实五态结果；版本冲突不报告 succeeded。

- 当前 records 是权威；revisions 是历史；索引可重建。
- 单 writer 串行化前台、子 Agent 和未来整理的写请求。
- 文件名由 ID 生成；运行中用 hash 比对，避免离线编辑遗漏 revision。
- 明确遗忘命令先落抑制记录，再清理各副本；退休与遗忘分别说明。

**失败测试**

```text
create → 返回 id/hash → read 同值
两个 revise 使用同一旧 hash → 恰好一个成功，另一个冲突
替换文件失败 → 当前文件仍可读且不报告已记住
备份成功但替换失败 → 多一个无害历史版本，不改变当前认识
文件成功、索引更新失败 → 文件已记住，索引降级可重建
同标题不同主体/作用域 → 搜索互不可见
来源引用不存在/属于另一主体 → 拒绝引用，不能伪造证据
retire/forget → 正常搜索不返回；重启后保持
```

**完成判据**：跨新会话读写与纠错可靠；还不声称自动会记、会用。工具可操作的范围由绑定上下文决定，不能让模型传入另一个 subjectId。

## 6. 阶段 C：最小召回与上下文组合

**范围**

新增 `src/extensions/cognition/context.ts`。启动时索引当前主体记录，支持中文片段/关键词匹配；优先当前 actor/project 的适用记录。自动召回不调用额外模型，工具搜索允许模型主动补查。

固定顺序：event-frame projection → compaction → cognition 记忆线索 → 请求校验。compaction 为记忆预算留空间；最终请求计入全部工具 schema。旧记忆块不落 journal，下一请求从记录重新产生。

读全文返回工具结果；自动线索使用带 memoryId/source/scope 的内部信息块，不拼成更高权威 system 事实。persona.md 与短运行契约稳定，动态记忆不重复写入稳定前缀。

**失败测试**

- 相关偏好被召回，无关任务不注入；无结果时不输出一大段空模板。
- 中文无空格问题有可用召回，昵称变化仍可按稳定 actorId 找到资料。
- 同名不同 ID 不串人；private space 内容不会在另一个群聊自动出现。
- pinned 超预算只选择预算内内容，不突破作用域或删除最新输入。
- 修改/遗忘之后旧索引命中被版本和抑制检查排除。
- compaction 不把瞬态记忆再归纳成新经历；事件帧仍完整。
- 关闭检索/索引报错时依然能正常回答；来源缺失不能猜 operator。

**测量**：固定本机语料，记录新增上下文准备 p50/p95、输入 token、额外模型调用。p95 ≤50ms 为试验目标；未达标先移除同步全量扫描，不先引入远端检索。

**完成判据**：完成一次真实模型的“写入→新会话召回→行为使用→纠错”对照，并如实记录失败例。

## 7. 阶段 D：执行证据与经验学习的前置修正

**范围**

聚焦 `src/tools/pipeline.ts`、`src/agent/loop.ts` 与结果投影合同，单独设计小修正并验证。权威执行结果进入 canonical 历史；模型可见变换不能改变执行是否成功。现有 transformResult 的 status 覆盖必须退出事实提交路径。

不新建 raw/effective/verified 三套终态。需要外部重新核实时追加新的对账证据，不能重写旧记录。保留现有工具结果五态与取消恢复规则。

**失败测试**

- 执行器 failed/unknown，展示 hook 试图改 succeeded：journal 仍保留原始结论。
- 模型摘要误称成功：经验生成能追到原始失败/未知，不把模型自评当结果。
- 取消后迟到真实结果与现有协议一致；不因拆分展示层丢附件或真实 effects。

**完成判据**：结果事实可信边界明确后，才允许自动归纳工具成功/失败经验。前几阶段的用户明确偏好记忆不必等本阶段才能验证。

## 8. 阶段 E：可选整理 worker

**范围**

新增 `src/extensions/cognition/consolidation.ts`；先提供手动整理，再启用 automaticConsolidation。

worker 只读证据、生成已有记录的 patch，不拥有真实外部动作工具。输入为主体绑定、历史范围、当前记录 hash；输出为已有记录的 revise/retire 建议，提交经同一 writer。第一版不批量造新记忆。

- 事件回调只合并待处理范围，不等待模型。
- 一次只处理一个后台范围；无新材料零调用。
- 提交前重新检查 hash、来源适用性、遗忘抑制、scope/generation。
- 部分提交有效，失败后重新读取，不重放旧 patch。
- 正常完成不唤醒前台；有影响当前事项的信息才回流。

**取消限制必须先验证**：pi.models.stream 通过 ResourceScope.run 跟踪，deactivate 会 await pending。generation guard 只能禁止迟到写入，不能让不响应 abort 的 Provider promise 自动结束。必须用测试证明所用 Provider 的 abort 会结算；否则禁止声称能即时退出/切换，也不能释放主体锁后再开同主体。需要硬取消时再评估独立进程，不在第一版预造 worker 平台。

**失败测试**

- 前台新写入抢先完成，后台旧 patch 冲突。
- 换人/卸载/forget/rewind 后旧 patch 不提交。
- 多次触发只合并水位，不重复并发调用。
- Provider 取消响应与不响应两种 fake 都不产生假成功；后者显示仍在关闭。
- 进程在若干 patch 后停止，已提交记录保留；重新整理不依赖旧内存队列。
- 同一事件重复转述不能变成多份独立支持证据。

**完成判据**：在固定记录集上减少重复/错误，且不增加前台关键延迟、错误纠正或未经支持的结论。达不到就保持手动整理或删除自动化。

## 9. 阶段 F：有证据再更换检索/存储

只有触发对应瓶颈才启动一个小实验：

| 实测问题 | 候选改动 | 必须保持 |
| --- | --- | --- |
| 文件扫描/排序超出前台预算 | 全文索引 | records 权威不变，索引可重建 |
| 同义表达持续漏召回 | 向量召回 | subject/scope 前过滤＋结果版本复核 |
| 多对象写入事务/规模成为主要瓶颈 | SQLite 等事务存储 | 一个 writer、可导出正文与来源 |
| 抽取/召回研发成本成为主要问题 | 对接第三方记忆服务 | 先作为候选/索引；权威迁移另验收 |

此时才调查候选产品的当前 API、依赖、成本、删除和隔离语义。不因产品名称热门就提前接入。每次只比较一个候选，使用同一数据集与同一评分；没有明确收益就删除适配代码。

不建立长期双写。若迁移权威存储：冻结旧 writer → 导出 → 导入 → 同样场景验证 → 切换 → 删除旧写路径。只保留明确只读的回滚快照，不能两个库都接受更新。

## 10. 测试文件与执行门

建议新增：

- `tests/subject-profile.test.ts`：身份、路径、锁、设置和跨人物隔离。
- `tests/cognition-memory.test.ts`：写入、版本、来源、scope、遗忘。
- `tests/cognition-context.test.ts`：相关召回、预算、中文、压缩组合。
- `tests/cognition-lifecycle.test.ts`：取消、迟到提交、重载、worker。
- `tests/cognition-integration.test.ts`：两个 Host、跨会话、回溯、真实工具事实。

实现阶段先跑对应文件，再跑已有：memory-derivation、projection-seam、session-replay、host-separation、compaction-per-step、compaction-fingerprint、world-framework-store/lifecycle。最后 pnpm typecheck、pnpm test；涉及入口/资源时跑 build、verify:cli、verify:file-events。

package.json 当前没有 dev:baseline，不照抄历史命令。真实服务相关既有用例失败要单列，不能静默排除后宣称全量通过。

本次文档阶段已重新运行原有 5 文件 18 项测试，全通过；上述新测试尚不存在，也尚未执行。

## 11. 行为评测与交付

固定样例至少覆盖：记忆写入与纠正、无关不召回、跨人/跨空间隔离、原始执行 unknown、回溯后承诺、忘记后的不复活。测试单独控制变量：同模型同工具，先比较无记忆与手动记忆，再比较是否启用整理。

硬门：跨主体泄露为零；未经确认不能记为工具成功；版本冲突不覆盖；取消后不提交；不因为记忆改变原有明确任务的基本完成能力。

质量指标：相关召回、正确使用、纠错成功、误记/误用、模型调用增量、延迟与人工自然度。小样例只证明样例内表现，不宣称拥有通用自我学习或人格连续性。

每阶段交付：真实改动文件、对应命令结果、未验证边界、工作树归属、停止/回滚方式。current-runtime.md 只记录实现后已验证事实；本提案放 docs/proposals，按仓库约定留在本地。

推荐先完成 A–C。它已经能让 Uina 在不同个体之间保持独立经历，在同一个体跨会话延续并纠正认识；后续增强必须围绕这条可测闭环增加价值。


