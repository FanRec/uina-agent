# QQ 世界设计提案

日期：2026-10-02。版本：认知、投递与能力组合修订版。状态：设计，未实现，未做真实 QQ/TTS 验收。

本文是本次 QQ/TTS 的现行提案，不替代 Subject Runtime 的施工规格。此前带音频句柄、presented 对账和 Mailbox 新接缝的版本仅为历史，不再照其实施。

## 结论

QQ 是同一个 Uina Subject 持续拥有的外部世界。世界保存实际观察到的事实，Uina 通过工具主动查询，并在值得注意的变化出现时获得最小提醒。最终 assistant 文本不自动发到 QQ；发送是带明确目标的世界动作。

平时不投影 QQ dashboard。认知入口为 push delta + pull detail；没有当前查看会话、viewToken、acknowledge、QQ presented cursor 或每条消息的消费确认。

同一运行实例以一个 wakeInFlight 和 dirty 合并提醒；跨 crash/restart 按 at-least-once 恢复，允许重复同一消息/观察卡引用，不为了消除重复修改 Host/Extension 公共接缝。不对账 Subject 队列或 Session 的精确消费范围。

TTS 和 QQ 分别暴露原生能力，由 Uina 组合：TTS 生成一个普通音频文件，QQ 发送一个已有音频文件。QQ 不调用 TTS，TTS 不知道 QQ。一次 render_file 取代 render/handle/save/release；不新增资产租约或生命周期平台。

危险外部动作使用 will_dispatch 耐久屏障；本地合成、下载、转换与缓存使用普通可恢复文件流程，不统一拖入强 fsync 协议。

必须保留：显式目标、外部副作用 unknown、restart 不自动重复外部动作、rewind 不回滚现实、QQ 不进入 Core、一个 Uina 主脑。

## 方案选择

| 方案 | 问题或取舍 | 决定 |
| --- | --- | --- |
| 消息到来后自动转发最终回复 | 隐含回应义务，混淆本地输出与 QQ 发言 | 不采用 |
| 暴露全部 OneBot 原始接口 | 协议、地址与回执认知成本外溢给模型 | 适配器内部使用，模型看明确领域动作 |
| 每联系人一个 Agent | 多决策者、人格/记忆同步、并发行动 | 第一版仍为一个 Subject |
| 模拟 QQ GUI 当前会话/已读操作 | 没有不可替代的权威事实，增加模型 bookkeeping | 不保存 currentConversation，不设 ack |
| 精确 presented + 跨 store 消费对账 | 为防观察重复增加第二套交付协议 | 删除；Subject/Session 自己拥有输入事实 |
| 新 Mailbox snapshot seam 防重启重复 | 尚未证明体验需要，违反最小充分原则 | P0 删除，实测有问题再讨论 |
| 音频句柄 + save/release | 短暂转移被升级为长期资源生命周期 | 删除，单次 render_file |
| qq.send_voice(text) 内部调用 TTS | QQ 承担文本到声音的职责 | 不采用；send_voice 只接收音频资源 |
| 独立 TTS 生成 + QQ 发送，由 Uina 组合 | 多一个明确能力动作；所有权和事实清楚 | 采用 |

## 已核对事实与证据边界

文档与源码不一致时以当前实现和运行验证为准。工作树存在并行变更，以下描述的是本次读取到的合同，实施时再核对具体位置。

- WorldDef 提供 actions、onStart/onStop；ServiceCompanionContext 提供 emitEvent、worldDataDir；queued/urgent 分别转为 followUp/steer，支持 ToolExecutionResult/images。
- world-loader 支持接收 ExtensionAPI 的工厂。QQ 通过主体绑定、事件、工具、服务和生命周期装配，Core 不必认识 QQ。profile 模式的世界数据目录为 `<subject.stateRoot>/world-data/qq`。
- Subject.accept 在空闲时启动回合；emitEvent/submitInput 的 Promise 在该路径可能等待整个活动结束，忙时则主要表示队列受理。不能以 Promise 完成作为统一的已消费证明。
- input_accepted 表示受理；queue_enqueued 已持久写入，不能将其解读为 Provider 已看到/理解。P0 用这个现有事实记录轻量 handoff，不查 canonical 输入范围。
- Subject 恢复队列拒绝重复 input.id。稳定观察 cardRef/message ref 与一次投递的 inputId 应分开；补投生成新 inputId 携带同一个稳定引用，无需改去重合同。
- turn_start/inputRefs、agent_end/turn.afterEnd 可用于本实例运行调度；它们不需要被解释为每条消息已处理。可见 turn_end 可能只是转场，不等于整个活动结束。
- 现有 Session JSONL append 完成写入后调用 FileHandle.sync；失败时回退完整边界并同步，回退失败停止后续写。QQ 新账本也须明确危险动作的耐久边界；不能因为 appendFileSync 名字中有 Sync 就推断 fsync。
- cognition 默认以空 scope 召回主体记忆，单主脑不保证联系人之间的内容保密隔离。
- 本地 NapCat 是发行包及旧桥接脚本。已检查 `app/napcat/napcat.mjs`，bundle 内版本为 4.18.14，不证明当前运行进程或最新版本。SHA256：`618EE67B151BA369F33D6C69CFA51218409E727843610E30BDC951C5B309825C`。
- bundle 提供 OneBot WS/echo、账号/联系人/历史、媒体、poke 和多项好友/群管理；接口存在不证明实际账号权限。自己账号消息上报需核实 reportSelfMessage 配置。
- NapCat 短消息 ID 的反向寻址依赖有限内存映射；部分 real_id/message_seq 也是短 ID。查历史可重建映射，但不能保证任意老消息还能引用/撤回。
- NapCat 发送路径等待底层成功状态；统一 failed 回执也可能包装发送期间异常，无副作用不能仅凭 failed 字样推断。
- 现有 TTS 有批量合成原语，但播放产物与 BridgeTask/播放状态和清理耦合。公开 voice_driver:speak 面向本机发声；callService 本身也不是模型能直接使用的工具，独立产出需增加模型工具动作。

未读取认证、真实账号配置或会话内容；未连接 QQ、真实 TTS Vendor。本次只修订文档，未修改运行代码。

## 系统结构、所有权和不变量

```text
QQ / NapCat
    ↕ 事件与 API 回执
QQ World：journal、index、attention、actions
    ↕ 最小 delta / qq 工具
同一个 Uina Subject
    ↕
主脑 Session / 现有 cognition
```

| 状态 | 权威所有者 |
| --- | --- |
| QQ 实际账号、好友/群关系、外部消息 | QQ；NapCat/World 保存带时间、来源的观测 |
| subjectId 与 expected self_id 绑定 | 主体的 QQ 配置，启动核验 |
| 已观察消息、附件、动作尝试与证据 | QQ 世界单写者账本 |
| 会话索引、通知偏好、轻量投递卡 | QQ World |
| Subject 队列、canonical 输入、Provider 请求 | Subject/Session；QQ 不复制 presented |
| 社交理解、注意选择、内容和行动决定 | 同一个 Uina 主脑 |
| 长期关系记忆 | 现有 cognition，引用真实来源 |
| 音频合成后端、音色选择、本机播放 | TTS 各自负责；QQ 不参与 |
| 生成文件及其清理 | 发布后归指定目标的拥有者；TTS 只负责单次写入 |
| QQ 保存的发送附件 | QQ World，不删除外部输入源文件 |

关键不变量：

1. P0 要求 profile，绑定 expected QQ self_id；不匹配就阻止账号读写与新账号资料混入，不从模型参数猜身份或自动改绑。
2. send、send_voice、poke、管理动作使用明确 conversation/actor/ref。名字和当前注意对象不能作为隐式发送目标。
3. 网络观察、入账、输入受理、模型请求、理解、平台已读、对方已读是不同事实；不推断超出证据的结论。
4. 已观察事实不等于 QQ 全部现实。没收到/补不回的消息保持缺口，不宣称永久完整覆盖。
5. QQ 账本保存世界观测；Session 保存实际输入。撤回等变化以新事实表达，不改写主脑当时的输入。
6. 观察恢复可以重复；外部动作不因恢复重复执行。unknown 核实后由主脑明确决定下一行动。
7. rewind 不撤销 QQ 现实、不逆转世界账本；QQ 不扫描 Session 去重建消费游标。
8. 网络回执分流不等待主脑；writer 锁不跨 emitEvent/主脑活动；纯投影不发网络、不修改通知状态。
9. World 停用隔离旧回调，取消监听/重连/在途 I/O 并等待结算；不停止由其他所有者管理的 QQ/NapCat。
10. 他端通过同一账号发送仅证明自己的账号发言；可靠关联到本次动作才归为 Uina 的该次发送。
11. TTS 不认识 QQ，QQ 不 import TTS 或查询其 preset、speaker、referenceAudio、mute、generation、BridgeTask。
12. 文件发布后的取消不授权 TTS 删除目标；QQ 成功接收媒体后也不授权删除其外部源文件。

## 认知接口

怎么看：QQ 是可以主动查询与行动的 World。稳定能力说明、真实绑定身份和工具告诉 Uina 它存在，不每轮重播正常 QQ 状态。

什么时候看：有效事件存入世界，attentionFilter 筛选值得提醒的变化，通过一个合并 wake 在 Subject 的下一可用机会输入。@表示相关性，默认 followUp，不自动打断。

看到什么：被动时看到足够决定是否进一步查看的最小 attention delta；主动 read/inspect 后获得真实详情及附件。正常内容不长期占据模型 prompt。

| P0 action | 合同 |
| --- | --- |
| status | 主动查账号、连接、能力、历史缺口、未结算动作 |
| inbox | 最近会话、相关变化、可读详情 refs；不制造“每条必须处理”的任务债务 |
| contacts | 查好友/群/成员，返回稳定地址及当时显示名 |
| read | 明确 conversation/ref 与范围，有序原文、分页、完整性 |
| inspect | 展开引用/转发/图片/文件/语音，说明实际读取范围 |
| send | 明确目标与结构化内容，返回证据，unknown 附 operation ref |
| attention | 查/改通知偏好；明确稍后提醒另作意图，不暗中替模型设置待办 |
| operation | 查一次动作的状态/证据，不隐式重发；正常情况下无需频繁使用 |

媒体和管理按真实切片增加 send_voice/send_file/poke 及具体动作；不放一个自由文本 manage 万能指令。继续一个 qq 工具 + 各 action 的明确 schema。

删除 currentConversation、viewToken、acknowledge、每轮正常 dashboard。分页是查询，不是模型要维护的消费 offset。

read/inspect 为纯查询，不清 dirty、不标通知已消费、不影响 wake。它们可查询远端或更新详情缓存，但不能因此把历史回填当新实时提醒，或隐式改变 attention。主动读过后再次收到同一消息的通知是允许的。

P0 不自动调用平台已读 API；若以后开放则是独立外部动作。Subject 是否把工具结果送入模型不由 QQ 复制 presented 记录。

被动卡片例子：

```text
[QQ 外部观察]
小林在群“周末出游”提到了我的账号。
conversation: group:716000003
msg:000184：「@Uina 周六要不要一起？」
可 read 查看上下文；本次只有这段提醒。
```

manifest 仅记录卡片的稳定 cardRef、正文/preview、来源 refs 和版本，不证明 canonical 精确消费。卡片必须包含可恢复正文与必要来源，不只是另一 store 中可能尚未落盘的空引用。截断标记和可读详情清楚，不说未展开内容已经理解。

只在可行动异常存在时允许纯投影：断线、账号不匹配、unknown 动作等。正常时零注入；异常投影和变化通知共享同一份状态与稳定引用，不重复讲述同一事件。若实测异常投影也无必要，可继续收敛成事件 + status。

联系人消息/附件/转发保留外部来源，不因同名或 @取得宿主管理权。来源与稳定地址降低错发，不证明全局主脑/记忆的内容隔离；有强保密需求另定受众/记忆规则。

## Attention：single-flight + at-least-once

当前实例只维护 dirty、一个 wakeInFlight，以及从世界账本派生的未纳入观察卡的相关变化。不建每会话通知队列、per-message presented 状态或精确交付 cursor。

1. WS 分开处理 API 回执和事件；观察入普通 journal/index，经筛选标 dirty。
2. 无 wakeInFlight 时同步占位、冻结一张观察卡，再 emit followUp。清除本批 dirty；此后新相关事件再次设 dirty，不追加第二张 wake。
3. 排队/活动期间新消息合并等待。P0 不使用 deferred render 更新最新卡片：稳定正文直接进入可恢复输入，新变化下一张处理。
4. 以现有 input_accepted 记录轻量 handoff：只说明 Subject 已受理 cardRef/inputId，不读 Session/队列，不宣称模型看到。卡片创建与 handoff 均可普通批量写入，没有跨 store 事务。
5. 本实例用 turn_start/inputRefs 关联 followUp 所在活动；用 agent_end/turn.afterEnd 结算占位，不把一次可见 turn_end 转场误当整个活动结束。事件/钩子里不等待一个主脑回合，也不锁住 journal 后再投递。
6. 活动正常结算释放占位，dirty 才安排下一张。卡片略去的细节留给 pull，不因尚未展开自动再次唤醒。
7. 受理失败、活动开始前失败或取消保持可重试卡、报告原因，服从 Subject 既有暂停/恢复语义；不立即循环重试，不让 dirty 绕过操作者取消。

运行内“最多一个”只针对本次 activation 新建的 wake；崩溃前留在恢复队列的旧提醒和重启补投可同时出现，不承诺全局去重。

跨崩溃：

- 卡已记录但尚未受理：补投原卡。
- Subject 已受理，但 QQ handoff 没留下：也补投，重复允许。
- handoff 已留下：输入恢复由 Subject 负责，无需 QQ 证明 canonical 消费/Provider 理解。
- 两者都未完整留下：从已提交相关事件重新建卡；没有提交的网络尾部不冒称有耐久保证，重连按真实历史能力补查并标缺口。

稳定 cardRef/message ref 不变；每次补投生成新的 inputId。当前 Subject 拒绝重复 queue id，不能把“相同消息提醒可以重复”误实现为“直接复用一个已恢复输入 ID”。

handoff 是最小的投递受理记账，用来避免每次重启无限重播全部历史，不能升级为理解、已处理或精确 presented。若中间状态不确定，保守重投同一引用，绝不恢复执行旧 send。

at-least-once 对已提交/可恢复观察成立，不表示所有网络字节零丢失，也不保证被取消的模型任务终于理解。Subject 明确取消后的输入处理属于其自身合同，QQ 不补投去推翻该决定。

P0 不加 Mailbox snapshot、snapshot+subscribe 原子接缝、不解释 auxiliary 队列日志、不查 Session 工具结果清通知。实测重复体验确有问题再评估现有机制和通用接缝。

## 耐久性：危险外部动作与普通本地工作分开

普通 incoming、观察卡、handoff、媒体准备可批量写/同步。未提交的尾部可以在故障时丢失；恢复如实使用已提交记录、实际文件和历史查询，不虚构保证。

强屏障只用于不能由恢复自动重复的外部写：send、poke、好友/群管理等。

```text
校验明确目标/内容
    → 完整追加 intent + will_dispatch
    → FileHandle.sync 成功
    → ws.send / 外部写 API
    → 核对结果
    → 追加并同步结论
    → 返回证据
```

commit 定义为串行 writer 完整写入记录并成功调用实际 sync，屏障后才发布相应提交状态。appendFile Promise/appendFileSync 不能代替此合同。

追加/sync 失败禁止 dispatch；回退最后完整边界并同步。回退失败则 writer 明确不可写，停止新外部动作，不能 catch 后继续发。

恢复规则：schema/version、序号与状态转移核验；末尾未完整换行 partial tail 独占打开后截断并同步；完整行损坏/中部错误明确失败，不跳过后继续猜测。

完整 will_dispatch 无确定结论，按 unknown 恢复；仅 intent 不证明发出。即使实际可能在 send 前崩溃也不自动重发。新建/替换日志的文件/目录耐久需按目标平台核验，初期不自动轮换日志增加恢复问题。调用 sync 不等于对任意设备断电给出零丢失保证。

| 证据 | 工具结果 |
| --- | --- |
| 调度前取消 | not_started |
| 启动后证明 dispatch 前取消 | cancelled |
| 确定拒绝且无副作用 | failed |
| 可靠发送确认 | succeeded，不证明对方已读 |
| dispatch 后断线/超时/取消/模糊失败 | unknown |

NapCat failed 可能包装执行期间异常，QQ 写动作主动返回 unknown，不能落入通用 World catch 的确定 failed。已确认发出但本地同步失败，返回外部证据与持久化问题，不能否认发送。

operation ref 绑定账号/会话/内容；echo 只是 RPC 关联，不是平台幂等键。文本/时间相似仅提供候选自消息，另一客户端可能发相同内容。新发送是主脑明确的新行动。

本地 TTS render、附件下载、转换、缩略图/ASR缓存均不是 will_dispatch 协议对象。P0 不要求它们开始前 fsync journal，也不强制每个媒体文件/目录 sync。普通文件校验、原子发布与崩溃对账足够；有明确断电耐久需求再独立增加对应保证。

## 账号、历史与媒体

初期通过正向 WS 连接外部管理的本机 NapCat；凭据不进入模型或正文日志，不启动旧 Pi/自动回复桥。

恢复账本/动作 → 连接 → self_id 核验 → 状态/版本查询 → 必要联系人/最近会话 → 相关历史补查 → 必要新变化/缺口提醒。WS 在线不等于 QQ 登录可用。

get_recent_contact 的 changedList 不自动等于完整联系人/权威未读；事件流不是持久补投服务。会话保存 coverage/gap 和实际查询范围，无法证实补齐就保持 incomplete/unknown。

永久 message ref 属于世界；存完整信封及可用协议身份，操作老消息前按会话重建/核验地址，失败明确不可寻址。记得内容不等于还能撤回/引用。短 ID 冲突不全局覆盖旧记录。

| 能力 | 设计与限制 |
| --- | --- |
| 图片收发 | 保留 image 段，inspect 实际字节并经现有 images/read_image 回注；send 使用现有资源。图片生成另属能力 |
| 文件收发 | file/group_upload 与文件 API；文本读 UTF-8，PDF/Office 用真实格式能力。私聊发送与群文件目录动作明确 |
| poke 收发 | actor/target/conversation 保留，只戳自身按对应偏好提醒；主动戳人依赖实际 PacketApi 能力 |
| 语音接收 | record/get_record、fetch_ptt_text；转写附原语音 ref，不伪称语调/笑声等声学感知 |
| 语音发送 | send_voice 接收已有音频文件，NapCat 转换/上传/发送；音频来源不限 TTS |
| 好友管理 | 查询、请求处理、备注、删除；不承诺主动加任意号/拉黑等未核实功能 |
| 群管理 | 按角色/权限执行成员、邀请/申请、名片、公告、禁言、踢人、管理员、退群等明确动作 |

未展开附件不说已经理解；媒体 URL 过期/未下载原件不说永久可用。未知 Provider 能力保持未知，实际识图/转写另验收。

poke 是外部社交事件；开心/惊讶/回戳/身体动作由主脑决定，不固定 QQ→Live2D 情绪反射。社交请求绑定真实 request ref，管理动作明确对象、事实与证据；不凭外部文本直接越过主体判断。

## TTS 与 QQ：由 Uina 组合，模块彼此独立

```text
Uina
  ├─ tts 工具：render_file(text, destination)
  │                  ↓ saved / published_unconfirmed
  │             普通音频文件
  └─ qq 工具：send_voice(conversation, audioResource)
                     ↓
               QQ 发送结论
```

QQ World 不主动调用 tts_audio:render_file，不 import TTS 代码，不检查 TTS 是否加载/静音，不选音色/参考音频。TTS 不 import QQ，不接触账号、会话、NapCat 或发送状态。QQ 的 send_voice 在 TTS 未加载时仍能发送其他来源的现有音频。

“用自己的声音发句话”是主脑选择的复合行为，不是 QQ 暗中承担的文本到声音流水线。切换 GPT-SoVITS/其他生成器由相应能力负责，QQ 合同保持不变。

服务继续放在 TTS Extension，供需要程序组合的受信任扩展使用；但 callService 不自动成为模型能力，因此必须同时提供模型可调用的生产动作。优先在已有 tts 工具增加 action=render_file，复用同一个操作实现；voice.speak 继续表示本机发声，不借它取文件，不加一层仅转发调用的扩展。

建议服务与模型动作共用参数 text、destination 与下述 RenderFileResult。目标是明确的新文件路径；相对路径由当前工作区解析，结果返回绝对路径以供直接组合。模型工具结果正文需含文件地址和关键元数据，不能只放在模型看不到的 details。

```ts
type RenderFileResult =
  | {
      status: "saved";
      destination: string;
      mimeType: string;
      byteLength: number;
      durationMs: number;
      sha256: string;
      submittedText: string;
    }
  | {
      status: "published_unconfirmed";
      destination: string;
      reason: string;
    };

// Extension service（建议名称，尚未实现）
"tts_audio:render_file": {
  text: string;
  destination: string;
} => RenderFileResult

// 同一操作的模型入口
{ action: "render_file", text: string, destination: string }
```

saved 只证明完整目标在返回时可用；published_unconfirmed 表示可能已发布但本次成功结论未完整结算。工具层 saved 映射 succeeded；published_unconfirmed 映射 unknown，并明确只涉及本地文件，不是 QQ 已发送。其他前置拒绝/发布前取消按真实证据 failed/cancelled/not_started，不伪造这两个结果。

QQ 基本语音动作：

```ts
{
  action: "send_voice",
  params: {
    conversation: string;
    audioResource: { kind: "file"; path: string };
  }
}
```

QQ 接收音频源，不接收 text、voiceId、preset、speaker。无需通用 AudioResource 注册表/句柄体系；P0 先用普通文件资源。

例子（工具名/参数为设计示意）：

```text
tts.render_file(text="我晚点告诉你～", destination="exports/voice/greeting.wav")
  → saved，destination=<实际绝对路径>

qq.send_voice(conversation="private:859000002", audioResource={kind:"file", path:<上面的路径>})
  → succeeded / failed / unknown
```

published_unconfirmed 或调用返回丢失时，先核实目标文件再决定下一步，不能把“可能生成成功”当作可直接发送。发声、合成、发送是各自不同事实。

这比 QQ 直接可选调用 TTS 更适合当前需求，但不是禁止所有扩展间服务调用的教条。将来真实业务若需要一个自动复合服务，再用具体需求证明其所属策略层；不提前塞进 QQ 或 Core。

## render_file：一次本地文件产出

Bridge 新增独立 render HTTP 端点，仅产生音频响应。复用实际 preset/参考音频、清洗/语言选择、合成原语与已有互斥，不创建假 BridgeTask、不改变播放计数/trace/mute、不触发声卡/字幕/口型。

可流式传输响应，但不承诺 Vendor 实时合成；后端可批量完成后传出。实际 submittedText 反映清洗，不说原字逐字无变。

TTS Extension 的单次流程：

1. 解析明确 destination，在其同目录创建本次独有 staging；目标已存在则拒绝覆盖。
2. 接收并写音频；取消/异常关闭 I/O 后清自己的 staging，服务 Promise 不在后台 writer 仍运行时提前结算。
3. 完整校验真实容器、字节、时长和 hash，最后取消检查，再用目标平台已验证的原子不覆盖方式发布。普通 exists + rename 不能冒充跨平台原子不覆盖。
4. 发布后目标归该目录的拥有者，返回 saved 与绝对 destination。随后取消不授权删目标。
5. 发布后发生可观察的结算错误且仍能返回，返回 published_unconfirmed；若整个返回丢失，调用异常也应核实 destination，不能保证结果还能送达。

前置失败/发布前取消清 staging；进程崩溃仍可能留下 staging，不能宣称完全无 orphan。staging 名称可识别，清理由指定输出目录的拥有者在无活跃 writer 边界完成。它是普通临时写入，不是长期 TTS 资产，没有 handle/retain/save/release/PID 租约。

默认 saved 是完整文件的原子可见，不是断电耐久保证，不要求 render 前日志 sync。若采用 hard-link 发布需验证文件系统支持；发布后 staging 别名清理失败应报告，不删除有效目标。

导出到 workspace 的文件归 workspace，不因后来发送而自动归 QQ。它是普通生成作品，保留到 Uina/操作者明确清理；TTS 不设隐藏 TTL、不回收成功作品。模型可用已有文件能力明确删除不再需要的文件，不引入隐式临时句柄。

本地扩展受信任，指定本地目标路径符合当前边界；不虚构 callerId 权限体系。真正的受众/文件权限需求另外定义。

## QQ 接收音频与清理

send_voice 对外部 audioResource 只读：校验实际存在/格式，不删除、不改写源。为避免源被后续修改、清理或出现在非共享路径，QQ 在 dispatch 前普通复制/快照到自己的附件目录，校验复制字节；所有实际上传从该副本进行。

这一次复制是“任意来源音频 → QQ 所有的发送附件”的真实所有权边界。它没有 TTS 长期临时资产、句柄/save/release；也不要求 Uina 知道 QQ 内部目录、引用计数或等待平台读取完成。

拷贝/准备失败不启动 QQ 外部发送。外部动作的 will_dispatch 同步屏障仍保留；媒体准备本身无强制预 fsync。源文件被并发修改时不能靠文件名/mtime认定一致，需检查实际复制和解码结果，疑似不稳定则明确拒绝，不用 TTS 状态猜测。

音频文件落盘和 QQ 附件记录之间有普通崩溃窗口。恢复扫描自有媒体目录及命名，结合现存引用与实际文件：能证明已绑定则恢复，来源不明的自有未引用文件可回收，不编造合成文本。无活跃 writer 的边界沿用主体独占启动/世界关闭等待，删除时不沿 symlink/junction 越界。

| 文件/动作状态 | 清理责任 |
| --- | --- |
| TTS 发布前失败/取消 staging | TTS 单次操作清；进程崩溃后由输出目录拥有者扫描自有残片 |
| workspace 成功生成文件 | workspace 作品，明确清理，不因 QQ 发送自动删 |
| QQ 拷贝半成品 | QQ 结算/恢复清，不触碰外部源 |
| 已发布但元数据/操作返回不明 | 目标拥有者核实文件，不覆盖重试 |
| QQ 自有无引用孤儿 | 恢复确认无活跃读写后回收 |
| 上传/发送中 | QQ 保留，禁止删活跃附件 |
| 发送 unknown | QQ 保留用于核实，不按分钟 TTL 清，不自动重发 |
| 确认发送成功 | 建议保留原音频作为真实历史附件，按明确留存策略清 |
| 确认失败/放弃且无引用 | 可回收 QQ 副本，保留动作事实 |
| 明确删除历史附件 | 无在途读取后删除，记原音频不可用，发送事实不改 |

默认媒体原子可见不保证断电后还在：附件丢失时如实报告不可用，不能按缓存重建策略自动重发消息或把新合成冒称原语音。没有必要为所有媒体准备强制一次 fsync；若确需长期存档耐久，针对该明确需求另验收文件持久化。

已确认发出的语音保留实际音频，比日后重新合成同文更符合“自己的 QQ”。QQ 历史增长是留存策略，不借 TTS 播放任务年龄阈值清理，不提前建全局资产去重/引用计数平台。

## NapCat 功能覆盖差距（2026-10-02 核对）

本节对照本地 4.18.14 bundle 的动作实现、消息转换与 notice 构造器，以及官方 API/消息/事件列表。它是能力清单，不把未纳入项自动变成 P0 需求，也不表示接口已通过真实账号验收。当前提案涵盖只代表设计范围，全部 QQ 新功能仍待实现。

### 尚未明确纳入的用户能力

| 功能组 | 本地入口例子 | 当前提案缺口 |
| --- | --- | --- |
| 个人资料与在线表达 | set_qq_profile、set_qq_avatar、set_self_longnick、set_online_status、set_diy_online_status | 账号核验已有；自主修改昵称/头像/签名/在线状态未定义 |
| QQ 表情与表情包 | face/mface converter、fetch_custom_face/detail、add/del_custom_face、set_custom_face_desc、dice/rps | 图片存在不等于 QQ 表情语义；表情选择、表情收藏/整理、骰子/猜拳未明确 |
| 消息表情回应 | set_msg_emoji_like、get_emoji_likes、fetch_emoji_like，group_msg_emoji_like notice | 与资料赞不同；回应和增删变化感知未定义 |
| 资料点赞 | send_like、get_profile_like、notify.profile_like | 点赞别人和收到点赞未纳入明确动作/attention |
| 主动撤回 | delete_msg、friend_recall/group_recall | 设计讲了撤回事实/不可寻址边界，但没有明确撤回动作 |
| 主动转发 | forward_friend/group_single_msg、send_group/private_forward_msg、send_forward_msg | inspect 读合并转发已有；发送单条/合并转发未定义，保留原作者/来源语义 |
| 视频 | video converter、视频资源下载/上传处理 | 文件附件通用流程不等于视频消息与模型视频理解；收发/预览/抽帧未定义 |
| 音乐/联系人/小程序卡片 | music/contact/json converter、send_ark_share、send_group_ark_share、get_mini_app_ark | 普通文字链接不等于平台卡片；对应明确分享动作未定义 |
| 交互卡片/按钮 | click_inline_keyboard_button、JSON/Markdown 特殊消息 | 卡片展示、按钮目标解析/点击未定义；不以任意 raw JSON 绕过明确动作 |
| QQ 收藏 | create_collection、get_collection_list | 创建和浏览个人收藏未纳入；收藏不是 cognition 的长期记忆 |
| 群文件整理 | 根/子目录列表、建删目录、delete/move/trans/rename_group_file | 上传/下载已提；完整目录查询与整理仍没有动作合同 |
| 群相册 | get_qun_album_list、get_group_album_media_list、upload_image_to_qun_album、评论/点赞/取消点赞/删除 | 整组未纳入 |
| 群待办 | set/complete/cancel_group_todo | 标记现有消息为待办、完成/取消未纳入；不替代主脑 reminder |
| 群签到 | set/send_group_sign、get_group_signed_list | 签到与查询记录未纳入 |
| 群精华/荣誉 | get/set/delete_essence_msg、get_group_honor_info | 一般群管理不自动包含精华设置/取消、查询与荣誉 |
| QQ 空间 | send_qzone_msg、delete_qzone_msg | 本地支持图文说说发布/受众权限及删除；未纳入，不据此承诺浏览所有好友动态/评论/点赞 |
| 在线文件/文件夹传输 | send_online_file/folder、get_online_file_msg、receive/refuse/cancel_online_file | 普通离线文件收发不能覆盖其接受/拒绝/取消及状态通知 |
| 闪传/文件集 | create_flash_task、send_flash_msg、get_flash_file_list/url、get_share_link、get_fileset_info/id、download_fileset | 与普通文件不同的分享/文件集流程，尚未纳入；不要与闪照混淆 |
| QQ 自带 AI 音色 | get_ai_characters、get_ai_record、send_group_ai_record | 尚未纳入；默认仍由独立 TTS 提供 Uina 音色，不自动替换 |
| 私聊输入状态 | set_input_status、notify.input_status | 显示自己输入/观察对方输入未定义；不靠假输入状态模拟人 |

### 类别已涉及，但还没有具体合同

- 好友：单向好友查询、可疑好友申请列表/处理、分类资料、陌生人/用户状态查询。好友列表/申请/备注/删除的基础范围不能代表全部。
- 群配置：群头像/群备注/群名、全员禁言/禁言列表、专属头衔、入群审核/搜索/机器人加入选项、成员邀请策略、成员相册与临时会话权限、新成员历史可见性、忽略申请/系统通知。基础踢人/禁言/管理员不代表这些高级配置已有 schema。
- 事件感知：群名/名片/头衔、精华变动、资料赞、输入状态、表情回应、在线文件状态、gray_tip 等具体 normalization/attention 仍须定义。保留 raw notice 信封不等于主脑已能正确理解所有事件。
- @全体、平台已读：NapCat 有入口；本提案 P0 没有明确加入。平台已读是有意不与 read/attention 耦合，不能为补全列表重引入 ack。
- 查询辅助：NapCat OCR、翻译、URL 安全查询等可作为实际能力组合，但不是 QQ 世界必须重复实现的认知机制。

### 不宜作为 Uina 日常工具整体暴露

Cookies/CSRF/credentials/clientkey/Rkey、原始 send_packet、流式上传/下载协议、测试接口、cache 清理、bot_exit/restart、模型展示等主要属于认证、传输或运维。其中用户可感知的功能如需管理，应另用明确运维动作；不要将全部原始 API 放入 qq 工具。流式传输可改进大文件适配器，不必成为 LLM 的新动作。

### 不能只凭入口名称判定可用

本地 get_guild_list/get_guild_service_profile 的 _handle 为空；location 发送 converter 是硬编码测试内容；xml/miniapp converter 也有空实现，而独立 get_mini_app_ark 另有实际路径。因此不能宣称完整 QQ 频道、任意位置发送、任意 XML/小程序消息都已支持。

官方事件兼容表注明某些表情回应上报存在范围限制，具体是否需要主动查询及本地 packet 能力要验收；不能按事件名称承诺全量捕获。

### 建议优先补齐

先补个人资料/状态、QQ 表情/表情包、消息回应、主动撤回与转发。它们直接支持稳定身份、自然表达与行动纠正，而且可复用现有动作/消息接缝。视频/音乐分享与文件目录可随后添加；QQ 空间、群相册、群待办、在线文件/闪传在明确使用需求出现时分切片，不为 API 完整率膨胀 P0。

新增能力继续遵守同一规则：观察只推 delta，详情 pull；外部写结果按证据结算，恢复不重做；具体平台功能属于 QQ，资源生成/理解能力由主脑组合。此清单不增加 Core 接缝、presented 或新的资源平台。

主要本地核对点（bundle 行号）：73268 附近消息 converter；75178 资料赞；76061 在线状态；76550 个人资料；76634 收藏；77082/77139 消息回应；77194 输入状态；77277 起群文件整理；78087/78099 频道空实现；79105 起待办/相册；79819 起闪传/在线文件；80236/80273 QQ 空间；80304 起高级群权限；71427 起群通知。官方列表仅作交叉核对，具体以实际代码和账号验证为准。

## 实施与验收

切片顺序：

1. QQ journal/index、账号连接、只读工具、危险动作 commit 屏障；信封保留真实媒体/notice/request 类型。
2. attentionFilter、单实例 single-flight、普通卡片/handoff、跨重启允许重复；没有 Host 新接缝或 Session 消费对账。
3. 明确 send/operation、自消息核实、历史补查/缺口；图片文件/poke与基础社交请求逐项验收。
4. 独立 TTS render_file 服务及模型动作、QQ 只接受文件的 send_voice；随后群管理/其他媒体按真实需求补齐。

必要本地验证：

- 忙时大量事件最多一个本实例 wake，旧恢复卡重复允许；manifest 不成为 offset/消费协议。
- read/inspect 前后 attention 状态不变；冻结卡后新消息标 dirty；截断余量不无限自唤醒。
- 受理/普通 handoff 丢失导致重复同 ref、使用新 inputId，无公共合同修改；失败/取消不绕过 Subject 暂停。
- 回执乱序、短写/sync失败/回退失败禁止危险 dispatch，partial tail 与中部损坏分别处理。
- 发送成功但回执丢失/failed 包装可能发出，unknown 不恢复重发；rewind不回滚现实。
- 图片确实进模型请求，未展开附件不伪称理解；poke目标/权限/packet不可用可见。
- QQ 未加载 TTS 时发送已有 wav 正常；QQ 代码没有 TTS import、服务名/参数/状态依赖。
- TTS 未加载 QQ 时独立生成；服务和模型工具共用实现，结果正文含实际路径，生成不触发本机发声。
- render_file 取消前/发布前/发布后/回执丢失、已存在目标、staging清理失败匹配 saved/published_unconfirmed及错误边界。
- 媒体预记录未落盘但留下文件仍能普通恢复清理，测试不以强制 render 前 fsync解决。
- send_voice 只读任意源，复制后不依赖源继续存在；失败/取消清本次副本，unknown保留，不删源。
- 世界/TTS 重载等在途 writer退出再扫描，清理不越界；本地缓存丢失不触发外部重发。

实施后运行 pnpm typecheck（含 boundaries）及相关 TS/Python 测试。本次纯文档不运行代码测试、不把既有测试当实现证明。

真实验收：账号/自消息/群权限/poke packet，实际历史与短 ID 重启，媒体过期/语音格式转换上传，真实音色/图像理解/语音转写。sync故障注入证明代码合同，真实断电及目标设备保证另验收。

预计代码修改范围为 `.uina/worlds/qq`、TTS Extension/Bridge 和相关测试；P0 不改 Host/Extension 公共合同或 Core 状态机。缺口若出现须以真实调用/失败场景证明再增强接缝。

## 文档归属与源码索引

此文件位于既定 Git 忽略目录，属于本地私人设计文档。历史版本：

- `docs/history/qq-world-design-before-review-2026-10-02.md`
- `docs/history/qq-world-design-before-attention-simplification-2026-10-02.md`

本次只重写提案和保存历史，未修改运行代码、配置、第三方或真实会话。其他原有/并行工作树修改保持不动。

优先源码：

- `src/extensions/world-framework/types.ts`、`world-activation.ts`、`world-loader.ts`、`world-tool.ts`
- `src/extensions/runner.ts`、`services.ts`、`lifecycle-scope.ts`
- `src/agent/loop.ts`、`src/runtime/events.ts`、`hooks.ts`：受理、followUp、活动结算合同
- `src/session/jsonl-store.ts`、`recovery.ts`：sync、回退、重复队列 ID
- `src/extensions/event-frames/projection.ts`、`src/extensions/cognition/context.ts`
- `.uina/extensions/tts/tool.ts`、`index.ts`、`client.ts`、`bridge/server.py`、`service.py`
- `E:/Uina/ThirdParty/NapCat/app/napcat/napcat.mjs`：消息地址、发送、历史/媒体/poke/管理

官方交叉参考（不替代本地实现）：`https://napneko.github.io/onebot/api`、`https://napneko.github.io/develop/msg`、`https://napneko.github.io/develop/event`；文件持久化参考 `https://nodejs.org/api/fs.html` 与 `https://sqlite.org/atomiccommit.html`。
