# Live2D 标签动作链路修复方案

- **状态（2026-10-14）**：部分实施，仍有 parser 生命周期和结果语义缺口；不按本文旧“当前行为”表推断现状。
- **日期**：2026-10-01
- **范围**：`<cue>` 标签从模型输出到 Live2D 动作执行的完整链路
- **目标**：修复流中断串标签、异步派发假成功、取消竞态、协议解析不一致和目标路由绕过校验等问题
- **非目标**：不重写 World Framework，不增加中央事件总线，不把 cue 升格为新的 Core 概念，不改 TTS/Embodiment 的所有权边界，不处理与 cue 无关的 VTS 动作表现问题

---

## 1. 执行摘要

当前标签动作的根因不是某一条 cue 映射错误，而是**标签生命周期没有绑定输出流生命周期，动作投递没有结果语义**。

当前链路实际是：

```text
output_update
  -> 全局 StreamingTagStripper
  -> BodyRouter.dispatchCue() 同步返回 boolean
  -> BodyEndpoint.emitCue() void
  -> MotionDirector.dispatchCue() fire-and-forget
  -> 异步 claim / playExpressiveBeats
```

这条链路同时存在三种错误：

1. **边界错误**：`output_interrupted` 不清理解析状态，半截标签可以跨流拼接。
2. **所有权错误**：路由层把“调用了 emitCue”当成“动作已送达”，但真正的动作执行在更下游异步发生。
3. **取消错误**：输出流、回合、cue 动作各自有取消路径，但没有共享同一个取消边界。

修复原则：

- 一个 content stream 一个 cue parser 状态；
- `output_start / update / end / interrupted` 完整收口；
- cue 派发只报告“是否被接受/为何未启动”，不伪造物理执行成功；
- 所有待执行 cue 必须持有当前输出流的 `AbortSignal`；
- `target` 路由与隐式路由使用同一套能力匹配和 ID 归一化；
- 标签协议保持轻量，不引入新的总线、队列或全局协调器。

---

## 2. 实施前审查基线（2026-10-01，非当前源码状态）

### 2.1 当时的代码事实

| 位置 | 当前行为 | 后果 |
|---|---|---|
| `.uina/extensions/embodiment/index.ts:148-155` | 只处理 `output_update` 的 content | 标签提取依赖流式回调 |
| `.uina/extensions/embodiment/index.ts:157-164` | 只在 `output_end` flush | 正常结束可收口 |
| `.uina/extensions/embodiment/index.ts:174-177` | `turn_aborted` 才调用 `stripper.flush()` | 没有处理 `output_interrupted` |
| `src/agent/stream-collector.ts:137-164` | 中断输出会发 `output_interrupted` | 当前 Embodiment 没有接住 |
| `.uina/extensions/embodiment/tag-stripper.ts:12-28` | parser 是单例字段，状态跨调用保存 | 可跨流残留 |
| `.uina/extensions/embodiment/body-router.ts:104-151` | `dispatchCue()` 返回同步 boolean | 只能证明调用了端点 |
| `.uina/extensions/embodiment/types.ts:46` | `emitCue(cueId): void` | 无法返回取消、拒绝、执行受理结果 |
| `.uina/worlds/live2d/runtime.ts:81-84` | `emitCue()` 更新 `lastCue` 后异步派发 | 未执行的 cue 也可能显示为最近 cue |
| `.uina/worlds/live2d/motion-director.ts:53-56` | `dispatchCue()` 使用 `void` 调用异步 dispatcher | 失败无法回传 |
| `.uina/worlds/live2d/runtime.ts:48-57` | 通道抢占失败直接 return | cue 被静默丢弃 |
| `.uina/extensions/embodiment/body-router.ts:115-121` | 指定 target 时不检查 affordance | 定向 cue 可绕过能力声明 |
| `.uina/extensions/embodiment/body-router.ts:124-150` | 隐式路由只做原始字符串比较 | 与 Live2D 内部归一化不一致 |
| `.uina/extensions/embodiment/tag-stripper.ts:131` | cue 正则允许可选 `/` | 非自闭合标签也会触发 |
| `.uina/extensions/embodiment/tag-stripper.ts:183-197` | `id` 只接受引号形式 | 非法标签可能被删除但不执行 |

### 2.2 当时复现的关键问题

以下行为已在当前 checkout 复现：

```text
stream 1: 前文<cue id="warm_
stream 1: output_interrupted
stream 2: smile"/>后文
```

当前结果：第二个 stream 会得到 `warm_smile` cue。

这是错误的。上一条输出被中断后，未闭合标签必须被丢弃，不能参与下一条输出解析。

### 2.3 当时的验证边界

当时记录的 typecheck/测试结果仅对应 2026-10-01 工作树；文中关于 Live2D 测试被 `.gitignore` 排除的说法已过时。

### 2.4 当前源码复核（2026-10-14）

- Embodiment 仍由一个 `StreamingTagStripper` 跨输出调用保存状态，只订阅 `output_update` 与 `output_end`，没有按 `output_start` / `output_interrupted` 创建、清理每条 content stream 的 parser。半截标签仍可能跨流串接。
- `BodyRouter.dispatchCue()` 仍返回同步 boolean，`BodyEndpoint.emitCue()` 仍为 `void`；路由层不能表达异步拒绝、取消或“已受理但执行结果未知”。
- 已实现的改进包括目标路由能力检查、`supportsCue` 与目录同源、`lastCue` 异步账本，以及 `turn_aborted → interrupt`。TTS 当前复用 Embodiment 的 `parseCueTag`，并由 `playback-cues.ts` 按实际播放位置投递；这取代了原文“只共享测试向量、无跨扩展运行时依赖”的边界。
- `tests/speech-cue-playback.test.ts` 覆盖 TTS 的跨 chunk、过滤和中断清队列；它不覆盖 Embodiment parser 的每流生命周期。相关测试文件在仓库中存在，本轮没有运行这一组测试。
- 本轮 `pnpm typecheck` 通过，`tests/live2d-mo-catalog.test.ts` 的 6 项通过；该目录测试不证明此次 MO 曲线重写的自然度。真实 VTS/MO 视觉效果未验收。

---

## 3. 第一性原则与不变量

### 3.1 标签不是工具调用

`<cue>` 是模型输出中的**旁路表现信号**，不是需要模型等待结果的工具调用。

因此：

- 标签不阻塞正文流；
- 标签不打开新的模型回合；
- 标签不写入主体的权威历史；
- 标签不需要返回“动作完成”给模型；
- 但系统内部必须知道它是“已接受”“未启动”“已取消”还是“状态未知”。

不能把“异步开始处理”包装成 `succeeded`。

### 3.2 输出流是标签状态的最小生命周期边界

一个 cue parser 只能服务一个 content stream。

```text
output_start(streamId)
  -> output_update(streamId)*
  -> output_end(streamId)
```

异常路径：

```text
output_start(streamId)
  -> output_update(streamId)*
  -> output_interrupted(streamId)
```

任何 parser 缓冲区、待执行 cue、取消信号，都不能跨越这条边界。

### 3.3 “送达”必须拆成两个事实

标签链路至少区分：

```text
解析成功
  -> 路由匹配成功
  -> 身体接受执行
  -> 动作实际完成
```

cue 是旁路信号，不等待完整动作完成，因此本次修复只需要保证前三层真实：

- `accepted`：目标身体在线、未暂停、支持该 cue，并已接受执行；
- `not_started`：没有执行，例如 offline、busy、unknown cue、invalid target；
- `cancelled`：在动作开始前或动作进行中被当前 stream/turn 取消；
- `unknown`：已经向物理端发送请求，但无法确认物理状态。

不在 cue 链路中使用 `succeeded` 表示动作完成。

### 3.4 BodyEndpoint 仍是唯一身体行为出口

不新增中央 cue bus。

Embodiment 负责：

- 解析模型输出；
- 绑定输出生命周期；
- 选择目标端点；
- 传递取消信号；
- 记录未受理原因。

Live2D World 负责：

- 解释 cue；
- 仲裁身体通道；
- 启动/取消动作；
- 报告身体侧受理结果。

Host、Core、Session、UI 不增加 cue 概念。

---

## 4. 目标设计

## 4.1 Cue 结果类型

在 Embodiment 与 World 的共享行为合同中增加最小结果类型：

```ts
export type CueDeliveryStatus =
  | "accepted"
  | "not_started"
  | "cancelled"
  | "unknown";

export interface CueDeliveryResult {
  status: CueDeliveryStatus;
  cueId: string;
  bodyId?: string;
  reason?:
    | "unsupported_cue"
    | "unknown_target"
    | "body_offline"
    | "body_paused"
    | "channel_busy"
    | "invalid_cue"
    | "stream_cancelled"
    | "physical_state_unknown";
}
```

合同只描述 cue 是否被身体接受，不描述具体 Live2D 参数，也不暴露 MotionDirector。

将 `BodyEndpoint` 改为：

```ts
emitCue(cueId: string, options?: { signal?: AbortSignal }): Promise<CueDeliveryResult>;
```

这是必要的最小接口变化：现有 `void` 无法表达取消和拒绝，也无法消除 fire-and-forget 假成功。

### 4.2 输出流状态

在 `.uina/extensions/embodiment/index.ts` 内维护单个当前 content stream 状态，不引入独立 manager：

```ts
interface CueStreamState {
  streamId: string;
  stripper: StreamingTagStripper;
  controller: AbortController;
}
```

只有一个当前 content stream 时，直接使用一个变量即可；不需要 Map、事件总线或后台任务注册表。

生命周期：

1. `output_start(content)`：
   - 若有旧状态，先 abort 并 reset；
   - 创建新 `CueStreamState`。
2. `output_update(content)`：
   - 只接受当前 `streamId`；
   - parser 提取 cue；
   - 每个 cue 通过当前 `controller.signal` 派发。
3. `output_end(content)`：
   - flush 当前 parser；
   - 派发 flush 中完整解析出的 cue；
   - abort/释放 controller；
   - 清空当前状态。
4. `output_interrupted(content)`：
   - abort controller；
   - 丢弃未闭合 parser 缓冲；
   - reset parser；
   - 清空当前状态；
   - 不派发残留半截 cue。
5. `turn_aborted`：
   - 先中断当前 cue stream；
   - 再调用 `router.stopAll()`。

### 4.3 事件顺序与流 ID

监听器必须同时注册：

```text
output_start
output_update
output_end
output_interrupted
turn_aborted
```

`output_update` 不再隐式创建一个永远存在的全局 parser。

如果收到未知 `streamId` 的 `output_update`：

- 不解析；
- 不跨流恢复；
- 可通过 `reportError` 记录一次诊断；
- 不影响当前有效 stream。

这样可以防止旧流的迟到事件污染新流。

---

## 5. 标签协议修复

### 5.1 规范格式

正式格式保持简单：

```xml
<cue id="warm_smile"/>
<cue id="warm_smile" target="live2d_mo"/>
```

协议要求：

- 必须是自闭合标签；
- `id` 必须存在；
- `id` 和 `target` 使用单引号或双引号；
- 标签属性之间允许空白；
- `id`、`target` 解析后 trim；
- 不允许把 `<cue id="x">` 当作合法 cue。

### 5.2 非法标签处理

不能出现“标签从正文消失，但动作也没有执行且没有诊断”的状态。

决策：

- Embodiment parser 只把合法自闭合标签提取为 cue；
- 非法 cue 标签不产生动作；
- 非法标签触发一次结构诊断；
- 正文清洗端使用同一条合法标签语法，只移除合法 cue；
- 不把非法开放标签静默当成合法动作。

是否保留非法标签到最终文本，需要由正文清洗策略决定，但必须满足：

```text
非法 cue != 合法动作
非法 cue != 静默丢失
```

推荐实现：非法 cue 标签从展示/TTS 正文中移除，同时记录 `invalid_cue_tag` 诊断，因为它是模型控制语法而不是用户正文；但该行为必须有测试锁定，不能由两个清洗器各自猜测。

### 5.3 归一化规则

BodyRouter 和 Live2D resolver 必须使用相同的通用 ID 归一化规则：

```text
trim
lowercase
连续空白与连字符 -> "_"
连续下划线合并
```

例如：

```text
warm_smile
Warm Smile
warm-smile
```

在路由匹配层视为同一个候选 ID。

注意：

- 归一化只处理语法形式；
- 语义别名仍由身体 affordance 声明和 Live2D resolver 管理；
- BodyRouter 不复制 Live2D 的 cue 表。

### 5.4 target 路由

有 `target` 时也必须执行完整校验：

1. target 是否存在；
2. target 是否暂停；
3. target 是否在线；
4. target affordance 是否支持该 cue 或别名；
5. 通过后才调用 `emitCue()`。

不能因为 target 是显式指定的，就跳过能力检查。

---

## 6. BodyRouter 修复

修改范围：

- `.uina/extensions/embodiment/body-router.ts`
- `.uina/extensions/embodiment/types.ts`
- `.uina/extensions/embodiment/index.ts`

### 6.1 `dispatchCue` 改为异步

目标签名：

```ts
async dispatchCue(
  cueId: string,
  target?: string,
  options?: { signal?: AbortSignal },
): Promise<CueDeliveryResult>;
```

隐式路由和显式路由共用一个候选选择路径，区别只在候选集合：

- 有 target：候选集合最多一个；
- 无 target：从非暂停、在线、支持 cue 的端点中选择主导端点，否则第一个候选。

### 6.2 不把“调用成功”当作“派发成功”

当前：

```ts
ep.emitCue(cueId);
return true;
```

目标：

```ts
return await ep.emitCue(cueId, options);
```

`emitCue()` 抛出的异常必须转成 `unknown` 或 `not_started`，不能让单个身体异常摧毁整个输出流。

### 6.3 未处理 cue 的诊断去重

保留现有“同一个未处理 cue 一次只报一次”的意图，但去重键应包含必要上下文：

```text
streamId + normalizedCueId + target
```

不应让上一轮的未知 cue 状态抑制下一轮同名 cue 的诊断。

输出流结束或中断时清除该 stream 的去重状态。

---

## 7. Live2D Endpoint 修复

修改范围：

- `.uina/worlds/live2d/runtime.ts`
- `.uina/worlds/live2d/motion-director.ts`
- 必要时 `.uina/worlds/live2d/types.ts`

### 7.1 `emitCue` 必须成为真实异步边界

执行顺序：

1. 归一化 cue ID；
2. `resolveCueToBeat()` 失败时返回 `not_started / invalid_cue`；
3. 计算需要的通道；
4. 以 `signal` 尝试 claim；
5. signal 已取消时返回 `cancelled`；
6. 通道被更高优先级动作占用时返回 `not_started / channel_busy`；
7. 成功获得 lease 后才更新 `lastCue`；
8. 启动动作；
9. 动作进入执行路径后返回 `accepted`；
10. 释放 lease。

`lastCue` 不应在动作尚未获得通道时更新。

### 7.2 不再静默吞掉 cue claim 失败

当前 catch 直接 return。

目标：

```ts
return {
  status: "not_started",
  cueId,
  bodyId: this.bodyId,
  reason: "channel_busy",
};
```

“通道忙”是正常仲裁结果，不一定需要作为用户错误打印，但必须在内部结果中可见。

### 7.3 cue 动作绑定 stream signal

`MotionDirector.dispatchCue()` 及 cue dispatcher 必须接受并传递 `AbortSignal`。

不能继续使用：

```ts
void this.cueDispatcher(cueId);
```

应改为返回 Promise，由 Endpoint/Router 决定如何处理结果。

### 7.4 处理动作抢占后的旧参数残留

cue 被新动作抢占时，只恢复**旧 cue 实际触碰的参数/通道**，不能全局清空，也不能覆盖新动作。

最小实现原则：

- 每次 expressive beat 执行前记录 touched params；
- 每个动作拥有一个 generation；
- 旧动作取消时，只有当自己仍是该参数的当前 owner，才恢复到当前 base pose；
- 新动作已经接管的参数不由旧动作清理。

禁止用一个无条件的 `dampenToNeutral()` 解决所有抢占，因为它会破坏：

- 当前基准姿态；
- 其他通道动作；
- 新 cue 的目标参数。

---

## 8. 输出中断与安全停止

### 8.1 `output_interrupted`

标签处理必须在 `output_interrupted` 上执行完整收口：

```text
abort pending cue work
reset parser
discard incomplete tag
clear stream diagnostics
```

不能调用普通 `flush()` 去执行半截控制语法。

### 8.2 `turn_aborted`

顺序固定为：

```text
abort current cue stream
stop body actions
reset body audio/motion state
```

这样可以避免“stop 先完成，旧 cue 后启动”的竞态。

### 8.3 Live2D safeStop

`safeStop()` 至少负责：

- abort 当前 expressive/cue motion；
- release 所有 channel lease；
- `audioObserver.reset()`；
- reset speech activity/acoustic impulse；
- 清理 `lastCue` 或标记其状态为 cancelled；
- 不在停止后继续接受旧 stream 的 cue。

是否向 VTS 发送最终 neutral frame 属于物理层策略，但必须明确：

- VTS 在线：可以发送一次 neutral frame；
- VTS 离线：只能标记未确认，不能声称物理已复位。

---

## 9. TTS / Markdown / Embodiment 的协议一致性

本次不把 TTS 和 Embodiment 合并成一个大模块。

两个消费者继续各自拥有自己的正文处理职责，但必须共享同一份协议事实：

- 合法 cue 的语法；
- id/target 引号规则；
- 是否要求自闭合；
- 非法标签处理策略。

由于当前扩展边界不适合让 TTS 依赖 Embodiment 实现，采用以下最小方案：

1. 在 Embodiment parser 上增加协议测试；
2. 在 TTS `cleanSentence()` 上增加同一组协议测试；
3. 两边只共享测试向量/协议约定，不引入跨扩展运行时依赖；
4. 后续若协议继续增长，再单独评估是否需要共享纯函数包。

最低一致性测试输入：

```text
<cue id="warm_smile"/>你好
<cue id='warm_smile'/>你好
<cue id="warm-smile"/>你好
<cue id=warm_smile/>你好
<cue id="warm_smile">你好
<cue id="warm_smile" target="live2d_mo"/>你好
<cue id="unknown"/>你好
```

---

## 10. 测试方案

### 10.1 必须新增或恢复入库的测试

当前 `tests/live2d-motion-core.test.ts` 被 `.gitignore` 忽略。实施时必须先解决测试归属问题：

- 关键测试不能继续被根仓库忽略；
- 如果测试属于独立 nested repository，应在其正确仓库纳入版本控制；
- 主仓库只保留主仓库能够执行且真正属于主仓库的集成测试。

禁止以“本地存在且通过”代替可提交证据。

### 10.2 TagStripper 测试

必须覆盖：

1. 完整 cue；
2. 在 `<`、`<c`、`<cu`、属性中间、`/>` 中断的跨 chunk cue；
3. `output_end` flush；
4. `output_interrupted` 后丢弃半截 cue；
5. 中断后下一 stream 不继承旧 parser 状态；
6. code block 中的 cue 不触发；
7. think block 中的 cue 不触发；
8. 多 cue 顺序保持；
9. 非法 cue 不产生动作且有诊断；
10. 普通 `<` 比较表达式不被吞掉。

### 10.3 Embodiment 生命周期测试

使用真实 `activateEmbodimentExtension()` 和 mock BodyEndpoint，验证：

1. `output_start` 创建 stream 状态；
2. `output_update` 只处理当前 stream；
3. `output_end` flush 并释放状态；
4. `output_interrupted` abort 并 reset；
5. 中断后的半截 cue 不会在下一 stream 执行；
6. turn abort 先取消 cue，再 stop body；
7. 旧 stream 的迟到 update 不影响新 stream；
8. 同一 cue 的诊断按 stream 去重。

### 10.4 BodyRouter 测试

验证：

1. 隐式路由支持规范 ID和别名；
2. 大小写/空白/连字符归一化一致；
3. target 路由不能绕过 affordance；
4. offline 返回 `not_started/body_offline`；
5. paused 返回 `not_started/body_paused`；
6. 未知 target 返回 `not_started/unknown_target`；
7. endpoint 异常转换为结果，不冒泡摧毁输出流；
8. `emitCue` 返回 `accepted` 时才清理未处理 cue 诊断。

### 10.5 Live2D Endpoint 测试

使用 fake VTS client 验证：

1. unknown cue 不更新 `lastCue`；
2. channel busy 不更新 `lastCue`；
3. signal abort 返回 `cancelled`；
4. 通过 claim 后返回 `accepted`；
5. cue 执行失败不伪造成功；
6. 新 cue 抢占旧 cue 后，旧 cue 参数不会残留；
7. safeStop 后旧 cue 不会重新启动；
8. VTS offline 不声称物理动作已完成。

### 10.6 TTS 一致性测试

必须确保：

- Embodiment 能识别的合法 cue，TTS 不朗读；
- Embodiment 不识别的非法 cue，不被 TTS 静默当成合法控制标签；
- cue 中的下划线、连字符和引号不会被 Markdown 清洗提前破坏。

---

## 11. 实施顺序

按依赖关系执行，不做跨层同时大改：

### 第 1 批：协议和 parser 生命周期

修改：

- `tag-stripper.ts`
- `embodiment/index.ts`
- 相关 Embodiment 类型

完成标准：

- `output_interrupted` 被处理；
- parser 不跨 stream；
- 半截 cue 不跨流；
- 合法/非法语法行为固定并有测试。

### 第 2 批：BodyRouter 结果语义

修改：

- `embodiment/types.ts`
- `body-router.ts`
- `embodiment/index.ts`

完成标准：

- `dispatchCue` 异步；
- target 与隐式路由校验一致；
- 归一化一致；
- 不再以 `boolean=true` 表示动作已执行。

### 第 3 批：Live2D Endpoint 和取消接线

修改：

- `live2d/runtime.ts`
- `live2d/motion-director.ts`
- 必要时 `live2d/types.ts`

完成标准：

- `emitCue` 接受 signal 并返回结果；
- claim 失败、取消、unknown cue 都可见；
- `lastCue` 只记录已接受 cue；
- turn abort 能取消待执行 cue。

### 第 4 批：动作残留与 stop 收口

修改：

- `motion-director.ts`
- `body-director.ts`
- `runtime.ts`

完成标准：

- cue 抢占不残留旧参数；
- safeStop 清理音频/动作状态；
- 不破坏 base pose 和其他通道。

### 第 5 批：测试入库和全局验证

完成：

- 恢复关键 Live2D 测试的版本控制归属；
- 增加 Embodiment/Router/Live2D 连接测试；
- `pnpm typecheck`；
- 定向测试；
- 全量测试；
- `git diff --check`；
- 单独记录 VTS 实机未验证边界。

---

## 12. 验收不变量

实现完成后必须满足：

1. 一个 `streamId` 的半截标签永远不会在另一个 `streamId` 中完成。
2. `output_interrupted` 后不会再启动该 stream 未完成的 cue。
3. 标签只在 content channel 中解析。
4. code block 和 think block 中的 cue 不触发。
5. unknown cue 不更新 `lastCue`。
6. offline/paused/busy 不返回动作成功。
7. target 路由不能绕过 affordance 检查。
8. Router 的“accepted”只表示身体接受执行，不表示物理动作已完成。
9. turn abort 后，旧 cue 不会异步复活。
10. TTS 不朗读合法 cue。
11. 普通小于号和普通文本不被误删。
12. 没有新增中央事件总线、全局 cue manager 或 Core 层概念。
13. VTS 真实物理效果仍单独标记为未验证，不能由 mock 测试代替。

---

## 13. 明确不做的事情

本次修复不做：

- 不把 cue 变成模型可见工具调用；
- 不让 cue 写入 Session 历史；
- 不增加独立 CueQueue/CueManager/CueBus；
- 不让 Host 或 Core 理解 Live2D cue；
- 不把 TTS、Embodiment、Live2D 合并为一个扩展；
- 不顺便重写 VTS 参数映射；
- 不顺便增加新 cue；
- 不改变现有 World enable/disable 语义；
- 不把离线本地模拟冒充 VTS 物理成功；
- 不用“测试通过”宣称真实 VTube Studio 已验证。

---

## 14. 最终判断

这次不应继续修补某一条正则或某一个 alias。

最小且正确的重构边界是：

```text
输出流生命周期
  owns parser state + cancellation

Embodiment
  owns extraction + routing + diagnostics

BodyEndpoint
  owns cue acceptance result

Live2D World
  owns channel arbitration + motion cancellation

VTS
  owns physical transport truth
```

只要这五个所有权边界成立，当前发现的标签问题可以在现有架构内收敛解决，不需要扩大 Core，也不需要引入新的中央协调层。
