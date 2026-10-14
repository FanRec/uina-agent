# 下一步规划：剩余工作拆分

状态：**规划 v1（未执行）**
日期：2026-09-21
起点：`embodiment-voice-live2d-refactor-report.md`（S1/S2/S3/S6/S8/S9/S10 已接通；S5、B3、B5、S7 保留）

---

## §0 起点状态

### 已完成并验证
四条断裂接缝（S1/S2/S3/S6/S8）、新发现的 S9、S10 全部接通；M1/M2/M3 三个机制落地；typecheck 0 错误、boundaries ok、新增接线测试 9/9（两池皆绿）、CRAP 门禁两个范围通过。

### 三处未提交状态的资产（必须先处理）
| 仓库 | 状态 |
| :--- | :--- |
| 主仓库 | 7 改 + 1 未跟踪（`tests/embodiment-endpoint-wiring.test.ts`） |
| `.uina/worlds/live2d` | 我改 2 文件；**另有 9 个先于本次的未提交改动**，且 `runtime.ts` 未被 git 跟踪 |
| `.uina/extensions/{embodiment,tts}` | 我各改 2 / 1 文件；tts 另有 `bridge/server.py` 已改、`bridge/test_server_startup.py` 未跟踪（非本次） |

---

### R1 收尾当前改动（已完成 · 2026-09-21）

**已提交、未推送**（用户裁定：提交即可 / 先不推送）。五个仓库工作树全部干净，提交后复核通过（typecheck+boundaries ok、接线测试 9/9、受影响测试 103/103）。

| 仓库 | HEAD | 提交 |
| :--- | :--- | :--- |
| 主仓库（`main`） | `b15cf5d` | feat(extensions): 新增同进程共享接缝，接通具身端点与语音链路（8 文件 / +565 −4） |
| `.uina/worlds/live2d`（`master`） | `2a8e03e` | feat: 端点接入同进程共享接缝，动作支持取消（含在途的 Live2DRuntime 抽取）（10 文件 / +753 −346，`runtime.ts` 首次入库） |
| `.uina/extensions/embodiment`（`master`） | `73744cc` | feat: 端点发现改走同进程共享表，删除三个失效的注册服务（2 文件 / +139 −71） |
| `.uina/extensions/tts`（`main`） | `d5a536f` → `a2901ca` | ① fix: 剥离 cue 具身线索，不再把动作标签念出来 ② fix(bridge): 修复 server.py 循环导入并补启动自检（在途改动单独成提交，不混入本次改动） |
| `.uina/extensions/voice`（`master`） | `b532a59` | 无改动 |

**提交策略说明**：live2d 在途改动与本次改动交织于同文件（`index.ts`、`runtime.ts`），无法干净拆分，故合为一个提交并在信息中显式声明两批内容；tts 可拆，故在途的 bridge 改动单独成提交，避免把非本轮改动挂在本次修复名下。凭据文件 `vts-token.json` 已确认被 `.uina/worlds/live2d/.gitignore` 覆盖且未跟踪。

**遗留到推送时**：`git ls-remote` 远端校验（本次未推送，故未做）。

---

### R3 死代码清扫（已完成 · 2026-09-21）

**已提交、未推送。** 三个子仓库工作树干净；提交后复核通过（typecheck 0 错误、boundaries ok、受影响测试 126 例、全量 902 例、CRAP 两道门禁通过）。

| 仓库 | HEAD | 提交 | 规模 |
| :--- | :--- | :--- | :--- |
| `.uina/worlds/live2d` | `9b495ba` | refactor: 删除三处从未接线的机制（Layer 1 关键帧、PCM 口型入口、兼容访问器） | 6 文件 / +36 −215 |
| `.uina/extensions/voice` | `36fab4c` | refactor: 删除 PCM 契约与测试专用注册服务 | 2 文件 / +11 −21 |
| `.uina/extensions/tts` | `402f8f7` | refactor: 删除 tts 转发服务，发声意志统一收敛于 voice | 1 文件 / −33 |
| 主仓库 | `b15cf5d`（无新提交） | — | 见下方注意事项 |

**逐项结果**

| # | 对象 | 结果 |
| :--- | :--- | :--- |
| R3-1 | Layer 1 关键帧（`playClip`/`evaluateClips`/`evaluateSegment`/`activeClips` + 5 个类型） | 已删除，联动删除 `live2d-motion-core` 的 **3 个用例共 109 行**（31→28 例）。声学微冲用例保留 |
| R3-2 | `voice:register_driver` 服务包装 | 已删除；`VoiceSession.registerDriver` 保留。原用例改走**生产路径**（`hasService` + `callService` 调 `voice_driver:interrupt`）验证断点投影，比原来更贴近现实 |
| R3-3 | `tts` 转发服务 | 已删除；用例改为**明确断言它不存在**，固定"不多一层转发"的结构 |
| R3-4 | 6 个 `getLive2D*` 访问器 | 已删除（`Companion`/`AudioObserver` 两个全仓零引用），只留 `getLive2DRuntime()`；测试改为按需取运行时视图 |
| R3-5 | `AudioPcmChunk` + `processPcmChunk` | 已删除。**两个原本用 PCM 驱动的用例改写为电平入口，未删除**——衰减与复位是真实行为，覆盖予以保留 |
| R3-6 | 「重心游移」名不副实 | 按 D4 裁定**改文档**：`PhysiologicalNoise` 头注释如实标注躯干漂移未实现，返回处说明保留键位是为固定合成层参数集合（代码行为未变） |

**残留复核**：15 个被删符号全仓 grep 命中数均为 0；`voice:register_driver` 仅剩 2 处解释性注释（无活引用）。

**⚠ 注意事项（本轮的实质代价）**
R3 的**测试改动全部落在 `.gitignore` 内的测试文件**（`live2d-app`/`live2d-motion-core`/`voice-extension`/`tts-extension`），因此主仓库**没有产生任何可提交内容**。即：**这三个子仓库的删除动作已被版本化，而支撑它们的测试改动没有。** 这正是 D3 讨论的 `.gitignore` 结构性问题在 R3 上的具体显现——如果将来有人把某个机制按测试期望改回来，版本史里看不到反证。

**新发现问题（已给出取向建议，待你确认执行）**

`D-6`：交付事件有三套类型重叠，其中一套是纯中间层。

| 类型 | 归属 | 状态 |
| :--- | :--- | :--- |
| `PlaybackEvent` | `tts/client.ts` | **活线格式**：镜像桥侧 `PlaybackEventHub.publish` 的全部 kind |
| `PlaybackBreakpoint` | `voice/driver.ts` | **唯一真正在用的语义事实**：中断路径（`VoiceSession.interruptedBreakpoint` → 单轮退火视口）用的就是它 |
| `VoiceDeliveryEvent` | `voice/events.ts` | **零引用中间层**，建议删除 |

**建议：留 `PlaybackEvent`（线格式）+ `PlaybackBreakpoint`（窄语义），删除 `VoiceDeliveryEvent`。** 四条证据：

1. **它是中间层，两头不占**。既不是线格式（缺 `kind`/`event_id`/`task_id`/`created_at`），也不是最小语义事实（比 `PlaybackBreakpoint` 宽，却没有任何消费者）。一个接缝三个类型，多出的两个都是负债。
2. **它表达不了失败**。`phase` 只有 `start|progress|end|cancel`，而桥侧有 3 处会发 `kind="failed"`。语义模型漏掉失败态，任何消费方必然漏处理失败——这不是不完整，是错误。
3. **它的精确性依赖一个默认关闭的能力**。`committedCharEnd` 与 `precision: "aligned"|"estimated"` 需要字符级对齐，而桥侧 `[subtitle_sync] enabled = false`，实际走的是 `fallback_mode = sentence_only` 的估算路径。即它的核心卖点在当前配置下拿不到。
4. **它的数据线格式上已经有了**。桥侧 `subtitle`/`playback_started` 事件的 `detail` 已携带 `revealed_count` / `revealed_text` / `played_ms` / `buffered_ms` / `playback_completed`——重新建模不增加信息，只让同一语义有两处定义各自漂移。

**顺带一处必须修的缺陷**：`PlaybackEvent.kind` 的联合体末尾带 `| string`，这让它形同虚设（写错 kind 不报错，`switch` 也无法穷尽检查），而实际线上 kind 是封闭的 7 个：`submitted`/`synthesizing`/`playback_started`/`subtitle`/`completed`/`cancelled`/`failed`（`subtitle` 还漏在联合体外）。修法是保留字面量联合 + 用 `Literal | (string & {})` 惯用法容忍未来新增，而不是用 `| string` 抹平类型。

**建议执行时机：并入 R2 第一个提交。** 理由：R2 会让 `subscribeEvents` 第一次真正被消费，届时「线格式的 kind 联合体」必须定稿；两件事改的是同一处定义，分开做等于同一个判断做两遍。若保留 `VoiceDeliveryEvent`，R2 就得为一个没有消费者的模型写投影函数——又是一次投机性施工。


---

## §1 剩余工作与依赖

```
R1 收尾当前改动（提交/推送 + 子仓库归属确认）        ✅ 已完成
   │
   ├─ R3 B3 死代码清扫                                ✅ 已完成
   │
   ▼
R2 S5 音频电平通路（跨语言，端到端需真实桥）          ✅ 已完成（真实口型待人工验收）
   │
   ▼
R4 B5 文档对齐 + 新铁律入档（依赖 R2 的最终形态）      ⏳ 待开工
   │
   ▼
R5 S7 ASR/VAD 全双工打断（独立立项，本轮不做）
```

**R2 与 R3 之间无依赖**，可并行；**R4 必须最后**（文档要描述定稿后的代码）。

---

## §2 批次拆分

### R1 收尾当前改动（最小、最高优先）

**为什么排第一**：`.uina/worlds/live2d` 与 `.uina/extensions/tts` 里混着**先于本次工作**的未提交改动。再往上叠 S5（要改同一个 tts 仓库）会让"哪些是我的、哪些是你的"彻底不可分辨。先结算再加。

| # | 任务 | 产出 | 需你裁定 |
| :--- | :--- | :--- | :--- |
| R1-1 | 主仓库提交本次改动（7 改 + 新测试入库） | 1 个提交 | 提交信息措辞；是否连同 `tsconfig.json` 一并 |
| R1-2 | `tests/embodiment-endpoint-wiring.test.ts` 是否入库 | 已设计为可安全入库（无 `.uina` 静态 import、缺 `.uina` 时整组 skip），**建议入库** | ✅ 需你定 |
| R1-3 | `.uina/worlds/live2d` 提交（含 `runtime.ts` 首次入库） | 1 个提交 | ✅ 需你确认这批在途改动都是你的、可以一起提交 |
| R1-4 | `.uina/extensions/embodiment`、`tts` 分别提交 | 2 个提交 | ✅ 同上（tts 的 `bridge/server.py` 等非我改动需你确认归属） |
| R1-5 | 推送 + `git ls-remote` 校验 | 远端 SHA == 本地 HEAD | 是否推送、推哪些仓库 |

**验收**：三个（或四个）仓库工作树干净；`git ls-remote` 与本地 HEAD 一致。
**风险**：子仓库的在途改动可能尚未完成 —— 若其中有半成品，**不要提交**，改为只提交我改动的文件（`git add -p` 式精确选择）。

---

### R2 S5 音频电平通路 + D-6 收口（已完成）

**设计前提已于开工前修正一次**：电平**搭载现有进度事件**下发，不另建节拍。

理由（实测）：`AudioPlayback.progress_snapshot(duration_ms)` 已由 `_run_subtitle_progress_loop` 的 `snapshot_getter` 每 tick 调用一次，`remember_snapshot` 随即 `_publish_playback_event(...)` 出网。因此只要把电平放进进度快照，就会自动随现有事件流动——**不需要新的 SSE 通道，也不需要新的 kind**。

**由此撤销 D5**：`progress_interval_ms`（当前 16ms）同时驱动字幕平滑度，改成 33ms 会**连带降低字幕质量**，属能力回归。搭载现有事件后，35ms 的独立节拍没有存在意义；电平的实际到达频率 = 现有进度频率（约 60Hz），而消费端 `AudioObserver` 本就以 80ms 半衰期做包络，足够。

**任务拆解（8 项，按依赖序）**

| # | 任务 | 文件 | 验收 |
| :--- | :--- | :--- | :--- |
| R2-1 | `VoiceLevelSink` 契约 + `VOICE_LEVEL_SINK_EXPOSED_PREFIX = "voice.levelSink:"`；**删除 `VoiceDeliveryEvent`**（D-6） | `.uina/extensions/voice/events.ts` | typecheck 通过；全仓无 `VoiceDeliveryEvent` 引用 |
| R2-2 | `PlaybackProgressSnapshot` 增 `rms` / `peak`（带默认值，不动既有构造点） | `bridge/models.py` | Python 单测：既有构造点不受影响 |
| R2-3 | 电平测量：`_measure_level(pcm_bytes)` 零依赖整型累加 + 跨步采样（≤1024 样本），在 `feed()` 内测量、**锁外**执行；`progress_snapshot()` 返回电平 | `bridge/audio_playback.py` | Python 单测：已知波形 RMS 与解析值相符（±10%）；静音→0；畸形输入不抛异常 |
| R2-4 | 电平随现有事件出网：`remember_snapshot` 的 publish `detail` 增 `rms`/`peak` | `bridge/service.py` | Python 单测：publish 被调用且 detail 含两字段 |
| R2-5 | 修 `PlaybackEvent.kind` 类型缺陷：补齐线上封闭的 7 个 kind（含漏掉的 `subtitle`），用 `PlaybackKind \| (string & {})` 取代 `\| string`（D-6 附带项） | `.uina/extensions/tts/client.ts` | typecheck 通过；新增 kind 不破坏 `switch` 穷尽性 |
| R2-6 | TTS 成为 SSE 消费方：`turn_start` 订阅该 trace、`turn_end`/`turn_aborted` 退订并 `sink.reset()`；sink 经 `pi.shared(APP_EXPOSED_SHARED_NAME)` + 前缀解析，并随共享表变化重解析 | `.uina/extensions/tts/index.ts` | 单测：假 SSE → sink 收到电平；退订后不再推；启停重解析 |
| R2-7 | Live2D 暴露电平接收端 `ctx.expose(VOICE_LEVEL_SINK_EXPOSED_PREFIX + bodyId, sink)`；`levelSinkExposed` 在 expanded 视口可见 | `.uina/worlds/live2d/runtime.ts` | 单测：sink 暴露存在；喂电平后 `mouthOpenY > 0`；`reset()` 归零 |
| R2-8 | 接线后复核：删掉 `runtime.ts` 头部的"未接线"注释与 R3 保留的占位说明 | 文档与注释 | grep 无残留不实声明 |

**验收分层（必须区分）**
- **可自动验证**：R2-1…R2-7 的单测（Python + TS）；typecheck/boundaries/全量测试/CRAP 全绿。
- **不可自动验证（须显式声明）**：真实口型效果需 `GPT-SoVITS + CUDA + sounddevice + VTube Studio` 齐备，**本环境不具备**。该项标记为"待人工验收"，**不得在报告中写成已验证**。

**风险**
1. **音频路径负担**：`feed()` 在投递线程（非 PortAudio 回调），但**测量必须在锁外**，否则延长 `_buffer_lock` 持有时间、可能影响喂数节流。已按此设计。
2. **测量失败不得中断发声**：`_measure_level` 全程 try/except，异常一律退化为 0。
3. **与 VTS 原生音频口型的叠加**：接上后 Uina 会覆盖 `MouthOpen`。`arbiter.isChannelLocked("mouth")` 已提供抑制手段；真实环境需确认不与虚拟声卡路径打架（归入人工验收项）。
4. **batch（非流式）路径**：进度事件只在流式路径出网（`[streaming] enabled = true` 为当前配置）。非流式时电平不缺数据但不流动——如实记录，不假装覆盖。

**R2 完成记录（2026-09-21，已提交未推送）**

| 仓库 | HEAD | 提交 | 规模 |
| :--- | :--- | :--- | :--- |
| `.uina/extensions/voice` | `c06ff43` | feat: 声学电平接收端契约，并删除从未使用的 VoiceDeliveryEvent（D-6） | 1 文件 / +43 −25 |
| `.uina/extensions/tts` | `14c22e1` → `615d4fa` → `2770f7f` | ① feat(bridge): 桥侧声学电平测量，随现有进度事件下发 ② feat: tts 成为声学电平的消费方，并按前缀扇出给身体外壳 ③ fix: 电平扇出缺宿主接缝时降级，而非让整个激活失败（B） | 4 文件 / +109；2 文件 / +121 −4；1 文件 / +14 −2 |
| `.uina/worlds/live2d` | `2777b30` | feat: 暴露声学电平接收端，口型通道接线完成 | 1 文件 / +21 −2 |
| 主仓库 | `b15cf5d`（无新提交） | — | 测试改动仍在 gitignored 文件内（同 R3 的结构性问题） |

八项任务全部落地，另**撤销 D5**（电平搭现有进度事件，不需要独立 33ms 节拍；改 `progress_interval_ms` 会连带降低字幕平滑度）。

**验证**
- 可自动验证：typecheck 0 错误；boundaries ok；Python 侧 **7/7** 通过（vendor Python = 桥实际运行环境），含正弦 RMS 与解析值比对 ±0.01、畸变输入退化、`feed → snapshot` 传递、停流清零；受影响 TS 测试 **155 例**通过（tts 32、live2d-app 21 等）；全量 **903 通过 / 3 失败**（2 例 bilibili 真实网络 + 1 例 world-framework-lifecycle 的固定 20ms 等待抖动，均已隔离复跑通过）；CRAP 门禁 **内核 430 函数 + extensions/ 全范围 576 函数**双通过。
- ⚠ **不可自动验证**：真实口型效果需 `GPT-SoVITS + CUDA + sounddevice + VTube Studio` 齐备，**本环境不具备**。该项状态为**待人工验收**，本报告不声称已验证。人工验收时需同时确认：Uina 侧 `MouthOpen` 与 VTS 原生虚拟声卡口型路径是否互相打架（`arbiter.isChannelLocked("mouth")` 为抑制手段）。


---

### R3 B3 死代码清扫（纯减法，逐项确认）

已核清每项的真实影响面：

| # | 对象 | 影响面（已实测） | 建议 | 需你确认 |
| :--- | :--- | :--- | :--- | :--- |
| R3-1 | `MotionComposer.playClip` / `MotionClip` / `evaluateSegment` / `activeClips`（Layer 1 关键帧） | 生产零调用；`tests/live2d-motion-core.test.ts` 7 处引用（约 3 个用例） | **删除**，同时删对应用例。保留 Layer 3 的 `triggerAcousticImpulse`（属声学层，随 R2 复活） | ✅ |
| R3-2 | `pi.registerService("voice:register_driver", …)` 包装 | 生产零调用；测试仅 1 处断言该服务 | **删除服务包装**；**保留** `VoiceSession.registerDriver`（同内存驱动注入，另有 3 处测试使用，是合法接缝） | ✅ |
| R3-3 | `pi.registerService("tts", …)` 转发层 | 生产零调用；测试 1 处断言 | **删除**（内部再转发 `voice:*`，自身无人调用） | ✅ |
| R3-4 | `index.ts` 的 6 个 `getLive2D*` 兼容访问器 | 测试约 8 处使用 | **删除**，测试改用 `getLive2DRuntime()` | ✅ |
| R3-5 | `voice/events.ts` 的 `AudioPcmChunk` | R2-7 已判 PCM 路线不采纳 | **删除**（与 R2 同批） | ✅ |
| R3-6 | `physiological-noise.ts` 的 `ParamBodyAngleX: 0`（"重心游移"名不副实） | 设计承诺 vs 实现 | **接线**（真实躯干游移）**或** 改文档，二选一 | ✅ 取向 |

**验收**：删后 typecheck/测试/CRAP 全绿；全仓 grep 确认无悬垂引用（`grep -rn` 逐项复核，不信任编辑回执）。
**风险**：删除测试用例会降低总用例数，需在提交信息中逐条列出"删除了哪些用例、为什么"，避免看起来像掩盖失败。

---

### R4 文档对齐（已完成 · 2026-09-21）

**已提交未推送。** 共 4 个提交（主仓库 2 + live2d 2）。

| 仓库 | HEAD | 提交 |
| :--- | :--- | :--- |
| 主仓库 | `b41a1da` → `bf29b18` → `316ad81` | ① docs: 入档同进程共享铁律，校正应用/扩展契约与运行事实（3 文件 / +37 −3）② test: 用条件轮询取代固定 20ms 等待，消除门禁假失败（1 文件 / +17 −3）③ fix(ai): 模型目录部分成功不得报成整体失败（providers/host + 测试 / +38 −5） |
| `.uina/worlds/live2d` | `78ba236` → `e8298b8` | ① docs: 对照实现校正 DESIGN（四层改三层、重心游移改文档、签名与拓扑）② docs: 补上一处漏改（§1.1 仍声称"美术关键帧"属四层合成）+84 −38 |

**逐项结果**

| # | 目标 | 结果 |
| :--- | :--- | :--- |
| R4-1 | 新铁律入档 | ✅ 三份**已跟踪**文档同步：`current-runtime.md`「能力注册」、`extensions-development.md`「工具与服务」（含 `share`/`shared` 用法与重名即报错语义）、`app-development.md` 新增 §4.2（两条通道方向表 + 真实缺陷反例） |
| R4-2 | voice-architecture 校正 | ✅ 新增 §0 实现现状对照表（✅/⚠/❌ 逐项），改 §1.1（0 工具→"管道 0 工具但意志控制 1 工具"）、§3.3（PCM 旁路→电平搭进度事件，附被否决理由）、§3.4（标注零实现）、§4（Level 1 改实际形态、Level 2 标未实现）、§5 拓扑（改为真实文件树）；§2 拓扑图内的 PCM 旁路与未实现 ASR 也一并改掉 |
| R4-3 | embodiment-architecture 校正 | ✅ 新增 v3.5 状态表；§6 删掉不存在的 `emitCue` 的 `payload` 参数；**新增 §7「端点登记与发现」**（原规范的空缺，含拉取+订阅的理由、结构校验、以及 7.3 节保留该缺陷为教训） |
| R4-4 | live2d DESIGN 校正 | ✅ 四层→三层；§3.1「重心游移」按 D4 裁定改文档（如实标注未实现）；§4 修正 `arbiter.claim` 签名与 `ctx.signal` 必选；§5 标注实现已升级为声明式映射表；§6 拓扑补 `runtime.ts` + 两处 expose 说明 |
| R4-5 | 项目笔记与 flaky 台账 | ✅ `dev/DECISIONS.md` 新增「测试池」节（默认池为准 + jiti/vmThreads 不可用 + 覆盖率落盘的两个硬约束 + CRAP 范围不含 `extensions/`）；`dev/FLAKY.md` 按台账纪律登记 4 组记录，其中 `world-framework-lifecycle` 一例**已确认并闭环**（固定 20ms → 有界条件轮询） |

**过程中的自查纠正**：初次校正后 grep 复核，抓到两处**仍在陈述**（不只是标注）的不实表述——`voice-architecture` §2 拓扑图里的"实时 PCM 旁路广播"与 live2d DESIGN §1.1 的"四层动作合成系统…美术关键帧"。已补改并单独提交。教训：文档校正不能只改标题级表述，散落在别处的同一句话同样是不实声明。

**验证**：typecheck + boundaries 通过；全量 **904 通过 / 2 失败**（仅剩已登记的 bilibili 真实网络对局，`world-framework-lifecycle` 抖动已消除）；CRAP 内核 430 + `extensions/` 576 函数双通过。

**注**：`dev/`（含 DECISIONS.md、FLAKY.md）与 `docs/proposals/`、`tests/{live2d-app,...}` 均被 `.gitignore` 覆盖，故这些改动未入库——与项目既有的"私人开发工作台与过程文档不随仓库公开"策略一致。

### R4 依赖说明（原计划文本）


| # | 文档 | 待修 |
| :--- | :--- | :--- |
| R4-1 | `src/extensions` 开发文档 / `agent-world-framework.md` | **新铁律入档**：「纯数据走 `callService`，活引用走 `share`」；补 `expose` / `onHostEvent` / `ActionContext.signal` 三条能力说明 |
| R4-2 | `voice-architecture.md` | §5 代码拓扑（实现已迁 tts；voice 只剩意志+断点）；§1.1「0 个 Tool」与现实 `voice` 工具矛盾；§3.4 ASR/VAD 标注"规划未实现"；§4 Level 2 未实现；§3.3/§4 补记"实际走电平 SSE，非 PCM 旁路" |
| R4-3 | `embodiment-architecture.md` | §3.1 `emitCue(cueId, payload?)` → 实际 `emitCue(cueId)`；补记端点登记契约（`body.endpoint:` 前缀 + 拉取/订阅发现） |
| R4-4 | `.uina/worlds/live2d/DESIGN.md` | §3 Layer 1 状态（按 R3-1 结论）；§3.1「重心游移」按 R3-6 结论 |
| R4-5 | 项目笔记 | 测试池结论修正（默认池为准；vmThreads 下 jiti 不可用） |

**验收**：逐条 grep 复核文档中不再出现与实现相反的表述。

---

### R5 S7 全双工打断（独立立项；本轮只做文档标注）

本轮产出：`voice-architecture.md` §3.4 已标注"零实现"（R4-2 完成）。真做需独立执行稿。

**拆解：R5 是两件不同的事，设计文档把二者混为一谈**

| 子项 | 需要什么 | 规模 | 缺的接缝 |
| :--- | :--- | :--- | :--- |
| **R5a 打断（Barge-in）** | 采集 + VAD（语音活动检测）。**不需要听懂说了什么** | 中批次 | ⚠ **缺**：扩展无法打断当前回合（见下） |
| **R5b 语音输入（ASR）** | 采集 + ASR 转录 + 投递为输入 | 独立工程（含模型选型/延迟预算/中文识别质量） | ✅ 不缺：`ExtensionAPI.submitInput(AgentInput)` 已存在，`AgentInput.mode` 为 `steer`/`followUp`——正是"人说的话"该有的语义 |

**关键发现：接缝情况与直觉相反。** 需要新接缝的是**较小的那个**（打断），不需要新接缝的是**较大的那个**（语音输入）。

**现状：打断只接通了一半**

- **下游已完整**：`host.interrupt()` → `Subject.interrupt()` → loop 广播 `turn_aborted`（`loop.ts:1097-1098`）→ voice 侧掐音频 + 清排队、embodiment 侧 `safeStop()`、具身反射急停。音频层另有 `voice({action:"interrupt"})` 工具与 `voice:interrupt` 服务（含 `expectedTraceId` 防误杀）。
- **上游完全缺失**：没有任何东西能检测"人类开口"。
- **缺口在暴露层而非能力层**：`host.interrupt()` 存在，但**只被 `src/cli/app.ts` 调用**；`ExtensionAPI` 里**没有任何 interrupt 成员**。所以扩展能掐自己的音频，却**无法停止模型继续生成**——那会留下"声音停了但模型还在自说自话、身体还在动"的半吊子状态（`turn_aborted` 不触发 → embodiment 的 `safeStop` 也不会跑）。

**三个必须先定的问题（架构级，不是实现细节）**

1. **回声自激**——全双工的头号问题。麦克风会听到 TTS 自己的输出，立刻"检测到人声"并打断自己。可选路线：
   (a) **要求戴耳机**：最省事，且诚实（把约束写进前置条件而不是假装不存在）；
   (b) **虚拟声卡重路由**：桥已有把 PCM 镜像到 `CABLE Input` 的能力，但当前主输出仍走默认设备 → 仍需 (a) 或 (c)；
   (c) **回声消除（AEC）**：效果最好、成本最高（需 WebRTC 级处理）。
   **这一条决定整个架构，必须在开工前定。**
2. **打断要打两层**：音频层（已有）与生成层（需暴露接缝）。若不愿加接缝，退路是"掐音频 + 以 `steer` 注入人类的话"，但语义变弱（生成不停止、`turn_aborted` 不触发、身体不停）——**必须明说是降级方案，不能含糊过去**。
3. **延迟预算要重新拆**：设计文档承诺"≤80ms 判定"。真实链路是 `VAD 判定 → 跨进程（若采集在桥里）→ 到 host 的 IPC → 生成层取消生效`，而"生成层取消"本身受 loop 安全点约束、并非瞬时。**建议把单一 80ms 承诺改为可测的分段预算**。

**放哪一层做（关键架构选择）**

桥（Python）已拥有 PortAudio/sounddevice 栈但**现在只用于输出**；Node 侧要录音则需引入新的原生音频依赖。两种切法：

| 方案 | 分工 | 评价 |
| :--- | :--- | :--- |
| A 采集+VAD 都在桥内 | 桥决定是否打断，反向命令主体 | 依赖最省、延迟最短；但**控制流倒挂**——哑外设开始做决策 |
| **B 桥只做采集与能量测量，判定在主体侧**（建议） | 桥是采集器，voice 扩展做 VAD 与打断编排 | 谁做决定谁负责；且与 R2 的"电平搭现有事件"同款思路（方向相反）；代价是判定跨一次进程 |

**可测试性要求（硬约束）**：本环境无麦克风、无法验证真实声学。R5a **必须**设计一条采集源注入缝（同 `setVtsClientForTest` 形态：把采集源换成可注入的能量序列或合成 WAV），否则又会产出一条"只能在真实设备上验证"的功能——本轮审查已经三次见到这种代价。

**验收分层**
- 可自动验证：VAD 判据（合成音频 → 判定序列）、打断编排（双缝联动）、注入缝本身、以及"打断后音频停止且 `turn_aborted` 被触发"。
- 不可自动验证：真实麦克风与真实回声环境（须标记待人工验收）。

**建议**：先做 R5a（含新接缝与注入缝），R5b 独立立项。开工前先定回声策略。

---

## §3 建议顺序与理由

1. **R1 先行**，不是洁癖：`.uina` 三个仓库已有在途改动，R2 还要改同一个 tts 仓库。不先结算，S5 的 diff 将与既有改动混作一团，之后无法归因谁改了什么。
2. **R2 次之**，因为它是**唯一还让代码说谎的缺口**（`AudioObserver` 是死代码，而设计文档宣称口型已实现）。R3 只是删多余之物，可以等。
3. **R3 可与 R2 并行**（不同文件集，冲突面小）；但 R3-5（删 `AudioPcmChunk`）必须与 R2-7 同批，否则中途会留下"契约在、生产者不在"的中间态。
4. **R4 最后**，且必须等 R2/R3 定稿 —— 文档描述未定稿的代码等于再造一次不实声明。

---

## §4 门禁与提交纪律（沿用项目约定）

```
pnpm typecheck                      # 含 check:boundaries + tsc --noEmit
npx vitest run                       # 默认池（vmThreads 下 jiti 不可用）
node scripts/crap.mjs --gate --files=<改动范围>
git ls-remote origin                 # 直读远端校验，勿信本地 ref
```

- 每批次独立提交；R2 建议拆 2 个提交（桥侧 Python / TS 侧接线），便于回滚。
- 覆盖率数据生成需排除 4 个真实网络/本地服务依赖文件，否则 json 不落盘（已实测）。
- 失败用例先隔离复跑；隔离通过即判为环境性，但**必须在报告里写明判据**，不得静默忽略。

---

## §5 裁定结果（2026-09-21，已生效）

| # | 事项 | 裁定 | 状态 |
| :--- | :--- | :--- | :--- |
| D-1 | `.uina` 三个仓库的在途改动是否都是你的、可否一起提交 | **提交即可**（已按仓库分别提交） | ✅ 已执行 |
| D-2 | 是否推送 | **先不推送** | ✅ 已遵守（推送时需补 `git ls-remote` 校验） |
| D-3 | `tests/embodiment-endpoint-wiring.test.ts` 是否入库 | **入库** | ✅ 已随主仓库 `b15cf5d` 入库 |
| D-4 | R3-6「重心游移」取向 | **改文档**（不实现真实躯干游移，属表现力增强，宜另立项） | ⏳ 并入 R4-4 |
| D-5 | R2 电平频率 | **33ms 起步**（口型足够、负担更低；实测不足再提至 16ms） | ⏳ 并入 R2 |

**R2 / R3 已解除阻塞**，可开工；R4 仍须等 R2/R3 定稿。

