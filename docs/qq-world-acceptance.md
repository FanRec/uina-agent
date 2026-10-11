# QQ World 重构验收记录

日期：2026-10-11，Asia/Shanghai / GMT+08:00。覆盖本次授权方案 A01～A17。单一 qq facade 与 inbox/read/skip/browse/send/interact/remind/requests/profile 九个领域动作保持不变。

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
