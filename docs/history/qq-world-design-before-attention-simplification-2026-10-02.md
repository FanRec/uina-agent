# QQ 世界设计提案

日期：2026-10-02。版本：审查修订版。状态：设计，未实现，未做真实 QQ/TTS 验收。

本文是本次 QQ/TTS 的现行设计提案，仍不替代 Subject Runtime 的施工规格。它将此前主设计、媒体能力和 TTS 补充整合为一个方案；审查前文本仅作历史留档，不应继续照其句柄/ack 合同实施。

## 结论与六项独立审查

QQ 是同一个 Uina Subject 持续拥有的外部世界。世界保存被实际观察到的事实，模型通过动作主动查询，并在值得注意的变化出现时获得最小外部观察。最终 assistant 文本不自动发送；每次 QQ 发言是带明确目标的外部动作。

复用现有 World/Extension、Mailbox、事件帧、工具结果和主体 profile。QQ 不进入 Core，不新增每联系人一个 Agent、不模拟 QQ GUI 的当前窗口、不建设通用社交/资产平台。

对外部审查的六项建议，结论如下：

| 建议 | 独立判断 | 实施约束 |
| --- | --- | --- |
| 删除持久当前查看会话 | 接受。它不提供不可替代的事实，也不能合法作为发送缺省值 | read/inspect/send 均显式提供会话或具体引用 |
| P0 删除 acknowledge/viewToken | 接受。理解无法由模型手动确认得到证明 | 世界区分 observed、实际提交到可恢复观察中的 presented、独立平台已读；无 acknowledged |
| push delta + pull detail，平时不投影 | 接受。正常状态每轮 dashboard 造成冗余 | 工具告诉模型能力存在；正常内容只在 attention delta、read/inspect 结果出现 |
| single-flight dirty wake | 接受机制；不同意仅靠一个布尔值和最新 seq 就足以证明交付 | 一个 outstanding wake；另保存它的 ID/实际覆盖范围。只在 Session 提交后确认覆盖，恢复从权威队列和 Session 对账 |
| will_dispatch 的 durable 屏障 | 接受，且应写成代码合同 | 完整追加并成功 sync 后才执行 ws.send；写入/同步失败禁止发送 |
| 用 render_file 替代音频句柄 | 接受。上一版句柄状态与长期临时所有权没有实际需求 | 一次调用产生消费者目标文件；成功发布后立即属于消费者，无 TTS 资产租约 |

必须保留：显式目标、外部副作用 unknown、restart 不自动重发、rewind 不回滚现实、QQ 不进入 Core。

## 源码事实与证据边界

本次检查的本地事实：

- `src/extensions/world-framework/types.ts` 提供动作、onStart/onStop、emitEvent 与 worldDataDir；动作可返回 ToolExecutionResult/images。`world-activation.ts` 将 queued/urgent 事件转成 followUp/steer。
- `world-loader.ts` 支持接收 ExtensionAPI 的世界工厂。QQ 可取得主体绑定、事件订阅、Session 读取与纯投影 hook，Core 不必认识 QQ。
- profile 模式世界目录为 `<subject.stateRoot>/world-data/qq`；主体身份与资源根由 Host 绑定，不能从模型参数/cwd 猜测。
- `agent/loop.ts` 的 accept 空闲时会启动回合；followUp 不是永不唤醒。emitEvent/submitInput 的 Promise 在空闲路径可能直到整个回合结束才返回，不能拿它当统一消费确认。
- deferred render 在 appendInput 之前运行；render 成功、queue 移除、input_accepted，都不足以证明最新观察文本已进入可恢复 canonical 输入。runTurn 在消费提交后发 turn_start/inputRefs；可以据此再读 Session 核对输入。细节见下文。
- deferred render 只返回文本，闭包不持久化；不能假设排队时的 data 已自动变成消费时的最新 metadata。快照范围必须写入实际提交的文本，或与已提交文本可靠关联。
- 当前 ExtensionAPI 可订阅 queue、读取历史/Session，但没有初始化时的只读 Mailbox 快照。Subject.queuedSnapshot 和 Host.snapshot 已有权威数据；seedQueue 在世界激活之前发生。严格跨重启 single-flight 有一个 Host→Extension 只读接缝缺口，不能靠 world 本地布尔值遮盖。
- `session/jsonl-store.ts` 的 append 逐字节完成写入后调用 handle.sync；失败时 truncate 至先前完整边界并再 sync，回滚失败则阻止后续写。现有 Session 并非只是 appendFile；QQ 新账本仍须自己定义耐久合同。
- 本地 bilibili-live Journal 的 appendFileSync 不能直接继承为“危险 QQ 写动作已获得耐久屏障”。不要按函数名中的 Sync 推断已做 fsync。
- cognition 默认以空 scope 召回主体记忆；同一个主脑不等于联系人之间有内容保密隔离。
- 本地 NapCat 为发行包与旧桥，已检查 `app/napcat/napcat.mjs`，bundle 内版本常量 4.18.14，不证明当前运行版本或最新版本。SHA256 为 `618EE67B151BA369F33D6C69CFA51218409E727843610E30BDC951C5B309825C`。
- bundle 支持 OneBot WS/echo、账号/联系人/历史、图片/文件/语音、戳人和多项社交管理；自消息上报受 reportSelfMessage 控制。接口入口不等于当前账号权限或真实服务端验收。
- NapCat 短消息 ID 的反向寻址依赖有限内存映射。real_id/message_seq 在本地部分构造中同样为短 ID，不能依字段名宣称永久地址。查历史可重新建立映射，但不能保证所有老消息还能操作。
- NapCat 发送实现等待底层成功状态；统一 failed 回执也可能包装执行期间异常。只有可靠证据支持确定失败/成功，其他情况 unknown。
- 当前 TTS 的批量合成、播放文件与清理仍耦合 BridgeTask/播放状态。需要独立 render 端点，复用真正合成原语，不创建假的播放任务。现有公开 voice_driver:speak 面向本机发声。

未读取认证/真实账号配置/真实会话内容；未连接 QQ 或真实 Vendor；本次只修订设计文档。上述代码依据不是生产、断电或服务端保证。

## 所有权、调用方向和不变量

```text
QQ / NapCat 外部事实
        ↕ 事件与 API 回执
QQ World：事实账本、索引、attention、明确动作
        ↕ 最小变化观察 + 按需工具
同一个 Uina Subject：理解、关系判断、行动决定
        ↕
主脑 Session / 现有 cognition
```

| 状态 | 权威所有者 |
| --- | --- |
| QQ 实际账号、好友/群关系、外部消息 | QQ；NapCat/世界保存带来源与时间的观测 |
| subjectId 与 expected self_id 绑定 | 主体的 QQ 配置，启动核验 |
| 实际观察、媒体记录、发送尝试与证据 | QQ 世界单写者账本 |
| 本地会话/联系人索引、attention 筛选 | QQ 世界，从事实与偏好派生 |
| 排队/已提交到主脑的输入 | Subject/Session；QQ 不另写第二套 Mailbox 权威状态 |
| 社交理解与决定 | 同一个 Uina 主脑 |
| 长期关系记忆 | 现有 cognition，引用真实来源 |
| 已生成 QQ 语音文件 | QQ 世界；TTS 仅在单次调用内负责产出 |

不变量：

1. 第一版要求主体 profile，绑定一个 expected QQ self_id。不匹配就阻止账号读写及新账号入账；不能自动改绑。
2. 每次 send 必须明确 conversation；其他动作以具体稳定地址/ref 寻址。显示名不是身份键。
3. 观察、持久排队、已提交观察、已提供给 Provider、理解、平台已读、对方已读不是同一事实；当前只证明合同确实有证据的部分。
4. QQ 保存自身已观察事实，不承诺覆盖从未收到/无法补回的消息。Session 保存主脑实际获得的那部分；后来的撤回以增量表达，不能重写当时输入。
5. 任意外部写动作须满足耐久 dispatch 屏障；可能发出的动作中断/超时按 unknown 核实。
6. restart 不自动重发；rewind 不撤销 QQ 行动、不逆转世界账本与 presented 的现实交付事实。
7. 网络回执分流不等待主脑；账本锁不跨主脑回合；投影不网络读取、不推进游标。
8. World 停用取消本实例监听/重连/服务调用，隔离旧回调，等待结算；不停止由其他所有者管理的 QQ/NapCat。
9. 通过同一账号的其他客户端发言，仅能证明自己的账号发了消息；有可靠关联才归属为 Uina 的某次动作。
10. TTS render_file 不发声、不触发字幕/口型、不影响 voice trace/mute，也不接管产物长期生命周期。

## 认知面：怎么看、什么时候看、看到什么

怎么看：QQ 是可以主动查询与行动的 World；工具说明和稳定账号绑定说明能力与归属，不每轮重播账号 dashboard。

什么时候看：有效事件先保存到世界；attention 规则筛选值得注意的变化，最多一个待提交 QQ wake，通过 followUp 在现有 Subject 的下一可用机会进入。@只代表相关性，不默认打断当前活动。

看到什么：被动观察是可决定要不要进一步查看的最小 delta。需要理解时主动 read/inspect，完整详情从世界按需取出。

P0 认知动作：

| action | 合同 |
| --- | --- |
| status | 主动查询实际账号、连接、已核验能力、历史缺口与未结算动作 |
| inbox | 最近会话和变化目录、尚未提醒的相关变化、可继续查询的 refs；不制造“看完必须处理”的任务债务 |
| contacts | 查询/检索好友、群与成员，返回稳定地址与当时显示名 |
| read | 显式 conversation/ref + 查询范围；有序原文、分页与完整性，不设当前会话、不要求 ack |
| inspect | 展开具体消息引用/转发/图片/文件/语音，明确实际读取范围 |
| send | 明确目标与结构化内容，可引用确切消息；返回执行结论，unknown 时给 operation ref |
| attention | 查询/修改通知偏好；稍后提醒必须是明确意图，基础过滤不隐含定时器 |
| operation | 查一次动作的证据及状态，主要用于 unknown；查询不能隐式重发 |

仍使用单个 qq 世界工具和各 action 的明确 schema。contact/group/voice 等高级动作按真实切片增加，不塞自由文本 manage，也不一次复制全 OneBot API。

删除持久 currentConversation、viewToken、acknowledge、正常状态每轮投影。分页游标只是查询参数，不是强迫模型管理的消费 offset。

平台已读不和 read 的本地工具语义混在一起。P0 不新增自动 mark-read；以后明确开放时作为独立外部动作与结果。presented 只证明一段观察已可靠进入可恢复输入/已提交工具结果，不证明理解、已处理或平台已读。

被动观察例子：

```text
[QQ 外部观察]
小林在群“周末出游”提到了我的账号。
conversation: group:716000003
msg:000184：「@Uina 周六要不要一起？」
可 read 查看上下文；本次仅包含这段提醒。
```

refs 在程序封套中保留 account、conversation、source seq、真实展示/摘要范围和 schema 版本。正文不暴露内部 fsync/dispatch 状态或 token，除非需要解释操作结果。超预算时展示摘要/目录并标注仍有可读详情，不能把略过的内容说成已经读过。

只在断线、账号不匹配、尚未结算的外部动作等可行动异常存在时允许纯投影；没有异常则零注入。投影与异常 delta 共用一份世界状态、稳定异常引用及变更版本，不每轮重复同一事件叙述。unknown 保留到实际核实，重启/rewind 后也不能因为通知发过就假装已解决。若实测异常投影本身仍无必要，再收敛成事件 + status；不恢复正常 dashboard。

QQ 联系人不会因同名/@获得本地操作者身份。所有消息/转发/附件保留外部来源。单主脑和全局记忆仍可能跨会话知晓资料；稳定地址和来源标签不能当成严格保密边界。有强隔离需求时另外制定受众上下文/记忆读取规则。

## Single-flight attention：最小状态与真正提交

世界内部最多一个 outstanding wake，内存只维护 dirty、observed 水位以及这个 wake 的身份和实际快照范围。不新增每会话通知队列/activation/debounce 状态机。

observed 水位是账本序号；dirty 来自尚未纳入提醒且符合 attention 的变化。最新普通群消息、发送结论、配置记录同样可能增加账本 seq，因此不能直接用 latestObservedSeq 的差值当作“所有内容都已展示”。

流程：

1. 网络层先分离 API 回执与事件。事件按序入账/更新索引；相关变化设 dirty。
2. 无 outstanding 才同步占位生成稳定 wakeId，准备一个可恢复 fallback delta；先持久保证其来源范围，再提交一个 followUp。占位必须先于异步 submitInput。
3. 等待消费期间新消息只设 dirty，不再追加第二个 QQ wake。deferred render 在消费时从账本生成当前合适范围的 delta，冻结真实 snapshot 范围/refs。
4. render 不推进 presented、不删除 pending 变化；实际提交文本携带封套引用，不能只更新进程内 captured seq 或排队时旧 data。
5. turn_start/inputRefs 之后查相应 canonical Session 输入，核对实际文本/快照，才记录 presented 的覆盖范围。提交前故障则原 wake 仍 outstanding/待恢复；提交后 Provider 报错不取消 presented，因为事实是进入可恢复输入，不是 Provider 已理解。
6. 为避免模型持续进行 QQ 回合时不断插队，当前 wake 进入活动回合后保留其飞行占位。新变化设 dirty；其回合结算后最多补一个 followUp。不能等待一个刚入队的 submitInput Promise 来识别“已结束”：忙时它只是排队受理。
7. 截断余量作为同一 aggregate 提醒里的未展开详情留给 pull，不因为 omitted 正文永远自触发 wake。否则虽只有一个 queue item，仍会产生无休止回合。新相关变化/明确提醒可形成下一 wake。
8. 主脑取消/失败后服从原有暂停/队列语义，不靠设置 dirty 立即重新启动失败回合。未提交 wake 留待正常恢复；自动断线恢复不得成为无限调用循环。

dirty 清理不能是“最后统一 false”。对冻结范围确认后重新计算尚未纳入提醒的新变化：render/appendInput 之间到来的消息属于下一批；旧普通记录/截断详情不自动成为新 batch。

为了少引入状态，可把一次 delta 的 refs/摘要覆盖范围记录为一个 manifest，而不维护每条消息一个独立 presented 对象。manifest 中要区分“标题/preview 被提醒”与“完整正文被读”；inbox 不把 preview 称为已经看懂详情。主动 read/inspect 已提交结果有 Session 证据时也能为系统提供观察范围，无需模型执行 ack。

范围定义是内部交付事实，不把 seq/manifest 变成模型要手动维护的参数。

## Wake 恢复与现有接缝缺口

两个独立账本之间没有 exactly-once 事务。优先保证不静默丢观察，跨崩溃可以重复投递同一明确 ref；外部发送绝不因此重复。

- Session 已排队但 QQ 占位未落盘：重启必须能读权威 Mailbox，认出已有 wake，不新建第二个。
- Session 已提交，QQ presented 未记录：从 Session 的实际输入与 manifest 对账，再补交付记录。
- render 冻结了最新 delta，但 appendInput 失败：不得确认 presented；原 wake 的恢复 fallback 仍有效。
- 重启恢复的 wake 没有 render 闭包：fallback 必须是真实、可理解的观察和 refs，不能是占位串。它只确认自己的覆盖范围；更晚变化下一次处理。
- Session 回溯抛弃输入：世界的曾经交付事实不回退；实际账号动作/未解决异常仍可查询或投影。

当前 World 可以通过工厂的 ExtensionAPI 订阅 queue、读取 pi.history/Session；但启动时 Subject.seedQueue 已先发生，单靠事件订阅看不到恢复队列。ContextSnapshot 是 token/请求观测，不含 Mailbox。不能在 QQ 里从 auxiliary 重新实现一次 queue_enqueued/queue_restored 的解释器。

因此严格跨重启 single-flight 的最小接缝建议是：Host 装配向 Extension 暴露一个只读 Mailbox 快照，使用现有 Subject.queuedSnapshot 返回安全复制；与已有 queue 事件一起观察。它不接受消费/修改队列，不增加 QQ 概念，不改 Core 状态机，属于 Host/Extension 接缝。名字在实施时按公开 API 风格确定。

当前运行中的提交范围可由 turn_start/inputRefs + Session 对账获得，无需新增 QQ 专属 committed 事件。实施先验证订阅与初始快照不会漏掉激活交界变化；若现有事件的重入顺序不足，补通用原子 snapshot+subscribe 的理由须有失败测试，不能预先制造复杂订阅层。

只承诺同一运行实例内最多一个 outstanding；跨重启的同等保证依赖上述真实只读接线与对账测试。若不做该接线，只能声明重启允许额外重复 wake，不能保留强保证但省略实现。

## JSONL 耐久合同与外部动作

普通 incoming 观察可以批量写/同步，但要承认尚未 sync 的尾部可在进程/系统故障时丢失。新消息一旦被选入可恢复 wake，在交付前必须把其引用事实和 manifest 范围同步完成，避免 Session 指向不存在的世界记录。单写者 commit 屏障会包含此前普通写入，无需每条普通群消息独立 sync。

危险外部写动作统一走：

```text
校验目标/内容
  → 完整追加 intent 与 will_dispatch
  → sync 成功（真实 commit 屏障）
  → ws.send / 对应外部写 API
  → 核对结果
  → 写入并同步结论
  → 返回
```

耐久 commit 的定义：同一串行 writer 完整写入整个 JSONL 记录至已知边界；调用实际 FileHandle.sync 并成功；提交状态与 seq 在屏障完成后发布。appendFile Promise/appendFileSync 完成均不能代替这个定义。

如新建/替换日志，文件内容 sync 不自动证明目录项持久；必须验证目标平台对日志创建/轮换及父目录持久化的实际保证。初期不引入自动日志轮换来回避这个问题。Windows 本机的目标文件系统/设备须验证；不能仅凭 Node API 给出任意硬件断电零丢失承诺。

若追加或 sync 失败，禁止 dispatch。回退最后完整记录边界并同步；回退失败将 writer 置为明确不可写，停止新的外部写动作直到重开/维修，不 catch 后继续发下一条。

恢复：

- JSONL schema/version、记录 seq 与动作转移验证后解释。
- 末尾没有完整换行的一段视为未提交 partial tail；独占打开后截断到最后完整边界并 sync，再追加。
- 完整行出现语法/语义错误或中部损坏，明确报告，不跳过一行继续假定后续有效。
- 仅 intent 的记录不能证明已发送；完整 will_dispatch 且无可证明结论，恢复为 unknown，即使进程可能在实际 send 前就崩溃。
- will_dispatch 以后的多个事实一起掉电丢失时，保持保守结论；不能因为自己没找到终态就推断成功或失败。
- append 模拟短写、sync 失败、尾截断恢复可本地验证；真实断电保证需要另做环境验收。

operation ref 在 dispatch 前生成并绑定账号/会话/内容与时间。WebSocket echo 只关联 RPC，不是 QQ 的幂等键。确定前置拒绝/无副作用的失败为 failed；成功证据为 succeeded；dispatch 后断线/超时/取消/模糊异常为 unknown；已证明执行前取消分别按 not_started/cancelled 表达。

NapCat 通用 failed 不总是“肯定没发”；QQ 写动作必须捕获不确定异常并返回 unknown，避免 World 通用 catch 将其误归 failed。已确认发出但本地结论同步失败，返回外部证据与本地持久化异常，禁止暗示安全重发。

查询自己的近期消息可以辅助核实，文本/时间相似只能给候选，不强行归属；另一客户端可能发出相同文本。重发是新的明确行动，不是连接重试。

## 账号、历史与媒体范围

连接初期由 Uina 使用 OneBot 正向 WS 连接外部管理的本机 NapCat。凭据不进入模型/正文日志；不拉起旧 Pi 桥接程序。

恢复账本和动作 → 连接 → 核验 self_id → 查询实际状态/版本 → 按需联系人/最近会话 → 相关会话分页补历史 → 推送必要的新变化/缺口 delta。

WS 可达不等于 QQ 登录可用；历史列表不等于所有离线事件可靠补投。get_recent_contact 的实际 changedList 不能不经验证称为完整联系人或权威未读。各会话保留 coverage/gap、已核验重叠范围；未补齐保持 incomplete/unknown。

为模型生成永久世界 message ref，存储完整信封及可用协议身份。操作老消息前按会话重建/核验地址，不可寻址明确返回；记得内容不等于还能撤回/引用。短 ID 冲突或身份字段不足不能全局覆盖旧记录。

媒体与基本管理纳入设计目标，但不一口气强行塞进 P0：

| 能力 | 接入与边界 |
| --- | --- |
| 图片收发 | 保存 image 段；inspect 获取真实字节，经现有 images/read_image 回注；send 使用实际资源。生成图片是另一能力 |
| 文件收发 | file/group_upload 与 get_file/上传 API；文本读 UTF-8，PDF/Office 用真实格式能力。明确区分私聊发送、群消息与群文件目录 |
| 戳一戳 | notify/poke 保存 actor/target/conversation；只戳自身才按对应 attention 规则提醒。主动 poke 需要 PacketApi.available，在线不证明可用 |
| 语音接收 | record/get_record、fetch_ptt_text；转写附原语音引用与来源，不声称声学感知。语调/笑声等需真实音频分析 |
| 语音发送 | 已有音频或 tts_audio:render_file 产物 → NapCat 格式处理/上传/发送；合成成功不等于发送成功 |
| 好友管理 | 查询、请求同意/拒绝、备注、删除；不承诺任意 QQ 号主动加友/拉黑等未核实功能 |
| 群管理 | 按实际角色/权限开放成员、申请/邀请、名片、公告、禁言、踢人、管理员、退群等明确动作；结果及变更核实 |

没有读取的图片/语音/文件不能声称已理解。媒体先有描述与 ref，必要时展开；实际 Provider 图片能力未知则保持未知，失败不会伪造内容。转写失败明确可见。

戳人产生的是外部社交事件，情绪/回戳/身体表现由主脑决定，不写死 QQ→Live2D 反射。好友/群变更同样走动作账本，请求 ref 绑定实际申请/邀请身份和范围，不用自由文本管理指令直接触发危险动作。

## TTS：一次 render_file，不保留句柄

新的最小 Extension service：

```ts
"tts_audio:render_file": {
  text: string;
  destination: string;
} => {
  status: "saved";
  mimeType: string;
  byteLength: number;
  durationMs: number;
  sha256: string;
  submittedText: string;
}
```

路径来自受信任消费者明确指定的新目标；现有 ServiceContext.signal 传播取消。不同 World 的 callerId 可能都来自 world-framework，不能据此宣称逐世界路径隔离。本地扩展已默认受信任，本需求不增加权限/租约体系。

所有权：Bridge 只返回音频字节；TTS Extension 在一次调用内将合成可靠发布到目标；发布后的文件属于消费者。没有长期 TTS 临时资产、save/release、引用计数、句柄重载失效、PID 租约或 TTS orphan 扫描。

Bridge 新增独立 render HTTP 端点；复用音色/preset/参考音频、文本处理/语言选择、真实合成原语与既有合成互斥。不要通过假的 BridgeTask 进入播放路径。响应可流式传输，但不承诺 Vendor 实时合成：现有后端可能先批量完成再传出，完整音频的 container/时长校验后才发布。

导出不调用播放器/字幕/口型，不改变 mute/trace/朗读计数。实际 submittedText 反映当前清洗规则，不宣称原文字逐字无变更。

调用过程：

1. QQ 生成独一目标路径，记录媒体准备与来源；其预记录至少在需要崩溃恢复的层级完成提交，再调用服务。
2. TTS 在目标同目录创建属于本次操作的唯一 staging，流写音频；取消/异常关闭句柄并清本次 staging。
3. 完整接收后校验真实容器、大小、实际时长与 sha256，执行所声明的文件 sync。
4. 最后取消检查之后进入发布临界点，以目标平台已验证的原子不覆盖方式发布。普通 rename 的跨平台覆盖语义不能冒充“目标不存在才成功”；例如验证同文件系统 hard-link 发布的支持，或选择对应平台原语。
5. 发布成功后即是消费者文件；返回 metadata。发布后新到的取消不允许再删除 destination。不覆盖已有目标。
6. 若平台需要且支持，对目录项完成所声明的持久化；不能笼统声称原子可见即等于掉电耐久。

取消/返回竞态必须诚实：发布前失败清 staging、无新 destination；发布后返回丢失/取消/目录同步失败，destination 可能已经存在。此时不能返回“肯定没有文件”或反手删除产物。调用者按媒体准备记录和实际文件核实，结果可表达 published_unconfirmed；它是一次文件操作的不确定结果，不创造长期 TTS 状态机。

若发布使用 staging hard-link，发布后仍可能清 staging 别名失败；destination 保持有效，残留/清理异常可见。发布幂等性由目标存在冲突和 QQ 的准备记录核实，不自动重合成覆盖现有文件。

TTS 服务 Promise 在错误/取消路径也必须等自身 I/O 与 staging 清理退出，不可 abort 后提前 reject 却在后台继续写消费者目录。Bridge 计算未必立刻停，但没有本机播放/Bridge 产物文件；计算结束的无消费者响应丢弃。

## 文件崩溃窗口与 QQ 清理

正常成功没有 TTS 临时资产；进程在流写 staging 时崩溃仍会留下 staging，不能宣称“不会有任何 orphan”。它位于 QQ 的媒体准备目录，统一归 QQ 恢复对账，不需要另建 TTS scratch/PID 生命周期。

调用双方约定明确的 staging 命名/操作关联，QQ 只回收自己记录的目录与准备文件，不能猜测任意 .tmp 属于自己。沿用已有主体独占启动边界，确保旧调用已停止后扫描；世界重载时等取消 I/O 退出再对账，不能一边原调用写一边删。删除前核对实际路径在该目录内，拒绝 symlink/junction 越界。

文件已发布、QQ 附件记录尚未提交时崩溃：根据先前媒体准备记录与实际字节验证是否完成，完成则恢复/记录附件；半成品回收。不把已经存在的音频重新合成后声称还是原声音。记录仅是媒体/动作记录，不额外发明资源租约。

| QQ 资产/动作状态 | 规则 |
| --- | --- |
| 本次失败/取消 staging | 正常路径由 TTS 清；崩溃后由 QQ 在无活跃 writer 的边界回收 |
| 已发布、结果返回不明 | QQ 核实文件及准备记录，不盲目覆盖重试 |
| 无有效引用的自有孤儿 | 恢复核实后回收 |
| 上传/发送中 | 保留；禁止删除活跃文件 |
| 发送 unknown | 保留供核实，不按 TTL 清除，不自动重发 |
| 发送确认成功 | 建议作为真实已发送语音附件保留，按明确历史策略清理 |
| 确认失败/放弃且无引用 | 可回收文件，保留动作事实 |
| 明确删除历史附件 | 无在途读取后删除，账本记原音频不可用，发送事实保持 |

文件成长由 QQ 留存策略处理，不借用 TTS 播放任务年龄阈值。初期按单附件和实际消息/操作引用管理，不预建跨资产全局引用计数或去重平台。

## 实施切片与验证

建议顺序：

1. QQ 账本、耐久屏障、账号/连接与只读工具；基础媒体信封保留全部实际类型。
2. attention filter + single-flight，初始权威 Mailbox 快照接线，提交/恢复对账；最小 delta 与按需 read/inspect。
3. 明确发送与 operation unknown 核实；自消息上报、重连补历史与覆盖缺口。
4. 图片/文件/poke 收发与基础请求处理；TTS render_file 独立切片；高级群管理逐动作添加。

本地合同验证：

- 两个同名联系人、多个群同时变化、正文中的外部指令均不改变权威身份/发送地址。
- 忙时千条相关事件仍最多一个 outstanding wake；不能只有 queue 长度小但不断自唤醒。
- render 后提交失败不推进 presented；冻结快照后新消息仍可通知；data 不会误当最新范围。
- 新 wake 在 turn_end 进入时不阻塞当前回合结算；失败/取消不被 dirty 重启绕过。
- restart 的 queue_enqueued/已提交输入/世界交付记录交错崩溃逐点对账；不依赖丢失 render 闭包。
- rewind 保留 QQ 行动事实及未解决异常，世界不重放过去自动发言。
- 短写/sync 失败/追加回退失败禁止 dispatch；partial tail 与完整行损坏分别处理。
- WS 回执乱序、失去成功回执、底层 failed 发生在可能发出后，unknown 不重试。
- 图片真的进入模型请求，附件未展开不伪装已读，文件按真实格式解析。
- render_file 不播放、不改变字幕/口型/mute/trace，使用同一音色并反映清洗文本。
- 取消前/发布前/发布后/返回丢失、目标已存在、目录 sync 失败、staging 清理失败、重载期间写入全部有明确结论。
- 文件发布与 QQ 账本之间崩溃可核实；TTS 清理不会触碰成功目标；自有清理不越界。

实施后运行 pnpm typecheck（含 boundaries）和相关 TS/Python 测试；本次没有修改运行代码，不把既有测试当作实现证明。

真实验收另外验证 QQ 账号/自消息/群权限/poke packet、历史语义/短 ID 重启、语音转换/媒体过期、真实音色与模型图片理解。fsync 调用与故障注入仅证明合同实现，真实断电/文件系统/设备持久性另验证。

预计运行代码变更属于 `.uina/worlds/qq`、TTS Extension/Bridge、必要的 Host→Extension 只读 Mailbox 接线与相关测试。Core 状态机无需变化；若未来还有不足，须用真实失败场景证明，不把 QQ 分支加进去。

## 文档归属与源码索引

本提案位于仓库既定忽略目录，属于本地私人设计文档。审查前文本存于 `docs/history/qq-world-design-before-review-2026-10-02.md`，仅为历史。

本次只重写此提案及保存审查前文本，保留工作树原有与并行修改；没有修改 Host/TTS/Core 或第三方运行代码。

关键源码：

- `src/extensions/world-framework/types.ts`、`world-activation.ts`、`world-loader.ts`、`world-tool.ts`
- `src/extensions/runner.ts`、`services.ts`、`lifecycle-scope.ts`
- `src/agent/loop.ts`：accept、consumeQueueItems、commitQueueItem、runTurn、finishTurn、queuedSnapshot
- `src/host/host.ts`：seedQueue/start 次序、Host.snapshot 和 ExtensionRunner 装配
- `src/session/jsonl-store.ts`：append/sync/rollback
- `src/extensions/event-frames/projection.ts`、`src/extensions/cognition/context.ts`
- `.uina/extensions/tts/bridge/service.py`：批量合成、播放产物清理
- `.uina/extensions/tts/bridge/server.py`、`.uina/extensions/tts/client.ts`、`index.ts`
- `E:/Uina/ThirdParty/NapCat/app/napcat/napcat.mjs`：mQ、消息转换、发送、历史/媒体/poke/管理动作

官方协议与耐久参考（参考不代替本地实现及真实验证）：

- `https://napneko.github.io/onebot/api`
- `https://napneko.github.io/develop/msg`
- `https://napneko.github.io/develop/event`
- `https://nodejs.org/api/fs.html`：write/sync/link/rename 各自语义
- `https://sqlite.org/atomiccommit.html`：文件与目录同步、故障模型和设备假设
