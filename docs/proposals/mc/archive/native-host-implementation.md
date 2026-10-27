# 批 6：正式原生主脑入口与可靠交付

日期：2026-10-25。基线 `codex/phase0-baseline` / `9ac9cbd`，开工工作树干净。本批沿现有 checkout 实施；本批提交包含下述源码、回归与文档，未推送。

## 交付与边界

正式 `minecraft({action,params})` 已接通现有 **10 查询 + 15 动作**，未增加玩法数量。沿同一受管 Companion/双 Job/IPC 装配，不引入第二个 Agent、调度器或同进程游戏工具。

- Runtime schema **v3**：SQLite Worker 保存不可变 Run/Segment/Call/Effect/stop/completion 截面。对象引用读取最新已提交记录，record/completionRef 读取原件；晚到效果不改旧 completion。终结记录、报告与 pending 处置在同一事务提交，失败不发布假完成。
- 完整记录统一异步读取；普通报告 16 KiB 展示预算，显式记录 256 KiB inline 预算，超限由存储 Worker 导出有 sha256/bytes 的完整 JSON。损坏缓存从原件重建；不在游戏主线程同步导出。
- Executor ledger **v2**：保存请求原件及交付尝试；显式 retry 复用原键，恢复只查证、不重发动作。工具等待取消与 Run 停止分离。
- 工具短窗口 3 秒。短直返和后台输入读取同一固定报告；只有来源绑定的真实 Host committed receipt 才 ACK Runtime。后台只有一个活动输入，事件加速对账、5 秒兜底；材料读取失败仍可交付真实 header。
- WorldDef 为无参、无副作用工厂，manifest 指向 `worlddef/index.ts`；产物 manifest 指向对应 `.js`。默认关闭，使用安装目录 `config.json`；仅交付 offline Java 1.21.11，binding 可明确为 null。Host 注入数据根和 durable delivery，缺依赖/资产启动失败。
- BodyEndpoint 复用 Owner 门及域外退役；急停等待持久门和控制停止，恢复核对 attachment/revision；interrupt/失焦不停止独立 Run。生命周期 abort 与 onStop 汇合同一关闭过程。
- 六个 action 形状保留；code、程序名、Library、continue、replace_pending/preempt_current 明确不可用。Program、文件复用、世界等待/决策、自保及 Microsoft 认证属于后续批次。

## 使用

将 `config.example.json` 复制为安装目录的 `config.json` 并填操作者实际配置，再通过现有 `world_store` 启用 `minecraft`。真实配置被 Git 忽略；构建只复制示例和生成的 manifest，不复制配置、认证或运行数据。

工程验收入口：

```text
pnpm dev:mc:native
node dist/.uina/worlds/minecraft/dev/native-host.js
pnpm dev:mc:model
```

前两个以受控 Provider 驱动真实 Host/WorldTool/Paper；第三个使用现有 Provider 配置，不自动切换模型或修改认证。均分配独立 Temp 数据根与 journal v4 会话。场景准备的管理员命令与被测的正常采集/生产分开；命令发送不算生效，准备后查询实际方块。

## 当前验证

- `pnpm typecheck`：604 文件格式检查、9 条边界和 TS 通过；`pnpm build` 与源/产物 World 发现、无副作用默认工厂检查通过；`git diff --check` 通过。
- MC 专项：显式测试文件列表、vmThreads，**36 文件 / 273 项通过**。旧 mutable engine record 测试已替换为真实 SQLite 不可变引用测试。
- Host/World 回归：默认池 **7 文件 / 38 项通过**，包含真实 Host 关闭重开、工具渠道 canonical ACK、direct 工具报告经 input 补交，Run 数量保持不变。
- 真实 SQLite：终结事务故障、重开结算而不重放、pending/committed ACK、旧 effect 引用保持 unknown 而新引用为 met、30 KiB inline/300 KiB 文件、损坏导出重建均通过。
- 真实 Paper 1.21.11 build132 / Java21 / Windows11 x64 / Node24：源码最终 **9/9**，产物最终 **9/9**。覆盖正式入口、发现、采集/制作、缺料失败、后台 canonical 交付、固定记录、request 停止、具身急停/恢复、工具等待取消和关闭。
- 真实模型首次校准：`deepseek/deepseek-flash` 完成原木→8 块木板；核对缺料后采集并制作木镐，库存为木板5/木镐1/木棍6；导航 accepted 后显式 stop，固定记录为 cancelled。没有用服务器指令完成被测目标。

本轮真实模型 Provider 回报：49 次请求、41 次工具结果；未缓存 prompt 33,900、cacheRead 944,768、output 4,197、totalTokens 982,865。计数包含场景准备所产生的完成通知与模型读取；未推算货币费用。不是最小调用次数或长期性能结论。

原始证据（本机 Temp，不加入 Git）：

- 源码最终：`C:/Users/34150/AppData/Local/Temp/uina-mc-native-TbEBBH/report.json`。
- 产物最终：`C:/Users/34150/AppData/Local/Temp/uina-mc-native-4QbyAB/report.json`。
- 真实模型：`C:/Users/34150/AppData/Local/Temp/uina-mc-model-osPd5C/report.json`。
- 当前命令日志：`dev/mc-batch6-*.log`；该目录原本被 Git 忽略。

## 校准修正与剩余事项

- 精确 status 原来返回连接缓存，可能一直显示 connecting；现查执行侧，心跳刷新具身状态。
- 只读查询的确定拒绝原来被误标 unknown，现为 failed；unknown 保留给受理或外部效果未确认。
- 家族目录翻页允许只传 cursor，避免模型按返回游标继续读取时缺 query 被拒。
- 独立审查的两项 Important 均已由失败回归复现、修复并通过最终专项：旧输入退役时返回 committed 不再重设旧 active 占位；IPC 确定 not_sent 的提交保持 not_accepted/failed 或 not_started，不误报 unknown。没有 Critical 或遗留 Minor。
- 审查未扩入 Program/Library/decision/其他调度、自保、Microsoft/其他版本及未改动 Core/Host/Session；这些保持原有后续批次归属。真实游戏与模型证据由本轮主任务取得，不以审查的局部复现替代。
- 源码与产物的最终 9/9 在两项审查修复后重跑。首次真实模型校准后对确定拒绝与目录翻页的修正由定点回归验证，没有重复运行模型来增加调用成本。

本轮启动的 Paper 已通过控制台 stop 正常退出（exit 0），25565 已无监听。

范围外且未验证：QuickJS/Program、Library、完整 I2、默认自保、高级玩法、Microsoft、其他协议版本、Windows10/ARM 与长期负载。下一批为批 7 Program 执行闭环，不重做已验收原生链路。


## 提交前常规审查

本轮复核原两项修复有效，并新增修复两项有实际复现的 Important：

- Host 已 committed 后先释放本地活动输入占位，再幂等 ACK Runtime。Runtime 已提交但 IPC 回包丢失时，旧 key 不再永久阻塞后续通知；新增失败回归后通过。
- 接入区分 IPC 传输事实与可信领域拒绝：执行侧在受理前明确给出 `failure.dispatch=not_sent` 时保留 not_accepted。真实受管 Companion/IPC 在父侧缓存尚未刷新、执行侧 gate 已关闭的场景下验证无 Runtime 受理；源码回归先失败后通过，最终产物也直接核验通过。

提交前检查：`pnpm typecheck`、`pnpm build`、MC 显式 vmThreads **36 文件/275 项**、Host/World 默认池 **7 文件/38 项**及 `git diff --check` 通过。没有未处理的阻断项。本次未修改游戏算法，未重复运行上一开发轮的真服/模型场景；上文 9/9 与首次模型校准保持各自原始证据边界。
