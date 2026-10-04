from __future__ import annotations

from PIL import Image
import pytest

import uina_screen_mcp.capture as capture


def test_surface_failure_never_falls_back_to_visible(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(capture, "_capture_window_surface", lambda *_: (_ for _ in ()).throw(capture.WindowCaptureError("window_capture_failed", "surface failed")))
    visible_called = False

    def visible(_bounds):
        nonlocal visible_called
        visible_called = True
        return Image.new("RGB", (10, 10))

    monkeypatch.setattr(capture, "capture_pixels", visible)
    with pytest.raises(capture.WindowCaptureError, match="surface failed"):
        capture.capture_window(1, (0, 0, 10, 10), "surface")
    assert visible_called is False


def test_visible_uses_desktop_pixels_and_reports_unclipped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(capture, "_is_window_minimized", lambda _hwnd: False)
    image = Image.new("RGB", (10, 10))
    monkeypatch.setattr(capture, "capture_pixels", lambda _bounds: image)
    actual, clipped = capture.capture_window(1, (0, 0, 10, 10), "visible")
    assert actual is image
    assert clipped is False


def test_minimized_visible_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(capture, "_is_window_minimized", lambda _hwnd: True)
    with pytest.raises(capture.WindowCaptureError, match="minimized"):
        capture.capture_window(1, (0, 0, 10, 10), "visible")


def test_cursor_surface_rejected_by_contract() -> None:
    # Cursor composition is defined only for desktop-pixel captures; surface
    # callers must reject it before native work.
    with pytest.raises(ValueError, match="captureMode"):
        capture.validate_cursor_mode("surface", True)


def test_active_window_is_resolved_once() -> None:
    # The resolver receives one inventory snapshot, so active_window is stable
    # for the operation even if a later foreground window would differ.
    from uina_screen_mcp.targets import TargetResolver

    resolver = TargetResolver()
    inventory = {"foregroundHwnd": 1, "windows": [{"hwnd": 1, "pid": 2, "processCreatedAt": 3, "title": "A", "bounds": [0, 0, 10, 10]}], "displays": [], "virtualBounds": [0, 0, 10, 10]}
    resolved = resolver.resolve({"kind": "active_window"}, inventory)
    assert resolved["hwnd"] == 1
