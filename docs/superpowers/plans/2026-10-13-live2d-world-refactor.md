# Live2D World 完整重构计划

状态：2026-10-13 用户批准实施。基线：053fc3d；20 个 Live2D 测试文件、177 项通过。

2026-10-14 当前工作区复核：计划中的任务 1–6 在文首已有实施记录；下方任务框是原施工清单，不代表尚未实施。当前重新运行 `pnpm typecheck` 通过，`tests/live2d-mo-catalog.test.ts` 6 项通过；本轮未重跑完整 Live2D 套件或全量测试。MO 动作公式存在未提交工作区改动，目录测试不证明自然度；真实 VTS/MO 画面未验收。

2026-10-13 实施记录：任务 1–6 的源码、回归和文档已落地，分阶段中文提交并集成原工作区；未推送。独立审查的两项重要缺口已以失败回归修复。当前 Live2D 23 文件、207 项通过，48 个 TS/MJS 文件格式通过，边界及独立 tsc 通过；整仓测试仍有 2 项失败，完整 typecheck 被范围外格式诊断阻断。失败明细及真实 VTS/MO 待验收项见[运行合同](../../live2d-world-runtime.md)。上述代码交付不表示整仓门或真实设备验收已经完成。

## 目标与冻结约束

模型目录拥有不可变内容与名称解释；runtime 统一身体意图执行；外部动作拥有执行与清理事实；Worker adapter 拥有线程资源生命周期。
保留 express/state/costume/status/reload、参数形状、MO 动作内容、变体轮换、并发、单一 director、Worker 时钟及 BodyEndpoint/VoiceLevelSink。不得新增 Core 接口、通用事务/RPC/多模型框架。
含后处理的特技无法捕获基线时，发送副作用前 failed/not_started，reason=effect_baseline_unavailable；仅 tint 不读写 post。

## 任务 1：固化缺口

- 正式回归：源对象修改不改变快照；MO sway 别名可执行；身份不符的 cue 不启动；清理失败不能被 safeStop 漏报；Worker 退出后所有 facade 离线且注销。
- 先观察 RED，再实现对应任务；保留测试日志与实施裁决。

## 任务 2：固定目录

- 编译前隔离作者数据；校验与 compileMotion 后深冻结定义、变体、spatial/effects/playback、slots、attention、aliases、costumes。保留编译动作 WeakSet 身份。
- 私有名称索引；公开冻结记录和数组，无 Map 出口或旧接口兼容转发。
- CatalogKind=motion/posture/expression/attention/ambient/costume；CatalogResolved<K>={kind,name,aliases,entry}。
- CatalogSnapshot={modelID,background:{idle?,thinking?},resolve(kind,name),list(kind),resolveCue(name)}；resolveCue 仅 motion/posture。
- 内置注视与中文别名统一解析，全局唯一命名空间；变体不独立寻址。status/错误/affordance 同源。
- 迁移所有消费者与测试，验证作者与消费者都不能改快照，speech 覆写读固定定义。

## 任务 3：统一身体意图

- gate：取消 → 生命周期 → 暂停 → 连接 → 适配 → 参数/目录。
- state 一次捕获目录/代次，一次解析所有字段，按 posture→expression→attention→ambient 施加固定条目；等待后检查代次与取消。
- 非法参数零副作用；中途失败保留此前生效信息，不回滚持续意图；保留 hold/冻结/ambient 语义。
- 删除公开单槽旧方法与重复校验。executeCue(id,onStarted) 共用实际执行；准入拒绝不记 started。
- endpoint 仅能力查询与异步账本；无 director 执行分支，无未处理异步拒绝。
- 持续状态取消只结束等待，返回结构化 cancelled 与已施加事实。

## 任务 4：收口外部动作

- 新建 external-actions.ts；runSpatial/runCostume/cancelSpatial/cancelAll/settlePending/acknowledgeUnconfirmed/snapshot。
- 依赖仅 client/rig/director、目录代次/焦点读取、cleanupTimeoutMs。普通参数动作直接 director；共享注入确认在 results module。
- 空间表演一次申请 model:transform，带效果加 effect:* 与 costume 互斥。
- 捕获模型/连接/目录代次并核验活动身份，位姿组合与预设前瞻校验；后处理先捕获有效基线。
- 效果先派发、位姿随后；ACK 后完整等待；效果失败记录后继续，位姿失败中止。
- pose/tint/post 各自标记发送尝试，发送前记账；未碰的项不恢复。纯效果无非零 delta 时不移动模型。
- 每次恢复前后检查原代次，失效则不写旧基线且 unknown；位姿回读重试、tint 白色 ACK、post 基线开关/preset 核对。
- 清理 not_needed/confirmed/unknown；热键单独 accepted/unknown。safeStop 汇总全部义务；等待期持锁，未知结算后释放。
- 保留 restored/restoredEffects，由分项事实派生；新增 details.cleanup。必要清理 unknown 时普通完成 unknown；取消仍 cancelled 并明确未知。
- resume 显式允许继续、无自动重发/恢复，保留未知诊断；在途仍持锁。恢复只保证开关/preset，不全量保存滤镜值。
- director claim release 删除取消监听，不拆 director。

## 任务 5：线程与生命周期

- proxy/engine 生命周期 new/starting/running/closing/dead；幂等收尾覆盖 start rollback/stop/error/exit。
- EnginePort 支持 error/exit/off/await terminate，删除 onDead 旁路。结束撤销全部 facade/Host/取消监听，缓存离线并保存原因；忽略迟到 sync/exposed，终止后不 fire。
- 预取消零 call；运行取消只发 abort，等待 runtime 结构化结算。已投递具身调用死亡 unknown/engine_exited；死后新调用 not_started；读取失败不返回过期成功。
- engine 生命周期 controller 与调用 signal 组合；context abort 先拒绝新受理、取消并暂停，保留在途结果；onStop 等待 runtime.stop/结算后 terminate，传播清理失败。
- 保留现有请求/归位预算及默认 5000ms 清理预算，无新并发/容量/超时限制。
- typed operation contract 关联 op/args/result，mapped 分发表覆盖全部；错误保留可序列化原因与清理细节。
- runtime start 取消检查/局部回滚；stop 聚合错误而完成所有拆除，gate/online 包含生命周期。
- assembly.ts 默认装配两 adapter 同源；工厂安装 onStatusChange；instance 接受 Live2DWorldRuntime；生产每次激活新实例。
- MessageChannel + 真实 Worker 假设备 + WorldActivation 全链测试。测试 Worker 内创建 fake，无真实 VTS/auth。

## 任务 6：文档与验收

- 更新运行事实、规范、package 描述，标明旧 8 工具和 P1 说明被取代；CONTEXT 只补领域含义。
- Biome 纳入 Live2D TS/MJS；只格式本次范围，不全仓改写或修改用户 Git 设置。
- 全 Live2D、check:boundaries、tsc、pnpm typecheck、pnpm test；记录既有失败。审查格式基线 288 项不是成功。
- 真实设备验收单独：动作/讲话、空间归位、分别 tint/post、取消失焦、World 重启无重复端点；未经授权不触碰设备。
- 中文阶段提交，仅本范围，不推送；保护 TTS/voice 并行工作、Provider/会话/认证。

## Review Focus

- 源数据修改、消费者修改与 speech 重编译能否绕过固定快照。
- 组合 state 等待中换代/取消是否继续施加剩余旧条目。
- 部分恢复失败、换代或取消是否被 safeStop 汇总为成功。
- context abort 与 onStop 次序是否丢失归位结论或死锁。
- Worker 死亡、迟到 sync、重复 stop 是否泄漏登记/订阅或复活在线事实。
