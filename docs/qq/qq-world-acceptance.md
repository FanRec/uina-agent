# QQ World 重构验收记录

日期：2026-10-11，Asia/Shanghai / GMT+08:00。原重构覆盖 A01～A17，保留原九个动作合同；后续授权的发现能力扩展新增 people/files/fetch/search/expressions，单一 qq facade 现有十四个领域动作。两轮验证分别记录如下。

## 修复与证据

以下“通过”均指当前工作树自动化验证。隔离平台、假时钟、假 Provider 不代表真实 QQ 服务验收。审查中的 F01～F17 已迁入正式 `tests/qq-world-regressions.test.ts`，保留关键行为断言并按在线 inbox 合同调整假传输。

| 审查项 | 实现结果 | 自动化证据 |
| --- | --- | --- |
| A01 | read/follow 共用窗口；按实际交付位置提交；>30 条或 >14,000 字符退让摘要 | F01/F14、四个压力边界、partial follow 接续、挂起后 read 降压恢复 |
| A02 | 持锁后重验 focus/push/暂停、生命周期和消费位；无正文返回 null | F02/F03/F04、停止时等待锁、World/Subject 空退役 |
| A03 | readerInitialized 一次初始化；已初始化新会话基线 0；重启不重新封存 | F06 完整 World 停止/重启；原消费基础测试 |
| A04 | 入站计数及首条提醒统一；out 历史保留 | F05、ordinary notification position excludes later own echo |
| A05 | 渲染失败保留候选；可取消的 2 秒重试 | F07、临时故障恢复；停止后无迟到写入 |
| A06 | 结算先释放占位；通知位置与事项补账幂等 | F08、settlement accounting retries idempotently；故障恢复后仅写一次 |
| A07 | 占位求值当前候选，跨会话直接互动在 QQ 纸条内置顶 | F10、World → Subject FIFO 忙时排队与 poke 升级 |
| A08 | 文本与事项/操作引用取自同一成果；成功结果缓存复用 | F15、enqueue 失败后的正文保留、真实 SessionStore appendInput 重试复用 |
| A09 | 暂停恢复统一使用消费位、基线与有效推送范围 | F16、消费基础与调度测试 |
| A10 | requests list 默认 20，透传 limit/cursor | F12 经真实 WorldTool schema 使用返回游标查询第 21 条 |
| A11 | 删除退役入口文案；输出真实 action/params 指引 | F13、读/浏览呈现测试；混合长消息两种预算下展开全部文本并保留图片引用 |
| A12 | read/skip 锁内重验取消；媒体完成后才提交 read | F09、read cancelled during media expansion、锁等待停止 |
| A13 | browse 三模式兑现 includeMedia；点查共用 local-first/get_msg | F17、local and platform history both expand media、contentTarget 既有测试 |
| A14 | QQ 不等待 Subject 空闲；短防抖完成即提交占位 | F11、World → Subject 忙时 FIFO 集成 |
| A15 | coverage gap 单独持久回放；按时间区间展示弱风险，archive 独立 | coverage intervals replay independently from archival；时区偏移重叠；传输生命周期相关测试 |
| A16 | 每次在线好友/群目录，合并本地会话并分页；摘要保留所有待处理引用/计数；显式平台历史 | online directory/pagination/count-change、目录/保存失败状态不变、platform around 无 received/dispatched、全局概览测试 |
| A17 | qq-status 只读、明确数据根、真实 unknown 数、focus unknown | 真实诊断进程执行前后文件字节相同，旧配置/坏尾行不变，缺失目录无创建 |

## 集成与验证门禁

`tests/qq-world-subject-integration.test.ts` 使用现有 WorldActivation、SubjectHarness、真实 Subject 与临时 JsonlSessionStore，覆盖忙时 FIFO、跨会话互动升级、read/skip 与排队 follow 交错、空退役、后续 follow 的实际正文落盘、前台回合打断及 canonical input 提交失败后复用相同成果。没有通过手写 dispatched 记录模拟 follow 成功。

```powershell
pnpm exec vitest run qq-world tool-validation-diagnostics --maxWorkers=2
pnpm typecheck
pnpm test --maxWorkers=2
pnpm build
pnpm verify:cli
```

本次验证：QQ 与 schema 诊断测试 403 项通过；全量 1,865 项通过，零失败；typecheck（335 个格式检查文件、8 条边界规则、TypeScript）、build、verify:cli 均通过。CLI 的四个编译产物场景包括成功工具、图片运输、会话回退和 Provider 截断明确失败。默认高并发曾遇到 Windows VirtualAlloc 内存分配失败，最终门禁使用默认 forks pool、maxWorkers=2。

## 真实平台与恢复边界

2026-10-11 通过 OneBotTransport 进行了只读连接探测，结果 connection available=false。服务不可用，真实身份、好友/群目录和平台历史未验证；没有发送消息、处理申请或写真实 World 数据。自动化结果不能推导真实 QQ 对端展示、申请效果、长期负载或模型理解质量。

已成功构造的正文支持进程内同输入重试。本地派发书签与 canonical SessionStore input 之间没有跨进程原子事务保证；进程在两者之间崩溃的恢复仍为未验证边界。外部 unknown 操作不自动重发。过去错误推进/封存的历史不自动回退或批量恢复。

## 修改归属与文档校正

改动限于 QQ World 非 vendor 源码与 schema、QQ 测试、诊断脚本和文档；Core、vendored SDK、真实配置和数据未修改。并行 embodiment/Live2D 工作由其原任务处理，本次未触碰。Git 提交仅包含本次 QQ 修改；忽略目录中的设计和审查原稿保留本地，当前运行事实与本验收记录随代码提交。未推送。

原报告所称 reader → scheduler → render → scheduler 运行时 import 环不成立：相关引用为 type-only，scheduler 没有运行时 import render。真实问题是消费查询职责位于 scheduler；现已移到 World 的 consumption.ts。设计矩阵 T01A/B、T04A/B、T07A/B 拆分后共 18 行，不能以场景编号或历史 P6 声明代替当前证据。

## 发现能力扩展（2026-10-11）

五个动作通过原 World schema、授权、传输、分页与消息点查接线。仅新增 discovery/resource-fetch 两个局部模块，不引入管理器、缓存、后台下载重试、租约或新 Core 接口。fetch 只读平台资源，search 只检索本地 text/fileName；系统表情不包含自定义贴纸。方案见 `docs/proposals/qq/qq-world-discovery-resource-design-2026-10-11.md`。

正式测试 `tests/qq-world-discovery.test.ts` 共 26 项，使用实际 World 注册、ToolBroker schema 校验、普通文件消费者及隔离传输，覆盖设计 D01～D22：

| 验收项 | 自动化证据 |
| --- | --- |
| D01～D03 | 单一 qq / 十四分支；重名保留全部引用；成员数组、未知字段、错误身份、畸形/空列表区分 |
| D04～D05 | 人物、文件、表情 nextCall 可直接续页；条件变化 invalid、数据变化 stale；无关到达/消费变化不影响列表 |
| D06～D08 | 文件/文件夹引用绑定账号与群、跨重启解析；目录不递归、不支持的上游续页明确失败；对象消失/同名替换不下载 |
| D09～D10 | 私聊 file_id/file_hash 保留并回放；过期 URL 最多刷新一次；平台远端路径没有映射时失败 |
| D11 | 实际本地 HTTP 字节流；长度不符、下载目录、来源元数据和附件定位写盘失败；无半发布资源 |
| D12～D13 | 查询等待/流式下载中 stop，无迟到定位或发布；并行副本不互删；正常重启保留文件与 mediaRef；只清理自有未发布目录 |
| D14～D15 | fetch → 实际 read_file/read_image；SILK 原始字节不转码/转写；现有 send 参数合法，显式禁止的出站根仍拒绝；测试没有发送 |
| D16～D18 | local 来源、字段、Unicode/大小写、方向/发送者/时间过滤；跨分段不假命中；撤回/归档与缺口分别呈现；命中集变化 stale |
| D19～D20 | 五读取动作不改控制文件、消费位或通知位；系统数字编码与模板合法，畸形/emoji/custom 不伪装为可用目录 |
| D21～D22 | 平台点查与转发只补定位，不生成 received/dispatched；附件引用重启不串号；授权与绑定身份独立检查，local search 不需在线连接 |

新增调用 fixture 共 8 个合法、7 个非法场景，原表情测试保留数字编码与完整续页断言并新增非法编码明确失败。附件展示同时保留 browse 展开与新增 fetch 入口，混合长消息原回归通过。文件成果只证明实际字节取得及声明的长度/本地摘要证据，不证明完整媒体解码或模型理解。

最终门禁：QQ 与 schema 诊断 24 个文件、444 项通过；全量 163 个文件、1,920 项通过、1 项预期失败；pnpm typecheck（339 个格式检查文件、8 条边界规则、TypeScript）、build、verify:cli 均通过。运行默认池并设 maxWorkers=2。期间并行 Live2D 在途修改曾引发临时类型/格式和 accept 场景失败，最终串行类型检查与全量重跑已通过，本任务未修其代码。QQ status 只读文件字节检查包含在专项回归中。

本轮再次通过 OneBotTransport 只读探测，connectionAvailable=false；未取得真实身份、人物、群文件、资源或表情平台证据。未发送消息、处理申请、修改真实配置或真实 World 数据。未修改 Core、vendored SDK、Pi 或 Live2D 在途文件；本轮 QQ 改动未提交、未推送。

## 发现实现审查与修复（2026-10-11）

情况分析、重构顺序与修复依据见 `docs/qq/qq-world-discovery-review-2026-10-11.md`。本轮保留前述未提交实现和原验收断言，新增十一项审查用例，发现能力测试共 37 项。最初六个反例在原实现上全部失败，修复后通过：覆盖旧 URL 回退、引用串对象、私聊缺 hash 的假兜底、身份校验顺序及真实时间比较。其余用例覆盖目录失败缓存污染、平台拒绝、超时刷新、Unicode 片段和流式 ENOSPC。

`platform-query.ts` 收拢既有查询边界；原 resource-fetch 内的 `publishDownload` 集中拥有完整文件与来源元数据发布；附件身份比较由定位与刷新复用。没有引入新 Core 接口、下载缓存、后台任务或租约。历史上已错误覆盖的附件引用和消费位不自动恢复。

本轮实际验证：

- QQ 与 world-tool-schema 专项 24 个文件、447 项通过，包括 status CLI 的只读文件字节断言。
- Live2D 新测试加入前，`pnpm typecheck` 通过；`pnpm build`、`pnpm verify:cli` 通过，CLI 四个场景仍包含 Provider 截断的明确失败。最终再次执行 typecheck 被新加入的 `tests/live2d-e2e-lifecycle.test.ts` 格式检查阻止，尚未进入该次命令的 TypeScript/边界阶段；最终独立执行 `pnpm exec tsc --noEmit` 与 `pnpm check:boundaries` 均通过。未修改该文件以绕过门禁。
- 第一次全量：163 个文件，1,929 项通过、2 项失败、1 项预期失败；两项失败归属未修改的 branch-inspector UI，进入分支后仍显示选择页。该文件单独复跑 20 项通过；第二次全量该文件也通过。未据此推定具体波动根因。
- 第二次全量：运行期间工作区新增 Live2D 生命周期测试，总数变为 164 个文件；1,932 项通过、2 项失败、1 项预期失败。失败为 `tests/live2d-e2e-lifecycle.test.ts` 的 safeStop 口型恢复及代次 cue finished 状态断言。该文件属于并行 Live2D 在途工作，本任务未修改。当前全量门禁没有通过，不能沿用前轮“全量通过”的记录宣称本轮全绿。

未执行真实平台查询或写操作；各类资源的真实平台证据仍未取得，此前连接不可用不作为当前连接状态结论。本任务保留其他修改，未提交、未推送。

## 提交记录（2026-10-11）

用户随后授权提交发现实现与审查修复。提交前重新运行 QQ 与 world-tool-schema 专项，24 个文件、447 项全部通过。本次提交仅包含 QQ World 源码/schema、发现测试及运行事实、验收和审查文档；其他 Live2D、embodiment 和 profile 在途改动不纳入。未推送；本次专项复跑不替代上文全量门禁和真实平台未验证边界。

## 当前工作区离线复核（2026-10-14）

本次逐篇审阅重新运行了仓库内 `tests/qq-world*.test.ts` 与 `tests/world-tool-schema.test.ts`：24 个文件、420 项通过。测试使用隔离目录与假传输；不连接真实 QQ，也不验证平台字段、资源交付或对端呈现。该结果只表示当前工作区这些离线断言通过，不覆盖整仓测试。历史各轮测试数字仍保留为各自运行快照。
