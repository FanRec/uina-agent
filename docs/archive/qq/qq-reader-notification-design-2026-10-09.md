# QQ World 阅读、关注与通知重构设计（终审落地规格）

2026-10-11 发现能力扩展：经独立授权，单一 qq facade 新增 people/files/fetch/search/expressions，由九个领域动作扩展为十四个；前文九动作冻结数量仅适用于阅读通知重构基线。新增动作不改变消费、通知或原九动作合同，接口与验收见 [发现与资源设计](../../proposals/qq/qq-world-discovery-resource-design-2026-10-11.md)。

2026-10-11 修复实施更新：本次已按 A01～A17 授权方案完成源码修复与自动化验收。最新合同见 §10；与前文或 R1～R7 冲突时，以 §10 为准。逐项证据见 `../qq-world-acceptance.md`，真实 QQ 连接不可用，平台验收保留未验证。

日期：2026-10-11（Asia/Shanghai / GMT+08:00）  
修订：第十三轮终审完整封关（消除流水线拓扑自欺、修正冷启动游标矛盾、补齐配置继承、清除伪语义判定与多模式优先级对齐）；2026-10-11 第十四轮实现级裁定 R1~R7（见 §9，与 `qq-reader-notification-devplan-2026-10-11.md` 配套）；2026-10-11 P6 收尾实现落地封关（9 积木 facade 上线，旧 6 action/游标机制/12 observe scope 退役，R2 裁剪清单执行完毕，运行事实见 `docs/current-runtime.md` QQ World 章节，执行记录见 devplan P6 节）。  
前序版本：2026-10-09 第五轮稿（过度工程与 Core 侵入方案废弃）；2026-10-11 第七~十二轮修订案（四项事实边界、9 工具收敛、动静双态、1~2s 短防抖、延迟渲染、串行消费锁与能力动机解耦）。  
状态：开发设计规格，经架构、人性化、源码底层事实与 LLM 认知审查终审定稿；遵循 Reality-First 与 Unix 语义原子化原则。  
源码核查基线：当前工作树 / HEAD `31afc79`，保留 QQ 修复提交 `716d1f4` 的全部底层能力。  
适用项目：`E:/Uina/Uina`。

---

## 1. 核心定位：Uina 的感知与行动器官（能力与动机严格解耦）

QQ 是 Uina 在数字世界中的主动社交空间，是她的**感知器官与行动器官**，绝非一个单纯由“外部消息事件驱动”的被动响应客户端。

### 1.1 主体性与边界哲学（Capability vs Motivation）
1. **能力与动机严格分离（Crucial Boundary）**：
   - **QQ World 仅提供真实的感知与行动能力**（看收件箱、读消息、发消息、轻互动、预约提醒、处理申请、维护形象）；
   - **QQ World 绝不负责产生社交动机**：Uina 为什么突然想起某个朋友、何时主动问候、如何维持长期关系，属于上层数字主体自身的认知机制与前台活动（Subject Persona / Memory / Cognitive Goals）。
   - **坚决不把人格、情感打分、关系决策器或聊天行为工作流塞进 QQ World**。保持工具原子性与纯粹性，绝不破坏工具组合哲学。
2. **主动使用高于被动响应**：
   外部通知只是外界唤起她的途径之一，绝非她访问 QQ 的唯一途径。即使没有任何新消息，Uina 也可以出于自身意图主动调用收件箱巡视好友近况、回顾过往约定、主动发起问候，或在一段对话后主动放下关注。
3. **选择权与放下权**：
   Uina 拥有完全的注意力自主权：
   - 可以选择关注谁、忽略谁；
   - 可以选择“已阅不回”；
   - 可以面对刷屏闲聊明确说“先跳过这段，不看了”；
   - 可以在交谈完毕后主动解除置顶关注，转身专注其他事务。
4. **通知是弱刺激，不是强指令**：
   通知小纸条陈述事实和可用入口，不替主体产生社交目的，不要求她例行巡检，也不强迫她立即回复。

### 1.2 动静结合的双态在场模型与有效跟读判定
人在使用 IM 软件时，自然存在“在后台守护（静）”与“坐在窗口前聚焦交谈（动）”两种完全不同的状态。Uina 的数字主体性同样映射为这一**动静结合的双态模型**：

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       【静 · 日常守护 (Background Perception)】               │
│  - 状态：主体在思考或执行其他任务，QQ 在后台静默运行。                          │
│  - 启动基准：进程重启后默认无焦点 (focus = [])，严格处于静默守护态。             │
│  - 触发：仅在某个会话从未读 0 变为 >0 时（首条新消息），经 1~2s 短防抖弹出一张纸条。│
│  - 纸条：呈现【全局所有待处理会话态势】（一眼掌握全局，绝非单个会话孤立提醒）。      │
│  - 规则：群聊增量闲聊完全静音；直接互动与私聊沉寂复苏特许穿透升级。                  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ 主体决定介入：会话期聚焦该窗口
                                       │ qq_inbox({ focus: ["p1"] })
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       【动 · 专注在场 (Focused Digital Presence)】            │
│  - 判定：effectiveFollow = isFocused(target) && resolvedPushMode(target)     │
│          === "follow" (自动展开 inherit 继承)                               │
│  - 状态：视线聚焦在指定会话，如同人坐在电脑前盯着打开的聊天窗口。              │
│  - 行为：新消息像流一样主动连续交付正文，提供持续、即时的沉浸式对谈在场感。      │
│  - 降压：若向主体派发的未消费深度超预算（约 14,000 字），自动退让为摘要小纸条。 │
│  - 自主退出：交谈完毕，主体仅需 qq_inbox({ focus: [] }) 移开视线，即可自然停止  │
│              连续跟读，退出专注态；且绝不隐式修改底层持久化的 push.mode 偏好！  │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 关键生命周期法则：
1. **`focus`（会话期内存注意力状态）**：
   - 代表“主体当前这会儿是否正看着该窗口”。
   - **不作为跨启动永久偏好持久化**：系统重启后 `focus` 自动初始化为空 `[]`（无焦点）。主体绝不会在开机瞬间遭遇由于昨晚遗留的 focus 而突发正文刷屏，完全符合人类“开机/醒来时视线未在任何窗口上”的真实认知习惯。
2. **`push.mode`（持久化通知偏好）与继承解析**：
   - 永久记录在 `qq-control.json` 中（`off` / `digest` / `follow` / `inherit`）。
   - **解析规则**：`resolvedPushMode(target) = target.push.mode === "inherit" ? account.push.mode : target.push.mode`。
3. **有效跟读派生公式**：
   $$\text{effectiveFollow} = \text{isFocused}(\text{target}) \land (\text{resolvedPushMode}(\text{target}) === \text{"follow"})$$
   清空 focus 自然切断跟读流，且双方配置互不隐式篡改。

---

## 2. 行为真实性：双轨解耦事实架构与消费串行锁

系统必须保持行为真实性（Behavioral Truth），绝不产生语义层面的自欺。**通知感知与正文消费是两套正交轨道，绝非单向串联流水线**：

```text
                        [received] (平台底层入站事实)
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
     【通知感知轨】                     【正文消费与裁决轨】
     (外界提醒主体)                     (主体主动操作)
            │                                 │
     [notice_enqueued]                        ├─► [body_dispatched]  (顺序阅读/跟读)
     (唤醒占位入队)                            │   (派发至模型上下文)
            │                                 │
            ▼                                 └─► [backlog_skipped]  (主动放下积压)
     [notice_committed]                            (跳过指定未读区间)
     (通知提交会话主干)
```

1. **`received`（平台入站事实）**：
   消息或外部事件已被本地底层连接接收并持久化写入 `qq-facts.jsonl`。不代表通知已发出，更不代表主体已知晓。
2. **通知感知轨：`notice_enqueued` 与 `notice_committed`**：
   - **`notice_enqueued`**：通知唤醒占位信号已构建并进入 Subject 输入邮箱。**严禁直接宣称为已送达**。
   - **`notice_committed`（对应 Core `input_settled`）**：该通知占位已被 Subject 真正取出、执行 `render()` 动态求值并写入会话记录（`store.appendInput`）。**诚实定义为通知已进入会话历史，绝不宣称模型已理解**。
3. **正文消费轨：`body_dispatched` 与 `backlog_skipped`**：
   - **`body_dispatched`（正文派发消费书签）**：QQ World 成功将正文输出交付给运行时（无论是 `qq_read` 工具返回还是 `follow` 自动正文注入）。**书签精确定义为 QQ World 已完成派发的消费边界（throughSeq）**。
   - **`backlog_skipped`（主动放下事实）**：主体调用 `qq_skip` 显式裁定放下某段未读积压，日志记录跳过区间与原因，更新本地书签与重新核算剩余待处理计数。

### 2.1 会话级消费串行锁（Per-conversation Mutex）
`Math.max` 单调比较只能防止书签向后倒退，**不能解决并发交错读取导致的正文重复派发**。系统引入轻量会话消费串行锁：
- **同会话串行化**：对同一会话的正文消费动作（`qq_read`、`follow` 自动正文派发、`qq_skip`），必须通过 QQ World 内存中的**会话级异步串行锁**（`withConversationLock(convRef, fn)`）严格排队执行。
- **持锁时序规范**：
  1. 获取该会话的消费锁；
  2. 重新读取该会话**最新落盘的 `throughSeq` 书签**；
  3. 严格基于最新书签截取未派发的增量消息（`seq > throughSeq`）；
  4. 构造成果并输出派发；
  5. 推进书签：`throughSeq = Math.max(throughSeq, targetSeq)` 并持久化；
  6. 释放消费锁。
- **并发安全性**：
  若主体调用 `qq_read` 的同时外部到来了新的 `follow` 消息，后到的操作必须等待前序操作完全释放锁并推进书签后，才能接续读取剩余区间，**彻底根绝消息被重复切片、重复派发的竞态条件**。
- **操作内部异常隔离与单调推进**：
  若操作在派发输出前自身发生未捕获异常，锁照常释放，书签原封不动。 Core 在收到 `turn_aborted` 时，已通过工具返回写入 journal 的结果依然有效，书签遵循 `Math.max` 绝不盲目向后倒退。

---

## 3. 冻结的设计决定

| 概念 | 规格裁定 | 消除的过度设计 / 冗余点 |
| :--- | :--- | :--- |
| **内核隔离性** | **Core 零侵入**。QQ 的书签推进、跳过记录、关注列表与推送偏好全部归 QQ World 自治管理，在 `qq-facts.jsonl` 与 `qq-control.json` 内部事务闭环，不修改 Core 任何一行代码。 | 彻底废除旧版回执侵入 Core、跨进程分布式事务的过度设计。 |
| **能力与动机解耦** | **QQ World 只做纯粹的感知与行动器官**。负责真实交互；绝不向 World 塞入人格打分、情绪指数、好感度或动机决策器。动机完全归属上层主体。 | 消除把低层设备适配器与高层数字生命动机混为一谈的过度工程。 |
| **会话级消费串行锁** | 同一会话内部的 `qq_read`、`follow` 与 `qq_skip` 严格串行加锁执行，持锁后重读最新书签。`Math.max` 充当底线防退守卫。 | 消除并发交错读取导致的正文重复派发与游标撕裂。 |
| **有效跟读与 Focus 生命周期** | - **`focus` 为会话期内存注意力状态**：系统重启后默认无焦点（`[]`），杜绝开机自动正文轰炸；<br>- **`push.mode` 为持久化配置（支持 inherit 继承）**；<br>- **`effectiveFollow = isFocused && resolvedPushMode === "follow"`**。 | 解决 focus 与 follow 的语义冲突与继承失效问题，确立冷启动注意力基线。 |
| **正文派发书签（`body_dispatched`）** | 书签诚实定义为 **QQ World 已完成派发的消费边界**。遵循单调递增原则，消除强行跨层断言宿主物理提交或模型认知的自欺行为。 | 解决虚构交付事实与回合打断盲目回滚引发的灾难。 |
| **通知精细化（闲聊静默与私聊沉寂复苏）** | - 记录 `lastNotifiedSeq`，避免同一批内容重复提醒；<br>- **群聊增量闲聊严格保持静默**；<br>- **直接互动（@/戳/引用）与【私聊沉寂间隔复苏（如 $\ge 10$ 分钟）】特许穿透触发**。 | 彻底解决“一条旧未读导致对方数小时后发来的重要私聊被永久静默”的严重漏报问题，去除不可落地的“意图识别”假象。 |
| **工具箱设计** | **严格收敛为 9 个高内聚领域积木**（见 §4）。按完整意图划分，读写合一。诊断接口 `qq_status` 仅作为扩展内部自检与 CLI 命令，不注册为主体模型工具。 | 废除 36 个微观工具，废除把诊断接口混入模型工具箱的做法。 |
| **顺序阅读与自由漫游分离** | - `qq_read`：顺序推进正文并移动 `body_dispatched` 书签。<br>- `qq_browse`：纯只读探索任意时空历史、点查指定消息、展开复杂富文本，**绝对不移动书签**。 | 杜绝模型想看历史却误推进当前待读位置的风险。 |
| **1~2 秒短脉冲防抖** | 常规消息首次到达（0→1）与直接互动/私聊沉寂复苏**统一采用 1~2 秒短脉冲防抖**。用于合并人类连打断句（打字喘气合并），消除等待迟钝感。 | 彻底淘汰旧版迟钝的 10 秒防抖，告别“等得花儿都谢了”的人造延迟。 |
| **延迟渲染唤醒占位（Lazy Render Latch）** | 复用 Core 现役的 `AgentInput.render` 接缝（`src/agent/loop.ts`）：保证新鲜度与空退役；遵守 FIFO 队列公平原则，不向 Core 索求跨来源抢占特权。 | 消除强行要求 Core 实现复杂队列节点替换的过度设计。 |
| **内部单调 seq 与模型可读 ID 解耦** | - 模型交互与工具入参使用友好引用（如 `'m77'`）；<br>- **内部逻辑（书签、排序、翻页、跳过区间）严格基于自增整数 `seq` 计算**，绝对不靠字符串字典序推导前后关系。 | 根除使用 `'m77'` 字符串比对大小导致的字典序灾难。 |
| **保留断线覆盖诚实性（Coverage Honesty）** | 删除常驻后台扫描器，但**保留覆盖事实标记**。长连接断线重连若发现平台历史 seq 不连续，显式标记该区间为 `gap_detected`，绝不谎称本地历史是平台无损历史。 | 既消除后台死锁与轮询开销，又杜绝了向主体隐瞒丢消息的自欺行为。 |
| **精准跳过与一键抹平** | `qq_skip` 参数中 `throughMessageRef` 设为可选，默认值为 `"latest"`。支持部分跳过重新计算剩余量，也支持一键抹平到当下。 | 消除原描述中“无论跳到哪一律归零”的绝对化语义错误。 |
| **诚实冷启动（基线封存与游标初始化）** | 系统加载现有历史时，记录 `initializationBaselineSeq`。基线之前的历史标记为“封存积压（archived_backlog）”；`throughSeq` 初始化对齐至基线，使活动阅读器只承接新鲜消息。 | 既杜绝冷启动 9999+ 积压海啸，又保证未读统计对历史的绝对诚实。 |

---

## 4. 9 个高内聚领域原子积木规格

所有工具参数对象设置 `additionalProperties: false`。绑定账号由 World 运行时自动注入，模型无需每次重复填写 `account`。

### 4.1 `qq_inbox` —— 收件箱与注意力控制（读写合一）
查看当前所有会话的待处理动态，并可顺带调整会话期置顶关注或提醒偏好。

- **语义法则**：
  - **`focus` 为会话期注意力状态**：仅在当前运行进程生命周期内保持生效，进程重启后重置为空 `[]`。
  - **参数省略严格表示“不修改”**：不传 `focus` 保持原关注不变；不传 `push` 保持原偏好不变。清空关注必须显式传 `focus: []`。
  - **跟读派生生效**：列表中每个会话如实返回其当前 `effectiveFollow: boolean` 状态（由 `isFocused && resolvedPushMode === "follow"` 实时派生计算）。
- **参数**：
  ```json
  {
    "type": "object",
    "properties": {
      "focus": {
        "type": "array",
        "items": { "type": "string" },
        "description": "可选。原子替换当前置顶关注会话列表；传空数组 [] 表示放下所有关注；省略表示保持不变。"
      },
      "push": {
        "type": "object",
        "properties": {
          "target": { "type": "string", "description": "会话引用或 'account'（全局）。" },
          "mode": { "type": "string", "enum": ["off", "digest", "follow", "inherit"] },
          "filter": { "type": "string", "enum": ["all", "direct", "inherit"] },
          "pausedUntil": { "type": "string", "description": "ISO UTC 时间，暂停提醒直至此时刻；null 解除暂停。" }
        },
        "required": ["target"],
        "description": "可选。调整推送偏好；省略表示保持不变。"
      },
      "pendingOnly": { "type": "boolean", "default": false, "description": "仅查看有新待处理消息的会话。" },
      "limit": { "type": "integer", "default": 20, "minimum": 1, "maximum": 50 }
    }
  }
  ```
- **关键返回**：
  - 会话列表（名称、类型、新待处理条数 `pendingCount`、封存历史条数 `archivedCount`、最新发言时间、短预览、有效推送模式、是否置顶关注、`effectiveFollow`）。
  - 当前全局账号信息、置顶关注列表与全局推送偏好。

### 4.2 `qq_read` —— 顺序正文消费
从上次阅读位置接续往下读一屏消息，加持消费锁并在成功派发后单调推进 `body_dispatched` 书签。

- **语义法则**：
  - 在 `withConversationLock` 内串行执行：持锁重读最新书签，截取增量，成功派发后推进 `throughSeq`。
  - 与 `follow` 自动正文共用同一书签与同一消费锁，彻底杜绝交错重复。
  - 单条超长文本（>2,000 字）自动折叠首尾并标注 `hasMoreSegment: true`，不阻塞书签推进，主体按需用 `qq_browse` 展开。
- **参数**：
  ```json
  {
    "type": "object",
    "properties": {
      "conversationRef": {
        "type": "string",
        "description": "目标会话。若当前仅关注了一个会话，可省略此参数直接读该会话。"
      },
      "limit": { "type": "integer", "default": 20, "minimum": 1, "maximum": 100 },
      "budgetChars": { "type": "integer", "default": 14000, "minimum": 512, "maximum": 32768 },
      "includeMedia": { "type": "boolean", "default": false, "description": "是否随消息内联展开可读图片。" }
    }
  }
  ```
- **关键返回**：
  - 格式化消息正文流（发言者、引用关系、撤回标记、分段）。
  - 交付范围说明（当前交付至哪条消息 ID、会话剩余待处理条数）。

### 4.3 `qq_skip` —— 放下与跳过积压
明确放下指定区间的未读消息，记录跳过事实，持锁更新书签与重新核算剩余待处理计数。

- **语义法则**：
  - **部分跳过**：指定 `throughMessageRef`（如 `'m70'`）时，内部解析为对应的 `targetSeq`，跳过截至该序号的区间，剩余未读（`targetSeq + 1` 至最新）依然保持待处理。
  - **一键抹平**：省略 `throughMessageRef` 或传 `'latest'` 时，默认跳过截至当前到达的最新消息，该会话待处理计数归零。
- **参数**：
  ```json
  {
    "type": "object",
    "properties": {
      "conversationRef": { "type": "string", "description": "目标会话。" },
      "throughMessageRef": {
        "type": "string",
        "default": "latest",
        "description": "跳过截至的消息引用（如 'm77'），省略或传 'latest' 表示一键抹平截至最新到达的消息。"
      },
      "reason": { "type": "string", "default": "主动放下积压", "description": "跳过原因，留存审计事实。" }
    },
    "required": ["conversationRef"]
  }
  ```
- **关键返回**：
  - `skippedCount`: 本次跳过的消息条数。
  - `remainingPendingCount`: 该会话剩余待处理条数（仅跳过到最新时为 0）。
  - `newBookmark`: 新的书签推进位置。

### 4.4 `qq_browse` —— 时空漫游与点查（严格优先级裁决）
只读探索历史消息、点查指定消息或展开复杂卡片。绝不改变书签，不争夺消费锁。

- **执行优先级裁决**（消除多模式传参冲突）：
  1. **第一优先级：`contentTarget`**（展开单条消息的长文本、合并转发节点或卡片详情）；
  2. **第二优先级：`messageRefs`**（显式点查指定的一组消息正文）；
  3. **第三优先级：`direction` + `anchorMessageRef`**（历史时空翻页漫游，默认模式）。
- **参数**：
  ```json
  {
    "type": "object",
    "properties": {
      "conversationRef": { "type": "string", "description": "浏览指定会话的历史时必填。" },
      "direction": { "type": "string", "enum": ["latest", "before", "after", "around"], "default": "latest" },
      "anchorMessageRef": { "type": "string", "description": "历史定位锚点消息引用（如 'm77'）。" },
      "messageRefs": {
        "type": "array",
        "items": { "type": "string" },
        "description": "点查指定的一组消息引用（如 ['m12', 'm15']）。"
      },
      "contentTarget": {
        "type": "object",
        "properties": {
          "messageRef": { "type": "string" },
          "segmentIndex": { "type": "integer", "default": 0 }
        },
        "required": ["messageRef"],
        "description": "展开某条长文本分段、多层合并转发节点或指定卡片载荷。"
      },
      "limit": { "type": "integer", "default": 20, "maximum": 100 }
    }
  }
  ```
- **关键返回**：格式化呈现的历史消息、点查正文或展开详情。包含覆盖完整性状态（`coverage: "continuous" | "gap_detected"`），附带前后翻页可用 ID 线索，并明确注明“历史浏览；书签未移动”。

### 4.5 `qq_send` —— 发送消息与引用回复
高频外发动作。负责向外部世界产生发言副作用。

- **参数**：
  ```json
  {
    "type": "object",
    "properties": {
      "conversationRef": { "type": "string", "description": "目标群或私聊。" },
      "content": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "type": { "type": "string", "enum": ["text", "mention", "face", "image", "audio", "video", "file"] },
            "text": { "type": "string" },
            "userRef": { "type": "string" },
            "faceId": { "type": "string" },
            "path": { "type": "string" }
          },
          "required": ["type"]
        },
        "description": "消息分段数组。"
      },
      "replyTo": { "type": "string", "description": "引用的消息引用（如 'm77'）。" }
    },
    "required": ["conversationRef", "content"]
  }
  ```
- **关键返回**：操作回执引用、确定/未知结果、外发消息引用。

### 4.6 `qq_interact` —— 轻量互动与自身撤回
轻量外部互动副作用。

- **参数**：
  ```json
  {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["poke", "react", "retract"] },
      "conversationRef": { "type": "string" },
      "userRef": { "type": "string", "description": "poke 时必填的目标用户。" },
      "messageRef": { "type": "string", "description": "react 或 retract 时必填的目标消息。" },
      "reactionCode": { "type": "string", "description": "react 时的表情编码。" }
    },
    "required": ["action"]
  }
  ```
- **关键返回**：互动执行结论（成功、未知或拒绝）。

### 4.7 `qq_remind` —— 提醒预约与备忘事项
管理主体给自己设定的“稍后查看”承诺。到期时仅给一次查看机会，不自动执行外部动作。

- **参数**：
  ```json
  {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["list", "create", "resolve"], "default": "list" },
      "targetRef": { "type": "string", "description": "关联的会话或消息引用。" },
      "note": { "type": "string", "description": "备忘说明或查看意图。" },
      "reviewAt": { "type": "string", "description": "ISO UTC 格式的到期提醒时间。" },
      "remindRef": { "type": "string", "description": "resolve 时的待办引用编号（如 'f1'）。" },
      "resolution": { "type": "string", "description": "结项或取消的结论说明。" }
    }
  }
  ```
- **关键返回**：当前待办列表、新生成的提醒编号或闭环确认。

### 4.8 `qq_requests` —— 社交准入与好友/入群申请审批
专注处理好友申请与群邀请，绝不与资料修改混杂。

- **参数**：
  ```json
  {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["list", "respond"], "default": "list" },
      "requestRef": { "type": "string", "description": "审批时的申请引用编号（如 'r1'）。" },
      "decision": { "type": "string", "enum": ["accept", "decline"] },
      "reason": { "type": "string", "description": "拒绝时的说明原因。" }
    }
  }
  ```
- **关键返回**：待处理申请清单或批复结果确认。

### 4.9 `qq_profile` —— 自我形象与群名片维护
专注管理主体在外部平台的身份展示。

- **参数**：
  ```json
  {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["get", "set_card", "set_profile", "set_avatar"], "default": "get" },
      "conversationRef": { "type": "string", "description": "set_card 时必填的目标群。" },
      "card": { "type": "string", "description": "群名片内容（空串表示清除名片）。" },
      "nickname": { "type": "string", "description": "修改自身全局昵称。" },
      "signature": { "type": "string", "description": "修改自身全局签名（空串表示清空）。" },
      "avatarPath": { "type": "string", "description": "本地头像图片路径。" }
    }
  }
  ```
- **关键返回**：资料修改结果确认或当前个人资料详情。

---

## 5. 通知调度、延迟渲染唤醒与动静生命周期

### 5.1 精细化通知触发规则（闲聊防骚扰与私聊沉寂复苏）
解决“一条旧未读导致后续更重要私聊被永久静默”的严重缺陷，确立基于真实物理事实的通知规则：

```text
外部新消息到达
    │
    ▼
1~2 秒短防抖（打字断句合并）
    │
    ▼
是否满足提醒触发条件？
 ├── 1. 首次未读 (0 -> >0) ──────────────► 【触发全局态势小纸条】
 ├── 2. 直接互动 (@本人 / 戳 / 引用自身) ─► 【特许穿透升级】
 ├── 3. 私聊沉寂复苏 (静默 ≥ 10分钟后新发信)► 【特许穿透升级】
 └── 4. 群聊普通增量闲聊 (1 -> 100) ──────► 【静默记账，绝不弹新纸条！】
```

1. **统一 1~2 秒短脉冲防抖（打字喘气合并）**：  
   人类在 IM 中通常分作两三条短句连续敲回车发送。**1~2 秒极短防抖窗口**能自然将对方同一轮呼吸的打字连发合并进同一张纸条，消除人造等待感。
2. **通知覆盖位置记录（`lastNotifiedSeq`）**：  
   QQ World 内部记录每个会话上一轮通知已覆盖到的消息序号 `lastNotifiedSeq`，确保不会对同一批旧消息反复催更。
3. **精细化触发判定法则（纯物理事实依据）**：
   - **首次未读触发（0 $\rightarrow$ >0）**：会话此前已清空，首批新消息到达，触发通知。
   - **直接互动特许穿透**：无论何时出现 `@本人`、戳一戳、自身发言被引用，立即打破静默，触发紧急置顶小纸条。
   - **私聊沉寂复苏特许穿透（客观时间阈值）**：  
     私聊代表直接的点对点人际沟通。**当私聊会话出现新消息，且距离上次发信超过沉寂间隔（$\ge 10$ 分钟）时，特许触发新提醒**！绝不因为早上有一条闲聊未读，就导致下午更重要的私聊被永久压制。摒弃不可执行的“意图分析”，只认客观物理时间。
   - **群聊增量闲聊严格静默（1 $\rightarrow$ 100 绝不催更）**：  
     群聊在首次提醒后，后续增量闲聊保持完全静音，客观记账，绝不每隔几分钟跳出催更。

### 5.2 全局未读态势感知呈现（One-glance Situational Awareness）
通知小纸条一旦触发，呈现的是**全局所有待处理会话的态势概览**，而非仅含单个触发会话：

- **小纸条交付示例**：
  ```text
  [QQ 动态通知]
  触发原因：p20002 小明 发来新私聊（小明：“下午有空看下部署吗？”）

  当前待处理概览：
  • p20002 小明   ｜ 待处理 2条             ｜ 小明：“下午有空看下部署吗？”
  • g30003 开发群 ｜ 待处理 18条 (含1次@你) ｜ 阿岚：“@Uina 接口怎么看”
  • g40004 交流群 ｜ 待处理 35条            ｜ 闲聊中…
  （当前共 3 个会话有待处理内容；可用 qq_read 查看，或 qq_skip 放下）
  ```
- **核心价值**：主体一瞥纸条便能掌握全局社交全貌，当场做出“读小明、回开发群、跳过交流群”的全局裁决，**彻底免去调 `qq_inbox` 查全貌的额外轮次消耗**。

### 5.3 延迟渲染唤醒占位（Lazy Render Latch）与调度真实性
系统利用 Core 现役的 `AgentInput.render` 接缝（见 `src/agent/loop.ts`）：

```text
外部事件触发
    │
    ▼
QQ 队列中是否已有唤醒占位？
 ┌──┴──┐
 │ 是  │ 否
 ▼     ▼
【仅更新 QQ World 待渲染快照】       通过 pi.onInput({ render: () => ... })
 (若含直接互动/私聊沉寂复苏则置顶)   投递唤醒占位 (notice_enqueued)
                                         │
                                         ▼
                                   等待 Subject 按队列顺序取出该占位
                                         │
                                         ▼
                             【Subject 触发 render() 延迟求值】
                              - 从 QQ World 读取此时此刻的最新全貌
                              - 若排队期间已被主体 read/skip 清空：
                                render 返回 null ──► Core 自动退役 (empty_render)
                              - 否则返回最新纸条正文 ──► 提交入库 (notice_committed)
```

- **真实调度边界澄清**：
  1. **内容新鲜度（已解决）**：占位出队时才调用 `render()`，无论排队多久，主体看到的始终是出队那一刻的最新未读与直接互动；
  2. **自合并与空退役（已解决）**：同一 QQ World 在邮箱中同一时刻仅维持一个占位；若排队期间积压被消费完毕，`render()` 返回 `null` 由 Core 自动退役（`empty_render`），不开启空白回合；
  3. **非跨来源抢占特权（遵守系统规律）**：
     **`render()` 延迟求值不是跨来源优先级抢占调度**。若队列前方已有用户手动输入的指令或其他扩展的任务在排队，QQ 占位依然在队尾正常等待排队出队，不破坏 Core 的 FIFO 队列公平性。直接互动与私聊沉寂复苏仅保证在 QQ 小纸条内部置顶呈现。

### 5.4 Follow 与 Read 的统一书签与串行消费
- **有效跟读与自主退出**：  
  当且仅当 `effectiveFollow = isFocused && resolvedPushMode === "follow"` 为真时，新到达的消息才会自动作为输入向主体派发；  
  主体交谈告一段落，调用 `qq_inbox({ focus: [] })` 移开焦点后，`effectiveFollow` 立即为假，连续正文自动停止派发，主体自然退回日常守护状态；且持久化的 `push.mode` 保持不变。
- **串行锁保证书签推进**：  
  手动 `qq_read` 与自动 `follow` 共用同一个 `body_dispatched` 书签，并通过 `withConversationLock` 串行互斥执行。后到的消费动作必须等待前序动作提交书签后才能获取增量，**绝无重复派发与游标竞态**。
- **过载自动退让保护（基于真实未消费深度）**：  
  在跟读模式下，以**未消费正文深度（Unconsumed Buffer Pressure）**为唯一权威依据：当向主体派发但尚未被消费的正文累积达到单屏呈现预算（约 14,000 字符或 30 条）时，系统自动切断连续正文灌注，平滑退化为全局摘要小纸条并附带降压提示：
  > *“[QQ 动态提示] 关注会话 g30003 出现高频积压；自动正文已暂停灌注。你可以主动调用 `qq_read` 阅读，或调用 `qq_skip` 放下积压。”*

---

## 6. 数据兼容、内部单调序号与断线覆盖诚实性

1. **v2 目录原地增量兼容**：
   沿用现有的 `/.uina/worlds/qq/v2/<selfId>/` 数据目录，不强制断代重开。
2. **严格内部单调递增 `seq`**：
   - 外部展现与工具传参支持友好 ID（`m77` 等）；
   - QQ World 内部维护自增整数序号（`seq`，从 1 单调递增）。所有阅读书签推进、区间比较、跳过计算与翻页逻辑，全部严格使用 `seq` 数值运算，**严禁用字符串字典序推导先后关系**。
3. **断线覆盖诚实性标记（Coverage Honesty）**：
   - 彻底删除后台常驻的断线缺口扫描器（Coverage Gap Scanner），避免无意义的并发扫描与轮询；
   - **保留真实覆盖状态记录**：长连接断线重连时，如果底层协议或事件表明中间存在消息缺失，QQ World 在事实日志中诚实记录 `coverage: "gap_detected"`；
   - 当主体通过 `qq_browse` 翻阅该历史区间时，明确提示存在断网缺口，绝不伪装为平台完整无损历史。
4. **基线封存与游标初始化（诚实解决冷启动）**：
   - 系统首次启动新版本时，在本地记录 `initializationBaselineSeq`（基线序号）；
   - 基线之前的未读历史归入 `archived_backlog`（封存积压）；未读统计诚实呈现 `待处理: 0 条；封存历史积压: 1200 条`，绝不虚假冒充“主体已读”；
   - **消费标线对齐**：活动消费书签 `throughSeq` **初始化对齐至基线序号**，确保日常阅读器 `qq_read` 只承接基线之后的新鲜消息，杜绝冷启动 9999+ 积压海啸。历史内容留待 `qq_browse` 随时回溯。
5. **系统自愈与零终端打扰**：
   - 投递失败或文件锁异常时，World 内部记录诊断并优雅退让至下一个周期重新核算；
   - **严禁向终端用户抛出 `Ctrl+Enter` 或要求在命令行调用 `Host.resumePending` 等底层调试命令**。

---

## 7. 必须验收的端到端场景矩阵

| 编号 | 场景 | 验收合格标准 |
| :--- | :--- | :--- |
| **T01A** | **常规首条消息到达（0→1）** | 1~2 秒短脉冲防抖合并后进入队列（`notice_enqueued`），呈现全局所有待处理会话概览；后续增量闲聊绝不产生催更新纸条；被消费后推进 `notice_committed`；书签不移动。 |
| **T01B** | **私聊沉寂复苏穿透提醒** | 私聊存在未读旧消息；沉寂 $\ge 10$ 分钟后对方发来新消息，系统打破常规静默，1~2 秒后生成包含该新事件的小纸条，**绝不被旧未读永久静默**。 |
| **T02** | **直接互动插队与延迟渲染升级** | 正在排队的占位信号在外部遇到 `@本人` 或戳一戳时，World 就地更新待渲染快照；取出执行 `render()` 时直接输出置顶紧急互动现场；零 Core 修改。 |
| **T03** | **顺序正文消费与消息级书签** | 连续调用 `qq_read`，消息顺畅衔接无遗漏；整条消息成功派发后单调记录 `body_dispatched` 书签；超长文本折叠提示而不阻塞消息级书签推进。 |
| **T04A** | **部分跳过与待处理重算** | 书签停在 m10，积压至 m100；调用 `qq_skip({ conversationRef: "g1", throughMessageRef: "m70" })`，内部按 seq 计算，验证 m11~m70 被跳过，剩余 30 条待处理（`remainingPendingCount: 30`），待处理不归零。 |
| **T04B** | **一键抹平到当下** | 调用 `qq_skip({ conversationRef: "g1" })`（省略 `throughMessageRef`）；跳过至最新到达的消息，剩余待处理清零（`remainingPendingCount: 0`）。 |
| **T05** | **可读 ID 锚点历史漫游与断线标记** | 随时调用 `qq_browse` 凭借可读 ID（如 `anchorMessageRef: "m77"`）进行历史漫游；内部以 seq 定位，阅读书签原封不动；若区间存在断网缺失，如实返回 `coverage: "gap_detected"`。 |
| **T06** | **收件箱读写合一且配置继承** | 调用 `qq_inbox({ focus, push })` 成功完成配置；当会话模式为 `inherit` 且全局为 `follow` 时，验证 `effectiveFollow` 准确生效；不传参时纯查询，**绝对不隐式清空现有关注与偏好**。 |
| **T07A** | **Follow 与 Read 交错共用书签** | 满足 `effectiveFollow` 条件时自动派发消息 A~C 并推进书签；随后主体主动调用 `qq_read`，验证自动从 D 开始交付，**绝无重复阅读 A~C**。 |
| **T07B** | **会话级消费锁并发互斥** | 模拟 `qq_read` 执行与 `follow` 自动正文在毫秒级同时触发；验证 `withConversationLock` 使二者严格串行执行，后到者持锁读取最新书签，**绝对不发生消息重复派发**。 |
| **T08** | **轻互动与撤回** | 戳一戳、表态、撤回发言稳定执行，未知状态诚实汇报。 |
| **T09** | **好友申请与资料维护** | `qq_requests` 与 `qq_profile` 独立正常工作，语义内聚明确，无多分支混杂。 |
| **T10** | **平滑热升级启动与游标基线** | 注入旧历史数据；加载后建立封存基线并将消费游标对齐至基线，待处理数诚实从当下算起，无积压海啸，历史可通过 `qq_browse` 随时回溯。 |
| **T11** | **书签单调性与打断安全** | `qq_read` 或跟读正文派发成功后遭遇思考中断（`turn_aborted`）；书签遵循 `Math.max` 单调不倒退，已确认派发的正文绝不因中断而倒退回起点，避免重叠重复交付。 |
| **T12** | **延迟渲染占位空退役** | 通知占位在队列排队期间，主体已主动调用 `qq_read` 消费完毕；占位出队时 `render()` 返回 `null`，Core 以 `empty_render` 自动退役，不开启空白回合。 |
| **T13** | **移开视线自然退出跟读** | 主体在 `effectiveFollow` 激活状态下调用 `qq_inbox({ focus: [] })`；验证新消息不再主动注入正文（转为守护态小纸条），且持久化文件中的 `push.mode: "follow"` 原封不动。 |
| **T14** | **重启冷启动无焦点静默守护** | 带有 `push.mode: "follow"` 配置重启系统；验证初始状态 `focus` 为 `[]`，`effectiveFollow` 为 `false`，首条消息仅产生守护态小纸条，绝不发生自动正文灌注。 |
| **T15** | **qq_browse 传参冲突降级** | 同时传入 `contentTarget` 与 `direction` 参数时，验证严格优先响应 `contentTarget` 展开单条详情，杜绝参数竞争异常。 |

---

## 8. 总结

本规格以行为事实归属、串行消费与能力边界为约束；实现是否符合规格必须由当前源码和可运行验证判断：
1. **纯粹的能力器官定位**：QQ World 严格专注于提供真实的感知与交互端口，不塞入人格、好感度或社交动机，动机完全属于上层主体；
2. **会话级消费串行锁**：以极简的 `withConversationLock` 串行排队彻底消灭了 `qq_read` 与 `follow` 交错时的并发重复派发；
3. **精细化通知规则**：群聊增量闲聊坚决静默不催更，同时为私聊沉寂复苏开辟穿透通道，告别私聊消息长期漏报；
4. **18 行验收场景**：T01A/B、T04A/B、T07A/B 拆开后共 18 行；场景编号不表示已获真实平台或全部跨进程验证。证据与边界见 `../qq-world-acceptance.md`。

本规格为实施施工的最终权威蓝本。

---

## 9. 第十四轮实现级裁定（R1~R7，终审后源码核查补丁）

以下裁定源于对 HEAD `31afc79` 工作树的 source-level 核查，保留为历史实现决定。A01～A17 修复后的合同以 §10 为准。

**R1（修订 §1.2/§5.4 过载退让依据）**：World 无法观测"模型是否已消费正文"，"向主体派发但尚未被消费的正文累积"不可实现。过载退让的权威量改为 **World 完全可观测的缓冲深度**：`seq > throughSeq` 的未派发正文字符/条数。每次跟读派发完成后检查缓冲，超过预算（约 14,000 字符或 30 条）即切断连续灌注、转全局摘要纸条。与 `body_dispatched` 书签单调推进天然一致。

**R2（补全 §3 工具箱裁剪清单）**：现有 `account` action 下的 `leave_group`、`remove_contact`、`set_presence` 在 9 工具中无落点，登记为**故意裁剪**（社会性行动留待上层主体真实需要时以新积木供给）；`attention.priority/preferred` 窗口偏置**废弃**（1~2s 短防抖统一后无意义）；`mark_read` 废除（被书签机制替代）。

**R3（修订 §6.2 可读 ID 语义）**：`m<ref>` 为**平台 message_id 直引**（允许负值，如 `m-897722166`），非自增短 ID。所有区间运算先经事实日志的 message 记录做 `platform_id → 本地 sequence` 映射；解析失败（引用不存在或不属目标会话）显式报错。§4.3/§4.4 中 `'m70'` 等示例均按此语义解读。

**R4（落盘 §6 持久化位置）**：① `body_dispatched` 书签 = facts journal 新增 `dispatched` 记录类型 `{ kind, conversationRef, throughSequence, source: "read"|"follow", inputId?, at }`，与 `notified` 分轨、单调回放；② `lastNotifiedSeq` 复用现有 `notified.throughSequence`，语义不变；③ **基线改为按会话映射** `initializationBaseline: Record<conversationRef, seq>`（`sequence` 按会话分配，单标量不成立），持久化于 `qq-control.json`，首见会话时以当前 `latestSequence` 一次性写入、绝不覆盖。

**R5（补齐 §6.1 迁移策略）**：`qq-control.json` 旧 `accountOverride/conversationOverrides`（AttentionOverride）一次性映射为新 push 字段：`silent→{mode:"off"}`、`direct_only→{mode:"digest",filter:"direct"}`、`normal→{mode:"digest",filter:"all"}`、`pausedUntil` 直传、`priority` 丢弃、空覆盖→空偏好（解析时回落默认）。旧字段在迁移时保留（现役 attention 路径仍消费），至旧 action 退役批次一并清除；通知路径切至新字段后不双读。

**R6（降级 §6.3 gap 检测）**：OneBot v11 的 message_id 不保证连续，无法从 ID 推断缺失。`gap_detected` 仅为弱信号标记：仅当传输层/SDK 显式报缺失或重连错误时写入；验收场景 T05 的该分支以注入模拟测试。不伪造检测能力。

**R7（补强 §5.3 render 合同）**：Core 对 render 闭包抛错的处理是条目回退邮箱重试（`src/agent/loop.ts:1534-1538`），World 侧闭包若抛错将无限重排队。所有 World render 闭包**必须永不向上抛**：内部捕获异常后返回降级文本或 `null`（空退役）。与 §6.5"自愈与零终端打扰"对齐。


## 10. A01～A17 修复后的实施合同（2026-10-11）

本节替代旧裁定中不成立的封关、首次基线和异常吞掉候选行为。保留单一 qq facade 与九个领域积木，Core 和 SDK 零改动。

- 消费查询归于 World consumption.ts，入站待处理为 sequence > max(dispatched, baseline)；自身 out 仅属历史。read/follow 共用顺序窗口，书签只到实际交付位置。单条允许显式折叠，指引可点查完整消息或展开富媒体，不丢整条消息后假定成功。
- 跟读在锁内重验 focus、有效 push/暂停、消费位和生命周期。未派发缓冲超过 30 条或 14,000 字符退让全局摘要，书签不动；回落后恢复。read/skip 等待锁后重验取消，read 媒体成果完成后才提交。
- R4③ 由一次性 readerInitialized 标记修正：首次迁移仅对当时已有历史建立基线，已有基线保留；之后新会话为 0，重启不重新封存正常未读。消费书签保持单调，不自动修复过去错误推进。
- 1～2 秒短防抖后即提交唯一 ID 占位，不等待 Subject 空闲；Runtime FIFO 负责出队。占位不冻结旧会话候选，求值当前候选、置顶跨会话直接互动，重验静音、申请状态和到期事项。普通纸条只交付触发事实和全局概览；所有有效待处理会话保留引用及计数，预算不足缩短预览。
- 一次成功求值缓存文本、各会话通知位置和事项/操作引用，结算使用同一成果。R7 的 render 不向 Core 抛错保留，但正常空退役与异常分开：失败保留候选，共用可取消的 2 秒计时器重试。结算先释放占位，再按 input ID 幂等补账；停机清理。外部 unknown 不自动重发。
- inbox 每次请求在线 get_friend_list/get_group_list，合并消息、事件、关注和偏好，返回目录名称或 unknown。目录任一路失败明确失败，focus/push 不变；全部校验、游标和查询成功后才保存 push、更新 focus。limit/cursor 分页绑定目录与条件，计数变化不使普通目录分页失效。需要 observation，同时修改 push 另需 attention.manage。
- requests list 默认每页 20，接受 limit/cursor；返回游标可直接续页。browse 保持 contentTarget > messageRefs > direction，三模式兑现 includeMedia；点查本地优先再 get_msg。历史 source 默认 local，platform 显式使用现有好友/群历史 API，around 合并两侧去重；失败不偷偷换来源，不写 received/dispatched。所有展开与续读指引使用真实 {action, params}。
- R6 弱覆盖接入断线/恢复、明确传输错误与不可解码消息，形成独立可回放时间区间。浏览仅报告窗口相关风险及平台完整性未知，不从 message_id 猜缺失、不把归档当断线。qq-status 支持明确 QQ 数据根和 profile stateRoot，纯只读解析，unknown 数来自日志，进程内 focus 不可观测时显示 unknown。

§7 的 18 行矩阵保留作为场景要求。实际自动化证据包括 F01～F17 正式回归、压力边界/媒体取消/配置失败/分页/重启/只读诊断，以及 World → Subject → JsonlSessionStore 的忙时 FIFO、互动升级、消费交错、空退役、回合打断和提交重试。完整映射见 ../qq-world-acceptance.md。

真实 QQ 连接探测不可用，真实身份、目录、平台历史未验证；没有发送或处理申请。局部成果缓存保证进程内重试，不提供派发书签与 canonical input 的跨进程原子性；崩溃夹在两次写入之间仍是未验证边界。历史误封存与误跳过不批量恢复。
