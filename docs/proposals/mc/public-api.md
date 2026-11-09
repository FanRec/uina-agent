# Minecraft World：模块公开接口

日期：2026-10-18（Asia/Shanghai / GMT+08:00）。状态：跨模块**类型与方法形状的唯一公开定义**（§2–§5、§7）；程序与库由各自模块定义（§6 只导航）。实现进度见 [README](README.md)。

本文只定义跨模块交换的东西：值、失败、观测、能力声明、Body、World、Executor 接入。行为合同见所属 `modules/`；[协作导航](contracts.md) 只列所有权与跨模块流程。Program、能力面与库的合同分别由 [program.md](modules/program.md)、[capabilities.md](modules/capabilities.md)、[library.md](modules/library.md) 唯一拥有，本文不复制也不改写它们。各节由对应模块拥有，放在同一文档只为核对类型，不要求实现成一个 SDK 包或共同基类。

## 1. 读什么、谁拥有什么

行为语义由所属模块唯一维护；跨模块所有权及协作导航见 [contracts](contracts.md)。Runtime 执行机制以 [Runtime 详细设计](modules/runtime.md) 为准。本文与各模块文档构成唯一公开定义；旧 `contracts/*.ts` 已于 2026-10-18 删除。新代码按本文和所属模块合同实现，不把旧类型作为兼容层。

- 原生动作是 Callable（声明 + 实现），查询使用 QueryDescriptor；Program 是普通 JS 文件。Run 是受理后的执行单元，内部调用建立 Call。Feature 只是源码组织方式。
- Uina 的 `ActionDef` 仍是 minecraft façade 的接入适配，返回工具回执；游戏内部调用返回领域值，不复用工具信封与工具取消信号。
- 查询/规划共用 World.read；动作/程序共用 Runtime.call。身体、窗口与反馈流是有生命周期的句柄，不伪装成 JSON 目录函数。

| 开发工作 | 读什么 | 不必读 |
| --- | --- | --- |
| 新增或修改一个能力 | [capabilities.md](modules/capabilities.md) §2–§4；本文 §3（声明、装配、发现） | IPC、通知递送、存储内部 |
| 写程序、改程序库 | [program.md](modules/program.md) §2–§4；[capabilities.md](modules/capabilities.md) §7–§8 | Runtime 队列、身体仲裁 |
| 扩展客户端输入或传感 | 本文 §4；[Driver](modules/driver.md)；[World](modules/world.md) | 采集与建造算法 |
| 改蓝图与经验 | [library.md](modules/library.md) §2–§5 | Bot、程序执行域 |
| 改 Uina 接入、进程与通知 | [executor.md](modules/executor.md)；本文 §7 | 各能力内部算法 |

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
  // null 只用于没有观察源的查询（静态知识 item/recipe、历史页 events）：
  // 没有可比水位，程序侧对应 version=null。
  cursor: ObservationCursor | null;
  history?: HistoryProgress[];
}
interface Progress { summary?: string; [key: string]: JsonValue | undefined }
// 长任务的领域目标摘要（capabilities §2.15）。与 Outcome 正交：Outcome 是一次执行的
// 终态，GoalState 是世界当前是否满足目标。四态计数之和恒等于 total。
type GoalState = "satisfied" | "unsatisfied" | "unknown";
interface GoalSummary {
  state: GoalState;
  completed: number; remaining: number; blocked: number; uncertain: number; total: number;
}
interface ImageFileRef {
  path: string; sha256: string; bytes: number;
  mimeType: "image/png"; width: number; height: number;
}
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
  tags?: string[];
  input: JsonSchema;
  output: JsonSchema;
  access: "act";
  checkpoints?: ExactRef[]; // 明确接受的续段检查点 schema；省略则不接受检查点
  completion: { scope: "execution" | "capability"; description: string };
  errors: { code: string; meaning: string }[];
  requires: string[];
  examples: { input: JsonValue; output: JsonValue }[];
  implementation: "native";
}
interface Availability { state: "available" | "unavailable" | "unknown"; reasons: string[] }
interface ResolvedCallable { descriptor: CallableDescriptor; availability: Availability; digest: string }
interface QueryDescriptor {
  ref: ExactRef; summary: string; input: JsonSchema; output: JsonSchema;
  tags?: string[];
  access: "read";
  watchable: boolean; feedback: boolean; // watchable 可按查询明确声明的输入/结果条件收窄
  facts?: FactCategory[]; // current 查询声明事实依赖（批23）：游标 = 依赖类别修订之和，未声明保守回退全局序号
  examples: {input: JsonValue; output: JsonValue}[];
}
type DiscoveryKind = "capability" | "program" | "blueprint" | "experience";
type DiscoveryEntry =
  | {kind: "capability"; callable: boolean; descriptor: CallableDescriptor | QueryDescriptor;
     availability: Availability; digest?: string}
  | {kind: "program"; callable: true; program: ProgramDescription; completion: {scope: "execution"}}
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

interface NativeCallable<I, O> {
  descriptor: CallableDescriptor;
  invoke(ctx: CallContext, input: I): Promise<O>;
}

interface ReadCallScope {
  readonly run: Ref;
  readonly segment: Ref;
  readonly callId: Ref;
  readonly signal: AbortSignal; // 运行/调用取消，绝不是 Uina 工具等待取消
  progress(value: Progress): Promise<void>;
}
interface CallScope extends ReadCallScope {
  call<I, O>(ref: Selector, input: I): Promise<O>;
  withBody<T>(work: (scope: BodyCallScope) => Promise<T>): Promise<T>;
}
interface ReadCallContext extends ReadCallScope {
  readonly world: WorldReadPort;
}
interface CallContext extends ReadCallContext, CallScope {
  readonly world: WorldPort;
  verify(effect: Ref, verifier: ExactRef, input: JsonValue): Promise<EffectReceipt>;
}
interface BodyCallScope extends CallContext { readonly player: BodyOps }
```

动作使用 NativeCallable；查询只使用 QueryDescriptor 与 World 查询定义，静态知识/计划是 watchable=false 的查询。组合根校验所有确切 ref 唯一、schema、支持条件和示例，目录由同一声明生成。Program 使用 Library 的可选契约，不伪造完整原生 descriptor。

目录统一发现能力、程序、蓝图与经验。search 只给候选摘要；describe 给合同与路径，示例只有 descriptor 里的输入/输出对（不另生成调用串，也不默认搬运源码）；无参数调用一次给出 `reads`/`acts` 两组能力 ref。匹配和排序见 [Library §8](modules/library.md#8-发现)。查询 callable=false 使用 read；动作/程序 callable=true 使用 call。

Runtime 的 [调用与身体合同](modules/runtime.md#body) 唯一规定子 Call、权限交集、可信来源、身体委托和退出清理。参数由调用者显式传递，内部 call 不 submit 子 Run；read 上下文不装配写代理，捕获旧 act 代理也不能升级权限。受信任原生实现绕过公开端口的 OS 行为不在隔离承诺内。

原生能力等待使用 ctx.world.watch；不新增 Program 的 decide/checkpoint/waitUntil 方法。调用程序时可捕获或继续传播专用决策请求；根未处理才交还，见 [Runtime §4](modules/runtime.md#waiting)。

观察/规划与执行分开；计划和执行复用同一业务目标结构，具体字段见 [能力面 §2.11](modules/capabilities.md)。

<a id="player"></a>

## 4. Body/Driver 所有者：取得资格、操作、窗口与反馈

```typescript
type Hand = "main" | "off";
type EquipSlot = "hand" | "offhand" | "head" | "chest" | "legs" | "feet";
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
interface StatusEffectValue { name: string; amplifier: number; seconds: number | null }
interface SelfState {
  place: Place; velocity: Vec3; health: number | null; food: number | null; onGround: boolean;
  maxHealth: number | null; saturation: number | null; oxygen: number | null;
  inWater: boolean | null; inLava: boolean | null;
  effects: StatusEffectValue[] | null; xpLevel: number | null;
  look: { yaw: number; pitch: number } | null; // 弧度；未收到视角包为 null
}
type SignText = [string, string, string, string];
interface SignFaceValue { lines: SignText; color: string | null; glowing: boolean | null }
interface SignValue { front: SignFaceValue | null; back: SignFaceValue | null; waxed: boolean | null }
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
// 窗口/库存/查询共用的纯值；组件使用当前版本的 {added,removed} patch，未知保持 null。
interface ItemValue {
  name: string; count: number; stackSize: number | null;
  components: JsonValue | null; durability: number | null; // 实际剩余耐久；max_damage/max_stack_size 覆盖值与移除语义优先于类别默认值
}
interface TossOutcome { receipt: EffectReceipt; removed: Record<string, number>; remaining: number }
interface ClientWindowObservation { target: BlockTarget | EntityRef; snapshot: WindowSnapshot }
interface StackExpectation { item: ItemSelector | null; count: number }
interface WindowClickReceipt extends EffectReceipt {
  confirmed?: WindowSnapshot; // 确认时的服务端完整快照；本次点击只归因被点击槽与光标的转换
  needsSnapshot: boolean;
  // 真服探针：强制 stateId 的 click 必回权威 full，但工作台会先回"仅同步"的 full。
  // 因此内容未变不判拒绝；未变化/迟到包保持 completion:"unknown"。
  outcome?: "confirmed" | "diverged" | "unknown";
  diagnostics?: {
    stateBefore: number | null; stateAfter: number | null;
    slot: number; button: number; elapsedMs: number;
    slotChanged: boolean; cursorChanged: boolean;
    recovery: string; // 上层据此决定重开窗口还是交还主脑
  };
}
// 商人报价：来自服务端 trade_list 的真实载荷；index 是 0 基报价序号（对应 select_trade 的 slot）。
interface MerchantOfferValue {
  index: number;
  cost: {item: string; count: number}[]; // 1 或 2 项，按协议实际给出的付款项
  output: {item: string; count: number};
  disabled: boolean;
  uses: number; maxUses: number;
  xp: number;
}
interface WindowSession {
  snapshot(): Promise<Fact<WindowSnapshot>>;
  click(input: {
    slot: number; button: number; mode: number; expectedRevision: number;
    expectedSlots: { slot: number; stack: StackExpectation }[];
    expectedCursor: StackExpectation;
  }): Promise<WindowClickReceipt>;
  // 批 15 专用提交：只派发、只承诺"包已进入连接"，生效与否由能力层按证据判定。
  // 三者都不改 revision、不做槽位预测；非对应窗口类型在派发前报 WRONG_STATE。
  selectEnchant(offer: 1 | 2 | 3): Promise<EffectReceipt>; // 附魔台第 offer 档（enchant_item）
  renameItem(name: string): Promise<EffectReceipt>; // 铁砧改名（name_item，协议不带 windowId）
  selectTrade(index: number): Promise<EffectReceipt>; // 商人第 index 个报价（select_trade，0 基）
  // 商人报价；未收到 trade_list 时为 null（不冒充空报价，也不为此主动发 /list）。
  offers(): Promise<Fact<MerchantOfferValue[] | null>>;
  close(options?: {force?: boolean}): Promise<void>;
}
interface AttackOutcome {
  receipt: EffectReceipt;
  // true=窗口内观察到受击/死亡；false=窗口走完但没有证据；null=窗口未走完（中止/断线）
  hit: boolean | null;
  // 批 12：只由 entityDead 观察置 true；fight 的击杀记账只认死亡观察，不把"受击后消失"冒认成击杀
  dead: boolean | null;
}
interface BodyOps {
  drive(input: ControlInput, ticks: number): Promise<{ receipt: EffectReceipt; actualTicks: number; end: Fact<SelfState> }>;
  dig(target: BlockTarget, options?: { aim?: "target" | "preserve" }): Promise<EffectReceipt>;
  attack(target: EntityRef, options?: {evidenceMs?: number}): Promise<AttackOutcome>;
  // 批 12：证据窗口——不派发动作，等待该实体在窗口内的受击/死亡观察（远程命中与击杀确认）
  awaitEvidence(target: EntityRef, options?: {evidenceMs?: number}): Promise<{hit: boolean | null; dead: boolean | null}>;
  // 批 29：本连接观察到的死亡实体（entityDead 持续累积，跨资格会话有效；
  // 读它不派发也不等待）。战斗会话用它把击杀归属从阻塞式证据窗里解出来——
  // 循环保持移动，目标缺席 + 此集合命中 = 击杀。networkId 只在连接内无歧义，
  // 断线/化身更换后清空。PlayerPort 持有累积，BodySession 是只读视图。
  deadEntities(): ReadonlySet<number>;
  useItem(hand: Hand): Promise<EffectReceipt>; // 一次激活，持续使用由 drive/feedback 的 hold 表达
  endUse(): Promise<EffectReceipt>; // 结束所属的原生使用状态，可能释放蓄力效果
  interact(input: { target: BlockTarget | EntityRef; hand: Hand; face?: Vec3; cursor?: Vec3 }): Promise<EffectReceipt>;
  equip(item: ItemSelector | null, slot: EquipSlot): Promise<EffectReceipt>; // null 只允许 hand/offhand；不得隐式丢弃
  toss(item: ItemSelector, count: number): Promise<TossOutcome>; // 主背包+快捷栏(9..44)；removed 只累计服务端确认移出量
  lookAt(target: PointTarget | EntityRef): Promise<EffectReceipt>;
  writeSign(target: BlockTarget, input: {side: "front" | "back"; lines: SignText}): Promise<EffectReceipt>;
  openContainer(target: BlockTarget | EntityRef): Promise<WindowSession>;
  // 玩家自带窗口（window 0 的 2×2 合成格与结果槽）的作用域：期间独占身体，退出时强制关闭。
  // 回调式是因为生命周期与身体资格是同一条作用域，交出裸会话会让调用方漏关而卡住身体。
  withInventory<T>(work: (window: WindowSession) => Promise<T>): Promise<T>;
  feedback(sensors: Record<string, WorldQuery>): Promise<FeedbackStream>;
}
interface BodySession extends BodyOps { close(): Promise<void> }
type ControlOwner = { kind: "run"; run: Ref; segment: Ref; callId: Ref }
  | { kind: "safety"; intervention: Ref; interruptedRun?: Ref };
interface PlayerPort {
  acquire(owner: ControlOwner, signal: AbortSignal): Promise<BodySession>;
  chat(text: string, signal: AbortSignal): Promise<EffectReceipt>; // 单行消息或 /指令；不占 Body，仍核验 act/Owner/连接
}
```

只有运行管理调用 `acquire`，能力/程序用 `withBody`；两者是同一次取得/释放的两侧，不是两个锁。Driver 为每个 BodySession 绑定行为契约中的资格、连接和资源代次；回调旧引用不能借用新主人资格。内层操作接收到已失效资源时返回 CONTROL_INVALID/REFERENCE_STALE。

chat 的输入/输出、前缀和完成范围由 [chat@1](modules/capabilities.md#chat) 拥有；Driver 的上游发送边界与取消规则见 [Driver §7.7](modules/driver.md#chat-send)。不提供独立 command 方法。

独立自保介入由运行管理使用 kind=safety 的同一 acquire 入口，当前来源是 Runtime 受信任的存活介入而非虚构 act Call，先完成旧控制屏障；不能另取一条 Driver 写入旁路，也不绕过 owner 急停/停用门。

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

窗口绑定本次打开和当前身体段。revision 覆盖全部槽位与光标；click 在驱动同一串行步骤核验版本、当前槽位/光标与调用者的 StackExpectation 后派发，不符返回 CONFLICT。count 是精确堆叠数，item=null 要求空且 count=0；非空按 ItemSelector 的组件/耐久/替代约定匹配，不声称物品全值相等。expectedSlots 至少覆盖本次直接操作的非负槽位，数量须为非负整数；具体点击模式检查其涉及的槽位（包括自动分配/交换的潜在目标）；不能用未声明槽位的假定代替现实，校验不产生自动换槽/重试。close 幂等且只关闭自己的代次；多人仍可能在协议到达前改变现实，多次点击不构成服务端事务。合法 button/mode 按客户端版本开放，不支持在派发前失败。

click 的 confirmed 是确认时的完整服务端快照，供消费者直接推进内容 revision 与观察值。只有被点击槽与光标的 mode-0 转换归因于本次点击，其他槽位只是同次观察。相关后态无法确认时 needsSnapshot=true；当前实现封闭该窗口的后续业务点击并要求关闭，不用另一次读取洗白未知或重放业务点击。真服探针（Paper 1.21.11）证明工作台会先回一个"仅同步"的 full（stateId 推进、内容不变），所以内容未变不能证明拒绝：`outcome` 只区分 confirmed/diverged/unknown，未变化与迟到包都保持 unknown，不设 rejected。`diagnostics` 是有界因果证据（stateId before/after、clicked slot、耗时、槽位/光标是否变化、待恢复条件），不替代 `confirmed` 快照。

窗口另有跨 open 返回和多次 click 的会话 Operation，click 是其短子操作；打开/点击 Promise 完成不退役窗口。所属调用作用域或 Body 结束则强制退役。WindowSnapshot.revision 覆盖类型、布局、槽位与光标的变化，**不随 `properties` 推进**（炉子进度每秒数次；revision 是点击的 CAS 前置条件，只约束点击真正依赖的内容），也不能直接复用服务器 stateId 或仅数 updateSlot；type/layout/properties 按该版本实际窗口提供，专用属性的确切意义由窗口/领域 schema 说明，不猜空值。区域名由布局表统一定义：普通容器 `container`+`player`；玩家窗口 `result`/`crafting`/`armor`/`player`/`offhand`；工作台 `result`/`crafting`+`player`；熔炉 `input`/`fuel`/`result`+`player`；酿造台 `bottle`/`ingredient`/`fuel`+`player`；附魔台 `input`/`lapis`+`player`；铁砧、砂轮与商人 `input`/`result`+`player`。工作站窗口**不产出 `container` 区域**，按 `container` 取格的调用方必须显式失败而不是把 input 当普通格。

普通 close 要求光标为空且没有未结束手势，否则报 CURSOR_NOT_EMPTY/WINDOW_GESTURE_ACTIVE，不隐式丢弃或搬槽；失败清理显式 close({force:true})，作用域退出/停机同样强制关闭并保存可能的协议后果、故障及未知。snapshot 纯读；主动重同步需当前窗口资格、串行派发、独立取消与故障期限。专用附魔/改名/交易选择不是现有 click 的别名，由上方 `selectEnchant`/`renameItem`/`selectTrade` 三个受控操作承接：它们经同一窗口适配派发、不改 revision、不承诺生效，完成口径归调用它的能力（批 15）。不向玩法公开 Bot，也不另建窗口能力目录。

当前受控协议实现为 Java 1.21.11。版本差异集中在按连接创建、随连接退役的 DriverProtocol；未来版本实现相同窄端口，不让能力/World/Runtime 添加协议分支。其他版本的相关写入明确报 UNSUPPORTED_PROTOCOL。

玩家库存、普通容器（generic_9xN、generic_3x3、hopper、shulker_box）、工作台与熔炉共用 mode=0 左/右键的快照与确认实现；只有玩家库存内部丢弃操作允许目标 -999。每个业务点击仅发送一个 stateId=-1 的 window_click，服务端处理后返回完整 window_items；不另加第二次同步点击。目标槽/光标必须符合本次 mode-0 前态，才以 confirmed 返回同次服务端快照，避免确认后再次读取造成取消竞争漏记。**这个前态判据只比内容（点击声明的槽位与光标），不比 revision 相等**：玩家库存窗口的 revision 每次全量同步都前进，一次多击序列必然"版本过期"，那是时序不是别人动过窗口（G36）；内容真的变了仍在派发前 `CONFLICT`，并在消息里指出差在哪一格与两个 revision。未变化/不明回包不能证明本次点击已被处理，超时保持 unknown 且不自动重试。开箱前等待一个真实物理步并复验资格，避免连续开箱超过实际 Paper 的 block-use 突发门。打开已派发而未确认窗口时发生取消/超时，关闭屏障记为不明，同连接不再授予身体资格，须重连。

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
  world(): Fact<ClientWorldValue>;
  searchBlocks(request: ClientBlockSearchRequest): Fact<ClientBlockSearchValue>;
  players(): Fact<ClientPlayersValue | null>;
  map(id: number): Fact<ClientMapValue | null>;
  inventory(): Fact<ClientInventoryValue | null>;
  /** G7：自 since 以来被写过的槽位及其当前内容（item null=已空）；标记不可用回 null，不猜。 */
  inventoryChanges(since: number): { slot: number; item: import("./body.js").ItemValue | null }[] | null;
  window(): Fact<WindowSnapshot | null>;
}
interface SectionTarget { world: Ref; worldRevision: Ref; dimension: Ref; section: Vec3 }
interface ClientBlockValue { target: BlockTarget; state: BlockStateValue | null; sign: SignValue | null }
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
  /** 掉落物栈；只有 item 实体可能非 null（元数据未到/解析失败为 null）。 */
  item: { name: string; count: number } | null;
  /** 苦力怕引燃状态（metadata[16]）；非苦力怕/元数据未到/读不出为 null，不猜（批33）。 */
  ignited: boolean | null;
}
interface ClientEntitiesValue { extent: "tracked"; entities: ClientEntityValue[]; selfRef: EntityRef | null }
interface ClientWorldValue {
  dimension: string;
  timeOfDay: "day" | "noon" | "night" | "midnight" | "dawn" | "dusk" | null;
  ticks: number | null; dayCount: number | null;
  weather: "clear" | "rain" | "thunder" | null;
  biome: string | null; difficulty: string | null; gameMode: string | null; spawn: Place | null;
}
interface ClientBlockSearchRequest { name: string; radius: number; limit: number; exclude: Vec3[] }
interface ClientBlockSearchValue {
  matches: {position: Vec3; name: string}[]; // 距采样点升序；已排除 exclude
  scanned: {radius: number; chunksLoaded: number};
  capped: boolean; // 触到上限，matches 只是最近一批
}
interface ClientListedPlayer {
  name: string; uuid: string | null; displayName: string | null;
  latencyMs: number | null; gameMode: string | null; entity: EntityRef | null;
}
interface ClientPlayersValue { extent: "server_listed"; players: ClientListedPlayer[] }
interface MapIconValue {
  type: string; pixel: {x: number; z: number}; direction: number | null; label: string | null;
}
interface ClientMapValue {
  id: number; scale: number | null; locked: boolean | null;
  colors: (number | null)[]; // 恰好 128*128，按 z 行、x 列；null=未收到，0=实际收到的色值；透明性由版本色表解释
  icons: MapIconValue[] | null;
  center: {x: number; z: number} | null; dimension: string | null;
}
interface EventActor { name: string | null; uuid: string | null; entity: EntityRef | null }
type ClientEventPayload =
  | {kind: "chat"; channel: "public" | "private" | "system" | "action_bar" | "unknown";
      text: string; sender: EventActor | null; recipient: string | null; self: boolean | null}
  | {kind: "damage"; amount: number | null; healthAfter: number | null;
      cause: string | null; attacker: EventActor | null}
  | {kind: "death"; message: string | null; place: Place | null}
  | {kind: "connection"; state: "connected" | "disconnected"; reason: string | null};
type ClientSlotValue = { slot: number } & (
  | { known: true; item: ItemValue | null }
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
  subscribe(
    listener: (notice: ClientFactNotice) => void,
    options?: { consumesEvidence?: boolean },
  ): ClientFactsSubscription;
}
interface ClientCaptureRequest { request: Ref; queries: Record<string, WorldQuery> }
interface ClientCaptureReply { request: Ref; capture: ClientFactCapture<Record<string, Fact<JsonValue>>> }
```

SelfState 是 self 查询与反馈共用的身体事实基础：生命值为游戏生命值单位，food 为 0..20，oxygen 为原版客户端气量 0..20（负的耗尽值规范为 0），seconds 是剩余游戏 Tick 按 20 Tick/s 换算的名义秒数，不承诺墙钟到期。新字段不可得为 null 并列入 Fact.unknown；不能填 maxHealth=20、oxygen=20 或 effects=[]。高层 held/armor 来自同次 inventory 采样，不再维护第二份装备状态。

sign=null 在非告示牌上表示不适用；告示牌数据未收到/版本未支持时也为 null，但须列 unknown。front/back 缺口不能转为空白牌面；告示牌实体数据变化必须推进 block 的失效水位。players 只说明服务器实际公告的名单，未列出不证明离线；UUID 即使由 offline 服务端提供也不证明正版身份。entity 仅关联当前真实跟踪代次，不能为名单造 EntityRef。

map 只读当前连接收到的地图包；缺失增量不补透明色，重连清空当前覆盖。center/dimension 只有来源实际给出时填写，不能由玩家位置、地图编号或本机存档推断。ClientEventPayload 通过 CapturedClientFact 的 schema=client.event@1 捕获，原 ref/mark 保持事件身份；通道、作者、攻击者无法可靠解析时保留原文与 null/unknown。具体捕获和失效见 [Driver §11.8](modules/driver.md#client-observations)。

这是游戏执行侧宿主内接缝，不向脚本或跨进程发送 read 函数/活 view。sample 同步读取同一本地提交边界的只读纯值和水位，拒绝 Promise/thenable；view 在返回时失效，其方法不能逃逸后再读。结果为不可变纯数据，不能泄漏 Bot/Item/Chunk。self/inventory/window 不可用时返回 null 及 unknown，不把缺失解释为空背包/箱子。上列基础值分别是 client.block@1、client.sections@1、client.entities@1、client.inventory@1 的唯一当前载荷；基本查询复用，不另造传感目录。Block state=null 表示未知，真实空气用 minecraft:air；实体 extent 仅保证当前 tracked 集合，不证明范围外不存在。缺失实体字段/物品 components 为 null 并在 Fact.unknown 说明，不能猜 UUID、速度或组件为空。known=true/item=null 才是已知空槽，known=false 是槽位未知；layout/selectedSlot 使用该版本明确槽位含义，revision 覆盖值、来源与覆盖改变。metadata/components 的确切 schema/codec 由对应客户端适配声明并随证据保留；不能将原生对象或未知编码默认为完整可解释 JSON。空间搜索与过滤归 World/查询所有者。

subscribe 原子登记并返回当前 stamp 和选定证据头；World 先订阅再 sample，changed 仅提示复查。状态、来源、覆盖和水位先提交，再排变化通知；通知回调不能在 Driver 关键路径同步做磁盘/大查询。连接/身体环境/来源重建或不能保持通知连续性时 reset，旧当前覆盖失效。Driver stamp、证据 mark、World 接收序号、ObservationCursor、物理步及反馈序号互不替代。快照与通知不发主动游戏协议操作。

选定历史证据在原始数据被覆盖/移除前捕获为 CapturedClientFact，mark.sequence 从 1 起，只数该不可复用 stream 内的选定证据；无记录时头为 0。ref 与 mark 绑定不可变载荷，重传复用原值，不按内容相同去重。scope 是实际采集时的绑定；binding 是临时绑定代次，world/worldRevision 是持久分区，dimension 未知为 null。evidenceThrough 与 sample 的当前事实在 Driver 同一本地提交边界固定，但它只是源证据头，不表示 World 已收到/落盘，也不是纯当前 read 的等待条件。同域在该水位可见前完成证据捕获/轻量移交；跨域须对账才称收到。evidence 不得被 changed 合并或 reset 静默清除。

durableThrough 确认指定 receiver 代次已持久提交的源前缀：每个序号都有已持久载荷，或已被已持久缺口记录覆盖。缺口记录本身有稳定 ref，同身份重传不改变区间。确认可合并、重复和迟到，但同 receiver/stream 内不回退；旧 receiver 不授权新 receiver 进度。Driver 只释放被全部已登记**证据接收方**（subscribe 时声明 consumesEvidence=true 的接收方）在当前 stream 上的 durableThrough 覆盖的材料；只读观察者（当前读的 watch 等）不消费证据，不参与该水线，否则永不确认会把有界缓冲耗尽并按溢出报假缺口。ack 的 stream 决定它推进哪条流：换流后旧流的确认不授权新流序号，新流的 1..N 不会被旧高位误释放。无证据接收方时材料保留到有界上限，溢出如实发 evidence_gap，不静默丢弃。acknowledge 返回仅表示本地处理 ACK，不证明另一域收到。无法重传时发 evidence_gap，区间为 (after, through]，null 表示末端未知；未知末端不得授权跨越无界后缀，须在确定封口后追加有限范围对账。封口 evidence_end 只证明源捕获结束，不证明收到/持久化。无可信封口的源保留未确认后缀；有 gap 的前缀即使已持久也不能宣称历史完整。

durable ACK 是同域部署的唯一确认层；同域共享同一份不可变材料和待落盘队列，按提交进度回收。received 层确认、重传协议与 outbox 副本不存在于当前合同——真实跨域交付出现时才按需求引入接收者代次、重传与乱序重排。选择历史范围、持久完成与缺口意义不因此削弱，也不把这条记录链变成每次当前 read 的前置条件。

跨域不运输 sample 回调。适配运输 ClientCaptureRequest/Reply、上述通知和 ACK；request 由宿主按既有查询定义生成，只执行纯客户端采样，不执行历史查询、Callable 或传入函数。纯当前 Reply 与失效元数据形成轻量有序状态检查点，World 纳入截至 stamp 的当前元数据并固定结果/cursor，再处理较新元数据；它不等待 evidenceThrough 的历史载荷/持久 ACK，大载荷路径不能堵住普通当前读。纯历史不发 ClientCaptureRequest。联合查询固定所需两侧数据；只有其定义明确要求截至当前样本的证据前缀时，才用 evidence fence 核对 F，并核验有关非 Driver 版本 G0、绑定/时间。该等待仅约束相关联合查询；缺证据重传/明确 gap，不把独立 RPC 到达当作前缀证明，不将逻辑切面称为物理原子。ClientCaptureRequest/Reply 形状不增加普通/严格模式，协议需求由查询实现确定。见 [World §6](modules/world.md)。

普通联合在接受当前检查点时固定 World 已接收的历史版本，此后新记录不使已固定结果重做；它只声称当时已接收范围。前缀联合中的 G0 只核验本次源证据对账以外的其他相关依赖；正常接收 F 以内的待到证据按 R 纳入，不作为自身并发冲突，纯落盘也不改变 G。

当前检查点的“纳入当前元数据”包括 §5 的未知范围保守覆盖，不要求等待细空间通知补齐。只有最新 stamp 而缺范围时也必须先发布相应保守失效再固定新 cursor；不能在旧空间索引上静默等待。

sections 按整数 Section 坐标读取；单格局部索引为 y*256+z*16+x（各 0..15）。值遵循唯一基础 schema client.sections@1：{ sections: [{ target, revision, base, patches }] }；base 为 null 或 { palette: [{ name, properties }], indices }，indices 为 4096 个 palette 索引或 null（未知格），properties 为字符串属性映射；patches 是按源提交排序的 { index, state }，state 为同形 Block State 或 null（覆盖失效）。Fact/basis 保留真实来源/时间/依据，revision 是不可复用只读版本，不是活 Chunk。仅区域查询固定其请求 Section；小范围 block/self/inventory 不先创建 Section 版本。服务端地形历史与区域读共用必要基底，不各建全加载区快照缓存；未被活动区域读或证据引用的预测不默认追加长期版本链。展开/编码/压缩在关键路径外，跨域不能复用仍会改写/已 detach 的 buffer。无法短边界固定某区域则明确该查询失败/部分覆盖，不影响其他当前读，也不跨 Tick 拼扫冒充同点。见 [World §7](modules/world.md)。

<a id="knowledge"></a>

### 4.2 Driver → 能力：静态游戏知识

```typescript
type HarvestRequirement = {kind: "any"} | {kind: "tools"; names: string[]} | {kind: "unknown"};
type ItemSource =
  | {kind: "craft" | "smelt"}
  | {kind: "block"; block: string; harvest: HarvestRequirement}
  | {kind: "entity"; entity: string}
  | {kind: "trade"; profession: string | null};
interface KnowledgeItem {
  name: string; displayName: string; stackSize: number;
  placeAs: string | null;
  tool: {type: string; tier: string | null; durability: number} | null;
  food: {hunger: number; saturation: number} | null;
  fuel: {ticks: number} | null;
  sources: ItemSource[];
  sourcesComplete: boolean; // false = 数据版本缺少掉落/交易等类别，不是"无法获得"
}
interface KnowledgeRecipe {
  station: "hand" | "crafting_table" | "furnace";
  ingredients: {item: string; count: number}[]; // 一次制作/熔炼的账单；熔炼一条配方只挂一个原料
  output: {item: string; count: number};
  pattern?: (string | null)[][]; // 成形配方的摆格图案（行优先，null=空格）；无形状与熔炼配方省略
  cookTicks?: number; // 熔炼一份产物的烹饪刻数；仅 furnace 配方有
}
interface KnowledgeBlockDrops { items: string[]; harvest: HarvestRequirement }
interface RegistryKnowledge {
  dataVersion: string;
  item(name: string): KnowledgeItem | null;
  recipesFor(item: string): KnowledgeRecipe[];
  blockDrops(block: string): KnowledgeBlockDrops | null;
  canonicalItemName(name: string): string | null;
  entityKind(name: string): "hostile" | "passive" | "player" | "other" | null;
}
```

知识随连接版本固定（minecraft-data / prismarine-registry + 版本固定的熔炼表），不是观察事实：没有 observedAt、没有水位，连接前不可用。方块掉落只取普通挖掘条目（silkTouch!==true），概率掉落保留在列表里而不折算概率；harvest 保留注册表的实际可采工具集合、无工具限制或未知，不用材质顺序猜测。block.harvest、mine、collect 共用可采性判断；自动选用当前合格手持，否则取槽序第一个合格工具。合成、方块、实体、熔炼四类来源齐备（熔炼来自 1.21.11 版本数据表），缺少交易类别，sourcesComplete 仍为 false 如实表达；`fuel.ticks` 来自手工最小燃料表，未收录的物品是 null（未知），不是 0。站别按实际非空格数判定（9 个同种材料的 shapeless 也是 3×3）。组合根把 RegistryKnowledge 注入能力层；Driver 是唯一接触客户端注册表与版本数据表的位置。

生产动作的领域数量见 [能力合同](modules/capabilities.md)：`craft@1` 的 `crafted/produced`、`smelt@1` 的 `produced` 累计本次服务端确认入包量，失败与取消保留确认量和剩余请求，不能从整次库存净差重建。熔炼 `consumed` 指确认投入炉子的材料，`loaded` 指累计装入量；`wait:false` 只装一批可供足燃料的原料，容量不足的余量用 `remaining` 表达。自有身体在世界等待前释放，取货重新申请；祖先委托继续保留祖先身体。

<a id="server-ui"></a>

### 4.3 服务器界面：观察长于操作，操作只做一次

第三方服务器把菜单、NPC 对话、聊天链接和 HUD 都塞进同一条连接。Uina 对它们的立场是：**观察是连接级的，写操作是单次派发**。物品搬运（§4 的窗口 CAS 事务）与菜单按钮不是同一件事，判据也不同。

```typescript
type RichActionKind = "run_command" | "suggest_command" | "show_dialog" | "custom"
  | "open_url" | "copy_to_clipboard" | "change_page" | "unknown";
interface RichTextAction { ref: Ref; kind: RichActionKind; value: string | null; payload: JsonValue | null }
interface RichText { text: string; translate: string | null; style: RichTextStyle; actions: RichTextAction[]; children: RichText[] }
interface UiSlotValue { index: number; region: "top" | "player" | "unknown"; item: ItemValue | null; display: ItemDisplay | null; buttonDigest: string | null }
interface UiSnapshot {
  kind: "none" | "container" | "dialog" | "book";
  screenRef: Ref | null;      // 本次打开的身份，不等于网络 windowId
  uiRevision: number;         // 标题/槽位/光标/Dialog 内容变化才推进
  title: RichText | null; coverage: "complete" | "partial"; unknown: string[];
  container?: { windowType: string; windowId: number; layout: UiLayoutView; slots: UiSlotValue[]; cursor: ItemValue | null; properties: Record<string, number> };
  dialog?: { phase: "play" | "config" | "local"; type: string; title: RichText | null; body: RichText[]; inputs: UiInput[]; buttons: UiButton[]; dismissible: boolean | null };
}
type UiActInput =
  | {kind: "click_slot"; screenRef: Ref; uiRevision: number; slot: number; button: "left" | "right"; buttonDigest: string}
  | {kind: "submit_dialog"; screenRef: Ref; uiRevision: number; buttonRef: Ref; values?: Record<string, JsonValue>}
  | {kind: "activate_text"; eventRef: Ref; actionRef: Ref}
  | {kind: "close"; screenRef: Ref; uiRevision: number}
  | {kind: "book_page"; screenRef: Ref; uiRevision: number; page: number};
type UiActOutcome = "screen_opened" | "screen_closed" | "updated" | "sent" | "unknown" | "unsupported";
```

`ui@1` 与 `hud@1` 是**当前观察**（`facts: ["ui"]` / `["hud"]`，可 watch），不占 Body、不需要窗口会话：服务器用 `/menu`、NPC 或聊天链接打开的界面同样可读。连接未同步时 `ui@1` 直接失败（UNKNOWN），不把"还没同步"读成"没有界面"。

`ui.act@1` 每次只做三件事：校验前态（`screenRef` + `uiRevision` + `buttonDigest` 三者一起失配即 `UI_STALE`，在派发前失败）→ 派发一次真实协议包 → 报告界面是否转移。**outcome 从不等于业务成功**：`screen_opened`/`screen_closed`/`updated` 只说明界面换了或内容变了，`sent` 明确表示"没观察到可归因的变化"（聊天命令类按钮的正常结果）。买没买到、传送没传送、领取没领取，必须另有事实证据。

三条边界是本轮真服钉出来的，不能靠猜：

- **Dialog 的关闭是纯客户端行为**。1.21.11 没有 serverbound 的关对话框包，服务端也无从得知，所以 `{kind:"close"}` 对对话框返回 `UNSUPPORTED_WINDOW`，而不是假装发了一个包。要离开对话框只能用它自己的按钮或让别的界面取代它。
- **书面翻页没有 serverbound 编码**（`book_page` → `UNSUPPORTED_WINDOW`）；`open_url`/`copy_to_clipboard`/`change_page` 同属客户端本地动作，`activate_text` 只执行 `run_command`/`custom`/`show_dialog`，其余如实拒绝。
- **文本动作只能执行"已经观察到的"**。`activate_text` 按 `eventRef`+`actionRef` 查连接级的文本动作登记表（有界 FIFO 128），模型不能自己拼一个动作让 Uina 去执行。旧观察被淘汰后重放会得到 `UI_STALE`。

`custom_click_action` 的线上形态与 minecraft-data 3.117.0 的记录不一致：服务端 codec 是 `Identifier + lengthPrefixed(optionalTag)`，缺失用 `TAG_End(0x00)` 表示；按数据定义直写会被 Paper 判 `DecoderException` 并**直接踢人**。Driver 自己拼包体（`driver/mineflayer/protocol.ts` 的 `encodeAnonymousNbt`），并由真服场景 `pnpm dev:mc:ui` 的双侧证据锁定。

未知布局（`layout.status !== "known"`）的窗口仍然可读——区域标 `unknown`、只读可见；按未验证区域点击会被拒绝，不猜。`ui@1` 只列非空槽：菜单按钮本来就是图标物品，空槽对"读懂结构"没有信息量。

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
  removeRecord(ref: Ref): Promise<{ removed: boolean }>;
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

查询域值由同一 QueryDescriptor 声明，基础值复用 Driver schema；当前采样与可选反馈复用纯函数，不另建传感目录。world@1 的可用性采用 WorldAvailabilityValue，其游戏字段见能力描述。

查询输入在能力装配时按 QueryDescriptor.input 编译，World 的 read/watch 入口统一校验后才分派，null 归一化为 {}。current/static/history 使用同一入口；缺少校验器在装配时明确失败。历史解析只负责坐标、token 和分区等语义，不再复制请求形状校验。

read 按查询类别分派（world.md §8.2）：current 走同步采样并给出 cursor；static（item/recipe 的知识部分）不依赖连接、cursor=null；history（events@1）在提交屏障后由存储读取。events 页形状：

```typescript
type GameEventKind = "chat" | "damage" | "death" | "connection";
interface GameEventRecord { ref: Ref; receivedAt: string; dimension: string | null; payload: JsonValue; evidence: Ref[] }
interface EventGap { ref: Ref; reason: string; after: string | null; through: string | null }
interface EventPage { events: GameEventRecord[]; gaps: EventGap[]; next?: string; after?: string } // next/after 互斥
```

批 9A：events 仅在输入固定 `after`、不是分页输入且本页没有 `next` 时提供历史提交观察 cursor，可经相同 watch 端口等待。最近窗口、分页、尚有 next 的结果 cursor=null。`after` 是持久增量位置，`next` 固定分页窗口，ObservationCursor 是查询失效版本，三者不能混用。当前查询的可等待性以 QueryDescriptor 为准；静态、派生查询和 container.last 不可等待。见 [批 9A 实施](archive/wait-implementation.md)。

read 的切面、cursor/分页、当前与历史降级由 [World §6–§9/§13](modules/world.md) 定义。顺序为 read → 原样交出 cursor → watch → next；changed 后重读，reset 后旧游标失效。Watch 是复查提示，不是事件日志或主动游戏操作。

writeRecord 的 schema 所有权、分区与 CAS，以及 retain/release 的持久性与清理协调，由 [World §10](modules/world.md#retention) 定义。WorldEvidencePort 只给实际持有跨库强引用的可信记录所有者，不注入 guest。Runtime 发布强引用的次序见其 §7.2。removeRecord 是显式删除（`forget@1` 用）：按当前绑定分区删除，记录不存在返回 `removed:false`（由能力转成 NOT_FOUND），删除同样推进记录版本。

`route.plan@1` 是试算，不属于 current/static/history 三类读取：World 按 ref 分派给组合根注入的窄计划端口（`WorldRoutePlanner`，类型见 contracts/world.ts；组合根用 Driver 受控寻路实现），结果 cursor=null 不可等待。World 不依赖 Driver。

`build.plan@1` 同理：不属于三类读取，World 按 ref 分派给组合根注入的窄计划端口 `ConstructionPlanner { plan(query): Promise<BuildPlanValue> }`（类型见 contracts/world.ts；组合根用 Construction 实现——读 Library 的原件字节、经 `region@1` 读现场、复用同一份差异算法），结果 `source:"derived"`、cursor=null、不可等待。**World 不依赖 Construction 或 Library**，Construction 也不依赖 World（用 `world: () => WorldReadPort` 惰性取值，与 `CapabilityDeps.runtime` 同一手法）。

```ts
interface ConstructionTargetCell { at: Vec3; kind: "set"|"clear"|"preserve"|"unknown"; block?: BlockSpec; reason?: string }
interface BuildPlanValue {
  blueprint?: { ref: string; digest: string };
  targets: ConstructionTargetCell[];        // 已加锚点、已变换的绝对格，按 (y,z,x) 排序
  need: Record<string, number>;
  missing: Record<string, number>;
  blocked: { at: Vec3; by: string }[];
  unreachable: { at: Vec3 }[];
  estTicks: number;
}
```

批 12：`surface@1` 消费组合根注入的窄探测端口 `SurfaceProbe`（类型见 contracts/world.ts；组合根用 Driver 客户端本地区块实现站立/露天判据与露天出口查找，G3）。能力层不触碰客户端对象；未加载区块返回 null（未知），由动作按未知处理，不猜空气。

程序 waitUntil 由 [Program §2.4/§7](modules/program.md) 定义；每个 target 保留自己的观察版本，不伪造全局水位。

<a id="programs"></a>

## 6. Program 与 Library：导航

程序模型、文件头、API、逻辑段与共享 worker、容量和退役的唯一规格在 [program.md](modules/program.md)。库操作与蓝图/经验见 [Library](modules/library.md)，能力签名见 [能力面](modules/capabilities.md)。程序不持有库写对象，文本操作使用 library 工具；蓝图由领域能力解释。

旧接口的映射只保留在 [变更历史](changelog.md)，这里不维护兼容别名或第二份完整类型。WorldEvidencePort.retain/release 仍供 Runtime 保护自己记录所需的 World 强引用，与文件库保存无关。

<a id="executor"></a>

## 7. Uina ↔ Executor：确定的受理、查询、结果与事件

截至批9B，正式 WorldDef/Host 交付、Program/Library/等待、程序决策与 continue、替换/抢占已接通。公共类型与实际端口分别见 `contracts/runtime.ts`、`contracts/program.ts` 和 `contracts/executor.ts`；本轮 Runtime schema v5、World history v3、Executor ledger v3，Host journal v4。实现和验证边界见 [批9B实施记录](archive/decision-implementation.md)；这不表示安全介入、反馈与全部玩法已实现。

> **程序入口（2026-10-18）**：程序以 `{ kind: "program"; source: SourceRequest; input }` 提交，`source` 是 `{name}` 或 `{code}`；Runtime 受理时把它解析成确切字节（快照与头注释见 [program.md §3](modules/program.md)）。执行端口不在本文（见 §6 对照表）：段记录只记程序的名字/来源/摘要/快照，不记源码。

```typescript
interface Origin { worldOwner: Ref; activation: Ref; caller?: Ref; invocation?: Ref }
// SourceRequest 引用 Program §7
type Entry = { kind: "call"; selector: Selector; input: JsonValue }
  | { kind: "program"; source: SourceRequest; input: JsonValue };
type Schedule = { kind: "enqueue"; priority?: boolean } // priority：身体/导航申请插队一档（G9）；safety 仍最前，只作用于本次受理的段
  | { kind: "replace_pending"; targets?: Ref[] }
  | { kind: "preempt_current"; expectedRun: Ref };
interface RunRequest { requestId: Ref; entry: Entry; schedule: Schedule }
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
interface RunSummaryBase {
  run: Ref; rootRequestId: Ref; revision: number; segment: Ref | null; record: Ref;
  completion: Pick<CallableDescriptor["completion"], "scope">;
  progress: Progress; progressComplete: boolean;
  control: RunBase["control"];
  unknownEffectCount: number; unknownEffects: Ref[]; unknownEffectsComplete: boolean;
}
type RunSummary = RunSummaryBase & (
  | {phase: "queued" | "running" | "stopping"}
  | {phase: "waiting"; waiting: WaitState; waitingComplete: boolean}
  | {phase: "awaiting_decision"; decision: Ref; reason: string; reasonComplete: boolean; completionRef: Ref}
  | {phase: "finished"; outcome: Outcome; completionRef: Ref;
      error?: {code: string; message: string; messageComplete: boolean}}
);
type RunWaitReply =
  | {kind: "result"; snapshot: Extract<RunSummary, {phase: "finished" | "awaiting_decision"}>}
  | {kind: "changed" | "timeout"; snapshot: RunSummary};

type Acceptance = { kind: "accepted"; requestId: Ref; segment: Ref; snapshot: RunSummary }
  | { kind: "unknown"; requestId: Ref; reason: string }
  | { kind: "not_accepted"; requestId: Ref; code: string; message: string };
type SubmissionLookup = { kind: "found"; requestId: Ref; operation: "submit" | "continue"; segment: Ref; snapshot: RunSummary; completionRef?: Ref }
  | { kind: "cancelled"; requestId: Ref; record: Ref } // 从未受理，持久撤销屏障已建立
  | { kind: "not_found"; requestId: Ref }
  | { kind: "unavailable"; reason: string };
type CompletionSnapshot = Extract<RunSnapshot, { phase: "finished" | "awaiting_decision" }>;
type CompletionReport =
  | { reportKind: "terminal"; snapshot: Extract<RunSnapshot, { phase: "finished" }> }
  | { reportKind: "decision"; snapshot: Extract<RunSnapshot, { phase: "awaiting_decision" }> };
interface DeliveryRef {
  completionRef: Ref; requestId: Ref; run: Ref; segment: Ref; revision: number;
}
type Delivery = DeliveryRef & CompletionReport; // 唯一持久完整报告
type CompletionHeader = DeliveryRef & {recordBytes: number} & (
  | {reportKind: "terminal"; snapshot: Extract<RunSummary, {phase: "finished"}>}
  | {reportKind: "decision"; snapshot: Extract<RunSummary, {phase: "awaiting_decision"}>}
);
interface JsonFileRef { path: string; sha256: string; bytes: number }
type CompletionContent<R extends CompletionReport> =
  | {kind: "inline"; report: R}
  | {kind: "record"; record: Ref} // 正文按需展开，本次未读取/导出
  | {kind: "unavailable"; record: Ref; error: {code: string; message: string}};
type CompletionView =
  | (Extract<CompletionHeader, {reportKind: "terminal"}> & {
      content: CompletionContent<Extract<CompletionReport, {reportKind: "terminal"}>>})
  | (Extract<CompletionHeader, {reportKind: "decision"}> & {
      content: CompletionContent<Extract<CompletionReport, {reportKind: "decision"}>>});
// 受理即工具层的最终回答：模型收到受理句柄（requestId/run/segment），不给 phase，
// 也不给完成快照。完成与决策一律由完成通知投递，正文是按 phase 收窄的展示投影：
// finished 给 outcome/progress/value/error/unknownEffects，awaiting_decision 给
// decision/reason/progress；正文读不到时给 detail=record|unavailable 与截断标志。
// 结构化原件只在完成通知的 event.data，展示投影与原件不互相推导；工具层不带这份正文。
type DeliveryDisposition = "pending" | "committed";
interface DeliveryState {
  delivery: CompletionHeader; disposition: DeliveryDisposition; // 有界投影；完整正文按 completionRef 读
  eligible: boolean; // 从当前 decision/Run 状态派生，不改历史正文
}
// HostCommitReceipt 由 Host 通用交付合同拥有。
type DeliveryReceipt = HostCommitReceipt;
type StopTarget = {run: Ref; request?: never} | {request: Ref; run?: never};
interface StopCommand { requestId: Ref; target: StopTarget }
interface StopReceipt {
  requestId: Ref; target: StopTarget; record: Ref | null;
  intent: "durable" | "unknown";
  control: "stopping" | "stopped" | "unknown"; // 当前内存控制事实，不宣称持久
  snapshot: RunSummary | null;
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
  access: "act"; input: JsonValue;
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
type SafetyInterventionRecord = {
  intervention: Ref; record: Ref; policy: ExactRef;
  trigger: {kind: "lava" | "drowning" | "low_health_damage"; sample: Fact<SelfState>; evidence: Ref[]};
  thresholds: {oxygen: number; healthRatio: number; maxTimeMs: number};
  interruptedRun: Ref | null; startedAt: string; effects: Ref[]; unknownEffects: Ref[];
} & (
  | {finishedAt: null; ended: null; outcome: null}
  | {finishedAt: string; ended: "safe" | "blocked" | "timeout" | "cancelled" | "invalidated"; outcome: Outcome}
);
interface EffectRecord {
  effect: Ref; owner: ControlOwner; operation: Ref; record: Ref;
  facts: DriverExecutionFact[]; verifications: EffectVerification[];
  latest: EffectReceipt; // 本截面的最新判断，不改写原 completion
}
type CallSummary = Pick<CallRecord, "call" | "run" | "segment" | "parent" | "record"
  | "ref" | "implementation" | "access" | "execution" | "outcome">;
type RuntimeRecord =
  | {kind: "run"; record: Ref; value: RunSnapshot}
  | {kind: "segment"; record: Ref; value: SegmentRecord}
  | {kind: "call"; record: Ref; value: CallRecord}
  | {kind: "effect"; record: Ref; value: EffectRecord}
  | {kind: "safety"; record: Ref; value: SafetyInterventionRecord}
  | {kind: "completion"; record: Ref; value: Delivery}
  | {kind: "stop"; record: Ref; value: StopReceipt & {intent: "durable"; record: Ref}};
type RecordFormat = "auto" | "inline" | "file";
type RecordReply = {kind: "inline"; record: RuntimeRecord}
  | {kind: "file"; record: Ref; recordKind: RuntimeRecord["kind"]; file: JsonFileRef};

interface ExecutorClient {
  inspect(): Promise<ExecutionSideStatus>; // 类型由 Executor §2.3 拥有；不等游戏连接
  attach(origin: Origin): Promise<OwnerState>;
  heartbeat(attachment: Ref): Promise<OwnerState>;
  setOwnerGate(request: { requestId: Ref; attachment: Ref; gate: OwnerGate; closed: boolean; expectedRevision?: number }): Promise<OwnerGateReceipt>;
  submit(origin: Origin, request: RunRequest): Promise<Acceptance>;
  lookup(requestId: Ref): Promise<SubmissionLookup>;
  read(run: Ref): Promise<RunSummary>;
  readRecord(ref: Ref, options?: {format?: RecordFormat}): Promise<RecordReply>; // 固定 record/completionRef；对象身份 ref 则先固定最新截面
  listCalls(run: Ref, filter: { parent?: Ref; cursor?: string }): Promise<{ items: CallSummary[]; next?: string }>;
  list(filter: { activeOnly: boolean; cursor?: string }): Promise<{ items: RunSummary[]; next?: string }>;
  wait(run: Ref, options: {afterRevision?: number; timeoutMs?: number}, signal: AbortSignal): Promise<RunWaitReply>;
  stop(command: StopCommand): Promise<StopReceipt>;
  continue(request: { run: Ref; decision: Ref; requestId: Ref; entry: ContinuedEntry; environment?: "inherit" | "current" }): Promise<Acceptance>;
  pendingDeliveries(page?: {cursor?: string; limit?: number}): Promise<{items: DeliveryRef[]; next?: string; total: number}>; // cursor 是 rowid 键集；total 是积压总数（与分页同条件）
  readDelivery(completionRef: Ref): Promise<DeliveryState>;
  settleDelivery(completionRef: Ref, receipt: DeliveryReceipt): Promise<void>;
  events(listener: (event:
    | {kind: "run_changed"; run: Ref; revision: number; completionRef?: Ref}
    | {kind: "safety_changed"; intervention: Ref; record: Ref}) => void): () => void;
}

```

RunSummary/CallSummary 是已提交完整记录的有界投影，省略 progress/unknownEffects 时用完整性字段标明。它们不独立结算。CompletionReport/Delivery 保存唯一固定正文，CompletionHeader 投影其小型头；recordBytes 是完整 RuntimeRecord 的 UTF-8 JSON 字节数。

CompletionView 的 inline/record/unavailable 只说明本次正文读取形态，不改变报告 outcome。RecordReply 的 file 只用于显式完整记录读取。不可变 record/completionRef 精确读原件；run/segment/call/effect 身份引用先固定最新已提交 record，再返回该截面。列表/调用树仍独立分页，完整对象统一 readRecord；不再公开三种专用完整读取方法。

Runtime 唯一维护受理/撤销、decision 消费、停止、门、记录及交付处置，见 [Runtime](modules/runtime.md)。Executor 唯一维护 façade、受理出口、IPC、Host 对账与文件读出，见 [Executor](modules/executor.md)。Host 回执类型与真实性见 [Host 持久交付回执](../runtime/delivery-receipts.md)。

ExecutorClient 不把 observe、目录或 Library 变成 Runtime 职责；三者是同一 IPC 上各自所有者的分派。来源、attachment 和当前调用身份来自可信接入，不由模型/guest JSON 授权。

### 7.1 可信组合根注入

只服务 Runtime / Driver / 组合根的本地合同，不接受模型 JSON 注入；函数是可信本地实现，不跨执行域传输。程序的执行端口不在本文：`ProgramPort` / `ProgramCapacity` 见 [program.md §7](modules/program.md)。

```typescript
interface CheckpointSchemaDefinition { ref: ExactRef; value: JsonSchema } // 预留：本仓库 0 引用
interface DriverExecutionFact {
  effect: Ref; operation: Ref; contract: ExactRef; observedAt: string;
  kind: "intent" | "dispatch" | "receipt" | "cleanup";
  dispatch: "not_sent" | "sent" | "unknown";
  completion: "met" | "not_met" | "unknown"; evidence: Ref[];
  detail?: JsonValue; // 操作声明的原始回执/缺口，不是 guest 自述
}
interface RecordTicket { instance: Ref; sequence: number }
interface DriverExecutionSink {
  record(fact: DriverExecutionFact): RecordTicket | null;
  ensureDurable(ticket: RecordTicket): Promise<void>;
}
interface RuntimeRecordBarrier {
  capture(): RecordTicket;                  // 无事实时为该实例 sequence=0，不是未知回退值
  flushThrough(through: RecordTicket): Promise<void>;
}
```

DomainCheckpoint 的 schema 由领域模块普通导出，组合根校验同 ref 唯一；descriptor.checkpoints 只声明可消费的领域 schema，不声明则不接收领域检查点。ProgramCheckpoint 不进入这个注册表；续段根程序只读 value，来源在记录中保留，子程序须显式传参。两类不隐式转换；原生入口不能因程序 checkpoint 而跳过自己的输入/领域验证。能力在自身实现中核验目标；Runtime 不注入通用目标 verifier。`ctx.verify` 只调用 effect 原要求指定的领域核验者并追加效果判断。

**效果核验器（批13，G4 关闭）**：核验器由组合根随能力工作包注入 `EngineOptions.verifiers`（`ReadonlyMap<ExactRef, EffectVerifier>`），不预建通用框架：

```typescript
interface EffectVerifier {
  check(effect: { effect: Ref; operation: Ref; facts: DriverExecutionFact[] },
        world: WorldPort, input: JsonValue):
    Promise<{ completion: "met" | "not_met" | "unknown"; evidence: Ref[]; reason?: string }>;
}
```

`ctx.verify(effect, verifier, input)` 与程序桥 `mc.verify(effect, verifier, input)` 走同一注册表：未注册/效果无记录 → NOT_FOUND；核验器不派发动作，只按已记录事实 + 当前世界读数给出追加判断（读不到保持 unknown，不冒充 met/not_met）；结果以 `EffectVerification` append-only 追加到原 Effect（新 record ref 的新不可变截面），原 completion 与历史报告不改写，返回 receipt 的 completion 取核验结论、dispatch 沿用原事实。首个注册者：`verify/dig@1`（body.dig@1 效果的目标格现在是空气吗），运行事实 detail 自批13 起携带 `target`。

DriverExecutionSink 由 Runtime 注入并绑定可信 ControlOwner（run 或 safety）；EffectRecord.owner 来自该绑定，不接受 guest 自填。安全介入只补齐已有 safety 所有者的记录，不生成虚构 Call/Segment。`record` 同步接收不可变事实、非阻塞入队，返回本 writer 实例的 ticket，**不代表持久或服务端 ACK**；无法接收时返回 null、锁存 recorder fault 并封闭新副作用（故障后 `record` 也不再写入）。

**写前意图（§5.3）**：`kind:"intent"` 是派发前已持久的意图，证明"本次业务操作可能已经发出"，不证明服务端已执行；恢复时只剩 intent 一律按 `unknown` 对账，不能判 `not_sent`。`ensureDurable(ticket)` 是唯一派发前屏障，由 RecordQueue 等 DB worker 的真实 `onDurable` ACK 实现：**不可安全重放的业务写必须先落 intent 并等它提交，才允许派发**。ACK 丢失无法证明 intent 是否落盘，必须上报 `unknown`；只有 `record` 返回 null（本次没有 intent）才允许判 `not_sent`。intent 已落盘却明确决定不派发时追加终态 `cleanup(not_sent, not_met)`，恢复侧才不会把"只剩 intent"当成崩溃窗口。撤销与清理路径本身不等磁盘，这不构成业务写绕过派发前屏障的理由。

**持久挂起与唤醒（G33）**：跨进程存活的状态只有 `awaiting_decision`。根原生能力在"写不可重放的那一半已经落地"之后抛挂起请求，Run 停在 `awaiting_decision`，`runs.decision` 里多出 `wait`：

```typescript
interface DurableSuspendRequest {          // 能力交给 Runtime 的请求形状
  reason: string; checkpoint: JsonValue;
  recheckAfterMs: number; deadlineAfterMs: number;
  progressed?: boolean;                    // 自上次挂起以来世界是否真的推进了
}
interface DecisionRequest {
  code: "NEEDS_DECISION"; reason: string;
  checkpoint: ProgramCheckpoint | null; origin: ProgramOrigin;
  wait?: DurableWait;                      // 带它 = 等世界条件，不是等 Host 决策
}
interface DurableWait {                     // Runtime 落库的形状
  attempts: number; earliestCheckAt: string; lastProgressAt: string; deadlineAt: string;
  resume: { selector: Selector; input: JsonValue }; checkpoint: JsonValue;
}
```

`earliestCheckAt` 被夹在 `deadlineAt` 之内；`lastProgressAt` 只在能力声明 `progressed` 时前移，所以静默预算是"多久没进展"而不是"挂了多久"。唤醒扫描在 `recover()` 之后、ready 之前起，定时器 `unref` 并随 `shutdown()` 清理；**认领一律走 `continue()`**，因此 stop 优先、并发只认领一次、没有合法 Owner 绑定就不唤醒都由既有受理 CAS 承担。恢复入口是"同一能力 ref + 原输入"，检查点经 `CallContext.checkpoint` 交回；换能力的续段（`CHECKPOINT_INVALID`）与子调用挂起（`SUSPEND_NOT_ROOT`）一律拒绝。明确拒绝的唤醒只记一次并停止重试（资格类瞬时拒绝除外）；能力反复 wake→check→wait 时按 16 次预算终成 `unknown`（`WAIT_BUDGET_EXHAUSTED`）。`OwnerState` 因此增 `activation`：重启后 Host 用新代次，扫描器必须取当前 binding。

**安全干预时间线（§6.7）**：`SafetyInterventionRecord.timeline` 记录 `hazardObservedAt / interruptIssuedAt / controlRetiredAt / bodyGrantedAt / firstActionAt / finishedAt`，全是 ISO 墙上时钟（跨进程可比），缺的字段如实 `null`，不拿相邻时刻冒充。

`RuntimeRecordBarrier.capture` 固定已收到前缀 H，`flushThrough(H)` 保证 ≤H 材料已提交，否则明确失败；材料丢失的故障不得返回成功。DB worker 的 ACK 水线必须覆盖本批全部材料（`record_log` 幂等跳过同样算已提交），否则 `flushThrough` 的等待者永不 resolve。ticket 不跨实例或重启比较，H 之后的材料不纳入原终结。Driver 关闭 Promise 完成前，已产生的清理派发与可得回执必须先入 sink；未来回执可晚到并追加核验。完整结算见 [Runtime 详细设计](modules/runtime.md)。

## 8. 模块独立验证的最小要求

| 所有者 | 用公开合同验证，避免测试内部结构 |
| --- | --- |
| Callable/Program | 同输入经直接调用、程序内 call、保存程序调用返回同领域值；嵌套不二次 submit；read 视图无写口且捕获旧写代理仍被拒绝；progress 不升级为效果证据 |
| Runtime/Body | 独立 Body 分支 FIFO、委托复用、自等待局部失败；回调等待保持身体、退出释放；旧 scope/window/反馈不可复活；Effect 屏障先于终结 |
| Driver | 输入/点击参数、版本及预期槽位/光标物品、帧代次/新鲜度与停止屏障；真实服务端另验效果，mock 不替代 |
| World | read/游标同一点、读/订阅交界不漏唤醒、换源/重连/旧游标返回 reset；schema/CAS/证据写入受唯一所有者约束 |
| Library | 三类条目的命名/目录/路径安全；蓝图 Raw/Target/Project 与 AirPolicy；经验弱链接；明文错误；蓝图不携带现场进度 |
| Uina/Executor | ID 持久化后 IPC；顶层只回受理，完成报告至少一次持久交付；真实 Host 回执与停滞恢复；过滤过时 decision；重复不重放游戏 |

这些是接口实现的验收要求，尚未执行的项目不能写成通过。解析/存储类、SQL 表、插件内部算法、完整原版函数目录及延迟常数由模块设计和实验决定；它们不应阻挡另一模块基于以上公开合同开发。

（历史批次的状态性附注——如批7 时期的执行子集说明——已随批次收口移出本文：现行合同以正文与所属 modules 文档为准，当时的边界与证据见 [archive/](archive/README.md) 各实施记录与 changelog。）

## 批 25 实现说明（2026-11-05，多世界自治 v3 第一阶段）

会话生命周期唯一拥有者是 `worlddef/session-controller.ts` 的 `SessionController`；身份纯函数在 `worlddef/session-identity.ts`。工具面新增 `session` action（status/list/connect/disconnect），World 启用默认不入服，`observe/run/chat/runs` 在无活动会话或管理切换中返回 `NOT_CONNECTED`（not_started）。工具入参与结果：

```typescript
type ConnectTarget =
  | { host: string; port?: number; username?: string; slot?: string; world?: { id: string; revision?: string } }
  | { server: string; username?: string; slot?: string; world?: { id: string; revision?: string } };
interface SessionStatus {
  state: "disconnected" | "connecting" | "syncing" | "connected" | "disconnecting" | "faulted";
  active: null | {
    profileId: string; visitId: string; target: ProfileIdentity;
    connection: "connecting" | "syncing" | "ready" | "disconnected" | "faulted";
    actualUsername: string | null; actualUuid: string | null;
    worldAssociation: "explicit" | "endpoint_default";
    executorPhase: "starting" | "ready" | "faulted" | "closing" | "closed";
    actionsAllowed: boolean; ownerGates: string[];
    history: "opening" | "ready" | "unavailable";
  };
  operation: null | { kind: "connect" | "disconnect" | "close"; id: string };
  lastError: { code: string; message: string } | null;
  settingsPath: string; libraryPath: string;
}
interface ProfileIdentity {
  endpoint: { host: string; port: number };
  principal: { kind: "offline"; username: string; slot: string };
  world: string; worldRevision: string;
}
```

- **身份**：`profileId = sha256(["mc-profile-v1", canonicalHost, port, "offline", username, slot, world, worldRevision])`，只允许本系统生成的 64 位 hex 进入磁盘路径。`identity.json` 不可变（schemaVersion + identity），重访内容不一致即 `PROFILE_IDENTITY_CONFLICT`；`observed.json` 保存可验证登录观测（visitId/at/username/uuid），UUID 仅在协议来源可得时记录，矛盾即拒用旧 Profile。未显式给 world 时用 `endpoint:<host>:<port>` + revision `default` 并标记 `endpoint_default`（不是已证实相同世界）。
- **数据根**：`ownershipDir`（稳定 MC 根，Windows 目录 Job 跨 Profile 唯一）+ `sessionDataDir`（`sessions/<profileId>/`：executor.db、runtime.db、runs/、exports/）+ `sharedDataDir`（world-history.db 与 `library/`）。`settings.json` 位于稳定根，每次 connect 重读（defaultUsername、servers 别名含可选 world 关联）。
- **退役三事实**：`Executor.close()` 返回 `{ process: "retired"|"unknown", ownership: "released"|"held", runtime: "clean"|"unclean"|"unknown" }`；只有 `process=retired && ownership=released` 才允许新执行域，未证实即 `SESSION_BLOCKED`（重试 connect/disconnect 是唯一恢复渠道，无时间兜底）。`runtime=unclean` 只影响旧 Run 的恢复结算。`EXECUTION_DOMAIN_UNRETIRED` 保留给 Runtime 发起的 retire_required 路径。
- **连接回执**：`connection.wait` RPC 等 ClientHost 首个终态（ready/断开/故障）并返回 `{state, username, uuid, reason}`；`Executor.open()` 成功不再冒充入服成功。入服超时按当前事实判 `CONNECT_FAILED`。
- **错误码**：`SESSION_BUSY`（管理槽占用）、`SESSION_BLOCKED`（旧执行域未证实退役）、`NOT_CONNECTED`（无活动会话）、`CONNECT_FAILED`、`IDENTITY_MISMATCH`、`PROFILE_IDENTITY_CONFLICT`、`SETTINGS_INVALID`。
- **离线资料**：`describe` 直读静态 Catalog（无需执行域）；`library` 收敛为宿主常驻唯一写入口（`save.from` 经活动 Executor 的 Runtime RPC 与 Profile 根快照直读核验来源，无会话 NOT_CONNECTED）；Companion 对 `library/` 只读，Library 变更经 `program.changed` 窄通知撤销 Runtime 程序缓存；`program/validator.ts` 离线校验复用同一 program worker compile 路径。Body 端点 `bodyId = minecraft:<visitId>`，随 visit 注册与摘除。旧布局迁移以 executor.db 为身份锚点，一次完成（v3 M4 的最小闭环）；批26 剩 RuntimeArchiveReader、profile 查询参数、离线 saveFromRun、交付 envelope 与完整 M4。
