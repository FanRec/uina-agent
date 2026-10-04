# Implementation closure

Updated 2026-10-05 (Asia/Shanghai).

## Completed without real-desktop or provider access

- Three-tool MCP contract: `ListTargets`, `Screenshot`, `Snapshot`, self-contained schemas, descriptions, defaults, validation, and output rendering.
- Target inventory/resolution: desktop, display, region, active window, opaque window refs, ambiguity, stale identity, negative coordinates, mixed-DPI facts.
- Native lifecycle: serialized short-lived worker, timeout/cancellation cleanup, stderr/protocol separation, next-call recovery.
- Pixel path: Pillow desktop capture, PNG downscaling/original, frame validation, cursor composition path, PrintWindow surface path, visible path, partial/diagnostic metadata.
- Semantic path: UIA lazy import, MTA flag before import, password guard, unknown scroll state, visited/text budgets, cycle protection, field-level degradation.
- Browser path: Chromium UIA document roots plus lazy Firefox MSAA/IAccessible2 fallback with `browser_msaa_ia2` source and unknown scroll state.
- MCP/Uina projection: synthetic partial image roundtrip, structured facts, image preservation, and diagnostic base64 de-duplication.
- Measurement tooling: Python percentile/criteria gate, TS Uina-side probe/gate script, missing/unapproved criteria rejection.
- Packaging: uv lock, wheel build, isolated install smoke, stdio discovery.

## Intentionally unverified empirical gates

- Actual Windows desktop/display/window capture and cursor appearance.
- PrintWindow visual fidelity across Notepad, Settings, Explorer, Chromium, Electron, GPU/protected content, occlusion, minimized and mixed-DPI windows.
- Firefox installation and real IA2 page tree; the implementation and synthetic contract exist, but support is not claimed until a controlled page is tested.
- Warm/cold P50/P95 thresholds, final default image dimension, image readability, journal growth, and re-observe cost. No criteria file is approved by measured output itself.
- Real visual Provider reception/recognition and the eight no-Skill task evaluation.

These boundaries are release blockers, not hidden fallback states. A failed or unavailable component remains explicit in the Observation result.
