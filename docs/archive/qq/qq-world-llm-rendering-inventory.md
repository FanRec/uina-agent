# QQ World：LLM 可见内容模板全量盘点

日期：2026-10-07。范围：所有会进入模型上下文的文本（工具定义、批次现场、工具回执）。
排除项（非 LLM）：`index.ts` onStart throw（host/UI 可见）、`scheduler.ts` console.warn（日志）、`transport.start()` 错误（启动失败可见性）。

## A. 工具定义层（常驻 system/tools 区，每回合都在）

| 来源 | 模板 | 备注 |
| --- | --- | --- |
| tool-schema.ts L5 | `QQ_TOOL_DESCRIPTION`（qq facade 总描述） | 常驻 |
| tool-schema.ts | 5 个 action description（observe/speak/gesture/attention/follow_up/account） | 常驻 |
| tool-schema.ts | 68 条参数/分支 description（源自 qq-world-tool.json） | 常驻；含 "从 expressions 查询得到的系统表情编号"、"复制 expressions 返回的 reactionCode" 等行为指引 |

## B. 主动推送层（render.ts，scheduler → emitEvent → input）

| 模板 | 形状 |
| --- | --- |
| renderBatch 会话头 | `[QQ 群聊\|QQ 私聊\|QQ 临时会话] snapshot=<本地时间 GMT+08:00>` + `conversationRef=…；"<最后发言者显示名>"；trigger=<private\|at_self\|reply_self\|poke\|recall\|cls>` |
| messageLines（前文/新增行） | `<前文：\|新增：>HH:mm\|MM-DD HH:mm \| qq-message:ref \| <sender>\|replyTo=…` + 次行 `quote(正文)` |
| senderLabel | `我（已确认发言）`/`我`/`qq-user:<self>:<uin> "<显示名>"`/`?` |
| segmentText | text 原文；`@显示名或userRef`；`[face:id]`；`[卡片\|XML 卡片] <截断240>`；`[合并转发 resId=…（observe…展开）]`；`[image ref=… url="…"（未展开）]` |
| 跟进行 | `待跟进 qq-follow-up:…：note="…"` |
| 背景行 | `背景：另有 N 条普通事实待合并（可观察获取）。` / `已省略` |
| coverage 行 | `coverage=本次新增完整…hasMore=false` / `因预算截断…hasMore=true（用 observe…继续读取）` |
| renderFollowUpBatch | `[QQ 待跟进] snapshot=…；source=主体保存的事项` + `ref=…\|state=…\|target=…\|note=…\|reviewAt=…\|evidenceRefs=[…]` + `不自动执行；仍 open 可随时主动查。` |
| renderAccountEventBatch | `[QQ 状态事件] snapshot=…；source=内部连接/账号状态` + `HH:mm \| kind \| summary` + `用 observe(scope="status") 核验当前事实。` |
| looseText | 平台历史页用：同 segmentText 的降级版（@仅编号、不铸造引用） |
| TimeView | 快照头完整时间+偏移；行内同日 HH:mm、跨日 MM-DD HH:mm |

## C. 工具回执层（app.ts 74 处 worldSucceeded/Failed/Unknown）

### C1 成功模板（写动作）
speak（sent+target/messageRef+已确认分段/停止于分段/余下未派发不整包重发）、gesture.react、gesture.poke（群/私聊同模板）、attention.set/clear、follow_up.create/update/close/cancel、account 9 操作（respond_request/retract/mark_read/leave_group/remove_contact/set_profile/set_avatar/set_group_card；set_presence 固定拒绝）、dispatchWrite 附 `operationRef=`+diagnostic。

### C2 成功模板（observe scopes）
status、capabilities（⚠️ 文案称 "includeMedia 仅提供未展开元数据" —— includeMedia 已实现展开，**已过时**）、attention、follow_ups、operations（单条/列表）、requests、overview（⚠️ "近期账号事件" 只列 kind@time）、messages（每条 `ref \| time \| sender \| 正文`）、members（`qq-user:… \| nickname=… \| card=… \| role=…（占位不作真实身份）`+空结果覆盖说明）、conversation（经 renderConversationPage：头/行/recentEvents/coverage+hasMore/nextCursor；⚠️ self 的 "（includeGroups 分页群身份：后续切片）" 是未实现功能的预告文字）、contacts/groups/conversations、expressions（id 行+guidance）。

### C3 失败/未知模板
- 校验类 26 处：invalid_target/account_mismatch/invalid_content/media_*/mention_target_unverifiable/reply_target_*/not_own_message/unsupported_target/invalid_kind/invalid_operation/invalid_params/invalid_reaction_code/unknown_*/cursor_invalid/no_local_facts/not_found…
- media-root.ts detail 文本（not_absolute/traversal/not_found/not_file/outside_roots/no_roots，经 `媒体复制失败/资源校验` 进正文）
- queryFailed：`failed / <label>\nreason=<kind>: <reason>\n下一步：<QUERY_NEXT_STEP>`
- dispatchWriteRaw：`failed / …（platform_rejected\|not_connected）`、`unknown / …（operationRef+核验指引）`
- grant 拒绝：`本实例未授 <grant>；适配器可能有实现，但未调用平台。`

## D. 嵌入回执的行模板（media-fetch.ts / app.ts）
- expandImages note：`media=请求展开 N 张：成功 X，失败 Y` + `失败 ref=… file=…：原因`
- renderForwardNodes：`合并转发（N 条，仅一层不递归）：` + `  "名字"(uin)：正文` + 超限标注；forwardUnavailableLine
- cursor：`hasMore=true；nextCursor=<base64>`

## E. 已发现问题（下一轮修复输入）→ 已于 2026-10-08 处理

1. ✅ capabilities 文案改为与 includeMedia 实现一致（抓图附加 base64；音视频不转写）。
2. ✅ self 实现 includeGroups（所在群列表）与 groupConversationRef（get_group_member_info 自己的 card/role），删除"后续切片"预告。
3. ✅ 模板单源化：render.ts 新增回执正文区（receipt.ok/fail/unknown 三态头 + RECEIPT_NOTES 指引注记 + membersLine/capabilityLine/operationRow/operationRecordLines/requestRow/followUpRow/expressionLine/messageRow 集合行）；app.ts 内联 `succeeded/failed/unknown /` 头清零；校验类单句保持与校验逻辑同址（高内聚，无漂移史，不强迁）。
4. ✅ 时间口径规则统一（按合同 §5："程序 UTC 不变，快照头一次偏移"）：**有快照头的现场**（批次/会话页/待跟进/状态事件）走 TimeView 本地化；**无头回执**（messages/operations/requests 行）保持原始 UTC。接线修复：app.ts 两处 `new TimeView()` 改经 timeView(deps)（display.timezone 此前对 observe 失效）；QqAppDeps 增加 display 由 index.ts 注入。
5. ✅ 归入第 4 条规则（overview 事件 UTC 属无头回执，合规）。
6. ✅ ingest 未识别分段改为 `{type:"unknown", rawType}` 事实，`[未知分段 type=…]` 文字单源到 segmentText；旧 journal 的 text 段兼容渲染。
7. ✅ 指引规则登记：只读查询/unknown 有"下一步"（queryFailed/verifyOperation 单源 RECEIPT_NOTES）；校验类失败靠 schema+reason，不加指引（噪音）。
- 附带收敛：app.ts 三处分散 render 导入合并为单一 namespace import；k=v 漂移清理（8 处半角冒号统一全角）。
