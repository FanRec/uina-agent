# 批 7：Program 执行闭环实施记录

基线：`codex/phase0-baseline` / `58f1ba0`。使用现有 checkout；开工工作树干净。

## 范围与进度

- [x] A：共享合同、只读程序材料、编译与确切快照。
- [x] B：真实 QuickJS/Worker、JSON/错误桥、公平 pump、局部取消及容量。
- [x] C：Runtime 原生/程序统一调用、身体委托、窗口参照与关闭。
- [x] D：正式 IPC/工具/状态、schema v4、源码和产物验收。

顺序：材料 → 引擎 → Runtime/Driver → 正式装配；每项通过所属边界的真实检查再收口。
不实施 Library CRUD/统一发现、waitUntil、decide/continue/checkpoint、feedback/loop、自保和新增玩法。

## 决策

- 使用已批准的当前 checkout；不创建额外 worktree，不自动提交或推送。
- 最小只读文件解析归 Library，Program 只消费材料；正式文件管理仍在批 8。
- QuickJS 固定 0.32.0；Runtime schema v4，不自动迁移旧数据，Host journal 仍 v4。
- 源码路径中的 run ref 使用 URI 编码作为目录名，避免 Windows 的冒号限制；内容摘要仍对原始 UTF-8 字节计算，保留 BOM 和换行。

## 实际结构与复查

```text
WorldTool → Executor/Companion → Runtime（native | program）
                                 ├─既有能力 / World / Driver
                                 └─Program → 共享 Worker → 每 Call 独立 QuickJS runtime
                                      ├─Library 只读材料及共用头解析
                                      └─runs/<编码后的 run>/sources/<sha256>.js
```

复查后保留现有 Driver、Runtime 存储、进程监管和 Host 交付链，调整原生专用调用数据结构，而非重写运行底座。Program 不伪造原生 descriptor；程序完成范围为 execution。段内同名 singleflight，解析失败驱逐，后续段重读文件；每次程序调用记录确切来源、摘要、snapshot 和诊断。

Runtime 拥有真实 CallFrame、Body 委托与关闭顺序，Program 只搬运 JSON 和调用所有者登记的句柄。Driver.runScoped 绑定局部取消、可信 owner 和恢复前资格检查，不复制客户端或身体队列。窗口由调用方参照视图生成预期，只推进已确认槽位/光标；未知后态要求显式 snapshot。

引擎每轮最多一个 pending job 后回到 Worker 事件循环；sleep(0) 真实让出，睡眠/悬挂 Promise 不占整个线程。停止使用共享原子标记；销毁回执或线程退出后才释放 guest 名额。Worker 故障先封受影响 Call 准入，清理宿主资源，等待真实退出，替代 Worker 不重放程序。日志/进度覆盖合并，telemetry 有确认背压，结果等待末尾进度送达 Runtime。

### 实测改变的依赖处理

0.32.0 的 executePendingJobs 在调用 FFI 前保存 typed-array view，WASM 扩容后该 view 失效，随后创建未受管 context，退役可能触发 gc_obj_list 断言。仓库用 pnpm 补丁从当前 HEAPU8.buffer 重新取返回指针；补丁说明见 `patches/README.md`。不是改引擎语义或另做运行器。

该版本 Emscripten 对增长数组的 realloc 计账也不足，单设 setMemoryLimit 不能证明实际堆受限。实现同时在让出边界检查实际 managed heap；真实增长数组测试会局部 PROGRAM_MEMORY，原 Worker 随后仍可用。32 MiB 是引擎计账加让出边界检查的受管堆策略，单次计算期间可以超出，不能称为 OS RSS 的硬上限。未建立进程 RSS、长期满载或高频反馈性能承诺。

### 独立审查收口

四项 Important 均先用失败回归复现，再修复：

1. 非委托子调用申请祖先持有的身体：派发前 BODY_SCOPE_ACTIVE，不再永久排队；原生已有 CONTROL_CONFLICT 用例保留。
2. 普通关窗因光标非空被拒：成功关闭前保留 guest 句柄，可以用原句柄放回物品。
3. 父窗口临时 BODY_SUSPENDED：继续接收服务端观察，公开操作仍拒绝；委托结束后可复查，真实 replacement/end 仍退役。
4. 子范围 drive.use.once：成功或后续失败都清理所属使用，祖先身体保持有效；清理事实保留实际 owner，不误清其他调用的使用。

另外由回归覆盖实际 Worker 退出后的 PROGRAM_CRASH 与替换、不把退役封门误记为用户取消、JSON 的 __proto__ 字段、出站值超限、BOM 字节保真及非法名称不能绕过段缓存。

## 验证

本轮环境：Windows 11 x64、Node 24.13.1、pnpm 11.5.2、Java 21.0.9、Paper 1.21.11 build132、offline UinaDev。没有改动 Core、真实 Provider 配置/认证/会话或 Pi，没有重置游戏世界；游戏准备只作用于既有 16000 附近专用平台。全部 Uina 验收使用独立 Temp 数据根。

| 命令/边界 | 本轮结果 |
|---|---|
| `pnpm typecheck`（格式、9 条边界、TS） | PASS |
| 显式 `tests/mc/*.test.ts`，`--pool=vmThreads` | **38 文件 / 290 项 PASS** |
| 默认池 delivery-host/process/session/subject、mc-native-host | **5 文件 / 27 项 PASS** |
| `pnpm build`（native、TS、资源） | PASS；Windows native 模块被测试进程加载时不能并行覆盖，最终串行构建通过 |
| `pnpm dev:mc:program`，真实 Host/WorldTool/Executor/QuickJS/Paper | **8/8 PASS** |
| `node dist/.uina/worlds/minecraft/dev/program.js`，正式构建入口 | **8/8 PASS** |
| `pnpm dev:mc:program -- --model`，真实 deepseek-flash | **4 个检查点 PASS**；实际 JS 缺料纠错→2 原木→8 木板，显式停止等待程序并查询记录 |

MC 确定性测试使用真实 QuickJS、Node Worker、临时文件和 SQLite；难以稳定制造的 Driver 包/窗口竞争使用窄协议输入。它们不替代真服证据。游戏场景中的 op 只准备平台/树/箱子；被测采集、制作、窗口点击和停止全部走正式端口。真实模型只获短指南与任务，无管理员补料。模型 report 的 modelRequests 计数器只接受控 stream，不用于推断真实模型请求次数。

最终日志和保留数据：

- MC：`C:/Users/34150/AppData/Local/Temp/uina-mc-program-regression-final.log`。
- Host：`C:/Users/34150/AppData/Local/Temp/uina-mc-program-host.log`。
- build：`C:/Users/34150/AppData/Local/Temp/uina-mc-program-build-final.log`。
- source：`C:/Users/34150/AppData/Local/Temp/uina-mc-program-source-final.log`；数据 `uina-mc-native-5s4EUq`。
- dist：`C:/Users/34150/AppData/Local/Temp/uina-mc-program-dist-final.log`；数据 `uina-mc-native-ZLo9Zq`。
- model：`C:/Users/34150/AppData/Local/Temp/uina-mc-program-model.log`；数据 `uina-mc-model-VVvl0o`。

收尾：本轮启动的 Paper 通过游戏内 `/stop` 正常退出，启动会话 exit 0，25565 无监听；游戏世界、日志和独立验收数据保留。工作留在上述分支的未提交工作树，未推送。

## 后续边界

下一批为 Library 保存/读取/修改/发现复用，再做等待/决策与完整 I2。当前仍是 25/51 项游戏能力；本批不改变玩法数量。未验收 Microsoft 认证、其他 Minecraft 版本、非 Windows x64、多 Worker 调度、长期负载或完整反馈路径。

## 2026-10-25 常规审查与提交前复验

对 `58f1ba0` 以来的完整批 7 改动做只读独立审查，并修复三项已由失败回归复现的问题：同步 main 抛错遗漏末尾 progress/console；input 与 progress 缺少 1 MiB JSON 边界检查；Ajv 自动注册程序 schema 的 `$id` 导致重复解析及修改后运行冲突。头解析器与 Runtime 校验器均关闭自动全局注册，仍保留原有 schema 校验和按 digest 缓存。

提交前：`pnpm typecheck`、MC **38 文件/293 项**、默认池 Host 相关 **5 文件/27 项**、`pnpm build` 全部通过。实际构建产物的 Worker/QuickJS/SQLite 专项入口再次验证同步错误末尾材料、超限 input/progress 和同 `$id` 不同源码两次运行，全部通过；临时数据 `C:/Users/34150/AppData/Local/Temp/uina-program-review-dist-sB84ZB`。命令日志为 Temp 下的 `uina-mc-program-review-tests.log`、`uina-mc-program-review-host.log`、`uina-mc-program-review-build.log`，产物验证脚本为 `uina-mc-program-review-dist.mjs`。

本次修改不涉及游戏协议，未重新启动真服或调用真实模型；前节真服/模型结果保持对应证据边界。批 7 及上述审查修复由本次提交收口，不推送。`dev/` 按仓库既有规则忽略，本地事实/经验笔记保留但不强制纳入 Git。
