from __future__ import annotations

import ntpath
import secrets
from typing import Any

Rect = tuple[int, int, int, int]


def _rect(value: Any) -> Rect:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError("invalid_region: rect must contain four coordinates")
    if any(isinstance(item, bool) or not isinstance(item, int) for item in value):
        raise ValueError("invalid_region: rect coordinates must be integers")
    left, top, right, bottom = value
    if right <= left or bottom <= top:
        raise ValueError("invalid_region: right/bottom must be greater than left/top")
    return left, top, right, bottom


def _intersection(a: Rect, b: Rect) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _union(rects: list[Rect]) -> Rect | None:
    if not rects:
        return None
    return min(r[0] for r in rects), min(r[1] for r in rects), max(r[2] for r in rects), max(r[3] for r in rects)


def validate_region(rect: Rect, display_rects: list[list[int] | tuple[int, int, int, int]]) -> Rect:
    requested = _rect(rect)
    displays = [_rect(display) for display in display_rects]
    bounds = _union(displays)
    if bounds is None:
        raise ValueError("invalid_region: no physical displays are available")
    if requested[0] < bounds[0] or requested[1] < bounds[1] or requested[2] > bounds[2] or requested[3] > bounds[3]:
        raise ValueError("invalid_region: region must be fully inside virtual desktop bounds")
    if not any(_intersection(requested, display) for display in displays):
        raise ValueError("invalid_region: region does not intersect a physical display")
    return requested


class TargetResolver:
    """Resolve explicit target requests and hold opaque refs for this server process only."""

    def __init__(self) -> None:
        self._refs: dict[str, tuple[int, int, int]] = {}
        self._identity_refs: dict[tuple[int, int, int], str] = {}

    def remember_window(self, facts: dict[str, Any]) -> str:
        hwnd = facts.get("hwnd")
        pid = facts.get("pid")
        created = facts.get("processCreatedAt")
        if any(isinstance(v, bool) or not isinstance(v, int) or v <= 0 for v in (hwnd, pid, created)):
            raise ValueError("target_identity_unavailable: a reliable window reference requires HWND, PID, and process creation identity")
        identity = (hwnd, pid, created)
        ref = self._identity_refs.get(identity)
        if ref is None:
            ref = "w-" + secrets.token_hex(6)
            self._identity_refs[identity] = ref
            self._refs[ref] = identity
        return ref

    def resolve(self, target: dict[str, Any], inventory: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(target, dict) or not isinstance(inventory, dict):
            raise ValueError("invalid_arguments: target and inventory must be objects")
        kind = target.get("kind")
        displays = [d for d in inventory.get("displays", []) if isinstance(d, dict)]
        windows = [w for w in inventory.get("windows", []) if isinstance(w, dict)]
        display_rects = [d["bounds"] for d in displays if d.get("bounds") is not None]
        desktop_bounds = inventory.get("virtualBounds") or _union([_rect(r) for r in display_rects])
        if kind == "desktop":
            if desktop_bounds is None:
                raise ValueError("target_not_found: no physical displays are available")
            return {"kind": "desktop", "bounds": list(_rect(desktop_bounds)), "displays": displays}
        if kind == "display":
            found = next((d for d in displays if d.get("id") == target.get("id")), None)
            if found is None:
                raise ValueError("target_not_found: display id is no longer available; call ListTargets")
            return {"kind": "display", **found}
        if kind == "region":
            validated = validate_region(tuple(target.get("rect", ())), display_rects)
            return {"kind": "region", "bounds": list(validated)}
        if kind == "active_window":
            hwnd = inventory.get("foregroundHwnd")
            matches = [window for window in windows if window.get("hwnd") == hwnd]
            if len(matches) != 1:
                raise ValueError("target_not_found: no current foreground top-level window is available")
            return self._window_result(matches[0])
        if kind != "window":
            raise ValueError(f"invalid_arguments: unsupported target kind {kind!r}")
        if "ref" in target:
            identity = self._refs.get(target["ref"])
            if identity is None:
                raise ValueError("stale_target: window ref is unknown or expired; call ListTargets")
            hwnd, pid, created = identity
            current = next((w for w in windows if w.get("hwnd") == hwnd), None)
            if current is None or (current.get("hwnd"), current.get("pid"), current.get("processCreatedAt")) != identity:
                self._refs.pop(target["ref"], None)
                self._identity_refs.pop(identity, None)
                raise ValueError("stale_target: window identity changed; call ListTargets")
            return self._window_result(current, ref=target["ref"])
        match = target.get("match")
        if not isinstance(match, dict):
            raise ValueError("invalid_arguments: window target requires ref or match")
        app = match.get("app")
        title_part = match.get("titleContains")
        candidates = []
        for window in windows:
            names = {str(window.get(key, "")).casefold() for key in ("app", "appDisplayName", "displayName") if window.get(key)}
            if app and ntpath.basename(app).casefold() not in names and app.casefold() not in names:
                continue
            if title_part and title_part.casefold() not in str(window.get("title", "")).casefold():
                continue
            candidates.append(window)
        if not candidates:
            raise ValueError("target_not_found: no window matches the requested app/title")
        if len(candidates) > 1:
            simplified = [{k: w.get(k) for k in ("hwnd", "pid", "app", "title", "bounds")} for w in candidates]
            raise ValueError(f"target_ambiguous: multiple windows match; choose a returned ref: {simplified}")
        selected = candidates[0]
        ref = None
        try:
            ref = self.remember_window(selected)
        except ValueError:
            pass
        return self._window_result(selected, ref=ref)

    @staticmethod
    def _window_result(facts: dict[str, Any], ref: str | None = None) -> dict[str, Any]:
        if facts.get("minimized"):
            raise ValueError("target_not_found: selected window is minimized")
        result = {key: facts.get(key) for key in ("hwnd", "pid", "processCreatedAt", "app", "appDisplayName", "title", "bounds", "foreground", "minimized")}
        result["kind"] = "window"
        if ref is not None:
            result["ref"] = ref
        return result
