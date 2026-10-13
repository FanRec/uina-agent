# Live2D World 当前运行合同

2026-10-13。实现位于 `.uina/worlds/live2d`，身体策略不进入 Subject/Core。

## 工具与意图

模型看到一个 `live2d({action, params})`，五种 action：

| action | 参数 | 结算 |
| --- | --- | --- |
| express | motion、atomic?、speech? | 等待命名动作与外部清理；输入接受不等于画面确认 |
| state | posture?、expression?、attention?、ambient?、hold_ms? | 持续意图；没传的字段保持，ambient=null 清除 |
| costume | item | 等待热键请求接受；不能推断实际外观状态 |
| status | detail? | 默认目录与状态；detail 返回生命周期、近期 cue、外部结算及引擎诊断 |
| reload | 无 | 显式重载并核验绑定 |

执行仍为 parallel，通道与外部资源由 director 仲裁。state 先校验整组参数，再按姿态、表情、视线、环境顺序施加。等待中被取代、取消或目录更换后不再施加余项，返回已接受的部分事实；不回滚持续意图。hold_ms=0 或省略持续保持，正数在过渡到位后计时，暂停或失焦冻结剩余时间。

cue 只命中动作与姿态，通过 runtime 的同一执行路径准入与结算；endpoint 只提供能力查询与异步账本。拒绝不记 started；异常必落账；旧回调只更新自己的记录。伴随 cue 仍由 embodiment/voice 拥有输出时序，World 不读取它们的内部状态。

## 固定模型目录

compileCatalog 隔离作者输入，再校验、编译和冻结定义、变体、轨迹、效果、别名及槽位。索引私有，消费者通过 resolve/list/resolveCue 获得冻结记录，无公开 Map 或旧反查入口。内置注视和中文别名同源，所有名称全局唯一；动作变体不能独立寻址。

status、错误候选项和 affordance 使用同一快照。环境别名“摇摆／晃动／摇”都解析为 sway；持续环境选择保存规范名。目录更新递增代次并使旧执行失效；消费者与原作者对象都不能绕过代次修改内容。

## 外部动作与恢复

external-actions 拥有空间特技与外观热键的执行、资源、取消和结算。空间动作独占 model:transform，带效果同时独占 effect:*，与外观请求互斥；清理等待期间不释放资源，未知结算后释放，不永久持锁。

空间段先派发效果，再发移动；移动 ACK 后完整等待段时长。效果分发失败记录后继续，移动失败切断后续段。位姿组合越界和已知缺失 preset 在发送前拒绝。

含后处理的动作必须先读取有效基线；缺失或错误开关字段、读取失败都得到 failed / effectStatus=not_started / reason=effect_baseline_unavailable。只有 tint 时不读取或修改 post。没有非零空间偏移的纯效果动作不移动或恢复模型位置。

pose、tint、post 各自记录发送尝试，只恢复自己修改过的项。恢复前后核验模型、连接、目录代次；失效后不向新环境写旧基线，义务结算为 unknown。位姿回读核实；tint 刷白只能证明请求接受；post 恢复进入前开关与具名 preset，不保证所有滤镜值逐项保真。

details.cleanup 逐项为 not_needed / confirmed / unknown。restored/restoredEffects 从这些事实派生：true 表示清理义务已完成或无需清理，不是画面确认。热键单独记录 accepted / unknown；接受不能证明外观可见。

safeStop 暂停合成、保持中性口型注入，取消动作与持续状态的等待，但保留持续意图供 resume 继续；等待外部请求与分项清理。任何必要项未确认或预算耗尽均抛错。resume 允许继续并确认已知未确认屏障，不自动重发或重试恢复；最近未知诊断保留，在途请求仍持锁。

## 生命周期与线程

生产在独立 Worker 运行时钟与 VTS 通信，进程内与 Worker 通过共同 assembly 装配。一个实例只拥有一次激活生命周期；重新激活创建新实例。启动失败回滚已安装资源，停止在 finally 语义下释放全部资源并聚合错误。

proxy/engine 使用 new、starting、running、closing、dead。停止与 Worker error/exit 共用收尾，撤销端点、电平、Host 订阅、取消监听和能力缓存；保留的 facade 引用也离线。迟到消息不能复活登记，终止后不 fire。登记期的焦点控制允许在 start 应答前投递。

预取消工具调用不投递。运行取消只转发 abort，等待实际结构化结算；World scope 先取消并等工具，随后 onStop。停止等待 runtime 清理后回收线程，错误跨线程保留嵌套原因与清理信息。已有清理预算耗尽时剩余调用如实 unknown，不新增无期限等待。

已投递具身调用遇到线程死亡为 unknown / engine_exited；死后新调用 not_started；读取失败不回传缓存成功。同步只更新状态与能力，不产生模型输入或唤醒对话。

## 验证边界

定向测试覆盖模型目录、工具/cue、实际合成与假 VTS 协议、外部恢复、MessageChannel、真实 Worker 自举及 WorldActivation 停用。真实 Worker 使用线程内创建的假设备，不读取或改写真实认证，不证明真实 VTS/MO、GPU 或视觉自然度。

执行命令：`pnpm exec vitest run tests/live2d-*.test.ts`、`pnpm check:boundaries`、`pnpm exec tsc --noEmit`、`pnpm typecheck`、`pnpm test`。Windows PowerShell 用 rg 枚举测试路径再展开参数。依赖已安装时，pnpm 11 可逐命令传 `--config.verify-deps-before-run=false`，避免共享依赖工作树的自动安装；不修改用户配置。

整仓格式基线、其他扩展失败和真实设备验收必须分别记录，不以定向通过冒充整仓或设备通过。

### 2026-10-13 自动验证（原工作区集成后）

- 定向 Live2D：23 个文件、207 项通过，包括真实 Worker 假设备及 WorldActivation 链路。
- 8 条依赖检查及 TypeScript 独立检查通过；全部 48 个 Live2D TS/MJS 源码、测试及 fixture 的格式检查通过，git diff --check 通过。
- 原工作区整仓（包含同期已合入的 Voice/TTS 工作）：169 个文件通过、2 个文件失败；1998 项通过、1 项预期失败、2 项失败，共 2001 项。smoke 的旧断言对非 JSON 失败正文调用 JSON.parse，稳定失败；session-settings 等待“写盘 low”超时，独立复跑该文件 7 项全部通过，超时未稳定复现。两者所属源码与测试均不在本次修改范围，未为其调整实现或等待预算。UI 缓存测试在此原工作区通过。
- 整体 pnpm typecheck 在格式阶段失败：262 项诊断，本次 Live2D 范围格式通过。边界及 tsc 另行执行通过，不能据此报告完整 typecheck 通过。合入时遗留的本次范围 CRLF 已按既有 LF 属性校正，未产生 Git 内容差异，未改用户 Git 配置。
- 本轮未进行真实 VTS/MO 或视觉自然度验收。

原工作区日志保存在忽略目录 generated/live2d-refactor：current-live2d.log、current-boundaries.log、current-types.log、final-original-format.log、final-original-typecheck.log、final-original-tests.log、final-unrelated-retest.log。失败用例保留在整仓日志中；单独复跑结果不替代那次全量失败。

独立全分支审查提出两项重要验收缺口，均以 RED→GREEN 修复：效果 ACK 返回后重核执行代次，防止向新模型发送旧位姿；持续状态最后一次等待后重核代次/取消，不报告已失效的成功。
