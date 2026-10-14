# Live2D / Voice / Embodiment 连通性重构计划

状态：**重构计划 v1（未改动任何代码）**
日期：2026-09-21
依据：`docs/proposals/embodiment/embodiment-voice-live2d-audit.md`（审查报告 v1）
目标：消除审查报告 §3–§5 发现的全部缺陷，并保证新缺陷能被门禁捕获而非再次静默

---

## §0 统一诊断：三处根因是同一类缺陷

对抗式复盘后，审查报告里的 R1（活对象）、R2（事件契约）、R3（取消信号）不是三个独立问题，而是**同一类缺陷的三次显影**：

> **框架边界把信息丢了。** 丢函数（`structuredClone`）、丢事件类型（`onActivity` 只剩 `origin`）、丢取消信号（`ActionContext` 无 `signal`）。

三次都用了同样的"绕过去"手法（`as any`、吞异常、声明了却无人填充的字段），三次都在边界内侧被 mock 掩盖。

因此解法模式也是同一个：**在边界上显式增补该通道，并为每处钉住不变量**。这带来一个重要的 Ockham 收口——

**三个新机制覆盖全部八个连通性缺陷。** 不需要八处补丁：

| 机制 | 覆盖的缺陷 |
| :--- | :--- |
| **M1 同进程共享原语**（`share`/`shared`，不序列化） | S1 → 连带 S2 / S3 / S8；S5 |
| **M2 动作取消信号透传**（`ActionContext.signal`） | S9 |
| **M3 宿主事件流订阅**（world-framework 发布） | S6 |

---

## §1 依赖图与拓扑分层

### 1.1 因果主干

```
R1 活对象通道缺失 ──> S1 端点注册断 ──> S2 cue 词汇未注入
        (根因)           (直接症状)  ├──> S3 cue 派发断
                                    └──> S8 身体管理被架空

R2 事件契约过窄 ────> S6 反射 3/4 不可达
R3 边界丢取消信号 ──> S9 动作取消断裂
R4 两条口型路径并存 ─> S5 音频旁路双向断
R5 门禁不含 .uina ──> G1–G6 类型逃逸与测试漏网
R6 测试观测面错位 ──> (放大器：掩盖 R1/R3 的后果)
```

### 1.2 拓扑序（严格前置关系）

```
第 0 层（根因，必须先定口径）
  R1  R2  R3  R4  R5  R6

第 1 层（由根因直接解除）
  S1  ← R1
  S6  ← R2
  S9  ← R3
  S5  ← R4（且其接线依赖 M1）
  门禁 ← R5

第 2 层（S1 的下游，修好 S1 即自动恢复）
  S2  ← S1
  S3  ← S1
  S8  ← S1

第 3 层（无前置依赖，可完全并行）
  S7  打断闭环未实现（需求缺口，见 §5）
  S10 cue 标签被念出
  S11 Layer 1 关键帧死码
  S12 投机服务面
  S13 DESIGN 失配
  S14 重心游移名不副实
```

### 1.3 关键依赖推论

1. **S2 / S3 / S8 不是独立工作项**。修好 S1 后它们自动恢复——**只需补断言，不需补代码**。把它们当独立任务会浪费成本。
2. **M1 是唯一的关键路径瓶颈**。S1 与 S5 都卡在它上面。M1 定不下来，批次 2 无法启动。
3. **R4（口型路线）与 M1 无关**，但"接电平"方案需要 M1 作为投递通道，所以仍排在 M1 之后。
4. **R5 / R6 不阻塞功能修复**，但若不做，本轮修复会重演"修好又被下一个缺陷静默"的循环——**建议与批次 1 同期落地**。
5. **S7 不依赖任何东西，也不被任何东西依赖**——它是唯一真正的独立项。

---

## §2 必须先裁定的决策点

### D1 — 活对象通道怎么建（最关键，决定批次 2 全部形态）

先说清一件事：**无论 Live2D 是 App 还是 Extension，都必须先建一条新通道。** 因为 Uina 当前**没有任何"扩展间同进程活对象共享"的接缝**：

- `callService` 双向 `structuredClone`（`runner.ts:558-564`）
- `registerService` 的 handler 由注册方持有，调用方拿到的是克隆返回值
- `callTool` 是工具管线，不是共享通道

所以"把 Live2D 升格为 Extension"**并不能自动解决 S1**——一升格就会撞上同一堵墙。这改变了问题性质：不是"Live2D 造错了形态"，而是**扩展系统缺一个接缝**。

| 方案 | 做法 | 评价 |
| :--- | :--- | :--- |
| **A 命令转发** | App 把活对象登记到 world-framework；framework 注册 `app:invoke` 服务，入参 `{app, method, args}` 全纯数据 | `callService` 不变量不破。**但 `BodyRouter.dispatchCue` 同步签名 vs `callService` 异步必起冲突** → 退化为 fire-and-forget，`affordance()`/`state()` 这两个**筛选依据**要另建缓存层。新增 4 项机制，其中含"同步外壳内的异步转发"这种欺骗性结构 |
| **B 升格 Extension** | `.uina/worlds/live2d/` → `.uina/extensions/live2d/` | 不解决 S1（同上）。且丢掉 world_store / `/worlds.json` / 三档视口 / 门面内置 action。**用户已明确"别做多余的事"，此处代价远超收益** |
| **C 新增同进程共享原语（推荐）** | `pi.share(name, value) → dispose` + `pi.shared(name)`；App 侧经 `ServiceCompanionContext.expose` 转发 | 一个零语义 KV 表，不做任何解释、不序列化。**同步**——彻底消灭方案 A 的同步/异步张力与缓存层。不动 Live2D 的 App 形态。不触碰内核（`runner.ts`/`host.ts` 均在 `src/extensions`，不在五目录 allowlist 内） |

**我推荐 C。** 理由（Occam + 第五关）：

- **新机制数**：A = 4（expose + invoke + 缓存 + 代理类）；C = 1（一个 KV 表）。
- **不变量**：C 不破坏 `callService` 的纯数据契约，而是给它加一个**互补的兄弟原语**——"纯数据走 `callService`，活引用走 `share`"。这个分工可以作为一条新铁律写进文档，语义清晰无歧义。
- **第五关（新增公开接缝需证明至少一个高级能力不再修改 Core）**：embodiment + Live2D + TTS 三方共享，正是合格证。
- **信任模型一致**：AGENTS.md 明确"本地扩展默认受信任，不凭空增加权限、取消并发或容量限制"——同进程共享活对象不违反该模型。

拟定签名：

```ts
// src/extensions/runner.ts — ExtensionAPI
/** 同进程具名共享（不序列化）：把活引用（对象/函数）交给其他扩展消费。
 *  与 callService 的分工：纯数据走 callService，活引用走 share。
 *  生命周期与 registerService 同权：注册方 scope 销毁时自动清理。 */
share(name: string, value: unknown): () => void;
shared(name: string): unknown | undefined;

// src/extensions/world-framework/types.ts — ServiceCompanionContext
/** 同进程行为出口：App 只能被消费，不获得主动伸手的能力。 */
expose?: (name: string, value: unknown) => () => void;
```

**关键设计约束：App 只拿写方（`expose`），不拿读方。** 这样 App 保持"零 `pi` 纯净契约、不主动伸手"的边界；消费方一律是 Extension（有 `pi.shared`）。这条约束让 App 契约不被稀释。

### D2 — 口型路线（口型 §7 B1 的裁定）

| 选项 | 得到 | 代价 |
| :--- | :--- | :--- |
| 删除自主旁路 | 消除两套口型打架风险 | 失去 Layer 3 声学微冲（VTS 只动嘴）；失去口型通道主权（`shocked`/`laugh`/`sleepy_yawn` 嘴型被 VTS 覆盖） |
| **接电平（推荐）** | 拿回 Layer 3 + 口型主权 | 桥侧一次 O(N) RMS + 现有 SSE 每 ~30ms 一帧；**消费端 `AudioObserver.processLevel` 与 `VoiceLevelEvent` 均已就位** |
| 接 PCM | 完全自治 | 需新建 Python→Node 二进制传输；触及设计自设的"零分配"红线 |

### D3 — 门禁范围与测试归属

- `.uina/**` 纳入 `tsconfig` include：**实测代价为 0 错误**（已用探针 tsconfig 验证），是零成本改动。
- 5 个关键测试（`live2d-app` / `live2d-motion-core` / `embodiment-runtime` / `voice-extension` / `tts-extension`）当前在 `.gitignore` 第 28–34 行。**不入库 = 连接最脆弱的层没有版本化的回归网**。

### D4 — S7 打断闭环是否纳入本轮

**我建议不纳入**，理由见 §5。本轮目标是"让已实现的机制真正通电"，ASR/VAD 是新增功能，混入会污染批次边界。

---

## §3 重构批次

### 批次 0｜口径裁定（无代码产出）

| 项 | 内容 |
| :--- | :--- |
| 产出 | D1/D2/D3/D4 四项裁定落成文字，写入本文件 §2 作为执行依据 |
| 退出条件 | 四项均有明确结论；D1 的机制签名定稿 |
| 风险 | **这是唯一无法跳过的批次**。D1 未定就动批次 2，等于在错误契约上施工 |

---

### 批次 1｜框架契约补齐 + 真实边界测试骨架

**目标**：把 M1/M2/M3 三个机制建起来，并让测试第一次跨越真实边界。

| 改动 | 文件 | 内容 |
| :--- | :--- | :--- |
| M1 | `src/extensions/host.ts` | 新增同进程共享表（与 `handlers`/`hookHandlers` 平级）；`onScoped` 同权清理 |
| M1 | `src/extensions/runner.ts` | `ExtensionAPI.share/shared`，走 `ownRegistration` |
| M1 | `src/extensions/world-framework/types.ts` | `ServiceCompanionContext.expose?` |
| M1 | `src/extensions/world-framework/app-registry.ts` | 构造 ctx 时转发 `expose → pi.share` |
| M2 | `src/extensions/world-framework/types.ts` | `ActionContext.signal: AbortSignal` |
| M2 | `src/extensions/world-framework/facade-tool.ts` | 把 `run(rawArgs, signal)` 的 signal 放进 `actionContext` |
| M3 | `src/extensions/world-framework/app-registry.ts` | 经 M1 发布 `world-framework.hostEvents`（`subscribe` 函数）；`onActivity` 保留或废弃见 D3 附带裁定 |
| 测试骨架 | `tests/harness/` | 复用既有 harness，新增"真实 extension + 真实 app + 真实 runner"组合夹具 |
| 骨架断言 | 新测试 | 一条**能捕获 S1 的失败测试**（当前应当红）——这是本批次最有价值的产出 |

**验收**：`typecheck` + `boundaries` + 全量 vitest + CRAP 全绿；新骨架测试在接入批次 2 前保持红（故意红以钉住缺陷）。

**风险**：M1 是新公开接缝，必须过一次对抗式评审——**审"它会不会变成绕过 `callService` 的万能后门"**。缓解：名称与文档明确"仅同进程、仅活引用、不做语义解释"，并在 `boundaries` 检查里确认它不被内核目录使用。

---

### 批次 2｜三块实体接线

**目标**：把批次 1 的机制接上，恢复全部连通性。

| 项 | 文件 | 改动 | 断言 |
| :--- | :--- | :--- | :--- |
| S1 | `.uina/worlds/live2d/runtime.ts:143-158` | 注册改走 `ctx.expose("body.endpoint:live2d_mo", endpoint)`；删除 `callService` 分支与 `console.warn` 吞异常 | 真 runner 下 `body({action:"list"})` 含 `live2d_mo` |
| S1 | `.uina/extensions/embodiment/index.ts` | 用 `pi.shared()` 发现端点并注册进 router；注册失败必须可观测（`pi.reportError`） | 注册后 `getPrimaryBodyId() === "live2d_mo"` |
| S2 | `embodiment/context-projector.ts` | 无需改代码（S1 下游） | `turn.prepare` 后的 systemPrompt 含 17 条 cue id |
| S3 | `embodiment/body-router.ts` / `tag-stripper.ts` | 无需改代码（S1 下游） | 喂 `<cue id="warm_smile"/>` 后 endpoint 收到原样 id |
| S8 | `embodiment/tools.ts` | 无需改代码（S1 下游） | `switch_focus` / `pause` 返回成功 |
| S5 | `tts/index.ts` + `bridge` | 按 D2 落地；**删除 `ctx.audioSink` 分支**，改由 tts `pi.share("tts.levelFeed", {subscribe})`、Live2D `ctx.use` 不可用故改为 tts 主动推给已 expose 的 sink | `processLevel` 被真实调用；`mouthOpenY > 0` |
| S6 | `.uina/worlds/live2d/runtime.ts:175-195` | 订阅 `world-framework.hostEvents`；**修正死判断** `event.type === "thinking"` → `output_update` + `channel === "thinking"` | `onThinking` / `onTurnEnd` / `onTurnAborted` 均可达 |
| S9 | `.uina/worlds/live2d/index.ts` 4 个 action | `arbiter.claim(..., {signal: ctx.signal})`；`flip` 的 25 步循环加 `signal.aborted` 检查 | abort 后物理动作序列停止，且不谎报 `succeeded` |
| S10 | `.uina/extensions/tts/stream-parser.ts:11-30` | `cleanSentence` 增加 `<cue .../>` 剥离（保持无代理原则，不复用 embodiment 的 `cleanText`） | 喂 cue 后合成文本零 cue 残留 |
| 清理 | `.uina/worlds/live2d/runtime.ts:85-90` | **删除 `Live2DCompanionContext` 的 4 个投机字段**（`audioSink`/`onHostEvent`/`bodyRouter`/`vtsClient`），由真实通道取代 | 文件内无未填充契约字段 |

**验收**：批次 1 的骨架测试由红转绿；新增 9 组断言全绿；每项缺陷有对应断言，**断言必须跨越真实边界**（不得再用 mock `callService`）。

**风险**：S9 会把 `ctx.signal` 引入 action，需确认 `facade-tool` 上游（`ToolBroker`）确实在取消时 abort 该 signal——若无，则 M2 只是搬了一个永远不 abort 的信号，**修的是假问题**。此项列为批次 2 的第一个验证点。

---

### 批次 3｜清扫（每项单独列给你确认后执行）

| 项 | 对象 | 建议 |
| :--- | :--- | :--- |
| S11 | `motion-composer.ts` 的 `playClip`/`MotionClip`/`evaluateSegment`/`activeClips` | **删除**。Layer 1 无加载器、无 `motion3.json` 解析、无调用者；保留即"看起来四层实际三层" |
| S12 | `voice:register_driver`、`tts`、`embodiment:get_router` | **删除**（零生产调用者；`embodiment:get_router` 还会再招一次 S1 类错误） |
| S12 | `voice:set_muted/interrupt/get_status` | **保留 + 注明"当前无消费者"** |
| S14 | `physiological-noise.ts:163` 的 `ParamBodyAngleX: 0` | **接线**（真实重心游移）或**改文档**，二选一 |
| — | `index.ts:17-44` 的 6 个 `getLive2D*` 兼容访问器 | **删除**（自称"向后兼容测试"，生产零用途） |
| — | `reflex-director.ts` 若 S6 采纳 | 随 S6 一起接线，不在此批删 |

---

### 批次 4｜门禁与可验证性

| 项 | 改动 | 验收 |
| :--- | :--- | :--- |
| G1/G4 | `tsconfig.json` include 加入 `.uina/worlds` `.uina/extensions`；`tsconfig.build.json` 同 | 实测 0 错误（已验证） |
| G5/G6 | 删除 `embodiment/index.ts:48,57` 的 `as any`（**已实证两种变体均无需 cast**） | typecheck 绿 |
| R6/D3 | 5 个关键测试移出 `.gitignore`；补真实边界集成测试 | `git ls-files tests/` 含这 5 个文件 |
| — | `boundaries` 检查确认内核目录未使用 `share/shared` | `check:boundaries` 绿 |

---

### 批次 5｜文档对齐（S13）

| 文档 | 待修 |
| :--- | :--- |
| `voice-architecture.md` | §5 代码拓扑（实现已迁 tts）；§1.1「0 个 Tool」与现实矛盾；§3.4 ASR/VAD 标注为未实现；§4 Level 2 未实现 |
| `embodiment-architecture.md` | §3.1 `emitCue(cueId, payload?)` → 实际只有 `emitCue(cueId)` |
| `live2d DESIGN.md` | §3 Layer 1 状态；§3.1「重心游移」名不副实 |
| 新增铁律 | **"纯数据走 `callService`，活引用走 `share`"** 写入扩展开发文档与 `agent-world-framework.md` §7 |
| `agent-world-framework.md` | §7.1 把 Live2D 列为 App 典范——按 D1 结论决定是否加注 |

---

## §4 提交与门禁纪律

每批次收尾（与项目既有约定一致）：

```
pnpm typecheck                      # 含 check:boundaries + tsc --noEmit
npx vitest run --pool=vmThreads      # 务必 vmThreads 池
node scripts/crap.mjs --gate        # CRAP 门禁，新欠账零容忍
git ls-remote origin                # 直读远端校验推送（勿信本地 ref）
```

- 每批次独立提交，**批次 2 必须拆成 3 个提交**（S1+M1接线 / S6+S9 / S5+S10），否则一次回滚代价过大。
- 批次 1 与批次 4 的顺序建议对调一半：**把 `tsconfig` include 提前到批次 1 开头**——这样后续所有改动的类型错误立刻暴露，而不是等到最后。这是本计划唯一一处对拓扑序的**有意违反**，理由是它只增约束、不改行为，且能把错误暴露点前移。

---

## §5 明确不做的事

| 项 | 理由 |
| :--- | :--- |
| **S7 全双工打断（ASR/VAD）** | 这是**新增功能**而非既有连接修复，属独立工程（麦克风采集 + VAD + ASR 客户端 + 打断闭环），混入会污染批次边界。建议另立执行稿。本轮只做一件事：把 `voice-architecture.md` §3.4 明确标注为"规划未实现"，**消除文档对现实的不实声明** |
| Live2D 升格为 Extension | 不解决 S1（同堵墙），且丢掉 world_store/视口/持久化，代价远超收益 |
| 把 `AudioPcmChunk` 接成二进制传输 | 触及设计自设的"零分配复用"红线，而"接电平"以更低成本买到核心能力 |
| 为口型新建 `RuntimeEvent` 词条 | 会动内核词表，需过四关；M1 通道足以承载，无需扩词表 |
| 重构 world-framework 的视口治理 | 无证据表明其存在问题；不做无证据的重构 |

---

## §6 全量覆盖矩阵（确保无遗漏）

| 编号 | 问题 | 根因 | 批次 | 断言 / 验收 |
| :--- | :--- | :--- | :--- | :--- |
| R1 | 边界丢函数 | — | B0 裁定 / B1 M1 | 集成测试：端点注册成功 |
| R2 | 边界丢事件类型 | — | B1 M3 | `onThinking` 被真实触发 |
| R3 | 边界丢取消信号 | — | B1 M2 | abort 后 action 中断 |
| R4 | 两条口型路径并存 | — | B0 裁定 / B2 | 二选一落地，另一条删除 |
| R5 | 门禁不含 `.uina` | — | B1（提前）/ B4 | include 生效，0 错误 |
| R6 | 测试观测面错位 | — | B1 骨架 / B2 断言 | 断言跨越真实边界 |
| S1 | 端点注册断 | R1 | B2 | `list` 返回 `live2d_mo` |
| S2 | cue 词汇未注入 | S1 | B2 | systemPrompt 含 17 条 id |
| S3 | cue 派发断 | S1 | B2 | `emitCue` 收到原样 id |
| S4 | 语音意志链（本就通） | — | — | 回归保护：不得被本轮改动打破 |
| S5 | 音频旁路双向断 | R4+R1 | B2 | `processLevel` 真实调用，`mouthOpenY > 0` |
| S6 | 反射 3/4 不可达 | R2 | B2 | 4 个策略全可达 |
| S7 | 打断闭环未实现 | — | **范围外** | 仅修文档声明（B5） |
| S8 | 身体管理被架空 | S1 | B2 | `switch_focus`/`pause` 成功 |
| S9 | 动作取消断裂 | R3 | B2 | abort 后停止且不谎报成功 |
| S10 | cue 标签被念出 | — | B2 | 合成文本零 cue |
| S11 | Layer 1 关键帧死码 | — | B3 | 删除 或 补 loader |
| S12 | 投机服务面 | — | B3 | 删除 或 标注 |
| S13 | DESIGN 四处失配 | — | B5 | 四份文档与实现一致 |
| S14 | 重心游移名不副实 | — | B3 | 接线 或 改文档 |
| G1–G4 | 门禁盲区 | R5 | B1/B4 | typecheck 覆盖 `.uina` |
| G5–G6 | 唯一漏网文件 + `as any` | R5 | B4 | cast 删除，typecheck 绿 |

**21 项全部有归属。** 其中 3 项（S2/S3/S8）无代码改动、只有断言；1 项（S7）明确排除并说明理由；1 项（S4）为回归保护。

---

## §7 工作量与成本提示

| 批次 | 新增机制 | 改动文件数（估） | 新增断言 |
| :--- | :--- | :--- | :--- |
| B0 裁定 | 0 | 0 | 0 |
| B1 框架 | 3 | ~6 | 1 红 + 1 骨架 |
| B2 接线 | 0 | ~8 | ~9 |
| B3 清扫 | 0 | ~5 | 回归 |
| B4 门禁 | 0 | ~4 | 5 文件入库 |
| B5 文档 | 0 | ~5 | — |

**总新增机制：3 个**（M1/M2/M3），全部在 `src/extensions` 层，不触碰内核五目录。

---

## 附录：本计划依据的新增实证

| 事实 | 验证方式 | 用途 |
| :--- | :--- | :--- |
| `.uina` 纳入 typecheck 的错误数为 **0** | 探针 tsconfig + `tsc -p` | D3 成本评估（零成本） |
| `embodiment/index.ts` 的 `as any` **不必要**（两种写法均通过） | 探针脚本 + `tsc --noEmit` | G6 可直接修 |
| `facade-tool.ts` 只做 upfront `signal?.aborted` 检查，**不转发 signal**；`ActionContext` 无 `signal` 字段 | 读 `facade-tool.ts:205-244` + `types.ts:22-36` | R3 / S9 的确立 |
| App 拿到的 `signal` 是 `WorldRegistry` 的**全局** `abortController.signal`，只在 `disposeAll()` 时 abort | `app-registry.ts:123,244` | 证明 App 侧取消语义与 action 取消完全不同 |
| `RuntimeHooks.events` 只有 `emit`/`observe`/`flush`，**无 `subscribe`**；订阅在 `ExtensionHost.on` | `runtime/hooks.ts:96`、`extensions/host.ts:90` | M3 必须由 world-framework 代订并发布 |
| DESIGN.md §4 写的 `ctx.signal` 在真实 `ActionContext` 中**不存在** | 对比 `DESIGN.md:207,241` 与 `types.ts` | S13 文档失配清单补充 |
