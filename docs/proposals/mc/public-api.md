# Minecraft World：模块公开接口草案

日期：2026-10-17（Asia/Shanghai / GMT+08:00）。状态：统一设计合同；各模块实现进度不同，本轮仅修订文档，未进行真实游戏验收。

本文与 §6.3 明确链接的 Library 合同是模块之间**方法、值与错误形状的唯一设计来源**；生命周期、控制和一致性约束见 [行为契约](contracts.md)。各节由对应模块拥有，放在同一文档是为了核对类型，不要求实现成一个 SDK 包或共同基类。具体玩法的参数/结果 schema 归该能力定义，不在这里复制完整原版目录。

## 1. 收敛后的概念与阅读范围

Runtime 内部机制以 [Runtime / Callable 详细设计](modules/runtime.md) 为准。本文与明确链接的 Library 合同构成唯一公开定义；2026-10-17 本轮只更新设计，`contracts/*.ts` 尚须实施时同步，不代表现有类型已符合终态。

- 游戏能力是一个 **Callable（可调用导出）**；Run 是调用实例；Program 是实现方式之一。Feature 只是组织有关实现的源码模块，不再增加 Action→Capability→Feature 的转发层。
- Uina 的 `ActionDef` 仍是 minecraft façade 的接入适配，返回工具回执。游戏内部 `call` 返回领域值，不能复用它的工具信封和工具取消信号。
- 查询、规划、成熟动作、细操作和保存程序使用同一声明/调用机制。取得身体、等待和反馈闭包是少量有生命周期的宿主操作，不伪装成 JSON 目录函数。

| 开发工作 | 必读公开合同 | 不必为此通读的实现 |
| --- | --- | --- |
| 增加采集/制作/战斗方法 | §2–3、所用的 §4–5、该玩法 schema；行为契约 §5–6 | IPC、通知递送、SQLite、其他玩法内部 |
| 编写/保存新程序 | §3 的 call、§6；所用能力 describe；需要精细控制时读 §4 | 运行队列、插件装配、资产存储内部 |
| 扩展客户端输入/传感 | §4–5；行为契约 §5/7 | 采集算法、程序修订/检索 |
| 修改程序库 | §6；行为契约 §8 | Bot、身体仲裁、Uina 日志 |
| 修改 Uina 接入/执行管理 | §7；行为契约 §2–6 | 各玩法算法 |

下列 TypeScript 块是接口示意，Library 类型按 §6.3 链接导入；实施时以同一套源码合同进行类型检查；`JsonValue` 只出现在开放领域值/源码合同处，不再代替运行状态、受理结果或事件结构。

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
interface Progress {
  summary: string;
  measures: { name: string; value: number; unit: string; evidence: Ref[] }[];
}
interface Checkpoint { schema: ExactRef; value: JsonValue; evidence: Ref[] }
interface CallFailure extends Error {
  code: string;
  dispatch: "not_sent" | "sent" | "unknown";
  progress?: Progress;
  effects: Ref[];
  recoverable: boolean; // 不授权重试未确认副作用
}
interface EffectReceipt {
  effect: Ref;
  dispatch: "not_sent" | "sent" | "unknown";
  completion: "met" | "not_met" | "unknown";
  evidence: Ref[];
}
```

参数/schema 不合法在该调用派发前报 `INVALID_ARGUMENT`；实现不存在/当前环境不支持报 `CALL_UNAVAILABLE` 并说明确切 ref 和原因。领域不足用模块定义的稳定 code（如 TARGET_NOT_MET）及真实 progress；未知效果用 EFFECT_UNCERTAIN。取消/资格失效使宿主动作失效，catch 不恢复资格。桥接把 Error 转成上述纯数据，再在脚本域还原 Error 属性；未处理普通 JS 异常记 PROGRAM_ERROR。

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
  completion: { scope: "execution" | "capability" | "goal"; description: string; verifier?: ExactRef };
  errors: { code: string; meaning: string }[];
  requires: string[];
  examples: { input: JsonValue; output: JsonValue }[];
  implementation: "native" | "program";
}
interface Availability { state: "available" | "unavailable" | "unknown"; reasons: string[] }
interface ResolvedCallable { descriptor: CallableDescriptor; availability: Availability; digest: string }
interface QueryDescriptor { ref: ExactRef; summary: string; input: JsonSchema; output: JsonSchema; feedback: boolean }
type DiscoveryEntry = ({ kind: "callable" } & ResolvedCallable)
  | { kind: "query"; descriptor: QueryDescriptor; availability: Availability };
interface SearchSummary {
  kind: "callable" | "query";
  ref: ExactRef;
  summary: string;
  availability: Availability["state"];
  reason?: string;
  access?: "read" | "act";
  feedback?: boolean;
}
interface CallableDirectory {
  search(query: string, cursor?: string): Promise<{ items: SearchSummary[]; next?: string }>;
  describe(selector: Selector): Promise<DiscoveryEntry>;
}
type NativeCallable<I, O> =
  | { access: "read"; descriptor: CallableDescriptor & { access: "read" }; invoke(ctx: ReadCallContext, input: I): Promise<O> }
  | { access: "act"; descriptor: CallableDescriptor & { access: "act" }; invoke(ctx: CallContext, input: I): Promise<O> };
interface ReadCallScope {
  readonly run: Ref;
  readonly segment: Ref;
  readonly callId: Ref;
  readonly signal: AbortSignal; // 运行/调用取消，绝不是 Uina 工具等待取消
  readonly checkpoint: Checkpoint | null;
  call<I, O>(ref: Selector, input: I): Promise<O>;
  wait(request: WaitRequest): Promise<WaitResult>;
  waitForChange(targets: readonly ChangeWaitTarget[], options?: { afterMs?: number }): Promise<ChangeWaitResult>;
  decide(reason: string, checkpoint: Checkpoint): Promise<never>;
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

**装配不是另一套框架。** 原生功能模块导出 `NativeCallable[]`；组合根收集、校验同 ref 唯一及 schema，建立目录和调用包装。受控重新装配后，新环境中的新导出可被目录发现；已受理 Segment 的 nativeEnvironment、descriptor digest 和 bindings 固定不变，不热替换在途调用。新 Segment 默认继承原环境，只有明确选择 current 才绑定新装配代次。原生能力、保存 Program 与模组扩展的导出最终都经同一 descriptor/目录解析及 Callable 调用包装；实现来源保留在描述中，不各设调度器。模块正常使用 TS/包管理器组织内部依赖；目录描述、参数校验、describe 和程序签名从同一 descriptor 派生。保存程序由资产所有者提供同形描述及源码入口，不再注册第二种 Skill/Routine 身份。组合根持有实际实现引用，目录只索引；发现为 unavailable 仍能读取原因。

search 只从同一 descriptor 投影 SearchSummary，不带输入/输出 schema、错误、示例及完整支持说明；reason 仅作简短不可用原因，describe 才展开全部 reasons。摘要不是另一份注册数据，搜索也不执行能力。

`call` 的正常顺序是：找到确切导出 → 校验输入/当前支持与 access → 建立子调用记录 → 继承 run、segment、策略、取消及当前身体作用域 → 直接调用实现 → 验证输出结构并记录领域结果 → 返回 O。内部调用不 submit、不建立子 Run、不重新排顶层队列。泛型方便模块类型检查，不能替代真实 schema 校验。

只读导出可以调用只读导出，不能调用 act、取得身体或写资产/领域记录，违规在派发前失败；规划就是返回有依据的计划值的 read 导出。act 不一定用身体（例如保存资产或游戏聊天），不能把“act”自动等同于身体互斥。

read 实际只获得 ReadCallContext/ReadProgramAPI，宿主不为它装配写代理。除此之外，call 分派、身体/窗口/反馈写入、World 记录和资产写入口都核验宿主绑定的**当前调用身份及 access**；子调用权限为父约束与被调声明的交集，不能借父 act、捕获旧 player/仓库代理或伪造参数升级。违规报 READ_ONLY_VIOLATION。原生异步后续和脚本桥接保留调用身份；没有有效归属的业务写入拒绝。取消、关闭资源、进度与执行证据记账属于宿主管理，不被误禁为业务写。受信任原生实现直接绕开公开端口访问操作系统不在此权限合同的隔离保证内。

Runtime 唯一提供宿主绑定的真实当前调用、祖先约束、access、存活与委托关系；Driver 消费其注入的核验接缝，不由 Body Permit 或业务参数自定权限。代理入口必须先读取真实调用，不能把捕获代理 bind 回创建者的 act 上下文。原生事件回调单独绑定其 Operation 来源并重查存活；Program IPC 的调用关联由可信执行域/桥接入口解析，消息体的 callId/access 只是定位数据，不是授权。没有当前调用或来自不相关执行域的请求在实际写入前拒绝。

身体作用域采用显式 withBody：Runtime 为独立最外层申请排同一 FIFO，含同一 Segment 的并发 Call；Driver 只接受选定的一个 acquire 并落实交接。嵌套 scope.withBody 及 scope.call/body.call 明确委托复用资格，内层退出不释放祖先。当前 Body 调用谱系却用外部旧 ctx/mc 再申请独立 Body 时，派发前 CONTROL_CONFLICT，失败归当前 Call、可捕获；不因普通并发退役整段。无关兄弟只排队，不因同 Run 获得资格。任意捕获 Promise 的等待环不做通用检测，持 Body 时不得 join 需要独立身体的无关工作，应委托或先退出 Body。

回调 settle 时立即关闭该 scope 及后代的新宿主调用准入，取消并结算未 await 的所属子调用，然后完成释放屏障，withBody 此后才 settle。退役 scope 不能通过 call/withBody 重新取得资格；窗口、反馈代理和迟到请求全部携带原 scope 身份。普通 callable 完成也关闭其调用作用域；不允许逃逸的未等待宿主工作悄悄跨到下一调用。原生与程序的 wait 委托同一个 CallScope 入口，适用相同的身体边界与恢复规则。

这样高层采集的一次导航/装备/挖掘/拾取共用一个身体段；普通程序的相邻能力可各自释放。需要连续独占时，程序显式把它们放在一个 withBody 中。无须每个 primitive 争锁，也无须猜测任意 JS 闭包的身体生命周期。

**可选规划不新增接口层。** 例如 `construction.plan@2` 返回该模块拥有的 Plan 类型，`construction.build@4` 接收其引用并在执行前重验；没有规划价值的能力无需凑 plan 方法。

<a id="player"></a>

## 4. Body/Driver 所有者：取得资格、操作、窗口与反馈

```typescript
type Hand = "main" | "off";
type Key = "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak";
interface EntityRef { connection: Ref; incarnation: Ref; appearance: Ref; networkId: number }
interface BlockTarget { place: Place; block: Vec3 } // block 各分量须为整数
interface ItemSelector { name: string; components?: JsonValue; minDurability?: number; substitutions?: string[] }
interface ControlInput {
  keys: Partial<Record<Key, boolean>>;
  look?: { yaw: number; pitch: number }; // 弧度
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
interface WindowSession {
  snapshot(): Promise<Fact<WindowSnapshot>>;
  click(input: {
    slot: number; button: number; mode: number; expectedRevision: number;
    expectedSlots: { slot: number; stack: StackExpectation }[];
    expectedCursor: StackExpectation;
  }): Promise<EffectReceipt>;
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

interact 的 face/cursor 仅对方块有效：face 为轴向单位法向，cursor 为该方块内 [0,1] 命中点且位于指定面；无效组合派发前失败。高层 `placeAt`、瞄准和物品转移是 callable，可组合这些操作，不在 Driver 内暗中采料或规划长期目标。dig/attack/interact 返回的是其已声明完成范围及原始证据，攻击尝试不等于命中/击杀。

dig 的 aim 默认 target，可调整视角；preserve 不自动瞄准，供同一协调者在移动/视角控制仍进行时挖掘，适配须检查实际目标/手持及可达条件，不能保证移动后仍可挖。该选项解决真实的视角组合缺口，不引入一般资源占用 API。attack 本身不暗中瞄准或清移动键；不满足游戏规则的主手挖掘/攻击/使用重叠仍按实际冲突报告。

窗口绑定本次打开和当前身体段。revision 覆盖全部槽位与光标；click 在驱动同一串行步骤核验版本、当前槽位/光标与调用者的 StackExpectation 后派发，不符返回 WINDOW_CHANGED。count 是精确堆叠数，item=null 要求空且 count=0；非空按 ItemSelector 的组件/耐久/替代约定匹配，不声称物品全值相等。expectedSlots 至少覆盖本次直接操作的非负槽位，数量须为非负整数；具体点击模式检查其涉及的槽位（包括自动分配/交换的潜在目标）；不能用未声明槽位的假定代替现实，校验不产生自动换槽/重试。close 幂等且只关闭自己的代次；多人仍可能在协议到达前改变现实，多次点击不构成服务端事务。合法 button/mode 按客户端版本开放，不支持在派发前失败。

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
interface BlockStateValue { name: string; properties: Record<string, string> }
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

跨域不运输 sample 回调。适配运输 ClientCaptureRequest/Reply、上述通知和 ACK；request 由宿主按既有查询定义生成，只执行纯客户端采样，不执行历史查询、Callable 或传入函数。纯当前 Reply 与失效元数据形成轻量有序状态检查点，World 纳入截至 stamp 的当前元数据并固定结果/cursor，再处理较新元数据；它不等待 evidenceThrough 的历史载荷/持久 ACK，大载荷路径不能堵住普通当前读。纯历史不发 ClientCaptureRequest。联合查询固定所需两侧数据；只有其定义明确要求截至当前样本的证据前缀时，才用 evidence fence 核对 F，并核验有关非 Driver 版本 G0、绑定/时间。该等待仅约束相关联合查询；缺证据重传/明确 gap，不把独立 RPC 到达当作前缀证明，不将逻辑切面称为物理原子。ClientCaptureRequest/Reply 形状不增加普通/严格模式，协议需求由查询实现确定。见 [World §6](modules/world.md#snapshot)。

普通联合在接受当前检查点时固定 World 已接收的历史版本，此后新记录不使已固定结果重做；它只声称当时已接收范围。前缀联合中的 G0 只核验本次源证据对账以外的其他相关依赖；正常接收 F 以内的待到证据按 R 纳入，不作为自身并发冲突，纯落盘也不改变 G。

当前检查点的“纳入当前元数据”包括 §5 的未知范围保守覆盖，不要求等待细空间通知补齐。只有最新 stamp 而缺范围时也必须先发布相应保守失效再固定新 cursor；不能在旧空间索引上静默等待。

sections 按整数 Section 坐标读取；单格局部索引为 y*256+z*16+x（各 0..15）。值遵循唯一基础 schema client.sections@1：{ sections: [{ target, revision, base, patches }] }；base 为 null 或 { palette: [{ name, properties }], indices }，indices 为 4096 个 palette 索引或 null（未知格），properties 为字符串属性映射；patches 是按源提交排序的 { index, state }，state 为同形 Block State 或 null（覆盖失效）。Fact/basis 保留真实来源/时间/依据，revision 是不可复用只读版本，不是活 Chunk。仅区域查询固定其请求 Section；小范围 block/self/inventory 不先创建 Section 版本。服务端地形历史与区域读共用必要基底，不各建全加载区快照缓存；未被活动区域读或证据引用的预测不默认追加长期版本链。展开/编码/压缩在关键路径外，跨域不能复用仍会改写/已 detach 的 buffer。无法短边界固定某区域则明确该查询失败/部分覆盖，不影响其他当前读，也不跨 Tick 拼扫冒充同点。见 [World §7](modules/world.md#sections)。

<a id="world"></a>

## 5. World 所有者：读取、变化订阅与领域记录

```typescript
interface WorldQuery { ref: ExactRef; input: JsonValue }
type WorldChange =
  | { kind: "changed"; cursor: ObservationCursor; changed: Ref[] }
  | { kind: "reset"; reason: "stream_changed" | "epoch_changed" | "cursor_expired"; cursor: ObservationCursor };
interface ChangeWaitTarget { query: WorldQuery; after: ObservationCursor }
type ChangeWaitResult =
  | { target: ChangeWaitTarget; change: WorldChange }
  | { kind: "timeout" };
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

调用者将 read.cursor 原样交给 watch，再交给 next。World 按查询实际依赖原子比较水位/登记等待；有当前依赖时，同域纳入当前 sample，跨域先登记再做轻量当前检查点。当前实现（2026-10-17 对齐）将 after 比较统一放在首次 `next(after)`：watch 的 after 参数不参与登记时比较，登记瞬间已存在的变化由首次 next 立即交付，行为与"watch 登记即固定基线"等价。已发生的迟到通知由 stamp 对账覆盖，之后变化由当前订阅覆盖；该检查不等待历史 bulk/fence。纯历史 Watch 只核对本地历史/领域/时间版本，不请求 Driver。只有查询声明依赖源历史前缀时才另核对该前缀。对账失败明确 SOURCE_UNAVAILABLE/reset，不永久静默等；首次 next 立即交付登记时发现的变化。依赖覆盖输入区域和潜在新对象、相关时间阈值；stream/epoch 不符或无法对账则 reset 后重新 read→watch。prediction→server 等同源升级是 changed，相关来源连续性切换才 reset。

WorldWatch 是底层可组合原语，不要求 Program 直接持有它。Program/Callable 的 `waitForChange(targets, options?)` 是 Runtime 提供的一次性宿主操作；targets 是非空列表，每项为 `{ query, after }`。Runtime 为每项分别创建 `WorldWatch`，并为每项建立受当前 Call signal 联动的子取消域，再竞速各自的 `next(after)` 与可选的单调时钟 `afterMs`。任一 Watch 返回 changed/reset 即返回该 target 和原始 WorldChange；时间先到则返回 timeout。随后 Runtime 只取消输家子域，并关闭所有 Watch、清除计时器，清理完成后才结算调用；父 Call 取消则取消全部子域。World 仍是每个 cursor、查询依赖范围、changed/reset 和失效比较的唯一所有者；Runtime 不拆 cursor、不拼接 current/history 水位，也不把 timeout 当作世界变化或完成证据。每个 cursor 必须与对应 query 的确切身份、参数、World/binding 作用域及来源代次匹配；World 对错配不得静默等待，须 reset 或返回稳定错误。多个目标只是多个独立观察，不形成原子联合快照或跨源一致性承诺。

targets 为空或 `afterMs` 为零/负数/非有限值时返回 INVALID_ARGUMENT；缺省 afterMs 表示只等失效。timeout 表示本次等待结束，所有输入 cursor 均未被推进，不表示查询发生变化；调用者应重新 read 所需事实再判断。任一 changed/reset 都只要求调用者重读相关事实，不表示它们曾在同一时刻成立；Watch 的合并通知也不保证观察到瞬时条件。若任一 Watch 创建失败，整体等待失败并关闭已创建的 Watch，不将不可用伪装成 timeout。每项查询分别遵循 World 自己的依赖支持合同；多个独立查询可以分别覆盖当前/历史来源，Runtime 不合并水位。若业务需要跨查询的一致性切面，必须由 World 提供显式联合查询合同。

最新 stamp 不等于空间范围已索引。World 另维护本当前源已连续分类或已保守覆盖的水位 C；同 epoch 看到 H>C，却无法证明 (C,H] 的 changed 范围完整时，对依赖该当前源的查询一次发布全源保守失效，再将 C 推进 H。单个连续 notice 可用精确范围，跳号/合并/乱序若无完整范围证明则走保守路径，不能用 MAX(已收范围stamp) 越洞。此处全源仅指该 Driver 当前依赖，不牵涉纯历史/DB/F。相同 H 不在每次 read/watch 重复分配失效版本；新 read 先真实采样到 H、纳入保守失效再固定 cursor，迟到的已覆盖范围只细化索引，不把旧变化伪装成之后新变化。来源断裂无法比较才 reset。算法及 20→21 反例见 [World §9](modules/world.md#watch)。

changed 可合并，仅提示复查，changed 引用不承诺穷举每个中间变化；下一次 read 得到新快照和新 cursor 后再 next。需要逐事件历史时应读对应事件记录，不把 WorldWatch 当事件日志。取消 next 只取消本次等待；close 关闭订阅，资源也随所属调用/身体作用域清理。持久世界等待见 §6，不保存任意 watch 闭包。

writeRecord 只供绑定领域所有者的 CallContext；World 从真实当前调用核验存活、act/schema 所有权、分区及 CAS revision。expectedRevision=null 仅创建；更新不符报 RECORD_CHANGED，不能偷换 schema/world/worldRevision。修订追加不可变版本及证据；CAS 只保护同一领域记录，不比较通用观察版本。领域判断可以基于确切旧证据保存，新原始观察不可被覆盖；其当前有效性由领域查询解释，不把历史判断当当前事实。空间约束由确切 schema 强制，可跨维度的记录明确列出全部位置。schema 与领域验证器由功能模块在组合根提供，不另造生命周期。Program 只有只读 World；标注/更新通过领域 callable。

WorldEvidencePort 仅注入 Runtime 等实际持有跨库强引用的记录所有者，不属于脚本/普通能力写口。retain 对可信 owner 幂等追加 World 证据引用，成功前保证证据、必要 Section 基底/补丁等传递依赖已持久且保留关系已提交；owner 的含义是不可变运行/效果记录，不是临时 call scope，也不是调用者自报的授权。先 retain，再发布外部持久引用；release 仅在该 owner 的引用已持久移除或发布已持久放弃后执行。失败不宣称持久引用成立；跨库中断宁可留下孤立保留，不能先删除证据。DomainRecord 的同类保留在 World 自己的修订事务内完成。外部证据由其原所有者保证，World 不遍历 Subject 会话或新增通用引用 Registry。详情见 [World §10](modules/world.md#retention)。

retain 的存在/依赖校验与保留提交、历史切面登记和实际删除经过同一 World writer/历史发布门，删除前复核引用/保护。删除先胜则 retain 报 EVIDENCE_UNAVAILABLE，保护先胜则跳过。删除在途不允许历史切面按旧版本固定已失去的材料；纯当前读、当前检查点及当前 Watch 不申请这条门，不因存储/GC 而等待。该短门不阻塞 Driver/证据接收，不跨长查询持有。

<a id="programs"></a>

## 6. Program 与 Assets：普通函数、宿主桥接与版本（历史对照）

> **已由 [`modules/program.md`](modules/program.md) 取代。** 程序是单文件 + 头注释，没有 `WaitRequest`/`mc.wait`/`mc.checkpoint`/`dependencies`/`bindings`/`nativeEnvironment`；调用统一为 `mc.call(selector, input)`，等待用 `mc.waitForChange`/`mc.sleep`。本节保留作历史对照，实施以 program.md 为准。

以下 API 留在本文作为唯一公共定义；不把宿主对象、函数或 iterator 本身塞入 IPC。函数回调留在原 guest；Body/Window/Feedback/文件流使用宿主登记的资源路由与本地包装。每次 Program Call 有独立语言 runtime，普通 Promise 分支本身不创建 Call。完整数据边界、回调交接与取消算法由 Program 所有者规定。

```typescript
interface WaitRequest { condition: ExactRef; input: JsonValue; checkpoint?: Checkpoint }
interface WaitResult { observation: Ref; evidence: Ref[] }
interface ProgramBody extends BodyOps {
  call<I, O>(ref: Selector, input: I): Promise<O>;
  loop(step: (frame: FeedbackFrame) => ControlInput | { done: true }, sensors: Record<string, WorldQuery>): Promise<void>;
}
interface ReadProgramAPI {
  readonly checkpoint: Checkpoint | null;
  call<I, O>(ref: Selector, input: I): Promise<O>;
  read<T>(query: WorldQuery): Promise<Observation<T>>;
  wait(request: WaitRequest): Promise<WaitResult>;
  waitForChange(targets: readonly ChangeWaitTarget[], options?: { afterMs?: number }): Promise<ChangeWaitResult>;
  decide(reason: string, checkpoint: Checkpoint): Promise<never>;
  progress(value: Progress): Promise<void>;
  readonly assets: ReadLibrary;
}
interface ProgramAPI extends ReadProgramAPI {
  withBody<T>(work: (body: ProgramBody) => Promise<T>): Promise<T>;
  readonly assets: WriteLibrary;
}
interface ProgramDefinition {
  descriptor: Omit<CallableDescriptor, "ref" | "implementation">;
  source: string; // async function(mc, input) 的函数体；不是 npm 包
  dependencies: ExactRef[]; // 仅显式 Program 资产依赖；不包含原生 ref，不穷尽动态调用
  bindings?: ProgramBinding[]; // 提供时是闭合的裸名表；不再回退到当前原生环境
}
interface ProgramBinding { name: string; refs: ExactRef[] }

```

程序入口是 `async function(mc, input)`，input/output 按声明 schema 校验。循环、函数、闭包、异常与局部状态都是普通 JS；不允许直接访问 Bot/Node 宿主。ProgramAPI 是脚本侧的本地门面，异步方法跨执行域时只运输参数/结果及隐藏的调用/资源引用；函数参数一直留在脚本域。

`withBody` 本地保留 work，宿主取得资格并返回代理；回调里用 body.call 继承该作用域，直接身体方法也是该代理。结束后宿主完成释放屏障，finally 只是正常路径方便写法，强制终止的清理仍由驱动负责。loop 本地保留 step，内部用 feedback→next→step→apply，done/异常/取消时关闭；不向驱动发送函数，不允许反馈回调另起异步身体分支。自写控制的自由度来自新传感和 ControlInput，不来自原始 Bot 旁路。

`wait` 是领域等待的便捷能力：WaitConditionDef 让可复用的 ready/pending/decide 规则由领域所有者定义；它不是 Program 表达等待的唯一入口。临时或组合条件用普通 JavaScript `read → 判断 → waitForChange → 重读`，无需注册新 Callable/条件、改 Runtime 或添加条件 DSL。示例：

```javascript
while (true) {
  const healthQuery = { ref: "self.health@1", input: {} };
  const weatherQuery = { ref: "weather.current@1", input: {} };
  const enemiesQuery = { ref: "entities.nearby@1", input: { radius: 16 } };
  const [health, weather, enemies] = await Promise.all([
    mc.read(healthQuery), mc.read(weatherQuery), mc.read(enemiesQuery),
  ]);
  if (health.value >= 10 && weather.value === "clear" && enemies.value.length === 0) break;
  await mc.waitForChange([
    { query: healthQuery, after: health.cursor },
    { query: weatherQuery, after: weather.cursor },
    { query: enemiesQuery, after: enemies.cursor },
  ],
    { afterMs: 30_000 },
  );
  // timeout 也回到 read；只由新观察判断条件。
}
```

上面的三个 ref 及返回字段仅为接口形状示例，不代表当前已有这些 QueryDescriptor。若天气、生命值、实体等事实分别由独立 QueryDescriptor 提供，Program 可各自 read 并把每个查询与自己的 cursor 放入同一次 `waitForChange`。若某项底层事实本身不存在，仍须由其所有者补足观察能力；普通 JS 不能伪造事实。分别读取不提供联合快照；只有业务确实要求多个来源在同一一致性切面解释时，才由 World 增加明确的联合查询。

wait/waitForChange 检查**当前调用谱系**没有持有/借用 Body，否则 BODY_SCOPE_ACTIVE；无关兄弟的 Body/排队不构成拒绝理由。先退出自己的 withBody，不能自动释放后让旧闭包持旧 player。waitForChange 为每个 target 分别调用 World.watch(query,after,childSignal)，childSignal 由 Runtime 与 Call signal 联动；一项变化/重置或本地计时胜出时只取消其他 childSignal。任何返回、建 Watch 失败、取消或调用关闭都必须取消相关等待、关闭所有已建 Watch 并清计时器，资源清理完成后调用才结束。World 自己保证每个 read cursor→首次 next 无漏变化，并核验 cursor/query 身份。取消只停止该调用的等待并由 CallScope 关闭，不停止 Run；多个等待 Call 可并存且各自持有观察资源。await mc.wait/waitForChange 都保留闭包与活动 guest 容量；decide 持久封口并释放旧域。重启只恢复记录/检查点，显式 continue 才建新段，不恢复栈或自动主动复查。

**保存的是一个程序入口。** 普通文件工具编辑 `program.js` 与 Manifest，`WriteLibrary.publish` 创建不可变 Revision；修改内容或回退都发布新版本并对当前 head 做 CAS，不移动旧版。`publishFromRun` 必须指定 run/segment/**record**，经可信 ProgramSourcePort 固定当时入口，再进入同一发布机制；不复制栈、输入、结果或完整历史。接口仅见 §6.3 所链接的 Assets 合同，不再定义 ProgramAssets/ScriptAssets 的另一套保存门面。

原生段从执行时冻结 descriptor 生成 `return await mc.call(<exactRef>, input);`，完整保留 input/output、access、completion、checkpoints 等声明，去掉原 ref/implementation；dependencies=[]、bindings=[]，原生 ref 不是资产依赖。Program 段保存实际源码与入口自己的 effectiveBindings。保存来源不充当执行证据；关联 Evidence 经可信有限导出独立附加，不建立持久 capture owner 或跨库保留事务。

顶层 run 的名称在首次受理解析成确切入口。未提供 bindings 时，程序内简单名称从**当前程序定义的显式 dependencies 与固定原生环境**建立绑定，不查询当前推荐目录；显式依赖优先于原生同名绑定。提供 bindings 时只用这份有限闭合表，缺项报 UNBOUND_CALL，不能补入新环境的同名实现；名称须为无版本的完整名称，refs 非空、去重且每项名称与键一致，同名声明依赖与该表不一致在执行前报 INVALID_ARGUMENT。同一名称多个确切版本可供确切调用，裸名仍报 AMBIGUOUS_CALL，不能因保存而任挑一个。保存程序 Q 使用 Q 自己的声明，不能被调用方 P 的同名绑定覆盖；不构建模块安装/导入图。

绑定在程序调用开始前确定并记录，等待期间不变；恢复同一定义继承既有绑定。续段显式提交的新定义/依赖就是换版意图，不能被旧绑定覆盖；默认原生环境仍按 inherit。动态确切 ref 在自身调用前核验/登记，每段记录实际调用与环境指纹，不冻结全目录；旧原生实现不可用明确失败，不假冒新版。

Program.progress 委托同一 CallScope.progress，保留调用归属、可合并非关键更新；它只报告作者声明的进展，不自行完成目标或创建服务端效果证据，最终回执仍按原证据合同裁定。

### 6.1 正常采集与制作

```javascript
// 简单名称来自本程序声明/固定原生环境；实际确切版本进入运行记录。
await mc.progress({ summary: "开始准备木板", measures: [] });
const wood = await mc.call("gather.collect", { block: "oak_log", additional: 8 });
const boards = await mc.call("crafting.craft", { item: "oak_planks", additional: 32 });
return { wood, boards };
```

一次 run 建一段程序；collect 内 withBody 取得身体，其内部 scope.call 导航/装备/采集共用资格，按实际入包返回；退出后释放，craft 再按当前真实材料执行。若需要连续独占，外层 `mc.withBody` 内改用 `body.call` 组合两者。产出批次超额如实返回，数量单位由各能力 schema 定义。顶层正常 return 的范围仍为 execution；两个子能力的目标/效果证据分别保存。

### 6.2 未预设的反馈控制

```javascript
const terrain = await mc.read({ ref: "region@1", input: input.region });
await mc.withBody(async body => {
  await body.loop(frame => {
    if (frame.self.value.onGround && insideLanding(frame.self.value.place.position, input.landing)) {
      return { done: true };
    }
    return chooseInput(frame, terrain, input);
  }, { collision: { ref: "nearby_collision@1", input: { radius: 3 } } });
});
return await mc.read({ ref: "self@1", input: {} });
```

insideLanding/chooseInput 是脚本内普通函数；桥接只传反馈帧和受控输出。loop done 只结束控制循环，落地目标的确认强度仍取决于观测与入口合同。保存后调用 `user.parkour@2` 与调用原生能力走同一 call 包装，不增加动作分类或第二执行器。

### 6.3 文件包、Library 与可信来源导出

> **已由 [`modules/assets.md`](modules/assets.md)（Library）与 [`modules/program.md`](modules/program.md) 取代。** 库是普通文件（`programs/`、`blueprints/`、`experiences/`），没有 SQLite 目录、不可变包、发布 CAS、版本号或证据副本；文本由 `library` 写，蓝图字节由文件能力放。本节保留作历史对照。

Assets 已采用普通文件包 + SQLite 目录/CAS 的统一终态（历史内容，实施以 Library 详细设计为准）：

| 合同 | 现行定义 |
| --- | --- |
| 三类条目的命名、目录、路径安全 | [Library §2](modules/assets.md) |
| 蓝图的 Raw/Target/Project、AirPolicy、完整性 | [Library §3](modules/assets.md) |
| 经验的形态、证据弱链接 | [Library §4](modules/assets.md) |
| `library` 的 `list/get/save/update/delete` | [Library §5](modules/assets.md) |
| 程序单文件、头注释、`library.save` 从运行段 | [program.md §2、§4](modules/program.md) |
| 程序执行端口与 RPC | [program.md §7](modules/program.md) |
| PublishRequest/CAS、ProgramSourcePort、EvidenceExportPort、ReadLibrary/WriteLibrary | **删除**，理由见 [Library §7](modules/assets.md) |

ReadCallContext/ReadProgramAPI 的 `assets` 字段随仓库一起删除：脚本不需要仓库对象，按名取蓝图用 `blueprint@1`（Construction 实现），文本库操作走 `library` 工具动作（[Runtime §9](modules/runtime.md#9-program-执行合同与资源准入)）。

WorldEvidencePort 仍可供 Runtime 保护自己记录的必要 World 强引用；不存在资产侧的 capture/retain/发布协议。


<a id="executor"></a>

## 7. Uina ↔ Executor：确定的受理、查询、结果与事件

> **程序入口与执行端口已改（2026-10-18）**：程序以 `{ kind: "program"; source: SourceSnapshot; input }` 提交，`SourceSnapshot = { name, source, digest }`（源码与头注释见 [program.md §2](modules/program.md)）；`ProgramDefinition`/`wait`/`checkpoint` 的旧形状只出现在 §6 历史对照。§7.1 的 `ProgramExecutionPort`/`ProgramSegmentDomain`/`ProgramCapacity` 不再由 Executor 暴露——程序在世界侧进程内执行，容量与 guest 队列经 `runs` 报告（[program.md §5、§7](modules/program.md)）。本节其余受理、查询、结果、事件与投递合同仍然有效。

```typescript
interface SourceSnapshot { name: string; source: string; digest: string }
interface Origin { worldOwner: Ref; activation: Ref; caller?: Ref; invocation?: Ref }
type Entry = { kind: "call"; selector: Selector; input: JsonValue }
  | { kind: "program"; source: SourceSnapshot; input: JsonValue };
type Schedule = { kind: "enqueue" }
  | { kind: "replace_pending"; targets?: Ref[] }
  | { kind: "preempt_current"; expectedRun: Ref };
interface RunRequest { requestId: Ref; entry: Entry; policy: Record<string, JsonValue>; schedule: Schedule }
interface GoalState { state: "undeclared" | "met" | "not_met" | "unknown"; contract?: ExactRef; evidence: Ref[] }
interface RunBase {
  run: Ref; rootRequestId: Ref; revision: number; segment: Ref | null;
  progress: Progress; goal: GoalState;
  control: "none" | "active" | "stopping" | "stopped" | "unknown";
  unknownEffects: Ref[]; record: Ref;
}
type RunSnapshot = RunBase & (
  | { phase: "queued" | "running" | "stopping" }
  | { phase: "waiting"; waits: { callId: Ref; request: WaitRequest }[] }
  | { phase: "awaiting_decision"; decision: Ref; reason: string; checkpoint: Checkpoint; completionRef: Ref }
  | { phase: "finished"; outcome: Outcome; value?: JsonValue; error?: { code: string; message: string }; completionRef: Ref }
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
  | { kind: "program"; definition: ProgramDefinition; input: JsonValue };
type SegmentEntry =
  | { kind: "program"; ref?: ExactRef; definition: ProgramDefinition }
  | { kind: "native"; descriptor: CallableDescriptor & { implementation: "native" }; digest: string };
interface SegmentRecord {
  run: Ref; segment: Ref; revision: number; record: Ref; entry: SegmentEntry; input: JsonValue;
  nativeEnvironment: Ref; effectiveBindings: ProgramBinding[]; sourceDigest: string;
  checkpoint: Checkpoint | null; value?: JsonValue; evidence: Ref[];
}
interface CallRecord {
  call: Ref; run: Ref; segment: Ref; parent: Ref | null; record: Ref;
  ref: ExactRef; implementation: "native" | "program"; digest: string;
  access: "read" | "act"; input: JsonValue; effectiveBindings?: ProgramBinding[];
  execution: "running" | "returned" | "threw" | "interrupted";
  completion: CallableDescriptor["completion"];
  outcome?: Outcome; value?: JsonValue;
  error?: { code: string; message: string; dispatch: "not_sent" | "sent" | "unknown"; effects: Ref[] };
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
  programCapacity(): Promise<ProgramCapacity>;
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

façade 的临时代码只需 code/input；接入生成 execution 范围的临时描述和默认 JSON 输入/输出合同，不要求模型为每段代码手填完整 ProgramDefinition。具名 call/args 规范化为 Entry 的 selector/input；library 保存时才需要可复用描述。

SegmentRecord 是运行所有者固定的一次只读截面；revision/record 标识该截面，entry 保存实际执行的 ProgramDefinition 或当时冻结的原生 descriptor/实现摘要。effectiveBindings 只属于该段入口，保留同名歧义；子程序各自的表和实际调用关系仍属于其调用记录，不能扁平并进该表。活段 evidence 可增长，但同次 readSegment 不混合前后截面；readSegment 不承诺持久保留，也不能给任意调用者建立 GC 保护。原生段的普通裸名环境不等于它的后代依赖图。

ProgramSourcePort 与 EvidenceExportPort 采用 §6.3 引用的唯一 Assets 合同，只注入可信宿主，按确切不可变 record 导出有限来源/事实；不装入 ExecutorClient 或脚本，也不需要 Runtime 为资产保存建立持久 capture/retain 账本。CallRecord 用于实际调用树、失败与 effects 的展开，不允许调用方直接写入或修改结论。SegmentRecord.record 与 CallRecord.record 始终是已提交不可变截面；活跃调用的后续进度产生新截面，不原地修改旧 record。

以上请求 ID 是内部协议字段。模型 façade 的 run/continue/stop/library 参数不含需自造的 ID；接入为新工作在任何 IPC 前持久建立 requestId，后续本次传输重试/查询复用。模型得到系统返回的 request/run 后可以查询或恢复旧请求；再次普通 run 是新意图，不能用参数相同自动合并。invocation 仅审计关联，不承担持久唯一性。

停止是例外：接入先生成 ID 并立即发送 stop/关闭 owner 门，不因本地持久失败阻止停机；持久受理承诺以执行侧 intent=durable 为准。StopReceipt 分开返回控制快照及停止意图持久性，snapshot=null 表示尚未取得执行侧事实。lookup 仅查询 submit/continue 映射；停止重试同 ID 返回/补齐 StopReceipt，不拿运行 phase 冒充停止意图已落盘。

attach 为该客户端绑定可信 owner/activation，heartbeat 续有效期，失联门按行为契约自动关闭；后续调用核验绑定。setOwnerGate 关闭 disabled/emergency 时立即撤销准入并停止所属运行，再报告持久性；关闭门不受 CAS 冲突阻止。解除门要求当前 attachment、expectedRevision 精确匹配及显式意图，失败不放开动作；解除一个门不解除其他门，不复活旧运行。World 停用、具身 safeStop/resume 分别调用这些公开方法，不能只循环 stop 当前 run。

continue 不再使用含义过宽的 rebind 标志：call 入口必须给确切 ref，新代码也须显式给出，因此代码/能力换版本身就是明确选择；environment 默认 inherit，只有显式 current 才换当前原生环境。新段先核验输入/检查点与目标合同兼容性，再消费 decision；同名裸 selector 不在续段内部重新解析。新代码可沿用原生环境，动态确切调用按其自身规则检查，旧段绑定/证据不变。

submit/continue 先完成 Runtime 持久受理，再在同一次客户端调用的短等待窗口内读到已提交 finished/awaiting_decision 时返回 RunReply.result，超时返回 accepted，unknown 先 lookup。waitSignal 只解除本次窗口等待、令调用返回 accepted/当前已知事实，不撤销 Run。CompletionReport 是唯一执行报告联合：reportKind=terminal 只能配 finished，reportKind=decision 只能配 awaiting_decision；completionRef/result 并不意味着整个 Run 已终结。finished outcome/value 是真实合同结论，decision 没有最终 outcome。同一段最多一份 decision 报告，同一 Run 最多一份 terminal 报告；待决策 Run 被 stop 可另生 terminal，旧 decision 不改。lookup.completionRef 是该 request 所受理段第一次封口的报告引用，不取 Run 最新续段报告；未有报告时省略。窗口从受理确认起算，时长由接入配置，不影响 Run 寿命。显式 wait 只等待 revision 变化；短等待循环 read/wait 至本次提交报告或窗口关闭，不能把一次 progress 当完成。list/read 只允许所绑定 owner，signal/期限只取消等待。

events 只是变更提示，断流从 read/list/pendingDeliveries 补读。completion 与固定报告在相应段交还/Run 终结事务持久；原 run/continue 短窗口直返前在 Executor 既有请求记录固定 request/segment/completionRef，再 settleDelivery(tool_handoff)，正常抑制后台通知。工具桥接完成响应交接后关闭本地请求，二者都不是 canonical ACK。恢复只枚举本 owner 未结请求并用 lookup 对账；pending 走正常 drain，input_committed/过时 decision 关闭本地项，tool_handoff 且 eligible 则以 (requestId, completionRef) 唯一键建立一个持久补报意图，重启续用既有意图/attempt 流程，不重做动作。一个意图可因 ACK 丢失重复呈现；本地已关闭后的最终交接缺口仍可查询，不宣称恰好一次/至少一次，不扫描 Host 会话。工具等待取消解除本地暂缓，Run 继续。input_committed 只接受可信 attempt inputId→completionRef 对应的 input_settled.committed。两种 receipt 均核验 owner/原请求或实际 attempt，guest 无权注入；settleDelivery 幂等，只追加交付处置，不改游戏结论。故障补报可在 tool_handoff 后追加 input_committed，不能回退 pending。

pendingDeliveries 只返回 disposition=pending 且 eligible 的项，不静默截断；恢复补报显式由未结请求持久意图指定，使用 readDelivery 读取 tool_handoff，不扩大 pending 枚举。普通 read/wait 不消耗通知。readDelivery 用于 emitEvent 前和 deferred render 前复查：decision 已消费/被停止/Run 终结就不再作为请求投递，旧 report 仍可查。render 对过时 decision 返回 null，不写 ACK；状态读取不可用也不冒认为待处理，保留重试。render 检查与 Host append 非原子，最后竞态可能展示历史，continue 仍以 DECISION_STALE 拒绝重复消费。未确认的输入按同 completionRef、新 attempt 可重报，不重新动作。正常的短等待暂缓、返回选择和后台 drain 由同一 Executor 实例串行协调，不建跨库租约/claim。完整交界见 [行为 §4](contracts.md#delivery) 与 [Runtime §13](modules/runtime.md#13-同一-completion短时直返与后台递送)。

programCapacity 是无 Body/guest 准入等待的观察接口，façade 用 runs {op: "program_capacity"} 暴露。ProgramExecutionPort.capacity 同步读取其唯一容量事实，返回 entriesScope=all 的一致内存截面；ExecutorClient 保留整体 limit/occupied/queued，entriesScope=owner 且只列当前 owner 的 Segment，不泄漏其他 owner 标识。occupied 含 opening/active/retiring/retirement_unknown，只有已证明释放才减少；requestedAt/occupiedAt 为诊断时间，排队顺序由 Program 内部序号决定。关联 Segment 的 Run/Call/WaitRequest 提供世界等待原因；跨读只是带 observedAt 的观察，不承诺与持久 Run 快照原子，也不能把容量快照当资源预留。全部域长期 wait 可让新 Program 无限 queued；停止、取消、纯 native、状态查询走独立路径。

### 7.1 可信组合根注入

> **程序执行端口已移出本节的公开面（2026-10-18）。** 世界进程内部的 guest 执行/桥接不再是 Executor 对 Uina 暴露的合同；本小节关于 `ProgramExecutionPort`、`ProgramSegmentDomain`、`ProgramCapacity`、`ProgramExecutionFailure`、`DriverExecutionSink`、`RuntimeRecordBarrier`、`WaitConditionDef`、`CompletionCheck` 的定稿仅作历史对照，现行定义见 [program.md §5、§7](modules/program.md)。以下只保留仍被 Runtime/Driver 组合根使用的可信注入合同。

下列合同只服务 Runtime/Program/Driver/领域组合根，不接受模型 JSON 注入。函数表示可信本地实现，不跨执行域传输。

```typescript
interface CheckpointSchemaDefinition { ref: ExactRef; value: JsonSchema }
type ConditionCheck =
  | { state: "ready"; result: WaitResult }
  | { state: "pending"; afterMs?: number }
  | { state: "decide"; reason: string; checkpoint: Checkpoint };
type WaitConditionDef = {
  ref: ExactRef; input: JsonSchema;
} & (
  | { kind: "passive"; query(input: JsonValue): WorldQuery;
      evaluate(input: JsonValue, observation: Observation<JsonValue>): ConditionCheck }
  | { kind: "active"; recheck: ExactRef; args(input: JsonValue): JsonValue;
      initialDelayMs(input: JsonValue): number;
      evaluate(input: JsonValue, result: JsonValue): ConditionCheck }
);
interface CompletionCheck {
  state: "met" | "not_met" | "unknown";
  evidence: Ref[]; reason?: string;
}
interface DriverExecutionFact {
  effect: Ref; operation: Ref; contract: ExactRef; observedAt: string;
  kind: "dispatch" | "receipt" | "cleanup";
  dispatch: "not_sent" | "sent" | "unknown";
  completion: "met" | "not_met" | "unknown"; evidence: Ref[];
  detail?: JsonValue; // 操作声明的原始回执/缺口，不是 guest 自述
}
interface RecordTicket { instance: Ref; sequence: number }
interface DriverExecutionSink {
  record(fact: DriverExecutionFact): RecordTicket | null;
}
interface RuntimeRecordBarrier {
  capture(): RecordTicket; // 无事实时为本实例 sequence=0，不是未知回退值
  flushThrough(through: RecordTicket): Promise<void>;
}
interface ProgramRetirement { state: "retired" | "unknown"; reason?: string }
// 可信 ProgramExecutionPort 产生的失败；guest 自述不能伪装此对象的来源。
interface ProgramExecutionFailure extends Error {
  code: "PROGRAM_ERROR" | "PROGRAM_CAPACITY";
  scope: "call" | "domain";
  reason: "syntax" | "language" | "encoding" | "exception" | "resource"
    | "capacity" | "protocol" | "engine" | "transport";
}
interface ProgramCapacity {
  observedAt: string; limit: number; occupied: number; queued: number;
  entriesScope: "all" | "owner";
  entries: { segment: Ref; requestedAt: string; occupiedAt?: string;
    state: "queued" | "opening" | "active" | "retiring" | "retirement_unknown" }[];
}
interface ProgramSegmentDomain {
  invoke(request: {
    call: Ref; definition: ProgramDefinition; input: JsonValue;
    api: ReadProgramAPI | ProgramAPI; signal: AbortSignal;
  }): Promise<JsonValue>;
  retire(reason: string): Promise<ProgramRetirement>;
}
interface ProgramExecutionPort {
  capacity(): ProgramCapacity;
  validate(definition: ProgramDefinition): Promise<void>; // 语法/语言支持，不执行用户代码
  open(request: {
    segment: Ref; mode: "wait" | "try"; signal: AbortSignal;
  }): Promise<ProgramSegmentDomain>;
}
```

Checkpoint schema 由领域模块普通导出，组合根校验同 ref 唯一。descriptor.checkpoints 明确入口可消费的 schema；不声明则不接收非空检查点。NativeCallable 的 descriptor.access 与顶层 access 必须相同。Program 非 execution 完成范围须配置可信原生 read verifier；它按已冻结入口 input/value/effects 和确切要求判定并返回 CompletionCheck，不能接受脚本自述代替证据。ctx.verify 只允许 effect 原要求指定的核验者，不能改目标或核销无关效果。

DriverExecutionSink 是 Runtime 注入且绑定可信创建来源的本地实例；record 同步接收不可变事实并非阻塞入队，返回本 writer instance 的 ticket，不代表持久/服务端 ACK。无法接收返回 null 并锁存 recorder fault、封闭新副作用；Driver 撤销/清理不等磁盘。RuntimeRecordBarrier.capture 固定已收到前缀 H，flushThrough(H) 保证 ≤H 材料已提交，否则明确失败；发生材料丢失的故障不得返回成功。ticket 不跨实例/重启比较；H 后材料不纳入原终结。Driver 相应关闭 Promise 完成前，已产生的清理派发/可得回执必须先入 sink；未来回执可晚到并追加核验。完整结算见 [Runtime §11](modules/runtime.md#11-effect-记录提交屏障与结算)。DriverOptions 必须注入完整 HostCallVerifier 与 sink，缺真实来源验证不启用完整写集成。

ProgramExecutionPort 只注入可信宿主；api 是当前 Call 绑定的本地入口，不作为 JSON/宿主对象送 guest。open.wait 进入有限域容量 FIFO，可取消；try 无立即容量报 PROGRAM_CAPACITY。每 Segment 最多一个 domain，共享首次 open Promise；嵌套/并发 Program Call 在域内隔离语言环境，不再占第二份域容量。持 Body 时首次开域只准 try，不能持 Body 排容量；native 不占域。invoke.signal 只取消该 guest Call；段 retire 封闭全部 invoke/桥接，取消所有 guest 并给出退役事实；未知不得释放仍存活资源的容量，域退役不替代 Driver 屏障。Program 经 Executor 注入的受管创建能力建立子域，最终进程树监管只有 Executor 一个所有者，Runtime 不接 OS API。await wait 保留 domain/闭包及资源；decide/段终结释放，不恢复退出后的栈。QuickJS+段子进程是优先原型，具体语言/WASM pump/帧编码/预算/平台启动留给各所有者详细设计。

ProgramExecutionFailure 只在可信执行端口与 Runtime 间分类故障：scope=call 允许正常子调用处理，scope=domain 表示共享引擎/桥接隔离失守，Runtime 先关闭整段并调用 retire，不能将它作为一个可吞掉的普通 JS 异常送回仍活动 guest。单调用取消通过原 signal/CallScope 结算，不伪装成 JS 错误。PROGRAM_ERROR 的设计含义扩为语言执行/编码/资源/引擎/桥接错误，PROGRAM_CAPACITY 表示无法立即获得活动执行域；该两码的细分 reason 只服务可信端口，不由 guest 为自己授予生命周期权威。后续实施同步 errors.ts 的旧释义及 PROGRAM_CAPACITY 缺项。

WaitConditionDef 核验确切 ref/input；read 只可 passive，active.recheck 必须为固定 act Callable。pending.afterMs 为有限正数，initialDelayMs 为有限非负数；到期只复查，取消/重读拆除上轮计时器和 Watch，无默认任务期限。World 不支持混合查询时支持检查明确失败，Runtime 不另造混合 cursor。

## 8. 模块独立验证的最小要求

| 所有者 | 用公开合同验证，避免测试内部结构 |
| --- | --- |
| Callable/Program | 同输入经直接调用、程序内 call、保存程序调用返回同领域值；嵌套不二次 submit；read 视图无写口且捕获旧写代理仍被拒绝；progress 不升级为效果证据 |
| Runtime/Body | 独立 Body 分支 FIFO、委托复用、自等待局部失败；外层释放；旧 scope/window/反馈不可复活；wait 按谱系检查；Effect 屏障先于终结 |
| Driver | 输入/点击参数、版本及预期槽位/光标物品、帧代次/新鲜度与停止屏障；真实服务端另验效果，mock 不替代 |
| World | read/游标同一点、读/订阅交界不漏唤醒、换源/重连/旧游标返回 reset；schema/CAS/证据写入受唯一所有者约束 |
| Library | 三类条目的命名/目录/路径安全；蓝图 Raw/Target/Project 与 AirPolicy；经验弱链接；明文错误；蓝图不携带现场进度 |
| Uina/Executor | ID 持久化后 IPC；短任务真实直返、长任务通知；tool_handoff 非 canonical ACK；过滤过时 decision；故障同引用重复/缺口不重放游戏 |

这些是接口实现的验收要求，尚未执行的项目不能写成通过。解析/存储类、SQL 表、插件内部算法、完整原版函数目录及延迟常数由模块设计和实验决定；它们不应阻挡另一模块基于以上公开合同开发。
