from __future__ import annotations

import os
import sys
from typing import Any

from .semantics import collect_semantics


def read_page_semantics(hwnd: int, bounds: Any, options: dict[str, Any]) -> dict[str, Any]:
    """Return only an identifiable accessible page root; never browser chrome."""
    page_roots = options.get("pageRoots")
    if page_roots is not None:
        if not isinstance(page_roots, list) or len(page_roots) != 1:
            raise RuntimeError("page_structure_unavailable: page_root_ambiguous")
        result = collect_semantics(page_roots[0], options.get("maxNodes", 1200), options.get("maxTextChars", 500))
        result["source"] = options.get("source", "browser_uia")
        result["scope"] = "page"
        return result
    if os.name != "nt":
        raise RuntimeError("page_structure_unavailable: browser accessibility requires Windows")
    sys.coinit_flags = 0
    import uiautomation as auto  # noqa: PLC0415

    try:
        window = auto.ControlFromHandle(hwnd)
    except Exception as exc:
        raise RuntimeError("page_structure_unavailable: no accessible page root was found") from exc
    if window is None:
        raise RuntimeError("page_structure_unavailable: no browser window root was found")
    roots: list[Any] = []
    queue = [window]
    visited: set[int] = set()
    while queue:
        control = queue.pop(0)
        identity = id(control)
        if identity in visited:
            continue
        visited.add(identity)
        role = str(getattr(control, "ControlTypeName", ""))
        class_name = str(getattr(control, "ClassName", ""))
        if role.casefold() in {"documentcontrol", "webcontrol"} or class_name.casefold() in {"chrome_renderwidgethosthwnd", "mozaccesstoolkit"}:
            roots.append(control)
        try:
            queue.extend(control.GetChildren())
        except Exception:
            continue
    if len(roots) == 0:
        # Firefox exposes its document through MSAA/IAccessible2 rather than
        # the RootWebArea marker used by Chromium. Keep the import lazy so
        # ordinary UIA snapshots never load oleacc/comtypes.
        try:
            from .ia2 import read_page as read_ia2_page  # noqa: PLC0415

            return read_ia2_page(hwnd, bounds, options)
        except Exception as exc:
            raise RuntimeError("page_structure_unavailable: no accessible page root was found") from exc
    if len(roots) > 1:
        raise RuntimeError("page_structure_unavailable: page_root_ambiguous")
    from .semantics import _control_to_raw  # noqa: PLC0415
    result = collect_semantics(_control_to_raw(roots[0]), options.get("maxNodes", 1200), options.get("maxTextChars", 500))
    result["source"] = "browser_uia"
    result["scope"] = "page"
    return result
