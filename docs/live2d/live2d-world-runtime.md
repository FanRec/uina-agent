# Live2D World 当前运行合同

2026-10-14。实现位于 `.uina/worlds/live2d`，身体策略不进入 Subject/Core。

本轮实现合同见“Action 作者层与播放时钟”。自动测试使用合成作者、假 VTS 与真实 Worker 隔离夹具；不能证明真实 MO/VTS 观感或调度阈值已经校准。完整 Live2D 定向结果以本次开发记录为准，不把本文的历史测试数字当作当前验收。

## 工具与意图

模型看到一个 `live2d({action, params})`，六种 action：

| action | 参数 | 结算 |
| --- | --- | --- |
| express | motion、atomic?、speech? | 等待命名动作与外部清理；输入接受不等于画面确认 |
| state | posture?、expression?、attention?、ambient?、hold_ms? | 持续意图；没传的字段保持，ambient=null 清除 |
| costume | item | 等待热键请求接受；不能推断实际外观状态 |
| prepare_body | 无 | 按当前模型创建或复用三个 Uina VTS 自定义输入，返回手动映射步骤；不改写 `.vtube.json` |
| status | detail? | 默认目录与状态；detail 返回生命周期、近期 cue、外部结算及引擎诊断 |
| reload | 无 | 显式重载并核验绑定 |

执行仍为 parallel，通道与外部资源由 director 仲裁。state 先校验整组参数，再按姿态、表情、视线、环境顺序施加。等待中被取代、取消或目录更换后不再施加余项，返回已接受的部分事实；不回滚持续意图。hold_ms=0 或省略持续保持，正数在过渡到位后计时，暂停或失焦冻结剩余时间。

cue 只命中动作与姿态，通过 runtime 的同一执行路径准入与结算；endpoint 只提供能力查询与异步账本。拒绝不记 started；异常必落账；旧回调只更新自己的记录。伴随 cue 仍由 embodiment/voice 拥有输出时序，World 不读取它们的内部状态。

MO 的 `head.yaw/pitch/roll` 与 `torso.yaw/pitch/roll` 是独立逻辑轴。没有显式躯干轨迹时，躯干目标跟随头部合成结果；`torso.*` 的绝对轨迹可单独接管，`baseline-offset` 轨迹则叠加在头部跟随目标上。头部旧动作因此仍能自然带动身体。该 rig 不声明手臂逻辑轴，也不通过移动整个模型制造上下弹跳。

首次接入 MO 时调用 `prepare_body`。它按模型 ID 生成稳定隔离的三个 VTS 输入名并幂等创建，随后由操作者在 VTube Studio 的模型参数设置中按工具结果分别映射到 rig 声明的身体输出。映射仍由 VTS 管理；Uina 不编辑模型保存配置。完成映射后执行 `reload`，再查 `status(detail=true)` 的 `bodyMapping`：每个轴会报告输入缺失、输入范围不符、未映射、映射到错误输出、映射歧义或 ready。躯干未 ready 时，头部和眼睛通道仍可用。

## 固定模型目录

目录只保存动作工厂、静态姿态/表情、别名和其它模型专属能力，不缓存编译动作。`compileCatalog` 隔离作者输入并以固定 seed 校验结构、轴、曲线和空间载荷，校验性 Bake 的结果会丢弃；Runtime 每次播放按动作名、播放序号与用途派生随机流并重新 Bake。目录索引私有，消费者通过 `resolve/list/resolveCue` 获取冻结记录；内置注视词表与别名同源，名称全局唯一。

本轮按用户要求清空 MO 的旧动作内容，没有搬运动作、环境片段或 idle/thinking 曲线。当前 MO `motion` 与 `ambient` 列表为空，`background.idle/thinking` 未设置；原 `rest/tuck/head_back` 姿态与 `smile/smirk/clear_face` 表情、rig 标定和内置注视保留。`express` 对动作返回目录为空/未知动作，`state.ambient` 不会回退到旧目录。目录换代仍递增代次并使旧执行失效。

## Action 作者层与播放时钟

作者合同详见 `.uina/worlds/live2d/MOTION-AUTHORING.md`。动作工厂产出 `ActionPlan { timeline, channels, spatial?, speed? }`；`timeline` 提供命名 marker 和正时长 span。`keys`、`poseWindow`、`spring`、`oscillate` 构造局部曲线；`during`、`track` 放置到动作时间；`absolute`、`offset`、`sumOffsets`、`mergeChannels` 明确通道空间与同轴规则。`compileAction` 校验并冻结身体通道、空间事件与 speed；独立编译缺省使用固定 0.5 随机流。

Runtime 分开派生 selection、performance、autonomic 随机流。每次播放只 Bake 一次，身体和空间共享同一 `CompiledAction`。Director 负责身体仲裁与采样，ExternalActions 负责 VTS 请求、独占声明和清理；预检完成后两者以同一 Director 有效时钟确定共同 `t0`。`speed` 只做一次时间换算，暂停或失焦冻结有效时钟。

自然完成的退场起点是作者动作的标称 wall end，长帧会计入终点后的淡出进度；release/preempt 从调用时的有效播放年龄开始。handoff 输出与 handle 结算共用退场进度，物理滤波仍按受限的帧间 `dt` 前进。

空间 marker 按绝对动作时间稳定排序；纯效果 marker 到时即可发送。含位姿 span 的事件先检查至少 100ms 的位姿窗口，再发同段效果并等待 ACK，ACK 后再检查窗口并移动。ACK 等待继续消耗窗口，不重置时钟、不重发未知请求。位姿窗口不足时取消动作并清理，原因 `spatial_window_missed`；100ms 是待真实 VTS 校准的内部起始值。正常播放等待完整 ActionPlan 身体结束后再恢复基线，效果保留到下一个对应效果事件或动作结束。取消、失败和错过窗口立即清理。

含位姿 span 的事件在附着效果 ACK 后再次核对窗口和同一模型位姿，再发送变换。相对旋转只在作者空间事件边界及归位前核对位姿，不逐帧读取 VTS。若同一模型在动作期间被手动移动，后续空间请求中止，不向它写回进入时的旧位姿，位姿清理记为 `unknown`；仍安全时恢复本动作拥有的效果。空间追踪描述作者请求 dispatch/ACK 与调度迟到，清理请求和 ACK 由最终分项 settlement 说明。资源所有权、模型/目录/连接代次核验及结构化终态仍归 ExternalActions。

开发诊断可分别读取作者目标、最终合成帧、来源贡献与 clamp hit；诊断仅通过本地预览选项开启，不进入模型可见工具结果。

## 外部动作与恢复

含空间事件的目录动作由 external-actions 拥有 VTS 位姿/效果与外观热键的执行、资源、取消和结算。空间动作独占 model:transform，带效果同时独占 effect:*，与外观请求互斥；清理等待期间不释放资源，未知结算后释放，不永久持锁。当前 MO 没有空间动作条目。

空间事件按 `atMs` 等待；含位姿 span 的事件先检查窗口，再派发效果并等待 ACK，ACK 后重查窗口，再按 span 绝对终点执行移动。纯效果 marker 不受位姿窗口门槛限制。ACK 返回不改变共同动作时钟。效果分发失败记录后继续剩余计划和身体播放，但最终状态为 unknown；位姿失败或时间窗错过会取消后续事件并立即清理。无错误的正常路径等身体 ActionPlan 结束后才恢复效果和位姿。位姿组合越界和已知缺失 preset 在发送前拒绝。

含后处理的动作必须先读取有效基线；缺失或错误开关字段、读取失败都得到 failed / effectStatus=not_started / reason=effect_baseline_unavailable。只有 tint 时不读取或修改 post。没有非零空间偏移的纯效果动作不移动或恢复模型位置。

pose、tint、post 各自记录发送尝试，只恢复自己修改过的项。恢复前后核验模型、连接、目录代次；失效后不向新环境写旧基线，义务结算为 unknown。位姿回读核实；tint 刷白只能证明请求接受；post 恢复进入前开关与具名 preset，不保证所有滤镜值逐项保真。

details.cleanup 逐项为 not_needed / confirmed / unknown。restored/restoredEffects 从这些事实派生：true 表示清理义务已完成或无需清理，不是画面确认。热键单独记录 accepted / unknown；接受不能证明外观可见。

safeStop 暂停合成、保持中性口型注入，取消动作与持续状态的等待，但保留持续意图供 resume 继续；等待外部请求与分项清理。任何必要项未确认或预算耗尽均抛错。resume 允许继续并确认已知未确认屏障，不自动重发或重试恢复；最近未知诊断保留，在途请求仍持锁。

**合成故障停车**：动作曲线的病态分支若逃过 bake 探测网格，运行期采样异常由 composeTick 捕获——fault 登记、时钟停止、口型中性单帧注入、全部播放结算 cancelled，后续工具调用以 `fault` 拒绝。此设计保证在途 spatial 清理（归位/染色复位）不受影响；恢复 = 重载 world（生产每激活创建新实例），不设自动恢复。

## 生命周期与线程

生产在独立 Worker 运行时钟与 VTS 通信，进程内与 Worker 通过共同 assembly 装配。一个实例只拥有一次激活生命周期；重新激活创建新实例。启动失败回滚已安装资源，停止在 finally 语义下释放全部资源并聚合错误。

proxy/engine 使用 new、starting、running、closing、dead。停止与 Worker error/exit 共用收尾，撤销端点、电平、Host 订阅、取消监听和能力缓存；保留的 facade 引用也离线。迟到消息不能复活登记，终止后不 fire。登记期的焦点控制允许在 start 应答前投递。

预取消工具调用不投递。运行取消只转发 abort，等待实际结构化结算；World scope 先取消并等工具，随后 onStop。停止等待 runtime 清理后回收线程，错误跨线程保留嵌套原因与清理信息。已有清理预算耗尽时剩余调用如实 unknown，不新增无期限等待。

已投递具身调用遇到线程死亡为 unknown / engine_exited；死后新调用 not_started；读取失败不回传缓存成功。同步只更新状态与能力，不产生模型输入或唤醒对话。

## 验证边界

定向测试覆盖模型目录、工具/cue、身体跟随与躯干覆盖/恢复、VTS 输入准备与映射诊断、合成目录中的环境片段轮换、Action 时间线与随机隔离、实际合成与假 VTS 协议、外部恢复、MessageChannel、真实 Worker 自举及 WorldActivation 停用。真实 Worker 使用线程内创建的假设备，不读取或改写真实认证，不证明真实 VTS/MO、GPU 或视觉自然度。

执行命令：`pnpm exec vitest run tests/live2d-*.test.ts`、`pnpm check:boundaries`、`pnpm exec tsc --noEmit`、`pnpm typecheck`、`pnpm test`。Windows PowerShell 用 rg 枚举测试路径再展开参数。依赖已安装时，pnpm 11 可逐命令传 `--config.verify-deps-before-run=false`，避免共享依赖工作树的自动安装；不修改用户配置。

整仓格式基线、其他扩展失败和真实设备验收必须分别记录，不以定向通过冒充整仓或设备通过。

### 2026-10-14 Action 作者层重构

- 本轮移除旧 `MotionPlan`/`compileMotion` 作者 API、MO 动作备份文本与复制测试夹具；未迁移动作内容。MO 当前只有静态姿态/表情和 rig 标定，动作目录为空。
- 新作者面为 `ActionPlan`、Timeline、曲线组合器和 Bake 编译器；Director 与 ExternalActions 共用 CompiledAction 和有效时钟；Runtime 按动作名/播放序号隔离三类随机流。
- `mo:preview` 保留连续轮播，增加单次、固定次数重播、seed、离线任意时刻采样、真实空间请求追踪。离线预览不创建 VTS 客户端；真实模式沿 `express` 生产路径。
- 修复长 tick 退场进度、Bake 数值与 span 快照边界；空间位姿窗口在效果 ACK 前后检查，同模型漂移会保留用户位姿；正常动作等待身体结束后才恢复 effects/pose，清理前已确认回到基线时跳过重复移动。VTS 在途绝对插值的取消归位由单一进度轨迹判定，并用假 VTS 回归覆盖。
- 定向 Live2D：31 个文件、294 项通过。`pnpm typecheck`（格式、8 条边界、TypeScript）、独立 `pnpm check:boundaries` 与 `git diff --check` 通过。`mo:preview --list` 确认 MO 动作目录为空；离线合成目录采样由 `tests/live2d-preview.test.ts` 覆盖。
- 真实 VTS/MO 视觉观感、ACK 延迟分布与 100ms 位姿阈值仍未验收；自动化合同测试不替代设备验收。

### 2026-10-13 自动验证（原工作区集成后）

- 定向 Live2D：23 个文件、207 项通过，包括真实 Worker 假设备及 WorldActivation 链路。
- 8 条依赖检查及 TypeScript 独立检查通过；全部 48 个 Live2D TS/MJS 源码、测试及 fixture 的格式检查通过，git diff --check 通过。
- 原工作区整仓（包含同期已合入的 Voice/TTS 工作）：169 个文件通过、2 个文件失败；1998 项通过、1 项预期失败、2 项失败，共 2001 项。smoke 的旧断言对非 JSON 失败正文调用 JSON.parse，稳定失败；session-settings 等待“写盘 low”超时，独立复跑该文件 7 项全部通过，超时未稳定复现。两者所属源码与测试均不在本次修改范围，未为其调整实现或等待预算。UI 缓存测试在此原工作区通过。
- 整体 pnpm typecheck 在格式阶段失败：262 项诊断，本次 Live2D 范围格式通过。边界及 tsc 另行执行通过，不能据此报告完整 typecheck 通过。合入时遗留的本次范围 CRLF 已按既有 LF 属性校正，未产生 Git 内容差异，未改用户 Git 配置。
- 本轮未进行真实 VTS/MO 或视觉自然度验收。

原工作区日志保存在忽略目录 generated/live2d-refactor：current-live2d.log、current-boundaries.log、current-types.log、final-original-format.log、final-original-typecheck.log、final-original-tests.log、final-unrelated-retest.log。失败用例保留在整仓日志中；单独复跑结果不替代那次全量失败。

独立全分支审查提出两项重要验收缺口，均以 RED→GREEN 修复：效果 ACK 返回后重核执行代次，防止向新模型发送旧位姿；持续状态最后一次等待后重核代次/取消，不报告已失效的成功。
