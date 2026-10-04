from __future__ import annotations

import pytest
from jsonschema import Draft202012Validator

from uina_screen_mcp.contracts import DEFAULT_MAX_DIMENSION, aggregate_components, build_tools, validate_arguments


def test_tool_names_and_descriptions() -> None:
    tools = build_tools()
    assert [tool.name for tool in tools] == ["ListTargets", "Screenshot", "Snapshot"]
    by_name = {tool.name: tool for tool in tools}
    description = " ".join(tool.description or "" for tool in tools).lower()
    for term in ("screenshot", "snapshot", "does not", "page", "partial", "original"):
        assert term in description
    for name in ("Screenshot", "Snapshot"):
        schema = by_name[name].inputSchema
        Draft202012Validator.check_schema(schema)
        assert schema["additionalProperties"] is False
        assert all(not key.startswith("/") for key in schema.get("$defs", {}))
        assert schema["properties"]["maxDimension"]["default"] == DEFAULT_MAX_DIMENSION


def test_validate_arguments_applies_defaults_and_rejects_ambiguous_targets() -> None:
    assert validate_arguments("Screenshot", {})["target"] == {"kind": "desktop"}
    normalized = validate_arguments("Snapshot", {})
    assert normalized["includeImage"] is True
    assert normalized["scope"] == "window"
    assert normalized["maxNodes"] == 1200
    assert normalized["maxTextChars"] == 500
    assert normalized["maxDimension"] == DEFAULT_MAX_DIMENSION
    valid_targets = [
        {"kind": "desktop"}, {"kind": "display", "id": "DISPLAY1"},
        {"kind": "region", "rect": [0, 0, 10, 10]},
        {"kind": "active_window"}, {"kind": "window", "ref": "w1"},
        {"kind": "window", "match": {"app": "notepad"}},
    ]
    for target in valid_targets:
        validate_arguments("Screenshot", {"target": target})
    invalid = [
        {"kind": "window", "ref": "w1", "match": {"app": "x"}},
        {"kind": "window", "match": {}},
        {"kind": "desktop", "unexpected": True},
        {"kind": "region", "rect": [0, 0, True, 10]},
    ]
    for target in invalid:
        with pytest.raises(ValueError):
            validate_arguments("Screenshot", {"target": target})
    for value in (0, -1, "all"):
        with pytest.raises(ValueError):
            validate_arguments("Screenshot", {"maxDimension": value})
    assert validate_arguments("Screenshot", {"maxDimension": "original"})["maxDimension"] == "original"
    with pytest.raises(ValueError):
        validate_arguments("Snapshot", {"scope": "page"})


def test_partial_is_symmetric_and_not_requested_is_ignored() -> None:
    for components in (
        {"image": {"status": "ok", "valid": True}, "semantics": {"status": "unavailable"}},
        {"image": {"status": "failed"}, "semantics": {"status": "ok", "valid": True}},
    ):
        assert aggregate_components(components) == "partial"
    assert aggregate_components({"image": {"status": "ok", "valid": True}, "semantics": {"status": "not_requested"}}) == "ok"
    assert aggregate_components({"semantics": {"status": "ok", "valid": True, "elements": []}}) == "ok"
    assert aggregate_components({"semantics": {"status": "failed", "valid": False, "error": "bad"}}) == "failed"

