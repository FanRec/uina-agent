# 控制权资格与 Effect 写前意图（2026-11-09）

本文件只记录这一批的做法与证据，不维护现状。当前合同见 [../public-api.md](../public-api.md) 与 [../modules/](../modules/)，当前缺陷见 [../known-gaps.md](../known-gaps.md)。

## 1. 基线与依据

- 分支 `mc/world-refactor`，开工 HEAD `ef6293e1`；附件 `E:/Uina/设计包/Uina-Minecraft-World-Refactor-V3.1-2026-11-09.md`（1838 行，S0–S5、F01–F20、C01–C25、T0–T3）。
- 附件基于公开旧基线 `d0c4e0f`，本地已领先多个批次。S0 只读核对判定：Runtime 持久受理、`requestId` 幂等、stopIntent、CompletionReport、Effect 账本、BodyQueue 同步占槽、授予前复验、close-before-release、批37 的 `state-frame` 注入、批41 的纯异步受理**都已存在**，按附件 §17 记为 `PASS existing`，本批不重复实现。
- 工作区原有的未提交改动（`.github/workflows/ci.yml`、`tests/tts-bridge-protocol.test.ts`、`vitest.config.ts` 等）原样保留，未 reset、未覆盖、未卷入提交。

## 2. 改造一：控制权资格改为单一许可

**证据**：`driver/control-arbiter.ts` 原为 `bodyClaimed` / `gotoClaimed` 两个裸布尔槽。`driver/body/player-port.ts` 的 `onClosed` 无条件调用 `releaseBody()`；旧会话迟到的 close 因此能抹掉新 owner 的资格槽，使 `tryClaimGoto()` 返回 true，Pathfinder 与新 Body 并行控制同一 Bot（对应 C09）。

**做法**：`DriverControlArbiter` 改为单 `active: ControlPermit | null`，每次授予绑定 `{id, kind}`，`release(permit)` 只在对象同一时生效；旧 API `tryClaimBody` / `releaseBody` / `tryClaimGoto` / `releaseGoto` / `isGotoActive` 全部删除。生产消费点 `driver/body/player-port.ts`、`driver/goto.ts` 迁移到 `claim/release`。

**红测试先行**：`tests/mc/mc-control-permit.test.ts` 初版用旧 API 复现，实测 `AssertionError: expected true to be false`（旧 `releaseBody()` 后 `tryClaimGoto()` 返回 true），改生产代码后才转绿。

## 3. 改造二：Effect 写前意图与真实持久屏障（**部分实现**）

`DriverExecutionSink` 增加 `ensureDurable(ticket)`；`RecordQueue.ensureDurable()` 走 `flushThrough(ticket)`，等 DB worker 的 `onDurable` 回报，不把"已入队"当"已持久"。`runtime-db-worker.ts:731-735` 的 `apply` 分支确实对每个批次回报 `durable`，`runtime/index.ts:225-229` 把它转给 `queue.onDurable`，所以生产路径的屏障不会挂死。组合根 `companion/side.ts`、`driver/body/session.ts` 的 scoped/root recorder 都把屏障转发到真实队列。

`EffectRecorder.beforeWrite()` 先落 `kind:"intent"` / `dispatch:"unknown"` / `completion:"unknown"`，等 ACK 后才放行派发。`driver/window/session.ts` 的 `click()` 把屏障放在冻结窗口前态**之前**：否则 ACK 等待期间到达的同步包会让 `expectedRevision` / `before` / `stateId` 与真正派发时的窗口状态错开（§7.7）；屏障之后到 `wire.click` 全部同步。

**本批修掉的语义漏洞**（不是测试时序问题）：

- ACK 丢失时不能报 `not_sent`：intent 可能已经落盘，宣称"确定没发"会让调用方重放一次扣料类点击。`beforeWrite` 现在抛 `dispatch:"unknown"` 的 `CallFailure`；只有 recorder 已故障或 sink 明确拒收 intent 才允许判 `not_sent`。
- intent 已落盘但这一步明确决定不派发（撤销 / 版本冲突 / 输入非法）时，追加终态 `cleanup(not_sent, not_met)`，恢复侧才知道"只剩 intent"是明确取消而不是崩溃窗口。
- `RecordQueue.unknownEffectsFor()` 与 `effectsForSafety()` 原先只看 `completion !== "met"`，会把终态明确"没发包"的效果报成未知效果，让模型误以为可能发生过扣料。现在终态 `dispatch === "not_sent"` 的效果不计入未知。

**覆盖面**：本批只在 `body.window.click@1` 接入，附件 §5.12 第 1 类要求逐个落 intent 的写端（工作站提交、丢弃、菜单购买、place、dig、attack、consume、addon 协议写端）都还没接。这不等于 §5.3 已收口；未接入清单、原因与 Addon 契约边界见 [known-gaps.md G34](../known-gaps.md)。§5 台账里 C02–C05 的 `PASS` 只代表这一个消费者的 T1 崩溃矩阵。

## 4. 验证证据

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | `Checked 878 files` + `boundary check ok: 10 rules`，双 tsc 无输出，exit 0 |
| `pnpm exec vitest run $(ls tests/mc/*.test.ts) --maxWorkers=4` | `121 passed (121)` / `1010 passed (1010)` |
| `UINA_TEST_PYTHON=<uv 隔离环境> pnpm test --maxWorkers=4` | `349 passed (349)` / `3576 passed + 1 expected fail`，exit 0 |
| `pnpm exec vitest run tests/mc/mc-driver-window.test.ts tests/mc/mc-effect-intent.test.ts` | 修复前 4 失败 / 25 通过（29 项，含 1 个未处理 rejection）→ 本批收口时 31/31 通过；2026-11-09 审查轮补测后 36/36 通过 |
| `node scripts/build-mc-native.mjs && pnpm exec tsc -p tsconfig.build.json && node scripts/copy-assets.mjs && pnpm build:web` | 四步全部 exit 0 |

两条环境性失败与本批无关，已定位：

- `pnpm build` 首步 `scripts/clean-dist.mjs` 被环境的批量删除保护拦住（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，`dist/` 1234 个生成文件 > 50 阈值）。未绕过保护，改跑清理之后的全部编译步骤，上表第四行即其证据。
- 全仓默认并发下 `tests/mc/mc-executor-kill-write.test.ts`（真实 SIGKILL + PowerShell 进程枚举）120s 超时；同一用例在 `--maxWorkers=4` 的显式 `tests/mc` 运行里 5.5s 通过。`tests/tts-bridge-protocol.test.ts` 需要 Python `httpx`/`uvicorn`/`fastapi`，用 uv 在 `E:/Work/venvs/tts-bridge` 建隔离环境并设 `UINA_TEST_PYTHON` 后 5/5 通过，未污染全局 Python，未改动该测试文件。

## 5. 验收台账（本轮真实状态）

口径：`PASS` = 本轮跑出的证据；`PASS existing` = S0 只读核对判定已在位但未产生本轮新证据；`NOT_RUN` = 未跑，不冒充通过。

| 项 | 状态 | 证据或原因 |
|---|---|---|
| C02 | PASS（T1，**仅 window.click**） | `mc-effect-intent.test.ts`「intent 被拒收时不派发」「ACK 丢失按 unknown 上报」+ `mc-driver-window.test.ts`「ACK 丢失不发包」 |
| C03 | PASS（T1，**仅 window.click**） | `mc-effect-intent.test.ts`「intent 已提交、派发前崩溃 → unknown」 |
| C04 | PASS（T1，**仅 window.click**） | `mc-effect-intent.test.ts`「包已发但 dispatch 事实没落盘 → 仍按 unknown 对账」 |
| C05 | PASS（T1，**仅 window.click**） | `mc-effect-intent.test.ts`「业务结果已提交但核验未提交 → 旧 Effect 不丢」 |
| C09 | PASS（T1） | `mc-control-permit.test.ts` 三条：迟到释放不抹掉新 owner、body/goto 共用唯一资格、资格退役不可复活 |
| C15 | PASS（既有测试本轮重跑） | `mc-driver-window.test.ts`「an unchanged full cannot prove rejection」 |
| T0 | PASS | typecheck + boundaries + 双 tsc + 单测全绿 |
| T1 | 部分 PASS | 写前 intent、控制撤销、屏障故障注入、崩溃矩阵 C02–C05 有确定性用例；其余故障注入未跑 |
| C01、C06–C08、C10–C14、C16–C25 | NOT_RUN | 本批未做对应故障注入；C14/C21 属持久等待，见 §6 |
| F01–F20 | NOT_RUN | S0 判定多数为 `PASS existing`，但本轮没有逐项复验证据，不冒充通过 |
| T2（真服 Paper 1.21.11） | NOT_RUN | 本批未启动 `dev-env`，未跑 `dev:mc:*` 场景 |
| T3（真 Agent / 30 分钟窗口） | NOT_RUN | 需要 G14 窗口，本批未跑 |
| 性能对照 | NOT_RUN | 未做写前屏障前后的吞吐/写入放大对比 |

## 6. 未完成：持久等待与 smelt 跨进程恢复

附件 §5.9 把持久等待列为 P0，本批**没有实现**，也未登记为已通过。源码级接缝已查清，供下一批直接施工：

- `capabilities/actions/smelt.ts:328-355` 的等待是 `capabilities/shared/observe.ts:104-122` 的 `setTimeout`，`withStation()`（`shared/workstation.ts:123-152`）每轮重新申请 Body/开窗；全部在同一次调用栈内，重启无状态可恢复。
- `runtime/engine.ts:312-354` 的 `recover()` 把 `phase:"waiting"` 与其余未终结 Run 一起保守终结为 `finished/unknown` 并清空 `waiting`。
- `phase:"awaiting_decision"` 是**唯一**跨进程存活的非终结状态（`recover` 在 `:314` 明确排除），由 `engine.ts:411-577` 的 `continuePrepared()` 在 `runtime/admission.ts:33-44` 的 `(phase, decision, revision)` CAS 下原子认领新 Segment。附件 §5.9 允许「复用现有受信任 decision 机制扩展其挂起分支」，这是不另建并行 Call 状态机的正路。
- 阻塞点有三处，必须一起做完：① `runtime/owner.ts:140` 的 `assertAllowed()` 检查 `origin.activation === binding.activation`（`capture()` 在 `:145`），重启后 host 会用新 activation，扫描器必须取当前 binding 而不是挂起时存下的旧值；② 需要启动扫描 + 定时复查 + 世界事件唤醒，且唤醒只能触发重新观察，时间到不等于世界变化完成；③ `smelt.ts` 需要显式新增可持久模式（不能改旧 `wait` 的返回含义），并把 `furnace` / `loaded` / `produced` / `completed` / `deadline` / `idle` 变成纯 JSON 检查点，恢复后跳过装料、只重新观察与取产物。
- 验收必须覆盖 C14、C21、C23 的崩溃矩阵：提交前/后 kill、Watch 丢失、唤醒时并发 stop、区块未加载、他人取走材料、两个 Run 不因同一份旧库存预算重复支付。

## 7. Git 状态

本批四个提交，均为路径限定提交，未推送：

- `78e7d4c` `fix(mc): 控制权资格改为单一 ControlPermit，旧回调无法越权释放`（3 源码文件）
- `c6cc437` `feat(mc): 窗口点击接入 Effect 写前意图与真实持久屏障`（6 源码文件）
- `44a8de8` `test(mc): 控制权资格与 Effect 写前意图的确定性回归`（14 测试文件，含 2 个新增）
- `f533a90` `docs(mc): 登记控制权资格与写前意图批次的证据和验收台账`（本文件及索引）

后续 2026-11-09 审查轮的修复与结论见 [review-2026-11-09-quality.md](review-2026-11-09-quality.md)。用户原有的未提交文件未改动、未提交、未推送。
