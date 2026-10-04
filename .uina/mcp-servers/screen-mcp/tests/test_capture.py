from __future__ import annotations

from PIL import Image
import pytest

from uina_screen_mcp.capture import capture_pixels, cursor_draw_position, prepare_png


def test_prepare_png_bounded_default() -> None:
    large = Image.new("RGB", (2560, 1440), "black")
    png, size = prepare_png(large, 1920)
    assert size == (1920, 1080)
    with Image.open(__import__("io").BytesIO(png)) as decoded:
        assert decoded.size == size
    assert prepare_png(Image.new("RGB", (1400, 900)), 1920)[1] == (1400, 900)
    assert prepare_png(large, "original")[1] == (2560, 1440)
    assert prepare_png(large, 4000)[1] == (2560, 1440)


def test_crop_preserves_negative_origin(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}
    expected = Image.new("RGB", (800, 600), "navy")
    def grab(**kwargs):
        seen.update(kwargs)
        return expected
    monkeypatch.setattr("PIL.ImageGrab.grab", grab)
    result = capture_pixels((-1280, -200, -480, 400))
    assert result is expected
    assert seen == {"bbox": (-1280, -200, -480, 400), "all_screens": True}


def test_black_image_is_valid() -> None:
    png, size = prepare_png(Image.new("RGB", (10, 10), "black"), 1920)
    assert size == (10, 10)
    with Image.open(__import__("io").BytesIO(png)) as decoded:
        decoded.load()
        assert decoded.getpixel((0, 0)) == (0, 0, 0)


def test_invalid_frame_is_error() -> None:
    with pytest.raises(ValueError, match="invalid_frame"):
        prepare_png(Image.new("RGB", (0, 10)), 1920)
    with pytest.raises(ValueError, match="maxDimension"):
        prepare_png(Image.new("RGB", (10, 10)), 0)


def test_cursor_uses_hotspot_and_crop_origin() -> None:
    assert cursor_draw_position((100, 50), (4, 7), (80, 20, 200, 100)) == (16, 23)
