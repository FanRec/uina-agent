from __future__ import annotations

import base64
import json

from mcp.types import CallToolResult, ImageContent
from uina_screen_mcp.render import render_mcp


def test_render_uses_one_observation_for_text_and_structured_content() -> None:
    png = b"\x89PNG\r\n\x1a\nfixture"
    observation = {
        "kind": "screenshot", "status": "ok", "target": {"kind": "desktop"},
        "startedAt": "2026-10-05T00:00:00Z", "completedAt": "2026-10-05T00:00:01Z",
        "image": {"status": "ok", "surface": "desktop", "bounds": [0, 0, 20, 10],
                  "originalSize": [20, 10], "outputSize": [20, 10], "source": "screen"},
        "semantics": {"status": "not_requested"}, "warnings": [],
        "diagnostics": {"backend": "fixture-only"},
    }
    result = render_mcp(observation, png)
    assert isinstance(result, CallToolResult)
    assert result.isError is False
    assert len(result.content) == 2
    text = result.content[0].text
    image = next(item for item in result.content if isinstance(item, ImageContent))
    assert base64.b64decode(image.data) == png
    assert text.startswith("Observation")
    assert "backend" not in text.lower()
    assert "[0, 0, 20, 10]" in text
    assert result.structuredContent == observation
    assert "fixture-only" in json.dumps(result.structuredContent)


def test_partial_is_success_and_preserves_component_reason() -> None:
    observation = {
        "kind": "snapshot", "status": "partial", "target": {"kind": "desktop"},
        "startedAt": "2026-10-05T00:00:00Z", "completedAt": "2026-10-05T00:00:01Z",
        "image": {"status": "ok", "valid": True},
        "semantics": {"status": "unavailable", "errors": [{"code": "not_supported"}]}, "warnings": [],
    }
    result = render_mcp(observation, None)
    assert result.isError is False
    assert "PARTIAL" in result.content[0].text
    assert "not_supported" in result.content[0].text
