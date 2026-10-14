# Live2D 动画开发最佳实践

本文按动画作者的工作顺序说明：如何决定内容类别、核对模型 rig、编写和登记动作、预览合成、在 VTube Studio 验收并收尾。它补充 [Action 作者合同](MOTION-AUTHORING.md) 与 [Live2D World 运行合同](../../../docs/live2d/live2d-world-runtime.md)；类型、校验和运行结果以当前源码为准。

## 当前起点

当前 MO 的动作、姿态、表情和背景内容目录为空。通用 ActionAuthoring、目录编译、Director、状态工具与 `mo:preview` 仍在；这表示机制可用于重建，不代表 MO 动画已经存在或通过视觉验收。开始前先运行 `pnpm mo:preview -- --list`，并通过 Uina 的 `status` 查看模型、绑定和目录。不要从历史目录复制旧动作或预设。

## 1. 先按用途选择目录

类别由作者根据内容的生命周期选择，代码不会从动作涉及的轴自动推断类别。姿态和表情是静态状态目标；动作和背景片段是带时间过程的 ActionAuthoring。

| 类别 | 作者要回答的问题 | 内容形式与运行入口 |
| --- | --- | --- |
| `postures` | 身体要保持成什么目标姿态？ | 轴目标值与 `transitionMs`；由 `state.posture` 设置，到期或被替换后回中性。 |
| `expressions` | 面部要保持成什么目标表情？ | 轴目标值与 `transitionMs`；由 `state.expression` 设置。若有眨眼、嘴形变化等明确时间过程，应写成 `motions`，不要伪装成静态表情。 |
| `motions` | 有明确开始、发展、停留和结束的一次表演是什么？ | 一个有限时长 ActionAuthoring；由 `express` 播放，也可由 `<cue id="动作名"/>` 触发。 |
| `background.ambient` | 用户选择后持续陪伴、可让位给前景动作的循环片段是什么？ | 与 motion 相同的 ActionAuthoring；通过 `state.ambient` 选择或清除。多个短句可做为一个 ambient 条目的主片段和 variants。 |
| `background.idle` | 没有用户选择的 ambient 时，默认运行什么背景循环？ | ActionAuthoring；Runtime 自动循环，不通过 `express` 选择。 |
| `background.thinking` | 宿主进入 thinking 状态时运行什么背景动作？ | ActionAuthoring；由 Runtime 随 thinking 事件自动启动和停止。 |

姿态、表情、注视、ambient 可以由一次 `state` 调用组合设置；未传字段不变。`hold_ms` 适用于姿态、表情和注视，不控制 ambient。cue 当前只解析命名动作和姿态；表情、注视和 ambient 走 `state`。服装/外观由 `costume` 与 VTS 热键处理，不是身体曲线。

一个实用判断是：如果内容的意义在于“到达并保持某个状态”，登记为 posture/expression；如果意义包含明确时间节奏或动态变化，登记为 motion；如果其作用是填充没有前景动作的背景时间，登记为 ambient 或相应的 idle/thinking。

## 2. 写曲线前先核对 rig 和动作意图

先看 [MO rig](models/mo/rig.json) 中的 `controls`、`bindings` 和来源声明。动画使用逻辑轴名，不直接写 VTS 原始参数名。当前 MO rig 声明的逻辑轴包括：

- 头部：`head.yaw`、`head.pitch`、`head.roll`
- 躯干：`torso.yaw`、`torso.pitch`、`torso.roll`
- 视线：`gaze.x`、`gaze.y`
- 面部：`eyes.left.open`、`eyes.right.open`、`mouth.form`、`mouth.open`

每个轴的 `min`、`max`、`neutral` 是作者的有效范围与基线；不要在动画中假设超出 rig 的范围仍可见，也不要把夹限当作常规调幅手段。当前 rig 没有手臂逻辑轴。未显式驱动躯干时，Director 默认让躯干跟随头部合成目标；显式 torso 轨迹会接管相应轴。不要通过全模型平移来伪造头身动作；只有确实需要改变屏幕内模型位置、尺寸或旋转时才声明 spatial 事件。

每个动作先写一张小型作者简报，避免边写曲线边猜：

1. **触发**：用户主动调用、语音 cue、默认 idle、宿主 thinking，还是用户选择的 ambient？
2. **意图**：用一句话说清观众应该读到的行为。
3. **节奏**：起势、主动作、停留、回收分别发生在哪些时间点？
4. **驱动轴**：哪些轴必须主动写，哪些应该跟随当前状态或 rig 的头身联动？
5. **共存**：会与持续姿态、表情、注视、说话口型、自律眨眼或背景片段同时运行吗？冲突时谁应接管？
6. **结束状态**：正常完成、被打断和失焦后分别应该保持、交还或归中什么？
7. **外部效果**：是否需要真实位姿变化、染色或后处理？效果由外部动作路径结算，需有明确恢复条件。

涉及躯干控制时，先看 `status(detail=true)` 的 `bodyMapping`。需要建立身体自定义输入时调用 `prepare_body`，在 VTube Studio 手动映射到 `ParamBodyAngleX/Y/Z`，随后 `reload` 并再次检查映射。工具接受输入不代表画面已正确响应。

## 3. 按类别组织文件，并显式登记

目前 MO 的模型专属目录入口是单个 `models/mo/catalog.ts`，其中 `MO_CATALOG_SOURCE` 现在为空。作者层不会自动扫描文件夹：任何定义都必须通过 `catalog.ts` 显式导入并登记。动作数量增长后，推荐按四类目录拆分，入口只承担汇总职责：

```text
models/mo/
  catalog.ts
  motions/
    greeting.ts
    look_around.ts
  postures/
    index.ts
  expressions/
    index.ts
  background/
    idle.ts
    thinking.ts
    ambient/
      gentle_sway.ts
```

复杂、带时间线的 motion 或 background 片段一条一个文件，便于单独预览和审查。姿态/表情是短小静态数据，可以先按类别集中在 `index.ts`，只有内容本身变复杂时再拆。不要为了目录完整创建空文件夹，也不要用动态文件扫描代替显式登记。

登记对象的字段遵循 `CatalogSource`：命名动作写在 `motions[name]`，作者函数字段叫 `motion`；姿态和表情写在 `postures` / `expressions`；背景写在 `background.idle`、`background.thinking` 和 `background.ambient[name]`。大致形状如下：

```ts
export const MO_CATALOG_SOURCE: CatalogSource = {
  motions: {
    greeting: {
      description: "视线先迎向对方，再转头并自然收回",
      aliases: ["问候"],
      motion: greeting,
    },
  },
  postures: {
    settled: {
      description: "平稳站定",
      values: { "head.pitch": 1 },
      transitionMs: 350,
    },
  },
  expressions: {},
  background: {
    idle,
    thinking,
    ambient: {
      gentle_sway: { description: "轻缓摇摆", motion: gentleSway },
    },
  },
};
```

这段只示意登记边界，具体曲线见下一节。名称和别名全目录唯一，包含动作、姿态、表情、attention、ambient、costume；重名会使目录编译失败。Motion 的 `atomic` 默认是 `true`，只有明确希望被高优先级动作接管后继续播放时才覆盖它。

## 4. 用统一 ActionAuthoring 写时序动作

所有时序动作都采用 `ActionAuthoring = (rng) => ActionPlan`。motion、ambient、idle 和 thinking 共用同一套曲线工具；分类差别体现在目录位置和 Runtime 生命周期，不体现在另一套动画语法。

- 简单单段动作使用 `motion(durationMs, localChannels)`；有错拍阶段时用 `timeline()` 定义命名 marker，再用 `during()` / `track()` 放置局部曲线。
- `keys()` 表达明确采样点；`poseWindow()` 表达进场、停留和退场；`spring()`、`oscillate()` 表达回弹和有限振荡。时间单位全部是毫秒。
- `LocalCurve` 以片段起点计时；放进 ActionPlan 后必须成为从动作起点计时的 `ActionCurve`。不要把局部曲线直接塞进 ActionPlan。
- 每个 ActionPlan 每个轴只有一条通道。`mergeChannels()` 处理不同轴，`sumOffsets()` 只用于明确需要相加的同轴增量；不要用对象展开覆盖已有轴。
- `absolute(curve)` 是该轴的目标值，会参与逐轴 Override 仲裁；`offset(curve)` 是相对本次播放基线的增量，可与其它增量叠加。姿态需要可保留的动作幅度时优先考虑 offset；动作必须准确达到某一目标时使用 absolute。
- `track()` 不会自动交叉淡化：明确写出每段的首尾值和 gap 规则。动作回归中必须检查回收段，不能只看峰值。
- 所有随机幅度和相位在作者工厂 Bake 时通过传入的 `rng` 抽取。返回的曲线必须是纯函数：采样时不再消费 RNG，不读时钟、不调用 `Math.random()`、不依赖可变外部状态。
- `speech: "exclusive"` 只用于动作有意独占 `mouth.open` 的情况，会压制同轴说话口型；其它情况下维持普通语音混合。
- `speed` 是播放速度倍率，由采样时钟与空间 wall-time 统一换算一次。不要同时按 speed 改曲线时间和 spatial 时间。

作者工厂只调用一次并被编译校验；编译检查时间线、rig 轴、曲线代表点有限值、通道类型、helper span 和空间事件。曲线探针通过不等于视觉正确，仍须预览完整动作周期。

## 5. 设计叠加时按逐轴所有权思考

目录类别和 Director 仲裁类别不是一回事。Runtime 将普通命名动作作为 `voluntary` 播放，将 idle/ambient 作为 `autonomic` 背景，将 thinking 作为 `transition` 背景。姿态/表情槽位同样以 transition 级目标参与合成；内建眨眼、呼吸和微动另有 autonomic 来源。

导演合成不是“所有动画整组相加”：

- 同一轴的 absolute 写入按 Runtime 类别优先级和激活顺序选一个。大致优先级是 reflex > voluntary > transition > autonomic；低优先级播放被遮蔽时仍可能继续走自己的时间，之后再从当前画面平滑接管。
- atomic 动作的任一轴被更高类别接管时会被取消；默认开启。相同类别的同轴冲突由新者遮蔽旧者，不自动取消旧者。
- baseline-offset 增量独立叠加，不参加 absolute 抢占；高优先级作者可通过 `inhibitAdditives` 抑制指定低层增量。
- 前景身体动作到来时，background 权重淡出；背景动作的时间继续推进。完成前景后背景再淡入。不要把 ambient 写成必须精确续播到同一瞬间的主表演。
- posture 与 expression 虽是不同槽位，若它们写到同一 rig 轴仍会竞争。编译器校验轴存在和值域，但不判断某轴语义上“应该属于姿态还是表情”；作者须按意图归类。
- `gaze.*` 还会经过 attention 补偿；眼睑会与生理眨眼调制；`mouth.open` 会与语音包络合成。看作者曲线目标时要同时看 Director 最终帧。

因此每个动作都要选清楚起始基线、目标写入模式、接管意图和退出后的归属。不要为了把状态凑在一起，把本应持续的表情塞进 motion；也不要把有节奏的面部表演降格成静态 expression。

## 6. 先离线，再连 VTS

`pnpm mo:preview` 当前只选择 `motions` 目录中的命名动作；它不提供 posture/expression/ambient 的离线采样界面。状态槽与背景片段需由相应的合成测试覆盖，并在运行链路中单独验收。

推荐逐条执行：

```text
pnpm mo:preview -- --list
pnpm mo:preview -- --sample greeting 450 --seed 17
pnpm mo:preview -- --once greeting --seed 17
pnpm mo:preview -- --repeat 3 greeting --seed 17
```

- `--list` 确认名字和别名实际进入了 MO 目录；当前目录为空时应如实显示空数组。
- `--sample` 离线执行，不连接 VTS。它以 rig 中性值作为基线，输出编译计划、作者目标、范围裁剪、Director 合成帧、贡献来源和 clamp hit。它适合检查节奏关键点、异常数值和轴合成，不证明角色表演自然。
- `--once`、`--repeat` 和连续模式会启动真实 Runtime 并等待 VTS 连接和模型绑定。只在已确认加载正确模型时使用。`--seed` 可重现作者与变体选择的随机序列；它不保证设备的精确时序重放。
- 连真实 VTS 时查看 `[计划]`、`[合成诊断]`、`[结算]`。按 `Ctrl+C` 会走 `safeStop` 并等待在途动作与空间清理结算；不要直接杀进程后把画面残留当作正常结果。

每个 motion 至少检查起点、中段关键峰值、停留末尾、回收段和结束 handoff；只有峰值截图不够。先用固定 seed 找到可接受的基准，再检查不同 seed 下幅度变化仍自然。

## 7. 空间动作与 VTS 外部效果

只有真实需要模型在屏幕空间移动、缩放、旋转，或需要 tint/post 时，才在 ActionPlan 中声明 spatial 事件。身体头身动作优先使用 rig 的头/躯干轴。spatial 不由 Director 曲线直接写 VTS；它由 ExternalActions 在资源独占和基线预检后与身体动作共用 `t0` 调度。

- effect marker 的时间点必须早于 ActionPlan 终点；位姿 span 必须在时间线内且彼此不重叠。
- 有位姿的事件先检查剩余窗口，再发效果并等待 ACK；ACK 后再次核验窗口和当前模型，再移动。ACK 等待会消耗动作时间，不会把后续片段整体顺延。
- 当前内部起始门槛要求位姿窗口至少剩 100ms；它还没有真实 VTS 延迟校准。作者要为请求和插值留出足够时间，不要把效果或位姿变化压在临界终点。
- 正常完成会等待整个身体动作结束再恢复基线；效果值保持到下一同类事件或动作结束。取消、位姿失败或错过窗口会立即清理。
- VTS 位姿或效果请求结果不确定时不能当作成功。观察预览 settlement 中按项记录的 dispatch、ACK、迟到和 cleanup；不要通过盲目重发来“补成功”。
- 同一模型被人手动移动时，Runtime 会在安全边界放弃旧基线归位，避免覆盖用户的新位置；spatial 动作在片段内部不做逐帧位姿轮询。

离线 `--sample` 不产生 VTS 请求，因此不能验收空间插值、ACK 延迟、滤镜显示或归位。空间动画必须安排真实 VTS 验收；若设备当前不可用，结论应标记为未验收。

## 8. 自动验证与视觉验收分开

代码侧先运行与改动范围相符的定向测试，例如：

```text
pnpm exec vitest run tests/live2d-action.test.ts tests/live2d-catalog-authoring.test.ts tests/live2d-director-action.test.ts tests/live2d-spatial-playback.test.ts tests/live2d-preview.test.ts tests/live2d-mo-catalog.test.ts
pnpm typecheck
```

这些测试证明编译、目录、合成、空间请求和 fake VTS 边界；不能证明 MO 的动作自然度、真实 VTS 映射正确、舞台构图或用户视觉满意。类型/边界检查也不会替代设备验收。

实机验收按场景记录：

1. 确认 VTS 连接、模型身份和 `bodyMapping`；未 ready 的轴不要拿来做视觉结论。
2. 在 MO 的中性状态逐次播放单条动作，至少观察一个完整的进场—表演—停留—退出周期。
3. 检查头身错拍是否符合动作意图、眼神是否与头部转向配合、面部是否被语音/生理眨眼意外遮盖、躯干是否由默认跟随或显式通道正确驱动。
4. 与 posture/expression、attention、说话口型、自律眨眼和 ambient 的实际共存场景各检查一次；同轴争用时画面应符合已选的接管和交还规则。
5. 对 spatial 动作检查窗口、外部 ACK、完整停留、模型手动偏移边界和结束归位；取消后单独确认效果和位姿清理。
6. 最终再次调用 `status(detail=true)`，确认所需绑定仍正确、模型未遗留意外状态。保存动作名、seed、关键问题和验收者结论。

## 完成检查单

- [ ] 内容归入正确的目录类别，入口文件显式登记；名字和别名不冲突。
- [ ] 使用 rig 已声明的逻辑轴和范围；状态槽是目标值，时序动作才写 ActionPlan。
- [ ] 动作的起势、主表演、停留、回收、说话共存与被抢占语义都已表达。
- [ ] Bake 校验和定向测试通过；离线采样没有意外 clamp 或轴贡献。
- [ ] 真实 VTS/MO 完整周期观感已验收；不可用的设备路径明确记为未验收。
- [ ] spatial 和效果副作用有明确 settlement 与归位证据。
- [ ] `status` 呈现的是当前实际目录，不留旧名字、旧备份回退或只写在文档未登记的内容。
- [ ] 需要时更新当前运行合同；最佳实践负责指导流程，作者 API 细节仍以 `MOTION-AUTHORING.md` 为准。
