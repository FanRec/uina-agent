"""Lazy Firefox MSAA/IAccessible page fallback.

This module intentionally has no import-time COM or oleacc side effects. It is
loaded only after UIA did not expose a single page root.
"""

from __future__ import annotations

import ctypes
import os
import sys
from collections import deque
from ctypes import wintypes
from typing import Any

ROLE_DOCUMENT = 0x0F
ROLE_LINK = 0x1E
ROLE_LISTITEM = 0x22
ROLE_PUSHBUTTON = 0x2B
ROLE_CHECKBUTTON = 0x2C
ROLE_RADIOBUTTON = 0x2D
ROLE_COMBOBOX = 0x2E
ROLE_DROPLIST = 0x2F
ROLE_SLIDER = 0x33
ROLE_STATICTEXT = 0x29
ROLE_TEXT = 0x2A
STATE_INVISIBLE = 0x00008000
STATE_OFFSCREEN = 0x00010000
OBJID_CLIENT = 0xFFFFFFFC
CHILDID_SELF = 0

ROLE_NAMES = {
    ROLE_DOCUMENT: "document", ROLE_LINK: "link", ROLE_LISTITEM: "list item",
    ROLE_PUSHBUTTON: "button", ROLE_CHECKBUTTON: "check box", ROLE_RADIOBUTTON: "radio button",
    ROLE_COMBOBOX: "combo box", ROLE_DROPLIST: "drop list", ROLE_SLIDER: "slider",
    ROLE_STATICTEXT: "text", ROLE_TEXT: "text",
}


def _load_accessibility() -> tuple[Any, Any]:
    import comtypes.client  # noqa: PLC0415
    comtypes.client.GetModule("oleacc.dll")
    from comtypes.gen import Accessibility  # type: ignore[attr-defined]  # noqa: PLC0415

    oleacc = ctypes.WinDLL("oleacc", use_last_error=True)
    oleacc.AccessibleObjectFromWindow.argtypes = None
    return Accessibility.IAccessible, oleacc


def _role_name(role: Any) -> str:
    if isinstance(role, str):
        return role.strip().lower() or "unknown"
    return ROLE_NAMES.get(int(role), "unknown") if isinstance(role, int) else "unknown"


def _value(obj: Any, attr: str, default: Any = None) -> Any:
    try:
        return getattr(obj, attr)(CHILDID_SELF) if attr.startswith("acc") else getattr(obj, attr)
    except Exception:
        return default


def _acquire(hwnd: int, iface: Any, oleacc: Any) -> Any:
    from comtypes import POINTER  # noqa: PLC0415

    pointer = POINTER(iface)()
    hr = oleacc.AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, ctypes.byref(iface._iid_), ctypes.byref(pointer))
    if hr != 0 or not pointer:
        raise RuntimeError(f"AccessibleObjectFromWindow failed: HRESULT=0x{int(hr) & 0xFFFFFFFF:08X}")
    return pointer


def read_page(hwnd: int, bounds: Any, options: dict[str, Any]) -> dict[str, Any]:
    if os.name != "nt":
        raise RuntimeError("page_structure_unavailable: IA2 requires Windows")
    sys.coinit_flags = 0
    iface, oleacc = _load_accessibility()
    root = _acquire(hwnd, iface, oleacc)
    limit = options.get("maxNodes", 1200)
    text_limit = options.get("maxTextChars", 500)
    queue: deque[tuple[Any, str | None, bool]] = deque([(root, None, False)])
    # Keep every COM wrapper alive while traversing: id(obj) is only safe when
    # wrappers cannot be collected and their addresses reused.
    retained: list[Any] = [root]
    seen: set[int] = set()
    elements: list[dict[str, Any]] = []
    truncated = False
    text_truncated = False
    while queue:
        obj, parent, in_document = queue.popleft()
        identity = id(obj)
        if identity in seen:
            continue
        seen.add(identity)
        if limit != "all" and len(seen) > int(limit):
            truncated = True
            break
        role = _value(obj, "accRole", -1)
        state = _value(obj, "accState", 0) or 0
        if state & (STATE_INVISIBLE | STATE_OFFSCREEN):
            continue
        role_label = _role_name(role)
        is_document = role == ROLE_DOCUMENT
        inside_document = in_document or is_document
        name = str(_value(obj, "accName", "") or "").strip()
        value = str(_value(obj, "accValue", "") or "").strip()
        if inside_document and (name or value or role_label in {"document", "link", "button"}):
            item: dict[str, Any] = {"id": str(identity), "parentId": parent, "role": role_label}
            if name:
                item["name"] = name
            if value and role not in {ROLE_TEXT, ROLE_STATICTEXT}:
                if text_limit != "all" and len(value) > int(text_limit):
                    value = value[: int(text_limit)]
                    text_truncated = True
                item["value"] = value
            item["scroll"] = {"horizontal": None, "vertical": None}
            elements.append(item)
        try:
            count = int(obj.accChildCount)
        except Exception:
            count = 0
        for index in range(1, max(0, count) + 1):
            try:
                child = obj.accChild(index)
                if child is not None and hasattr(child, "QueryInterface"):
                    child_object = child.QueryInterface(iface)
                    retained.append(child_object)
                    queue.append((child_object, str(identity), inside_document))
            except Exception:
                continue
    if not elements:
        raise RuntimeError("page_structure_unavailable: no visible IA2 document nodes were found")
    return {
        "source": "browser_msaa_ia2", "scope": "page", "nodesVisited": len(seen),
        "nodesReturned": len(elements), "nodeTruncated": truncated,
        "textTruncated": text_truncated, "errors": [], "elements": elements,
    }
