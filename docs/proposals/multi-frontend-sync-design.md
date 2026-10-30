# 多前端同步基础设施设计

状态：**v1 已于 2026-10-30 施工完成**（正文进投影、协议+SyncClient、网关、浏览器薄面、一致性测试、verify:gateway）。Stage 2/3 仍未授权施工。
所有"既有接缝"均为 2026-10-30 源码核实结果。
2026-10-30 自查修订一轮：删除 6 处投机协议面与 2 处防御性兜底（动机见 §7/§8），协议收敛为 5 个消息 kind。
2026-10-30 施工修正两处（以源码证据为准）：①网关落位从扩展层改为组合根应用模块——扩展 pi API 拿不到 `HostEventRecord.at`、`snapshot()`（队列）、`interrupt` 与 operator 来源标注，经扩展激活是功能降级（见 §3.3）；②`host.submitText` 增加可选 `source` 参数（additive）——意图归属标注需要它且无替代接缝（见 §7）。

## 0. 问题还原

Uina 的本质结构：**一个主体，一份权威状态**（canonical history + journal）；**N 个观察者**（TUI、stdio、未来的 web/手机），它们生命周期独立、传输各异、信任各异。观察者与主体之间只有两个动词：**观察事实** 与 **表达意图**。同步基础设施就是把这两个动词搬到线上，此外不加任何东西。

五条第一性推导，其余一切设计都从它们落下来：

1. **同步不是共识问题，是投递问题。** 单写者（主体）+ 只增历史（append-mostly，rewind/compaction 是有界例外）意味着不需要 CRDT/OT/锁。投递只有三种失败：晚加入、丢消息、消费慢。三者的解汇成一条规则：**连接生命周期 = 同步生命周期**。晚加入 → 连接建立时发快照；怀疑丢消息或状态可疑 → 重连；消费慢 → 服务端断开它。修复路径只有一条：**重连即快照**。快照必须随时可取且廉价——controller 的 `view()` 是派生态不是累积态，天然满足。
2. **区分事实与信号。** 可重放的真相（回合、工具结果、压缩终态）丢了能由快照兜底；瞬时信号（provider_retry、进度）丢了就丢了、重放反而错误。协议只保证事实流的有序送达，不为瞬时信号发明可靠性。
3. **意图是请求，不是写操作。** 远端发来的是"请主体做某事"的请求；主体校验、排序（mailbox）、执行，结果以事实形式回流给所有人。归属（哪个前端发的）随意图旅行，用于显示与策略，**永不用作权威**。由此不存在分布式编辑，不存在冲突解决。
4. **投影大脑只有一份。** 线上传事实词表（`RuntimeEvent` 形状）与视图快照，不是为 web 另造的 DTO；客户端跑与 TUI 相同的 `PresentationController` 摄取代码。为第二种前端造第二套形状必然漂移成两个大脑。
5. **协议是产品，传输是一次性的。** 消息语义不得携带任何 WebSocket 专属特征；连接内可靠性由 TCP 保证，协议层不重复建设。

## 1. 既有接缝（已核实）

| 接缝 | 现状 |
| --- | --- |
| Host 面 | `send`/`submitText`/`pushInput` + `subscribe`/`onEventRecord`（`HostEventRecord{at,event}`）+ `snapshot()`；派发单线程同步（`src/host/host.ts`） |
| 事件形状 | `HostEvent = RuntimeEvent \| notice`，全部纯数据可 JSON（`src/host/events.ts`、`src/runtime/events.ts`） |
| 客户端同步引擎 | `PresentationController`：`ingest`/`replaceAll`/`view`/`subscribe`/`dispatch`/`onIntent`，`PresentationChange`（append/update/replace）本身就是现成的增量协议形状（`src/presentation/controller.ts`） |
| 节点可序列化 | `PresentationNode = TurnNode \| ThinkingNode \| ToolNode`，纯数据字符串 id（`src/presentation/projection.ts`） |
| 历史回放 | `ingestReplay({entries, auxiliary})`：journal → 展示重建（未来历史分页直接复用，v1 不用） |
| 意图归属 | `InputSource` 已有 `channel?`/`actor?{id,label,relation}` 字段，网关标注零核心改动（`src/core/types.ts`） |
| 第二 Surface | `SurfaceAdapter{attach(controller)}` 已留位未用（`src/presentation/surface.ts`） |
| 边界 | `extensions/` → `presentation/` 不被边界规则禁止；`presentation/` 平台中立（对 host/session/core 仅 type-only），意味着它可以原样打包进浏览器 |

结论：**v1 不需要改 host，不需要动内核八概念。** 唯一需要的 presentation 新接缝见 §3.2。

## 2. 协议（v1）

信封统一为 `{ v: 1, kind: string, ... }`。只有两个动词族：observe 与 intent。全部消息 5 个 kind：

```text
客户端 → 网关
  hello      { auth, client, capabilities }   // token、客户端标识、能力声明、版本协商
  intent     { intent, source }               // PresentationIntent + InputSource 归属

网关 → 客户端
  snapshot   { view }                         // PresentationView JSON（transcript+trajectory+session）
  fact       { record }                       // HostEventRecord，按派发顺序透传
  error      { message }                      // 诊断行（鉴权失败/意图被拒/协议违约），通常伴随断开
```

规则：

- **握手即快照。** `hello` 的唯一回答是 `snapshot`（通过鉴权与版本检查后）；失败则 `error` + 断开。没有独立的 welcome/ack 往返。
- **无游标、无缺口检测。** TCP 内消息有序不丢；网关转发是进程内同步调用，也不会丢。连接内"丢消息"在 v1 的传输与派发模型下无法发生——为它建序号与补洞机制是防御不存在的事件。状态可疑的唯一处理是重连。
- **慢客户端：服务端断开。** ws 背压（`bufferedAmount`）超过上限即断开；客户端自动重连，重连即拿到新快照。不需要缓冲 flush、不需要服务端主动 resync 消息。
- **意图 fire-and-forget。** 无 ack、无去重——v1 客户端无从重试（没有 ack），TCP 内不重复，因此重复提交的流程不存在。结果以事实回流：客户端提交后在 `turn_start` 里看到自己的文本。将来某个客户端要加重试时，幂等性随重试机制一起加。
- **未知 kind 在版本匹配时 = 协议违约**：`error` + 断开。响亮失败，不静默吞（版本握手已挡住新旧混跑，剩余的未知就是 bug）。
- **图片**：按握手时 `capabilities.images` 决定内联 base64 或剥离；localhost 默认不剥离。

被删掉的 v1 协议面及其加回点见 §8 留门清单。

## 3. 模块落位

### 3.1 `src/presentation/sync.ts`（中立，单文件）

消息类型 + 编解码校验 + `SyncClient` 状态机：`connect → hello → snapshot(restore) → tail(ingest)`，任何疑虑 → 断开重连。传输是注入的双工接口，无任何真实 socket。协议类型与客户端在同一文件：它们本来就互相定义，拆开只会制造一次跨文件跳转。

### 3.2 presentation 唯一新接缝：`restore(view)`

远端快照是视图空间，而现有 `replaceAll` 吃 journal 事实（事实空间）。需要给 controller 增加一个从 `PresentationView` 重建投影的入口：重置投影与轨迹、播种 known-id 集合（后续事实按 id 走 update 不重复 append）、可选 `continueTurn`。中立、纯内存、可单测。这是本设计对 presentation 的唯一增量。

### 3.3 网关：`src/cli/frontend-gateway.ts`（组合根应用模块，施工修正）

原设计放扩展层；施工前源码核实推翻了该假设：扩展 pi API 不暴露 `HostEventRecord.at`（controller.ingest 依赖它）、`host.snapshot()`（队列快照）、`interrupt` 与 `submitText` 的 operator 来源标注——经扩展激活是功能降级而非风格差异。网关改为组合根直达 UinaHost 公开面，策略在网关模块内收口，宿主仍不感知"远端"概念：

- 鉴权：token 每次启用重生成（落数据目录 0600），sha256 后 timingSafeEqual 比较；
- 传输无关核心（`FrontendGatewayCore`）+ ws/http 适配器：hello 即快照（握手期事实进有界缓冲、快照后立即排空；join 时刻的 `host.snapshot()` 作为会话状态基线），背压超限断开（重连即快照）；
- 远程面明确拒绝本地语义（斜杠命令、队列撤回）；意图携带网关归属 `source.channel`/`actor` 进 journal；
- 传输：`ws`（既有依赖），默认绑 127.0.0.1，非回环绑定打印安全提示；
- ~~能力分级 / 游标 / 历史分页~~：按 §8 留门清单未施工。

### 3.4 TUI 与现有消费者

零改动。TUI 保持进程内特权路径（既定决策）；gateway 纯增量，不启用即不存在。

### 3.5 富槽位（v2，不在 v1）

`notify`/`setWorking` 目前只到达进程内挂载的 UI（`attachExtensionUI` 单数）。v1 远端消费 `notice` 事实 + `snapshot.busy`/工具事实推导活动；富 toast 镜像推迟到把扩展 UI 贡献提升为事实的契约改动（动 `extensions/ui-contract.ts`，不动核心）。原则：**远端必须看到的东西必须走事实流或快照；只到进程内 TUI 的机制一律要提升为事实才能出主机。**

## 4. 安全

从第一性原则看，远端提交文本 = 在这台机器上执行任意命令。网关不是"UI 同步端点"，是一扇 RCE 门：

1. 默认关闭；显式启用才监听；
2. 默认绑 127.0.0.1；出本机（隧道/局域网）是显式行为，届时加设备配对；
3. token 每次启用重新生成，只落盘 0600；**一个 token = 完全 operator**——v1 不做 observer/operator 角色分级：接入者只有你自己的设备，authZ 没有对象就是没有需求；
4. 策略全部在网关模块（组合根应用层）——核心永远不感知"远端"概念，内核八概念不变。

## 5. 测试策略

1. `SyncClient` 状态机测试：join（含流中 join——工具调用进行中接入，快照后续流按 id 结算不重复）、断开重连、版本不匹配、未知 kind 违约；
2. gateway ↔ SyncClient 在内存双工传输上跑全链路（不 mock 消息，走真实协议字节）；
3. 慢客户端：注入背压，验证服务端在超限时断开、客户端重连后收敛；
4. 意图路径：校验失败拒绝、归属标注（`InputSource.channel`/`actor`）落在 journal；
5. **一致性测试（设计的诚实性保证，已实施 `tests/frontend-sync-consistency.test.ts`）**：同一 `HostEventRecord` 序列，直连 controller 与 gateway+SyncClient 两条路径产出逐字节相同的视图（transcript+trajectory；session 是各面自维护的状态缓存，单独断言）；含流中 join（快照恢复开启段、续流不重段）；
6. 一条 localhost ws 冒烟（真 socket + 真进程 + 真 provider fixture，已实施 `pnpm verify:gateway`）。

## 6. 阶段路径

- **Stage 1（已于 2026-10-30 施工完成）**：v1 全量——正文进投影（`AssistantNode`，view 含完整正文）、`presentation/sync.ts`、`controller.restore(view)`、组合根网关、`src/web-client/` 薄面（`SurfaceAdapter` 第一个实现者，原生 ESM 零 bundler）、一致性测试与 `pnpm verify:gateway`。
- **Stage 2（手机/web 成为常用面时）**：last-N 快照 + history 分页（复用 `ingestReplay`）、presence（谁在看）、推送通知、重连退避。协议加法，不改已有 kind。
- **Stage 3（仅当主体需要自己的生命——daemon）**：宿主进程从 `cli/app.ts` 组合根提出为受管服务。TUI 若那时改卫星，只是把进程内路径换成 localhost 传输、跑同一个 SyncClient——传输替换，不是重设计。

每阶段的丢弃物：零。

## 7. 反设计（明确不做）

1. **CRDT/OT** —— 单写者，意图即请求，不存在并行编辑。
2. **第二套 DTO/REST transcript API** —— 双脑漂移之源；线上一律事实词表 + 视图快照。
3. **游标/缺口检测/服务端逐客户端回放缓冲** —— TCP + 进程内同步派发下连接内丢消息不可能；重连即修复。这是本轮自查删掉的最大一件。
4. **应用层心跳** —— ws 传输层自带 ping/pong。
5. **意图 ack 与去重窗口** —— 没有 ack 就没有重试，没有重试就没有重复；防御一个不存在的流。
6. **序列化失败兜底（剥离字段 + resync）** —— `JSON.stringify` 对纯数据是全函数；循环引用/BigInt 是生产者 bug，必须经 `onError` 响亮失败，不能被网关兜成"看起来正常"的快照。
7. **protobuf/二进制 schema** —— JSON + 版本字段 + 边界校验足够；出现测量出的带宽需求再议。
8. **通用 RPC/多路复用通道、核心/内核改动** —— 两动词之外不加机制；presentation 唯一新接缝 `restore(view)`。施工申报偏差：`host.submitText` 增加可选 `source?: InputSource` 参数（additive，缺省行为不变）——远端意图归属（`InputSource.channel`/`actor` 进 journal）需要它且无替代接缝。

## 8. 留门清单（删掉的东西从哪里加回来）

每一项都有明确触发条件，加回均为协议加法、无破坏性变更：

| 被删项 | 触发条件 | 加回位置 |
| --- | --- | --- |
| `fact.cursor` 序号 | daemon 时代需要"重连不重放全量"（持久游标 = journal 行号） | fact 消息加字段；hello 带 lastCursor |
| `history` 分页动词 | 客户端需要回看本会话之外的历史/长会话 last-N | 新 kind，复用 `ingestReplay` |
| observer/operator 分级 | 第一台低信任设备真实接入 | hello 策略字段 + 网关校验 |
| `ack`/SlotAck 镜像 | 富槽位提升为事实（`ui-contract` 契约改动） | 新 kind |
| 意图幂等 | 某客户端真实引入意图重试 | intent.id + 网关短窗去重 |

## 9. 风险与未验证项

- 长会话 join 的首包体积：数千节点时视图 JSON 可达 MB 级。v1 在 LAN 上接受；这是"重连即全量快照"的自觉代价，v2 以 last-N + history 分页收敛。
- `details?: unknown` 等开放载荷字段理论可携带不可序列化的值；现状 broker 产出均为纯数据。若真实发生，那是生产者 bug，走 `onError` 响亮失败——不加网关兜底。
- `ws` 是新增 npm 依赖（约 200 行接线）；若不接受依赖可用 node:http + 手写 upgrade，但不建议。
- 真实弱网/移动端行为未验证（本设计未施工）；断言仅覆盖协议形状，不覆盖体验。
