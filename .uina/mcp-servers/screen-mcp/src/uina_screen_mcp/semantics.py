from __future__ import annotations

import os
import sys
from collections import deque
from typing import Any, Iterable


def _text(value: Any, limit: int | str) -> tuple[str | None, bool]:
    if value is None:
        return None, False
    value = str(value)
    if limit == "all" or len(value) <= int(limit):
        return value, False
    return value[: int(limit)], True


def collect_semantics(root: Any, max_nodes: int | str = 1200, max_text_chars: int | str = 500) -> dict[str, Any]:
    """Normalize a tree while making visited-node and text budgets explicit.

    The input is deliberately a small adapter shape, so pure tests do not need
    COM objects and the worker can keep UIA ownership in one process/thread.
    """
    queue: deque[tuple[Any, str | None]] = deque([(root, None)])
    visited: set[Any] = set()
    elements: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    node_truncated = False
    text_truncated = False
    visit_limit = None if max_nodes == "all" else int(max_nodes)
    while queue:
        node, parent_id = queue.popleft()
        if node is None:
            continue
        identity = node.get("id") if isinstance(node, dict) else id(node)
        if identity in visited:
            continue
        visited.add(identity)
        if visit_limit is not None and len(visited) > visit_limit:
            node_truncated = True
            break
        if not isinstance(node, dict):
            errors.append({"code": "node_unreadable", "message": "semantic node was not an object"})
            continue
        item: dict[str, Any] = {"id": str(identity), "parentId": parent_id}
        for key in ("role", "name", "bounds", "focused", "enabled", "selected"):
            if key in node and node[key] is not None:
                item[key] = node[key]

        password_known = node.get("passwordKnown", False)
        password = node.get("isPassword") if password_known else None
        if password is True or password is None:
            if node.get("value") is not None:
                item["valueOmitted"] = "password" if password is True else "password_unknown"
        else:
            try:
                value, was_truncated = _text(node.get("value"), max_text_chars)
                if value is not None:
                    item["value"] = value
                text_truncated = text_truncated or was_truncated
            except Exception as exc:
                errors.append({"code": "value_unavailable", "message": str(exc)})

        scroll = node.get("scroll")
        if isinstance(scroll, dict):
            item["scroll"] = {key: scroll[key] for key in ("horizontal", "vertical") if key in scroll and isinstance(scroll[key], bool)}
            if not item["scroll"]:
                item["scroll"] = {"horizontal": None, "vertical": None}
        else:
            item["scroll"] = {"horizontal": None, "vertical": None}
        elements.append(item)
        children = node.get("children", [])
        try:
            for child in children:
                queue.append((child, str(identity)))
        except Exception as exc:
            errors.append({"code": "children_unavailable", "message": str(exc)})
    return {
        "source": "uia_fixture",
        "scope": "window",
        "nodesVisited": len(visited),
        "nodesReturned": len(elements),
        "nodeTruncated": node_truncated,
        "textTruncated": text_truncated,
        "errors": errors,
        "elements": elements,
    }


def _control_value(control: Any, password: bool | None) -> Any:
    if password is not False:
        return None
    for attr in ("Value", "LegacyIAccessibleValue"):
        try:
            value = getattr(control, attr)
            if value:
                return value
        except Exception:
            continue
    return None


def _control_password(control: Any) -> bool | None:
    try:
        value = getattr(control, "IsPassword")
        return bool(value)
    except Exception:
        return None


def _control_to_raw(control: Any) -> dict[str, Any]:
    password = _control_password(control)
    raw: dict[str, Any] = {
        "id": None,
        "role": getattr(control, "ControlTypeName", None),
        "name": getattr(control, "Name", None),
        "bounds": list(getattr(control, "BoundingRectangle", ())) or None,
        "isPassword": password,
        "passwordKnown": password is not None,
        "value": _control_value(control, password),
        "children": [],
    }
    try:
        runtime_id = control.GetRuntimeId()
        raw["id"] = ":".join(str(part) for part in runtime_id)
    except Exception:
        raw["id"] = str(id(control))
    try:
        raw["children"] = [_control_to_raw(child) for child in control.GetChildren()]
    except Exception:
        raw["children"] = []
    return raw


def read_window_semantics(hwnd: int, bounds: Any, options: dict[str, Any]) -> dict[str, Any]:
    if os.name != "nt":
        raise RuntimeError("semantic_unavailable: UI Automation requires Windows")
    sys.coinit_flags = 0
    import uiautomation as auto  # noqa: PLC0415

    root = auto.ControlFromHandle(hwnd)
    if root is None:
        raise RuntimeError("semantic_unavailable: UIA returned no window root")
    result = collect_semantics(_control_to_raw(root), options.get("maxNodes", 1200), options.get("maxTextChars", 500))
    result["source"] = "uia"
    return result
