# uina-screen-mcp

Local Windows observation-only MCP server for Uina.

## Contract

The stdio server exposes exactly `ListTargets`, `Screenshot`, and `Snapshot`.
It can enumerate displays/windows, capture desktop pixels, and read accessible
UIA/page semantics. Chromium page roots use UIA; Firefox can use the lazy
MSAA/IAccessible2 fallback and reports `browser_msaa_ia2` as its source. It
never clicks, types, scrolls, launches, focuses, restores, moves, or modifies
windows.

`Screenshot` is the fast image path. `Snapshot` combines image and accessible
semantics and reports `partial` when one requested component is unavailable
but another observation is usable. `scope=page` means an accessibility page
tree, not JavaScript DOM. `maxDimension=original` is explicit; the current
1920 default is a development candidate and is not a frozen release gate.

## Development

```powershell
uv sync --python 3.12 --group dev --frozen
uv run pytest tests -q
uv run uina-screen-mcp

# non-desktop contract and lifecycle tests
uv run python -m pytest tests -q

# measurement report; this observes the current desktop when Screenshot runs
pnpm exec tsx ../../../scripts/measure-screen-mcp.mts probe --python "$PWD/.venv/Scripts/python.exe" --scenario desktop --max-dimension 1920 --warm-samples 30 --cold-samples 10 --output .artifacts/probe.json
```

The supported runtime target is Windows 10/11 x64 with Python 3.12. Pure
contract tests run without a desktop. Real desktop, application, browser,
visual-provider, and latency-gate acceptance remain environment-specific and
must not be inferred from fake fixtures or protocol handshakes.

## Uina startup

Uina launches this server through the global MCP configuration, not by
scanning this directory as an extension. The configured entry is:

```json
{
  "mcpServers": {
    "screen": {
      "command": "E:\\Uina\\Uina\\.uina\\mcp-servers\\screen-mcp\\.venv\\Scripts\\uina-screen-mcp.exe",
      "inheritEnv": true,
      "autoStart": true
    }
  }
}
```

`autoStart` is intentionally explicit. At extension activation Uina starts the
trusted global server and discovers its three tools in the background; a failed
server reports an error without aborting Uina startup. Project-level servers
remain behind the existing trust prompt and are still started on demand.

The release gate intentionally requires an approved criteria JSON containing
the environment, approver, default dimension, sample conditions, and per-
scenario warm/cold P50/P95/failure thresholds. Probe results never approve
their own thresholds.
