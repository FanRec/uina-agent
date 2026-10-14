# TTS Delivery Hardening Implementation Plan

> **状态（2026-10-14 复核）：** 计划中的解析、PCM 完成/取消、播放租约、Voice 结果和订阅清理能力均可在当前代码中找到；这里的未勾选框是原执行清单，不表示它们仍是当前待办。当前合同见 [Voice/TTS 运行合同](../../voice-tts/voice-tts-runtime.md)，历史设备/整仓结果与本轮离线复核见 [Voice/TTS 验证记录](../../voice-tts/voice-tts-verification.md)。本轮额外通过 `tests/tts-hardening.test.ts` 和 Bridge `test_service_cancel.py`、`test_review_races.py`（49 项）；未连接真实 Vendor、Bridge 或设备。

**Goal:** 修复 TTS 文本、PCM、物理播放取消、进度、口型订阅和 Voice 结果契约中的已确认一致性缺陷，同时保持 Core、Voice、TTS、Bridge 的现有职责边界。

**Architecture:** `activeTrace` 只代表文本生成；TS 交付账期由 revision 保护；Bridge 以 `PlaybackLease(trace_id, generation_id, segment_index)` 作为声卡停止授权。正常 PCM 结束与取消使用不同路径。Core 不新增语音状态，只保留已有事件 flush 顺序保证。

**Tech Stack:** TypeScript/Vitest、Python/unittest、Fetch/SSE、现有 TTS Bridge 与 PlaybackCoordinator。

**Spec:** 用户提供的《Uina TTS 专项审查与重构方案》（基准 4a76aa2；实现基准为当前 HEAD bedefa8）。

## Global Constraints

- 不新增通用语音框架，不把 TTS 状态迁入 Core。
- 保留现有流式合成、自适应策略和跨 trace FIFO。
- 正常路径不得丢弃已接纳 PCM。
- 旧 trace/generation 不得停止新物理播放。
- 工具和 Voice 不得把未知结果报告为成功。
- 保留并报告当前工作区已有文件，避免修改真实 Provider、会话和设备配置。

## Review Focus

- `</think>` 在任意 chunk 边界都必须恢复到 normal 状态：`tests/tts-hardening.test.ts`。
- PCM 满队列正常结束保留全部已接纳块，取消才丢弃：`tests/tts-hardening.test.ts` 与 Python bridge 测试。
- 旧取消请求延迟到新 lease 后不得停止新播放：Python `test_service_cancel.py`。
- 当前播放句进度不得使用上一句的 revealed_count：`tests/tts-hardening.test.ts`。
- TTS unload 必须退订共享 registry：扩展激活/teardown 回归测试。

### Task 1: Lock down parser and delivery projection

**Files:**
- Modify: `.uina/extensions/tts/stream-parser.ts`
- Modify: `.uina/extensions/tts/delivery.ts`
- Create: `tests/tts-hardening.test.ts`

- [ ] Add failing tests for every two-part split of `<think>` and `</think>`, including the concrete `</th` + `ink>` case.
- [ ] Add failing test proving `summarizeProgress()` uses only the current segment's revealed count.
- [ ] Run the focused Vitest file and confirm the failures are caused by the current parser/progress behavior.
- [ ] Replace `thinkTagBuffer` guessing with an incremental tag candidate state that preserves partial close tags without replaying consumed characters.
- [ ] Change `summarizeProgress()` to read `revealed_count` from the selected current segment only.
- [ ] Run the focused Vitest file and confirm it passes.

### Task 2: Separate normal PCM finish from cancellation

**Files:**
- Modify: `.uina/extensions/tts/bridge/synthesis_handlers.py`
- Modify: `.uina/extensions/tts/bridge/streaming_engine.py`
- Modify: `.uina/extensions/tts/bridge/test_service_cancel.py`

- [ ] Add Python tests for a full queue normal finish, slow consumer finish, and cancellation wakeup.
- [ ] Run the bridge test file with the configured Python environment; if dependencies are unavailable, record the exact missing package.
- [ ] Implement `finish()` that preserves queued PCM and lets the consumer exit after draining.
- [ ] Implement `cancel()` that wakes the consumer and explicitly discards remaining queued PCM.
- [ ] Make producer `finally` use normal finish; make `StreamingSession.close()` use cancellation.
- [ ] Move PCM accounting after successful queue admission.
- [ ] Re-run the focused Python tests.

### Task 3: Make physical cancellation lease-owned

**Files:**
- Modify: `.uina/extensions/tts/bridge/playback_coordinator.py`
- Modify: `.uina/extensions/tts/bridge/service.py`
- Modify: `.uina/extensions/tts/bridge/models.py` if request/result fields require it
- Modify: `.uina/extensions/tts/bridge/test_service_cancel.py`

- [ ] Add a delayed stale cancellation test where trace A cancellation arrives after trace B owns playback.
- [ ] Add a same-trace new-generation test.
- [ ] Run tests and confirm current global `cancel_all()` behavior fails.
- [ ] Add a single coordinator-owned playback lease and an atomic `cancel_if_owner()` entry point.
- [ ] Route task and trace cancellation through the coordinator; stale cancellation only cancels queued work for its target.
- [ ] Return explicit cancellation outcome details without changing Core `ToolResultStatus`.
- [ ] Re-run Python cancellation tests.

### Task 4: Make Voice and lipsync results truthful

**Files:**
- Modify: `.uina/extensions/tts/client.ts`
- Modify: `.uina/extensions/tts/driver-impl.ts`
- Modify: `.uina/extensions/tts/index.ts`
- Modify: `.uina/extensions/voice/tool.ts`
- Modify: `.uina/extensions/voice/driver.ts`
- Modify: `src/extensions/world-framework/types.ts` only if needed for typed teardown
- Modify: `tests/tts-hardening.test.ts`
- Modify: `tests/voice-extension.test.ts` only if tracked/available

- [ ] Add tests for interrupt outcomes: interrupted, no-op, failed, and unknown.
- [ ] Add a test that expected playback trace is checked against delivery ownership, not active text trace.
- [ ] Change the bridge/client/driver contract to preserve the outcome and map it to truthful ToolExecutionResult status/details.
- [ ] Keep `activeTrace` for submit/turn end and `deliveryTrace` for playback targeting.
- [ ] Replace per-turn lipsync SSE switching with one physical playback event subscription, or the smallest equivalent that follows the Bridge owner.
- [ ] Save and call the shared registry unsubscribe function during teardown.
- [ ] Add teardown and old-audio/new-text lipsync regression tests.

### Task 5: Verify all layers and document limits

**Files:**
- Modify: `.uina/extensions/tts/README.md` if current claims are stale.
- Modify: `docs/superpowers/plans/2026-09-27-tts-delivery-hardening.md`

- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run Bridge tests with the required Python dependencies if available.
- [ ] Check `git diff`, `git status`, and worktree scope.
- [ ] Report real Bridge/device/provider verification separately from unit-test evidence.
