from __future__ import annotations

import pytest

from uina_screen_mcp.targets import TargetResolver, validate_region


def facts(hwnd: int = 10, pid: int = 22, created: int = 100, title: str = "Editor") -> dict:
    return {"hwnd": hwnd, "pid": pid, "processCreatedAt": created, "app": "editor.exe", "title": title,
            "bounds": [-1920, 0, 0, 1080], "minimized": False, "foreground": hwnd == 10}


def inventory(*windows: dict, foreground: int | None = 10) -> dict:
    return {"virtualBounds": [-1920, 0, 3840, 2160], "foregroundHwnd": foreground,
            "displays": [
                {"id": "DISPLAY-A", "bounds": [-1920, 0, 0, 1080], "dpi": 96, "scale": 1.0},
                {"id": "DISPLAY-B", "bounds": [0, 0, 3840, 2160], "dpi": 144, "scale": 1.5},
            ], "windows": list(windows)}


def test_match_zero_one_many() -> None:
    resolver = TargetResolver()
    with pytest.raises(ValueError, match="target_not_found"):
        resolver.resolve({"kind": "window", "match": {"app": "missing.exe"}}, inventory())
    one = resolver.resolve({"kind": "window", "match": {"app": "EDITOR.EXE"}}, inventory(facts()))
    assert one["title"] == "Editor"
    with pytest.raises(ValueError, match="target_ambiguous"):
        resolver.resolve({"kind": "window", "match": {"app": "editor.exe"}}, inventory(facts(), facts(hwnd=11, title="Editor 2")))


def test_ref_rejects_reused_handle() -> None:
    resolver = TargetResolver()
    ref = resolver.remember_window(facts())
    with pytest.raises(ValueError, match="stale_target"):
        resolver.resolve({"kind": "window", "ref": ref}, inventory(facts(pid=99, created=101)))


def test_title_change_keeps_ref() -> None:
    resolver = TargetResolver()
    ref = resolver.remember_window(facts())
    resolved = resolver.resolve({"kind": "window", "ref": ref}, inventory(facts(title="New title")))
    assert resolved["title"] == "New title"
    assert resolved["hwnd"] == 10


def test_region_requires_full_containment() -> None:
    displays = [[-100, 0, 0, 100], [0, 0, 100, 100]]
    assert validate_region((-50, 10, 50, 90), displays) == (-50, 10, 50, 90)
    with pytest.raises(ValueError, match="invalid_region"):
        validate_region((-101, 10, -50, 90), displays)
    with pytest.raises(ValueError, match="invalid_region"):
        validate_region((50, 10, 40, 90), displays)


def test_mixed_dpi_does_not_rescale_pixels() -> None:
    resolver = TargetResolver()
    result = resolver.resolve({"kind": "display", "id": "DISPLAY-B"}, inventory())
    assert result["bounds"] == [0, 0, 3840, 2160]
    assert result["dpi"] == 144


def test_display_gap_is_not_a_physical_monitor() -> None:
    with pytest.raises(ValueError, match="invalid_region"):
        validate_region((110, 10, 190, 90), [[0, 0, 100, 100], [200, 0, 300, 100]])
    assert validate_region((90, 10, 210, 90), [[0, 0, 100, 100], [200, 0, 300, 100]]) == (90, 10, 210, 90)
