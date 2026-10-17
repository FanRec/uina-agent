# Voice / TTS reliability execution record

Approved scope: source identity, ordered playback, confirmed stop/reset, immediate persistent mute, actionable diagnostics, one-shot perception, and real protocol/device verification.

The existing uncommitted edits are the starting point. No Core, provider authentication, real journals, or ThirdParty source changes are authorized.

## Decisions

- Default recover performs bounded connection and delivery reconciliation; restart requires an explicit owned target.
- Mute stores the preference immediately and confirms stopping the current session separately.
- Each activation owns a stable control session; each stream or explicit invocation owns a separate source with independent segment numbering.
- Tests must cross the real Python HTTP and scheduling boundary. Mock admission alone is insufficient.

## Verification

The driver now uses stable activation/session identity, separate sources, a serialized admission boundary, and distinct admission/seal/stop barriers. Bridge cancellation tombstones prevent late requests from reopening cancelled sources. Playback callbacks run outside the synthesis pool, in registered source order. Files use the same cancellable PCM player as streaming.

Real TS-to-Python HTTP tests exercise independent speech, replacement, source failure/continuation, cancelled late admission, original-work reconciliation, two-session isolation, and configured streaming diagnostics. Current focused TS suites pass 132 tests; Python passes 135. Real PCM hardware receipts were collected with a temporary Bridge and existing external Vendor; human hearing and a reloaded real Uina session remain unverified. The tracked report is docs/voice-tts-verification.md.

The test Python executable with pytest is the system Python (E:/Work/miniforge3/python.exe). The deployed GPT-SoVITS Python has no pytest; it remains available for actual Bridge/device acceptance without installing anything into ThirdParty.
