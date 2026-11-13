# Speech / TTS current contract

## Expression pipeline

Model `content` is interpreted once by the Output Interpreter (Subject-owned, `src/agent/expression.ts`). Extensions register output tags (`<speech>` block, `<cue>` marker) via `pi.registerOutputTag`; each content stream freezes its tag snapshot at `output_start`. Semantic `expression` events share the raw output observation dispatch; the visible text comes only from semantic text events, and tags outside blocks are displayed, never spoken. Assistant messages persist a minimal `expression` annotation (tag ranges/attributes) atomically with the original content; old unannotated history is displayed as-is. Requests whose preserved history needs signature/native replay keep assistant text verbatim.

`speech.say` text is plain text and never enters the decoder; its visible expression derives solely from the committed Tool Result's `details.speech` (`{version: 1, utteranceId, text, accepted: true}`).

## Utterances and delivery

An utterance is one independent expression (a `<speech>` block or one `speech.say`), not a turn, stream or player task. Acceptance of expression ≠ audio admission ≠ playback completion; `not_played` means no audio ever entered the delivery path, and unknown stays unknown. The Speech extension owns utterances, segmentation, cue alignment, the `speech` tool (`say/stop/status/set_muted`) and the persistent `muted` preference (old `readAssistantText` is deleted, never migrated to mute). The TTS extension keeps the Driver/Bridge, subtitles, acoustic levels and the maintenance tools `tts` / `tts_generate`, and exposes the delivery port via `tts_delivery:*` services; playback facts flow back to Speech via `speech_delivery:on_playback`.

Speech keeps one serial chain per utterance and a global control tail. Stop/interrupt/replace/mute first synchronously bump the local generation, clear unsubmitted segments and cues, and only then stop the driver source; late admissions cannot resurrect a stopped source, and an unknown stop keeps the physical barrier instead of claiming success. `replace=true` validates the new text first and refuses acceptance when the old output cannot be confirmed stopped.

Cues inside speech are time anchors: a marker seals the left segment and binds to the start of the next pronounceable segment (`playback_started`); end cues fire after the last segment completes. Only when a closed block certainly has no audio in the delivery path (muted, offline, all rejected, pure cues) do its untriggered cues run once as a text fallback; interrupted blocks cancel them. Cues outside speech blocks are embodiment's business, dispatched once in stream order.

## Context and events

Guidance (expression syntax, cue semantics) is file-based; capability sources only report current negative limits (muted/offline/barrier) and return null when healthy; the observation source reports at most one line — the currently playing segment from trusted playback facts, null when nothing is verifiably playing. Unexpected interruption, async delivery failure/unknown and availability stages go through the existing runtime-input path (`runtime/internal`, deduplicated by stable identity), never as synthetic tool receipts. Ordinary progress, queueing and completion never notify the model; details stay in `speech.status` / `tts.inspect`.

## Evidence and recovery

Voice protocol version 2 is advertised by `/health`. An incompatible external Bridge can be inspected but is not killed or reused for normal speech. Cancellation distinguishes stopped, not-playing-and-closed, unknown and failed; reset freezes the old epoch before cancellation. `tts.recover` checks compatibility, reconnects, reconciles sources, and permits one confirmed reset per unresolved gap; restart requires an explicit target owned by this extension/Bridge. Maintenance rejects new speech instead of saving it for later. Background probing does not reset or restart.

`tts.inspect` returns connection, synthesis-interface, player and local-record evidence; conclusions and unknowns live in tool content because Provider wire does not include `details`. Synthesis tests validate audio without playing; playback tests use the normal pipeline and wait for actual completion; mute prevents them. A successful playback receipt does not establish that a person heard it.

## Verification boundary

The automated protocol fixture runs the real Python HTTP/service/scheduling code with an observable test player and vendor, using temporary configuration. It does not establish real hardware behavior. Deployment requires matching TS and Python versions; reload alone cannot upgrade an external running Bridge. Real device receipt evidence and human listening feedback must be recorded separately.
