# Live2D 动画作者层重构实施计划

> **执行方式：** 主会话按依赖顺序逐任务实施；每个任务完成后做对应的定向检查。用户已授权直接开工。任务复选框用于记录实际进展。

**目标：** 将 Live2D 有限动作重构为由命名时间线、纯函数通道和可重现随机流编译得到的 Action，并以同一有效时钟驱动身体采样与空间事件。

**架构：** 作者层只在 Bake 时构造并验证 `ActionPlan`；播放期只采样编译通道并调度已排序空间事件。Director 继续拥有身体合成，ExternalActions 继续拥有 VTS 资源、请求和清理；两者共享动作时钟和 `t0`。本轮不迁移 MO 旧动画内容，旧动作目录及其复制夹具清除，机制用新的隔离测试作者验证。

**技术栈：** TypeScript、Vitest、现有 MotionDirector、VTS adapter 和 `pnpm mo:preview`。

**设计：** [live2d-animation-authoring-redesign.md](live2d-animation-authoring-redesign.md)

## 全局约束

- 时间单位统一为毫秒；作者时间由 `ActionPlan.timeline` 定义。
- `LocalCurve` 和 `ActionCurve` 保持相同函数形状；形状 helper 返回局部曲线，`during`/`track` 负责时间轴放置。
- 每个 ActionPlan 每轴最多一个通道；重复合并必须经 `mergeChannels`，同轴 offset 求和必须经 `sumOffsets`。
- `speed` 只在 Director/空间调度中缩放一次；曲线不内嵌速度。
- 作者 RNG 在 Bake 时结清；selection、performance、autonomic 三类随机流彼此隔离。
- 空间事件按绝对动作时间排序；同刻保留作者声明顺序；位姿窗口不可重叠。
- VTS 位姿/效果 ACK、失败、取消、迟到和清理继续按真实外部副作用结算；不重发不确定请求。
- 不改模型可见工具 schema、Worker 消息、endpoint、VTS adapter 或 Subject/Core。
- 本轮清除现有 MO 动作、ambient、idle/thinking 作者内容，不迁移旧曲线；保留与动作作者层无关的状态词表和模型标定。

## 开发依赖图

```text
T1 曲线类型 / Timeline / 组合器
  └─> T2 ActionPlan / 编译器 / 空间事件静态校验
        ├─> T3 可重现种子与用途隔离的 RNG
        │     └─> T4 Director 速度、有效时钟、合成诊断
        └───────────────┐
                        └─> T5 ExternalActions 共同 t0、预检、绝对事件调度与迟到结算
                              └─> T6 Runtime 接线、旧 MO 内容清除、目录代次/生命周期回归
                                    └─> T7 mo:preview 单次/重复/离线取样/真实执行诊断
                                          └─> T8 当前合同、审计记录、旧文件清理与最终定向验证
```

T3 与 T4 依赖 T2，但不依赖 T5；T5 必须同时消费 T2 的编译空间事件和 T4 的 Director 有效时钟。Worker/endpoint/tool contract 不进入依赖图，因为设计明确冻结这些边界。

## 文件职责图

| 文件 | 本轮职责 |
| --- | --- |
| `.uina/worlds/live2d/authoring/curves.ts` | Timeline、TimeSpan、曲线形状、`during`、`track`、通道合成 |
| `.uina/worlds/live2d/authoring/action.ts` | ActionPlan/ActionAuthoring、`motion()` 局部快捷写法、空间事件类型、Bake 校验、CompiledAction 纯采样 |
| `.uina/worlds/live2d/authoring/random.ts` | 根 seed、稳定派生和可重现随机流 |
| `.uina/worlds/live2d/authoring/catalog.ts` | Catalog 继续拥有词表/别名，改存 ActionAuthoring 并以固定探测 seed 校验 |
| `.uina/worlds/live2d/director/director.ts` | 共享有效时钟、单点 speed、最终合成与开发诊断 |
| `.uina/worlds/live2d/external-actions.ts` | 现有 claim/preflight/清理边界中的绝对时间空间调度和 ACK 记录 |
| `.uina/worlds/live2d/runtime.ts` | 派生随机流、Bake 一次、建立共同 t0、把 Action 与空间计划交给既有所有者 |
| `scripts/mo-preview.mts` | 保留连续预览，添加单次、固定 seed 重复、离线采样和真实执行追踪 |
| `tests/live2d-*.test.ts` | 用合成作者与假 VTS 验证机制、生命周期、结果语义；不保留旧动画拷贝夹具 |
| `docs/live2d/live2d-world-runtime.md`、`MOTION-AUTHORING.md`、审计登记 | 描述新运行合同、预览入口、明确未迁移内容与真机边界 |

## Review Focus

1. 非有限/越界 Timeline、超出当前 ActionPlan 数值范围的 span、重叠 track 或位姿窗口必须在 Bake 前失败；TimeSpan 不记录 Timeline 身份，由 `tests/live2d-motion.test.ts` 固定。
2. 作者随机调用次数变化不能改变其他动作的选择或 autonomic 流；由新增 `tests/live2d-random.test.ts` 固定。
3. ACK 延迟超过位姿窗口时不可重发或报告成功，必须取消后续动作并归位；由 `tests/live2d-exclusive-tools.test.ts` 固定。
4. pause/focus/safeStop 与模型/目录代次变化不能让旧动作对新状态继续派发；由 `tests/live2d-interrupt.test.ts`、`tests/live2d-e2e-lifecycle.test.ts` 固定。
5. 清除旧 MO 动作后，状态词表和预览必须明确显示当前没有动作，不得暗中回退到备份目录；由 `tests/live2d-mo-catalog.test.ts`、预览参数测试固定。

---

### Task 1：纯曲线与命名时间线

**文件：** 创建 `authoring/curves.ts`；更新 `tests/live2d-motion.test.ts`。

**接口：** `timeline(durationMs, markers) -> Timeline`、`keys(points) -> LocalCurve`、`poseWindow(...) -> LocalCurve`、`spring(...) -> LocalCurve`、`oscillate(...) -> LocalCurve`、`during(span, curve, options) -> ActionCurve`、`track(parts, options) -> ActionCurve`、`absolute`、`offset`、`sumOffsets`、`mergeChannels`。

- [ ] 覆盖 `start=0`、`end=durationMs`、同刻 marker、未知 marker、保留名冲突、非法 span 和越界 marker。
- [ ] 覆盖 keys 夹紧/严格递增；poseWindow 的进出窗口、ease、零时长与数值校验。
- [ ] 覆盖 spring 参数/端点/有限输出与代表输入下的过冲和逐次衰减；若候选形状不满足，调整内部公式而不扩充接口。
- [ ] 覆盖 oscillate 的相位、周期、淡入淡出及其端点性质。
- [ ] 覆盖 during 默认端点、track 首尾/间隙、顺序/重叠、常量边界和 offset 静默归零。
- [ ] 覆盖 sumOffsets 只接受同空间通道、mergeChannels 重复轴响亮失败、motion 将局部时间原点映射到动作起点。

### Task 2：ActionPlan、编译与空间事件校验

**文件：** 创建 `authoring/action.ts`；修改 `authoring/catalog.ts`；删除旧 `authoring/motion.ts`；更新 authoring/catalog 测试。

**接口：** `ActionPlan { timeline, channels, spatial?, speed? }`、`ActionAuthoring(rng) -> ActionPlan`、`motion(durationMs, localChannels) -> ActionAuthoring`、`compileAction(authoring, controls, rng) -> CompiledAction`、`sampleAction(compiled, actionMs, baseline) -> ActionSample`。

- [ ] 编译器只调用一次作者工厂；校验正有限 duration/speed、已声明轴、唯一通道、时间域、曲线有限采样和结果冻结。
- [ ] 把身体通道编译成纯采样产物；播放期不再遍历作者组合器或空间作者对象。
- [ ] `motion(durationMs, localChannels)` 返回 ActionAuthoring；Bake 生成 `[0,durationMs]` 时间线，并把局部曲线原点映射到动作起点。
- [ ] 将 `SpatialStuntDef.segments` 改为 `at` 效果 marker 与 `during` 位姿窗口；保留已有 transform/effect 字段与 external-actions 所有权。
- [ ] 校验 marker 必须早于动作结束、span 在范围内、位姿 span 不重叠、VTS 请求时长边界和同刻稳定顺序。
- [ ] Catalog 校验用固定 seed Bake 后丢弃；真实播放不缓存 Bake；以 `ActionAuthoring` 替换 `MotionAuthoring`/`MotionPlan`。

### Task 3：随机流隔离

**文件：** 创建 `authoring/random.ts`；更新 `runtime.ts` 与随机相关测试。

**接口：** `createSeededRandom(seed)`、`deriveRandom(seed, purpose, actionName, playIndex)`；purpose 固定为 `selection | performance | autonomic`。

- [ ] 固定整数 seed 对同一动作序号生成相同选择和 Bake 参数。
- [ ] 修改一个作者消耗的 performance RNG 次数不改变下一动作、变体选择或 autonomic 序列。
- [ ] Runtime 为稳定动作名维护播放序号；换 Catalog 时清除对应轮换状态。
- [ ] 生产默认根 seed 用安全随机种子生成；authoring 不再隐式回退到 `Math.random()`。

### Task 4：Director 单点 speed、共同有效时钟与诊断

**文件：** 修改 `director/director.ts`；按需修改 `director/pipelines.ts`；更新 arbitration/runtime tick 测试。

- [ ] Director 暴露只读、单调的有效时钟；冻结时不前进；每次 play 以该时钟建立 startAt/t0。
- [ ] `speed` 仅把墙钟动作历时换算为 actionMs；有效播放时长为 `durationMs / speed`，暂停时不累计。
- [ ] 编译动作作者目标、Director 合成输出、各轴贡献来源及最终 clamp 命中分开保留为开发诊断。
- [ ] 异常采样继续走现有 haltSynthesis 故障停车；不得跳帧吞错。

### Task 5：ExternalActions 绝对时间空间调度

**文件：** 修改 `external-actions.ts`；更新 `tests/live2d-exclusive-tools.test.ts`、`tests/live2d-performance.test.ts` 和相关夹具。

- [ ] 在现有 claim 后预检模型基线、所有随机空间目标、效果 preset 和身份代次；失败时先释放 claim，不启动身体动作/外部请求。
- [ ] 预检通过后只建立一个 t0；同一 t0 启动 Director 与绝对计划事件调度；span 上先派效果并等待 ACK，再派位姿，ACK 耗时计入窗口。
- [ ] 记录计划/派发/ACK/估计结束/迟到；ACK 不重置时间，请求未确认时不重发。
- [ ] 效果失败允许后续事件继续、最终 unknown；位姿失败不派依赖位姿，明确未派发与已派发未确认使用正确状态。
- [ ] `spatial_window_missed`、`minUsefulMoveMs`、动作结束后的 marker、同刻顺序和速率缩放各有定向回归。
- [ ] blur、取消、safeStop、换模型/换目录继续按旧所有权清理；清理失败仍为 unknown/cleanup_unconfirmed。

### Task 6：Runtime 接线与旧内容清理

**文件：** 修改 `runtime.ts`、`models/mo/catalog.ts`、MO catalog/运行时测试；删除旧目录备份及旧动作内容夹具。

- [ ] 运行期按目录名称选变体、派生 performance RNG、Bake 一次并将同一 CompiledAction 交给 Director 与 ExternalActions。
- [ ] body-only、spatial、endpoint cue、express、ambient 和 thinking 各自调用统一 Bake/seed 机制；工具 schema 与 Worker 消息不变。
- [ ] 不迁移旧 MO 动作/ambient/idle/thinking 曲线；保留 posture/expression/attention/costume 与 rig 标定，空动作词表明确报告无可用动作。
- [ ] 删除 `models/mo/catalog-bak.ts.txt`、复制旧动画的 `tests/live2d-mo-fixture.ts` 和 `elastic`/MotionPlan 等旧 authoring API；不留兼容转发。
- [ ] 回归目录替换、动作结果、safeStop 和 body/status 内容，不让空目录影响静态状态能力。

### Task 7：作者预览入口

**文件：** 修改 `scripts/mo-preview.mts`；新增/更新预览 CLI 测试。

- [ ] 保留默认连续轮播和 Ctrl-C safeStop。
- [ ] 增加单次播放、固定 seed 重播指定次数、离线任意 actionMs 采样；离线模式不连接 VTS、不产生副作用。
- [ ] 离线/真实追踪输出计划、作者目标、最终合成值、来源、clamp、计划/派发/ACK/迟到和结算。
- [ ] 空动作词表时准确列出“无可用动作”，不读取旧备份或隐式运行旧内容。

### Task 8：合同文档、历史清理与最终门禁

**文件：** 更新 `MOTION-AUTHORING.md`、`docs/live2d/live2d-world-runtime.md`、`docs/current-runtime.md`、设计状态与审计登记；按引用修正直接失效文档。

- [ ] 文档覆盖作者 API、RNG、Bake、speed/t0、ACK/迟到、Director 诊断、预览模式、生命周期和不迁移范围。
- [ ] 删除当前文档中的过时 ACK 后整段等待合同、elastic/MotionPlan/目录备份链接和迁移完成声明。
- [ ] 重新逐节对照设计 §1-8 与以上任务；代码搜索确认生产源无 `MotionPlan`、`elastic`、`SpatialStuntDef`、`catalog-bak` 或旧版本适配层。
- [ ] 跑 Live2D 定向测试、TypeScript 类型检查、边界检查与 `git diff --check`；完整测试套件不作为本轮必要门禁。
- [ ] 检查工作树 diff，报告代码结果、旧内容清理范围、定向验证结果和真实 VTS/MO 未验证边界。

## 设计覆盖自审

| 设计章节 | 负责任务 | 检查点 |
| --- | --- | --- |
| §1 目标、职责与冻结边界 | 全局约束、T4-T7 | Director/ExternalActions/Worker/World 所有权不串层；工具与 Worker 合同冻结；ambient 不造无限播放器 |
| §2 作者接口、Timeline、曲线和同轴规则 | T1-T2 | Local/Action 时间域、marker/span、所有 shape/helper、边界与非法值 |
| §3 身体/空间共用 Timeline | T2、T5 | marker/span、effects 顺序、绝对事件时间、stable tie order、位姿不重叠、VTS 单请求上限 |
| §4 Bake、随机性与启动 | T2-T3、T5-T6 | 固定探测 seed、逐播 Bake、三个隔离随机流、claim/preflight 在共同 t0 前完成 |
| §5 speed、ACK、迟到、取消与生命周期 | T4-T6 | speed 一次缩放、effective clock、每类请求结果、迟到阈值、清理/换代/失焦 |
| §6 Director 合成与三类预览 | T4、T7 | 作者/合成/clamp 分层诊断；离线计划、Director 合成、真实 VTS trace |
| §7 验收与分阶段落地 | Review Focus、T1-T8 | 定向回归覆盖全部输入类别；按用户要求不迁移生产动作内容 |
| §8 非目标 | 全局约束 | 不加动作树/GUI/通用物理模拟/DSL/脚本沙箱/逐轴 RNG/新混合器/兼容层 |

### 需要在实现中定值的设计留白

- `track` 的 `before`/`after` 接受常数或默认端值；`gap` 接受常数或 `"hold"`，不自动交叉淡化。
- 曲线函数保留普通 `(ms) => number` 形状；运行时只为本层生成的曲线记录最少域元数据，让 `sumOffsets` 拒绝已知的 Local/Action 混用，不引入名义 TypeScript 品牌。
- `minUsefulMoveMs` 先采用 100ms 的内部保守阈值；真机未连接时只能验证调度和结算合同，不能把该数值说成 VTS 校准结果。
- 本轮清除旧 MO 动作资产；真实 VTS 观感/阈值验收和之后重建动作目录是分开的内容交付，不以旧动作移植来替代。
