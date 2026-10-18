# Minecraft World：模块公开接口

日期：2026-10-18（Asia/Shanghai / GMT+08:00）。状态：跨模块**类型与方法形状的唯一公开定义**（§2–§5、§7）；程序与库已移出本文（§6 只留对照表）。实现进度见 [README](README.md)。

本文只定义跨模块交换的东西：值、失败、观测、能力声明、Body、World、Executor 接入。生命周期与控制约束见 [行为契约](contracts.md)，模块内部实现见 `modules/`。Program、能力目录与库的合同分别由 [program.md](modules/program.md)、[capabilities.md](modules/capabilities.md)、[assets.md](modules/assets.md) 唯一拥有，本文不复制也不改写它们。各节由对应模块拥有，放在同一文档只为核对类型，不要求实现成一个 SDK 包或共同基类。

## 1. 读什么、谁拥有什么

Runtime 内部机制以 [Runtime 详细设计](modules/runtime.md) 为准。本文与各模块文档构成唯一公开定义；`contracts/*.ts` 是实施时的落点，允许暂时落后于本文，但不允许反过来发明新语义。

- 游戏能力是 **Callable**（声明 + 实现），Run 是调用实例，Program 是另一种被调用的东西（普通 JS 文件，不是 Callable）。Feature 只是源码组织方式，不再有 Action→Capability→Feature 转发层。
- Uina 的 `ActionDef` 仍是 minecraft façade 的接入适配，返回工具回执；游戏内部调用返回领域值，不复用工具信封与工具取消信号。
- 查询、规划、动作、细操作共用一条调用路径；身体、窗口与反馈流是有生命周期的句柄，不伪装成 JSON 目录函数。

| 开发工作 | 读什么 | 不必读 |
| --- | --- | --- |
| 新增或修改一个能力 | [capabilities.md](modules/capabilities.md) §2–§4；本文 §3（声明、装配、发现） | IPC、通知递送、存储内部 |
| 写程序、改程序库 | [program.md](modules/program.md) §2–§4；[capabilities.md](modules/capabilities.md) §7–§8 | Runtime 队列、身体仲裁 |
| 扩展客户端输入或传感 | 本文 §4；[contracts.md](contracts.md) §5、§7 | 采集与建造算法 |
| 改蓝图与经验 | [assets.md](modules/assets.md) §2–§5 | Bot、程序执行域 |
| 改 Uina 接入与执行管理 | 本文 §7；[contracts.md](contracts.md) §2–§6 | 各能力内部算法 |

下列 TypeScript 块是接口示意；`JsonValue` 只用于开放领域值，不代替运行状态、受理结果或事件结构。

<a id="values"></a>

## 2. 公共值、失败与观测

```typescript
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonSchema = Readonly<Record<string, JsonValue>>;
type ExactRef = `${string}@${string}`; // 完整非空名称@不可变版本；运行时同样校验
type Selector = string; // 确切 ref 或当前调用作用域已固定的简单名称
type Ref = string;
type Outcome = "succeeded" | "failed" | "cancelled" | "unknown" | "not_started";
interface Vec3 { x: number; y: number; z: number }
interface Place { world: Ref; worldRevision: Ref; dimension: Ref; position: Vec3 }
interface ObservationCursor { stream: Ref; epoch: Ref; sequence: number }
type FactSource = "server" | "prediction" | "history" | "derived";
interface FactBasis {
  paths: string[]; // value 内的 JSON Pointer；一组可覆盖 motion/vitals 等相关字段
  source: FactSource;
  observedAt: string;
  evidence: Ref[];
}
interface Fact<T> {
  value: T;
  observedAt: string; // UTC ISO 8601
  connection?: Ref;
  incarnation?: Ref;
  source: FactSource | "mixed";
  basis?: FactBasis[];
  coverage: "complete" | "partial";
  unknown: string[];
  evidence: Ref[];
}
interface HistoryProgress {
  stream: Ref;
  receivedThrough: number | null;
  targetThrough: number | null;
  alignment: "caught_up" | "behind" | "gapped" | "unknown";
}
interface Observation<T> extends Fact<T> {
  cursor: ObservationCursor;
  history?: HistoryProgress[];
}
interface Progress { summary?: string; [key: string]: JsonValue | undefined }
interface BlueprintRef {kind: "blueprint"; name: string}
interface ProgramOrigin { call: Ref; program: string | null; digest: string }
interface ProgramCheckpoint { kind: "program"; value: JsonValue; origin: ProgramOrigin }
interface DomainCheckpoint { kind: "domain"; schema: ExactRef; value: JsonValue; evidence: Ref[] }
type Checkpoint = ProgramCheckpoint | DomainCheckpoint;
interface DecisionRequest {
  code: "NEEDS_DECISION"; reason: string;
  checkpoint: ProgramCheckpoint | null; origin: ProgramOrigin;
}
interface CallFailureData {
  code: string; source: "program" | "capability" | "world" | "input" | "environment";
  message: string; hint?: string;
  dispatch: "not_sent" | "sent" | "unknown";
  progress?: Progress; effects: Ref[]; recoverable: boolean;
}
interface CallFailure extends Error, CallFailureData {} // recoverable 不授权重试未知副作用
interface EffectReceipt {
  effect: Ref;
  dispatch: "not_sent" | "sent" | "unknown";
  completion: "met" | "not_met" | "unknown";
  evidence: Ref[];
}
```

参数/schema 不合法在该调用派发前报 `INVALID_INPUT`；能力或程序解析不到分别报 `NOT_FOUND` / `PROGRAM_NOT_FOUND`，环境不支持报 `WRONG_STATE`（能力码见 [capabilities.md §2.6](modules/capabilities.md)，程序码见 [program.md §7](modules/program.md)）。领域不足用该能力声明的稳定 code（13 码之一）+ `hint` + 真实 `progress`；未决效果走 `dispatch: "sent"|"unknown"` 与 `unknownEffects`，不另立不确定效果的第二种终态。取消/资格失效使宿主动作失效，catch 不恢复资格。桥接把 Error 转成上述纯数据，再在脚本域还原 Error 属性；未处理普通 JS 异常记 PROGRAM_ERROR。

Observation.cursor 的完整序号作用域及 read→watch 规则只在 §5 定义；FeedbackFrame.sequence 是单条反馈流内的帧序号，RunSnapshot.revision 是单个运行记录版本，三者不能互相比较。evidence 是事实引用，不是自述；空值不能被接口形状升级成服务端确认。

Fact 不含 World 查询游标，供 Driver 的当前事实采样使用；Observation 是 World 的查询结果。mixed 必须提供 basis，覆盖所有已知的来源/观察时间不同的字段组；分组以实际判定需要为准，不给每个数字建立独立对象。混合结果的 observedAt 是本地采样时刻，各组保留实际观察时刻，不能统一刷新旧事实。unknown 表达未覆盖路径及原因，不是新的事实来源；未知数值不得填 0 或默认健康值。非 mixed 的 observedAt 为所声明来源的实际观察时刻。纯值派生仍须保留其输入依据，derived 不升级为 server。

涉及历史观察的结果必须携带 history，按本次实际依赖的选定证据 stream 列出固定进度；纯当前省略且不为此读取历史。receivedThrough 是本切面已接收/明确缺口对账的源前缀（同 §4.1 ACK 含义），不是 World R、持久 D 或 Driver stamp；无法核验为 null，不猜 0。targetThrough 只有在同一当前样本 S 已取得同 stream/采集范围的 evidenceThrough 时填写，否则为 null；纯历史不请求 Driver，targetThrough=null。没有可比较源的领域记录可 history=[]，但不能解释为已追平。

alignment 规则：没有可比较 target/接收前缀或范围无法核验为 unknown；有目标且其所需前缀存在明确缺口为 gapped（gap ref/原因进入 evidence/unknown），不能因 receivedThrough 已越过目标就称完整；无相关缺口且 receivedThrough<targetThrough 为 behind；只有本切面确实包含目标前缀的全部选定载荷且无相关 gap 才 caught_up。gapped 与落后并存时数字仍显示距离，alignment 优先 gapped。不同 stream 不比较，target=null 的旧源即使有已知 gap 仍用 unknown 表示不可对齐，缺口另保留。caught_up 仅证明本次接收范围至少覆盖目标，不表示已持久、历史恰好截至 S、游戏状态仍未变或本次动作造成效果；receivedThrough 可以大于 targetThrough。basis/source/coverage 仍独立表达原始来源、时间和知识覆盖。所有进度随 C 固定，不用 await 后的新 ACK 刷新旧 Observation；普通联合只读取已知进度，不为填字段追平/等待。

<a id="callables"></a>

## 3. 能力所有者：声明、装配、发现与内部调用

```typescript
interface CallableDescriptor {
  ref: ExactRef;
  summary: string;
  input: JsonSchema;
  output: JsonSchema;
  access: "read" | "act";
  checkpoints?: ExactRef[]; // 明确接受的续段检查点 schema；省略则不接受检查点
  completion: { scope: "execution" | "capability"; description: string };
  errors: { code: string; meaning: string }[];
  requires: string[];
  examples: { input: JsonValue; output: JsonValue }[];
  implementation: "native" | "program";
}
interface Availability { state: "available" | "unavailable" | "unknown"; reasons: string[] }
interface ResolvedCallable { descriptor: CallableDescriptor; availability: Availability; digest: string }
interface QueryDescriptor { ref: ExactRef; summary: string; input: JsonSchema; output: JsonSchema; watchable: boolean; feedback: boolean }
type DiscoveryKind = "capability" | "program" | "blueprint" | "experience";
type DiscoveryEntry =
  | {kind: "capability"; callable: boolean; descriptor: CallableDescriptor | QueryDescriptor;
     availability: Availability; digest?: string}
  | {kind: "program"; callable: true; program: ProgramDetail; completion: {scope: "execution"}}
  | {kind: "blueprint" | "experience"; callable: false; name: string;
     summary: string | null; tags: string[]; path: string};
interface SearchSummary {
  kind: DiscoveryKind; callable: boolean; name: string; ref?: string;
  summary: string | null; tags: string[]; path?: string;
  availability?: Availability["state"]; reason?: string;
  access?: "read" | "act"; watchable?: boolean; feedback?: boolean;
}
interface CallableDirectory {
  search(query: string, cursor?: string): Promise<{items: SearchSummary[]; next?: string}>;
  describe(selector: Selector | {kind: DiscoveryKind; name: string}): Promise<DiscoveryEntry>;
}

type NativeCallable<I, O> =
  | { access: "read"; descriptor: CallableDescriptor & { access: "read" }; invoke(ctx: ReadCallContext, input: I): Promise<O> }
  | { access: "act"; descriptor: CallableDescriptor & { access: "act" }; invoke(ctx: CallContext, input: I): Promise<O> };
interface ReadCallScope {
  readonly run: Ref;
  readonly segment: Ref;
  readonly callId: Ref;
  readonly signal: AbortSignal; // 运行/调用取消，绝不是 Uina 工具等待取消
  call<I, O>(ref: Selector, input: I): Promise<O>;
  progress(value: Progress): Promise<void>;
}
interface CallScope extends ReadCallScope {
  withBody<T>(work: (scope: BodyCallScope) => Promise<T>): Promise<T>;
}
interface ReadCallContext extends ReadCallScope {
  readonly world: WorldReadPort;
  readonly policy: Readonly<Record<string, JsonValue>>;
}
interface CallContext extends ReadCallContext, CallScope {
  readonly world: WorldPort;
  verify(effect: Ref, verifier: ExactRef, input: JsonValue): Promise<EffectReceipt>;
}
interface BodyCallScope extends CallContext { readonly player: BodyOps }
```

原生能力不新增 Program 的 decide/checkpoint/waitUntil 方法：需要等待用 ctx.world.watch；调用程序时可捕获或原样传播 NEEDS_DECISION。Runtime 在根未处理该请求时才交还，原生根同样适用。程序检查点和领域检查点分型，续段规则见 §7。

**装配与发现。** 原生功能模块导出 `NativeCallable[]`；组合根收集、校验同 ref 唯一及 schema，建立目录和调用包装。受控重新装配后，新环境中的新导出可被目录发现；已受理 Segment 的 native 实现代次与已解析程序字节固定不变，不热替换在途调用。新 Segment 默认继承原环境，只有明确选择 current 才绑定新装配代次。原生能力、保存 Program 与模组扩展的导出最终都经同一 descriptor/目录解析及 Callable 调用包装；实现来源保留在描述中，不各设调度器。模块正常使用 TS/包管理器组织内部依赖；目录描述、参数校验、describe 和程序签名从同一 descriptor 派生。保存程序由 Program 的元数据提供可调用发现项；其 input/output 可未声明，不能伪造完整原生 descriptor。蓝图/经验为不可调用发现项，读取带 kind；不另设 Skill/Routine 身份。组合根持有实际实现引用，目录只索引；发现为 unavailable 仍能读取原因。

search 从原生 descriptor 或文件元数据投影 SearchSummary，覆盖能力、程序、蓝图与经验；不返回完整源码/正文/schema。kind 与 callable 明示，查询能力 callable=false（使用 mc.read），动作能力和程序 callable=true（使用 mc.call）；蓝图/经验不能调用。describe 精确读取展开说明与完整可复制调用示例，程序缺契约时如实标明。文本匹配、上限和稳定排序见 Program §4.3；不执行代码、不另存第二份描述。

`call` 的正常顺序是：找到确切导出 → 校验输入/当前支持与 access → 建立子调用记录 → 继承 run、segment、策略、取消及当前上下文已获委托的身体作用域 → 直接调用实现 → 验证输出结构并记录领域结果 → 返回 O。内部调用不 submit、不建立子 Run、不重新排顶层队列。泛型方便模块类型检查，不能替代真实 schema 校验。

只读导出可以调用只读导出，不能调用 act、取得身体或写资产/领域记录，违规在派发前失败；规划就是返回有依据的计划值的 read 导出。act 不一定用身体（例如保存资产或游戏聊天），不能把“act”自动等同于身体互斥。

read 实际只获得 ReadCallContext/查询桥，宿主不为它装配写代理。除此之外，call 分派、身体/窗口/反馈写入、World 记录和资产写入口都核验宿主绑定的**当前调用身份及 access**；子调用权限为父约束与被调声明的交集，不能借父 act、捕获旧 player/仓库代理或伪造参数升级。违规报 READ_ONLY_VIOLATION。原生异步后续和脚本桥接保留调用身份；没有有效归属的业务写入拒绝。取消、关闭资源、进度与执行证据记账属于宿主管理，不被误禁为业务写。受信任原生实现直接绕开公开端口访问操作系统不在此权限合同的隔离保证内。

Runtime 唯一提供宿主绑定的真实当前调用、祖先约束、access、存活与委托关系；Driver 消费其注入的核验接缝，不由 Body Permit 或业务参数自定权限。代理入口必须先读取真实调用，不能把捕获代理 bind 回创建者的 act 上下文。原生事件回调单独绑定其 Operation 来源并重查存活；Program IPC 的调用关联由可信执行域/桥接入口解析，消息体的 callId/access 只是定位数据，不是授权。没有当前调用或来自不相关执行域的请求在实际写入前拒绝。

身体作用域采用显式 withBody，回调等待期间也保留身体；等待不续租反馈帧或持续输入。原生能力自行取得身体时应在长期等待前释放自己的作用域，借用祖先时只清理自己的操作。需要其他身体任务推进条件时，应在作用域外等待。

身体申请与委托：Runtime 为独立最外层申请排同一 FIFO，含同一 Segment 的并发 Call；Driver 只接受选定的一个 acquire 并落实交接。body.call/scope.call 显式绑定委托，子上下文普通 call 继续传播，被委托子上下文的 withBody 重入；未委托的原 mc 再申请不自动重入。上层写句柄在委托期间挂起，内层退出不释放祖先。未获得委托的外部 ctx/mc 不自动升级。当前 Body 调用谱系却用外部旧 ctx/mc 再申请独立 Body 时，派发前 CONTROL_CONFLICT，失败归当前 Call、可捕获；不因普通并发退役整段。无关兄弟只排队，不因同 Run 获得资格。任意捕获 Promise 的等待环不做通用检测，持 Body 时不得 join 需要独立身体的无关工作，应委托或先退出 Body。

回调 settle 时立即关闭该 scope 及后代的新宿主调用准入，取消并结算回调退出时仍在途的所属子调用，然后完成释放屏障，withBody 此后才 settle。退役 scope 不能通过 call/withBody 重新取得资格；窗口、反馈代理和迟到请求全部携带原 scope 身份。普通 callable 完成也关闭其调用作用域；不允许仍在途的宿主工作逃逸到下一调用；记录 closedByParent，根摘要从记录派生 interruptedChildren，不声称能判断 JS 是否 await。程序等待与原生 watch 均归当前 CallScope 清理。

这样高层采集的一次导航/装备/挖掘/拾取共用一个身体段；普通程序的相邻能力可各自释放。需要连续独占时，程序显式把它们放在一个 withBody 中。无须每个 primitive 争锁，也无须猜测任意 JS 闭包的身体生命周期。

**可选规划不新增接口层。** 例如 `build.plan@1` 返回领域计划，`build@1` 使用同一设计与参数并在执行前重验；没有规划价值的能力无需凑 plan 方法。

<a id="player"></a>

## 4. Body/Driver 所有者：取得资格、操作、窗口与反馈

```typescript
type Hand = "main" | "off";
type Key = "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak";
interface EntityRef { connection: Ref; incarnation: Ref; appearance: Ref; networkId: number }
type PointTarget = Vec3 | {position: Vec3; dimension: string};
type BlockPos = Vec3 | {position: Vec3; dimension: string}; // 坐标须为整数；没有隐式 floor
interface BlockStateValue { name: string; properties: Record<string, string> }
type BlockSpec = string | {name: string; properties?: Record<string, string>}; // 字符串约束名字；仅显式属性加入目标
interface BlockTarget { place: Place; block: Vec3 } // Driver 的完整身份；block 各分量须为整数
interface ItemSelector { name: string; components?: JsonValue; minDurability?: number; substitutions?: string[] }
interface ControlInput {
  keys: Partial<Record<Key, boolean>>;
  look?: { yaw: number; pitch: number }; // 弧度；与 lookAt 互斥
  lookAt?: PointTarget | EntityRef;
  use?: { mode: "hold" | "once"; hand: Hand };
  attack?: EntityRef;
}
interface SelfState { place: Place; velocity: Vec3; health: number; food: number; onGround: boolean }
interface ClientPhysicsStep { connection: Ref; incarnation: Ref; sequence: number }
interface FeedbackFrameRef { stream: Ref; sequence: number }
interface FeedbackFrame extends FeedbackFrameRef {
  body: Ref;
  operation: Ref; // 持续控制 Operation；Controller 不另建一层代次
  step: ClientPhysicsStep; // 本帧采样的已完成客户端物理步
  sampledAt: number; // 驱动单调时钟毫秒
  validUntil: number;
  connection: Ref;
  incarnation: Ref;
  self: Fact<SelfState>;
  sensors: Record<string, Fact<JsonValue>>;
}
interface FeedbackStream {
  next(after: number | null, signal: AbortSignal): Promise<FeedbackFrame>;
  apply(frame: FeedbackFrameRef, input: ControlInput): Promise<{ receipt: EffectReceipt; appliedStep: ClientPhysicsStep }>;
  close(): Promise<void>;
}
interface WindowSnapshot {
  window: Ref; // 本次打开身份，不是网络 windowId
  type: string;
  revision: number;
  layout: { slotCount: number; regions: { name: string; slots: number[] }[] };
  properties: Record<string, JsonValue>;
  slots: { slot: number; item: JsonValue | null }[];
  cursor: JsonValue | null;
}
interface StackExpectation { item: ItemSelector | null; count: number }
interface WindowClickReceipt extends EffectReceipt {
  confirmed?: {slots: {slot: number; item: JsonValue | null}[]; cursor?: JsonValue | null};
  needsSnapshot: boolean;
}
interface WindowSession {
  snapshot(): Promise<Fact<WindowSnapshot>>;
  click(input: {
    slot: number; button: number; mode: number; expectedRevision: number;
    expectedSlots: { slot: number; stack: StackExpectation }[];
    expectedCursor: StackExpectation;
  }): Promise<WindowClickReceipt>;
  close(): Promise<void>;
}
interface BodyOps {
  drive(input: ControlInput, ticks: number): Promise<{ receipt: EffectReceipt; actualTicks: number; end: Fact<SelfState> }>;
  dig(target: BlockTarget, options?: { aim?: "target" | "preserve" }): Promise<EffectReceipt>;
  attack(target: EntityRef): Promise<EffectReceipt>;
  useItem(hand: Hand): Promise<EffectReceipt>; // 一次激活，持续使用由 drive/feedback 的 hold 表达
  endUse(): Promise<EffectReceipt>; // 结束所属的原生使用状态，可能释放蓄力效果
  interact(input: { target: BlockTarget | EntityRef; hand: Hand; face?: Vec3; cursor?: Vec3 }): Promise<EffectReceipt>;
  equip(item: ItemSelector, hand: Hand): Promise<EffectReceipt>;
  lookAt(target: PointTarget | EntityRef): Promise<EffectReceipt>;
  openContainer(target: BlockTarget | EntityRef): Promise<WindowSession>;
  feedback(sensors: Record<string, WorldQuery>): Promise<FeedbackStream>;
}
interface BodySession extends BodyOps { close(): Promise<void> }
type ControlOwner = { kind: "run"; run: Ref; segment: Ref; callId: Ref }
  | { kind: "safety"; intervention: Ref; interruptedRun?: Ref };
interface PlayerPort {
  acquire(owner: ControlOwner, signal: AbortSignal): Promise<BodySession>;
  say(text: string, signal: AbortSignal): Promise<EffectReceipt>;
}
```

只有运行管理调用 `acquire`，能力/程序用 `withBody`；两者是同一次取得/释放的两侧，不是两个锁。Driver 为每个 BodySession 绑定行为契约中的资格、连接和资源代次；回调旧引用不能借用新主人资格。内层操作接收到已失效资源时返回 CONTROL_INVALID/REFERENCE_STALE。

独立自保介入由运行管理使用 kind=safety 的同一 acquire 入口，先完成旧控制屏障；不能另取一条 Driver 写入旁路，也不绕过 owner 急停/停用门。

统一的是写入资格和停止约束，不是操作表示。连续输入、一次性攻击/使用、挖掘或窗口状态机都可直接适配；不要求所有操作转成 Tick 输入。完整原生插件可受控独占执行，也可只复用其算法参加组合。独占期间其他无委托关系的身体写入报 CONTROL_CONFLICT；同 Body 或嵌套调用本身不构成协调授权。复合依赖由能力/程序的普通代码安排，Driver 只核验其委托、实际写入和交接，不创建每通道仲裁队列。

同一 withBody 回调提供的 scope/player，以及 Runtime 允许的 scope.call 子调用，是可核查的协调来源；已声明兼容的子操作可以在 drive/feedback 存活时重叠执行，不要求先关闭整个流。协调者只暂停冲突输出；没有委托关系的独立持续根或实际不兼容的写入仍拒绝。Adapter 用局部组合约定检查已有 Operation，不增加公开协调 token、每通道锁或动态资源调度框架。

`drive` 的 ticks 是正整数，表示实际消费本次输入的客户端物理模拟步，不是服务器 Tick 或墙钟时长，不设置任意统一小上限。正常返回 actualTicks=ticks；在第一个消费步开始计数，最后一步结束后、下一模拟前撤销本次持续键/use，视角不回滚。取消/故障可提前结束并抛带实际步数 progress、效果引用和派发程度的错误，不把短执行包装为完整成功。EffectReceipt.effect 指向的记录保留本次确切低层完成合同、实际步与证据；sent 仅表示交给本地协议层，不表示服务器已处理。

每份输入中省略的 key 为 false；省略 use 仅释放本次 drive/feedback 拥有或明确接管的使用资源（包括其 once 留下的状态），不能清除兼容子操作独立拥有的使用状态；省略 look 不改视角，省略 attack 不发攻击。hold 同一手只在状态进入时激活，重复提交维持状态，不重复原生 use；once 与 attack 在该次 drive 或该帧 apply 中各最多派发一次。once 不建立自动重复激活，不能由 Driver 为了凑“一次”再隐式 release。useItem 可能留下的原生使用状态归当前仍存活调用作用域与 Body 下的独立使用会话；激活短操作返回不结束它，endUse 或明确接管该资源的合法无 use 输入结束它，所属作用域/Body 退役时强制清理。endUse 对已结束的所属状态幂等，不重复发 release，也不能清理无委托关系的其他操作资源。

切换手或与既有使用冲突先报 CONTROL_CONFLICT，由协调者明确结束旧使用。release/close 可能产生游戏效果，亦须记账。useItem 与输入中的 once 复用同一一次激活实现，供离散调用和协调提交分别使用；未确认的消耗不自动重试。持续使用和单次协议激活的后果受物品/版本实际机制影响；“一次”不保证吃完/射出/命中。

反馈流绑定调用作用域、Body 及流 Operation；帧 ref 只是追踪数据，不授权。每流一个在算帧和一个 latest-only 待交付槽，新采样只合并待交付槽，不使仍在有效期的在算帧失效。next 交付新帧后旧帧不可提交；apply 同时核验 stream、已交付 sequence、单次消费、代次及有效期，重复/乱序拒绝。传输层重传应复用同一宿主请求，不能另造新 apply。关闭流撤销持续输入，旧输出不补播。

帧观察第 N 步完成结果；apply 正常返回表示输出已在后续 M>N 步的模拟前安装且被该步消费，返回 appliedStep。准入和实际安装时均核验 validUntil；延迟到期、取消或尚未应用则失败，不能仅入队便返回成功。异步输出不保证赶上 N+1，不追溯影响 N。Driver 使用固定上游的模拟前窄接缝，不以 physicsTick 监听器排序代替它。定长 drive 已受理后由本地完成，不要求逐帧续命。

feedback 的 self 是必有字段；额外 sensors 是“本地键 → 确切查询与参数”，逐键返回 FeedbackFrame.sensors。QueryDescriptor 在同一 describe 入口给出输入/结果 schema 及是否支持高频反馈；不支持在建流前报 SENSOR_UNAVAILABLE，当前不可观察返回带 unknown 原因的观察，不静默漏键。新增有半径/过滤条件的传感无需改运行调度或另建传感注册生命周期。

self 尚不能形成真实 SelfState 时不创建反馈流，返回 SENSOR_UNAVAILABLE 及缺口，不虚构位置/生命值。采样复用同一事实源上的纯查询实现，由组合根注入；Driver 不回调 World 的存储/异步业务查询。

反馈、drive.end 和窗口 snapshot 返回 Fact，不伪造 World 查询游标；只有 WorldReadPort.read 形成 Observation 及同点游标。额外传感虽复用同一 WorldQuery 描述，其反馈结果仍是本次快速采样事实。

interact 的 face/cursor 仅对方块有效：face 为轴向单位法向，cursor 为该方块内 [0,1] 命中点且位于指定面；无效组合派发前失败。高层 `place@1`、瞄准和物品转移是 callable，可组合这些操作，不在 Driver 内暗中采料或规划长期目标。dig/attack/interact 返回的是其已声明完成范围及原始证据，攻击尝试不等于命中/击杀。

dig 的 aim 默认 target，可调整视角；preserve 不自动瞄准，供同一协调者在移动/视角控制仍进行时挖掘，适配须检查实际目标/手持及可达条件，不能保证移动后仍可挖。该选项解决真实的视角组合缺口，不引入一般资源占用 API。attack 本身不暗中瞄准或清移动键；不满足游戏规则的主手挖掘/攻击/使用重叠仍按实际冲突报告。

窗口绑定本次打开和当前身体段。revision 覆盖全部槽位与光标；click 在驱动同一串行步骤核验版本、当前槽位/光标与调用者的 StackExpectation 后派发，不符返回 WINDOW_CHANGED。count 是精确堆叠数，item=null 要求空且 count=0；非空按 ItemSelector 的组件/耐久/替代约定匹配，不声称物品全值相等。expectedSlots 至少覆盖本次直接操作的非负槽位，数量须为非负整数；具体点击模式检查其涉及的槽位（包括自动分配/交换的潜在目标）；不能用未声明槽位的假定代替现实，校验不产生自动换槽/重试。close 幂等且只关闭自己的代次；多人仍可能在协议到达前改变现实，多次点击不构成服务端事务。合法 button/mode 按客户端版本开放，不支持在派发前失败。

click 的 confirmed 只含本次模式/前态与回执能确认的槽位后态和光标；不能把任意实时快照归因于本次点击。相关后态无法确认时 needsSnapshot=true，Program 在下一次 click 前要求显式 snapshot；已确认变化用于推进参照，其他槽位保留旧预期。

窗口另有跨 open 返回和多次 click 的会话 Operation，click 是其短子操作；打开/点击 Promise 完成不退役窗口。所属调用作用域或 Body 结束则强制退役。WindowSnapshot.revision 还覆盖类型、布局、属性及来源变化，不能直接复用服务器 stateId 或仅数 updateSlot；type/layout/properties 按该版本实际窗口提供，专用属性的确切意义由窗口/领域 schema 说明，不猜空值。

普通 close 要求光标为空且没有未结束手势，否则报 CURSOR_NOT_EMPTY/WINDOW_GESTURE_ACTIVE，不隐式丢弃或搬槽；作用域退出/停机不受此阻止，强制关闭并保存可能的协议后果、故障及未知。snapshot 纯读；主动重同步需当前窗口资格、串行派发、独立取消与故障期限。专用附魔/改名/交易选择并非现有 click 的别名；对应能力设计须在此补确切受控操作合同，经同一窗口适配执行，不向玩法公开 Bot，也不另建窗口能力目录。

<a id="client-facts"></a>

### 4.1 Driver → World：客户端事实入口

```typescript
interface ClientFactStamp {
  source: Ref;
  epoch: Ref;
  sequence: number;
  connection: Ref | null;
  incarnation: Ref | null;
}
interface ClientFactView {
  self(): Fact<SelfState | null>;
  block(target: BlockTarget): Fact<ClientBlockValue>;
  sections(targets: SectionTarget[]): Fact<ClientSectionsValue>;
  entities(): Fact<ClientEntitiesValue>;
  inventory(): Fact<ClientInventoryValue | null>;
  window(): Fact<WindowSnapshot | null>;
}
interface SectionTarget { world: Ref; worldRevision: Ref; dimension: Ref; section: Vec3 }
interface ClientBlockValue { target: BlockTarget; state: BlockStateValue | null }
interface ClientSectionValue {
  target: SectionTarget;
  revision: Ref;
  base: { palette: BlockStateValue[]; indices: (number | null)[] } | null;
  patches: { index: number; state: BlockStateValue | null }[];
}
interface ClientSectionsValue { sections: ClientSectionValue[] }
interface ClientEntityValue {
  ref: EntityRef;
  uuid: string | null;
  type: string | null;
  position: Vec3 | null;
  velocity: Vec3 | null;
  metadata: { schema: ExactRef; value: JsonValue } | null;
}
interface ClientEntitiesValue { extent: "tracked"; entities: ClientEntityValue[] }
interface ClientItemValue { name: string; count: number; components: JsonValue | null }
type ClientSlotValue = { slot: number } & (
  | { known: true; item: ClientItemValue | null }
  | { known: false; item: null }
);
interface ClientInventoryValue {
  revision: number;
  layout: { slotCount: number; regions: { name: string; slots: number[] }[] };
  slots: ClientSlotValue[];
  selectedSlot: number | null;
}
interface ClientEvidenceMark { stream: Ref; sequence: number }
interface ClientFactScope { binding: Ref; world: Ref; worldRevision: Ref; dimension: Ref | null }
interface CapturedClientFact {
  ref: Ref;
  schema: ExactRef;
  mark: ClientEvidenceMark;
  stamp: ClientFactStamp;
  scope: ClientFactScope;
  fact: Fact<JsonValue>;
}
interface ClientFactCapture<T> {
  stamp: ClientFactStamp;
  scope: ClientFactScope;
  evidenceThrough: ClientEvidenceMark;
  value: T;
}
interface ClientEvidenceAck {
  receiver: Ref;
  stream: Ref;
  durableThrough: number; // 每个序号都有已持久载荷或已持久缺口覆盖
}
type ClientFactNotice =
  | { kind: "changed"; stamp: ClientFactStamp; changed: Ref[] }
  | { kind: "reset"; stamp: ClientFactStamp; reason: "connection_changed" | "incarnation_changed" | "source_rebuilt" | "gap" }
  | { kind: "evidence"; records: CapturedClientFact[] }
  | { kind: "evidence_gap"; ref: Ref; stream: Ref; after: number; through: number | null; reason: string }
  | { kind: "evidence_end"; through: ClientEvidenceMark };
interface ClientFactsSubscription {
  stamp: ClientFactStamp;
  evidenceThrough: ClientEvidenceMark;
  acknowledge(ack: ClientEvidenceAck): void;
  close(): void;
}
interface ClientFactsPort {
  sample<T>(read: (view: ClientFactView) => T): ClientFactCapture<T>;
  subscribe(listener: (notice: ClientFactNotice) => void): ClientFactsSubscription;
}
interface ClientCaptureRequest { request: Ref; queries: Record<string, WorldQuery> }
interface ClientCaptureReply { request: Ref; capture: ClientFactCapture<Record<string, Fact<JsonValue>>> }
```

这是游戏执行侧宿主内接缝，不向脚本或跨进程发送 read 函数/活 view。sample 同步读取同一本地提交边界的只读纯值和水位，拒绝 Promise/thenable；view 在返回时失效，其方法不能逃逸后再读。结果为不可变纯数据，不能泄漏 Bot/Item/Chunk。self/inventory/window 不可用时返回 null 及 unknown，不把缺失解释为空背包/箱子。上列基础值分别是 client.block@1、client.sections@1、client.entities@1、client.inventory@1 的唯一当前载荷；基本查询复用，不另造传感目录。Block state=null 表示未知，真实空气用 minecraft:air；实体 extent 仅保证当前 tracked 集合，不证明范围外不存在。缺失实体字段/物品 components 为 null 并在 Fact.unknown 说明，不能猜 UUID、速度或组件为空。known=true/item=null 才是已知空槽，known=false 是槽位未知；layout/selectedSlot 使用该版本明确槽位含义，revision 覆盖值、来源与覆盖改变。metadata/components 的确切 schema/codec 由对应客户端适配声明并随证据保留；不能将原生对象或未知编码默认为完整可解释 JSON。空间搜索与过滤归 World/查询所有者。

subscribe 原子登记并返回当前 stamp 和选定证据头；World 先订阅再 sample，changed 仅提示复查。状态、来源、覆盖和水位先提交，再排变化通知；通知回调不能在 Driver 关键路径同步做磁盘/大查询。连接/身体环境/来源重建或不能保持通知连续性时 reset，旧当前覆盖失效。Driver stamp、证据 mark、World 接收序号、ObservationCursor、物理步及反馈序号互不替代。快照与通知不发主动游戏协议操作。

选定历史证据在原始数据被覆盖/移除前捕获为 CapturedClientFact，mark.sequence 从 1 起，只数该不可复用 stream 内的选定证据；无记录时头为 0。ref 与 mark 绑定不可变载荷，重传复用原值，不按内容相同去重。scope 是实际采集时的绑定；binding 是临时绑定代次，world/worldRevision 是持久分区，dimension 未知为 null。evidenceThrough 与 sample 的当前事实在 Driver 同一本地提交边界固定，但它只是源证据头，不表示 World 已收到/落盘，也不是纯当前 read 的等待条件。同域在该水位可见前完成证据捕获/轻量移交；跨域须对账才称收到。evidence 不得被 changed 合并或 reset 静默清除。

durableThrough 确认指定 receiver 代次已持久提交的源前缀：每个序号都有已持久载荷，或已被已持久缺口记录覆盖。缺口记录本身有稳定 ref，同身份重传不改变区间。确认可合并、重复和迟到，但同 receiver/stream 内不回退；旧 receiver 不授权新 receiver 进度。Driver 只释放被全部已登记接收方 durableThrough 覆盖的材料。acknowledge 返回仅表示本地处理 ACK，不证明另一域收到。无法重传时发 evidence_gap，区间为 (after, through]，null 表示末端未知；未知末端不得授权跨越无界后缀，须在确定封口后追加有限范围对账。封口 evidence_end 只证明源捕获结束，不证明收到/持久化。无可信封口的源保留未确认后缀；有 gap 的前缀即使已持久也不能宣称历史完整。

durable ACK 是同域部署的唯一确认层；同域共享同一份不可变材料和待落盘队列，按提交进度回收。received 层确认、重传协议与 outbox 副本不存在于当前合同——真实跨域交付出现时才按需求引入接收者代次、重传与乱序重排。选择历史范围、持久完成与缺口意义不因此削弱，也不把这条记录链变成每次当前 read 的前置条件。

跨域不运输 sample 回调。适配运输 ClientCaptureRequest/Reply、上述通知和 ACK；request 由宿主按既有查询定义生成，只执行纯客户端采样，不执行历史查询、Callable 或传入函数。纯当前 Reply 与失效元数据形成轻量有序状态检查点，World 纳入截至 stamp 的当前元数据并固定结果/cursor，再处理较新元数据；它不等待 evidenceThrough 的历史载荷/持久 ACK，大载荷路径不能堵住普通当前读。纯历史不发 ClientCaptureRequest。联合查询固定所需两侧数据；只有其定义明确要求截至当前样本的证据前缀时，才用 evidence fence 核对 F，并核验有关非 Driver 版本 G0、绑定/时间。该等待仅约束相关联合查询；缺证据重传/明确 gap，不把独立 RPC 到达当作前缀证明，不将逻辑切面称为物理原子。ClientCaptureRequest/Reply 形状不增加普通/严格模式，协议需求由查询实现确定。见 [World §6](modules/world.md)。

普通联合在接受当前检查点时固定 World 已接收的历史版本，此后新记录不使已固定结果重做；它只声称当时已接收范围。前缀联合中的 G0 只核验本次源证据对账以外的其他相关依赖；正常接收 F 以内的待到证据按 R 纳入，不作为自身并发冲突，纯落盘也不改变 G。

当前检查点的“纳入当前元数据”包括 §5 的未知范围保守覆盖，不要求等待细空间通知补齐。只有最新 stamp 而缺范围时也必须先发布相应保守失效再固定新 cursor；不能在旧空间索引上静默等待。

sections 按整数 Section 坐标读取；单格局部索引为 y*256+z*16+x（各 0..15）。值遵循唯一基础 schema client.sections@1：{ sections: [{ target, revision, base, patches }] }；base 为 null 或 { palette: [{ name, properties }], indices }，indices 为 4096 个 palette 索引或 null（未知格），properties 为字符串属性映射；patches 是按源提交排序的 { index, state }，state 为同形 Block State 或 null（覆盖失效）。Fact/basis 保留真实来源/时间/依据，revision 是不可复用只读版本，不是活 Chunk。仅区域查询固定其请求 Section；小范围 block/self/inventory 不先创建 Section 版本。服务端地形历史与区域读共用必要基底，不各建全加载区快照缓存；未被活动区域读或证据引用的预测不默认追加长期版本链。展开/编码/压缩在关键路径外，跨域不能复用仍会改写/已 detach 的 buffer。无法短边界固定某区域则明确该查询失败/部分覆盖，不影响其他当前读，也不跨 Tick 拼扫冒充同点。见 [World §7](modules/world.md)。

<a id="world"></a>

## 5. World 所有者：读取、变化订阅与领域记录

```typescript
interface WorldQuery { ref: ExactRef; input: JsonValue }
type WorldChange =
  | { kind: "changed"; cursor: ObservationCursor; changed: Ref[] }
  | { kind: "reset"; reason: "stream_changed" | "epoch_changed" | "cursor_expired"; cursor: ObservationCursor };
interface WorldWatch {
  next(after: ObservationCursor, signal: AbortSignal): Promise<WorldChange>;
  close(): Promise<void>;
}
interface DomainRecord {
  ref: Ref;
  schema: ExactRef;
  world: Ref;
  worldRevision: Ref;
  revision: number;
  value: JsonValue;
  evidence: Ref[];
}
interface WorldReadPort {
  read<T>(query: WorldQuery): Promise<Observation<T>>;
  watch(query: WorldQuery, after: ObservationCursor, signal: AbortSignal): Promise<WorldWatch>;
  readRecord(ref: Ref): Promise<DomainRecord>;
}
interface WorldPort extends WorldReadPort {
  writeRecord(change: {
    ref?: Ref; schema: ExactRef; world: Ref; worldRevision: Ref; expectedRevision: number | null;
    value: JsonValue; evidence: Ref[];
  }): Promise<DomainRecord>;
}
interface WorldEvidencePort {
  retain(owner: Ref, evidence: Ref[]): Promise<void>;
  release(owner: Ref): Promise<void>;
}
interface WorldAvailabilityValue {
  current: { state: "starting" | "ready" | "unavailable"; reason?: string };
  history: { state: "opening" | "ready" | "read_only" | "unavailable"; reason?: string };
  binding: { state: "bound" | "unbound"; binding: Ref; world: Ref; worldRevision: Ref };
}
```

查询域值由对应 QueryDescriptor 唯一声明，不由消费方猜 T。例如 `self@1` 的 input 为 `{}`、结果为 SelfState|null；`block@1` 的 input 为 BlockTarget、结果包含 `known/unknown` 与确切 Block State；`inventory@1` 返回带组件和槽位版本的当前读数；`container.last@1` 返回历史容器记录。基础客户端值复用 Driver schema；空间过滤与领域结果归相应查询所有者，完整返回结构必须随 descriptor 发布，不让消费者猜开放 JSON。目录在同一 describe 返回 query 分支；新增传感增加描述及对应采样实现，运行调度不跟着修改。这里只有数据种类是开放值，观察信封和订阅协议固定。

world.status@1 的 input={}，value 为 WorldAvailabilityValue，只读同一个 World 的运行期可用性，不等待 Driver/SQLite。current、history、binding 分别表达，不以单一 ready 掩盖降级。SQLite opening/损坏/无法打开不阻止 Driver 已就绪时的当前读/当前 Watch；可信运行期绑定继续使用，否则临时 unbound 分区，结果 unknown 明示持久身份未确认，不从地址推断。历史不可读报 STORE_UNAVAILABLE；只有 query 明确支持且实际可核验的 RAM/只读范围才可 partial，不能把数据库坏了当空历史。history 非可写 ready 时 writeRecord/retain 拒绝 STORE_UNAVAILABLE，不报告 durable 成功。只读历史可用不代表能创建持久引用。存储恢复重新核验身份与连续性，不自动合并 unbound 历史或复活旧历史 cursor。

read 只固定该查询实际依赖的不可变值、版本与有关 cursor：纯当前用绑定/当前样本/失效水位，同步完成，不读 DB、不等历史；纯历史走提交屏障（先等已接收上界持久化，再在**同一读取边界**取得数据与提交版本并以该版本作 cursor，见 World §6.2），不采 Driver、不默认追平源头、不静默遗漏查询开始前已接收的证据；已读到的提交不会被再次通知。历史存储处于 opening 时历史读明确 STORE_UNAVAILABLE（当前读不受影响）；status 的 history 分别报 opening/ready/unavailable。联合查询固定所需两侧，只有定义承诺截至样本的历史前缀时才加证据 fence。它们使用同一接口/查询声明，不增加普通/严格模式。异步仅读固定切面，tail 后续落盘不改变结果，不移动/转头/开箱。当前绑定改变则相关查询 SNAPSHOT_INVALIDATED，显式旧分区历史可完整返回。历史分页 token 固定同版本，与 watch cursor 区分，无法继续则报 SNAPSHOT_EXPIRED。stream 绑定世界/代次/维度、确切查询、规范化参数及实际来源谱系；相关源重建/计数重置才换 epoch。单一依赖流的 sequence 分别为当前源失效事件序或历史读取提交版本，两者不可比。合法混合查询的 cursor 仍由 World 拥有：内部固定依赖向量/到期边界，对外 sequence 是该查询流自己的失效序，不能用 current/history 的 max 或和来伪造；缺少内部映射就 reset。当前实现仅支持单类别，混合支持须由 World 补齐，对应条件在支持检查时明确不可用。只在同 stream+epoch 内比较，Runtime 不拆 cursor，也不让无关提交成为当前读取前提。跨域保留各源实际时间，不承诺物理同时原子。

调用顺序固定：`read` → 原样交出 `cursor` → `watch(query, cursor)` → `next(cursor)`。同一 epoch 内 `next` 不丢唤醒：登记后先复查一次再挂起；`reset`/`epoch_changed` 让旧 cursor 作废，按 `world@1` 的 `history` 状态重读。changed 可合并，只提示复查，不承诺穷举中间变化；要逐事件历史就读对应事件记录。取消 `next` 只取消本次等待，`close` 关闭订阅，资源随所属调用/作用域回收。

`waitUntil` 的签名与结果由 [program.md §2.4、§7](modules/program.md) 定义。targets 是非空 `{key:{ref,input?}}`，predicate 留在 guest；每个 target 的 version 独立回传，不能合成全局水位。timeoutMs 缺省无限等待；非法期限或 version=null 的查询在建立 watch 前拒绝。支持观察游标看 watchable，支持高频反馈看 feedback，两者独立。

`writeRecord` 只供绑定领域所有者的 `CallContext`：World 从真实当前调用核验存活、act/schema 所有权、分区与 CAS revision；`expectedRevision=null` 仅创建，不符报 `RECORD_CHANGED`。`WorldEvidencePort` 只注入实际持有跨库强引用的记录所有者（Runtime 等），不属于脚本或普通能力写口：`retain` 幂等追加，成功前保证传递依赖与保留关系已提交；删除前复核引用与保护，失败报 `EVIDENCE_UNAVAILABLE`。

World 内部算法（当前/历史切面、失效水位、保留闭包、SQLite Worker）只在 [world.md §6/§9/§10](modules/world.md)，这里不复制。

<a id="programs"></a>

## 6. Program 与 Library：导航

程序模型、文件头、API、逻辑段与共享 worker、容量和退役的唯一规格在 [program.md](modules/program.md)。库操作与蓝图/经验见 [Library](modules/assets.md)，能力签名见 [能力面](modules/capabilities.md)。程序不持有库写对象，文本操作使用 library 工具；蓝图由领域能力解释。

旧接口的映射只保留在 [变更历史](changelog.md)，这里不维护兼容别名或第二份完整类型。WorldEvidencePort.retain/release 仍供 Runtime 保护自己记录所需的 World 强引用，与文件库保存无关。

<a id="executor"></a>

## 7. Uina ↔ Executor：确定的受理、查询、结果与事件

> **程序入口（2026-10-18）**：程序以 `{ kind: "program"; source: SourceRequest; input }` 提交，`source` 是 `{name}` 或 `{code}`；Runtime 受理时把它解析成确切字节（快照与头注释见 [program.md §3](modules/program.md)）。执行端口不在本文（见 §6 对照表）：段记录只记程序的名字/来源/摘要/快照，不记源码。

```typescript
interface Origin { worldOwner: Ref; activation: Ref; caller?: Ref; invocation?: Ref }
// SourceRequest 引用 Program §7
type Entry = { kind: "call"; selector: Selector; input: JsonValue }
  | { kind: "program"; source: SourceRequest; input: JsonValue };
type Schedule = { kind: "enqueue" }
  | { kind: "replace_pending"; targets?: Ref[] }
  | { kind: "preempt_current"; expectedRun: Ref };
interface RunRequest { requestId: Ref; entry: Entry; policy: Record<string, JsonValue>; schedule: Schedule }
interface RunBase {
  run: Ref; rootRequestId: Ref; revision: number; segment: Ref | null;
  completion: CallableDescriptor["completion"]; // 当前段入口范围；随报告固定，不认证历史目标
  progress: Progress; // 当前段根调用的最后报告；历史量在各段/领域对象中保留
  control: "none" | "active" | "stopping" | "stopped" | "unknown";
  unknownEffects: Ref[]; record: Ref;
}
// waiting 只描述"在等什么"，不承诺何时结束；不设墙钟超时
type WaitState =
  | { kind: "host_call"; method: string; sinceMs: number }         // 在等一个宿主 RPC（查询/动作/睡眠）
  | { kind: "world_change"; targets: ExactRef[]; sinceMs: number } // 在等观察版本变化
  | { kind: "sleep"; sinceMs: number }
  | { kind: "idle"; sinceMs: number }                              // 没有在途宿主请求，guest 卡在自己的 Promise 上
type RunSnapshot = RunBase & (
  | { phase: "queued" | "running" | "stopping" }
  | { phase: "waiting"; waiting: WaitState }
  | { phase: "awaiting_decision"; decision: Ref; reason: string; checkpoint: Checkpoint | null; request?: DecisionRequest; completionRef: Ref }
  | { phase: "finished"; outcome: Outcome; value?: JsonValue; error?: { code: string; message: string }; completionRef: Ref; interruptedChildren?: Ref[] }
);
type Acceptance = { kind: "accepted"; requestId: Ref; segment: Ref; snapshot: RunSnapshot }
  | { kind: "unknown"; requestId: Ref; reason: string }
  | { kind: "not_accepted"; requestId: Ref; code: string; message: string };
type SubmissionLookup = { kind: "found"; requestId: Ref; operation: "submit" | "continue"; segment: Ref; snapshot: RunSnapshot; completionRef?: Ref }
  | { kind: "not_found"; requestId: Ref }
  | { kind: "unavailable"; reason: string };
type CompletionSnapshot = Extract<RunSnapshot, { phase: "finished" | "awaiting_decision" }>;
type CompletionReport =
  | { reportKind: "terminal"; snapshot: Extract<RunSnapshot, { phase: "finished" }> }
  | { reportKind: "decision"; snapshot: Extract<RunSnapshot, { phase: "awaiting_decision" }> };
type RunReply = Acceptance
  | ({ kind: "result"; requestId: Ref; segment: Ref; completionRef: Ref } & CompletionReport);
type Delivery = {
  completionRef: Ref; requestId: Ref; run: Ref; segment: Ref;
  revision: number;
} & CompletionReport;
type DeliveryDisposition = "pending" | "tool_handoff" | "input_committed";
interface DeliveryState {
  delivery: Delivery; disposition: DeliveryDisposition;
  eligible: boolean; // 从当前 decision/Run 状态派生，不改历史正文
}
type DeliveryReceipt = { kind: "tool_handoff"; requestId: Ref }
  | { kind: "input_committed"; inputId: Ref };
interface StopReceipt {
  requestId: Ref;
  intent: "durable" | "unknown";
  control: "stopping" | "stopped" | "unknown"; // 当前内存控制事实，不宣称持久
  snapshot: RunSnapshot | null;
  error?: { code: string; message: string };
}
type OwnerGate = "disabled" | "emergency" | "owner_lost";
interface OwnerState { attachment: Ref; gates: OwnerGate[]; gateRevision: number; validForMs: number }
interface OwnerGateReceipt {
  requestId: Ref; state: OwnerState; persistence: "confirmed" | "unknown";
  control: "stopping" | "stopped" | "unknown"; error?: string;
}
type ContinuedEntry = { kind: "call"; ref: ExactRef; input: JsonValue }
  | { kind: "program"; source: SourceRequest; input: JsonValue }
// 段入口：Runtime 在受理时把 SourceRequest 解析成确切字节
type SegmentEntry =
  | { kind: "native"; descriptor: CallableDescriptor; digest: string }
  | { kind: "program"; name: string | null; origin: "library" | "code"; digest: string; snapshot: Ref };
interface SegmentRecord {
  run: Ref; segment: Ref; revision: number; record: Ref; entry: SegmentEntry; input: JsonValue;
  environment?: { serverVersion: string; protocol: number };
  checkpoint: Checkpoint | null; value?: JsonValue; interruptedChildren?: Ref[]; evidence: Ref[];
}
interface CallRecord {
  call: Ref; run: Ref; segment: Ref; parent: Ref | null; record: Ref;
  ref: Ref; // 原生与子调用为 ExactRef；程序调用为 <name> 或 code:<digest 前 8 位>
  implementation: "native" | "program"; digest: string;
  access: "read" | "act"; input: JsonValue;
  execution: "running" | "returned" | "threw" | "interrupted";
  completion: CallableDescriptor["completion"];
  outcome?: Outcome; value?: JsonValue;
  closedByParent?: {call: Ref; reason: "returned" | "threw" | "decision" | "cancelled"};
  decisionRequest?: DecisionRequest;
  error?: { code: string; message: string; source: string; dispatch: "not_sent" | "sent" | "unknown"; effects: Ref[]; hint?: string };
  progress: Progress; effects: Ref[]; evidence: Ref[];
}
interface EffectVerification {
  record: Ref; observedAt: string; verifier: ExactRef;
  completion: "met" | "not_met" | "unknown"; evidence: Ref[]; reason?: string;
}
interface EffectRecord {
  effect: Ref; call: Ref; operation: Ref; run: Ref; segment: Ref; record: Ref;
  facts: DriverExecutionFact[]; verifications: EffectVerification[];
  latest: EffectReceipt; // 本截面的最新判断，不改写原 completion
}
interface ExecutorClient {
  attach(origin: Origin): Promise<OwnerState>;
  heartbeat(attachment: Ref): Promise<OwnerState>;
  setOwnerGate(request: { requestId: Ref; attachment: Ref; gate: OwnerGate; closed: boolean; expectedRevision?: number }): Promise<OwnerGateReceipt>;
  submit(origin: Origin, request: RunRequest, waitSignal?: AbortSignal): Promise<RunReply>;
  lookup(requestId: Ref): Promise<SubmissionLookup>;
  read(run: Ref): Promise<RunSnapshot>;
  readSegment(run: Ref, segment: Ref): Promise<SegmentRecord>;
  readCall(call: Ref): Promise<CallRecord>;
  readEffect(effect: Ref): Promise<EffectRecord>;
  listCalls(run: Ref, filter: { parent?: Ref; cursor?: string }): Promise<{ items: CallRecord[]; next?: string }>;
  list(filter: { activeOnly: boolean; cursor?: string }): Promise<{ items: RunSnapshot[]; next?: string }>;
  wait(run: Ref, afterRevision: number, signal: AbortSignal): Promise<RunSnapshot>;
  stop(run: Ref, requestId: Ref): Promise<StopReceipt>;
  continue(request: { run: Ref; decision: Ref; requestId: Ref; entry: ContinuedEntry; environment?: "inherit" | "current" }, waitSignal?: AbortSignal): Promise<RunReply>;
  pendingDeliveries(): Promise<Delivery[]>;
  readDelivery(completionRef: Ref): Promise<DeliveryState>;
  settleDelivery(completionRef: Ref, receipt: DeliveryReceipt): Promise<void>;
  events(listener: (event: { kind: "run_changed"; run: Ref; revision: number; completionRef?: Ref }) => void): () => void;
}

```

façade 的临时代码只需 code + input：Runtime 把它解析成与具名程序相同的东西——确切源码字节、摘要与段内快照，然后走同一条调用路径。临时代码没有额外特权，也不跳静态校验（program.md §3.4）。

SegmentRecord 是运行所有者固定的一次只读截面：`entry` 保存该段实际执行的来源（原生 descriptor 与摘要，或程序名/来源/摘要与快照引用），`digest` 是该段实际运行字节的摘要。活段 evidence 可增长，但同一次 readSegment 不混合前后截面；readSegment 不承诺持久保留，也不建立 GC 保护。源码与头注释只属于 Program，Executor 不解析源码。

CallRecord 用于实际调用树、失败与 effects 的展开，不允许调用方直接写入或修改结论。SegmentRecord.record 与 CallRecord.record 始终是已提交不可变截面；活跃调用的后续进度产生新截面，不原地修改旧 record。

以上请求 ID 是内部协议字段。模型 façade 的 run/continue/stop/library 参数不含需自造的 ID；接入为新工作在任何 IPC 前持久建立 requestId，后续本次传输重试/查询复用。模型得到系统返回的 request/run 后可以查询或恢复旧请求；再次普通 run 是新意图，不能用参数相同自动合并。invocation 仅审计关联，不承担持久唯一性。

停止是例外：接入先生成 ID 并立即发送 stop/关闭 owner 门，不因本地持久失败阻止停机；持久受理承诺以执行侧 intent=durable 为准。StopReceipt 分开返回控制快照及停止意图持久性，snapshot=null 表示尚未取得执行侧事实。lookup 仅查询 submit/continue 映射；停止重试同 ID 返回/补齐 StopReceipt，不拿运行 phase 冒充停止意图已落盘。

attach 为该客户端绑定可信 owner/activation，heartbeat 续有效期，失联门按行为契约自动关闭；后续调用核验绑定。setOwnerGate 关闭 disabled/emergency 时立即撤销准入并停止所属运行，再报告持久性；关闭门不受 CAS 冲突阻止。解除门要求当前 attachment、expectedRevision 精确匹配及显式意图，失败不放开动作；解除一个门不解除其他门，不复活旧运行。World 停用、具身 safeStop/resume 分别调用这些公开方法，不能只循环 stop 当前 run。

continue 不再使用含义过宽的 rebind 标志：call 入口必须给确切 ref，新代码也须显式给出，因此代码/能力换版本身就是明确选择；environment 默认 inherit，只有显式 current 才换当前原生环境。新段先核验输入/检查点与新入口的兼容性，再消费 decision；同名裸 selector 不在续段内部重新解析。新代码可沿用原生环境，动态确切调用按其自身规则检查，旧段绑定/证据不变。

submit/continue 先完成 Runtime 持久受理，再在同一次客户端调用的短等待窗口内读到已提交 finished/awaiting_decision 时返回 RunReply.result，超时返回 accepted，unknown 先 lookup。waitSignal 只解除本次窗口等待、令调用返回 accepted/当前已知事实，不撤销 Run。CompletionReport 是唯一执行报告联合：reportKind=terminal 只能配 finished，reportKind=decision 只能配 awaiting_decision；completionRef/result 并不意味着整个 Run 已终结。finished outcome/value 是真实合同结论，decision 没有最终 outcome。同一段最多一份 decision 报告，同一 Run 最多一份 terminal 报告；待决策 Run 被 stop 可另生 terminal，旧 decision 不改。lookup.completionRef 是该 request 所受理段第一次封口的报告引用，不取 Run 最新续段报告；未有报告时省略。窗口从受理确认起算，时长由接入配置，不影响 Run 寿命。显式 wait 只等待 revision 变化；短等待循环 read/wait 至本次提交报告或窗口关闭，不能把一次 progress 当完成。list/read 只允许所绑定 owner，signal/期限只取消等待。

events 只是变更提示，断流后从 read/list/pendingDeliveries 补读。completion 与固定报告在段交还/Run 终结事务中持久。短窗口直返前 settleDelivery(tool_handoff)，成功后抑制后台通知；此状态不证明 Host 已记录结果。tool_handoff 后、响应返回前崩溃可能漏通知，不自动补报，按原 requestId/run 查询恢复事实。标记失败可返回已提交报告，但保留 pending，可能重复通知。

pendingDeliveries 只枚举 disposition=pending 且 eligible 的项；工具等待取消解除本地暂缓，不停止 Run。后台递送失败退避重试，input_settled.committed 后才凭可信 attempt inputId→completionRef 映射 settleDelivery(input_committed)。ACK 丢失可能重复呈现同报告，不重放游戏动作。两类 receipt 均核验 owner/原请求或实际 attempt；settleDelivery 幂等，只记录渠道处置，不改报告。tool_handoff 和 input_committed 均不正常重投，不建交接补报状态。

普通 read/wait 不消费通知。emitEvent 和 deferred render 前通过 readDelivery 复查 eligibility：过时 decision 返回 null；查询不可用保留 pending 重试；render 不写 ACK。检查与 Host append 不原子，最后竞态可能呈现历史；continue 仍以 DECISION_STALE 拒绝重复消费。同一 Executor 串行协调短窗口和后台 drain，不建跨库租约。算法见 [Runtime 结果交付](modules/runtime.md#delivery)。

容量不是 Executor 的公开方法：`runs` 的状态里给 `waiting` 与域/guest 计数（program.md §5.2、§5.3）。一次容量读数是带 observedAt 的观察，不承诺与持久 Run 快照原子，也不能当资源预留。

### 7.1 可信组合根注入

只服务 Runtime / Driver / 组合根的本地合同，不接受模型 JSON 注入；函数是可信本地实现，不跨执行域传输。程序的执行端口不在本文：`ProgramPort` / `ProgramCapacity` 见 [program.md §7](modules/program.md)。

```typescript
interface CheckpointSchemaDefinition { ref: ExactRef; value: JsonSchema }
interface DriverExecutionFact {
  effect: Ref; operation: Ref; contract: ExactRef; observedAt: string;
  kind: "dispatch" | "receipt" | "cleanup";
  dispatch: "not_sent" | "sent" | "unknown";
  completion: "met" | "not_met" | "unknown"; evidence: Ref[];
  detail?: JsonValue; // 操作声明的原始回执/缺口，不是 guest 自述
}
interface RecordTicket { instance: Ref; sequence: number }
interface DriverExecutionSink { record(fact: DriverExecutionFact): RecordTicket | null }
interface RuntimeRecordBarrier {
  capture(): RecordTicket;                  // 无事实时为该实例 sequence=0，不是未知回退值
  flushThrough(through: RecordTicket): Promise<void>;
}
```

DomainCheckpoint 的 schema 由领域模块普通导出，组合根校验同 ref 唯一；descriptor.checkpoints 只声明可消费的领域 schema，不声明则不接收领域检查点。ProgramCheckpoint 不进入这个注册表；续段根程序只读 value，来源在记录中保留，子程序须显式传参。两类不隐式转换；原生入口不能因程序 checkpoint 而跳过自己的输入/领域验证。能力在自身实现中核验目标；Runtime 不注入通用目标 verifier。`ctx.verify` 只调用 effect 原要求指定的领域核验者并追加效果判断。

DriverExecutionSink 由 Runtime 注入并绑定可信创建来源：`record` 同步接收不可变事实、非阻塞入队，返回本 writer 实例的 ticket，不代表持久或服务端 ACK；无法接收时返回 null、锁存 recorder fault 并封闭新副作用，Driver 的撤销/清理不等磁盘。`RuntimeRecordBarrier.capture` 固定已收到前缀 H，`flushThrough(H)` 保证 ≤H 材料已提交，否则明确失败；材料丢失的故障不得返回成功。ticket 不跨实例或重启比较，H 之后的材料不纳入原终结。Driver 关闭 Promise 完成前，已产生的清理派发与可得回执必须先入 sink；未来回执可晚到并追加核验。完整结算见 [Runtime 详细设计](modules/runtime.md)。

## 8. 模块独立验证的最小要求

| 所有者 | 用公开合同验证，避免测试内部结构 |
| --- | --- |
| Callable/Program | 同输入经直接调用、程序内 call、保存程序调用返回同领域值；嵌套不二次 submit；read 视图无写口且捕获旧写代理仍被拒绝；progress 不升级为效果证据 |
| Runtime/Body | 独立 Body 分支 FIFO、委托复用、自等待局部失败；回调等待保持身体、退出释放；旧 scope/window/反馈不可复活；Effect 屏障先于终结 |
| Driver | 输入/点击参数、版本及预期槽位/光标物品、帧代次/新鲜度与停止屏障；真实服务端另验效果，mock 不替代 |
| World | read/游标同一点、读/订阅交界不漏唤醒、换源/重连/旧游标返回 reset；schema/CAS/证据写入受唯一所有者约束 |
| Library | 三类条目的命名/目录/路径安全；蓝图 Raw/Target/Project 与 AirPolicy；经验弱链接；明文错误；蓝图不携带现场进度 |
| Uina/Executor | ID 持久化后 IPC；短任务真实直返、长任务通知；tool_handoff 非 canonical ACK；过滤过时 decision；故障同引用重复/缺口不重放游戏 |

这些是接口实现的验收要求，尚未执行的项目不能写成通过。解析/存储类、SQL 表、插件内部算法、完整原版函数目录及延迟常数由模块设计和实验决定；它们不应阻挡另一模块基于以上公开合同开发。
