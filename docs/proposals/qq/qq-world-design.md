# Uina × QQ：首版设计

日期：2026-10-07（Asia/Shanghai）
状态：首版设计记录。2026-10-14 复核：本文的目标、所有权与安全边界仍可作为背景；旧九动作和 §4/§7 的通知/消费合同已被 v3 实现取代，当前单一 qq 工具有 14 个领域动作。当前行为与未验证项见[运行文档](../../current-runtime.md#qq-world)和[验收记录](../../qq/qq-world-acceptance.md)。真实 QQ 与真实模型行为仍未验证。

本文件只记录目标、所有权和首版设计理由，不再是当前接口规范。当前参数以实际 schema [tool.json](../../../.uina/worlds/qq/tool.json) 为准；部署授权以 [grant schema fixture](qq-world-deployment-grants.schema.json) 为背景；[交互示例](qq-world-interaction-examples.json) 是历史设计 fixture，不能冒充当前运行记录。旧版[交互合同](../../archive/qq/qq-world-interface.md)已归档。

## 1. 目标与首版取舍

QQ World 是一个主体长期使用的账号环境。Uina 能主动找人、看群成员/会话/自身资料、表达、轻量互动、改变以后如何被打扰、保存明确 QQ 待跟进事项和执行获授管理动作。外部来信只提供事实和认知机会，普通模型文本不自动外发。

首版保留一个 Subject、多个会话现场、消息合并、显式工具行动、持续关注规则、窄范围跟进簿和真实结果。首版不保留条件版本更新、已排队 ordinary 的抢占替换、回复概率训练、精确曝光结算、认知焦点寄存器、通用权限/任务框架或未实现的 grant 名称。

这些删减基于当前需求不足，不是证明它们永远没用。串行写不排除所有旧状态决策，但目前没有要求“仅当旧版本仍成立才修改”的真实场景。删除条件更新后，revision 仅作诊断计数，不能被调用者当作修改前置条件。

QQ 提供自主使用权，不提供主体通用活动来源。有当前活动、通用 rhythm（自主节拍）/其他 World 机会或主体明确预约的跟进提醒时，Uina 可选择使用 QQ；没有活动来源就不会凭空思考。QQ 不新增无消息 heartbeat，也不自动启用默认关闭的 rhythm。

## 2. 所有权与授权

| 事实/状态 | 唯一所有者 |
| --- | --- |
| 实际账号、好友/群关系、消息与权限 | QQ 平台；World 只保存带来源/时间的观察 |
| 主体身份、生命周期、Provider 装配 | Host/profile |
| canonical 输入、模型/工具事实与回溯主线 | Subject/Session |
| 稳定引用、消息/事件、媒体及账号查询缓存 | QQ World |
| 生效 attention 与主体明确写下的 follow_up | QQ World 的控制存储；内容/选择由主体工具动作提供 |
| 此实例的 QQ grant | 部署者的安装配置；World 持有启动时的只读快照 |
| 是否行动、如何表达、事项怎样处理 | Subject；World 不推断情绪、关系或承诺 |
| 展示与输入 | UI；无业务状态权威 |

平台支持、部署允许、当前可用性分别报告。grant 内主体自决，grant 外拒绝，不请求逐次人类审批。QQ 工具与程序入口共享授权/目标校验，不能只有提示词约束。grant 不可通过 qq 自行扩大；部署修改后重新启用 World 才生效。

这是 QQ 接口的执行合同，不是进程沙箱；持有同一凭据的其他受信任代码仍可能绕过它。不得宣称全信任扩展或文件/执行工具已因此被隔离。既有 canonical 信息也不能靠撤销新读取权限从模型历史中抹除。

## 3. 账号与调用链

固定使用 SnowLuma 的 OneBot v11 正向 WebSocket，具体设置、已审查 commit 和源码差异见交互合同。一个 World 绑定一个明确账号；登录身份不符阻止平台写入，旧引用不转移到新账号。认证不交给模型。

```text
QQ事实 → 校验账号/grant → 保存 → attention/批次 → 冻结现场输入 ─┐
                                                             ├→ 同一 Subject → 显式 qq 动作
普通活动 / 通用自主机会 / 已完成工作 ──────────────────────────┘
                                                                    ↓
                                                    校验、平台执行、真实回执
```

主动调用不要求当前活动来自 QQ，也不要求有未通知消息。明确目标与现场足够时可以直接行动，避免例行查询全部状态。入站 scheduler 只管理自动机会，不拥有主体是否发言的决定。

写目标使用含账号边界的稳定 ref；昵称只供查找/展示。用户身份与会话路由分开，temp 保留源群；自身私聊回送不能把 sender 当对方。旧 message/request 地址失效则重新核验或明确不可用，不猜近似目标。Self、群成员与事件查询的覆盖/占位值必须保持真实。

## 4. 最小状态与运行机制

### 4.1 平台事实与通知位置

消息/事件先进入 QQ facts，查询不改变提醒位置、不标平台已读。每个会话保存入站顺序与 notifiedThroughSequence：只表示相应正文或明确省略说明已交给 canonical 输入，不表示模型看见/理解/处理或对方已读。

运行内只保留一个未结算自动输入占位及其冻结主要现场。候选从事实与控制状态派生，不为每条消息建立第二份队列。选择与预留串行；新消息留给下一批，不偷偷扩大已冻结正文。

render 只读。只有 World 停止、主投递资格被静默/暂停撤销、主预约事项取消/改期等情况才返回空并退役。无关 revision/排序变化不能废弃合法主要现场；不再维护“任何版本变化都撤销”的依赖网。当前不允许提醒的背景条目可只读省略，不新增主消息或修改计账。

input_accepted 仅为受理。input_settled(committed) 后记录主场景通知位置，空 render/丢 renderer 不推进。记录失败允许以后重复提醒；不建设 QQ/Session 消费对账。恢复只承诺可以从已保存事实重建，未有实证前不声称无条件至少一次投递。

### 4.2 朴素调度

私聊、真实 @/reply 等允许的 Direct 候选优先；普通群只在 normal 模式合并为普通候选。最长批次等待防止持续聊天永不结束窗口，忙时普通活动留在事实存储。

同类候选按等待年龄排序，preferred 获得一个普通批次等待窗口的有限偏置；平局用稳定 ref。没有轮转状态、概率分数或额外调参控制器，也不把这个排序称为主体兴趣。

ordinary A 已排队，Direct B 后来进入时，首版不撤销/替换 A：等待 A 占位结算，下一合法自动提交优先 B，不再选 ordinary C 插到 B 前。跨会话 Direct 默认 queued；同一进行中交互的直接补充可沿已有 urgent/steer 语义进入下一决策。不能中断已派发动作或启动第二个 Subject。

单占位限制额外 QQ 排队机会数，不保证时间上有界：A 的工具链、其他输入或故障可能很长。只有真实记录显示这个等待不可接受，才比较取消占位、最小退役接缝或更强仲裁；首版没有 supersession 标记、materialize 抢占协议和线性化测试。

turn_end 之后还可能有 afterEnd/续跑；agent_settled 回调内 activeRun 也可能未释放。使用 isBusy 核验，监听回调只通知待检查；在派发之外用单个可取消 recheck 检查，不能在 awaited 回调中等待 Subject 空闲。活动失败/人类中断不自动恢复旧工作。

### 4.3 控制状态

attention 改变以后如何提醒；follow_up 只存明确 QQ 目标、主体 note、证据引用和可选 reviewAt。都由单写方操作执行到此刻的实际状态，持久提交成功后再报告成功；状态关闭/取消检查仍执行。revision 返回诊断计数，无条件比较、冲突码或 ABA 规则。

暂停到期只恢复原规则并给一次允许的积压摘要，不逐条补发。首版只有这一行为，无 backlog 模式参数。reviewAt 只提供一次查看机会；主体明确改期才预约再次查看，不自动发消息、推断承诺或判定完成。

主体历史与控制文件没有跨 store 事务。回溯不撤销平台动作/控制变更；重开后查询 QQ 当前控制状态。普通压缩不能当通用长期记忆，QQ 跟进簿也不扩展成 jobs/memory 系统。

## 5. 动作、上下文与失败

### 5.1 外部结果

每次操作有 operationRef、执行结论和可用时的 messageRef；目标/请求及回执供核验。有序普通日志不作写前事务门槛，echo 关联迟到回执，unknown 不自动重发。日志错误报告为诊断，不把真实平台成功改成失败；查不到记录不证明没发送。没有持久性三态、发送证据等级或自动 replay。

ToolExecutionResult 的五状态保持：succeeded/failed/cancelled/unknown/not_started。平台明确成功不意味着对方阅读；受理未应用、部分成功与结果未知都要说明。新输入、取消和回溯不撤回已派发效果。低层 failed 若可能是请求到达后的超时，不能推成确定未执行。

### 5.2 模型可见上下文

observe 直接把目标现场作为 tool result 回注，无 attend/focusEpoch/requestRegistry。保留当前目标和工具协议原子组，不按 QQ 焦点猜测删掉非 QQ 结果。首版没有强会话信息隔离；来源标记不等于披露安全墙。

紧凑模板与固定主动许可只在交互合同定义。高频内容保留实际目标、当前批次/必要前文、来源/时间、稳定引用与未知/截断；去掉重复说明、正常回显和空段。续场景不固定附长尾部，也不凭“之前通知过”认为模型还记得。缓存不释放上下文窗口，真实总 token/轮数要测。

### 5.3 媒体与生命周期

上传前按允许根 resolve/realpath 验证，防 junction 越界；复制到 QQ 自持 staging，避免播放清理影响上传。QQ 只发送普通资源，TTS 只生成普通文件，不互相 import 或隐式播放。媒体能力未知保持未知，不能把引用当已理解。

World 拥有连接、timer、listener、在途工作与日志/控制写方。启动在绑定、grant、必要本地存储就绪后注册工具，可离线查询本地状态；平台上线不暗中补发。停止立即取消新机会/重连，结算在途工作并清理注册，避免等待 scope.run 与 onStop 相互死锁。

事实可按实际部署 retention 归档/删除，保留覆盖起点；旧引用不可用诚实返回，不伪造内容。open 事项必要证据与未知上传副本优先保留即可，首版不要求通用 pin/归档索引框架。控制状态不随消息尾部淘汰，离线事件完整补齐不作保证。

## 6. 接缝与实现归属

QQ 实现在 `.uina/worlds/qq/`，transport/state/attention/scene/actions/media 是职责划分，不强制一职责一类。Core/Host/UI 不增加 QQ 分支或权威状态。

当前可以组合 World actions、onStart/onStop、worldDataDir、emitEvent/render、input_settled、canonical 工具回注、event-frame、通用 compaction、world_store 与 rhythm。

实施时只审查两个已有机制的 Extension 透传：World 事实订阅增加已有 agent_end/agent_settled；World facade 透传现有 executionMode，让 qq 声明 sequential。调用 context 仅诊断有需求时透传，不作强幂等键。当前模型 call.id 没有跨请求唯一保证。

没有最终 Provider 曝光结算前置要求；没有私用 Host.claimQueued/全局 AsyncLocalStorage 来补 World 接缝。只有可复现的通用运行失败才讨论 Core 改动，不能把“QQ 接入方便”当理由。

## 7. 首轮 gate 与证据状态

**这是待验证清单，不是已验证记录。** 每个 gate 必须记录实际命令/版本、证据位置、结果及边界；不从方案描述、fixture 或历史通过推成当前运行通过。仅接口数据编译检查可以单独标通过，不能抵扣以下行为门。

| gate | 首轮必须覆盖的具体结果 | 验证层级 | 当前状态 |
| --- | --- | --- | --- |
| G1 接口契约 | facade/参数有效，删除字段拒绝，正文状态与实际结果一致 | 声明形状 + 实现组合 | 数据形状另有检查；行为未实现 |
| G2 部署边界 | 已支持但未获授动作拒绝，SDK 写调用 0 次，无逐次审批 | fake client 组合 | 未实现/待验证 |
| G3 目标定位 | 重名不猜人，未发言成员可定位，reply/目标属主错误拒绝 | 发现/动作组合 | 未实现/待验证 |
| G4 本地连续性 | attention 和 follow_up 修改、退出进程、重启读取仍一致；控制写失败不宣称保存 | 实际跨进程临时数据 | 未实现/待验证 |
| G5 消息/队列 | 合并、静默、单占位；A 已排队后 B 下一机会优先，不启动第二主体 | 假时钟 + 真实 Subject 队列 | 未实现/待验证 |
| G6 未知结果 | 写超时 unknown，不重发；同 echo 迟到回执归同操作 | 传输故障组合 | 未实现/待验证 |
| G7 生命周期 | disable/reload/中断不遗留连接、timer、旧 handler 与新平台动作 | 生命周期组合 | 未实现/待验证 |
| G8 资源/组合 | 越界拒绝，自持音频副本，生成/播放/发送生命周期不混淆 | 文件/媒体组合 | 未实现/待验证 |
| G9 真实 QQ | 身份核验、收发消息、对端真实呈现，并验一项已启用管理事务 | 授权测试账号 + 真实 SnowLuma | 未验证 |
| G10 真实模型 | 有通用机会时自主选择合法路径/正确目标；无来源不凭空活动；记录实际 token/轮数 | Host 组合负例 + 指定真实模型语义评估 | 未验证 |

G9/G10 的真实范围、账号/对象与副作用事先明确；缺权限/服务只能记未验证或范围排除，不能记通过。fixture+localhost 不证明真实 QQ；脚本模型不证明实际 LLM 的主动性。全部适用 gate 才能称首轮切片交付；如果只完成离线门，应明确称“离线组合完成”。

2026-10-08 离线门证据：G1=qq-world-contract（ToolDef 等价+validCalls/invalidCalls）；G2=qq-world-actions G2 组；G3=qq-world-actions G3 组；G4=qq-world-persistence；G5=qq-world-scheduler；G6=qq-world-actions G6 组+qq-world-transport-ingest+qq-world-lifecycle 迟到回执；G7=qq-world-lifecycle；G8=qq-world-media+qq-world-media-fetch。运行命令：vitest run --pool=vmThreads（沙箱仅 vmThreads 可用）。边界：fake transport/stub submitInput 组合，不证明真实 QQ 呈现与真实 LLM 主动性；G9/G10 仍待真实账号与模型。

## 8. 按需验证，不预设已完成

以下只在对应实现变更、现场故障或新需求触发时展开，记录独立证据：

- 新适配器/版本、temp/旧消息地址、头像/presence/reaction 映射差异。
- 控制文件损坏、磁盘/断电、日志丢失、retention 淘汰与资源不可用。
- 长期负载、高噪声群、Direct 等待时延、更多控制者/条件更新需求。
- 跨会话隐私、压缩后指代、长消息/媒体、人工自然性评估。

这些不是把故障处理删掉；它们不再构成一张四十行的首轮通过表，也不新增机制来预防未出现的压力。

## 9. 当前事实与施工入口

本次依据 `docs/current-runtime.md` 与 Host/World/Subject/ToolBroker 源码；QQ World 运行代码尚不存在。静态事实包括多输入活动、World followUp 同 origin 批处理、deferred render 空退役、activeRun 最终释放时机、五状态工具合同。它们不证明 QQ 实现已经正确。

SnowLuma 的固定源码快照、网络设置、动作映射只在交互合同维护。Pi 未被用于证明本方案；后续涉及它时检查用户指定 Research 路径的实际源码。

收口判断：保留真实控制权和故障可见性；删除当前没有需求的机制和重复规范。下一步是完成这十个适用 gate 的最小真实切片，不继续扩大纸上认知设计。
