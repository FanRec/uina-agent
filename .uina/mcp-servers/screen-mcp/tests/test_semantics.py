from __future__ import annotations

from uina_screen_mcp.semantics import collect_semantics


def test_password_guard_precedes_value() -> None:
    result = collect_semantics({"id": "root", "children": [{"id": "p", "role": "edit", "isPassword": True, "passwordKnown": True, "value": "secret"}]})
    assert "value" not in result["elements"][1]
    assert result["elements"][1]["valueOmitted"] == "password"


def test_unknown_password_skips_value() -> None:
    result = collect_semantics({"id": "p", "isPassword": None, "value": "maybe-secret"})
    assert "value" not in result["elements"][0]
    assert result["elements"][0]["valueOmitted"] == "password_unknown"


def test_scroll_unknown_is_not_false() -> None:
    result = collect_semantics({"id": "scroll", "scroll": {}})
    assert result["elements"][0]["scroll"] == {"horizontal": None, "vertical": None}


def test_visited_budget_counts_non_output_nodes() -> None:
    result = collect_semantics({"id": "root", "children": [{"id": "container", "children": [{"id": "button", "name": "OK"}]}]}, max_nodes=2)
    assert result["nodesVisited"] == 3
    assert result["nodeTruncated"] is True
    assert all(item["id"] != "button" for item in result["elements"])


def test_cycle_does_not_hang() -> None:
    root: dict = {"id": "root", "children": []}
    child = {"id": "child", "children": [root]}
    root["children"] = [child]
    result = collect_semantics(root)
    assert result["nodesVisited"] == 2


def test_partial_property_keeps_node() -> None:
    result = collect_semantics({"id": "x", "role": "button", "value": object()})
    assert result["nodesReturned"] == 1
    assert result["elements"][0]["role"] == "button"


def test_emoji_serializes() -> None:
    result = collect_semantics({"id": "x", "name": "确认 ✅"})
    assert result["elements"][0]["name"] == "确认 ✅"
