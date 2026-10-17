# QQ 世界设计提案

日期：2026-10-02。版本：支持范围确定版。状态：设计，未实现，未做真实 QQ/TTS 验收。

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

基础媒体和管理按真实切片增加 send_voice/send_file/poke 及具体动作；新纳入的身份、表达、视频/分享/群文件范围以“支持范围与暂缓决策”为准，不开放自由文本 manage。继续一个 qq 工具 + 各 action 的明确 schema。

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

## 支持范围与暂缓决策（2026-10-02）

本节替代此前仅列缺口的清单，是当前选定的实施范围。纳入表示需要设计并分切片实现，不表示已经可用；后面的暂缓项不进入当前 backlog、工具 schema 或实现占位。

取舍依据是实际价值：稳定身份与连续生活、自然交流与行动纠正、理解真实消息、既有合作场景。能由现有消息/动作接缝承载则优先支持；仅因 NapCat 存在接口不构成需求。基本机制、认知界面和运行状态不随功能数量增加而扩大。

### 纳入当前设计

既定的文字、@/引用、图片、文件、语音、poke、好友与基础群管理继续保留。增补如下：

| 能力 | 具体支持范围 | 理由与实施位置 |
| --- | --- | --- |
| 个人资料/状态 | 查与改自己的昵称、头像、签名、平台在线/自定义状态 | “自己的账号”有可行动的身份表达；自然表达切片 |
| QQ 表情/表情包 | 普通 face、浏览/使用账号现有表情包、收到时保留语义与真实可用媒体 | 自然交流的基础，不把所有表情抹为文本或普通图片；自然表达切片 |
| 消息表情回应 | 给确切消息设置/取消自己的回应、查询实际回应、感知已收到的回应变化 | 轻量社交反馈，无需每次发送一段话；自然表达切片 |
| 主动撤回 | 撤回自己账号实际发出的确切消息 | 行动纠正；核心发送通路稳定后优先接入 |
| 主动转发 | 真实单条转发、按明确 refs 合并转发到明确目标 | 分享真实内容，保留作者/来源；核心发送后接入 |
| 资料赞 | 给明确联系人点赞、查询/感知自己收到的资料赞 | 低复杂度的社交反馈，与消息回应分开；自然表达后的小切片 |
| 视频基础收发 | 接收/下载视频消息、查看真实元数据与可用封面、发送已有视频文件 | 收到常见消息不能只保留“未知附件”；媒体切片，不包办视频理解 |
| 音乐/联系人分享 | 明确音乐卡片、好友/群名片分享；读卡片可提取真实标题、地址和对象 | 支持日常分享，复用普通资源与 contacts；协作切片 |
| 群文件浏览 | 列群根/子目录、查询文件信息、下载、上传到明确已有目录 | 基本文件合作，不能仅依赖最新聊天里出现的文件；文件切片 |
| 关系/群事件理解 | 成员增减、管理员/禁言、群名/名片/头衔变更、撤回、回应、资料赞等已收到事实归一化 | 维持真实社交环境认知；基础观测和对应动作切片同时接入 |

上述动作不引入新的 Subject、当前会话、ack/presented、权限审批层或精确交付协议。所有外部写沿用 will_dispatch、证据结算和 unknown；查询不消费 attention。

### 身份与表达的最小合同

- `profile`：明确 query/update 两种 schema，query 返回实际账号资料与观测时间，update 只改明示字段。适配器若需要完整资料，查询并保留未修改字段，不用空字符串/假默认覆盖。头像使用普通现有图片资源；生成头像由其他能力完成，QQ 不嵌图像生成器。
- 平台状态是账号表达，不等于 WS/QQ 登录健康。Uina 明确设忙碌/隐身/自定义文案，不能由“模型正在推理”自动推断情绪、睡眠或在线状态；不因此恢复正常 dashboard。
- `emotes`：查询普通表情映射与账号已有收藏表情。返回稳定表情 ref、已有名称/描述及可 inspect 媒体，不让模型猜 QQ 数字 ID；没有可靠描述时保持未知，查看后自行判断，不再建自动理解所有表情的后台模型。
- `send` 增加明确 face/emote 内容项。普通文字里的 Unicode emoji 仍是 text。发送收藏表情要验证当前可用资源/协议字段；资源失效返回失败或不可用，不偷偷换成另一张图片。
- `react`：message ref、明确表情 ref、set/remove；query 走 inspect。不是资料点赞，不自动回赞、不把某条消息的回应伪装成联系人原话。接口/事件覆盖有限时查实际结果，不宣称全量捕获。
- `like_profile`：明确 actor 与调用次数，未指定次数按适配器已核实的单次语义执行；平台拒绝次数/频率如实返回，不在扩展发明日配额或自动重试策略。

收到回应/资料赞仅按 attention 偏好提醒，没有独立任务债务；同一消息多次变更按现有 single-flight 合并。表情缓存属于可重建平台资源索引，不成为长期关系记忆。

### 撤回与转发

- `retract` 输入具体 message ref，限定自己账号已确认发出的消息。不能靠模型传一个昵称/数字推断归属；他端同账号发出的消息须如实区分发起者，但仍可作为明确的自己账号消息寻址。
- 撤回是新的平台动作，绝不是 cancel/restart/rewind 的隐式结果；QQ 权限、时间窗与老消息短 ID 重新寻址可能拒绝，按真实证据结算。
- `forward` 接受明确目标与一个或多个已有 message refs。单条/合并的形式明确选择，使用实际作者、时间、内容及可用媒体；P0 不提供任意伪造作者/时间的 node 构造器。
- 转发跨会话可以是 Uina 明确决定的动作，不暗中引用当前上下文所有消息、不自动转发引用里的附件或完整历史。原资源不可用/平台不允许转发时说明，不悄悄改为生成相似内容。
- 来源信息在世界保留；平台实际转发形式能显示哪些作者/出处要如实说明，不能承诺客户端一定展示全部。平台转发触及其他联系人信息，主脑按已有判断负责，不因此增加每次审批流程或宣称强保密隔离。

### 视频与分享：QQ 提供平台出口，主脑组合理解/资源能力

- 接收 video 保留 message/attachment ref、实际文件与可验证元数据、可用封面。`inspect` 可返回已有封面及说明；没有封面就明确缺失，不把封面当完整视频内容。
- `send_video` 接收普通文件资源，和 send_voice 一样只读外部源，准备自己的上传副本再执行；QQ 不生成视频、不查询生成器状态。
- 原生视频模型输入、整段音画理解、抽帧、字幕提取、视频生成/编辑不在 QQ 内建设。Uina 有真实需求时组合已具备的媒体工具；不存在就说能力缺失，不因 send_video 可用宣称能看懂视频。
- `share` 为明确类型的 schema：music / contact / group，包含类型对应的真实来源或稳定 ref，不接受万能 raw JSON。音乐从已有网址/资源信息或独立音乐能力得到；QQ 不 import 点歌台，不负责找歌/播放。
- 音乐卡片的协议/签名服务不可用时明确返回，不默认变成文字链接发出。主脑可以另外决定发送普通链接；两次行为各自明确。
- 联系人/群名片由 contacts 取得确定身份；接收卡片显示实际对象，不能把卡片显示名当本地操作者。小程序、任意交互 JSON/Markdown 卡片与按钮暂缓。

### 群文件与基础管理的范围封闭

群文件：`files` 查询群根/明确 folderRef 的列表、文件信息及实际下载范围；下载沿用 inspect/附件流程，上传可选择已有 folderRef。不保存当前文件夹，不要求模型维护文件系统游标。建立/删除目录、移动/重命名/删除/跨群转存暂缓，避免把基本接收/分享扩大成整个文件管理器。

好友基础范围：好友/分类资料查询、真实请求同意/拒绝、备注、删除。单向/陌生人信息可在 contacts 需要消歧时按真实查询能力取得，但不新增自动检测/关系推断任务。可疑申请专门管理、任意号主动加好友、拉黑等不进入本期范围。

基础群管理明确支持：

| 类别 | 本期动作 |
| --- | --- |
| 查询 | 群资料、成员、实际角色与禁言状态 |
| 请求 | 处理真实邀请/入群申请，保留请求者/邀请者、原因和 ref |
| 群内身份 | 自己的群名片、主体自己的群备注 |
| 群资料/公告 | 修改群名/群头像，查询、发布、删除公告，按平台权限 |
| 秩序管理 | 成员禁言/解除、全员禁言/解除、踢人、设置/取消管理员 |
| 退出 | 明确退出自己所在群；解散整个群暂缓，不藏在 leave 的默认参数中 |

这些管理动作逐项定义 schema，目标/参数明示，不是自由文本 manage。角色观测不代替平台授权；权限变化/请求过期/他端变更时如实结算，不能为了成功硬加兼容或重试。专属头衔、精华设置/取消、群荣誉、入群搜索/机器人选项、邀请策略、成员功能权限和新成员历史可见性暂缓。

观测可先保留这些暂缓配置的实际变化，主动写动作不必同时开放。不对外声明“群管理全支持”，工具只说明已经接线的具体动作。

### 暂不支持的能力与重新考虑条件

| 暂缓项 | 当前原因 | 重新考虑条件 |
| --- | --- | --- |
| 表情包添加/删除/改描述 | 先用既有表情足以表达；整理图库是另一项明确任务 | Uina 实际需要收藏或整理特定表情 |
| 骰子/猜拳等魔法表情 | 娱乐价值有，但非当前交流必需 | 有真实群游戏/互动需求 |
| QQ 收藏的创建/浏览 | 还没有平台收藏使用需求，不与 cognition 混为一谈 | 明确需要在 QQ 保存/找回收藏 |
| 群相册及评论/点赞 | 与聊天附件不同的完整媒体工作流 | 真实群相册协作 |
| 群待办 | 尚无需要群共享平台待办的场景 | 真实多人任务需使用群待办，而不是主脑提醒 |
| 群签到/记录 | 非当前主体社交必需，不做自动打卡 | 明确群约定或主体选择 |
| 精华/荣誉/专属头衔 | 基础交流、成员查询已够，暂不扩展群文化管理 | 群内容整理/荣誉/身份运营的具体需求 |
| 高级群入群/权限配置、群解散 | 现阶段没有平台级群治理需求，已有基础管理即可 | 主体确实负责某群的完整治理 |
| QQ 空间图文说说/删除 | 独立的公开发布与受众语义，应另切片验证；聊天优先 | 明确希望她经营空间，并定义实际受众与可用读写范围 |
| 在线文件/文件夹收发控制 | 普通文件先满足交换需求，另有接受/拒绝/取消状态机 | 离线上传不能满足真实文件传输需求 |
| 闪传/文件集/分享链接 | 特殊文件服务，不是普通附件 | 明确的大文件/文件集分享需求 |
| 小程序、交互卡片、内联按钮、特殊 Markdown | 目标/行为语义尚未定义，不开放万能 payload | 实际需要使用某类可验证平台卡片/服务 |
| 私聊输入状态的发送与持续感知 | 不为拟人制造打字状态；持续高频感知收益未证明 | 输入状态对实际交互有用，且能表达真实准备行为 |
| 平台自动已读/独立已读动作 | read 不改变平台状态，当前没有使用需求 | 明确需要平台已读；仍独立外部动作，不重引入 ack |
| @全体 | 普通明确 @已满足当前范围，群广播另有使用约束 | 有实际群公告/广播需求与权限验证 |
| QQ 自带 AI 音色 | 保留 Uina 独立声音与能力组合，非替代 TTS 默认路线 | 明确选择某个 QQ 原生音色或平台效果 |
| 可疑申请专门管理 | 正常申请先满足关系入口，无需求不建新策略 | 实际账号收到这类申请且需要处理 |
| OCR/翻译/URL 检查的专门 QQ 动作 | 内容理解优先组合现有能力，不因平台有辅助 API 增加门面 | 明确存在现有能力不能满足的输入/检查需求 |
| 运维/认证/raw packet/流式传输接口直接暴露 | 属于适配器、认证或明确维护工作，日常模型不用懂 | 具体维护/性能任务；只开放必要语义，保持密钥不进上下文 |

暂缓不等于丢掉收来的内容。基础信封保留未知类型/原始事件与来源，read/inspect 返回“已收到但未支持展开/操作”，可查询真正已有的字段。对空间/相册/收藏等没有订阅/查询的空间，不伪称已经持续观察全部内容。某类交互确有需求时重新决定，不增加空工具/失效 action 占位。

### 尚不能当作真实可用能力

本地 get_guild_list/get_guild_service_profile 的处理方法为空，location 发送 converter 是测试内容，部分 xml/miniapp converter 为空；独立 get_mini_app_ark 是另一条实际路径。QQ 频道、任意位置发送、任意 XML 等不列为“可接入但暂缓”，应标未证明/未实现；必须有真实代码与验收才能重新判断。

官方事件兼容表和本地实现对回应等上报范围有差异/限制，实施时核实，不能按事件名保证全量捕获。接收层允许保留未支持事件，模型输出不编造其效果。

### 接缝与源码依据

新增 profile/emotes/react/retract/forward/like_profile/send_video/share/files 都属于 QQ World 的明确领域动作或现有 send/read/inspect 的参数增强；无 Core、Host 公共合同修改，不建长期资产句柄、presented 或新队列。名称是建议，实施时保持单个 qq 工具与明确 schema，避免同时公开重复入口。

主要本地依据：73268 附近消息 converter；75178 资料赞；76061 在线状态；76550 资料；76634 收藏；77082/77139 回应；77194 输入状态；77277 起群文件整理；78087/78099 频道空实现；79105 起待办/相册；79819 起闪传/在线文件；80236/80273 空间；80304 起高级群权限；71427 起群通知。入口存在不代表当前账号可用，真实验证单独进行。

## 实施与验收

所有“纳入当前设计”都属于本次选定范围，但按切片交付，不能在基础循环尚未验证时一次接入全部 API：

1. **核心通路**：journal/index、账号/连接、八个基本认知动作、single-flight、危险写屏障、send/operation、自消息与历史缺口。信封保留媒体和关系/群事件，不加 Host/Session 对账。
2. **基础通信**：图片/文件/poke、好友/请求、语音转写、独立 TTS render_file 模型动作与纯文件 send_voice。与核心通路共同满足最初已明确的通信需求。
3. **自然身份与表达**：profile/状态、普通/既有表情、回应、撤回与真实转发；接着资料赞。采用同一账本/事件/动作接缝。
4. **媒体合作与基础群管理**：视频基础收发、音乐/联系人分享、群文件浏览/选目录上传，以及上表明确的群管理。视频深入理解和高级群配置不混入此切片。

暂缓表中的能力不进入这些切片，没有后台预建、空实现或提前加入工具 schema。

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
- profile 改一个字段不清空其他资料；平台状态不等于连接健康，不自动投影普通 dashboard。
- emotes 使用实际 ID/ref；失效表情不偷换图片；react 增删归属与查询范围明确，资料赞独立。
- retract 校验自己账号归属/平台权限，失败不改写历史；forward 只用真实 refs，不伪造作者/时间，不隐式转发整段私聊。
- video metadata/封面不冒称完整内容理解；普通文件发送与视频消息语义不同；QQ 无视频生成器/点歌台依赖。
- share 卡片失败不自动改发链接；contacts 稳定身份消歧；files 查询不保存当前目录/消费 offset。
- 群管理逐项权限/请求失效/他端变化验证；leave 不隐含解散群，暂缓动作不在 schema。
- 未支持消息/事件保留原始来源并明确能力缺口；没有订阅的平台空间不宣称完整感知。

实施后运行 pnpm typecheck（含 boundaries）及相关 TS/Python 测试。本次纯文档不运行代码测试、不把既有测试当实现证明。

真实验收：账号/自消息/群权限/poke packet，实际历史与短 ID 重启，媒体过期/语音格式转换上传，真实音色/图像理解/语音转写。sync故障注入证明代码合同，真实断电及目标设备保证另验收。

预计代码修改范围为 `.uina/worlds/qq`、TTS Extension/Bridge 和相关测试；P0 不改 Host/Extension 公共合同或 Core 状态机。缺口若出现须以真实调用/失败场景证明再增强接缝。

## 文档归属与源码索引

此文件位于既定 Git 忽略目录，属于本地私人设计文档。历史版本：

- `docs/history/qq-world-design-before-review-2026-10-02.md`
- `docs/history/qq-world-design-before-attention-simplification-2026-10-02.md`
- `docs/history/qq-world-design-before-scope-selection-2026-10-02.md`

本次只修订提案的支持范围、动作边界与验收，并保存此前文本；未修改运行代码、配置、第三方或真实会话。其他原有/并行工作树修改保持不动。

优先源码：

- `src/extensions/world-framework/types.ts`、`world-activation.ts`、`world-loader.ts`、`world-tool.ts`
- `src/extensions/runner.ts`、`services.ts`、`lifecycle-scope.ts`
- `src/agent/loop.ts`、`src/runtime/events.ts`、`hooks.ts`：受理、followUp、活动结算合同
- `src/session/jsonl-store.ts`、`recovery.ts`：sync、回退、重复队列 ID
- `src/extensions/event-frames/projection.ts`、`src/extensions/cognition/context.ts`
- `.uina/extensions/tts/tool.ts`、`index.ts`、`client.ts`、`bridge/server.py`、`service.py`
- `E:/Uina/ThirdParty/NapCat/app/napcat/napcat.mjs`：消息地址、发送、历史/媒体/poke/管理

官方交叉参考（不替代本地实现）：`https://napneko.github.io/onebot/api`、`https://napneko.github.io/develop/msg`、`https://napneko.github.io/develop/event`；文件持久化参考 `https://nodejs.org/api/fs.html` 与 `https://sqlite.org/atomiccommit.html`。
