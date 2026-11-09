# 实现质量审查与修复轮（2026-11-09）

审查范围：`mc/world-refactor` 分支 `78e7d4c^..f533a90`（控制权资格 + Effect 写前意图四个提交），对照附件 `Uina-Minecraft-World-Refactor-V3.1-2026-11-09.md`。本文件只记录这一轮的做法与证据，不维护现状。

## 1. 附件任务是否圆满完成

**否。** 按附件 S0–S5 与 F01–F20 / C01–C25 / T0–T3 的原文口径逐项对照：

| 阶段 | 状态 | 实际交付或缺失 |
|---|---|---|
| S0 真实工程基线 | 已完成 | 分支/HEAD/未提交改动/依赖/测试环境/历史修复核对；大量条款判为 `PASS existing`，未重复实现 |
| S1–S2 核心执行与恢复 | **部分** | 修了 Control Gate 旧回调越权、窗口点击写前意图、ACK 水线、资格释放；**持久等待、`smelt(wait=true)` 跨进程恢复、`check@1`/Preview、Host 三层 ACK 诊断、Safety 首条逃生延迟链均未实现**（G33） |
| S3 领域能力成熟化 | 未做 | 导航/水域/采矿/地下工程/建造/工作站/容器/战斗/探索的逐项升级与真结果核验未开展 |
| S4 高层自主任务 | 未做 | 未用现有 Tool/Program/World 跑通资源生产、建筑、危险生存与任务中断恢复 |
| S5 收敛与交付 | **部分** | 全量回归、验收台账、公共合同与文档已收口；被替代旧实现的清理只做了 Control Gate 旧 API，未做跨模块全量清理、性能对照 |
| F01–F20 | `NOT_RUN` | S0 只读判定多数为 `PASS existing`，但本轮没有逐项复验证据，不冒充通过 |
| C01–C25 | 部分 PASS | 本轮有证据的只有 C02–C05（T1，且**仅 `body.window.click@1`**）、C09、C15；C14/C21/C23 等属持久等待，全部 `NOT_RUN` |
| T0 | PASS | typecheck + boundaries + 双 tsc + 单测全绿 |
| T1 | 部分 PASS | 写前 intent、控制撤销、屏障故障注入、崩溃矩阵有确定性用例；其余故障注入未跑 |
| T2 / T3 | `NOT_RUN` | 未启动 `dev-env`，未跑 `dev:mc:*` 场景；未跑真模型 30 分钟窗口（G14）；未做性能对照 |

两个容易误读为"已完成"的地方已在本轮纠正口径：

- **§5.3 写前意图不是全覆盖**。`EffectRecorder.beforeWrite()` 只接了 `body.window.click@1`。工作站提交（附魔/铁砧/交易）、丢弃物品、菜单购买、place/dig/attack/consume、Addon 协议写端都还没接。未接入清单与 Addon 契约边界登记为 G34；C02–C05 的 `PASS` 只代表这一个消费者的 T1 崩溃矩阵。
- **`pnpm build` 不等于跑通**。首步 `clean-dist.mjs` 被环境的批量删除保护拦住（`dist/` 1234 个生成文件 > 50 阈值），本轮未绕过保护，改跑清理之后的全部编译步骤。

## 2. 审查方法

独立审查员按"写前意图覆盖面 / 崩溃窗口闭合 / ControlPermit 覆盖 / 公共合同遗漏消费者 / `unresolved()` 语义外溢 / 测试假绿 / 文档事实一致"七个方向做只读对抗复核，本报告逐条核过源码行号后才采纳。筛掉的条目按两条判据处理：不是本批引入的既有缺陷、或只有推测路径而无真实可达反例的，登记而不改代码。

## 3. 修掉的真缺陷（每条先红后修）

| 缺陷 | 证据 | 修复 | 红测试 |
|---|---|---|---|
| ACK 水线低报，派发屏障挂死 | `runtime/runtime-db-worker.ts` 的 `applyBatch` 只在 INSERT 分支更新 `lastSeq`；整批命中 `record_log` 幂等跳过时 `ack=null`，不发 `durable`，`RecordQueue.flushThrough(ticket)` 的等待者永不 resolve | ACK 上界按本批全部 `ticket.sequence` 取最大值，幂等跳过同样算已提交 | `mc-runtime-ack-watermark.test.ts`：真实 worker 同载荷重放，修复前 2 秒内无 `durable` |
| `goto.settle()` 异常路径不释放资格 | `release(permit)` 是 `settle()` 最后一行，`clearGoal` / `requireRetirement` / `recorder.record` 任一抛错即跳过 | `settle()` 全函数体 `try/finally`，释放在 `finally` | `mc-control-permit-release.test.ts`：清理事实写入抛错后 `claim("body")` 仍成功，修复前返回 null |
| `finishClose()` 异常路径不释放资格 | `detachHost()` / `requireRetirement?.()` 抛错时 `onClosed` 不执行，`PlayerPortImpl` 的 `release(permit)` 落空 | `finishClose()` 全函数体 `try/finally`，`onClosed` 在 `finally` | 同上：宿主退订抛错后资格仍可再授予，修复前返回 null |
| 故障后仍写入看似已结算的事实 | `EffectRecorder.record()` 不检查 `faulted`，与类注释"记录故障封闭新副作用"矛盾；窗口 C02 用例甚至把这条事实写成预期 | `record()` 开头检查 `faulted` 直接返回 | `mc-effect-intent.test.ts`「屏障失败后 recorder 封闭新副作用，后续事实也不再写入」；`mc-driver-window.test.ts` C02 断言改为只含 `intent` |
| `click()` catch 无条件采信外部 dispatch | 旧三分支约束被改成 `knownFailure ? failure.dispatch : ...`，外部 `scope.guard()` 抛非 `not_sent` 的 `CallFailure` 时，未派发的包会被记成 `sent` | `dispatch` 只由本调用栈可证明的事实决定：`writing` → `unknown`；`intentDurable` 且未发包 → `not_sent` + 终态 cleanup；其余只可能是 `beforeWrite` 的两种失败，采信它的 `CallFailure.dispatch` | `mc-driver-window.test.ts`「协议写端在发包瞬间抛错」：`writing=true/sent=false` 必须按 `unknown` 收口，facts 为 `intent(unknown)` + `receipt(unknown)` |
| 崩溃恢复模型只装入最后一个 effect | `mc-effect-intent.test.ts` 的 `restart()` 用 `applied.slice(0, through)` 把数组下标当 `ticket.sequence`，且只 `restoreEffect(last)`；真实 `engine.recover()` 是按 effect upsert 后每个 effect 一行 | 改按 `ticket.sequence <= through` 过滤、对每个 effect 取最后一版累积 facts 再 `restoreEffect` | 新增 C07 多 effect 恢复：修复前只返回 `eff:probe:2` |
| 屏障时序测试不真实 | harness 的 `ensureDurable` 默认空放行，测试把一次 microtask 让出当成"真实异步屏障" | 不动既有 harness，新增受控 Promise 的端到端用例 | `mc-driver-window.test.ts`「写前意图没拿到 ACK 前绝不派发窗口点击包」：intent 已落盘、ACK 未放行时 `window_click` 必须为 0 |

**审查确认不存在的问题**：所有生产写端都经 `claim()` 后才创建 `BodySessionImpl`，没有绕过资格直接写 Bot 的路径；`DriverExecutionSink` 的生产包装层（`companion/side.ts`、`driver/body/session.ts` 的 scoped/root）都真实转发 `ensureDurable`，十余处空实现全在 `tests/`；没有"已派发事实之后追加 `not_sent` 终态"会把已派发效果错误摘出对账的路径。

## 4. 未修项与理由

| 项 | 理由 |
|---|---|
| §5.3 其余高风险写端（G34） | 逐个接入需要每个写端各自的红测试与真服证据。只补一两个再宣称 §5.3 收口，就是被禁止的半接线抽象。本轮改为如实登记为部分实现 |
| `driver/protocol-dispatch.ts` 的 Addon 写端 | 附件明确 Addon 内部不属于本轮重构范围；`send()` 同步返回 `ProtocolDispatch`，改成 async 会动公共契约。已登记"先写包后记事实"落在崩溃矩阵 (3)-(4) 之间，且从不调 `ensureDurable` |
| `goto.ts` cleanup 把未派发覆写成已派发（G35） | 本批之前就存在；修它需要给 goto 加"本次是否真的派发过路径"的标记，属领域重构，不是常规审查修复 |
| `window/session.ts` 在 `sent=true` 时吞掉控制权异常（G35） | 同上，既有行为；改动会牵动既有窗口用例，本轮只登记 |
| 外部 guard 抛 `dispatch:"sent"` 的注入测试 | 生产路径里 `writeDenial()` 与 `recheck()` 抛的全是 `not_sent`，没有真实可达反例。修 `dispatch` 计算是收紧旧约束而非为推测场景加防御，不再为它写测试 |
| DurableWait / smelt 跨进程恢复（G33） | 源码级施工路径与三处阻塞点已在 G33 登记，必须一次做完；本轮不动 |

## 5. 验证证据

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | `Checked 878 files` + `boundary check ok: 10 rules`，双 tsc 无输出，exit 0 |
| `pnpm exec vitest run $(ls tests/mc/*.test.ts) --maxWorkers=4` | `123 passed (123)` / `1018 passed (1018)` |
| `UINA_TEST_PYTHON=<uv 隔离环境> pnpm test --maxWorkers=4` | `351 passed (351)` / `3584 passed + 1 expected fail`，exit 0 |
| `pnpm exec vitest run <本轮新增/改动的 4 个测试文件>` | `40 passed (40)` |
| `node scripts/build-mc-native.mjs && pnpm exec tsc -p tsconfig.build.json && node scripts/copy-assets.mjs && pnpm build:web` | 四步全部 exit 0 |

环境性说明沿用上一批：`pnpm test` 默认并发下 `mc-executor-kill-write.test.ts`（真实 SIGKILL + PowerShell 进程枚举）120s 超时，`--maxWorkers=4` 下 5.5s 通过；`tests/tts-bridge-protocol.test.ts` 需要 uv 隔离环境里的 `httpx`/`uvicorn`/`fastapi`，设 `UINA_TEST_PYTHON=E:/Work/venvs/tts-bridge/Scripts/python.exe` 后通过，未污染全局 Python、未改该测试文件。

## 6. 文档与提交

- 更新：`public-api.md §7.1`（`kind:"intent"`、`ensureDurable`、写前意图条款、ACK 水线约束）、`modules/runtime.md §5.4`（"非阻塞 sink、不控制派发、没有逐包 write-ahead 承诺"三处旧口径与派发前屏障冲突，已按现状限定）、`known-gaps.md`（G33 行号修正，新增 G34/G35）、`changelog.md`、`archive/README.md`、`LEAD.md`、`archive/control-gate-and-effect-intent.md`（覆盖面口径、验收数字、提交数、G33 行号）。
- 本轮按**源码 / 测试 / 文档**三次路径限定提交，不推送；用户原有的未提交文件未改动、未卷入、未提交。
