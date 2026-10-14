# Voice / TTS current contract

## Everyday speech

The `voice`, `tts`, and `tts_generate` tools remain separate. Content streams use the saved text-reading preference; explicit speech remains available when text reading is off. Thinking, receipts and logs do not become speech. Full-width parentheticals, code and cue markup use the existing speech parser; explicit speak uses the same cleaning rules and does not execute body cues.

Each activation owns one control session. Body streams and explicit invocations own independent sources with segment indices starting at one. Admission is serialized locally. The Bridge registers source order before synthesis, seals a source at output end, and executes ready playback outside the synthesis worker pool. Pending and ready work both count against the existing task resource capacity; the playback head retains admission credit and synthesis priority.

`speak` queues a new source. `replace=true` validates the new text before cancelling the frozen old sources; it admits a fresh source only after stopping is confirmed. Invocation retries do not repeat or interrupt audio, and return any later known completion/failure/cancellation evidence. Ordinary new input does not cancel old speech.

Mute stores the preference and immediately stops/cancels this activation's work. A failed or unknown stop is reported separately from the saved preference and remains visible in status. Unmute, recovery, reload and normal completion never replay old speech. Changing text-reading preference affects new streams.

## Evidence and recovery

Voice protocol version 2 is advertised by `/health`. An incompatible external Bridge can be inspected but is not killed or reused for normal speech.

Cancellation distinguishes stopped, not-playing-and-closed, unknown and failed. Reset freezes the old epoch before cancellation, waits outside the registry lock, and enables the new epoch only after confirmed closure. Cancellation tombstones reject late admissions. Late replies update only their captured source. File and streaming playback share the cancellable PCM player.

Default `tts.recover` checks compatibility, reconnects the session and feedback stream, and reconciles original sources. An unresolved gap permits one confirmed reset. Restart requires explicit `operation:"restart"` and a target managed by the current extension/Bridge. Maintenance rejects new speech instead of saving it for later. Background probing does not reset or restart.

`tts.inspect` returns connection, synthesis-interface, player and local-record evidence. A component selection expands that component; raw health objects are not dumped into normal model text. Necessary conclusions, unknowns and executable arguments are in tool content, since Provider wire does not include `details`.

Synthesis tests validate audio without playing it. Playback tests use the configured normal playback pipeline and wait for actual completion; mute prevents them. A successful playback receipt does not establish that a person heard it. Long tests use the configured generation timeout as a total deadline, including queued work, and cancel remaining work on timeout/disconnection.

## Context

Voice facts are deduplicated by cause/version. Projection and inspection are read-only. Preflight captures the included versions; real output or tool execution consumes only those versions. Unread facts survive turn completion. Confirmed resolution removes obsolete uncertainty without turning old incomplete speech into completed speech.

Transient Voice frames retain the event-frame protocol and carry the generic internal `runtime.perception` source type. Compaction removes the whole transient group, not canonical tool receipts. Ordinary progress is not injected. Repeated equal summaries are grouped with their count; different reasons remain visible.

## Verification boundary

Previous automated and device evidence, plus this audit's repository-only checks and remaining acceptance boundaries, are recorded in [voice-tts-verification.md](voice-tts-verification.md). Historical full-suite and device results are snapshots, not proof for the current checkout.

The automated protocol fixture runs the real Python HTTP/service/scheduling code with an observable test player and vendor, using temporary configuration. It does not establish real hardware behavior. Deployment requires matching TS and Python versions; reload alone cannot upgrade an external running Bridge. Real device receipt evidence and human listening feedback must be recorded separately.
