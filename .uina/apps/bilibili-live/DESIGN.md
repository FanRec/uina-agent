# Bilibili 直播接入应用 (`bilibili-live`) 架构设计规范

**状态**：基线规范 (v1.0-RC1)  
**作者**：Antigravity & Uina Team  
**定位**：Uina 官方数字主体直播感知与交互应用底座  
**物理路径**：`.uina/apps/bilibili-live/`  

---

## 1. 架构愿景与第一性原则 (Vision & First Principles)

### 1.1 连续数字主体 vs 机械问答反射弧 (Continuous Subject vs Chatbot Reflex Arc)
传统的 AI 聊天机器人是典型的**刺激-反应机器（Stimulus-Response Reflex Arc）**：
- 它是一个死寂的黑盒，只有当外界输入（`Input`）触发时才被动产生一个输出（`Output`）；
- 它假设每个输出都必须严格拥有一个单一的输入“父亲”（1:1 因果绑定），输入是什么就必须回答什么。

而在 Uina 的定义中，数字主体（初奈）是一个**开放式、连续心智生命体（Continuous Living Entity）**：
- **多源感官场共存（Multi-Source Sensory Field）**：同一时刻，线下的搭档在说话、B 站直播弹幕在流淌、背景音乐在播放、游戏画面在演进、自身有内在的心智状态与情绪。
- **自主注意力（Autonomous Attention）**：主体不是对所有输入照单全收的“复读机”，而是拥有注意力的掌控权。主体自主决定关注什么、忽略什么、合成什么、何时发声、何时沉默。
- **表达的自然涌现**：主体的每一句言语和每一个动作，是其在那个时间点面对**全部感知场与自我意识综合涌现的结果**，绝非对单一输入的机械反射。

### 1.2 时间线共时性 vs 机械因果绑定 (Temporal Co-presence vs Causal Binding)
在真实的直播录像（VOD）中，没有人会给主播说的每一句话打上数据库外键（`reply_to_danmaku_id`）。回看录像之所以能理解主播在说什么，是因为**时间线的共时性**——在那个时间点，屏幕上的弹幕正是那些，主播的言语自然流淌于那个情境中。

- **视口是视网膜，不是数据库**：视口展现的是当前时刻主体眼前的物理景象；
- **拒绝强加因果（No False Causality）**：系统绝不能自作聪明地搞“回合感知快照”去盲目猜测主体是在回哪条弹幕。
  - **反模式论证**：线下搭档在控制台问初奈：“接下来玩什么游戏？”，初奈回答：“玩星露谷物语吧”。此时若视口里恰好有一条观众弹幕“主播玩星露谷吗”，系统若强行把该弹幕作为前因打桩进会话，就是彻头彻尾的**虚假因果（False Causality）与指鹿为马**！
- **事实落盘原则**：
  1. 滚动的未读普通弹幕流属于**易失感官（Volatile Sensory Stream）**，仅存在于内存，绝不持久化进 `session.jsonl`（防止 5 分钟撑爆 100k Tokens）；
  2. 高价值事件（SuperChat、舰长、大额礼物）进入 **App 私有持久化日志（Durable App Journal）**，防止重启崩溃遗忘；
  3. 只有当主体产生了**显式外部动作（Side-Effect Actions）**，如发送弹幕（`send`）、标记已处理（`mark_handled`），其动作参数与执行结果才会作为不可辩驳的确定性事实 100% 落盘进 `session.jsonl`。

---

## 2. 三层存储与长连接去重拓扑 (Three-Tier Storage & Deduplication)

为了彻底解决“普通弹幕撑爆 Session”与“高价值 SC 崩溃丢失/重连重复”的矛盾，系统严格划分三层数据持久化边界：

```text
Bilibili Network
       │
       ▼
Volatile Protocol Adapter (blivedm-ts: client.ts / open-live.ts)
       │
       ▼
[sourceEventKey 幂等去重] ─── (已存在则丢弃，防重连重放)
       │
       ▼
LiveEventBuffer
       │
       ├── 1. 普通弹幕/小礼物 (Volatile Sensory Stream) ──→ 内存环形队列 ──→ ViewportScheduler ──→ Pure render()
       │
       └── 2. 高价值/待办事件 (SC / Guard / 大额礼物)
               │
               ▼
       App Durable Journal (.uina/apps/bilibili-live/data/events.jsonl)
               │
               ▼
       mark_handled({ eventId }) ─── (本地状态流转，更新 events.jsonl)
               │
               ▼
Uina 显式动作: send(...)
       │
       ▼
       3. 主体行为与因果事实 ───→ Core Session (data/session.jsonl)
          (包含 attempt / outcome: succeeded | failed | unknown)
```

1. **第一层：Core Session (`data/session.jsonl`)**
   - **职责**：Uina 核心主线事实。
   - **存储内容**：用户的输入、主体的回答、主体调用的 Tool Call（`send`、`mark_handled`）及其返回的真实 Outcome。
2. **第二层：App Durable Journal (`.uina/apps/bilibili-live/data/events.jsonl`)**
   - **职责**：App 私有持久化。
   - **存储内容**：未处理的 SuperChat、舰长、达到阈值的大额礼物、以及它们的 `handled` 状态。
   - **双标识体系（Identity & Alias）**：
     - `sourceEventKey`：外部业务唯一键（如 `bilibili:sc:<sc_id>`），用于长连接重连时**严格幂等去重**；
     - `durableId`：内部持久化 UUID；
     - `alias`：面向大模型的短别名（`sc_1`、`gd_1`、`gf_1`）。
   - **写入机制（Append-Only）**：
     - 新待办到达时追加完整事件记录：
       `{"op":"sc","record":{"durableId":"uuid","sourceEventKey":"bilibili:sc:123","alias":"sc_1","uid":123,"uname":"孙八","price":30,"message":"加油","handled":false}}`
     - 主体调用 `mark_handled` 时追加轻量状态更新记录：
       `{"op":"handled","id":"sc_1","handledAt":1726839250000}`
     - 压缩归档时追加计数器元数据：
       `{"op":"meta","lastCounters":{"sc":100,"gd":10,"gf":5,"dm":500}}`，保证短 ID 序列永不回退复用。
   - **崩溃恢复与重启算法**：
     - 启动时顺序回放 `events.jsonl`，后到达的更新记录覆盖前序事件的 `handled` 状态；
     - 筛选出所有 `handled === false` 的项目装载进内存待办队列；
     - 恢复短 ID 计数器，保证重启后分配的新 ID 绝不与历史 Session 记录冲突。
3. **第三层：Volatile Sensory Timeline (RAM Buffer)**
   - **职责**：瞬时感知流。
   - **存储内容**：近期的普通弹幕、低于价值阈值的高频小礼物。仅保留在内存，关机即焚。
   - **分流铁律**：只有价值 $\ge$ `pendingThreshold`（默认 1000 电池 / ￥100）或大航海才进入 `events.jsonl`；普通小礼物仅在内存流中行内合并，绝不写磁盘。

---

## 3. 认知学与视口工效学 (Cognitive Science & Ergonomics)

### 3.1 单一流式视网膜 (One Unified Stream)
坚决摒弃将视口切碎为“上轮焦点”、“当前氛围”、“最新弹幕”等人工碎片。人类主播面对的弹幕姬永远只有**一个单一、连贯的流式窗口**。

### 3.2 双时钟模型与 Viewport Scheduler
彻底解决“`render()` 不能修改状态”与“`minResidenceMs` 必须计算真正‘在视口中展示的时长’”之间的矛盾。

#### 双时钟契约 (Dual Clocks)
- **`wallTimeMs` (`Date.now()`)**：仅用于人类可读时间格式化展示（如 `[14:20:05]`）与日志落盘审计。严禁用墙上时间计算时长或超时（防 NTP 校时、休眠唤醒时间跳变）。
- **`monotonicTimeMs` (`performance.now()`)**：单调时钟，专门驱动 `minResidenceMs`、超时判定、心跳年龄与指数退避计算。

#### 状态机与纯函数解耦
- **`ViewportScheduler.advance(monotonicNow)`**：
  - 由新事件摄入或内部 LCD 刷新触发；
  - 维护 `visibleSlots: VisibleSlot[]`；
  - 每条弹幕首次被排入可见视口时，记录 `visibleSinceMonotonic = monotonicNow`；
  - **视网膜免死金牌**：当视口满需要淘汰时，若 `monotonicNow - slot.visibleSinceMonotonic < minResidenceMs`，**锁定保护，禁止淘汰**！只有驻留满 `minResidenceMs`（默认 10,000ms）的最旧槽位，才允许被新弹幕替换出视口。
- **`render(tier)` 纯函数**：
  - **100% 只读** `visibleSlots` 与 `pendingAssets`；
  - 无论连续调用多少次，只要底层未 advance，输出严格幂等、零副作用。

### 3.3 近似 Token 预算 (Approximate Budget)
- **诚实工程设计**：零运行时 npm 依赖下，无法内嵌各模型私有 Tokenizer。
- **物理硬边界**：
  - `maxViewportChars`：视口最大字符数（默认 600 字符）；
  - `maxItems`：视口最大条目数（默认 20 条）；
  - `approximateBudgetTokens`：粗略 Token 估算（默认 200 Tokens，中文字符 1:1，ASCII 1:0.25）。

### 3.4 诚实聚合流水线 (Honest Aggregation Pipeline)
**铁律：必须先全文聚合，展示时再截断**。若先截断再聚合，会导致第 51 个字符不同的两条长弹幕被错误合并！

```text
Raw Text
  ↓
1. Trim & Normalize (全文标准化)
  ↓
2. Canonical Aggregation (基于全文比对聚合，在 aggregationWindowMs 内维护 count 与 uniqueSenders)
  ↓
3. Viewport Selection (调度进入可见视口槽位)
  ↓
4. Display Truncation (展示时按 maxDanmakuLength = 50 截断并附 "...")
  ↓
5. Sanitize & Wrap (<data> 转义包裹)
  ↓
6. Pure Render / Tool Output
```

- **区分消息数与用户数**：
  - 若 `uniqueSenders.size > 1`：展示为 `<data>李四 等 8 人: 666 (x12)</data>`；
  - 若 `uniqueSenders.size === 1` 且 `count > 1`：展示为 `<data>李四: 666 (连发x12)</data>`；
  - 若 `count === 1`：展示为 `<data>李四: 666</data>`；
  - 绝不因单人刷屏而伪造“等 N 人”的虚假事实。

### 3.5 全出口不可信数据污染防御 (Tainted Egress Defense)
所有源自 B站的文本（用户名、弹幕内容、SC 留言、礼物名称、房间标题、主播昵称）一律标记为 **TAINTED**。

- **统一转义规范**：
  ```typescript
  export function sanitizeUntrustedText(text: string): string {
    if (!text) return "";
    return text
      .replaceAll("<", "＜")
      .replaceAll(">", "＞")
      .replaceAll("\r\n", " ")
      .replaceAll("\n", " ")
      .replaceAll("\r", " ");
  }

  export function wrapUntrustedData(label: string, text: string): string {
    return `<data ${label}>${sanitizeUntrustedText(text)}</data>`;
  }
  ```
- **全出口覆盖（5 大通道）**：
  1. `render()` 视口：待办与弹幕全部转义包裹；
  2. `recent()`：返回的历史弹幕全部转义；
  3. `status()`：房间标题、主播名全部转义；
  4. `mark_handled()`：返回的已处理描述全部转义；
  5. `ctx.wake()`：**彻底切断动态不可信文本**！固定发送零动态常数字符串（见 4.4 节）。

### 3.6 Prompt Cache 保护与三档视口退火
- **`hidden`（0 Token）**：未连接或应用停用时返回 `""`，严格常态退火；
- **`ambient`（~10-20 Tokens）**：
  - 仅包含低频稳定元数据：
    `[B站直播 6号房 | 🟢 在线 | 弹幕: 12条 | 待办: 1条SC, 0条上舰]`
  - 严禁包含高频跳动的秒级时间戳或人气值，100% 保护大模型 Prompt Cache；
- **`expanded`（有界预算，默认约 200 Tokens）**：纯数据监控液晶屏。

### 3.7 弹幕过滤与降噪机制
- **默认中立（`filterKeywords: []`）**：默认不替主体做主观审查，避免“点赞到多少玩恐怖游戏？”等正常弹幕被误杀。用户可按需在 `config.json` 中配置；
- **纯表情过滤（`ignoreEmojiOnly`）**：可选过滤纯表情弹幕；
- **展示截断（`maxDanmakuLength: 50`）**：仅在展示阶段截断超长小作文。

---

## 4. 协议适配层与网络鲁棒性 (Protocol & Network Robustness)

### 4.1 适配器定位
- **`client.ts`（Web 端客户端）**：易变适配器（Volatile Adapter），依赖 WBI 签名与逆向网关；
- **`open-live.ts`（官方开放平台）**：基于 HMAC-SHA256 的官方开发者协议，生命周期更稳固。

### 4.2 协议安全边界
- `MAX_PACKET_BYTES`：单帧上限 1MB；
- `MAX_DECOMPRESSED_BYTES`：解压后上限 5MB（防 Zip-Bomb）；
- `MAX_NESTING_DEPTH`：解压嵌套深度上限 3 层；
- 容错解析：未知 `op`、畸变 JSON 绝不导致 Node 进程崩溃。

### 4.3 强事件安全唤醒机制（模式二）
- **杜绝 Prompt Injection**：
  - `ctx.wake` 绝对不携带不可信用户名或弹幕内容；
  - 固定使用零污染常数字符串：
    `"[bilibili-live: high_priority_event_available]"`
- **唤醒与感知闭环**：
  ```text
  [收到 SC / 舰长 / 大额礼物]
         │
         ▼
  [写入 LiveEventBuffer，幂等追加 events.jsonl]
         │
         ▼ (满足唤醒门槛)
  [ctx.wake("[bilibili-live: high_priority_event_available]")]
         │
         ▼
  [Core 触发 turn.prepare] ───► [JIT 调用 render("expanded")]
                                       │
                                       ▼
                         [模型睁眼看到视口内转义后的 SC 待办，自然回应]
                                       │
                                       ▼
                         [调用 mark_handled({ eventId: "sc_1" }) 消除待办]
  ```

---

## 5. 完整数据模型契约 (`src/types.ts`)

```typescript
export type LiveRoomStatus = "online" | "offline" | "round" | "unknown";

export interface EventTime {
  readonly wallTimeMs: number;       // Date.now()，人类时间
  readonly monotonicTimeMs: number;  // performance.now()，持续时间
}

export interface DanmakuRecord {
  readonly id: string;               // 短 ID (dm_1)
  readonly uid: number;
  readonly uname: string;
  readonly text: string;             // 完整原始文本
  readonly time: EventTime;
  count: number;
  uniqueSenders: Set<number>;
  firstSender: string;
}

export interface SuperChatRecord {
  readonly durableId: string;        // 内部持久化 UUID
  readonly sourceEventKey: string;   // 外部幂等去重键: "bilibili:sc:<id>"
  readonly alias: string;            // 模型视口短别名: "sc_1"
  readonly uid: number;
  readonly uname: string;
  readonly price: number;            // 人民币元
  readonly message: string;
  readonly time: EventTime;
  handled: boolean;
  handledAt?: number;
}

export interface GuardRecord {
  readonly durableId: string;
  readonly sourceEventKey: string;   // "bilibili:guard:<uid>:<level>:<time>"
  readonly alias: string;            // "gd_1"
  readonly uid: number;
  readonly uname: string;
  readonly guardLevel: number;
  readonly giftName: string;
  readonly time: EventTime;
  handled: boolean;
  handledAt?: number;
}

export interface GiftRecord {
  readonly durableId: string;
  readonly sourceEventKey: string;   // "bilibili:gift:<uid>:<giftId>:<time>"
  readonly alias: string;            // "gf_1"
  readonly uid: number;
  readonly uname: string;
  readonly giftId: number;
  readonly giftName: string;
  readonly price: number;            // 电池数
  count: number;
  readonly time: EventTime;
  handled: boolean;
  handledAt?: number;
}

export interface VisibleSlot {
  readonly recordId: string;
  readonly fullText: string;
  readonly firstSender: string;
  readonly count: number;
  readonly uniqueSendersCount: number;
  readonly arrivalMonotonic: number;
  visibleSinceMonotonic: number;      // 首次展示在视口的单调时间
}

export interface LiveAppState {
  connectionStatus: "disconnected" | "connecting" | "connected" | "reconnecting";
  roomId: number | null;
  roomTitle: string | null;
  streamerName: string | null;
  roomStatus: LiveRoomStatus;
  popularity: number;
  lastHeartbeatTime: number;
}

export interface ViewportConfig {
  approximateBudgetTokens: number;   // 默认 200 Tokens
  maxViewportChars: number;          // 默认 600 字符
  maxItems: number;                  // 默认 20 条
  minResidenceMs: number;            // 默认 10000 ms
  showTimestamps: boolean;           // 默认 true
  aggregationWindowMs: number;       // 默认 20000 ms
}

export interface FilteringConfig {
  filterKeywords: string[];          // 默认 [] (中立)
  ignoreEmojiOnly: boolean;          // 默认 false
  maxDanmakuLength: number;          // 默认 50 字
}

export interface GiftsConfig {
  pendingThreshold: number;          // 默认 1000 电池 (￥100)
  aggregationWindowMs: number;       // 默认 10000 ms
}

export interface NetworkConfig {
  autoReconnect: boolean;            // 默认 true
  requestTimeoutMs: number;          // 默认 5000 ms
  maxReconnectDelayMs: number;       // 默认 30000 ms
}

export interface StorageConfig {
  dataDir: string;                   // 默认 "./data"
  journalCompactionThreshold: number;// 默认 500 行
}

export interface WakeupConfig {
  wakeOnSuperChat: boolean;          // 默认 true
  superChatMinPrice: number;         // 默认 0 元
  wakeOnGuard: boolean;              // 默认 true
  wakeOnGiftThreshold: number;       // 默认 1000 电池 (￥100)
}

export interface LiveAppConfig {
  defaultRoomId?: number;
  sessdata?: string;
  biliJct?: string;
  buvid3?: string;
  openPlatform?: {
    accessKeyId: string;
    accessKeySecret: string;
    appId: number;
    code: string;
  };
  viewport?: Partial<ViewportConfig>;
  filtering?: Partial<FilteringConfig>;
  gifts?: Partial<GiftsConfig>;
  network?: Partial<NetworkConfig>;
  storage?: Partial<StorageConfig>;
  wakeup?: Partial<WakeupConfig>;
}
```

---

## 6. 门面工具动作契约 (`src/index.ts`)

门面工具名：`bilibili-live`

### 1. `connect`
- **Schema**：`{ "roomId": { "type": "number", "description": "直播间房号（可选，留空使用配置）" } }`
- **凭据安全铁律**：严禁在 Schema 中包含任何 `sessdata` / `biliJct` 参数。模型仅表达意图，凭证留在本地配置文件或环境变量中，绝不写入 `session.jsonl`。

### 2. `disconnect`
- **Schema**：`{}`。断开长连接并收起视口为 `hidden`。

### 3. `status`
- **Schema**：`{}`。返回经过 `sanitizeUntrustedText` 转义后的连接状态、房间标题、主播名及待办统计。

### 4. `mark_handled`
- **描述**：标记指定的待办事件（`sc_*`, `gd_*`, `gf_*`）已处理完毕。
- **收敛规则**：仅支持待办资产，普通弹幕（`dm_*`）不属于待办，不建立人工数据库因果。
- **Schema**：`{ "eventId": { "type": "string", "description": "待办事件短 ID (如 sc_1, gd_1, gf_1)" } }`（必须参数）。

### 5. `send`
- **Schema**：`{ "message": { "type": "string" }, "roomId": { "type": "number" } }`。
- **三态结果模型**：返回 `succeeded` / `failed` / `unknown`。

### 6. `recent`
- **Schema**：`{ "count": { "type": "number" } }`。返回经过 `wrapUntrustedData` 转义后的近期弹幕历史（不消耗视口）。

### 7. `clear`
- **收敛规则**：仅清空易失弹幕感知缓冲池，严禁提供 `all` 参数。待办资产只能通过 `mark_handled` 显式流转。

---

## 7. 外部配置文件规范 (`config.json`)

```json
{
  "defaultRoomId": 6,
  "sessdata": "",
  "biliJct": "",
  "buvid3": "",

  "viewport": {
    "approximateBudgetTokens": 200,
    "maxViewportChars": 600,
    "maxItems": 20,
    "minResidenceMs": 10000,
    "showTimestamps": true,
    "aggregationWindowMs": 20000
  },

  "filtering": {
    "filterKeywords": [],
    "ignoreEmojiOnly": false,
    "maxDanmakuLength": 50
  },

  "gifts": {
    "pendingThreshold": 1000,
    "aggregationWindowMs": 10000
  },

  "network": {
    "autoReconnect": true,
    "requestTimeoutMs": 5000,
    "maxReconnectDelayMs": 30000
  },

  "storage": {
    "dataDir": "./data",
    "journalCompactionThreshold": 500
  },

  "wakeup": {
    "wakeOnSuperChat": true,
    "superChatMinPrice": 0,
    "wakeOnGuard": true,
    "wakeOnGiftThreshold": 1000
  }
}
```

---

## 8. 运行时要求

1. **Node.js**：`>= 22.18.0`（原生 `WebSocket`、`node:crypto`、`node:zlib`、`globalThis.fetch`）；
2. **纯 TypeScript**：`erasableSyntaxOnly`（无 TS `enum`，仅字面量联合与 `const`）；
3. **零运行时 npm 依赖 (Zero runtime npm dependencies)**；
4. **质量门禁**：`pnpm typecheck` 0 错误，CRAP 复杂度 < 30。
