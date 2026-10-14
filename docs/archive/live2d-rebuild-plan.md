# Live2D World 重写施工方案 (Rebuild Plan v1.0)

> 2026-10-13 状态校正：本文为早期重写阶段档案，P1 接入与旧工具面不代表当前源码。当前施工与进度改由[完整重构计划](../superpowers/plans/2026-10-13-live2d-world-refactor.md)及[运行合同](../live2d-world-runtime.md)记录；目录、统一 state/cue、外部结算、Worker 生命周期已经实施。当前五种 action 为 express/state/costume/status/reload，独立单槽及 diagnose 工具已删除。自动化失败与未完成的真实设备验收分别记录，不因历史勾选认定当前通过。

> 状态：已确认生效（2026-10-11，用户确认）
> 依据：引擎规范 =《live2d-intuitive-animation-spec.md》v4.6 +《live2d-intuitive-animation-spec-amendments.md》(v4.7 修订)；世界层 =《live2d-world-boundary-spec.md》v1.0。三份文档冲突时以修订登记与边界规范为准。
> 进度追踪：**《live2d-rebuild-checklist.md》是唯一进度载体**——本文定义阶段与门禁，清单定义任务粒度、依赖、DoD 与 evidence。开发按清单 ID 逐项推进与勾销。
> 范围：`.uina/worlds/live2d/` 全量重写；动作内容不迁移、重新设计；`src/extensions/world-framework/seams.ts` 新增（唯一 src 触点）；embodiment/voice 扩展仅做 re-export 改造。

---

## 1. 原则

1. **每阶段以画面事实收尾**：引擎正确性的最终裁判是真实 VTS 画面与 Cubism 读回，不是绿色门禁。每阶段结束必须在本机 VTS 上完成该阶段的人工核对清单，并留 evidence 记录。
2. **vts-client 按行为移植，不重新发明**：现行 `vts-client.ts`（906 行）已踩完协议坑（token 持久化、断线重订事件、单未确认帧背压、注入证据记账、假就绪防护、代次校验），其行为与 `WebSocketLike` 测试接缝是移植的验收基准。引擎其余部分（仲裁/管道/创作层）按规范新写。
3. **review 教训内建，不靠事后补**：REVIEW.md 的每条教训要么已进规范（单调时钟、代次、断线恢复、口型独立合成、中性完整重建），要么落进某阶段清单（本文件 §6 对照表）。出现"文档声称超前于代码"即停下修文档。
4. **提交纪律**：AI 准备小批量、逻辑内聚的批次并跑全门禁；是否 commit 由用户决定。每阶段一批或数批，不混合无关改动。
5. **工程验收与表现验收二分**：前者是本方案门禁与两份验收矩阵（自动化可判定）；后者是真实画面的人工自然度核对，只存在于作者验收记录。**反目标**：不建"自然度评分系统"——自然度只能由人看画面判定，任何把表现验收自动化的尝试都是自欺。
6. **打断与暂停语义二分**：`interrupt`（回合打断）= 取消瞬时动作、保留槽位与自律、不暂停身体；`safeStop`（显式暂停）= 全局冻结 + 保持帧。二者不得混用。

## 2. 现状与清理

工作树现状（已核实）：live2d 目录处于中途重写态（相对 HEAD 删除约 4200 行 / 新增约 713 行），`body-director.ts`、`motion-library.ts`、`model-adapters/da*.json` 已删，文档（DESIGN.md/REVIEW.md 等）与代码已脱节。

处置：

| 项 | 处置 |
| --- | --- |
| 现行 `vts-client.ts` + 其测试 | **移植基准**：重写期间保持可运行，新实现通过同一行为测试后替换，旧文件删除 |
| 其余现行 *.ts（motion/director/adapter/package/profile 等） | 重写完成后全删；不迁移动作内容 |
| 世界内旧文档（DESIGN/REVIEW/ADAPTER-REVIEW/PRESENTATION-REVIEW/COMPOSITION/MO-MODEL-COMPARISON/MOTION-AUTHORING/MODEL-ADAPTATION） | 移入 `.artifacts/live2d-history/`（或按用户决定删除）：REVIEW.md 的教训表已提炼进规范与本文 §6，原文留作证据 |
| `.artifacts/live2d-rebuild-20261010/` | 保留为历史证据区，不进任何门禁 |
| `models/mo/rig.json` | 按 v3 schema 重制；标定曲线数值可参考旧文件，但**每条曲线必须经作者会话重新标定后才能标 evidence**（修订 A8） |
| embodiment 工作树未提交修改 | 与 seams.ts 改造合并为一个批次处理，避免类型双源期间半漂移；`turn_aborted → router.stopAll()` 分发改为 interrupt 分发（`BodyRouter.interruptAll`，见清单 P4-8） |

## 3. 目标模块布局与依赖规则

见边界规范 §8。补充依赖检查：`check-boundaries` 增加两条规则——world 内模块禁止 import `src/` 除 world-framework 外的路径；world 禁止 import 其他 `.uina/extensions/*`。

## 4. 分阶段施工

每阶段门禁（全绿才算交付）：

```bash
biome format → boundaries → tsc → pnpm test (--pool=vmThreads) → scripts/crap.mjs --gate
```

沙箱约束：vitest 仅 `--pool=vmThreads` 可用；测试失败时 coverage json 静默丢弃（判定依据只看测试结果本身）；harness 级/真实 VTS 验证由用户在本机终端执行。新代码从第一批起过 CRAP gate（小接口、深实现）。

### P0 接缝与骨架（无画面依赖）

- 交付：`src/extensions/world-framework/seams.ts`；embodiment/voice re-export 改造；live2d 骨架（index/endpoint/runtime 空实现 + WorldDef 注册）；目录与模块边界规则。
- 验收：全门禁；现有全部世界/扩展测试不回归；世界可启停、工具返回 `not_started` 级语义。

### P1 协议层移植 + rig v3 + 中性流

- 交付：`adapter/vts-client.ts`（移植）、`adapter/profile.ts`、`adapter/rig.ts`（v3 校验 + max 聚合 + 分段标尺端点裁剪）；`models/mo/rig.json` 骨架（先 declared 级）；60Hz 保活注入 + faceFound + 背压丢弃 + 断线恢复全流程（引擎规范 §3.3/§3.4）。
- 画面验收：VTS 中模型被 Uina 接管并保持中性姿态 ≥ 60s 不漂移；断开重连后中性流恢复；换模型后代次失效。
- 对应断言：引擎 #11/#14；边界 #7/#8。

### P2 仲裁与自律（引擎核心）

- 交付：`director/director.ts`（槽位 Set/Patch + SupersededError、逐轴仲裁、shadow/cancel/release、类别优先级 A1、独占声明 A12）、`director/autonomic.ts`（呼吸唯一主来源互斥、冷却锁眨眼、微晃避让；注入时钟/RNG，A9）。
- 画面验收：低头姿态叠加点头手势回归 -8°（引擎 #1）；微笑时眨眼完全闭拢再回 0.8（#3）；惊跳取消冲突手势（#4）；patch 并发互不干扰（#6）。
- 对应断言：引擎 #1/#3/#4/#6/#8/#9/#10/#12/#19；边界 #9。

### P3 管道（骨骼/视线/面部/口型）

- 交付：`director/pipelines.ts`（解析弹簧含子步保护 A10、视线头姿后置补偿、面部 SmoothFilter、眼睑乘法调制、语音包络跟随含 50ms 释放）；`models/mo` 的 speech 配置。
- 画面验收：视线锚定头动补偿（#5）；语音电平驱动张嘴、暂停衰减回零（#2）；遮蔽轴恢复无跳变（#10）。
- 对应断言：引擎 #2/#5/#7/#10。

### P4 世界边界（工具/cue/声学/事件/发布门）

- 交付：WorldDef 全工具面（§2.1 词汇表）、BodyEndpoint + lastCue、levelSink、宿主事件消费、独占资源（空间特技手势/costume）。
- 画面/链路验收：cue 从输出标签到模型动作全链路（含未送达可见化）；safeStop 保持帧 + resume；空间特技归位回读。
- 对应断言：边界 #1–#12 全部；引擎 #14。

### P5 创作层与新动作

- 交付：`authoring/motion.ts`（MotionBuilder/step/settle/parallel/sequence，A4 精简版）+ `authoring/states.ts`；`models/mo/catalog.ts`；**全新设计** 3~5 个命名动作 + 姿态/表情/注视目录（作者会话标定 evidence，A8）；thinking/blink/idle 背景内容。
- 画面验收：每个动作在说话/待机两种背景下人工确认自然，acceptance.md 记录。
- 对应断言：引擎 #13（正交组合无职责污染）；发布门 #2。

### P6 遥测与收尾

- 交付：三层遥测（logicalTarget / vtsInjected / cubismReadback 配置与时间窗关联）进 `diagnose`；旧文件与旧文档清理（§2 处置表）；规范文档定稿（v4.6+修订合并为 v4.7 终稿）。
- 验收：全门禁 + 全矩阵抽查；故障隔离三准则各演练一次（人为制造一处 rig 错误，确认遥测能定位到层）。

**不做**：Timeline（修订 A2）、PerformanceContext 门面（修订 A14，v1 零调用方）、weighted/primary 运行时（A6）、即兴 beats 工具（边界规范 §2）、裸露的自由位姿调度工具（spatial 收拢至手势特技，flip 拆除）。

## 5. 测试策略

- **合成纯函数化**：director 对外只有 `step(dtMs, inputs)` 与查询；测试手工步进（A9），无真实定时器等待——顺带规避沙箱时序 flaky。
- **VTS 假体**：`WebSocketLike` 假 WS + 预录请求/响应脚本；断线/代次/背压用假体注入故障。
- **随机性**：眨眼 RNG 注入固定序列；微晃噪声注入确定性种子。
- **flaky 隔离**：几何/时序敏感测试（历史 flaky：branch-inspector/overlay-keys/subagents，属其他模块）单文件 rerun；新增测试必须能在 vmThreads 池下稳定重复 10 次。
- **coverage 陷阱**：门禁判定只看测试通过与否；coverage 数字仅作参考，不作为交付证据（测试失败时 json 会静默丢失）。

## 6. REVIEW.md 教训对照表（内建位置核对）

| 教训（REVIEW.md） | 落位 |
| --- | --- |
| 单一合成入口、接管保留位置速度 | 引擎 §4.2 + P2/P3 |
| 眨眼跨阶段推进、新眨眼眼睛空闲才启动 | autonomic（P2） |
| 嘴形与声音开放度独立合成、微笑不锁口型 | 管道 P3 + 引擎 §4.2-5 |
| 未来 PCM 禁止、按播放位置取窗 | 边界 §4 |
| cue 播放事件驱动、尾句 output_end 等待 | embodiment 既有，边界 §3 记为边界事实 |
| 别名 cue 静默丢失 | 边界 §3 supportsCue 同源 |
| 重复焦点吞掉限时姿态 | 边界 §3 onFocus 幂等 + 引擎 A11 |
| 翻转绝对轨迹 + 归位回读 | A12 + 边界 #9 + P4 |
| VTS 假就绪、旧连接污染 | vts-client 移植基准（P1） |
| 保存范围≠模型真实范围 | profile 区分保存映射与真实事实（P1） |
| 中性完整重建防残留 | 槽位整槽替换语义（引擎 §2.2） |
| 卡帧时间分叉 | 引擎 §4.2 单调时钟 + 子步保护 |

## 7. 风险登记

| 风险 | 缓解 |
| --- | --- |
| 标定工作量被低估（瓶颈在画面不在代码） | rig 曲线一律 declared 起步、作者会话逐条升级 evidence；P5 只做 3~5 个动作，不做动作库 |
| 移植 vts-client 时行为漂移 | 以现行测试为验收基准，逐测试对照后再删旧文件 |
| seams.ts 改造引发扩展回归 | P0 单独一批，全量世界/扩展测试回归后才动 live2d 内部 |
| 规范与实现再次脱节 | 每阶段收尾同步规范状态行；发现偏差先修文档再继续 |
| 沙箱测试假绿 | 关键判定以用户本机终端复跑为准（既有约定） |

## 8. 完成定义 (DoD)

1. 三份规范文档合并定稿（引擎 v4.7 + 边界 v1.0 + 本方案勾销）；
2. 清单全部任务勾销且每项附 evidence；
3. 全部验收矩阵（引擎 #1–#14/#16–#19 + 边界 #1–#13）在本机通过并留 evidence；
4. 全门禁绿 + 远端 push 校验一致；
5. MO 模型经作者会话完成发布验收，cue 与工具链路在日常对话中实测可用；
6. 旧实现零残留，旧文档归档。
