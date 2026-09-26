# 声音自感知（voice perception）任务拆解

状态：M1 + M2 已落地（实现完成；端到端待 bridge 上线）
日期：2026-09-23
范围：`.uina/extensions/voice/` + `.uina/extensions/tts/`（不碰 `src/`）

---

## 0. 第一性原理

问题不在"缺一个视口"，在**三种时间尺度的错位**：

1. 文本是**一次性**吐出的（一个 turn 一次 output_update 流）。
2. 声音是**串行**交付的（按句切分，逐句合成、排队、播放）。
3. 我的判断发生在**文本时刻**，而后果发生在**音频时刻**。

于是产生三个真实缺陷：

- **无法配速**：不知道话说到哪，就无法决定"再补一句还是闭嘴"。
- **无法理性自断**：排队 5 句时继续写，等于往队列里丢垃圾。
- **无法知道对方听见了什么**：断点只有字符数，没有"哪句、哪几个字"。

**不变量（设计红线）：**

- 文本的权威在我（我交出去的），进度的权威在 bridge（物理的）。二者不得互相冒充。
- 渲染路径上不允许出现 IO。视口必须读内存快照。
- 视口只在**它能改变我下一步动作**时才存在。

## 1. 目标 / 验收

**DoD**：开麦说一段长回复时，我能在一行内知道自己处在"第 k/n 句、还有 m 句排队"；被打断后，知道自己交出去的哪几个字已播、哪一段没播。

**非目标（明确不做）**：

- 不做麦克风/ASR 侧感知（当前无数据源，另立任务）。
- 不做逐帧声学电平（口型用）。
- 不做实时字幕流进上下文（噪音，挤正事）。
- 不改 `src/`，不新增跨扩展 IPC 服务。

## 2. 系统视图

```
我的文本 ──StreamParser──▶ 句 ──client.speak(segment_id)──▶ bridge（合成/播放）
   │                              │                              │
   │ 作者侧真值                    │ 记账点                        │ 物理真值
   ▼                              ▼                              ▼
segmentTexts: Map<idx,text>   TtsVoiceOutputDriver      getSubtitleState()
                                 │                              ▲
                                 └──── push 快照（内存）────────┘
                                          │
                                          ▼
                              ambient 视口（仅开麦时一行）
```

**关键决策（系统思维）**：投影点放在 **tts 扩展**，不放 voice 扩展。

理由：视口每轮都要渲染。若放 voice，每轮要跨扩展 IPC 查 status（异步、可失败、有竞态），且制造第二份真相。tts 扩展同进程持有 driver 对象，零 IPC、零竞态。voice 只保留它唯一权威拥有的东西：**打断断点**（单轮退火，已有）。

## 3. 任务拆解

| # | 任务 | 依赖 | 产出 | 验收 |
|---|---|---|---|---|
| T1 | 契约扩展：`PlaybackStatus` 加 `segmentIndex?` / `pendingSegments?`（可选字段，向后兼容） | — | `voice/driver.ts` | 类型通过编译，旧 driver 实现不受影响 |
| T2 | 记账收口：把 `client.speak()` 的提交统一收进 driver（`submitSegment(text)`），内部维护 `segmentTexts: Map<idx,text>` + `currentSegment` | T1 | `tts/driver-impl.ts`、`tts/index.ts` 调用点 | 单测：提交 3 句后 map 有 3 条，索引连续 |
| T3 | 进度填充：`getStatus()` 从 `getSubtitleState` 计算 `segmentIndex` 与 `pendingSegments(= playback_completed=false 计数)` | T2 | `driver-impl.ts` | 单测：伪造 subtitleState → 字段正确；异常时降级为 idle |
| T4 | **push 快照**：driver 在 submit / turnEnd / interrupt 后更新内存快照；渲染只读快照 | T2 | `driver-impl.ts` | 渲染函数零 await |
| T5 | ambient 渲染：开麦时一行；静音/离线时整行消失（0 token）；idle 收成短式 | T4 | `tts/index.ts` 的 turn.transformContext 钩子 | 单测：四种状态各一条期望字符串 |
| T6 | 打断文案升级：用 `segmentIndex` 翻 `segmentTexts`，输出"已听到的第 N 句止于「…」" | T2、T4 | `voice/session.ts`（断点结构加 `segmentText`） | 单测：断点 → 文案；无映射时回退旧文案 |
| T7 | 测试补齐 + 回归 | 全部 | `tests/tts-extension.test.ts` 等 | `pnpm vitest run` 相关套件全绿 |
| T8 | 备份（前置）：`.uina/` 不入 git，改前先快照 voice/tts 源码 | — | `.uina/backups/<date>/` | 文件存在、可 diff |

**前置（先做）**：T8。理由：这段代码没有任何版本控制兜底，改坏了不可回滚。

## 4. 对抗式审查（预演反驳）

| 反驳 | 处理 |
|---|---|
| A1 "每轮多 15 token，值吗？" | 只在开麦时投；关麦/离线整行消失。token 成本与"我是否会误判配速"绑定。 |
| A2 "每轮异步查 status 会拖慢回合" | 改成 push 快照（T4）。**渲染路径禁止 IO**。这是本轮最重要的修正。 |
| A3 "查 bridge 失败怎么办？" | 视为"未知"，该字段省略，不阻塞、不报错刷屏。 |
| A4 "segmentTexts 内存泄漏" | 每 turn 重置，只留当前 trace，条数上限 N(=32)。 |
| A5 "文本与 bridge 实际朗读不一致" | 只声明"我交出去的是什么"，不声明"物理念出的逐字"。进度以 index/count 为准。 |
| A6 "会不会变成我盯着自己说话、自我监视的噪音" | 只有 `pending>0` 或被打断时给全量；idle 只给"开麦·空闲"。 |
| A7 "voice 与 tts 投影职责重叠" | voice 只管断点（它权威拥有），tts 管实时谱。两条不交叉。 |
| A8 "过度设计" | 奥卡姆裁剪见下。 |

## 5. 奥卡姆裁剪（砍掉的）

- 砍：`getSubtitleState` 的 `revealed_text` 当真相 → 只当校验，内容来自我方记账。
- 砍：新增 `voice:get_status` 类 IPC 服务 → 同进程直连够用。
- 砍：字符级逐字跟随视口 → 只在打断那一刻用。
- 砍：独立的"语音仪表盘 app" → 一行 ambient 不配一个应用。
- 砍：ASR/麦克风 → 没有数据源，不做"看起来完整"的空壳。

## 6. 里程碑

- **M1（最小可用）**：T8 → T1 → T2 → T4 → T5。验证：开长麦，视口出现 `第k/n句 排队m`。
- **M2**：T6，打断文案精确到"听见的最后一句"。
- **M3（另立）**：探查 bridge 是否有麦侧（输入）事实可接。

## 7. 已知风险

- bridge 当前离线（物理播放: 离线），端到端验证要等它起来；M1 用假 driver + 假 fetch 做单测覆盖（已做）。
- 版本控制已核实：`voice`、`tts` 各自是独立 git 仓库（早前"无版本控制"的结论是错的，错在只看了主仓库的 `.gitignore`）。因此 `.uina/backups/` 快照属于重复包袱，已删除，回滚交给 git。

---

## 8. 实现记录（与计划的差异，2026-09-23 落地）

**T1 不是"加两个可选字段"，而是重写契约。** 计划里写了"向后兼容的可选字段"，那会留下兼容性僵尸。落地版直接替换：

- `PlaybackStatus`（`playback`/`activeTraceId`/`lastCommittedCharEnd`）→ **`DeliverySnapshot`**：`online` / `muted` / `submittedSegments` / `spokenSegments` / `pendingSegments` / `currentSegmentIndex` / `currentSegmentText` / `committedCharEnd`。
  - 初版快照里还有 `phase`（idle\|playing\|synthesizing）与 `activeTraceId`，两者**从未有过消费者**（`synthesizing` 与 `playing` 的区分没人读）——已在收敛阶段删除，不留在“以后可能有用”里。
- 读取路径收敛：新增 `snapshot()`（**同步、零 IO**）；旧的 `getStatus()`（异步、每轮一次 IPC）删除，`voice_driver:get_status` 服务名一并消失。

**T2 的调用点消失了。** `client.speak()` 的提交口收进 `submitSegment(text)`，`tts/index.ts` 里那两处 `speak` 调用点和 `nextSegmentIndex()/currentSegmentIndex` 取值全部删除——句序、文本、trace 只由 driver 一处记账。

**新增（计划里没有的）**：

- `tts/delivery.ts`：纯函数层（`summarizeProgress` / `renderDeliveryLine` / `renderBreakpointNotice` / `clipText`）。归纳与渲染从状态机里剥出来，所以每条规则都能被单测钉住，不必启扩展。
- `probe()`：唯一的 IO 读点，由 tts 的 1s 轮询在"还有音频在路上"时推进，队列排空即自停（`isDelivering`）。**探测失败保留上一份已观测事实**（陈旧但真实），不臆造"已停"或"已播完"。
- 轮次交接改成"开新账期"而非清零：`startTurn` 只标记 `epochDirty`，首次 `submitSegment` 才切账期。上一轮音频还在响时，新一轮开头读到的仍是真实交付状态。

**交付视口的退火规则（T5 细化）**：

- 断点提示优先级高于实时行，且**只报一次**（消费即清）；两者都无话可说时钩子返回 `undefined`，0 token。
- 实时行只在"开麦 + 在线 + 本轮确实交过句子"时出现。

**voice 侧同步瘦身（T6 的连带）**：`voice/session.ts` 不再自建单轮退火断点（那会与 tts 的视口争抢同一事实），只保留它唯一权威拥有的"发声意志"；`voice/index.ts` 删掉上下文钩子与 `turn_aborted` 之外的一切投影逻辑，只留 `turn_aborted → session.interrupt()`。

**验证**：`tests/voice-extension.test.ts`（8）、`tests/tts-extension.test.ts`（33）、新增 `tests/tts-delivery-perception.test.ts`（11）全绿；全仓 `vitest run` 1059 passed / 1 expected fail / 0 failed。

---

## 9. 收敛记录（2026-09-23 第二轮：全局审查 → 收敛 → 验证）

审查发现的问题里，有两类：**真正的错**与**多余的结构**。两类都处理了，逐项对账：

| 发现 | 善后 |
| --- | --- |
| `turnOpen` 只写不读（死状态） | 连同 `endTurn()` 一起删除；轮次由 trace 命名与账期切换表达 |
| `online`/`muted` 在 driver 内**存两份**（字段 + 现场值），锁步更新迟早错位 | 只留 `_isOnline`/`_muted` 真值，快照在 `snapshot()` 现场合成，不存副本 |
| 交付事实有**两套措辞**（`voice/tool.ts` 与 `tts/delivery.ts` 各写一份） | 收敛为 `voice/driver.ts` 导出的 `describeDelivery(snapshot)`，两处调用同一句措辞 |
| `session.registerDriver()` 是**只在测试里走过的第二 mount 路径** | 删除。测试改为走生产同一条 IPC 接缝（服务名注入假驱动） |
| 「排队 m」**把正在播的那句也算进排队** | 字段语义改为「尚未播完，含在播那句」，措辞分别为「播放 第 k/n 句（未播完 m 句）」/「最后一句」/「待播 m/n 句」 |
| `submittedSegments` 有 getter 与快照**两条读路径** | 只留快照一条；`summarizeProgress` 返回完整事实集（含作者侧计数），不再片段式合并 |
| tts 的 abort 监听与 teardown **两条清理路径**清同一份电平订阅 | 只留 teardown 一个主人 |
| `clipText` 外泄（内部细节进了导出面） | 收为私有 |

**这轮重构自己引入过一个 bug，被测试当场抓住**：`probe()` 从「片段合并」改成「整体替换事实」后，一度把作者侧的 `submittedSegments` 冲掉（快照里该字段变 `undefined`）。修法是让归纳结果自包含，而不是回到合并写法。

**复杂度体检（CRAP）**：给 `scripts/crap.mjs` 加了 `--root=`（默认 `src`），扩展仓库用同一套公式看，不另写一份。范围 `voice/` + `tts/`：12 文件 100 函数，质量门（comp ≥ 8 且覆盖率 0）**通过**。热点前四：`tts/companion.ts:32 ensureCompanion`（CRAP 154 / comp 14）、`tts/stream-parser.ts:63 feed`（76 / 37）、`tts/index.ts:210`（65 / 11）、`tts/config.ts:35 loadConfig`（36 / 36，覆盖 100%）。`summarizeProgress`、`describeDelivery` 等新拆出的纯函数均在阈值下。

**第二轮验证**：`tsc --noEmit` 干净；全仓 `vitest run` 88 文件 **1065 passed / 1 expected fail / 0 failed**。（同一批里 `tests/session-settings.test.ts` 曾偶发失败一次。单独重跑、全量重跑均通过，且该文件只 import `src/ai/settings.js` 与 harness，不引用本次改动的任何模块，故不归因于本轮变更——但未做 bisect，严格说只是“无证据指向它”。）

**仍未证明的事**：bridge 物理播放仍离线，端到端只由假 driver + 假 fetch 覆盖 ——「机制正确」有证据，「真机上听得对」没有。

---

## 10. 说话纪律提醒（真机试用后的追加，2026-09-23）

真机第一次开麦试用把问题暴露得很直接：**一轮长回复就堆了 41 句**，音频落在对话后面很远。我曾主张“靠我自己看视口数字自控”，被事实反驳了 —— 文字产出速度本来就远快于语速，不堆才怪。

操作者的提议比我原来的“队列上限 + 挤掉最旧”更妥：**在视口里多摆一句事实**。采用，落在 `tts/delivery.ts`（视口措辞的唯一主人）：

- 开麦且在线时，交付行尾巴带一句：`你写的每个字都会被念出来——注意句子长度与节奏`。
- 它在本轮还没开口时**就已经出现**（不再要求 `submittedSegments > 0`）—— 提醒要在开口之前起作用，事后补报没意义。
- 静音或离线仍返回 `null`（0 token）。代价是开麦期间每轮多一行；这是为了不堆积而愿意付的帐。

放弃了“挤掉最旧未播句”的方案：它会让我说的话在听众耳边跳着进去，属于“内容完整性被静默牺牲”，与不攠造事实的底线相中。
