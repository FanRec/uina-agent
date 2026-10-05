from __future__ import annotations

import io
import os
import ctypes
from ctypes import wintypes

from PIL import Image
from PIL import ImageGrab


class WindowCaptureError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def validate_cursor_mode(capture_mode: str, include_cursor: bool) -> None:
    if include_cursor and capture_mode == "surface":
        raise ValueError("invalid_arguments: captureMode=surface does not support cursor inclusion")


def _validate_bounds(bounds: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    if not isinstance(bounds, (tuple, list)) or len(bounds) != 4:
        raise ValueError("invalid_bounds: expected [left, top, right, bottom]")
    if any(isinstance(value, bool) or not isinstance(value, int) for value in bounds):
        raise ValueError("invalid_bounds: coordinates must be integers")
    left, top, right, bottom = bounds
    if right <= left or bottom <= top:
        raise ValueError("invalid_bounds: right/bottom must exceed left/top")
    return left, top, right, bottom


def prepare_png(image: Image.Image, max_dimension: int | str) -> tuple[bytes, tuple[int, int]]:
    if image.width <= 0 or image.height <= 0:
        raise ValueError("invalid_frame: captured image has no pixels")
    if max_dimension != "original" and (
        isinstance(max_dimension, bool) or not isinstance(max_dimension, int) or max_dimension < 1
    ):
        raise ValueError("maxDimension must be a positive integer or original")

    output = image
    if max_dimension != "original" and max(image.size) > max_dimension:
        scale = max_dimension / max(image.size)
        size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        output = image.resize(size, Image.Resampling.LANCZOS)
    output.load()
    buffer = io.BytesIO()
    output.save(buffer, format="PNG")
    return buffer.getvalue(), output.size


def capture_pixels(bounds: tuple[int, int, int, int]) -> Image.Image:
    requested = _validate_bounds(bounds)
    if os.name != "nt":
        raise OSError("unsupported_platform: desktop capture requires Windows")
    image = ImageGrab.grab(bbox=requested, all_screens=True)
    if image.width <= 0 or image.height <= 0:
        raise ValueError("invalid_frame: desktop capture returned an empty image")
    image.load()
    return image


def _is_window_minimized(hwnd: int) -> bool:
    if os.name != "nt":
        raise WindowCaptureError("unsupported_platform", "window capture requires Windows")
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    return bool(user32.IsIconic(hwnd))


def _capture_window_surface(hwnd: int, bounds: tuple[int, int, int, int]) -> Image.Image:
    """Capture a window surface with PrintWindow using the GPU-content flag."""
    if os.name != "nt":
        raise WindowCaptureError("unsupported_platform", "surface capture requires Windows")
    left, top, right, bottom = _validate_bounds(bounds)
    width, height = right - left, bottom - top

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
            ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG),
            ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD),
        ]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    user32.GetDC.argtypes = [wintypes.HWND]
    user32.GetDC.restype = wintypes.HDC
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    user32.ReleaseDC.restype = ctypes.c_int
    user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
    user32.PrintWindow.restype = wintypes.BOOL
    gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi32.CreateCompatibleDC.restype = wintypes.HDC
    gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
    gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
    gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    gdi32.SelectObject.restype = wintypes.HGDIOBJ
    gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi32.DeleteObject.restype = wintypes.BOOL
    gdi32.DeleteDC.argtypes = [wintypes.HDC]
    gdi32.DeleteDC.restype = wintypes.BOOL
    gdi32.GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT, ctypes.c_void_p, ctypes.POINTER(BITMAPINFO), wintypes.UINT]
    gdi32.GetDIBits.restype = ctypes.c_int

    screen_dc = user32.GetDC(0)
    if not screen_dc:
        raise WindowCaptureError("window_capture_failed", "GetDC failed")
    memory_dc = None
    bitmap = None
    old_bitmap = None
    try:
        memory_dc = gdi32.CreateCompatibleDC(screen_dc)
        bitmap = gdi32.CreateCompatibleBitmap(screen_dc, width, height)
        if not memory_dc or not bitmap:
            raise WindowCaptureError("window_capture_failed", "GDI bitmap allocation failed")
        old_bitmap = gdi32.SelectObject(memory_dc, bitmap)
        if not user32.PrintWindow(hwnd, memory_dc, 0x00000002):  # PW_RENDERFULLCONTENT
            raise WindowCaptureError("window_capture_failed", "PrintWindow returned false")
        info = BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.bmiHeader.biWidth = width
        info.bmiHeader.biHeight = height
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = 0
        raw = ctypes.create_string_buffer(width * height * 4)
        rows = gdi32.GetDIBits(memory_dc, bitmap, 0, height, raw, ctypes.byref(info), 0)
        if rows != height:
            raise WindowCaptureError("window_capture_failed", "GetDIBits returned an incomplete frame")
        image = Image.frombuffer("RGBA", (width, height), raw, "raw", "BGRA", 0, 1)
        return image.transpose(Image.Transpose.FLIP_TOP_BOTTOM).convert("RGB")
    finally:
        if memory_dc and old_bitmap:
            gdi32.SelectObject(memory_dc, old_bitmap)
        if bitmap:
            gdi32.DeleteObject(bitmap)
        if memory_dc:
            gdi32.DeleteDC(memory_dc)
        user32.ReleaseDC(0, screen_dc)


def _looks_blank(image: Image.Image) -> bool:
    sample = image.convert("RGB")
    sample.thumbnail((64, 64))
    total = sample.width * sample.height
    if total == 0:
        return True
    visible = 0
    for y in range(sample.height):
        for x in range(sample.width):
            if max(sample.getpixel((x, y))) > 8:
                visible += 1
    return visible / total < 0.005


def capture_window(hwnd: int, bounds: tuple[int, int, int, int], capture_mode: str = "surface") -> tuple[Image.Image, bool, str]:
    if capture_mode not in {"surface", "visible"}:
        raise WindowCaptureError("invalid_arguments", "captureMode must be surface or visible")
    if capture_mode == "surface":
        image = _capture_window_surface(hwnd, bounds)
        if not _looks_blank(image):
            return image, False, "printwindow"
        # GPU-composited windows may accept PrintWindow yet return an all-black
        # frame. Preserve the requested target and fall back to visible pixels.
        return capture_pixels(bounds), False, "pillow_imagegrab_fallback"
    if _is_window_minimized(hwnd):
        raise WindowCaptureError("window_capture_failed", "minimized windows have no visible surface")
    image = capture_pixels(bounds)
    return image, False, "pillow_imagegrab"


def cursor_draw_position(cursor: tuple[int, int], hotspot: tuple[int, int], capture_bounds: tuple[int, int, int, int]) -> tuple[int, int]:
    left, top, right, bottom = _validate_bounds(capture_bounds)
    if len(cursor) != 2 or len(hotspot) != 2:
        raise ValueError("invalid_cursor: cursor and hotspot must be two-dimensional")
    x, y = cursor[0] - hotspot[0] - left, cursor[1] - hotspot[1] - top
    return x, y


def add_cursor(image: Image.Image, capture_bounds: tuple[int, int, int, int]) -> tuple[Image.Image, bool]:
    """Composite the actual cursor icon into a desktop-pixel frame.

    The cursor is drawn by DrawIconEx into a top-down 32-bit DIB section, so
    hotspot and negative virtual-screen origins remain in the same physical
    coordinate space as the captured image.
    """
    if os.name != "nt":
        raise WindowCaptureError("unsupported_platform", "cursor capture requires Windows")
    _validate_bounds(capture_bounds)

    class POINT(ctypes.Structure):
        _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]

    class CURSORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("flags", wintypes.DWORD), ("hCursor", wintypes.HANDLE), ("ptScreenPos", POINT)]

    class ICONINFO(ctypes.Structure):
        _fields_ = [("fIcon", wintypes.BOOL), ("xHotspot", wintypes.DWORD), ("yHotspot", wintypes.DWORD), ("hbmMask", wintypes.HBITMAP), ("hbmColor", wintypes.HBITMAP)]

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]

    width, height = image.size
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    user32.GetCursorInfo.argtypes = [ctypes.POINTER(CURSORINFO)]
    user32.GetCursorInfo.restype = wintypes.BOOL
    user32.GetIconInfo.argtypes = [wintypes.HICON, ctypes.POINTER(ICONINFO)]
    user32.GetIconInfo.restype = wintypes.BOOL
    user32.DrawIconEx.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.HICON, ctypes.c_int, ctypes.c_int, wintypes.UINT, wintypes.HBRUSH, wintypes.UINT]
    user32.DrawIconEx.restype = wintypes.BOOL
    gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi32.CreateCompatibleDC.restype = wintypes.HDC
    gdi32.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.POINTER(BITMAPINFO), wintypes.UINT, ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
    gdi32.CreateDIBSection.restype = wintypes.HBITMAP
    gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    gdi32.SelectObject.restype = wintypes.HGDIOBJ
    gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi32.DeleteObject.restype = wintypes.BOOL
    gdi32.DeleteDC.argtypes = [wintypes.HDC]
    gdi32.DeleteDC.restype = wintypes.BOOL

    info = CURSORINFO(ctypes.sizeof(CURSORINFO), 0, None, POINT())
    if not user32.GetCursorInfo(ctypes.byref(info)) or not info.hCursor or not info.flags:
        return image, False
    icon = ICONINFO()
    if not user32.GetIconInfo(info.hCursor, ctypes.byref(icon)):
        raise WindowCaptureError("cursor_not_supported", "GetIconInfo failed")
    left, top, _, _ = capture_bounds
    screen_dc = None
    memory_dc = None
    bitmap = None
    old = None
    try:
        screen_dc = user32.GetDC(0)
        memory_dc = gdi32.CreateCompatibleDC(screen_dc)
        bmi = BITMAPINFO()
        bmi.bmiHeader = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), width, -height, 1, 32, 0, width * height * 4, 0, 0, 0, 0)
        bits = ctypes.c_void_p()
        bitmap = gdi32.CreateDIBSection(memory_dc, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
        if not screen_dc or not memory_dc or not bitmap or not bits.value:
            raise WindowCaptureError("cursor_not_supported", "DIB allocation failed")
        old = gdi32.SelectObject(memory_dc, bitmap)
        source = image.convert("RGBA").tobytes("raw", "BGRA")
        ctypes.memmove(bits.value, source, len(source))
        x = int(info.ptScreenPos.x) - int(icon.xHotspot) - left
        y = int(info.ptScreenPos.y) - int(icon.yHotspot) - top
        if not user32.DrawIconEx(memory_dc, x, y, info.hCursor, 0, 0, 0, None, 0x0003):
            raise WindowCaptureError("cursor_not_supported", "DrawIconEx failed")
        result = Image.frombuffer("RGBA", (width, height), ctypes.string_at(bits.value, width * height * 4), "raw", "BGRA", 0, 1).convert("RGB")
        return result, True
    finally:
        if memory_dc and old:
            gdi32.SelectObject(memory_dc, old)
        if bitmap:
            gdi32.DeleteObject(bitmap)
        if memory_dc:
            gdi32.DeleteDC(memory_dc)
        if screen_dc:
            user32.ReleaseDC(0, screen_dc)
        if icon.hbmMask:
            gdi32.DeleteObject(icon.hbmMask)
        if icon.hbmColor:
            gdi32.DeleteObject(icon.hbmColor)


def worker_capture(payload: dict[str, object]) -> dict[str, object]:
    """Capture and encode one already-resolved region inside the worker process."""
    raw_bounds = payload.get("bounds")
    if not isinstance(raw_bounds, (list, tuple)):
        raise ValueError("invalid_bounds: capture payload is missing bounds")
    bounds = _validate_bounds(tuple(raw_bounds))
    max_dimension = payload.get("maxDimension", 1920)
    if payload.get("hwnd") is not None:
        image, clipped, source = capture_window(int(payload["hwnd"]), bounds, str(payload.get("captureMode", "surface")))
    else:
        image, clipped, source = capture_pixels(bounds), False, "pillow_imagegrab"
    cursor_included = False
    if payload.get("includeCursor"):
        image, cursor_included = add_cursor(image, bounds)
    png, output_size = prepare_png(image, max_dimension if isinstance(max_dimension, (int, str)) else 1920)
    return {
        "image": {
            "status": "ok",
            "valid": True,
            "surface": "desktop_pixels",
            "bounds": list(bounds),
            "originalSize": list(image.size),
            "outputSize": list(output_size),
            "source": source,
            "clipped": clipped,
            "cursor": cursor_included,
        },
        "pngBase64": __import__("base64").b64encode(png).decode("ascii"),
    }
