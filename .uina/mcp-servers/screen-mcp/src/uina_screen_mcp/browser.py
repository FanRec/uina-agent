from __future__ import annotations

import os
import sys
from collections import deque
from typing import Any, Hashable

from .semantics import collect_semantics


def _runtime_identity(control: Any) -> Hashable:
    try:
        runtime_id = control.GetRuntimeId()
        if runtime_id:
            return ("runtime", tuple(int(part) for part in runtime_id))
    except Exception:
        pass
    return ("object", id(control))


def _is_page_root(control: Any) -> bool:
    class_name = str(getattr(control, "ClassName", "")).casefold()
    # Chromium/Edge expose the actual web content through this HWND class.
    # Generic DocumentControl/WebControl nodes also occur in browser chrome.
    return class_name in {"chrome_renderwidgethosthwnd", "mozaccesstoolkit"}


def _discover_page_roots(window: Any) -> list[Any]:
    """Discover browser page roots with stable UIA identities and strong refs."""
    roots: list[Any] = []
    queue: deque[Any] = deque([window])
    retained: dict[Hashable, Any] = {_runtime_identity(window): window}
    visited: set[Hashable] = set()
    while queue:
        control = queue.popleft()
        identity = _runtime_identity(control)
        if identity in visited:
            continue
        visited.add(identity)
        if _is_page_root(control):
            roots.append(control)
        try:
            children = control.GetChildren()
        except Exception:
            continue
        for child in children:
            child_identity = _runtime_identity(child)
            if child_identity not in retained:
                retained[child_identity] = child
                queue.append(child)
    return roots


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
    roots = _discover_page_roots(window)
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
