# QQ World 人物、文件、资源拉取、历史检索与表情设计

日期：2026-10-11（Asia/Shanghai，GMT+08:00）  
状态：五个动作已实现并注册，隔离测试通过；真实 QQ 服务不可连接，真实平台读取仍未验证。实际落地取舍与门禁见 §15。
范围：新增 `people / files / fetch / search / expressions` 五个领域动作，继续只注册一个 `qq` 工具。

2026-10-14 复核：五个动作仍与当前源码相符；§12 的实施阶段是已结束的历史计划，不是当前施工清单。当前离线复核为 QQ/schema 24 个测试文件、420 项通过；真实 QQ 及平台资源读取仍未验证。

## 1. 要解决的问题与最终边界

Uina 已能阅读 QQ 消息和主动行动，但还需要可靠回答五类问题：这个人是谁、群里有什么文件、怎样把已发现的附件取得为本地文件、过去收录过什么、哪些表情编码可以用于表达。

五个动作分别完成一个完整意图，输出能够直接成为下一步输入。QQ 负责接触平台与取得资源；文件阅读、PDF 解析、语音识别、音频转换和内容理解由已有或独立能力完成。下载成功只证明取得了字节，不证明 Uina 听懂了语音或读懂了文档。

本次确定两条不可放宽的底线：

1. `fetch` 只读拉取。允许写入 QQ 自己拥有的本地下载文件，但不改变平台对象；不加入群文件上传、删除、移动、重命名、建文件夹或权限管理。
2. `search` 只检索本地已收录消息历史，明确返回 `source: "local"` 与覆盖边界；不假设 QQ 平台拥有全文检索 API，不将无命中说成“平台上没有”。

本设计针对前序规格的动作数量作一次明确扩展：当前九个领域动作扩展为十四个，注册工具数量仍为一个。原来的六动作版本已经退役，不恢复。前序设计的消费、通知、身份、授权和生命周期合同继续有效；这里只调整原规格中“固定九个积木”的数量决定。

历史前序依据：[归档版阅读与通知设计](../../archive/qq/qq-reader-notification-design-2026-10-09.md)、[当前运行事实](../../current-runtime.md)、[现有验收矩阵](../../qq/qq-world-acceptance.md)。实现阶段已结束；当前差异以源码、运行事实和验收记录为准。

## 2. 当前证据与未知项

以下来自 2026-10-11 的本地源码检查；SDK 类型声明只证明适配入口存在，不证明真实服务器返回满足使用条件。

| 事项 | 当前事实 | 本设计要求 |
| --- | --- | --- |
| 工具表面 | `.uina/worlds/qq/tool.json` 定义单一 facade、九动作；`src/tool-schema.ts` 由脚本生成 | 在唯一参数真源增加五个分支，不另注册五个工具 |
| 人物读取 | SDK 声明好友、陌生人资料、群成员列表和成员资料；成员列表返回数组 | 校验真实字段、保留未知、重名返回多个候选 |
| 群文件读取 | SDK 有根目录、子目录和下载地址入口；目录返回为宽泛 `JsonObject` | 先验证载荷，再形成目录合同；畸形载荷不能当空目录 |
| 附件读取 | 消息目前保留类型、mediaRef、URL、文件名；`media-fetch.ts` 只负责内联图片 | 补足来源与平台定位字段，独立提供文件资源拉取链路 |
| 文件/语音 API | `get_image/get_record` 返回宽泛 `MediaInfo`；`get_file` 返回 `JsonValue` | 必须探明定位与字节获得方式，不能凭 API 名宣称支持 |
| 平台下载 | `download_file` 返回平台进程的文件路径 | 不能直接将该路径包装成 Uina 可读本地文件 |
| 系统表情 | `app.ts` 已有内部 `handleExpressions`，尚非公开 action | 复用有效查询逻辑，补严格解码和模型可用输出 |
| 自定义贴纸 | SDK 有 `fetch_custom_face`，返回 `string[]`；当前 send 不接受贴纸引用 | 本次首版不公开自定义贴纸，避免产生无法消费的结果 |
| 本地检索 | journal 已持有消息与覆盖风险；已有通用分页实现 | 首版直接查询事实，不增加独立索引权威或向量服务 |
| 普通文件消费 | workspace `read_file` 可读绝对路径的 UTF-8 文本，二进制会明确拒绝；send 接受本地文件资源并检查根目录 | 通过真实下游工具验证组合，不能仅断言输出有 path |

证据入口均相对项目根：`.uina/worlds/qq/src/{index,app,reader,observe,facts-journal,message-codec,types,pagination,media-fetch,media,media-root}.ts`，SDK 的 `src/vendor/snowluma-sdk/types/{actions,params,results}.ts`，以及 `src/extensions/workspace-tools/index.ts`。

`docs/current-runtime.md` 记录的 2026-10-11 只读连接探测不可用；本文未获得新的真实服务证据。目录结构、私聊附件、群文件和语音读取的真实返回，均保留为实现验收中的未验证项。

## 3. 领域分工

| action | 唯一职责 | 主要成果 | 明确不承担 |
| --- | --- | --- | --- |
| `people` | 找到人物并读取上下文内的身份资料 | userRef、名称、群名片、已知角色与观察时间 | 加好友、删好友、关系评分、在线状态推断 |
| `files` | 浏览一个群文件目录 | 文件/文件夹引用、名称、已知元数据、续页 | 下载字节、递归扫描全树、群文件管理 |
| `fetch` | 将一个已发现的平台资源取得为本地文件 | 普通文件 resource、实际大小、来源和格式事实 | 上传、删除、转写、解析、转码、自动处理附件 |
| `search` | 在本地收录历史中找消息 | messageRef、命中片段、会话、覆盖说明 | 平台全文搜索、自动补历史、语义记忆管理 |
| `expressions` | 查找平台系统表情编码 | faceId 或 reactionCode、名称与可用调用 | 替模型决定情绪、自动发送、捏造贴纸发送合同 |

新增动作全部是读取能力。`files → fetch → read_file/独立解析能力`、`search → browse → fetch`、`people → send/interact`、`expressions → send/interact` 是正常组合。先查找再行动时，读取成功不蕴含后续写入权限或平台接受。

群公告、精华消息、合并转发发送、群管理和自定义贴纸发送不属于本文实施范围。已有能力保持自己的职责，不为这五个动作顺带扩张。

## 4. 共同调用和成果合同

### 4.1 facade、校验与授权

统一入口为 `qq({action, params})`，账号由 World 绑定；模型不填写 account。每个分支使用明确 schema 和 `additionalProperties: false`，组合约束进入 schema 或紧邻 handler 的校验，避免多个旧参数映射层。

`people/files/fetch/expressions` 使用已有 `observation`。纯本地 `search` 延续现有纯本地读取授权规则，不新建 grant；它不会偷偷调用平台接口。后续 `send/interact` 独立检查自身现有 grants。

所有平台查询都通过当前传输和绑定身份核验，不引入第二个 QQ 客户端。局部目录权限拒绝表达为局部拒绝，不能推断整个平台不支持。

### 4.2 成果与未知值

沿用 `ToolExecutionResult`：可读 `result`、`status`、结构化 `details`。以下字段是新增动作在 `details` 中的共同约定，不新增 Core 类型：

- `source`：明确 `platform` 或 `local`；`fetch` 进一步说明本次字节来自已保存副本还是平台拉取。
- `observedAt`：平台查询时间或本地检索快照时间，使用 ISO UTC；展示时标明时区。
- 列表成果：`items / total / hasMore / nextCursor?`；`total` 仅为本次所取得、筛选后的数据集条数。
- `coverage`：说明对象范围、是否已完整取得本次目录，以及平台总体完整性未知。消息检索使用更具体的覆盖字段，见 §9。
- 分页有后续时提供 `nextCall: {action, params}`；它保留查询条件与 limit，直接携带 nextCursor。
- 不存在证据的角色、大小、格式、上传者等值使用 `null` 并说明 unknown；有效空列表和无法取得列表严格区分。

查询成功表示本次声明的查询完成，不表示平台总体完备。某条元数据缺失但对象身份有效时可以正常返回并标 unknown；身份或关键结构不可辨识时整次查询失败，不能静默过滤掉坏行再宣称列表完整。

可读结果保留名称与行动引用，不重复堆出内部 JSON、鉴权地址和全部调试字段。大列表以分页完整取得，长预览显式折叠；不能为了预算删掉实际返回条目的引用。诊断不记录 URL 中的鉴权参数和密钥。

### 4.3 稳定引用与目录分页

复用现有 `u… / g… / p… / t… / m… / a…` 引用，不把昵称、文件名或过期下载 URL 当作身份。已有短引用只在绑定 World 的账号作用域中解释，不改变其格式或承诺跨账号可移植。

新增 `fileRef/folderRef` 使用有版本的可序列化引用，携带绑定账号、群、父目录和平台对象标识；文件定位需要时保留 busid。具体编码由实现固定为 `qfile:v1:<base64url>`、`qfolder:v1:<base64url>`，只承载平台定位字段，不承载下载 URL、本地路径或任意请求头。解码后严格校验，账号不符直接失败。编码本身不是权限凭据，实际访问仍重验身份与对象；同一平台对象重复查询返回同一引用，重启后可解析。平台 ID 变更则返回新引用。

首版不增加中央资源 registry、句柄租约或 release 工具。目录读取不写入 received 事实；`fetch` 使用引用重新查询其父目录、验证对象仍存在，再取得地址。无有效刷新链路时返回 unavailable，不能猜地址。

列表默认每页 20 条，limit 为正安全整数，不新增无依据的总结果硬上限。复用 `pagination.ts` 的条件绑定和显式 `cursor_invalid/cursor_stale`，游标绑定账号、动作、过滤条件、目录与 limit。首版目录采用实时重新查询；成员/文件增删或名称变化会使旧游标 stale，并提供无 cursor 的重启调用。观察时间、签名 URL、无关消息计数等易变字段不进入分页指纹。稳定排序与可见元数据字段参与指纹，不能因同一页偶然相等而跨数据集续页。

### 4.4 生命周期与失败

新增读取动作不得更改 dispatched、notified、skip、基线、focus、push 或待处理事项。平台历史/点查只读结果不得变为新到达 received 事实。fetch 增加本地文件与必要附件定位事实，也不等于阅读正文。

平台读取复用现有取消和超时边界。等待结束后、构造成果前重新检查 signal、World 生命周期与绑定身份。World stop 取消未完成查询和下载，迟到回调不能发布成果或重新排期。无需给纯查询加消费锁或 QQ 自己的后台工作队列。

| 情况 | status / reason 的设计口径 | 恢复方式 |
| --- | --- | --- |
| 不合法选择器、条件组合、游标 | failed / invalid_params、cursor_invalid、cursor_stale | 给可执行修正或重新查询调用 |
| 无读取授权、对象权限拒绝 | failed / grant_denied、platform_denied | 说明实际拒绝范围 |
| 连接或身份尚未就绪 | failed / connection_unavailable、identity_unverified | 使用现有连接诊断，不恢复退役诊断 action |
| 平台超时/畸形返回 | failed / query_timeout、malformed_response | 保留错误证据，不能当空结果 |
| 对象删除、定位不足、URL 失效无法刷新 | failed / resource_unavailable、locator_unavailable | 回到 files 或消息点查重新定位 |
| 取消或停止发生在成果发布前 | cancelled / cancelled、world_stopped | 不返回成功资源，不追加消费事实 |
| 本地文件未完整取得或无法发布 | failed / download_failed、integrity_mismatch、storage_failed | 清理自有临时文件，允许主动重新 fetch |

`not_started` 表示必要动作尚未开始的事实，不用它伪装已发出但失败的查询。读取失败无需借用写操作 unknown 屏障；已有外部写操作仍沿用 succeeded/failed/cancelled/unknown/not_started 的真实副作用语义，unknown 不自动重发。资源完整性未知是成功成果中的证据字段，不等于“下载状态 unknown”。

## 5. people：找到人并取得上下文资料

### 5.1 输入

`scope` 为 `friends | members | person`，缺省 `friends`：

| scope | 必要参数 | 可选参数 | 平台链路 |
| --- | --- | --- | --- |
| friends | 无 | query、limit、cursor | get_friend_list |
| members | conversationRef，必须为群 | query、limit、cursor | get_group_member_list |
| person | userRef | conversationRef，若有则必须为群 | get_stranger_info 或 get_group_member_info |

`query` 只适用于列表，对昵称、好友备注、群名片作去首尾空白、Unicode NFC、大小写不敏感的字面子串匹配；不做模糊身份猜测，不支持正则。空 query 等于不筛选。person 模式拒绝 query/limit/cursor。

好友列表与成员列表按 userRef 对应数字 ID 的确定性顺序分页，编号用字符串比较规则实现，避免不安全 Number 转换。members 查询明确请求 fresh/no_cache（适配器支持时）；不能读取旧缓存后声称实时。返回来源与缓存新鲜度证据，无法确认缓存状态则 unknown。

### 5.2 输出与认知约束

每个 item 提供 `userRef / displayName / nickname / remark / card / role / conversationRef?`，以及 person 资料中平台实际提供的相关字段。displayName 优先群名片或好友备注，再昵称；都缺失时显示 userRef 并标名称未知。role 未提供则 null；不依据消息语气猜身份，不用目录存在推断在线。

重名列出所有匹配项与上下文，不自动选择、不直接写入。群成员不保证可建立普通私聊；临时会话也不能由群成员身份直接推导“已可私聊”。follow-up 调用必须使用已知有效会话引用或让模型继续询问目标。

```json
{"action":"people","params":{"scope":"members","conversationRef":"g123456","query":"小王","limit":20}}
```

```json
{"action":"people","params":{"scope":"person","conversationRef":"g123456","userRef":"u234567"}}
```

人物引用用于已有 mention/poke 等参数；查询不增加好友或改变关系。完整 person 资料无适配器证据时只返回已证实字段，不复制整份宽泛平台 payload 给模型。

## 6. files：只读浏览当前群目录

### 6.1 输入与输出

输入为 `conversationRef`（群，必填）、`folderRef?`、`query?`、`limit?`、`cursor?`。不传 folderRef 查根目录；传入则必须属于同账号、同群。query 为当前目录名称的同一套字面子串匹配，不递归、不代表全群文件搜索。

根目录使用 `get_group_root_files`，子目录使用 `get_group_files_by_folder`。输出统一 items：

- 文件夹：`kind:"folder" / folderRef / name / parentFolderRef / knownChildCount|null`。
- 文件：`kind:"file" / fileRef / name / parentFolderRef / sizeBytes|null / uploaderRef|null / uploadedAt|null`。
- 平台不提供根对象引用时 parentFolderRef 为 null；不能将 null 当名称缺失或非法路径。

先文件夹后文件，同种按 NFC 名称与稳定平台 ID 排序。平台目录没有证明完整分页时，coverage 明确 `directoryComplete: null`，`total` 只覆盖本次已返回对象；本地分页结束不能称“整个群文件已枚举”。若适配器本身提供续页或截断信号，实现先兑现其读取合同，再作 facade 分页，不能忽略信号。

目录载荷解码必须分清空数组、缺关键字段和不支持。对不认识的结构返回 malformed_response，并将经过脱敏的结构摘要用于诊断。群目录无权限不回退到“本地消息里见过的附件”；那是另一种数据源。

```json
{"action":"files","params":{"conversationRef":"g123456","query":"会议纪要","limit":20}}
```

folderRef/fileRef 必须复制真实返回值，本文不伪造一个看似有效的引用示例。每个文件行提供合法的 `fetch` next action，每个目录行提供合法的 `files` next action。

私聊文件库没有已验证的枚举接口，本次不设计 private scope。私聊中的文件由消息定位，交给 fetch。

## 7. fetch：取得一个已发现资源的原始文件

### 7.1 输入与选择器

输入只有 `target`，以下三种形状严格择一：

1. `{mediaRef}`：复用已发现的 a 引用及其绑定来源。
2. `{fileRef}`：使用 files 返回的群文件引用。
3. `{messageRef, segmentIndex}`：明确消息与零起始附件分段；不自动选“第一份看起来像附件”的内容。

不接收任意 URL、base64、平台本地路径、请求头或模型指定 outputPath。嵌套转发中的附件通过 browse 返回的、具有可解析来源的 mediaRef 拉取；不能寻址时明确 locator_unavailable，不猜节点。首版没有批量下载和自动拉取所有附件。

```json
{"action":"fetch","params":{"target":{"messageRef":"m77","segmentIndex":1}}}
```

```json
{"action":"fetch","params":{"target":{"mediaRef":"a12"}}}
```

### 7.2 定位与取得字节

先解析绑定作用域和对象类型，再沿现有本地优先、缺失 get_msg 的链路定位消息。补充附件定位时需要保留：来源消息、会话、分段/转发节点位置、平台 file/file_id、私聊 file_hash、群 busid 等实际必需字段。字段可以缺失，缺失就不能承诺对应下载路线。

定位信息由 QQ 的附件事实拥有，媒体索引从事实派生；为本地历史中的附件增加可回放的补充定位记录，不重写旧日志、不增加 received。平台只读快照中的附件需要时仅保存带查询来源的定位记录，不伪装成新到达消息。每个引用跨重启后仍可解析到来源，或者明确不可用，不能解析到另一个附件。补充定位写盘失败必须在取得成功前明确失败；索引不能成为第二份独立权威。

| 来源 | 读取路线 | 前置证据 |
| --- | --- | --- |
| 群目录文件 | 刷新父目录并核验 file_id → get_group_file_url → 取得字节 | file_id/busid 的实际含义和返回 URL 结构已确认 |
| 私聊文件消息 | 消息定位 → get_private_file_url 或已验证 get_file → 取得字节 | user_id/file_id/file_hash 足够，返回结构已确认 |
| 图片/语音/视频消息 | 按类型使用已验证 get_image/get_record/get_file 或平台资源 URL | 参数可定位对象，响应能获得原始资源 |

平台 URL 过期可在本次调用中刷新一次；不无限重试。只接受经已验证平台来源获得的 HTTP(S) 地址，正常处理该平台部署所需的 localhost 地址；跨域重定向不转发鉴权 header，也不把模型输入变成任意网址下载器。

平台返回 `file` 路径时，先判断它属于平台机器还是本机。没有明确部署共享目录映射时禁止直接读；有映射则经过路径解析、realpath 和只读根边界检查，再复制到 Uina 自有资源根。Windows junction、符号链接、路径穿越均不得突破映射根。禁止依靠当前进程“碰巧能打开同名路径”来宣称成功。

语音保留实际编码，不自动转码为 WAV。audio 类型可能是 SILK/其他容器，返回识别到的 MIME/格式或 unknown；是否存在可处理它的下游工具独立判断。拿到 byte stream 不等于 ASR 可用。

### 7.3 本地发布、寿命与取消

下载根固定为当前账号 World 数据目录的 `downloads/`，由 World 取得真实 dataDir，不根据 cwd 猜目录。不复用当前出站 `media.ts` staging：它会在操作结算后清理，无法承担后续工具的资源寿命。

实现使用生成的唯一资源子目录、清洗后的展示文件名和同根临时目录。先完整流式取得，再检查传输长度（若有）与平台可靠摘要（若有），计算本地 SHA-256，将文件与来源/摘要元数据一同写入临时目录并关闭文件。最后在同步的发布临界段重新检查取消/生命周期，以同一文件系统的目录 rename 原子发布两者；不在两次 await 之间分别发布文件和元数据。失败只删除本次拥有的临时产物。完整性未知明确保留；不能把本地自己计算的 hash 当平台校验通过。

只在原始文件完整、实际可读且必要来源元数据写入成功后返回 succeeded。发布成功是本次取消边界：在此之前停止则不发布；之后资源成果已形成，不因迟到取消把一个成功资源改成 cancelled。崩溃遗留的未发布文件不进入成功结果，下一次生命周期启动只清理 downloads 内已确认自有的临时产物。

发布文件跨工具调用和正常重启保留，首版无自动 TTL、无调用结束即删除；删除由用户或未来单独存储维护功能负责。未发布的临时文件与正式资源严格区分。相邻来源/摘要元数据仅记录成果，不实现下载缓存或副本复用。相同资源被同时拉取允许形成两份完整副本，首版不为省一次下载添加全局锁服务。

结果至少提供：`resource:{kind:"file",path:<绝对路径>}`、`fileName`、`mediaType`（image/audio/video/file）、`mimeType|null`、`sizeBytes`、`sha256`、`integrity`、`fetchedAt`、`origin`。integrity 取 `transport_checked | local_digest_only`，分别表示仅传输/目录长度等边界验证通过、仅得到完整流与本地摘要；不声称已核验平台摘要算法或 platform_verified。mimeType 区分已识别值与平台声明值，不因扩展名或 audio 标签推定格式。origin 有原 messageRef/fileRef 与会话，真实 URL 留在内部且脱敏。下载错误不能返回半文件的可用 resource。

如部署已有明确大小/磁盘/时间限制，执行前说明，并在越界时失败；不能静默截断或临时发明工具容量上限。实现以流式方式避免将文件全量驻内存。

## 8. 资源组合的实际可用性

fetch 成果是普通文件，不要求下一工具理解 QQ。UTF-8 文本可传给现有 read_file 的 path；图片可交给 read_image；PDF/语音交给实际存在且接受对应格式的独立能力。没有对应能力时如实告知“已取得文件，当前无已验证解析/转写能力”，不造一个工具名作为续读指引。

下面是下载完成后的既有 send 形状，路径只作示意，必须使用 fetch 实际返回值。发送为独立外部写操作：

```json
{"action":"send","params":{"conversationRef":"p234567","content":[{"type":"file","path":"E:\\Uina\\downloads-example\\resource.txt"}]}}
```

send 当前运行时也接受 `{kind:"file",path}` resource，但当前模型 schema 暴露的是 `content` 数组中的媒体段 path，且不接受 name/resource 字段；组合指引遵守真实 schema，不能把运行时宽容分支当成模型可用合同。后续若统一资源入参，需要独立修改 schema、fixture 和合同测试，不能只修改说明文字。

默认 media 根目前含 QQ dataDir，通常覆盖新 downloads 根；用户显式配置的 allowedRoots 可能排除它。fetch 不偷偷扩大出站根，后续 send 应按既有策略明确拒绝；验收必须同时覆盖默认配置的可组合与显式受限配置的拒绝。普通文件读取与对外发送的授权、格式要求分别报告。

## 9. search：本地收录历史检索

### 9.1 输入与匹配规则

参数为 `query`（必填，trim 后非空）、`source?`（只允许 local，默认 local）、`conversationRef?`、`senderRef?`、`direction?`（in/out）、`since?`、`until?`、`limit?`、`cursor?`。

时间使用带 Z 或偏移的 ISO 格式，范围为 `[since, until)`；不得接受无时区时间后猜测当地时区。since 必须小于 until。首版 query 作为一个字面子串，采用与 people 相同的 Unicode NFC/大小写规则，不使用正则、分词、嵌入或模糊语义。多关键词 AND/OR 留给有实际需求的后续合同。

首版检索字段严格限定为本地消息 text 段和 fileName；分别匹配每个字段，不跨分段拼接产生不存在的命中。JSON/XML 卡片原文、未展开转发节点、附件字节、ASR 内容、人员资料和事件不纳入索引。呈现明确列出 `searchableFields:["text","fileName"]`，不能称“搜索所有内容”。

本地真实收录的入站与出站均可检索；已消费/封存不是排除条件，默认仍参与。已撤回但本地保留的文本可命中，结果必须标已撤回；后续行动仍受既有所有权/可寻址约束。平台 browse 的临时历史快照未进入到达事实，因此默认不参与；不因一次搜索自动读取平台历史或写回 received。

```json
{"action":"search","params":{"source":"local","query":"会议纪要","conversationRef":"g123456","since":"2026-10-01T00:00:00+08:00","limit":20}}
```

### 9.2 排序、分页与覆盖说明

结果一条消息一行，多次命中作为该条的 matchedFields/snippets，不重复计数；按消息时间降序、conversationRef、会话 sequence、messageRef 确定性排序。未知或无效时间保留 unknown，放在无时间过滤结果末尾；有时间过滤时无法证明满足范围的消息不参与，并说明排除数。

首版直接扫描当前事实集合，复用现有分页，不持有跨调用内存快照。命中集新增、删除或可见内容变化会导致 cursor_stale，给原条件的无游标重启调用；不跳过位置后悄悄继续。非命中消息新到达、通知/消费位改变不影响游标。指纹绑定完整命中身份与内容摘要，不能只绑定缩短后的 snippet。引用和正文匹配结果不依赖“全局 seq”；现有 sequence 是会话内序号。

每次结果提供 messageRef、conversationRef、senderRef/name、time、direction、命中字段、明确截断的短片段，以及可执行 browse 调用。默认不下载媒体。结果文本开头明确“本地已收录历史”；零命中写“在本次本地检索范围内无命中”。

coverage 包括：实际检索会话范围、有效消息最早/最晚时间（无消息为 null）、收录条数、时间过滤条件、显式风险区间、归档/撤回等相关标注、未检索字段，以及 `platformCompleteness:"unknown"`。最早/最晚仅表示本地有样本的边界，不是连续覆盖承诺。封存只表示消费基线，不是假定缺口；风险来自可回放的断线/解码/传输异常，不从 message_id 或时间间隔推断漏消息。

不在本地的消息只能另行明确 browse 的 platform 来源；查询失败不能隐式替换 search 的数据源。若未来增加独立历史导入，需设计 provenance 和覆盖验收，不在此引入。

## 10. expressions：系统表情发现

参数为 `kind?`（face/reaction，默认 face）、`query?`、`limit?`、`cursor?`。空 query 查询 fetch_sys_faces，非空查询 search_sys_faces。复用内部有效链路，但补严格 payload 校验，不能沿用宽泛 payload 缺字段时 `?? []` 的假空目录行为。

返回数字字符串平台 q_sid，已知名称/别名、super 等实际字段，按稳定数字编码排序分页；Unicode emoji 和 em_code 不得未经映射当成 faceId/reactionCode。

face 结果提供 `faceId` 与现有 send face 段模板；reaction 结果提供 `reactionCode` 与 interact 模板。目录编码可作为一次调用的合法入参，不代表所有群/消息场景都接受 reaction。reaction 读取注明“候选系统编码；目标场景接受性由平台回执确定”；真实不支持的编码通过原 interact 明确失败，不建立假 capability 矩阵。

```json
{"action":"expressions","params":{"kind":"face","query":"微笑","limit":20}}
```

```json
{"action":"send","params":{"conversationRef":"p234567","content":[{"type":"face","faceId":"14"}]}}
```

```json
{"action":"interact","params":{"action":"react","messageRef":"m77","reactionCode":"14"}}
```

后两个示例只说明现有调用形状；实际编码必须复制对应查询结果。无目标时返回 template + required fields，不能返回缺必填参数却称可直接执行的 nextCall。

首版不暴露 `kind:custom`。SDK `fetch_custom_face` 的字符串不等于 face 数字编码，也未证明完整分页；若以后开放自定义贴纸，必须与 send 专用资源分支、独立操作审计、顺序/引用/unknown 语义和真实对端验收一同设计。不将其无损伪装成 image 或 face。

## 11. 实现组织与最少状态

修改限于 QQ World、相关测试、fixture、诊断辅助与文档。不修改 Core、Host 的通用合同、vendored SDK、真实配置/认证/数据、Pi 和 Live2D 在途工作。

沿现有 `index → app → handler → transport/journal` 接线；新增处理函数按上述职责组织。文件定位/下载确有独立 I/O 与资源寿命，可放入局部模块；人物/表情列表不需要 Manager、独立缓存服务或通用插件框架。通用分页和本地优先点查继续复用，媒体定位字段单源定义，避免各动作各自解码同一附件。

新增持久状态只有两类必要证据：可回放的附件定位补充事实，以及 downloads 中已发布文件和相邻来源/摘要元数据。旧日志允许缺新字段，不回写升级；恢复由 World 生命周期完成。查询缓存若只是加速可以丢弃，不具有事实权威，也不能让在线目录失败变成成功。

已有写操作日志 audit identity、消息解码顺序、消费位、通知候选和重试定时器不在本次重构。五个读取动作只共享现有调用/取消基础设施，不为下载添加自动后台重试或通用任务系统。

## 12. 分阶段实施与进入下一阶段的门

| 阶段 | 实施内容 | 必须取得的证据 |
| --- | --- | --- |
| S0 合同与载荷 | 确认 schema、列表形状、定位字段；建立严格 decoder 和脱敏 fixture；先确定实际部署可读取路线 | 数组/空/畸形/拒绝区分；所有示例可通过 schema；未知字段不伪补 |
| S1 人物与系统表情 | 接线 people/expressions；提供真实输出、查询、续页和合法组合模板 | 重名不误选；成员列表数组；无 grant 拒绝；表情目录不产生写操作 |
| S2 本地历史检索 | 只实现 local search；复用事实和风险回放 | 零平台请求；完整检索声明字段；分页 stale 明确；消费变化不改命中 |
| S3 群文件发现 | 实现 files、可重启的引用、目录刷新与权限语义 | 每个文件/文件夹可继续定位；载荷错误不伪空；无任何平台管理调用 |
| S4 文件资源拉取 | 补附件定位与发布生命周期；按已证实路线逐类支持 file/image/audio/video | 字节校验、取消/停止、重启、跨账号隔离；真实下游读取路径可用 |
| S5 集成与文档 | 通过注册后的 qq 走完整组合；更新运行事实、前序数量决定、验收矩阵 | 工具 schema/注册一致；已有九动作无回归；真实边界逐项报告 |

S0 可使用 fake 平台推进本地工作，但如果真实返回尚未验证，相应路线保持“实现/隔离测试通过，平台未验证”。不能将未证实的通用 get_file 当作所有附件的兜底。S4 按资源类型分别验收，禁止因图片通过就标文件与语音完成。

每阶段只在对应代码与证据具备后标完成。隔离自动化与真实平台证据分别记录，见 §15。

## 13. 对抗式验收矩阵

| 编号 | 反例/边界 | 必须观察到的结果 |
| --- | --- | --- |
| D01 | 注册后的模型工具表面与旧动作 | 一个 qq；最终十四分支；旧六动作不复活，九动作合同不变 |
| D02 | 同昵称/同群名片多人；空名称 | 返回所有候选与 userRef；未知如实显示；无自动写入 |
| D03 | 群成员数组、关键字段缺失、目录拒绝 | 正确数组解码；malformed_response 与有效空列表不同 |
| D04 | 所有列表续页、改变 limit/查询/账号 | nextCall 能原样续页；错绑定 invalid；数据变化 stale |
| D05 | 无关消息到达、计数/消费位变化 | 人物/文件目录分页不因无关事实失效；search 命中集未变可续 |
| D06 | folderRef 跨群、fileRef 跨账号、篡改/旧版本引用 | 明确拒绝；不访问错误对象，不读取任意本地路径 |
| D07 | 群文件目录结构未知、上游结果截断 | 不伪空；coverage 不宣称完整；不递归全树或静默遗漏 |
| D08 | files→fetch；文件已删除/同名替换 | 验证稳定 ID；旧对象 unavailable；不以同名替换继续 |
| D09 | 旧消息缺定位、私聊 hash 缺失、URL 过期 | 有证据才刷新；无法定位明确失败；无无限重试 |
| D10 | 平台路径来自另一机器/映射外/junction | 未发布 resource；映射存在也不能突破只读根 |
| D11 | 连接中断、短响应、长度/摘要不符、磁盘/元数据写入失败 | 不返回半文件成功；删除自有临时文件；失败可诊断 |
| D12 | 下载、定位写盘、最终发布附近取消/World stop | 取消边界明确；stop 后无迟到成果发布、定位提交或重试计时器；仅允许清理本次自有临时产物 |
| D13 | fetch 后下一回合/重启读文件；并行重复 fetch | 实际字节不变、资源保留；独立副本不互删，来源不串号 |
| D14 | 原始语音格式下游不支持；文本/图片下游实际读取 | 无伪转写或转码；UTF-8 经 read_file、图片经 read_image 验证 |
| D15 | download 根默认允许/显式不在 send roots | 默认可合法组合；显式根策略明确拒绝，不扩权限 |
| D16 | search 无命中、text/fileName 边界、大小写/Unicode、跨分段词 | 明确 local/字段范围；不搜附件字节；不生成跨字段假命中 |
| D17 | search 有撤回/封存/断线风险/未知时间 | 保留恰当标注；封存不当缺口；时间边界与排除数正确 |
| D18 | search 续页中新增命中、修改内容与非命中到达 | 前两者 stale 并可重启；非命中到达不影响命中指纹 |
| D19 | 所有五动作与 read/follow/skip、通知并发 | 不新增消费/通知事实；fetch 文件成果不减少未读 |
| D20 | 系统目录无效编码、缺字段、custom 字符串 | 不把畸形当空；不把 emoji/custom 当数字；查询无写操作 |
| D21 | browse 平台历史后 search/fetch、定位补充回放 | 不写 received/dispatched；只补定位证据；引用重启可解释 |
| D22 | 授权/真实连接不可用/绑定身份变化 | 读取明确失败；local search 可独立读取；无跨账号成果 |

测试不止直接调用 handler：通过 World 注册、Broker schema 校验和真实下游工具组成调用链，覆盖停止、写盘失败与重启。使用隔离数据根，不操作真实用户数据。下载校验使用已知 fixture 字节与摘要，不以 API 回执代替文件实际可读证明。

真实平台验收只读：核验绑定身份，读取好友/群成员、群目录、系统表情、已明确选定的既有消息与资源。探测不发送消息、不处理申请、不改资料或管理群文件。资源下载属于只读平台操作，避免全量扫描和自动批量下载。群 reaction 与 send 的真实对端呈现需要另行明确的写入授权；没有授权就保留未验证边界。

## 14. 验证、交付与完成判断

实现时逐阶段跑有意义的 QQ 合同/decoder/生命周期/资源组合测试，然后执行 `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm verify:cli`。检查生成 schema 无漂移；所有模型可见 nextCall/template 用真实 schema 验证。无关失败单列模块归属，不删关键断言换取通过。

同步 `docs/current-runtime.md`、前序阅读通知设计的动作数量说明和 `docs/qq/qq-world-acceptance.md`。验收矩阵分别记录设计、实现、隔离测试、真实只读与真实写入证据；不能合并成一个含糊的“支持”。

最终完成须同时满足：五个读取动作可从单一 facade 调用；返回引用可被下一动作解析；fetch 的普通文件被实际下游读取；search 的本地范围明确；已有消费/通知行为无回归；失败、停止与重启边界获得证据。真实服务不可用时可交付实现与自动验证，但明确列出平台未验证类型，不能声称真实 QQ 能力全部完成。

过去被错误封存/跳过的正文不自动批量恢复。本设计不修改既有书签，不借新增查询重新定义已读成果。

## 15. 最小实现落地记录（2026-10-11）

后续授权的最小实现方案收紧了本稿可选部分：不实现下载缓存或已保存副本复用，不增加共享目录映射配置，平台路径无法直接拉取时明确不可用。平台目录若给出尚无已验证适配的续页信号，返回 directory_incomplete，不猜分页协议。完整性成果目前只有 transport_checked/local_digest_only，不声称 platform_verified；未核实的摘要算法不猜测。下载沿用现有 connection.requestTimeoutMs，文件与 origin.json 通过同根临时目录一起发布，正式文件无自动 TTL。

S0～S4 的参数接线、载荷校验、定位回放和资源发布已实现，S5 的 schema/Broker/普通文件消费者组合测试已落地。新增正式测试为 `tests/qq-world-discovery.test.ts`，覆盖 D01～D22 场景，包含实际本地 HTTP 流、read_file/read_image、停止、重启、并行下载及写盘失败；不代表真实 QQ 服务已验收。系统表情原测试保留数字编码/续页断言，另增加非法 emoji 编码明确失败。

完整验证与无关失败归属以 [QQ World 验收](../../qq/qq-world-acceptance.md) 的“发现能力扩展”记录为准。真实只读连接探测结果 connectionAvailable=false，没有发送消息、处理申请或写真实数据。类型/构建门禁不能替代平台人物、目录、文件、语音与表情回执验证。
