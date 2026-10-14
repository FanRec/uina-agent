# Voice / TTS verification

> 本文件主体是先前的自动化与设备验收快照；原稿未注明准确运行日期或源码基线，不能单独作为当前 checkout 的通过证明。2026-10-14 本轮仓库内核验：`pnpm typecheck` 通过；5 个 TTS TypeScript 定向测试文件 61 项通过；2 个 Bridge Python 测试文件 64 项通过。没有运行全量套件或真实 Vendor、Bridge、设备。逐篇审核记录见 [文档审阅台账](../document-audit-register.md)。

## Implemented scope

Stable activation sessions and independent sources; FIFO/segment playback outside synthesis workers; cancellation tombstones and confirmed PCM stop; atomic reset; persisted immediate mute; bounded diagnostics and recovery; original-task reconciliation; concise tool content and one-shot observations. The shared cue-owner helper now receives the output event. The existing compaction extension recognizes the transient event-frame source; no Core concept was added.

The starting worktree was already dirty. Existing Voice/TTS work was retained and revalidated. No real provider configuration, authentication, session journal, ThirdParty source, or unrelated drawing was changed. Commit status is recorded by Git and the delivery report.

## Automated evidence

- Python Bridge suite: 135 passing tests using system Python with pytest, including real stop-control code and observable players.
- Voice/TTS focused TypeScript suite: 132 passing tests in 12 files.
- Final full TypeScript suite: 1970 passing tests, one pre-existing smoke failure, 1971 total.
- Real TS-to-Python HTTP tests cover independent/replacement speech, source failure and continuation, original-identity reconciliation, cancelled late admission, two-session isolation, and configured streaming tests.
- Actual OpenAI gateway HTTP construction is tested against a local wire receiver. No paid/remote model inference or real provider setting changes were made.
- Same request/fact, previous HEAD observation format versus new projection: 664 to 618 wire-message characters; 181 to 149 estimated tokens. These are local estimates, not provider-reported billing tokens. After real-response consumption the observation is absent; different failure reasons remain visible.

`pnpm exec tsc --noEmit`, `pnpm check:boundaries`, and `git diff --check` pass. `pnpm typecheck` stops at the existing repository-wide formatting gate (283 diagnostics, largely line-ending differences); no unrelated batch formatting was performed. The full suite's remaining failure is `tests/smoke.test.ts:59`, which parses the ToolBroker's plain error text as JSON and also failed before this work. An unrelated session-settings timing failure occurred on one earlier full run and passed on isolated rerun and the subsequent full run.

## Device evidence

`pnpm exec tsx tests/fixtures/tts-device-check.ts` ran a temporary new Bridge with the deployed Python, existing external Vendor, and actual configured PCM output/mirror. It changed only temporary output/configuration; subtitles and lipsync callbacks were disabled. It did not restart Uina, stop the external Vendor, or replace the user's running Bridge.

Program receipts confirm completion for body speech, independent speak, replacement speech, the configured streaming playback test, and speech after controlled lost-admission-reply recovery. Interrupt/mute returned confirmed cancellation, muted playback tests were not started, and a new driver applied a saved temporary mute preference before rejecting speech. Old content was not replayed during recovery. The temporary process exited normally.

Evidence: `C:/Users/34150/AppData/Local/Temp/uina-tts-device-verification.json` (canonical UTC observation timestamp). Human listening feedback is still unverified. This is driver/Bridge/hardware evidence, not acceptance of a reloaded real Uina session, OBS subtitles, or Live2D mouth animation.

Deployment requires matching TS and Python Voice protocol version 2. Reload cannot upgrade an external already-running Bridge; its owner must coordinate an update/restart. No external process was killed to make the checks pass.
