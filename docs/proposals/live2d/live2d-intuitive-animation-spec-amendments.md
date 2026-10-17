# Live2D 引擎规范 v4.7 修订登记 (Amendment Register)

> 状态：已确认生效（2026-10-11，用户确认）
> 适用对象：《live2d-intuitive-animation-spec.md》(v4.6 Final)。
> 效力声明：本文与 v4.6 合并构成引擎规范 v4.7；**条目冲突处以本文为准**。未列出的 v4.6 内容保持效力。
> 修订原则：对抗性评审结论——修复内部矛盾（root cause）、砍除无调用方的自我辩护式复杂度（Occam）、补齐重写必需但 v4.6 缺失的执行性语义。每条给出验证方式。

当前实现复核（2026-10-14）：当时 A2 推迟 Timeline；之后用户明确重新批准 Timeline，A2 现仅记录历史决定。A6 的 `weighted` 运行时聚合现已在 `adapter/rig.ts` 实现并有 `tests/live2d-rig.test.ts` 覆盖，只有 `primary` 仍拒绝。该实现晚于本修订文本，不能再把 weighted 写成当前未实现。

---

## A1. 优先级由类别派生，删除调用方旋钮

- **位置**：§5.2 `MotionPlayOptions.priority` ↔ §4.1 静态优先级矩阵。
- **问题**：矩阵规定 Reflex 40 > Voluntary 30 > Transition 20 > Autonomic 10，但 `priority?: number` 允许调用方传任意值绕过矩阵——"静态优先级"沦为虚构，仲裁行为不可推理。
- **修订**：删除 `priority` 字段，新增 `category: "reflex" | "voluntary" | "transition" | "autonomic"`；director 在入口按类别映射固定数值（40/30/20/10），外部任何路径都拿不到自定义优先级。类别到来源的归属：Reflex=反射反应；Voluntary=express 工具与 cue；Transition=state 槽位与 thinking；Autonomic=自律发生器。
- **验证**：类型层无 `priority` 入参；测试断言四类别的合成顺序与矩阵一致。

## A2. Timeline 层整体推迟

- **位置**：§2.4 全节、验收矩阵 #15、§7 清单第 6 条。
- **问题**：seek/repeat 状态重构与 `exitState: "retain"` 在 AI 驱动的实时身体上**没有调用方**——这不是从使用反推的设计，而是为假想的编排器预建的能力。验收断言 #15 只因特性存在而存在，属自我辩护式复杂度。
- **修订**：§2.4 整节移入文末新增附录"推迟特性（Deferred）"，标注触发条件：命名表演确实需要绝对时序谱、且 MotionBuilder 组合被证实不够用时，按原规范实施。v1 不实现、不测试、不预留半成品接口。清单第 6 条改为"完成 `motion`、`gesture` 及 Phase 1/2 绑定"。
- **验证**：代码与测试中无 timeline 符号；文档中该节仅存在于附录。

## A3. MotionHandle 精简

- **位置**：§5.2 `MotionHandle`。
- **问题**：`pause()/resume()/seek()` 无调用方（谁会暂停一个点头？），每个都翻倍状态机测试面。
- **修订**：`MotionHandle` 仅保留 `id / status / currentTime / duration / finished / stop(mode?)`。
- **验证**：接口无三方法；`finished` 结算断言（#8）保留并通过。

## A4. 删除 StepOptions.channels

- **位置**：§2.3 `StepOptions`。
- **问题**：step 内逐轴 delay/duration 与（已推迟的）Timeline 职责重叠，形成两套计时系统；现有 MotionBuilder 的 step 序列已足够表达分镜。
- **修订**：删除该字段。`StepOptions` 保留 `blendMode / ease / intensity / speech`。
- **验证**：类型删除；组合契约测试（#13）不依赖 channels。

## A5. MotionPlayOptions 精简

- **位置**：§5.2。
- **问题**：`weight / speed / clock` 三者各引入一条独立的状态维度：speed 牵动组合器时钟映射（§2.3 第 2 条），clock 引入双时钟事实，weight 引入第四混合变量（override/additive/fade 之外）。均无当前调用方。
- **修订**：删除 `weight / speed / clock / repeat`。保留 `fadeIn / fadeOut / entry / inhibitAdditives / resetVelocity` 与 A1 的 `category`。
- **验证**：类型删除；播放相关测试不引用删除项。

## A6. RetargetingRule：v1 仅实现 max

- **位置**：§1.3。
- **问题**：实测当前 MO rig（9 轴）**零共享输入**——`weighted`/`primary` 是为不存在的模型预建的聚合机制。类型声明本身廉价，运行时实现不是。
- **修订**：v1 实现 `max`（约三行）；`weighted`/`primary` 类型与"多轴汇入同一输入必须显式声明规则，否则绑定期报错"的校验**保留**；运行时实现推迟——rig 若声明未实现策略，绑定期报 `retargeting_not_implemented` 错误（fail-fast，不静默降级）。
- **验证**：单测覆盖 max 与绑定期拒绝；MO rig 加载通过。

## A7. ModelRig 升 v3

- **位置**：§3.1。
- **问题**：v4.6 的 `ModelRig` 与现行代码 v2 同号但 schema 不同（新增 `retargeting`、`evidence`、bindings 键类型变化），同号会造成旧文件静默误读；且缺少可选轴标注（见 A13）。
- **修订**：`version: 3`；`controls` 值增加 `optional?: true`；`retargeting` 以 **VTS 输入参数名**为键（聚合发生在输入处，不是轴处）。
- **验证**：加载 v2 文件报版本错误；schema 校验覆盖 optional 与 retargeting 键。

## A8. 能力证据：观测升级只在作者会话发生

- **位置**：§1.5 表格、§3.3 第 3/4 条（"主动注入微小扰动并读回参数"）。
- **问题**：绑定阶段自动扰动会让模型在用户面前无故抽动；VTS 读回为异步 WebSocket 往返，时序上不足以支撑"同帧因果"判定。该设计把标定成本转嫁给了每一次运行时绑定。
- **修订**：`observed`/`calibrated` 只能在**作者会话**（preview 路径）通过显式标定流程获得并落盘进 rig（`evidence` 字段）；运行时绑定期只做存在性核验（input/parameter 在列表中），最高认定 `declared`。运行时永不自动注入扰动。
- **验证**：运行时代码无扰动注入路径；作者标定工具写入 evidence 后重启，绑定按 calibrated 执行。

## A9. 可注入时钟与随机源（测试性前置）

- **位置**：§4.2（自律发生器、弹簧推进）。
- **问题**：眨眼随机周期与弹簧积分若直接依赖 `Date.now/Math.random`，验收矩阵 #3/#4（眨眼、惊跳）无法确定性测试；沙箱约束（vitest 仅 vmThreads、coverage 失败静默丢弃）进一步要求合成逻辑为纯函数。
- **修订**：director 合成为显式 `step(dtMs, inputs)` 纯推进，时钟由调用方（companion）驱动；眨眼随机源以构造参数注入（默认 `Math.random`）。规范文本固定此要求。
- **验证**：全部仲裁/管道测试以手工步进驱动，无真实等待。

## A10. 弹簧参数为配置而非规范常量

- **位置**：§4.2 第 1 条（ζ=0.85, ωn=15）。
- **问题**：将待调参占位符写进规范性文本，会诱导实现硬编码并阻碍按模型调校——历史教训恰是"文档声称超前于画面事实"。
- **修订**：数值改为**默认值**，落位于 director 配置（可被 rig 覆盖）；文本标注"默认值，须按真实模型画面调校"。
- **验证**：配置可覆盖；调参不触发规范文本变更。

## A11. 限时状态槽

- **位置**：§2.2 `StateTransitionOptions`。
- **问题**：现行 `pose` 工具带 `duration_ms` 到期自动回 neutral、失焦冻结剩余时间；v4.6 的槽位只有过渡时长，没有保持语义——边界规范（state 工具 `hold_ms`）没有引擎支撑。
- **修订**：`StateTransitionOptions` 增加 `holdMs?: number`；到期时该槽自动回 neutral（回 neutral 也走平滑过渡）；**多槽同时声明时各槽独立计时**；倒计时统一规则：任何非播放态（失焦、暂停）下冻结，回到播放态恢复剩余——焦点冻结由 world 在 `onFocus(false)` 时执行（幂等，见边界规范 §3）。
- **验证**：到期回 neutral 断言；多槽独立计时断言；冻结/恢复剩余时间断言（边界矩阵 #5）。

## A12. 非轴独占资源 (ExclusiveClaim)

- **位置**：§4.1（只覆盖逻辑轴）。
- **问题**：flip 需要 `model:transform`（MoveModelRequest 与参数轴并发会互相破坏位置）、costume 需要 effect 级互斥（热键切换的贴图道具不在参数轴空间内）。逐轴仲裁没有它们的位置；现行代码用资源字符串集合（`input:/output:/effect:/model:transform`）解决，v4.6 丢失了这块。
- **修订**：§4.1 末尾新增小节：director 同时维护一个**独占声明集**（claim id → 资源集合 + cleanup 标记），与逐轴仲裁并行生效；`model:transform` 与全部 effect 资源只经独占声明获取，与参数动作互斥；带清理的声明在清理完成前不可被抢占、不可随 safeStop 立即消失。接口规范见边界规范 §2（costume 与动作空间特技 spatial stunts）。
- **验证**：边界矩阵 #8/#9；空间特技取消后归位核实才结算。

## A13. 可选轴优雅降级

- **位置**：§1.5（Unsupported 行）、§5.1（`unsupported` 终态）。
- **问题**：v4.6 中模型缺通道 → 动作拒绝执行。但模型能力差异是常态（如无 `face.blush` 绑定的模型）：必需轴缺失拒绝是正确防御，**可选轴**缺失时整场拒绝则是体验倒退（现行实现已支持可选轴省略保持时序）。
- **修订**：rig v3 的 `optional: true` 轴缺失时：动作继续执行、时间轴保持、该轴省略，`details.omittedAxes` 列出；仅当动作**必需轴**缺失时返回 `unsupported`。目录生成时排除缺必需轴的动作。
- **验证**：可选轴缺失断言（边界矩阵 #12）；目录准入断言（边界矩阵 #1 的镜像）。

## A14. Performance 层推迟

- **位置**：§2.5。
- **问题**：两个层面。其一，`ctx.wait/Promise.all/条件分支` 就是 TypeScript，把普通 async 函数称作"第三层编排框架"会诱导建设注册总线与调度器——恰是旧实现膨胀的路径。其二（对抗式复查补充）：**v1 没有任何调用方**——v1 全部运行时触发点（工具、cue、宿主事件、自律发生器）经世界层的窄 API 即可覆盖；`PerformanceContext` 服务的是"运行时反应式演出脚本"（如 shyReaction），而 v1 演出全部是创作期静态组合（MotionBuilder），不存在运行时分支脚本。保留它违反与 A2（Timeline）相同的"无调用方"标准。
- **修订**：§2.5 整节移入文末附录"推迟特性"；世界层访问引擎只经 runtime 的窄 API（播放、槽位、独占声明、spatial）。触发条件：出现第一个真实的运行时反应式演出需求（依据环境刺激分支组合多个原语）时，按原规范引入该门面接口。
- **验证**：代码中无 PerformanceContext 符号；world 层对 director 的调用点全部收口在 runtime。

## A15. SupersededError 具名化

- **位置**：§2.2（两处提及 SupersededError）。
- **修订**：定义为具名错误类（`class SupersededError extends Error`），携带被抢占的轴集合；`instanceof` 判定而非字符串匹配。
- **验证**：验收矩阵 #6/#12 的判定方式。

## A16. 验收矩阵同步修订

- #15（Timeline 状态生命周期）**作废**（随 A2）。
- 新增：
  - #16 限时槽位：`holdMs` 到期自动回 neutral，断言平滑过渡（随 A11）；
  - #17 可选轴降级：省略轴不改变其余轴时序（随 A13）；
  - #18 独占资源：空间特技手势/costume 互斥与清理完成前不释放（随 A12）；
  - #19 类别优先级：四类别并发时合成顺序符合矩阵，且不存在绕过路径（随 A1）。
- §7 清单第 6 条改为：完成 `motion`、`gesture` 原子与 Phase 1/2 绑定，支持 `blendMode` 显式配置与代次失效（Timeline 移除）。

## A17. 抢占与控制权交还的精确语义

- **位置**：§2.2（atomic）、§4.1（仲裁与生命周期三态）。
- **问题**：v4.6 定义了 shadow/cancel/release 三态，但"抢占"一词未定义判定条件——additive 混合是否算抢占？atomic 的"整场取消"发生在什么时刻？被抢占轴最终交还给谁？这些留白会让实现各自发明判定。
- **修订**（精确化，非新机制）：
  1. **抢占 = Override 通道控制权转移**：只有 override 贡献的写入权变更构成抢占；additive 贡献的叠加与退出**永不构成抢占**，也不触发 atomic 取消；
  2. **atomic 抢占时刻**：atomic 动作控制的任一轴被更高优先级 override 接管时，立即触发该动作 cancel；`finished` 在该动作自身 fadeOut 收势完成后结算为 `cancelled`（不立即清零画面）；
  3. **交还规则**：动作释放/取消后，其轴经 fade 交还给下一有效来源——更高优先级动作尚在则交还被遮蔽轴（§4.1 第 3 条），否则回落到当前槽位/自律底座；不存在"无主轴"状态；
  4. **不复活**：已结算的动作实例不因任何后续事件重新参与合成。
- **验证**：断言 atomic 动作在 additive 叠加下不取消；抢占后 finished 结算时序；交还后轴值连续（边界矩阵 #10 的引擎侧对应）。

---

## 附：推迟特性 (Deferred)

| 特性 | 来源 | 触发条件 |
| --- | --- | --- |
| Timeline 绝对时序谱（含 seek 状态重构、repeat 循环重建、exitState） | v4.6 §2.4 | 命名表演确需绝对时序编排且 MotionBuilder 组合不足 |
| Performance 门面（PerformanceContext 运行时演出脚本） | v4.6 §2.5 | 出现第一个真实的运行时反应式演出需求（环境刺激分支组合） |
| `weighted` / `primary` 聚合策略运行时实现 | v4.6 §1.3 | 出现真实多轴汇入同一 VTS 输入的模型标定需求 |
| MotionBuilder `speed` / `weight` / `clock` / `repeat`、Handle `pause/resume/seek` | v4.6 §2.3/§5.2 | 出现具体调用方 |
