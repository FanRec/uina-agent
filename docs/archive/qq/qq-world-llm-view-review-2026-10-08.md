# QQ World：从 Uina 的可见现场审查认知与信息成本

日期：2026-10-08，Asia/Shanghai。性质：审查与改版方案，未实施功能或呈现改动。

后续修订：本稿对当时实现的审查事实继续保留；“必须向模型展示完整 canonical ref”和逐页显示时区的建议，由 [紧凑接口 V2](qq-world-llm-interface-v2-2026-10-08.md) 替代。V2 本身也已归档，当前接口以[实际工具 schema](../../../.uina/worlds/qq/tool.json)和[运行文档](../../current-runtime.md#qq-world)为准。

## 判断标准与证据边界

把自己放在只能看见模型请求、无法偷看程序内存的 Uina 位置：我需要知道谁、在哪、何时、说了什么、在回复谁、发生了什么互动；需要拿到能够直接操作的目标；需要知道动作是否已执行，以及还有哪些内容没有看见。

“程序已经保存”“details 中存在”“可以通过另一工具猜出来”均不等于我已经知道。减少字符不能以失去身份、对话关系、情绪信号、动作结果和可读取性为代价。反过来，revision、staging、SDK 错误、签名 URL、长游标、自述警告的重复通常不能改善我的判断。

已检查当前工作树中的 QQ 装配、全部渲染函数、15 个 observe scope、6 个 action、参数定义、World facade/result、Session 输入投影、event-frame，以及 OpenAI-compatible/Anthropic/Gemini 的工具结果运输路径。此前 QQ 精简及用户已有的其他改动均保留。

本次使用临时存储、合成消息与假 transport 生成真实函数的输出，没有读取真实 QQ 配置、聊天记录或认证，也没有调用 QQ/Provider。下面的示例人名、账号、消息及图片 URL 均是 fixture。认知收益是基于信息是否可见、可解释、可操作的设计判断，未做真实模型行为评估。

## 当前所有可见入口

| 入口 | 当前实际格式/内容 | 是否需要 |
| --- | --- | --- |
| QQ 工具定义 | 一个 qq facade；observe/speak/gesture/attention/follow_up/account；oneOf 参数、枚举、引用 pattern 与描述 | 必须知道动作和合法参数；重复描述、空描述和实施细节可收敛 |
| World 目录 list/search | 启用状态及 QQ 的完整工具总描述 | 发现入口需要；目录只需一句能力摘要，不必再次回显长合同 |
| 外部提醒包装 | user 通知、assistant 合成 external_event_frame 调用、tool JSON 回执；eventId/source/receivedAt/text | 外部来源与“不是我执行的动作”的边界必须保留；正文应避免再叠同义说明 |
| 内部提醒包装 | `[运行时事件 qq-internal · qq]` + 正文 | 内部来源需要；不用在正文重复框架分类 |
| 普通会话批次 | 快照时间、会话 ref、最后发言者名字、trigger；必要前文/新增行；事项、背景计数、coverage | 对话事实、身份、引用关系和缺口必要；标题错误和重复元信息应改 |
| 好友申请/群邀请 | 候选被送入普通会话 renderer；没有专用申请正文 | 申请人、类型、目标、说明、requestRef 是必要信息，目前缺失 |
| poke/recall 提醒 | 普通会话正文 + trigger=poke/recall | 谁做了什么、影响哪条消息必要，目前未随触发事实渲染 |
| follow_up 到期 | ref/state/target/note/reviewAt/evidenceRefs；“不自动执行” | 自己的事项及预约时间必要；固定状态与重复行为提醒可缩短 |
| 账号/连接事件 | 最近五条 kind/time/summary；核验 status 指引 | 变化及时间必要；actor/target 等关系信息不足，平台状态和内部连接不能混标来源 |
| 暂停结束积压 | 每会话未通知条数、最早时间；固定解释 | 会话目标、积压大小/时间可支持主动选择；长解释不必重复 |
| 迟到操作回执 | operation ref、action、target、outcome、reason、settledAt | 确定结论与目标必要；应补已知 messageRef，缩短底层错误 |
| observe.overview | selfId、会话数、pending 申请数、open 事项数、unknown 操作数、近期 kind@time | 简洁且有用；事件只有类型，不能解释人物和事项；计数不是完整平台清单 |
| observe.status | selfId、完整 grants、事实会话数、unknown 操作数 | 诊断时有用；实际连接状态/绑定健康缺失，不能完成文案要求的连接核验 |
| observe.capabilities | 四种媒体的 supportedByAdapter/allowedByDeployment/availableNow；grants；长注记 | 能力、授权、当前条件三者不能混淆；目前适配器实现与平台 probe 混用 |
| observe.contacts/groups/conversations | ref、昵称/备注或群名、来源；limit 截断提示 | 身份、关系、可操作会话入口需要；联系人缺私聊 conversationRef；分页及 kind 行为不完整 |
| observe.members | userRef/nickname/card/role；覆盖注记 | 重名区分、名片和真实角色需要；缺失 role 应标未知而非 member 占位 |
| observe.conversation | 快照/来源/方向；平台或本地消息；可选 recentEvents；coverage/hasMore/nextCursor | 现场、回复/附件/事件、时间与可读范围必须保留；平台历史降级丢关系，游标冗长 |
| observe.messages | ref、原始 UTC、sender、拼接正文；自动展开一层转发；可选图片 | 点查需要；未显示 conversationRef/replyTo，卡片仍截断，图片归属不足 |
| observe.requests | requestRef/kind/requester/comment/UTC | 申请事实需要；缺 state、显示名、邀请目标群 |
| observe.self | 自身 userRef/昵称；可选前 20 个群或指定群的名片/role | 我是谁及群身份需要；并非完整资料/在线状态查询；前 20 群没有继续入口 |
| observe.expressions | 数字 id、名称/别名/super；长编码指引 | 表情含义和可用编码需要；编码字段应直接对应 faceId/reactionCode，指引缩短 |
| observe.attention | target、实际 mode/priority/pausedUntil | 在我主动询问设置时有用；保留生效规则，别把无暂停的 null 当作重要正文 |
| observe.follow_ups | ref/state/target/note/reviewAt | 查看自己的事项需要；按需补证据及关闭原因，空字段可省 |
| observe.operations | 单条记录或 unknown/recent 列表 | 外部动作核验需要；需要目标、已确认消息引用和查询时刻，不能只给内部 action 名 |
| speak/gesture 成功 | succeeded、目标/消息 ref、effect=applied、operationRef | 成功语义及新引用需要；同一事实无需重复三种表达 |
| attention/follow_up 成功 | ref/target/reviewAt/state、revision/persisted、effect | 保存及实际效果需要；revision 不支撑行动；继承/暂停影响等实际生效差异应说明 |
| account 成功 | respond_request/retract/mark_read/leave_group/remove_contact/set_profile/set_avatar/set_group_card 的结果 | 哪项改变成功、是否部分成功需要；不能由平台接受推断对方已读或 UI 已呈现 |
| account.set_presence | 固定拒绝，无已核实映射 | 当前不可用应明确，不能在 schema 中指向不存在的 presence 选项 |
| 失败/unknown/cancelled | 校验原因、平台拒绝、未派发、超时/断线、操作引用、下一步；有些是 AJV 全分支错误 | 是否派发、效果是否已确认、如何修正必须保留；堆栈/全分支报告/同义 reason 标签可移至诊断 |
| 图片附加 | includeMedia=true 后抓取图片并通过 runtime/Provider 的图片通道运输；正文给成功/失败数 | 图片本身可影响对话意义；必须明确附件与消息/分段的对应；base64 编码说明不是认知内容 |

QQ 没有 environment 文本，因此当前没有额外的 QQ environment systemPrompt 注入。结构化 details 和工具结果 status 并不完整地作为普通文本进入 Provider：尤其 OpenAI-compatible wire 的 tool 消息主要发送 content。因此不能以“status 已在对象中”为理由把正文的成功/失败/未知含义删掉。

## 有问题的地方与修改方案

### 1. 群名被最后发言者名字替代；联系人缺少可发送目标

`convDisplayName()` 取最后一个入站 senderDisplayName。合成群批次标题实际成为 `conversationRef=...；"阿岚"`。我容易把阿岚误当会话名称。contacts 只给 userRef，而 speak 要 conversationRef；“只能复制 ref”的约定使我缺乏主动给从未聊过的好友发言的入口。

方案：标题使用已经取得的真实群名/私聊对象；未取得群名就写群号，不用发言者名字替代。联系人查询同时给由真实好友关系确定的 private conversationRef。群成员保留 userRef 和当前群会话，不把用户身份与会话路由合并。

### 2. 触发事件没有变成我能理解的事件现场

好友申请渲染实际输出 `[QQ 私聊] conversationRef=qq-request-account；trigger=request` 与“新增完整 0 条”，没有申请人、留言或 requestRef。poke 也可能只有空会话和 trigger。recall 未说明被撤消息。recentEvents 只取 ref/kind/time/summary，丢弃已有 actorRef/targetRef/messageRef。

方案：申请单独呈现类型、申请人、目标群、说明、requestRef 和时间；poke 明确“谁戳了谁”；recall 明确“谁撤回哪条消息”。可读的旧内容标为已撤回事实，不能继续当作仍存在的聊天内容。reaction 的编码、增删及对象若摄取未保存，先补来源事实；未知保持未知。该项是人类 QQ 能看见的社交事实，不能作为省 token 的牺牲项。

### 3. 平台历史、点查和实时批次给了不同程度的对话关系

平台历史经 `looseText()` 丢弃 reply 分段；图片变为 `[image（未展开）]`；自己的消息未统一标“我”。点查 `messageRow()` 没带会话和 replyTo。同一句“我也来”因缺少引用关系，可能被理解成另一件事。

方案：三个入口共用分段、发送者、回复关系的呈现规则。旧引用可读时提供必要引用前文；不可读时明确“回复该消息，原文未取得”。先保留关系，不凭相邻消息猜指代。平台历史的附件可提供实际展开入口；没有稳定媒体引用时不能伪造一个。

### 4. 表情、mention、附件有编码却缺少社交意义

`[face:14]` 只有编号；mention 有显示名时隐藏了稳定身份。reaction 只有 notice 类型说明；多张图片在正文只有总数，Provider 运输未保留 ImageContent.alt 的逐消息归属。

方案：已核实目录中的表情写 `[表情：微笑，faceId=14]`；未核实名称就保持未知，不根据编号猜。mention 保留“提到的人”和可复制 ref，特别标出我。图片按附加顺序标 `附件1→messageRef/该消息第几个分段`，不要让模型自己配对。音视频尚未转写/解码时如实标未查看，排版不能弥补未取得的内容。

### 5. 媒体传输数据很长；卡片却把有意义的内容截掉

segmentText 输出 mediaRef、原始 URL、底层 file 值和“未展开”；签名 URL 会占大量字符。我复用或查看媒体通常只需 ref/所属消息。卡片前 240 字符可能都是 JSON 外壳；messages 点查仍走同一个截断函数，不能兑现“再读完整原文”。转发默认展开一层最多 30 节点，但更后节点没有明确继续读取入口。

方案：媒体默认只留类型、真实展示名（若已取得）、引用、查看状态；原始下载 URL/底层路径留给 World。卡片展示从实际结构提取的标题、摘要和有意义链接，并标明来自卡片自报；不要把可行动链接与媒体传输 URL 一起删。保留可读的原文/后续节点入口。无法获取更多时明确不可读取，而不是给一个不会返回更多的指引。

### 6. 时间简写让不同日期看起来发生在同一天

conversation 页每条都传 previousIso=undefined，跨午夜仍显示 23:59、00:01。批次第一条也可能使用窗口之外的前一条消息判断日期。messages/requests/operations 又使用 UTC，与现场的 GMT+08:00 形成两套阅读习惯。

方案：事实仍存规范 UTC；我看的页面标一次完整日期和时区。首个可见日期和每次日期变化必须明确，之后同日才简写 HH:mm，跨年标年份。需要拿时间回填工具时返回带时区的完整值；不能用无时区简写代替调用参数。

### 7. “新增”“覆盖”“来源”和行为告诫反复占正文

当前先有“新增：”段头，每条再写“新增：”；尾部又给 coverage/hasMore/继续调用示范；首场景省略行和 coverage 可重复同一缺口。正常列表不断重复“平台快照；完整覆盖未知”。follow_up/回执重复静默、非自动执行等固定规则。

方案：保留一次段头、一处来源、一条简短覆盖结论。成功普通批次用 `新增2条，已完整呈现`；缺口用 `省略较早8条；可继续读取` 并给真正可用的参数。固定规则放工具合同；离线、过期、截断、效果未知等本次异常仍必须突出。

还有一个可理解性问题：members/request/follow_up 等行直接插入带引号的值，messages 直接插入正文；昵称、留言或正文里的换行/引号可使外部内容看起来像新的元信息行。方案是元字段统一安全引用、消息正文每行统一缩进，只转义一次，并保留外部归属；不以双层 JSON 转义换取安全感，也不让名称或正文伪造事实行。

### 8. 分页承诺、展示上限与实际继续入口不一致

contacts/groups/conversations/requests/follow_ups 的 limit 后提示“再用 limit 取余”，实际只会扩大同一个前缀而非取剩余；多个 scope 的 cursor 未被执行代码使用，conversations.kind 也被忽略。self.includeGroups 只取前 20 个群；members 未按 limit 截断。conversation 的一个实际游标是 191 字符的 base64 JSON，含可由查询推导的字段。默认若干本地列表可返回全量。

方案：先把每个 scope 的能力说准。有限首屏是呈现起点，不是总容量限制；后续必须能取增量而非反复取旧前缀。保留全部内容的可达性，未接线参数实施或移除，禁止宣称可用。游标仍由程序生成、原样复制、绑定查询，但编码缩短冗余 payload；不引入会话句柄/隐藏 registry。具体新版游标须验证跨源、过滤变化、账号、重启及失效语义。

### 9. 裁剪计数与正文变形影响理解

软预算只测局部正文，不代表最终模型请求 token。背景所谓“削减”只是换一句相近长度的话。文本裁剪取已经 quote 的字符串后再次 quote；`freshShown` 把截过文本的消息扣成未呈现，实际上其 ref/部分正文仍在。

方案：先删非认知冗余、预算按最终展示文本衡量；仅正文确需裁剪时保留身份、ref、回复和附件边界，基于原文裁剪并只转义一次。区分“完整消息 N / 部分正文 N / 未呈现 N”；继续读取必须可以取得真正缺失的部分。不可把必要正文换成模型生成摘要后当作原始事实。

### 10. 正常动作回执太像后台日志，unknown 又缺少更清楚的定位

发送结果同时出现 succeeded/sent/effect=applied、重复已知 target 与 operationRef。单次发送未知还给“已确认分段=无；停止于分段=0；余下未派发”。operation 点查/迟到更新遗漏记录里已存在的 messageRef。控制写入给 revision/persisted，却不直接解释继承或暂停下的实际生效变化。

方案：普通成功留一个明确结论、新产生的 ref，以及必要的实际变化。已知目标可以简写，但历史记录被单独读取时仍要可定位。确认失败与效果未知必须区分：未知留 operationRef、可能已执行和核验入口；多批次留已确认、未知、未派发各部分。记录保存故障会影响以后核验，仍要有一条明白诊断。attention 返回实际生效规则，follow_up 给实际预约/结算变化；revision 留在程序 details。

前轮已复现的 replyTo 未进入发送载荷、账号 silent 被局部覆盖、重连成功未通知恢复仍是行为缺口。新版回执不能靠措辞掩盖它们；“带引用回复已发送”“已经全局静默”“已经恢复连接”等结论必须先由真实执行事实支撑。

### 11. status/capabilities 的诊断含义不准确

status 没有连接事实，却被当作核验连接的下一步。capabilities 的 supportedByAdapter 来自平台 can_send_*，平台暂时不能发送并不说明本地适配器没实现；video/file 已有派发代码，却显示 supportedByAdapter=null。授权与当前平台条件不可压成同一个“能/不能”。

方案：status 显示当前连接、绑定身份/健康及最后一次确定观察时间，拿不到就说未知。能力用简短表头 `类型 | 适配器实现 | 部署授权 | 平台探测`；具体格式及对端呈现仍未知时保留这一差别。grants 只在实例能力合同或诊断请求中给一次，不重复灌入所有能力行。

### 12. 工具描述包含实施细节和不存在的使用路径

“单写方直接修改当前状态”“复制到 staging”“QQ 不产生主体通用自主活动”不能告诉我下一步如何玩 QQ。set_presence 描述要从 capabilities/self 复制已核实选项，当前两个入口都不返回这些选项；limit 的“无固定最大条数”也不能抹掉历史请求实际钳制 200 的事实。

方案：只保留用途、参数含义、当前限制和效果语义；不写未实现路线图。保持一个 QQ facade 和实际完整能力，不为省 token 默认隐藏工具。不可用动作明确不可用。schema 的合法键、必要约束及精确含义保留；相同字段约束可在同一个对象的共享 properties 收敛，互斥且其余相同的 const 分支可合并 enum。

### 13. 参数错误把无关分支一起倾倒给我

仅缺 conversationRef 的调用，当前 createWorldTool 返回 1,500 字符的 allErrors/oneOf 全分支说明，包括 unrelated messageRefs、operationRef、includeGroups 等。它使一次简单修正变成解读校验器的任务。

方案：按已选择的 action/scope/operation 给相关错误，例如 `observe.conversation 缺少 conversationRef；请复制场景或查询中的会话引用`。未知选择器才列可用值。完整 AJV errors 保留 details，不丢程序诊断，也不伪报成功。

### 14. 身份引用可减重复，但不能牺牲可操作性

群聊中同一人每条重复完整 userRef；长 ref 的字符成本真实存在。我又必须能够复制合法目标，因此直接把 qq-message 引用换成 m1 是错误的优化。

方案：默认保留完整 messageRef 和会话 ref。多次发言的多人批次可在页内列一次“显示名→完整 userRef”，行中用无歧义显示名；重名明确区分。只用于阅读的标签不能进入工具参数，不新增跨回合句柄状态。小批次不强行加字典，因为字典本身也有成本。

## 建议统一格式

常驻 QQ 描述保留：QQ 可主动参与；外发表达必须调用动作；复制真实 ref；部署边界；unknown 不直接重发；attention/follow_up 的实际含义及安静决定。“可用性未知不等于不可用，合法明确动作可以正常尝试”仍要保留，避免大量 unknown 注记诱发过度探测或不敢参与；没有动作映射、缺必要目标与已明确不可用的情形另行区分。把一次性、非认知的程序说明移除。若加实例身份/grants，只在 activation 的事实确定后提供，并保持该实例期间稳定，不引入每回合变化的工具描述。

普通会话（未知群名时显示群号；不臆造群名）：

```text
[QQ 群 30003] 2026-10-08 14:00 GMT+08:00
会话 qq-conversation:10001:group:30003
新增：
13:58 小明（qq-user:10001:20002）| qq-message:10001:42
  今晚来不来？[face:14]
13:59 阿岚（qq-user:10001:20003）| qq-message:10001:43 | 回复 qq-message:10001:42
  我也来
新增2条，已完整呈现。
```

face 名称经过目录核验后可替换为语义明确的表情说明。首条可见消息不属于快照当日时，必须显示它的实际日期。必要引用前文独立放“前文”，新增/旧内容不可混淆。

申请/互动（以下需要接入已有触发事实；不能只改标题）：

```text
[QQ 好友申请] 2026-10-08 14:00 GMT+08:00
小玖（qq-user:10001:20009）申请加好友
留言：一起打游戏
requestRef=qq-request:10001:flag-fixture；待处理

[QQ 群内互动] 2026-10-08 14:00 GMT+08:00
会话 qq-conversation:10001:group:30003
小明（qq-user:10001:20002）戳了我
```

正常与异常动作：

```text
已发送至 qq-conversation:10001:group:30003
messageRef=qq-message:10001:99

发送结果未知，可能已发送，请勿直接重发。
operationRef=qq-operation:10001:5；用 observe(scope="operations") 核验。

第1批已确认：qq-message:10001:99
第2批结果未知：qq-operation:10001:5
第3批未派发。不要整包重发。
```

以上简化必须保留 Provider 最终可读的效果状态，不能仅依赖未运输的 status/details。普通已确认操作仍完整持久化；删去常规正文中的 operationRef 不等于删除操作日志。

## 实测成本与可节省范围

字符数基于当前真实工具装配和合成输出，按 JS 字符串长度；不是实际 tokenizer 计数。项目 fallback 给 QQ schema 约 5,527 token，仅用于估算，不能当作 Provider usage。图片 token、协议角色开销、缓存收费也未测。

| 合成样例 | 当前字符 | 提案字符 | 说明 |
| --- | ---: | ---: | --- |
| 两条普通群消息 | 332 | 234 | 保留身份、时间、messageRef、reply 关系及正文；约少30% |
| 正常发送回执 | 139 | 69 | 保留目标、明确已发送和新 messageRef |
| 单批未知发送 | 177 | 88 | 保留可能已发送、不可直接重发及核验引用 |
| 成员查询超时 | 129 | 26 | 留下本次失败与重试；不再重复通用诊断流程 |
| 图片元数据 | 263 | 25 | fixture 中含180字符签名参数；只移除传输 URL/底层名字，真实文件展示名仍按需保留 |
| 到期事项 | 256 | 132 | 留事项 ref、会话、note、证据；此例预约等于通知时间，过期预约需另保留原时间 |
| QQ 工具 schema | 17,839 | 16,008 | 只做相同约束共享/同构分支合并及空描述删除的临时结构实验，约少10.3% |

schema 实验在现有 76 个 valid/invalid fixture 调用上，新旧接受/拒绝一致；不代表所有输入、所有 Provider 兼容或模型调用质量都已验证。继续优化需保持约束和单一真源，补边界等价测试，并比较真实 Provider 的用量及行为。只压缩字段 description 不足以解决整体成本：66 处 description 正文合计仅 1,673 字符。

一次外部事件在此样例经默认三消息组运输的完整 wire JSON 约 1,070 字符，明显大于 332 字符的 QQ 正文；这包含协议字段和序列化，不能把差额全当作浪费，也不能等同模型计费。先优化 QQ 正文，若随后处理公共帧包装，需作为独立跨世界合同审查，保留来源和合成调用边界。

## 建议顺序与验收

1. 先补会改变社交理解的事实：会话身份、申请/互动现场、回复/附件/表情含义、跨日时间、联系人写入路由。不拿这些信息换字符数。
2. 修正 schema 与可见内容对当前能力的错误承诺；补真正可用的分页/详情读取；让状态诊断和回执结论有实际证据。
3. 收敛重复段头、注记、成功日志、签名 URL、全分支校验错误及长游标。
4. 最后做 schema 结构收敛和多人批次身份去重；保持一个 facade，不增加 Core 概念或隐藏能力。

验收样例应包含：同名成员、自己发言、首场景引用较旧消息、跨午夜/跨年、好友申请/群邀请、poke/recall/reaction、两条消息各附图片、卡片详情、长转发、分页与查询条件变化、部分发送与迟到回执、离线保存事实、过期预约。用实际投影后的请求检查必要信息存在、无错误身份/虚假可用性，且必要正文可以继续取得。真人社交质量和真实 token/缓存收益要用后续授权的模型与 QQ 场景评价。

## 可核对的来源与样例

- `.uina/worlds/qq/src/render.ts`：所有批次、分段、时间、集合行和通用注记。
- `.uina/worlds/qq/src/app.ts`：全部查询、动作、分页、回执与模型正文拼装。
- `.uina/worlds/qq/src/ingest.ts` / `scheduler.ts` / `types.ts`：我本可看见的事实及哪些触发器入队。
- `src/extensions/world-framework/world-tool.ts` / `result.ts` / `builtins/world-store.ts`：工具 schema、校验错误、状态标签和目录复述。
- `src/session/recovery.ts` / `src/extensions/event-frames/projection.ts` / `protocol.ts`：输入来源与默认外部帧。
- `src/ai/gateway.ts` / `providers.ts`：最终运输的正文、图片和状态边界。
- `generated/qq-llm-view-audit/2026-10-08/current-samples.json`：当前真实 renderer/facade 生成的合成样例。
- `generated/qq-llm-view-audit/2026-10-08/proposed-samples.json` / `metrics.json`：提案样例及计量。
- `generated/qq-llm-view-audit/2026-10-08/schema-experiment.json`：仅临时结构实验，不是已实施合同。
