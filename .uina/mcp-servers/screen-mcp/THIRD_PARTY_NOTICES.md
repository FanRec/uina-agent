# Third-party implementation notes

This package uses published dependencies rather than vendoring upstream
desktop-control implementations.

## Windows-MCP

- Project: [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP)
- Reference commit: `8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3`
- License: project MIT; any vendored files would require their own notice. No
  upstream source file is copied into this package.
- Borrowed behavior: screenshot/snapshot tool separation, virtual-desktop
  coordinate handling, structural image validation, and visited-node budgets.
  The implementations are rewritten around Uina's partial-result contract;
  backend registries, control actions, analytics, overlays, and vendor UIA
  layers are intentionally not adopted.
- The Firefox fallback was reimplemented from the behavior of
  `src/windows_mcp/tree/ia2.py` at the same commit: lazy `AccessibleObjectFromWindow`,
  document-root filtering, per-property failure isolation, and unknown scroll
  state. No upstream source or vendor cache is copied.

## open-codex-computer-use

- Project: [iFurySt/open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use)
- Reference commit: `93b817501e0b9fa04fba155face2630bfcd0322e`
- License: project MIT. No upstream source file is copied into this package.
- Borrowed behavior: application-level text plus image observation and explicit
  window identity/bounds. Window selection is rewritten to reject ambiguity;
  click/type/scroll/launch/focus actions and the First-1 selection behavior are
  explicitly excluded.

## Runtime dependencies

`mcp`, `Pillow`, `jsonschema`, `uiautomation`, and `comtypes` remain ordinary
locked package dependencies. `comtypes==1.4.17` is used because the guide's
candidate `1.47` has no published distribution resolvable by uv.
