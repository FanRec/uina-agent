# 全库 Stop-That-Shit 审查实施计划（2026-10-22）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 22 个只读审查智能体分波覆盖全库，找出 stop-that-shit 定义的"shit"（无消费方的机制、投机防御、事实多重表示、掩盖失败的兜底、兼容层、重复验证），产出带证据的分级报告；**不修改任何代码**。

**Architecture:** 每个审查智能体领一个边界内聚的 scope（按调用链与体量切），领同一份判定标准块 + scope 专属关注点，产出 `docs/history/full-audit-2026-10-22/<scope-id>.md`；编排者（主会话）最后跨 scope 去重、汇总定级。智能体之间不共享上下文，所以每个任务的 MANIFEST 和 FOCUS 必须自包含。

**Tech Stack:** 本仓库（TypeScript/Node22/pnpm 项目 + 少量 Python 扩展 + Live2D/Cocos ts）；DSH `subagent` / `workflow` 工具做 fan-out；报告为 Markdown。

---

## 1. 硬约束（所有任务共享）

1. **只读审查。** 禁止修改 `src/`、`tests/`、`.uina/`、`scripts/`、`docs/` 既有内容、任何配置。唯一允许写入的是本 scope 的报告文件 `docs/history/full-audit-2026-10-22/<scope-id>.md`。禁止运行任何带 `--write`/autofix 的命令（如 `biome format --write`、`format` 脚本）。
2. **尊重现有工作树脏改动**：当前 `git status --short` 已有 `docs/proposals/live2d/*` 两个 M、`src/agent/context.ts` M、`.uina/worlds/qq/v2/3768832841/downloads/` 未跟踪——那是用户的，审查不碰、不评价是否"该提交"，但可以在 F1 hygiene 报告中提醒归属。
3. **判定必须有证据。** 每条 finding 必须给 `file:line` + 至少一次调用链/grep 核实（见 §4 验证门）。未过验证门的猜测不得写入报告，宁缺毋滥。
4. **不对照 Pi 做全仓扫描**；只有 scope FOCUS 明确写了 Pi 对照点时才读对应入口。
5. **不做风格、命名、格式化、"缺测试"类意见**——那不是本审查对象（AGENTS.md 与 biome 已管）。
6. 允许运行的验证命令：`node scripts/check-boundaries.mjs`、`pnpm exec tsc --noEmit`、针对性 `pnpm exec vitest run <file>`。仅用于确认机制是否真的接线/生效；不得改代码让它们通过。

## 2. 审查标准（"什么是 shit"，从 stop-that-shit Skill 逐条推导）

对每个 scope 的文件，按八类排查：

| id | 类别 | 判定问句 |
|---|---|---|
| A | 死机制/未接线 | 这个导出/参数/钩子/配置项/分支，有没有**真实消费方**？AGENTS.md 明文："无效或未接线机制应删除或明确失败"。 |
| B | 投机防御 | 这个校验/上限/重试/TTL/降级分支，**检测到了什么、拦下后行为有什么不同**？答不出具体受支持的输入/失效路径，只是"以防万一"，即为 shit。注意反例：真实合同要求（外部 wire、不可信输入、数据完整性）的验证**不是**投机。 |
| C | 事实多重表示/状态副本 | 同一事实（事件、生命周期状态、provider 能力、工具结果）是否有多套并行表示/映射层/状态副本？参照 `dev/REVIEW-2026-09-12.md` P0-1/P0-2 类问题在 subject-runtime 重构后的残留。 |
| D | 掩盖失败 | catch/默认值是否把 failed 变成 succeeded/空/unknown 猜测？是否违反固定不变量：未知保持未知；工具结果必须区分 succeeded/failed/cancelled/unknown/not_started；外部副作用未确认不得推断成功。 |
| E | 兼容层/残留桥 | 为已删除或从未存在的行为保留的 shim、双写、re-export、旧格式读取分支。 |
| F | 越权实现 | 代码实现了 `docs/proposals/` 里**未授权/待决策**的提案内容（对照 INDEX.md 的"尚未实现"声明）；或"为将来灵活性"新增而现在无用的接缝。 |
| G | 重复验证 | 同一保证被多层各测一遍/各防一遍：调用方已校验、被调方再校验、又加测试、再加 guard 脚本。指认时须给出保留哪一层、删哪一层的建议。 |
| H | 边界语义违规 | 目录 import 边界由 check:boundaries 管，此处查**语义**违规：UI 持有权威状态、Host 依赖 UI、扩展越权改内核事实、内核混入八概念之外的概念（AGENTS.md 内核 allowlist）。 |

**严重度**：`S` = 实锤（证据齐、判定"删/塌缩/明确失败"可直接执行）；`M` = 需裁决（可能有意保留但找不到书面依据；若书面依据在 proposal/decision 里，引用之并可撤销指认）；`L` = 记录即可、不值得动。

## 3. Finding 报告格式（每个智能体逐条输出，汇总靠它）

```markdown
### <scope-id>-<序号> [S|M|L] 一句话结论
- 类别: A–H
- 位置: src/xxx/yyy.ts:120-145（列出全部涉及点）
- 事实: 这段代码做什么（读码所得，不是猜）
- 证据: 消费方检索结果（grep import/调用点、动态注册路径：extensions/loader.ts、worlds.json、apps.json、runner scope 注册、UI intents 映射）；无消费方=贴检索式与 0 命中
- 移除后果: 删掉它哪些流程照常/哪些断裂
- 处置建议: 删除|塌缩为X|改明确失败|保留但简化验证（一句话）
- 自检: 已核对过哪些可能推翻指认的点（≤3 行）
```

报告末尾固定一节 `## 本 scope 未见问题的关键点`（列 3–6 处"查过、确实干净"的机制，防止审查变成只报坏消息）。

## 4. 验证门（指认前强制自检，防误报）

- 指认"无消费方"前：除静态 import 外，必须再查动态路径——`src/extensions/loader.ts`+`runner.ts` 的扩展清单、`.uina/worlds/worlds.json`、`.uina/apps.json`、`ui/intents.ts`、vitest 配置 include、`package.json` scripts、biome/tsconfig 引用。
- 指认"防御无用"前：确认输入来源。外部 wire（provider 响应、MCP、shell、websocket、文件）的解析校验默认是需求；本地受信内核内（AGENTS.md："本地扩展默认受信任"）的重复校验默认是嫌疑。
- 指认"多重表示"前：贴出两套表示各自的读写点，证明是并行维护而非投影关系（纯函数投影是有意的，见 REVIEW-2026-09-12 的方案即"保留一层纯投影"）。
- 测试 scope 同理：指认"重复测试"前贴出两测试的断言差异为零或子集关系。

## 5. Scope 总表

| scope | 体量 | 波次 |
|---|---|---|
| A1 core/runtime/tools/session | ~3.2k | 1 |
| A2 agent+host+cli+main | ~4.0k | 1 |
| A3 ai | ~1.9k | 1 |
| B1 extensions 根系统 | ~2.4k | 2 |
| B2 内置工具扩展 | ~2.6k | 2 |
| B3 world-framework | ~1.1k | 2 |
| B4 UI 骨架 | ~5.0k | 2 |
| B5 UI 组件层 | ~7.8k | 3 |
| C1 QQ World 生产 | ~10.6k（vendor 1.8k 只审集成） | 3 |
| C2 Live2D runtime/动作 | ~6.5k | 3 |
| C3 Live2D 视觉/创作 | ~4.3k | 3 |
| C4 Minecraft World 生产 | ~8.0k | 4 |
| D1 bilibili+netease+小世界+根配置+examples | ~7.7k | 4 |
| D2 tts 扩展 | ~ts+py | 4 |
| D3 embodiment+mcp+screen-mcp | ~5k | 4 |
| E1 测试-内核侧 | ~8k | 5 |
| E2 测试-UI 侧 | ~9k | 5 |
| E3 测试-qq+live2d | ~18k | 5 |
| E4 测试-其余 world/voice/mcp | ~14k | 5 |
| E5 harness+fixtures | ~6.5k | 5 |
| F1 scripts/配置/CI/hygiene | ~2.2k | 6 |
| F2 文档声明 vs 代码 | 抽样 | 6 |

（G 汇总由编排者主会话完成，不占智能体。`.uina/worlds/live2d/models/mo/**` 若含非代码资产按 Live2D 官方格式对待，C2/C3 只审 .ts/.mjs 行为码。）

## 6. 智能体提示词模板（编排者对每个 scope 填充后下发）

```text
你是只读代码审查员，执行 Uina 全库 stop-that-shit 审查的 scope {SCOPE_ID}。
仓库根：E:\Uina\Uina。先读 AGENTS.md、dev/FACTS.md、dev/BASELINE.md，再读本 scope 清单。
禁止修改任何既有文件、禁止 git 写操作；唯一可写：docs/history/full-audit-2026-10-22/{SCOPE_ID}.md。

判定标准（全文）：
{粘贴 §2 表格 + §4 验证门 + §3 报告格式，原文}

本 scope 文件清单：
{MANIFEST}

本 scope 专属关注点：
{FOCUS}

工作方式：先列每个文件的公开导出与入口调用链，再按 A–H 八类逐条排查；每条 finding 过验证门；
全部读完清单内文件（大文件可用 grep 定位后分段读，不许只抽查就下"没问题"结论）。
完成后把报告写入指定路径，并在最终回复里给出 findings 列表（id/严重度/一句话/位置）——
这段回复是给编排者做跨 scope 汇总用的，报告文件是给你自己留档用的。
```

---

## 7. 任务

### Task 0: 准备与覆盖核对（编排者自己做）

- [x] **Step 1: 建目录并快照工作树**

```powershell
New-Item -ItemType Directory -Force docs\history\full-audit-2026-10-22 | Out-Null
git status --short > docs\history\full-audit-2026-10-22\_worktree-before.txt
```

- [x] **Step 2: 跑覆盖核对，确认没有文件落在 24 个 scope 之外**（结果：voice 扩展 9 文件并入 D2；67 个纯音频资产记 ASSET 不审行为、其接线由 D2/D1 顺带确认；pnpm-lock EXCL；无 UNCOVERED。清单 `docs/history/full-audit-2026-10-22/_coverage.txt`）

Expected: 除已声明的 scope 与"文档正文/lockfile/ LICENSE / README"类外无遗漏；有遗漏则把它并进最近的 scope 清单（改 MANIFEST，不改标准）。
- [x] **Step 3: 下发前先读 `docs/proposals/INDEX.md`**，其中"尚未实现/待决策"清单是 F 类（越权实现）指认的依据，随模板附给所有生产代码 scope（A–D）。

### Task A1: 内核四目录

**Files (MANIFEST):** `src/core/*.ts`（6）、`src/runtime/*.ts`（5，含 guard.ts、process-tracker.ts）、`src/tools/*.ts`（3）、`src/session/*.ts`（6）。共 ~3.2k 行。
**FOCUS:** ① 内核八概念 allowlist：core/runtime/session/tools 里是否存在第五概念走私（对照 AGENTS.md 冻结条款与 `docs/proposals/subject-runtime-plan.md` 阶段标记）。② `runtime/guard.ts`+`noop.ts`+`process-tracker.ts` 各自的真实调用方——B 类投机防御高发地。③ `session/recovery.ts`(759 行) 的"未完成工具结算"是否把 unknown 结算成猜测状态（D 类）。④ `tools/broker.ts`+`pipeline.ts`+`validation-errors.ts` 三层校验是否有同保证重复（G 类）。⑤ `session/navigation.ts`、`prompt-snapshots.ts`、`access.ts` 的导出逐个找消费方（A 类）。

### Task A2: Agent–Host–CLI 控制流脊柱

**Files:** `src/agent/*.ts`（7，loop.ts 1486 行为重点）、`src/host/*.ts`（3）、`src/cli/*.ts`（8）、`src/main.ts`。共 ~4.0k 行。
**FOCUS:** ① C 类主线：REVIEW-2026-09-12 P0-1 声称的 4 套生命周期表示，subject-runtime 重构后还剩几套？沿 `loop.ts → runtime/events.ts → host/events.ts → ui/adapters/agent-events.ts` 数表示层。② `agent/rewind.ts`、`queue.ts`、`stream-collector.ts`、`projection.ts` 每条接缝的消费方；注意 `src/agent/context.ts` 当前有用户未提交修改，审 HEAD 版本并标注该文件在途。③ cli 七个杂项文件（`stdio-render.ts`、`draft.ts`、`run-mode.ts`…）是否有入口从未选择的分支（A/F）。④ host 是否越权持有 UI 状态、agent 是否 import 了 extensions/ai 具体 wire（H）。⑤ 取消/steer 路径的 failed/cancelled 结算（D）。

### Task A3: AI Provider 层

**Files:** `src/ai/config.ts`、`providers.ts`（1026）、`gateway.ts`、`sse.ts`、`settings.ts`。
**FOCUS:** ① "能力未知保持未知"不变量：grep 所有给 thinkingLevels/contextWindow/usage 猜默认值的位置（D 类，含 REVIEW P0-3 thinkingLevels 覆盖问题是否仍在——该 finding 当时在 :600 附近）。② gateway 的重试/退避参数：每个重试分支对应什么已证实的失效模式，无对应即 B 类。③ 各 Provider 的分支是否接了永远用不到的 model family（A）。④ `settings.ts` 读写与 `ai/config.ts` 的职责是否两份真相（C）。

### Task B1: 扩展系统本体

**Files:** `src/extensions/` 根文件（`runner.ts` 868、`host.ts` 502、`loader.ts`、`lifecycle-scope.ts`、`renderer-registry.ts`、`runtime-hooks.ts`、`services.ts`、`commands.ts`、`ui-contract.ts`、`builtin.ts`、`index.ts`）+ `src/ui/extension-ui-context.ts`(446)。
**FOCUS:** ① `host.ts` 的手写 emit 家族 vs 通用 emit 双派发（REVIEW P0-2）现状——还有几个专用 emit 没有消费方（A/C）。② `ui-contract.ts` 每个方法找扩展侧真实调用；没扩展用的方法是 F 类"为将来"。③ ActivationScope 注册/释放的配对：有没有注册了永不释放也永不使用的通道（A）。④ `services.ts`/`renderer-registry.ts` 这类小文件的存在理由。

### Task B2: 内置工具扩展

**Files:** `src/extensions/runtime-tools/**`、`session-tools/**`、`event-frames/**`、`workspace-tools/**`、`compaction/index.ts`（735）。
**FOCUS:** ① exec-command 的 process/output 分层有无双超时/双截断（G）；AGENTS.md 明文"本地扩展默认受信任，不凭空加权限、轮次、并发或容量限制"——workspace-tools 的每一处容量/轮次/并发限制逐个对照此条（B）。② `search-core.ts`(408) 与 `rg-installer.ts`：rg 不可用时的降级路径是否真实存在过失效场景。③ compaction 的触发条件与保留尾逻辑是否重复内核 `agent/compaction.ts` 的职责——注意 FACTS.md 代码地图里列了 `agent/compaction.ts` 但 src/agent 下没有该文件，先核实文档漂移还是重构残留（E/F）。④ event-frames 投影与 `agent/projection.ts` 的关系。

### Task B3: world-framework 接缝层

**Files:** `src/extensions/world-framework/**`（13 文件 1145 行）。
**FOCUS:** ① 这是"用接缝长功能"的接缝本体：`seams.ts`、`world-tool.ts`、`world-activation.ts` 的每个公开接口，数真实 world 侧实现者（qq/live2d/mc/bilibili…），≥2 个实现者=成立，1 个=嫌疑 F 类，0 个=A 类。② `mpv-path.ts`、`json-file.ts`、`result.ts` 这类工具是否被 world 侧各自绕过重复实现（C）。③ `world-state-store.ts` 与 session 存储是否两份真相（C）。

### Task B4: UI 骨架（渲染/输入核心）

**Files:** `src/ui/ui-host.ts`（1952）、`tui.ts`、`format.ts`、`intents.ts`、`features.ts`、`src/ui/adapters/agent-events.ts`、`src/ui/core/**`（19 文件 ~2333，含 mouse-selection 509、keys 242、overlay 233、utils 368）。
**FOCUS:** ① `ui-host.ts` 行数第一：找它持有的权威状态（H——UI 不应拥有主体状态转移）；`trajectory` 状态副本是 REVIEW P0-1 遗留重点。② `core/frame-log.ts`+`scripts/diagnose-frame-log.mts`+`tps-metric` 类调试机制：诊断价值是否有人用（B/G）。③ `native/win32-*.node` 二进制与 `native-modifiers.ts` 的降级路径真实性。④ adapters/agent-events.ts 的自建 listeners+notify（P0-1 第 4 表示）。⑤ mouse-selection/keys/overlay 之间的重叠命中测试（G）。

### Task B5: UI 组件层

**Files:** `src/ui/components/**`（21 文件 6176：transcript.ts 1259、input-line.ts 1073、tool-view.ts 526、diff-view.ts 340、stream-markdown、cards、widgets/*）、`src/ui/features/**`（7 文件 1176：branch-inspector、trajectory-scene、model-picker、effort-slider、prompt-overlay、help-menu、overlays/index）。
**FOCUS:** ① 组件里私有的缓存/平滑/近似机制（smooth-reveal、ui-cache 相关）：效果可感知吗，还是自我服务的防御（B）。② `cards.ts`/`context-card.ts`/prompt-overlay 与 `session/prompt-snapshots.ts` 的数据通路是否存在两处各自解析同一事实（C）。③ branch-inspector/trajectory-scene 的只读检视：有没有为"将来可操作"预留的写路径（F）。④ 各 index.ts barrel 的 re-export 是否有人在用（E）。

### Task C1: QQ World 生产代码

**Files:** `.uina/worlds/qq/src/**`（61 tracked，~10.6k；其中 `vendor/snowluma-sdk/**` ~1.8k 只审集成点，不审内部质量）。重点：app.ts 1038、tool-schema.ts 806、render.ts 676、reader.ts 598、discovery.ts 473、scheduler.ts 439、resource-fetch 365、transport 364、facts-journal 337、control-store、operation-log、message-codec、observe。
**FOCUS:** ① 该 world 历史上有三轮设计重构（docs/history 里 before-* 文档）：每轮"before"的机制有没有残留死路（A/E）——对照这些 before-*.md 找被取代未删的实现。② reader/scheduler/discovery/facts-journal 之间的消息事实表示份数（C）。③ transport/websocket 重连与 vendor sdk 自带重试的双层叠加（G）。④ 工具 schema 806 行：每个 action 的真实调用方，agent 从不用的 action 是 F。⑤ 外部副作用（发消息/下载）未确认时的状态结算（D）。vendor 集成点：normalizeMessage 的失败路径是否被外层再兜一次（G/B）。

### Task C2: Live2D runtime 与动作表面

**Files:** `.uina/worlds/live2d/runtime.ts`(1117)、`external-actions.ts`(931)、`worker/**`(675)、`models/**`(~3.8k，motions 逐个)。
**FOCUS:** ① `docs/proposals/live2d/live2d-cue-action-repair-plan.md` 文首复核声明 vs 现状（F：修复是否已实施、还是文档未授权代码先行）。② motions 目录 10+ 个手写动作脚本：catalog/authoring 已提供参数化能力时，独立 motion 文件是否重复表示（C/G）。③ worker 生命周期：keepalive/重启分支对应的真实失效证据（B）。④ 用户未提交的 `live2d-world-performance-redesign.md` 修改在途——只读，不据此定罪现有代码。

### Task C3: Live2D 视觉与创作层

**Files:** `.uina/worlds/live2d/adapter/**`（vts-client 1072、profile 257 等 1674）、`director/**`（963+323 等 1433）、`authoring/**`（curves 345、catalog 316、action 265 等 1207）。
**FOCUS:** ① `live2d-animation-authoring-redesign.md` 是 INDEX 明文的"未授权提案"且"A2 冲突"：检查生产代码是否已有该提案的实现混入（F 重点 scope）。② vts-client 与 adapter/profile 的模型状态两份表示？（C）③ director/pipelines 对 director 主干的短路/兜底（B）。④ authoring/curves 的曲线求值与 models/motions 手写插值是否两套数学（C/G）。

### Task C4: Minecraft World 生产代码

**Files:** `.uina/worlds/minecraft/**`（38 tracked：driver 2689、runtime 2793、contracts 968、world 761、capabilities 460、dev 313；`dev-env/README.md` 读，不审 jar）。
**FOCUS:** ① FACTS.md 明文"I1 子集有实现，K1 能力子集已回退"：K1 回退的残留接口（A/E）——`capabilities/` 与 `contracts/` 里每个契约找 K1 时代遗留的声明。② driver 与 runtime 对同一实体（pos/ref/queue）的表示份数（C）——`mc-ref-issuer`、`mc-runtime-refs` 是接缝。③ 假 driver 与真协议分支的降级猜测（D：外部副作用未确认不得推断成功）。④ `dev/entry.ts` + `pnpm dev:mc`：dev 目录 313 行是否混入生产加载路径。

### Task D1: bilibili-live + netease-jukebox + 小世界与根配置

**Files:** `.uina/worlds/bilibili-live/src/**`（4108，含 client/danmaku/ingestion/send/status 面）；`.uina/worlds/netease-jukebox/**`（2423）；`.uina/worlds/pacing-ticker/**`(808)、`soundboard/**`(389)、`jukebox/`+`ticker/`（jukebox 在 .gitignore、ticker 空——僵尸目录核对，A/E）；`.uina/worlds/worlds.json`、`.uina/apps.json`；`examples/**`（4）。
**FOCUS:** ① bilibili：`docs/history/qq-reader-notification-review-*` 显示 reader/notification 模式在 qq 侧重构过——bilibili 侧同族机制（ingestion/danmaku 缓冲、重连）是否保留旧表示或被复制粘贴出第二套（C/E）。② netease-jukebox：companion-manager/mpv-lifecycle/playback-coordinator 三层对"正在播什么"的状态份数（C）；mpv 进程管理与 world-framework/child-process-registry、runtime/process-tracker 三份进程控制（C 联动 B3/D3，以本 scope 主报）；INDEX 声明"真实账号和直播链路未验收"——代码是否已按验收写死成功路径（D/F）。③ pacing-ticker 4 面测试 vs 808 行生产码的比例倒挂，重点 B/G/F。④ examples/file-events.mts 与 verify:file-events 是否两套各自发挥（G）。⑤ soundboard 与 netease 播放能力重复（C）。⑥ worlds.json/apps.json 里每个条目对应目录真实存在且非空（A）。

### Task D2: TTS 扩展 + voice 扩展（ts 侧 + python bridge）

**Files:** `.uina/extensions/tts/**`（含 bridge/*.py）；`.uina/extensions/voice/**`（driver/events/index/perception/preferences/session/tool，9 tracked——覆盖核对时发现的计划外遗漏，并入本 scope）。
**FOCUS:** ① bridge 的 adaptive_engine/维护/重试类机制：每个恢复分支对应的已证实失效（B）。② tts 有 hardening/recovery/races/maintenance 多层防御测试命名——生产码里对应的防御是否重复内核 session/进程跟踪（C/G）。③ python 侧与 node 侧协议（`fixtures/tts-contract-bridge.py` 是测试替身）字段漂移时明确失败还是静默兼容（D/E）。④ wav 临时产物写进 `uina/tmp/`（未跟踪）——生产路径写垃圾目录算 hygiene，只记一句。⑤ voice 与 tts 的关系：INDEX 说"Voice 架构：部分实现"——voice 扩展是被 tts 取代的残留（E），还是仍在接线的独立能力？先查 loader/apps.json/worlds.json 的消费方再判；tests/voice-*.test.ts、tests/tts-*.test.ts 里测已不存在合同的僵尸测试线索留给 E4（联动）。

### Task D3: embodiment + mcp + screen-mcp

**Files:** `.uina/extensions/embodiment/**`、`.uina/extensions/mcp/**`（catalog/config/proxy-tool/server-manager/output-guard…）、`.uina/mcp-servers/screen-mcp/**`（py，含 IMPLEMENTATION_STATUS.md）。
**FOCUS:** ① INDEX 明文"MCP：P0 代码实现与未验证的远端/进程边界"、"screen-mcp：真实桌面门未验收"：代码里有没有把未验收当成已实现来防御/装饰（F/B）。② output-guard 的截断/净化与工具 broker 侧结果处理的双层（G）。③ server-manager 的子进程生命周期与 `runtime/process-tracker.ts`、`world-framework/child-process-registry.ts` 是否三份进程管理（C 重点）。④ tag-stripper/body-router 的消费方（A）。

### Task E1: 内核侧测试审查

**Files (glob):** `tests/{subject-invariants,session-*,tool-*,prompt-*,projection-*,context-*,refactor-regression,hardening,subtraction,host-separation,lifecycle-scope,builtin-gutter,thinking,usage-update,image-content,input-provenance,cli-*}.test.ts` 及同族。
**FOCUS:** 测试版八类：同一保证多条测试各测一遍（G）；测试替身比被测码还厚的机制（B 镜像）；为已删机制留下的死测试（A/E）；断言"防御存在"而非"行为正确"的测试（即锁住 shit 的测试——指认时须连同其保护的机制一起处置，标"随母体删"）。

### Task E2: UI 测试审查

**Files:** `tests/{ui.test.ts(3648),ui-*,branch-inspector,tool-view,component-boundary,context-card,frame-log,terminal-size,overlay-keys,hover-target,file-candidates,prompt-card-replay}.test.ts`。
**FOCUS:** ① ui.test.ts 3648 行单文件：里面与 `ui-layout/ui-frame/ui-cache-wiring` 的重叠断言（G）；`ui-crap-c1/c2/c3` 系列测的是什么crap、机制本体现在还在不在（A/E）。② 快照式断言把布局噪声当保证的过度具体化（B 镜像：测试侧投机）。

### Task E3: qq+live2d 测试审查

**Files:** `tests/qq-world-*.test.ts`（21）、`tests/live2d-*.test.ts`（~45）、`tests/live2d-*fixture.ts`、`fixtures/qq-world-interaction-examples.json`。
**FOCUS:** ① live2d 测试面 45 个文件对 11.4k 生产码：mo-*（每个动作一个测试文件）是否重复 catalog/director 的同一保证（G）。② qq 的 before-* 设计三轮迭代后，reader/pagination/consumption 等测试是否还在测已不存在的合同（A/E）。③ e2e-lifecycle 与各单测的双层覆盖。

### Task E4: 其余 world/voice/mcp 测试审查

**Files:** `tests/{mcp-*,netease-*,pacing-ticker-*,bilibili-live-*,tts-*,voice-*,speech-cue-playback,tps-*,world-loader-discover,world-tool-schema,file-events,edit-file,exec-*,search-tools,read-truncate,rg-installer-asset,get-time,memory-*,broadcast-hud-server,compaction-*}.test.ts` + `tests/mc/**` + `tests/helpers/**`。
**FOCUS:** ① 被 .gitignore 逐条排除入库的 10 个测试（netease/tts/bilibili/pacing/voice/embodiment/soundboard）仍被 git ls-files 跟踪吗——忽略声明与跟踪状态矛盾本身是一条 hygiene finding（记给 F1，此处只留证据）。② compaction 两测试与 mc 十一测试同机制重复（G）。③ memory-* 测试对应的 memory 机制消费方是否真实（A，联动 B1）。

### Task E5: harness 与 fixtures 审查

**Files:** `tests/harness/**`（1782）、`tests/fixtures/**`（4669）、`tests/helpers/**`。
**FOCUS:** ① harness 是防 shit 的地基：matchers/invariants 与 vitest 原生断言重复的部分（G）；scenario/stream-builder 未被任何 scope 用的能力（A/F）。② fixtures 4669 行谁在用，逐个 glob 反查；无主 fixture 是 A。③ 双 VT 屏实现（`harness/environment/vt-screen.ts` 与 `helpers/vt-screen.ts`，C）。

### Task F1: scripts、配置、CI、仓库卫生

**Files:** `scripts/**`（13）、`dev/baseline.mjs`、`.github/workflows/ci.yml`、`biome.json`、`tsconfig*.json`、`vitest.config.ts`、`package.json`、`pnpm-workspace.yaml`、`assets/**`（只查引用与体量归属，2.1MB）。
**FOCUS:** ① 每个 scripts 文件找 package.json script 或 CI 消费方；`audit-motions`、`key-dump`、`mo-preview`、`measure-screen-mcp`、`qq-status`、`verify-qq-media`、`generate-qq-tool-schema`、`diagnose-frame-log` 逐个定生死（A）。② `scripts/crap.mjs` 在 .gitignore 里但本地存在——确认其是否一次性工具残留（E，只报告不删）。③ vitest include/exclude 与 .gitignore 测试排除清单的矛盾（见 E4 ①）。④ ci.yml 跑的门与 package scripts 的双份漂移（C/G）。⑤ `uina/tmp/*.wav+log`、`.uina/worlds/qq/v2/*/downloads/` 垃圾目录归位建议（hygiene 一句话级）。

### Task F2: 文档声明 vs 代码（抽样门）

**Files:** `docs/current-runtime.md`、`dev/FACTS.md`、`dev/BASELINE.md`、`dev/DECISIONS.md`、`docs/proposals/INDEX.md` + subject-runtime-plan 阶段标记；抽查方式：每份文档提取"可判真伪的具体声明"（文件存在、命令存在、机制存在、阶段完成），逐条回源码验证。
**FOCUS:** 双向漂移都报：文档声称已完成但源码无（E/夸大）、源码已重构但文档仍描述旧事实（误导后续 agent——这类按 S 报，因为 AGENTS.md 把 FACTS/BASELINE 列为必读，坏事实比没事实糟）。已知样本线索：FACTS 代码地图列 `agent/compaction.ts` 而 src/agent 无此文件；代码地图未列 `.uina/worlds` 侧结构。

### Task G（编排者汇总，非智能体）

- [ ] 收齐 24 份报告与最终回复的 findings 列表。
- [ ] 跨 scope 去重：同一机制被两个 scope 指认（典型：进程管理三份 C 类会被 B3/D3/E4 同时报），合并保留最完整证据链，位置取内核侧。
- [ ] 对每条 S 级 finding 抽查复核（读原 file:line，确认验证门证据真实）；不合格降级或撤销。
- [ ] 写 `docs/history/full-audit-2026-10-22/summary.md`：总量分布（S/M/L × 类别 A–H × 层）、Top10 最值钱的塌缩机会（按"删除行数×风险低"排）、每条 finding 的处置建议一句话。
- [ ] 收尾核对：`git status --short` 相对 `_worktree-before.txt` 只多了 `docs/history/full-audit-2026-10-22/` 新目录——向用户证明零代码改动。

---

## 8. 执行方式

- **推荐:** 用 DSH `workflow` 工具按波次 fan-out（波内并行、波间串行：波 1 A* → 波 2 B1–B4 → 波 3 B5/C1/C2/C3 → 波 4 C4/D1/D2/D3 → 波 5 E* → 波 6 F*；F2 可并入波 1，文档漂移越早越好）。每个 agent 领 §6 模板 + 该 Task 的 MANIFEST/FOCUS。
- **备选:** 逐 scope 手发 `subagent`，每波后人工过一遍再发下波（更可控但更慢）。
- 汇总由主会话完成，不外包。

## 9. 明确不做（防审查自身变成 shit）

- 不建 checklist/打分系统/复审轮：一次 finding 复核由编排者抽查完成，不派"审审查"的二轮智能体。
- 不改代码、不顺手"小修复"、不新增 lint 规则建议（除非某条 finding 本体就是该删的机制）。
- 不给每个文件写"总体还行"的综述段落；报告只有 findings 和"未见问题的关键点"清单。
- 不审 `E:/Uina/ThirdParty/pi`、node_modules、dist、coverage、world-data、未跟踪临时目录内容。
