# QQ World 施工规划

日期：2026-10-07。状态：阶段实现与证据见 §4 Gate 台账；完整首轮 G9/G10 尚未验收。
依据：[主设计](../../proposals/qq/qq-world-design.md)（首版职责/gate 记录）、[交互合同](qq-world-interface.md)（旧版认知语义）、[ToolDef fixture](../../proposals/qq/qq-world-tool.json)、[示例集](../../proposals/qq/qq-world-interaction-examples.json)（fixture）、[grant schema](../../proposals/qq/qq-world-deployment-grants.schema.json)（部署授权）。当前参数以 [实际工具 schema](../../../.uina/worlds/qq/tool.json) 为准。
[开发指导](qq-world-development-guide.md)（2026-10-05）是 NapCat 世代旧稿：其阶段字母与动作名（read/send/send_voice）**不作为本规划依据**，其所有权表、五状态结果、unknown 不重发、生命周期不变量仍然有效并被收口版继承。冲突时以收口版 + 当前源码为准。

## 0. 探索确认的接缝事实（2026-10-07 源码核对）

| # | 事实 | 位置 | 对 QQ 的影响 |
| --- | --- | --- | --- |
| F1 | `WorldDef` 一个世界注册一个 facade 工具；AJV 校验 action.params；动作必须返回结构化 `ToolExecutionResult` | `src/extensions/world-framework/world-tool.ts` | `qq` facade + ToolDef 直接落为 `actions.observe/speak/gesture/attention/follow_up/account` |
| F2 | `Tool.executionMode` 存在但 world-tool 未透传 | `src/tools/broker.ts:19` vs `world-tool.ts` | 设计 §6 透传 #2：WorldDef 声明 `executionMode: "sequential"` → createWorldTool 透传 |
| F3 | `WORLD_HOST_EVENT_TYPES` 缺 `agent_end`/`agent_settled` | `src/extensions/world-framework/types.ts:121` | 设计 §6 透传 #1：补两词，调度器 busy-recheck 才有事实源 |
| F4 | `emitEvent` → `submitInput(followUp/urgent→steer)`，render 延迟执行、scope 停用返回 null；`input_settled` 事件带 inputId 与 `retired(empty_render/...)` | `src/extensions/world-framework/world-activation.ts`、`src/runtime/events.ts` | 单占位 = World 自持一个未结算事件 id；input_settled(committed) 推进 notifiedThroughSequence；空 render 退役免费获得 |
| F5 | `onHostEvent`/`onActivity`/`isBusy` 已在 ServiceCompanionContext | `world-framework/types.ts:70-80` | busy-recheck 用 isBusy + agent_settled 通知，配可取消 recheck timer |
| F6 | `worldDataDir = stateRoot/world-data/<world>`；框架 state store 仅支持 `Record<string,boolean>` | `world-activation.ts:99`、`world-state-store.ts` | facts journal / operation log / control store 由 QQ 自持文件实现（bilibili-live `journal.ts`+`notification-settings.json` 为先例） |
| F7 | world 从 `.uina/worlds/<name>/` 目录入口加载，支持 package.json#uina.entry；config 自理 | `world-loader.ts` | QQ 代码落 `.uina/worlds/qq/`，deployment 配置（endpoint/token/self_id/grants）在 `config.json`，grants 用 grant schema 校验 |
| F8 | `worldSucceeded/worldFailed/worldUnknown` helper 已存在；`effectUnknown` 抛错→unknown | `world-framework/result.ts`、`world-tool.ts:104-116` | 五状态 + effect=applied/accepted/unknown 正文合同直接复用 |
| F9 | SnowLuma：本地 `E:/Uina/ThirdParty/SnowLuma` 是部署发行版 v1.14.21（自包含、含真实账号数据目录，**禁止读写**）；npm 有 `@snowluma/sdk@1.14.22`，`@snowluma/onebot` 未单发 | 本地目录、npm registry | SDK 走 npm 依赖；**发行版 ↔ 固定 commit `87527cb` 行为一致性是 P0 预检项** |
| F10 | 参照 world：bilibili-live 的 fake client adapter、BatchedNotifier、generation guard、通知设置落盘、`tests/bilibili-live-*.test.ts` 假传输模式 | `.uina/worlds/bilibili-live/`、`tests/` | 测试惯例照搬：假 transport + 临时目录 + 假时钟；不触真实凭据 |
| F11 | 工作树有未提交修改（bilibili-live/netease-jukebox/src 等）；当前分支 `codex/phase0-baseline` | `git status` | QQ 开发全为新增 + F2/F3 两处小改；不重置、不覆盖 |

内核 allowlist 约束：QQ 全部逻辑在扩展侧；本规划只改 `src/extensions/world-framework/` 两处既有机制透传（F2/F3），Core/Host/UI 零改动。若实施中发现需要更多，按设计 §6 停下走四关。

## 1. 模块依赖图（施工顺序的拓扑序）

```text
                    ┌────────────────────────────────────────────────┐
                    │ L0 契约层（无依赖）                              │
                    │  qq/types.ts     ref/事件/事实/控制 领域类型      │
                    │  qq/schema.ts    ToolDef→运行时 JSON Schema 常量 │
                    │  qq/grants.ts    grant 词表 + 校验（grant schema）│
                    └──────┬───────────────┬───────────────┬─────────┘
                           │               │               │
              ┌────────────▼───┐   ┌───────▼────────┐  ┌───▼──────────────┐
              │ L1 持久层       │   │ L2 传输层       │  │ L3 媒体层         │
              │  facts-journal  │   │  onebot-client  │  │  resource-root   │
              │  (消息/事件/序号 │   │  (SDK 包装:echo  │  │  realpath 校验    │
              │   notifiedThrough)│  │  关联/超时/重连) │  │  staging 副本    │
              │  operation-log  │   └───────┬────────┘  └───┬──────────────┘
              │  (echo关联/迟到  │           │               │
              │   回执/unknown)  │           │               │
              │  control-store  │           │               │
              │  (attention+    │           │               │
              │   follow_up+rev)│           │               │
              └──────┬──────────┘           │               │
                     │                      │               │
              ┌──────▼──────────────────────▼───────────────▼─────┐
              │ L4 摄取层：OneBot 事件 → 规范 QQ facts              │
              │  账号边界 ref 铸造 / self 回送归并 / request 解析    │
              └──────────────────────┬────────────────────────────┘
                                     │
              ┌──────────────────────▼────────────────────────────┐
              │ L5 调度层：候选派生 → 批次窗口 → 单占位 → busy-recheck│
              │  (依赖 L1 control+facts、F3/F4/F5 事件、可取消 timer)│
              └──────────────────────┬────────────────────────────┘
                                     │
              ┌──────────────────────▼────────────────────────────┐
              │ L6 动作层：observe 各 scope / speak / gesture /     │
              │  attention / follow_up / account 九操作             │
              │  (grant 中间件横切全部入口；L2 在线查询+L1 离线事实)  │
              └──────────────────────┬────────────────────────────┘
                                     │
              ┌──────────────────────▼────────────────────────────┐
              │ L7 呈现层：模型正文模板（交互合同 §5-6）/ 压缩窗口 /  │
              │  cursor / 固定提示词落位                            │
              └──────────────────────┬────────────────────────────┘
                                     │
              ┌──────────────────────▼────────────────────────────┐
              │ L8 装配层：.uina/worlds/qq/index.ts                 │
              │  WorldDef + onStart/onStop + emitEvent/render +    │
              │  input_settled 记账 + config.json 装载             │
              └────────────────────────────────────────────────────┘

  横切（不归属单层）：grant 检查中间件（L6 全入口）、五状态结果合同（F8）、
  假 transport 接口（L2 定义，L4-L8 测试共用）。
```

依赖规则：只允许上层依赖下层；L1 三存储互相独立（control 写失败不得拖垮 facts）；L2 是唯一触碰 SDK/网络的模块；L4-L7 全部可对假 transport / 临时目录 / 假时钟测试。

## 2. 开发策略

**gate 即脊柱的离线优先纵向切片。** 依据：

1. 设计 §7 已裁定"完成十个适用 gate 的最小真实切片"是唯一交付标准，且"fixture+localhost 不证明真实 QQ"——所以阶段划分直接按 gate 归组，每阶段退出条件就是一个或多个 gate 的离线部分绿。
2. 奥卡姆：G1（纯数据/形状）→ G4（纯文件）→ G6（假传输）→ G2/G3（纯组合）→ G5（假时钟+真队列）→ G7/G8 → G9/G10（真实验收）按"依赖深度+验证成本"递增排列，先便宜后昂贵，前面阶段不改后面阶段的接口。
3. 对抗式审查内建：每个阶段用示例集 `invalidCalls`/`semanticRejections` 反打自己的实现，而不是只测 happy path；G2 的"SDK 写调用 0 次"用 fake transport 调用计数器作硬断言。
4. 两个框架透传（F2/F3）先行独立落地——它们是 L5/L6 的硬前置，且各自可单独验证，避免和 QQ 业务混在一个改动里。

**禁止项**（继承设计 §6/§8 与内核 allowlist）：不为 QQ 加 Core/Host 分支；不建 notify 队列/消费游标/曝光账本；不实现已删机制（条件更新、resumeBacklog、expectedRevision）；旧 guide 的阶段字母不沿用。

## 3. 阶段规划与完成度追踪

每阶段一个独立提交；完成报告按旧 guide §7 的七项格式。**gate 台账**（§4）是唯一完成度账本：每阶段收尾更新对应行的"证据/状态"列，状态只有 `未开始 / 离线通过(证据链接) / 未验证(原因) / 通过(命令+版本)` 四种。

### P0 预检与契约层（→ G1 数据形状部分）
- 核实 `@snowluma/sdk` npm 版本与固定 commit `87527cb` 的行为一致性：websocket-client echo 关联与 pending 超时、connect 阶段期限、rawResponse 迟到回执观察面、config statusCommand 默认值。结论记入本文件 §0 追加行；不一致则停在记录，不猜。
- 建 `.uina/worlds/qq/`：`src/types.ts`（ref 模式、领域类型）、`src/schema.ts`（ToolDef 落地）、`src/grants.ts`、`config.json` 形状（endpoint/port/path/token/self_id/deployment.grants）。
- 测试：示例集 validCalls 全过 AJV、invalidCalls 全被拒、deploymentCases valid/invalid 校验（纯数据门）。

### P1 框架透传（两个独立小改动，→ 无 gate 但为 G5/G6 前置）
- `WORLD_HOST_EVENT_TYPES` 增加 `agent_end`、`agent_settled`（F3），验证 runner 事件分发可用。
- `WorldDef` 增加 `executionMode?` 声明，`createWorldTool` 透传到 Tool（F2），broker sequential 语义加测试。
- 此阶段可先行单独提交。

### P2 持久层（→ G4）
- facts-journal：消息/事件追加、每会话入站顺序、notifiedThroughSequence、retention 覆盖起点标记。
- operation-log：operationRef 铸造、echo 关联、迟到回执归并、unknown 列表。
- control-store：attention 规则（安装初值+账号+会话覆盖）与 follow_up 簿，原子写（tmp+rename，沿用 world-state-store 模式）、revision 诊断计数。
- 账号绑定文件：self_id 快照。
- 测试：临时目录跨进程写读一致、写失败不宣称保存、损坏明确失败；控制写失败保留旧值。

### P3 传输与摄取（→ G6，G3 前置）
- onebot-client：连接、echo 关联（期限覆盖 connect）、超时→unknown、迟到回执 raw 观察、重连 generation guard（bilibili-live 模式）、statusCommand 关闭校验。fake transport 接口在此定义。
- 摄取：OneBot→规范 facts；temp 保留源群、self 私聊 sender≠peer、self 回送归并真实回执、request flag 解析、bot_status/断线内部事件。
- 测试：故障注入（写超时 unknown 不重发、同 echo 迟到回执归同 operationRef）、乱序/重复事件、占位值不冒充真实身份。

### P4 授权与动作层（→ G2、G3）
- grant 中间件横切全部 action 入口：grant 外 → failed + reason=grant_denied + effect=not_started，fake transport 写调用计数 0，无逐次审批；capabilities 三维返回；写 grant 不隐含读 grant。
- observe 各 scope（members 本地过滤分页、conversation 窗口、requests、operations 核验）；speak/gesture/account 九操作映射表（§3.2 表逐行落地，占位/未验证映射明确拒绝）。
- 目标校验：ref 账号边界、reply 属主、重名不猜人、成员覆盖未知不推出非成员。
- 测试：semanticRejections 全 fixture（含 deployment_denied 的 expectedPlatformCalls=0）。

### P5 调度与队列（→ G5）
- 候选派生表（交互合同 §4 表逐行）：Direct/普通/申请/poke/recall/断线/reviewAt/暂停结束/迟到回执/ticker 不复制。
- 批次窗口（quiet/direct/普通群/申请四组 quiet/maxWait 初值）、同类按等待年龄、preferred 有限偏置、稳定 ref 平局、A 占位→B 下一优先。
- 单占位 + emitEvent 串联；input_settled(committed) 记账；busy-recheck（agent_settled 通知 → isBusy 核验 → 可取消 recheck，awaited 回调内不等待）。
- attention 生效计算（silent/pause 禁机会不禁显式工具）、暂停结束单次积压摘要、reviewAt 单次提醒。
- 测试：假时钟 + 真 Subject 队列组合（沿用 host/agent 事件语义测试惯例）；merge/静默/单占位/中断不第二主体。


### P6 呈现层施工设计（2026-10-07 细化，实施前唯一规格）

**目标**：交互合同 §5/§6 的正文合同成为唯一呈现实现；模型可见文本单一 owner（`src/render.ts`，纯函数）；三个出口（调度批次、observe 各 scope、动作结果）全部收口。

**核心决策**：

1. **无 IR、无双表示**：render 函数直接消费规范 facts（MessageFact/EventFact/OperationRecord/FollowUpItem）+ 只读快照（notifiedThrough/control），不再造中间表示。动作层产出 facts，render 产出正文；details 继续携带 facts 供程序消费。
2. **时区**：事实一律 UTC 存储；`config.display.timezone`（IANA 名，缺省宿主时区）只在渲染层转换。TimeView 输出：快照标题偏移标注（`GMT+08:00`）一次；行内时间同日只显 `HH:mm`，跨日显 `MM-DD HH:mm`。
3. **首场景/续场景**：`notifiedThrough` 无该会话 → 首场景，尾部起点 16 条（前文+新增同窗）；否则续场景 = 新增（seq > notifiedThrough）+ 必要前文（仅 reply anchor，不固定附长尾部；anchor 本地缺失标"前文不可用"）。
4. **去重**：本快照 Map<messageRef> 已渲染即跳过；新增行 replyTo=X 时 X 的正文只在前文出现一次。跨请求全历史去重**不做**（合同明言未解决，不建曝光账本）。
5. **批次范围**：PendingCandidate 增加 `toSeq`（派发时最新 sequence，与冻结记账同一次快照读取，消除两处取值漂移）；窗口起点由渲染函数按 notifiedThrough 推导，候选不携带 fromSeq。
6. **软预算 14000**（config.display.batchBudgetChars 可调）：削减顺序 = 背景段整体丢（留"背景 N 条已省略"）→ 前文从最旧丢（保留 reply anchor）→ 单条超长原文分片（`…[truncated]` + 继续引用）。任何削减显式标注。
7. **cursor**：base64url(JSON `{v,scope,conv,direction,anchor,source,pos,eventPos,sig}`)；sig=查询参数 FNV-1a，复用条件不符 → `cursor_invalid` 明确失败，不返回空页冒充。conversation 双位置（消息+事件），事件未完先继续同窗口。在线/离线不同源（onlinePos=message_id / localPos=sequence），cursor 带 source，跨源复用报失效。
8. **includeEvents**：conversation observe 读该会话 journal 事件页（各按 limit）；账号级事件不混入。
9. **includeMedia v1**：媒体分段渲染元数据 + "未展开"；图片 base64 附件（broker images 通道）依赖 P7 下载/staging，P6 不冒充。
10. **测试哲学**（合同：词序/排版不是逐字标准）：断言必须信息存在（refs/时间/coverage/effect）+ 禁止项不存在（发送正文回显、空段、未标注截断）+ 性质（预算削减顺序、去重、时区换算）。不写逐字快照测试。

**文件与改动**：新建 `render.ts`（TimeView/escapeText/预算器/renderBatch/renderObserve*/renderAction，约 450 行）；`scheduler.ts` 候选加 toSeq、renderMinimal 删除（renderBatch 全接管，消灭双实现）；`app.ts` 17 处模板迁移；`config.ts` 加 display 段；`index.ts` 装配注入。新建 `tests/qq-world-render.test.ts`。

**实施顺序**（每步独立可验证）：① TimeView+escape+预算器（纯函数先测）→ ② renderBatch+toSeq+装配（首/续场景）→ ③ cursor+includeEvents（conversation 先行，列表类统一 offset cursor）→ ④ 动作结果模板迁移 → ⑤ 全量门+台账。

**明确不做**：跨请求去重、includeMedia 附件、逐字排版冻结、ToolDef 改动、曝光账本。

### P7 媒体层施工设计（2026-10-07 细化，实施前唯一规格）

**目标（G8）**：越界拒绝、自持媒体副本、生成/播放/发送生命周期不混淆 + 真实媒体收发验收。

**源码核实的事实**：SnowLuma 接受 `file:///`、`base64://`、`http(s)://` 三种媒体来源（profile.ts imageSource 注释）；发送管线对 `file://` 的语义前提是"client 与 bot 共享文件系统"（stream-file.ts 头注释，跨机器另有流式上传 API 作后备）；本部署 Uina 与 SnowLuma 同机 → staging + `file://` 是最短正确路径。

**切片（每片独立可验证）**：

- **S1 资源根校验器**（`media-root.ts`，纯函数）：`config.media.allowedRoots`（绝对路径数组，缺省 `[workspace cwd, worldDataDir]`）→ resolve + realpath 逐段确认在允许根内；拒绝 `..`、根外 symlink/junction、未允许盘符/UNC。Windows junction 用例（`fs.symlinkSync(type:'junction')`）钉住。返回规范化绝对路径。
- **S2 staging 管理**（`media.ts`）：`worldDataDir/staging/<operationRef>/<fileName>`；启动清理 = 删除操作已确定（succeeded/failed）的 staging 文件，**unknown 保留**（合同：保留证据不自动重发）；不删源文件；复制失败不 dispatch。不搞租约/引用计数（合同明令不引入）。
- **S3 发送管线**（app.ts `toOneBotSegments` 重写）：`resource{kind:file}` → S1 → S2 → OneBot `{type:'image', data:{file:'file:///<staging>'}}`；`resource{kind:qq_media}` → media index 查平台 URL 直接引用（已是本账号托管媒体，不二次 staging）；混合分段顺序保持；set_avatar 走同一校验+staging；dispatch 屏障不变。
- **S4 入站 mediaRef 铸造 + 索引**：ingest 对媒体分段铸造 `qq-media:<selfId>:<seq>` 写入 segment.mediaRef；journal 恢复时从 facts 重建 media index（Map<ref,{url,fileName,type}>）——facts 是唯一权威，索引可重放。
- **S5 capabilities 探测**：`can_send_image`/`can_send_record` → 媒体维度 supportedByAdapter 从 null 变真实事实。
- **S6 真实验收**：发图片/语音/文件到测试会话 + 对端确认呈现；set_avatar；越界路径实测拒绝。语音格式（silk 转码）是真实未知项——失败如实 failed，不伪转码。

**关键决策**：
1. **允许根必须显式配置**（部署者拍板），缺省 = workspace + worldDataDir；不默认全盘——这个边界就是 G8 验证对象本身。
2. **file:// 而非 base64**：同机共享文件系统假设成立（源码证实）；base64 大文件进 WS 帧无收益。
3. **staging 清理按 operationRef 结算状态**，与 operation-log 天然对齐，零额外状态。
4. **includeMedia 入站下载不做**（v1）：入站图片展开成模型附件需要下载+vision 支持，非 G8 范围（G8 是发送侧自持副本）；渲染保持 mediaRef+url 元数据，诚实标注。
5. 不新增 Core/接缝，全部 world 内部；切片顺序 image → file → 音频（格式未知）→ 视频。

**文件**：新增 `media-root.ts`、`media.ts`；改 ingest.ts（铸造）、facts-journal.ts（索引）、app.ts（管线/探测）、config.ts（media 段）、render.ts（媒体元数据微调）；新增 `tests/qq-world-media.test.ts`。

**实施顺序**：S1（纯函数+越界测试）→ S2（生命周期）→ S4（铸造+索引）→ S3（管线，fake transport 全测）→ S5 → S6（真实验收，对端确认）。

### P8 生命周期硬化（→ G7）
- onStart 失败回滚、onStop 取消新机会/重连、在途结算、重载无重复注册（world-activation scope 语义上验证组合）；恢复只承诺从已保存 facts 重建。
- 测试：disable/reload/中断组合，断言连接/timer/handler 清零、停后无新平台写。

### P9 真实验收（→ G9、G10，需用户授权与测试账号）
- G9：真实 SnowLuma + 授权测试账号——身份核验、收发、对端呈现、一项已启用管理事务。范围与副作用事先明确；缺权限记"未验证/范围排除"。
- G10：指定真实模型——通用机会下自主选择合法路径/正确目标、无来源不凭空活动、实测 token/轮数。
- 全部适用 gate 才称"首轮切片交付"；只到 P8 则明确称"离线组合完成"。

## 4. Gate 台账（唯一完成度账本）

| gate | 阶段 | 设计依据 | 模块落点 | 测试落点 | 状态 |
| --- | --- | --- | --- | --- | --- |
| G1 接口契约 | P0+P6 | design §7、interface §3/§5、ToolDef | L0 schema、L7 | `tests/qq-world-contract.test.ts`（ToolDef deep-equal + 88 fixture）、`tests/qq-world-render.test.ts`（首/续场景、去重、预算削减、cursor、时区、转义） | **离线通过**（批次/会话现场/分页/coverage 全部按合同 §5/§6；one-off 动作结果行保留在动作层，无重复实现） |
| G2 部署边界 | P4 | design §2、interface §2 | `app.ts` grant 中间件 | `tests/qq-world-actions.test.ts`（grant 外 0 平台调用） | 离线通过 |
| G3 目标定位 | P4 | design §3、interface §3.1 | `app.ts` 目标校验 | 同上（account_mismatch/reply_target_mismatch/unsupported_target/重名多候选） | 离线通过 |
| G4 本地连续性 | P2 | design §4.3 | `facts-journal/control-store/operation-log` | `tests/qq-world-persistence.test.ts`（跨进程/损坏/写失败保旧值） | 离线通过 |
| G5 消息/队列 | P5 | design §4.1-4.2、interface §4 | `scheduler.ts` | `tests/qq-world-scheduler.test.ts`（合并/静默/单占位/A 排队 B 优先/busy-recheck/follow_up 计账） | 离线通过 |
| G6 未知结果 | P3+P4 | design §5.1 | `transport.ts`+派发屏障 | `tests/qq-world-transport-ingest.test.ts`、`qq-world-actions.test.ts`（超时 unknown 不重发/明确拒绝 failed/迟到回执 raw） | 离线通过 |
| G7 生命周期 | P8 | design §5.3 | `index.ts` | `tests/qq-world-lifecycle.test.ts`（身份不符拒绝启动/停后不派发/传输释放） | 离线通过（初版） |
| G8 资源/组合 | P7 | design §5.3 | `media-root/media` + facts 媒体索引 + app/index 装配 | `tests/qq-world-media.test.ts`（26 项）+ `qq-world-transport-ingest.test.ts`；[验收证据](qq-world-p7-media-evidence.md) | 通过（`pnpm typecheck` / `pnpm test` / `pnpm build`；真实 SnowLuma `1.14.21-node` + QQ 3415086023；图片/语音/文件及混合顺序对端确认。头像未获授权、真实视频未验） |
| G9 真实 QQ | P9 | design §7 | 现场验收 | 真实账号 | 未验证 |
| G10 真实模型 | P9 | design §7 | Host 组合 | 真实模型评估 | 未验证 |

## 0a. 施工记录（2026-10-07 首轮）

- SnowLuma 源码已克隆至 `E:/Uina/ThirdParty/SnowLuma-src` 并检出固定 commit `87527cb`（= release v1.14.22）。本地 `ThirdParty/SnowLuma` 是部署发行版（含真实账号数据），未触碰。
- **F12（新）**：npm `@snowluma/sdk@1.14.22` 的 dist 相对导入无扩展名，纯 Node ESM 不可加载——SDK 源码已 vendor 至 `.uina/worlds/qq/src/vendor/snowluma-sdk/`（28 文件零外部依赖；仅两处偏离：相对导入补 `.js`、一处 TextDecoder 收窄，行为不变）。
- 框架透传已落地：`WORLD_HOST_EVENT_TYPES` += agent_end/agent_settled；`WorldDef.executionMode` → Tool 透传（`tests/qq-world-framework-seams.test.ts`）。
- 全量门：`pnpm typecheck`（含边界）、`pnpm test`、`pnpm build` 通过。
- 本轮状态见 gate 台账：P6/P7 已施工；P9 的完整真实 QQ/模型 gate 仍待独立验收。

## 0b. 对抗审查修复记录（2026-10-07 第二轮）

按"真 bug / 自欺 / 纯化"三类清理首轮代码，全部有回归测试：

**真 bug（4）**：
1. preferred 偏置写成 `ordinaryWindow * 1000`（=30 分钟），合同是"提前一个普通窗口"=1800ms——preferred 由永久霸权修正为有限偏置（`tests/qq-world-scheduler.test.ts` direct-vs-direct 用例）。
2. quiet/maxWait 语义倒置（"事实越多等越久"）——改为标准去抖+封顶：每次到达重置 quiet 窗口，自首条起 maxWait 强制到期（持续聊天不无限推迟，有测试）。
3. OneBot `reply` 分段未解析——渲染成"[未知分段]"且 `fact.replyTo` 永远为空，调度器 reply_self 直检是死代码；现在 reply 提取为结构引用不进正文（ingest 测试）。
4. `input_settled(committed)` 用 journal 最新序号记账——批次渲染后新到的消息被偷记"已通知"；改为派发时冻结 throughSequence（有测试）。

**去自欺（4）**：
1. 迟到回执归并接线：transport.call 支持 echo（=operationRef），OperationLog 加 echo 索引，index onRaw 解析 raw 帧升级 unknown；确定结论不被迟到副本覆盖（persistence+lifecycle 测试）。
2. 断线/恢复事件接线：onStatus → journal 事件 + internal 候选；"故障只报一次、恢复只对已报故障"状态机在装配层（lifecycle 测试）。
3. retract 所有权：本地未持有时 get_msg 在线核验发送者，平台不可寻址或不属于本人一律不盲发 delete_msg（actions 测试，0 写调用断言）。
4. replyTo 归属：本地缺失时 get_msg 重新核验，核验不一致/不可用明确失败不猜测（actions 测试）。

**纯化**：工厂期不再抛配置错误（发现期失败曾表现为 world_not_found 吞掉真实原因，现移至 onStart 明确失败）；temp speak 路由不再先造 NaN 再覆盖；`toSegmentsLoose` 不再铸造 `qq-user:?:…` 假引用；事件 ref 去 ISO 冒号；internal 候选正文渲染实际事件种类（断线/恢复/状态）；调度器死代码清理；friend history 传参经源码核实（reverse_order 支持后补齐）。

## 0c. P6 呈现层施工记录（2026-10-07 第三轮）

按「P6 呈现层施工设计」五步全部落地，`tests/qq-world-render.test.ts` 8 项 + 全量 1521 项绿：

- **render.ts**（唯一呈现 owner）：TimeView（UTC 存储、渲染层时区转换、快照标题偏移一次、跨日标注）、quote 转义、renderBatch（首场景尾部 16 / 续场景新增+reply anchor 前文、同快照去重、14000 软预算削减顺序=背景→前文（保 anchor）→按超出量精确分片、截断显式标注）、renderConversationPage（source 标注/事件页/coverage）、cursor 工具（FNV-1a sig 绑定查询条件、跨源/条件变化明确失效、不返回空页冒充）。
- **scheduler**：候选携带 toSeq（渲染窗口与冻结记账同源）；renderBatch 变必选依赖、renderMinimal 删除（消灭双实现）；tryDispatch 失败留可见日志（曾发现渲染异常被静默吞成"永不提醒"）。
- **app.ts**：conversation observe 接 cursor+includeEvents（在线优先、离线回退标陈旧、本地无事实明确不可用）；`renderSegments` 与 render.segmentText 重复消除。one-off 动作结果行（speak/attention 等单句模板）保留在动作层——无重复实现，迁移只加间接层，裁定不迁。
- **修复过程中抓到的实现 bug**：预算分片最初只砍固定 40 字符（20000 字原文照样超预算）——改为按超出量精确截断，测试钉住。
- **flake 记录**：一轮全量跑出现 3 个 shell 时序失败（smoke/exec-cwd，与 QQ 无关），隔离复跑与全量复跑均绿，未复现，未隔离（按 flaky 纪律记录在案）。

## 0d. P7 媒体施工与验收记录（2026-10-07 第四轮）

- **实现**：普通文件 → 原路径 `..` 检查 → resolve/realpath/允许根 → QQ staging → 编码正确的 file URI；媒体索引由 message facts 重放，引用账号与类型核验，缺平台 HTTP(S) 地址明确拒绝；头像复用同一管线。配置缺省根为 workspace cwd + worldDataDir，显式空数组禁本地文件上传。
- **裁定（S2）**：operationRef 含冒号不能在 Windows 作为目录名，目录使用 base64url(operationRef)，marker 保留原始引用；UUID 前缀避免同名源文件互相覆盖。unknown/孤儿副本保留、已确定操作启动清理，不删源、不重发。
- **裁定（S3）**：固定 SnowLuma 会重排 file，并可能把 video fallback 为 file，因此 file/video 单独分批，其余连续分段同批；全请求校验与复制在首个派发前完成，各批独立 operationRef/echo，失败停止余下派发，返回 confirmedParts。不存在原子发送承诺。
- **对抗修复（G6/G8 共用边界）**：bridge 抛错被 SnowLuma 包装成 failed/100，不代表效果未发生；普通/迟到回执共享分类，参数/未知动作的 1400/1404 明确拒绝，其余未知负回执保持 unknown。真实平台成功不被回执日志故障改判失败；保存意图失败不派发。
- **离线门**：QQ 9 文件 190/190；全量 126 文件、1548 passed + 1 expected fail；typecheck（含 6 条边界）与 build 通过。新增媒体 26 项与传输负回执回归均有失败证据与通过证据，World startup/restart 默认根及清理另有组合验证。
- **真实门**：绑定 3768832841 → 用户授权的 QQ 3415086023；真实 SnowLuma `1.14.21-node`、OneBot v11。图片/WAV 测试音/文本文件获平台回执，用户确认三项正常；file→text→file 获三独立回执，用户截图确认实际顺序。根外临时 fixture 实测 failed/outside_roots/not_started。
- **证据边界**：头像无部署 profile.modify grant 且无本次真实修改授权；视频仅离线路由/分批验证，真实视频未验；没有实际调用 TTS render_file 或播放链，没有下载/vision 展开入站媒体；G9/G10 不因这次媒体成功自动转绿。详情见 [P7 证据](qq-world-p7-media-evidence.md)。
- **工作树**：原 QQ 目录与先前 QQ 测试整组未跟踪，同时有其他 World/Core/UI 改动；本轮只改 QQ 媒体调用链及相关测试/验证脚本/本规格。没有混入先前切片生成提交，没有 commit/push；未改真实配置、真实会话或 SnowLuma 发行版目录。

## 5. 待决事项（实施到对应阶段前必须裁定）

- **D1 固定提示词落位**：交互合同 §2 的固定提示词段落放哪。World 无 systemPrompt 贡献接缝；候选：WorldDef.description + 各 action description 分摊（不加接缝）vs 请求 turn.prepare 注入（扩展接缝存在但越层）。倾向前者，P6 前定。
- **D2 SDK 依赖方式**：根 package.json 加 `@snowluma/sdk` 依赖 vs world 目录自包含。P0 预检结论决定；禁止修改 ThirdParty/SnowLuma 部署目录。
- **D3 历史查询在线/离线优先级**：合同已定"在线首屏只读尝试，离线保存事实标注陈旧"，实现取哪个为快照主源在 P3/P4 落地时按回执能力定，不新增机制。

## 6. 明确不做（继承设计删减清单）

条件版本更新 / expectedRevision、已排队 ordinary 抢占替换、回复概率训练、精确曝光结算、认知焦点寄存器、通用权限任务框架、resumeBacklog 参数、QQ/Session 消费对账、持久性三态、发送证据等级、自动 replay、关系画像/记忆系统、无消息 heartbeat、默认 ticker。
