# QQ 方案对比：dsh-world（含 qq-bridge）vs Uina qq world

日期：2026-10-27
比对对象：
- `chenkezhen480/dsh-world` @ `bf7e1e1`（v0.5.6，MIT，Cordis/DSH 插件）
- `Derpyu520/qq-bridge` @ 浅克隆 HEAD（dsh-world 的唯一 QQ 依赖）
- Uina `.uina/worlds/qq/`（WorldDef，自持 OneBot v11）

方法：只读源码。工具清单由 `server.tool(...)` / `QQ_ACTION_SCHEMAS` 字面量提取，机制结论标注文件与行号。未运行对方代码。

---

## 0. 结论摘要

1. **两者不是同类方案。** dsh-world 把 QQ 当作"进入她家的一个门"，插件自身**零 QQ 工具、零 QQ 协议代码**；QQ 能力全部由外部 `qq-bridge` 进程及其 MCP server 提供。Uina 把 QQ 当作"一个世界"，自己持传输、事实库、消费模型与授权门。
2. **工具数量不可直接比较。** dsh-world 自有 QQ 工具 = 0（微信模块才有 `wechat_*` 工具）；组合后模型可见的是 qq-bridge 的 38 个平坦 MCP 工具。Uina 是 1 个 `qq` 工具 / 14 个 action。
3. **能力面互补而非重叠。** Uina 强在社交治理（好友/入群审批、撤回、群名片、群文件、本地检索）；qq-bridge 强在表达面（自定义贴纸库、语音、黑话词库、桥自有记忆、花费看板）与长轮询等待。
4. **机制强度错位。** Uina 强在读写语义（durable intent、unknown 不重发、消费书签、三档呈递）；dsh-world 强在进程运维（6 态巡检、退避限流、`halt`/intent、端点自愈）。
5. **Uina 有一处真实运维缺口**：当前部署 `reconnect.retries = 0`，断线不自动重连、也无上游看门狗（详见 §5.2）。

---

## 1. 定位差异（决定后面所有差异）

| | dsh-world | Uina qq world |
|---|---|---|
| 本体 | QQ 是"门"（one more door into her home） | QQ 是"世界"（WorldDef） |
| 协议归属 | 外部 qq-bridge → SnowLuma → OneBot v11 | 自持 OneBot v11 WS（vendored SnowLuma SDK，固定 commit） |
| 插件职责 | 探活、拉起、停桥、绑定、报告 | 传输、事实、消费、调度、授权、审计 |
| 代码自述 | `src/ecosystem/qq/bridge.ts:5-12`："Nothing of the bridge's own logic is copied — this only probes, starts, stops, binds and reports." | `src/index.ts:20-24`："配置 → 存储 → 传输 → 摄取 → 调度 → facade" |
| 失效域 | 桥改了接口，插件跟着改（README §QQ） | 平台语义自己定义，不依赖第三方版本 |

一个直接后果：dsh-world 的 QQ 能力**质量上限由外部仓库决定**，且不可在本仓库内审计；Uina 的 QQ 能力**每一行为都有本仓库源码可查**。

---

## 2. 工具面全表

### 2.1 dsh-world 自有工具

| 工具 | 归属 | 是否走 QQ |
|---|---|---|
| `plan_next` / `check_alarm` / `cancel_alarm` | `src/life/tools.ts`，所有会话持有 | 否 |
| `reach_out` | 同上，仅家会话持有 | **否**：通道 = Windows toast + `outlets`（`reply`/`busy`/`reach`） |
| `wechat_chats` / `wechat_send` / `wechat_delivery` | `src/ecosystem/wechat/sending.ts`、`messages.ts` | 否 |
| （QQ） | — | **0 个**。`grep "tools.register\|defineTool" src/ecosystem/qq/` 无命中 |

即：**插件无法让模型发一条 QQ 消息，也无法让模型读一条 QQ 消息。** 主动性走系统通知；QQ 主动性交给桥的 socialV2。

### 2.2 组合后模型可见的 QQ 工具（= qq-bridge `src/mcp-snowluma-safe.js`，38 个）

读：`qq_get_unread_messages` `qq_get_recent_messages` `qq_get_my_recent_messages` `qq_get_group_history` `qq_get_message_detail` `qq_get_message_images` `qq_get_forward_msg` `qq_get_active_members` `qq_get_group_members` `qq_list_groups` `qq_get_prompt` `qq_get_self_image` `qq_status` `qq_social_state`
写：`qq_send_message` `qq_send_private_message` `qq_send_group_message` `qq_reply` `qq_send_burst` `qq_send_poke` `qq_send_sticker` `qq_send_voice` `qq_mark_read`
等待/唤醒：`qq_wait_for_messages` `qq_set_wake_config`
贴纸：`qq_list_stickers` `qq_get_sticker_image` `qq_collect_sticker` `qq_sticker_note` `qq_set_sticker_remark`
桥自有记忆：`qq_memory_append` `qq_memory_query` `qq_memory_clear` `qq_memory_remove`
黑话：`qq_slang_query` `qq_slang_submit`
语音库：`qq_list_voices`
反馈：`qq_report_feedback`

附加约束（源码可见）：发送类工具要求模型自己携带 **会话令牌 `token`**（`mcp-snowluma-safe.js:731` 起），即把桥的会话凭据暴露进模型上下文。

### 2.3 Uina `qq` 工具：1 个入口 / 14 个 action

`inbox` `read` `skip` `browse` `send` `interact` `remind` `requests` `profile` `people` `files` `fetch` `search` `expressions`
（`tool.json` + `src/tool-schema.ts`；`executionMode: "sequential"`）

模型只见短引用 `g群号 / pQQ号 / tQQ号-g源群 / uQQ号 / m消息 / a附件 / r申请 / f事项 / o操作`，不接触任何传输凭据。

### 2.4 能力映射（谁有、谁没有）

| 能力 | Uina | dsh-world + qq-bridge |
|---|---|---|
| 收件箱（红点/关注/静音/游标） | `inbox` | `qq_get_unread_messages` |
| 顺序消费并推进书签 | `read` | —（无书签概念） |
| 放下积压（审计 + 单调推进） | `skip` | `qq_mark_read`（仅平台已读标记） |
| 只读历史（不动书签） | `browse`（contentTarget > messageRefs > direction） | `qq_get_group_history` / `qq_get_message_detail` / `qq_get_forward_msg` |
| 发送（分段 + 引用） | `send`（file/video 独立成批） | `qq_send_message` / `qq_reply` / `qq_send_burst` / 私聊 / 群发 |
| 戳一戳 | `interact.poke` | `qq_send_poke` |
| 群消息表情回应 | `interact.react` | **无** |
| 撤回自身消息（所有权核验） | `interact.retract` | **无**（`grep delete_msg` 零命中） |
| 稍后查看承诺（f{n}，到期只给查看机会） | `remind` | **无**（`plan_next` 是家会话闹钟，不是 QQ 待办） |
| 好友/入群审批 | `requests`（list/respond） | **无**（桥的"审批"指 agent 工具审批转发给管理员，`bridge.js:2357`，不是社交审批） |
| 群名片/昵称/签名/头像 | `profile` | **无** |
| 人物/群成员查询 | `people` | `qq_list_groups` / `qq_get_group_members` / `qq_get_active_members` |
| 群文件目录浏览 | `files` | **无** |
| 附件取回为本地文件 | `fetch` | **无**（图片走桥的多模态注入，无落盘工具） |
| 本地消息/文件名检索 | `search` | **无**（`qq_memory_query` 查的是桥自有记忆库） |
| 系统表情编码查询 | `expressions`（face/reaction） | `qq_list_stickers` 等（贴纸，不是 face 编码） |
| 自定义贴纸（收藏/发送/备注） | **无** | `qq_collect_sticker` / `qq_send_sticker` / `qq_sticker_note` 等 |
| 语音收发/语音库 | 仅 `send` 支持本地 audio→record | `qq_send_voice` / `qq_list_voices` |
| 长轮询等待新消息 | —（门铃模型不需要） | `qq_wait_for_messages`（5 分钟） |
| 唤醒/潜水配置 | —（focus 是会话期内存） | `qq_set_wake_config` / `qq_social_state` |
| 桥侧记忆条目 | —（journal 是事实库，不是记忆） | `qq_memory_append/query/clear/remove` |
| 黑话词库 | — | `qq_slang_query` / `qq_slang_submit` |
| 运行状态 | 无 status action；连接状态走 internal 事件 | `qq_status` |

**结论：** 两边的空白区互不重叠。Uina 没有贴纸/语音库/黑话；qq-bridge 没有审批/撤回/资料/群文件/检索/表达回应。

---

## 3. 机制逐项对照

| 机制 | Uina | dsh-world（+ 桥） |
|---|---|---|
| **入站** | WS 事件 → `QqIngestion` → 事实落库，落库即通知调度（`index.ts:181-203`）；未授 `observation` 则不入库 | 桥把 QQ 消息变成 DSH 会话用户消息（回合驱动）；桥内每会话最多排队 50 条，DSH 不可用时补投 |
| **呈递** | 三档：`ring`（私聊/focused，整屏窗口+推进书签）/ `tap`（群 @、reply、poke、recall、好友申请，单条，书签不动）/ `internal`（一行注记）。去抖 `quiet` + `maxWait`，单占位，整会话字符预算封顶（`scheduler.ts:10-17`） | 无。消息即回合，模型被直接叫醒；`reserved2` 下反过来由模型 `qq_get_unread_messages` 主动拉 |
| **消费边界** | `dispatchedThrough` per-conversation 单调不减；`skips` 审计；`browse` 绝不移动（`facts-journal.ts:42-56`、`reader.ts:15-22`） | 无等价物；`qq_mark_read` 只改平台已读态 |
| **注意力** | `focus`（会话期内存，重启清空，不持久化）与 `push`（`off`/`pausedUntil`，持久化）严格分离；focused 无视门铃（`attention.ts:3-9`、`control-store.ts:182-200`） | 无 |
| **写路径可靠性** | grant → durable intent（`will_dispatch` 先落盘，echo=operationRef）→ 平台调用 → 结算 `succeeded/failed/unknown`；`unknown` **不自动重发**；迟到回执凭 echo 升级并通知（`app.ts:766-894`、`index.ts:213-236`） | 工具调用即写；无 durable intent、无 unknown 语义。桥侧有白名单/SSRF 防护，失败即工具报错，由模型自行重试 |
| **批次** | `file`/`video` 强制独立成批；失败回报"已确认分段 + 未派发剩余"，不整包重发（`app.ts:237-308`） | 桥按句读/URL 边界自动分段（500 字上限）；`qq_send_burst` 可分条 |
| **多字段非原子** | `set_profile` 逐字段回执，不整包重试（`app.ts:652-678`） | 无对应面 |
| **授权** | 8 个 grant 名 + action→grant 精确映射（写不隐含读）；缺 `deployment.grants` 声明 = **启动失败**（`grants.ts:9-11`、`grants-vocabulary.ts`） | 插件层无 grant。边界在桥：`allow.private/groups` 白名单（fail-closed）+ MCP 安全子集（隐藏 terminal/plugin_manager 等） |
| **身份核验** | 登录 selfId ≠ 绑定 selfId → 阻止平台写入并启动失败（`index.ts:283-291`） | 无（桥按 `state/sessions.json` 映射，admin QQ 用于审批） |
| **记忆** | 不写主体记忆；事实库/书签/操作日志三者分离 | QQ 私聊进"家"→ 归档 → 近期记忆块（默认 200 轮）；**群不进归档、不进记忆块**；归档分不出 QQ 与桌面（README §QQ 的记忆与开关） |
| **进程运维** | 无（自身即进程）；连接层有 coverage gap 记录（断线/平台离线缺口如实标注） | `supervisor`：5s 探测、1.5s 超时、3 次失败触发恢复、10 分钟最多 5 次、指数退避 2s 起 ±20% 抖动上限 60s、6 态状态机、`intent=stopped` 不拉（`supervisor.ts:64-190`） |
| **启停语义** | World `onStart`/`onStop`，abort + 结算在途（`index.ts:312-337`） | `stop()`（`/api/restart`，桥会自己回来）vs `halt()`（`/api/stop` + 落 intent，真停）严格区分；旧桥无 `/api/stop` 时如实报 `stop-failed`（`bridge.ts:338-401`） |
| **端点自愈** | 无；WS 地址写死在 `config.json` | 每次启动把 DSH 当前 origin 写回桥的 `config.json`（`dsh.baseUrl`），变了就重启桥一次（`bridge.ts:139-164`、`436-444`） |
| **通道抽象** | 每个 world 独立实现；共享 world-framework 接缝 | `ecosystem/shared/`：`SpeakerIdentity`（channel/accountId/conversationId/speakerId）+ `conversationKey` + `outlets`，渠道无关；加平台只写 `ecosystem/<channel>/` |
| **控制台** | 无（世界通过工具自述） | 世界控制台 QQ 卡：桥在跑/DSH 已连/QQ 在线/绑定入口/拉起/停桥；双控制台门（桥 token 文件 + SnowLuma 面板密码换 session token）（`panel.ts`、`route.ts`） |

---

## 4. 不可直接比较的部分

dsh-world 的很多"缺失"不是设计缺陷，而是**职责外包**：

- 会话、回合、审批、压缩、记忆块、花费统计由 DSH 宿主承担。插件只提供"世界"语义（人设、日记、生活线、归档范围）。
- 因此"没有 unknown 语义"在它的架构里成立——它不写平台，写平台的是桥；"没有消费书签"也成立——消息直接进会话，消费由宿主的回合机制隐含完成。

反过来，Uina 的"缺失"是**范围选择**：

- 没有贴纸/语音/黑话，因为 QQ world 的目标是"可审计的社交在场"，不是"仿真像人"。
- 没有面板，因为世界不假设有人机界面。

---

## 5. 各自的真实缺口

### 5.1 dsh-world 侧

| 缺口 | 证据 |
|---|---|
| 模型无法主动发 QQ 消息（只能靠桥的 socialV2 规则引擎，或桥的 MCP 工具绕过插件） | `reach_out` 只走 toast/outlets；QQ 模块无工具注册 |
| 群消息不进记忆，且归档无法区分渠道 | README §QQ 的记忆与开关 |
| 桥是硬依赖：换任何别的 QQ 实现都不支持 | README "除它之外不支持别的 QQ 实现" |
| 绑定会话需停桥改文件（桥把 `sessions.json` 读进内存并回写） | `bridge.ts:403-429` |
| 审批权在人（桥控制台），模型无法处理好友申请 | 38 个工具中无社交审批 |

### 5.2 Uina 侧

| 缺口 | 证据 | 影响 |
|---|---|---|
| **断线不自愈** | `config.json` `reconnect.retries = 0`；`transport.ts:301` `if (this.reconnectAttempts >= config.retries) return;`；SDK 侧显式 `reconnect: false`（`transport.ts:220`） | 上游重启/网络抖动后，世界静默失效，只能手动重启 world。有 gap 记录，无恢复动作 |
| **无上游看门狗** | 无心跳/`lastPacketAgo` 判定 | "连着但收不到消息"这类故障不可检出（对照：qq-bridge 用 30s heartbeat + 105s 静默翻 false） |
| **端点写死** | `config.json` `ws://127.0.0.1:3001` | SnowLuma 换端口需人工改配置 |
| 表达面薄 | 无贴纸库、无语音库、无 face 语义目录之外的表达 | 社交在场偏"文字 + 系统表情" |
| 无运行态自述 | 无 `status` action | 模型无法自查连接健康度，只能等 internal 事件 |

---

## 6. 对 Uina 的判断

**值得吸收（按性价比排序）：**

1. **上游看门狗 + 有限自动重连。** 不是照搬 supervisor 的六态机，而是把 `retries` 从 0 提到有限次（指数退避已有实现），并加"已连接但 N 分钟无事实"的判定 → 产出 internal 事件。这是当前唯一会让世界静默失效的路径。
2. **端点漂移自愈。** 若 SnowLuma 端口可变，把 `connection.url` 的发现/回写做成启动期一次同步，而不是人工改配置。
3. **运行态自述（可选）。** 一个只读 `status` 语义（连接、最近事实时间、未结算操作数、open 事项数）能让主体自己判断"我现在听得见吗"，比等 internal 事件更主动。

**不值得吸收：**

- 38 个平坦工具 + 会话令牌入模型上下文。Uina 的 1×14 facade 在 token 成本、引用一致性、授权可审计三方面都更优。
- 把 QQ 能力外包给第三方进程。当前自持方案让 platform 语义可被测试覆盖（`tests/` 内可注入 fake transport），这是 dsh-world 无法做到的。
- 把 QQ 消息并入主体记忆。Uina 的"世界事实 ≠ 主体记忆"是更干净的边界。

**一个反向观察：** dsh-world 把"社交审批、名片、撤回"整块留给**人**，Uina 把这块交给**主体 + grant**。这不是能力差距，是主体性主张的差异。若 Uina 未来要收敛风险，`requests.respond` / `profile.modify` / `messages.retract` 三个 grant 默认不授予，就是现成的收敛开关——不需要改代码。
