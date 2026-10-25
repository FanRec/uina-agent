# MC Executor 平台底座实施记录

日期：2026-10-25。基线 `8b46337`，工作树 `codex/phase0-baseline`。保留开工前生产链修复及文档改动，不提交或迁移真实数据。

## 本批责任与进度

按 development-plan §10 批 4、modules/executor §3–§7 实施。交付 Windows 独占/退役、私有 IPC、正式执行侧装配，以及 Runtime Owner/受理/关闭所需修正。Host 回执、WorldDef、模型工具、Program/Library 不在本批。

- A：Windows native 与真实 OS 验证已实现，13 项 OS 测试通过。
- B：Runtime Owner、持久受理与关闭已实现，schema v2；Owner 真实 SQLite/Worker 回归 5 项通过。
- C：Companion/Executor 身份账本与装配已实现；开发 harness 复用执行侧装配。
- D：固定 IPC、心跳、关闭/退役与集成验收已完成；最终源码/产物真服各 8/8，MC 回归 33 文件/270 项通过。

## 接缝与裁决

- Native 只提供 OS 事实；Executor 持有两个 Job 和精确进程句柄。Companion 初始化前只握手。
- Runtime 唯一维护 Owner 门、受理与执行结论；Driver 使用同一 `assertActionAllowed`；停止不等待磁盘。
- `submit` 改为异步持久受理，直接消费者同批更新；不保留同步兼容入口。
- 裁决：沿用当前 checkout，用户已批准以其未提交修复为基线。新 worktree 不含这些依赖，反而会验证旧实现。
- 配置 `binding:null` 使用每 launch 独立的显式 unbound 分区，不根据服务器地址推断世界身份（World §4.2）。
- Runtime 库升级拒绝旧版、不自动迁移；所有验证用临时数据根。

## 验证

开工前：`pnpm typecheck` 与 MC 28 文件/236 项通过（本会话计划阶段）。

- Windows 11 10.0.26200 x64、Node 24.13.1、MinGW-w64。Native 13 项真实 OS 场景：目录/账号并发竞争，大小写/junction 别名，空 Job 复用，精确进程句柄，外部 Job 嵌套/不兼容层级，第二次关联失败清理，父强杀/子孙回收，异步退役。强杀夹具不加载 tsx 且使用 detached 子进程，排除 libuv 自有 Job 的回收干扰。
- 真实 Node 故障注入使用测试侧 preload，生产没有 testMode、假 World 或替代 bootstrap。实际阻塞 Companion 主线程后，父侧心跳故障并确认两个 Job 归零；2 MiB stdout 峰值被持续读取，诊断尾部不超过 64 KiB，IPC 保持响应。缺失 Node 可执行文件的异步 fork 错误正常拒绝启动，不成为父进程未捕获异常。
- Paper 1.21.11 build132、Java 21、offline UinaDev；专用 12000 高空平台。源码 `pnpm dev:mc:executor` 8/8；初版 dist 同一场景 8/8。场景覆盖连接/观察、chat、导航/持久查证、等待取消与显式 stop、真实 5 秒 Owner 过期、IPC 故障/新 attachment/CAS、急停跨故障保留，以及干净关闭重开不重放。最终修订后的产物结果在下文补记。
- 源码记录：`%TEMP%/uina-mc-executor-source.log`，数据根 `%TEMP%/uina-mc-executor-2HslpL`。首个源码运行因新区块未加载导致准备平台失败、角色坠落，不计入通过；已改为确认四角区块与实际平台石块后才开始被测动作。
- 构建要求关闭正在使用源码 native 的进程再重编译：Windows 不允许覆盖已加载的 `.node`。本轮一次并行构建因此失败，停止相应源码验收进程后正常构建通过；没有回退旧资产。

## 审查修复

独立整体验证审查指出四项问题，均以先复现失败、再修复通过的回归关闭：

1. 同一门正开盘提交时再次关闭：开门除 revision 外再核验 generation，旧开门不能跨越任何关门请求。
2. 并发手动/自动恢复：整个 launch 使用同一 Promise，跨 ledger await 只启动一个 Companion；关闭期间一并处理在途启动。
3. 执行侧失联时关闭 emergency：先发起本地持久意图，再尝试远端；远端不可用仍明确失败，不丢本地原因。
4. fork 未返回 PID 后的异步 error：保留子进程全生命周期 error 监听，启动失败正常回滚。

故障注入另外定位了心跳计时问题：父侧健康期限从建立 attachment 并启动心跳时算起，不把初始化耗时当作主线程失响应。测试要求实际阻塞标记已收到后才接受“看门狗成功”的结论。

上述修订后定点 3 文件/13 项通过。额外真服回归复现了“导航中关闭”错误地把中间 `stopping` 当失败并立即强杀的问题：父侧继续发送 shutdown，执行侧等待 Runtime.close 的真实控制屏障，再断连接、关 World。关闭宽限与域外强杀没有放宽。新连接尚未收到目标区块时的 UNREACHABLE 不混作关闭失败，场景先核验实际已加载平台。

## 最终收尾

- `pnpm typecheck`：587 文件格式检查无改写，9 条边界与 TypeScript 通过；`git diff --check`、MC 相对链接检查通过。
- MC 显式文件列表、vmThreads：**33 files / 270 tests PASS**，日志 `%TEMP%/uina-mc-batch4-tests-final.log`。其中 native 13、IPC 8、受管会话 5、Node 故障 3、Owner 5，既有生产链回归保留。
- `pnpm build`：通过；native、Companion 和三个 SQLite Worker（Runtime/World/Executor）全部进入 dist。日志 `%TEMP%/uina-mc-batch4-build-final.log`。
- 最终源码 `pnpm dev:mc:executor`：**8/8 PASS**，含导航中关闭；日志 `%TEMP%/uina-mc-executor-source-final.log`，数据根 `%TEMP%/uina-mc-executor-ZLWipA`。
- 最终产物 `node dist/.uina/worlds/minecraft/dev/executor.js`：同一场景 **8/8 PASS**；日志 `%TEMP%/uina-mc-executor-dist-final.log`，数据根 `%TEMP%/uina-mc-executor-w8USM0`。
- 本轮启动的 Paper 已经受管 chat@1 发送 `/stop` 后完成服务端实际保存/退出；Java 启动会话 exit 0，25565 无监听。世界及专项验收数据保留。
- 工作树归属 `codex/phase0-baseline`；实现完成后按用户要求，与既有生产链修复一起常规审查并提交，提交身份以 Git 历史为准。`src/` 内核零改动，不修改真实 Provider、认证或会话。

Host journal 仍为 v3；本批不提供可靠通知、BodyEndpoint 或完整 `minecraft({action,params})`。Windows10、ARM、Microsoft 认证、真实模型体验、长期负载与断电没有据本批证据宣称通过。下一任务是批 5 的 Host 通用持久回执，随后批 6 接正式主脑入口。

### 复现入口

`node scripts/build-mc-native.mjs` 构建源码 native；需要 PATH 中的 MinGW-w64 g++ 和当前 Node 的 node-gyp 缓存头/node.lib。可用 `MC_NATIVE_CXX`、`MC_NODE_HEADERS` 指定构建工具/缓存，不包含认证材料。关闭使用该 native 的执行进程后再重编译。

启动既有专用 Paper 后，运行 `pnpm dev:mc:executor`；构建后运行上面的 dist 入口。场景默认创建独立 Temp 数据根，可用 `MC_EXECUTOR_DATA_DIR` 显式指定全新开发目录。旧 Runtime schema 不迁移，错误的身份/丢失的已初始化库明确拒绝。
