# Inline Prompt and Injection Cards

## Summary

Replace the hard-to-read `/context` diagnostic overlay with two focused surfaces:

- The transcript shows a compact context card when the effective system prompt
  or its turn-boundary contributions change, plus readable cards for external
  runtime inputs and visible extension messages.
- `/prompt` opens the latest effective system prompt and its contribution
  summary on demand. It does not list auxiliary records or recent transform
  bookkeeping.

The existing `context_prepare` runtime fact remains available to non-TUI
consumers. The TUI becomes a projection of that fact instead of a second
diagnostic data model.

## Behavior

### Effective prompt lifecycle

The base prompt is fixed when `UinaHost` creates the `Subject`. Profile
`persona.md`, explicit `systemPrompt`, and the built-in event-frame prompt are
therefore startup inputs. `turn.prepare` hooks run before every turn and their
latest returned `systemPrompt` is the effective prompt for that turn. Project
extension reloads affect subsequent turns; core and profile source changes
require a process restart.

The TUI must label the prompt as either `当前回合生效` or `进程启动基座` where
appropriate. It must not imply that editing a file changed the running
Subject.

### Change detection

The Subject computes a deterministic fingerprint from the effective system
prompt and the ordered `turn.prepare` provenance list. The TUI keeps the last
fingerprint for the current process and renders a full context card only when
the fingerprint changes. Repeated identical turns render no card. The first
observed prompt is a change from an empty baseline and renders a card.

The full snapshot is persisted through the existing auxiliary `custom_entry`
channel only when the fingerprint changes. The entry uses the stable custom type
`uina.prompt.snapshot` and contains the snapshot sequence, fingerprint, final
system prompt, and ordered provenance. It never enters model history.

On session restore, snapshots are merged with canonical entries by their global
journal sequence and rendered at their original position. This preserves the
conversation-flow location without treating a prompt snapshot as a user or
assistant message.

### Transcript card

The collapsed card uses the existing ANSI palette and terminal-width helpers:

```text
  ╭─ ◆ 提示词变更 · 本回合生效 ─────────────────╮
  │ 2,184 字符 · 3 个来源 · +1 段                 │
  │ ├─ 基座 · 事件帧协议                         │
  │ ├─ cognition · 记忆协议                       │
  │ └─ world-framework · 环境状态                 │
  │ Ctrl+O 展开最终提示词                         │
  ╰──────────────────────────────────────────────╯
```

The card is a first-class transcript item with its own expansion state and
does not reuse thinking-card state. Expanded mode shows grouped provenance,
the effective prompt wrapped by display width, and a short change summary
relative to the previous snapshot. It never dumps transform internals or
auxiliary counts into the normal flow.

External runtime inputs render as a separate `◇ 外部注入` card with source,
type, timestamp, and sanitized body. They never render as a human `❯` bubble.
Internal private runtime inputs remain hidden when their source policy says
`display:false`. Existing visible `custom_message` cards keep their renderer
and ordering; restored custom messages retain `images` and `details`.

The existing minimal `input_accepted` event remains unchanged. For an accepted
runtime input with `source.origin === "external"`, the Subject emits a separate
read-only `external_input` event after durable acceptance. It carries the stable
input id, source, received time, text, and images needed by transcript
consumers. The event is observational only and never becomes a second journal
record. If the input is internal or explicitly private, no visible event is
emitted.

### `/prompt`

The old `context` command and `Alt+G` binding are removed. `/prompt` opens a
small overlay built from the same prompt-card component. It shows the latest
effective prompt, its change time/turn, and contribution rows. Empty state says
that no turn has prepared a prompt yet. It does not show transform ledgers,
auxiliary groups, or a second session browser.

## Implementation boundaries

- Add a prompt snapshot type and card renderer under the transcript UI.
- Extend `TranscriptContainer` with prompt-card timeline/turn items, expansion,
  replay insertion, and width-safe rendering.
- Extend the TUI event adapter to consume `context_prepare` and external input
  facts; keep `context_prepare` in the public runtime event stream.
- Persist changed snapshots via `SessionStore.appendCustomEntry`; add a parser
  and sequence-merge path for restored auxiliary snapshots.
- Treat snapshot persistence as diagnostic best effort: a failed auxiliary
  write reports an error and keeps the live card/model turn intact.
- Keep `InjectionProvenance` and `ContextPrepareEvent` for other consumers.
- Remove `ContextInspectorOverlay`, `ContextIntelPort`, its adapter, feature
  registration, `/context` command/help text, and Host/Runner accessors whose
  only consumer was the old overlay.
- Do not modify provider wire format, model projection semantics, or the
  canonical message journal.

## Tests and acceptance

- Prompt fingerprinting renders once for the first prompt, suppresses identical
  repeats, and renders a readable change card when the prompt or provenance
  changes.
- Cards remain within terminal width, wrap CJK/emoji safely, and expand/collapse
  independently of thinking cards.
- `/prompt` shows the latest effective prompt; `/context` and `Alt+G` are absent.
- External runtime input has the same visible policy live and after restore and
  never becomes a human user bubble.
- Custom message ordering, `display:false`, `images`, and `details` survive
  live rendering and session replay.
- Auxiliary prompt snapshots replay at the correct sequence positions and do not
  enter `projectAgentHistory` or provider requests.
- Run focused UI/session/runtime tests, then `pnpm typecheck`, `pnpm test`, and
  the repository baseline gates where dependencies permit. Report any real
  TTY/provider boundary separately.

## Assumptions

- Full prompt snapshots are acceptable in the local session journal's auxiliary
  area because the user explicitly requested full replay; the UI will clearly
  label them as prompt diagnostics rather than conversation messages.
- A prompt snapshot is a display fact, not a model-visible message and not a
  rewind target.
- The existing terminal card primitives and palette are sufficient; no new UI
  framework or dependency is introduced.
