from __future__ import annotations

import base64

import pytest

from uina_screen_mcp.server import ScreenService


class FakeRunner:
    def __init__(self, responses: dict[str, dict]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict, float]] = []

    async def run(self, operation: str, payload: dict, timeout_s: float) -> dict:
        self.calls.append((operation, payload, timeout_s))
        response = self.responses[operation]
        return response.copy()

    async def close(self) -> None:
        return None


def inventory() -> dict:
    return {
        "virtualBounds": [0, 0, 20, 10],
        "foregroundHwnd": 10,
        "displays": [{"id": "DISPLAY-A", "bounds": [0, 0, 20, 10]}],
        "windows": [],
    }


def window_inventory() -> dict:
    result = inventory()
    result["windows"] = [{
        "hwnd": 10,
        "pid": 20,
        "processCreatedAt": 30,
        "app": "test.exe",
        "title": "Test",
        "bounds": [0, 0, 20, 10],
        "foreground": True,
        "minimized": False,
    }]
    return result


@pytest.mark.asyncio
async def test_screenshot_emits_text_image_and_structured_content() -> None:
    png = b"png-fixture"
    runner = FakeRunner({"capture": {"ok": True, "payload": {"image": {"status": "ok", "valid": True, "bounds": [0, 0, 20, 10], "originalSize": [20, 10], "outputSize": [20, 10], "source": "fixture"}, "pngBase64": base64.b64encode(png).decode()}, "error": None}})
    service = ScreenService(runner=runner, inventory_provider=inventory)
    result = await service.call("Screenshot", {})
    assert result.isError is False
    assert result.structuredContent["status"] == "ok"
    assert any(getattr(item, "type", None) == "image" for item in result.content)
    assert [call[0] for call in runner.calls] == ["capture"]


@pytest.mark.asyncio
async def test_invalid_arguments_never_run_query() -> None:
    runner = FakeRunner({})
    service = ScreenService(runner=runner, inventory_provider=inventory)
    result = await service.call("Screenshot", {"maxDimension": 0})
    assert result.isError is True
    assert runner.calls == []


@pytest.mark.asyncio
async def test_snapshot_semantic_only_never_captures() -> None:
    runner = FakeRunner({"semantics": {"ok": True, "payload": {"scope": "window", "source": "fixture", "elements": []}, "error": None}})
    service = ScreenService(runner=runner, inventory_provider=window_inventory)
    result = await service.call("Snapshot", {"target": {"kind": "active_window"}, "includeImage": False})
    assert result.isError is False
    assert result.structuredContent["status"] == "ok"
    assert [call[0] for call in runner.calls] == ["semantics"]


@pytest.mark.asyncio
async def test_snapshot_image_ok_semantics_unavailable_is_partial() -> None:
    runner = FakeRunner({
        "capture": {"ok": True, "payload": {"image": {"status": "ok", "valid": True}, "pngBase64": base64.b64encode(b"x").decode()}, "error": None},
        "semantics": {"ok": False, "payload": None, "error": {"code": "semantic_unavailable", "message": "no tree"}},
    })
    service = ScreenService(runner=runner, inventory_provider=window_inventory)
    result = await service.call("Snapshot", {"target": {"kind": "active_window"}})
    assert result.isError is False
    assert result.structuredContent["status"] == "partial"
    assert "semantic_unavailable" in result.content[0].text


@pytest.mark.asyncio
async def test_capture_without_png_bytes_is_not_reported_as_success() -> None:
    runner = FakeRunner({"capture": {"ok": True, "payload": {"image": {"status": "ok", "valid": True}}, "error": None}})
    service = ScreenService(runner=runner, inventory_provider=inventory)
    result = await service.call("Screenshot", {})
    assert result.isError is True
    assert result.structuredContent["status"] == "failed"
    assert result.structuredContent["image"]["status"] == "failed"


@pytest.mark.asyncio
async def test_snapshot_region_returns_partial_without_running_semantic_worker() -> None:
    runner = FakeRunner({
        "capture": {
            "ok": True,
            "payload": {"image": {"status": "ok", "valid": True}, "pngBase64": base64.b64encode(b"x").decode()},
            "error": None,
        },
    })
    service = ScreenService(runner=runner, inventory_provider=inventory)

    result = await service.call("Snapshot", {"target": {"kind": "region", "rect": [0, 0, 10, 10]}})

    assert result.isError is False
    assert result.structuredContent["status"] == "partial"
    assert result.structuredContent["semantics"]["errors"][0]["code"] == "semantic_requires_window"
    assert [call[0] for call in runner.calls] == ["capture"]
