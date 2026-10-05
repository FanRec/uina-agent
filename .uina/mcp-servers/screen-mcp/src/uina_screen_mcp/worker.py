from __future__ import annotations

import asyncio
import ctypes
import json
import os
import sys
import time
from ctypes import wintypes
from pathlib import Path
from typing import Any, Sequence

ALLOWED_OPERATIONS = frozenset({"enumerate", "capture", "semantics", "page"})


def default_worker_command(executable: str | None = None) -> list[str]:
    """Resolve the interpreter behind a Python console-script launcher.

    ``sys.executable`` is normally the venv interpreter, but Windows console
    script launchers can report their own ``.exe`` path. Starting that path
    with ``-m`` launches the MCP server entry point again instead of this
    worker module. The sibling ``python.exe`` is the interpreter installed in
    the same venv and keeps the worker on the server's dependency environment.
    """
    current = Path(executable or sys.executable)
    if current.name.lower() in {"python", "python.exe", "pythonw", "pythonw.exe"}:
        interpreter = current
    else:
        interpreter = current.with_name("python.exe")
        if not interpreter.is_file():
            raise RuntimeError(f"cannot resolve Python interpreter for native worker: {current}")
    return [str(interpreter), "-m", "uina_screen_mcp.worker"]


def _stderr_summary(stderr: bytes, limit: int = 1000) -> str:
    """Keep native launch failures actionable without flooding the MCP result."""
    text = stderr.decode("utf-8", errors="replace").strip()
    if len(text) <= limit:
        return text
    return f"...{text[-limit:]}"


def _response_bytes(response: dict[str, Any]) -> bytes:
    """Encode the worker protocol independently of the Windows console code page."""
    return (json.dumps(response, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


class QueryRunner:
    """Own serialized native worker processes and always reap each child before returning."""

    def __init__(self, worker_command: Sequence[str] | None = None) -> None:
        self._worker_command = list(worker_command) if worker_command else default_worker_command()
        self._lock = asyncio.Lock()
        self._children: set[asyncio.subprocess.Process] = set()
        self._active_process: asyncio.subprocess.Process | None = None
        self._active_communication: asyncio.Task[tuple[bytes, bytes]] | None = None
        self._closing = False

    async def run(self, operation: str, payload: dict[str, Any], timeout_s: float) -> dict[str, Any]:
        if operation not in ALLOWED_OPERATIONS:
            raise ValueError(f"unsupported worker operation: {operation}")
        if timeout_s <= 0:
            raise ValueError("timeout_s must be positive")
        if self._closing:
            raise RuntimeError("query runner is closing")
        async with self._lock:
            if self._closing:
                raise RuntimeError("query runner is closing")
            kwargs: dict[str, Any] = {}
            if os.name == "nt":
                kwargs["creationflags"] = getattr(ctypes, "CREATE_NO_WINDOW", 0x08000000)
            process = await asyncio.create_subprocess_exec(
                *self._worker_command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                **kwargs,
            )
            self._children.add(process)
            self._active_process = process
            request = json.dumps({"operation": operation, "payload": payload}, separators=(",", ":")).encode("utf-8") + b"\n"
            communication = asyncio.create_task(process.communicate(request))
            self._active_communication = communication
            started = time.perf_counter()
            try:
                stdout, stderr = await asyncio.wait_for(asyncio.shield(communication), timeout_s)
            except asyncio.TimeoutError as exc:
                await self._cleanup_shielded(process, communication)
                raise TimeoutError(f"{operation} worker exceeded {timeout_s:g}s and was reaped") from exc
            except asyncio.CancelledError:
                await self._cleanup_shielded(process, communication)
                raise
            finally:
                self._children.discard(process)
                if self._active_process is process:
                    self._active_process = None
                    self._active_communication = None
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            if process.returncode != 0:
                stderr_text = _stderr_summary(stderr)
                message = f"Worker exited with code {process.returncode}"
                if stderr_text:
                    message = f"{message}: {stderr_text}"
                return {
                    "ok": False,
                    "payload": None,
                    "diagnostics": {"elapsedMs": elapsed_ms, "stderrBytes": len(stderr)},
                    "error": {"code": "worker_failed", "message": message},
                }
            try:
                lines = [line for line in stdout.splitlines() if line.strip()]
                if len(lines) != 1:
                    raise ValueError("worker must emit exactly one JSON response line")
                result = json.loads(lines[0])
                if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                    raise ValueError("worker response has an invalid envelope")
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                return {"ok": False, "payload": None, "diagnostics": {"elapsedMs": elapsed_ms, "stderrBytes": len(stderr), "stdoutBytes": len(stdout)}, "error": {"code": "worker_protocol_error", "message": "Native worker returned an invalid response"}}
            diagnostics = result.get("diagnostics") if isinstance(result.get("diagnostics"), dict) else {}
            diagnostics = {**diagnostics, "elapsedMs": elapsed_ms, "stderrBytes": len(stderr)}
            return {**result, "diagnostics": diagnostics}

    async def _cleanup_shielded(self, process: asyncio.subprocess.Process, communication: asyncio.Task[tuple[bytes, bytes]] | None) -> None:
        cleanup = asyncio.create_task(self._terminate_and_reap(process, communication))
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                continue
        cleanup.result()

    async def _terminate_and_reap(self, process: asyncio.subprocess.Process, communication: asyncio.Task[tuple[bytes, bytes]] | None) -> None:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        if communication is not None and not communication.done():
            await communication
        elif communication is not None:
            communication.result()
        elif process.stdout is not None or process.stderr is not None:
            await process.communicate()
        self._children.discard(process)
        if self._active_process is process:
            self._active_process = None
            self._active_communication = None

    async def close(self) -> None:
        self._closing = True
        process = self._active_process
        communication = self._active_communication
        if process is not None:
            await self._cleanup_shielded(process, communication)
        # There is at most one child because the lock serializes native operations.
        for child in tuple(self._children):
            await self._cleanup_shielded(child, None)


def _set_dpi_awareness() -> str | None:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    try:
        set_context = user32.SetProcessDpiAwarenessContext
        set_context.argtypes = [ctypes.c_void_p]
        set_context.restype = wintypes.BOOL
        if set_context(ctypes.c_void_p(-4)):
            return "per_monitor_v2"
    except (AttributeError, OSError):
        pass
    try:
        shcore = ctypes.WinDLL("shcore", use_last_error=True)
        set_awareness = shcore.SetProcessDpiAwareness
        set_awareness.argtypes = [ctypes.c_int]
        set_awareness.restype = ctypes.c_long
        result = set_awareness(2)
        if result in (0, 0x80070005):
            return "per_monitor"
    except (AttributeError, OSError):
        pass
    return "system_default_or_already_set"


def _filetime_value(value: Any) -> int:
    return (int(value.dwHighDateTime) << 32) | int(value.dwLowDateTime)


def enumerate_windows() -> dict[str, Any]:
    if os.name != "nt":
        raise OSError("unsupported_platform: desktop capture requires Windows 10/11 x64")

    class RECT(ctypes.Structure):
        _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG), ("right", wintypes.LONG), ("bottom", wintypes.LONG)]

    class MONITORINFOEXW(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", RECT), ("rcWork", RECT), ("dwFlags", wintypes.DWORD), ("szDevice", wintypes.WCHAR * 32)]

    class FILETIME(ctypes.Structure):
        _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    awareness = _set_dpi_awareness()
    displays: list[dict[str, Any]] = []
    windows: list[dict[str, Any]] = []
    rects: list[list[int]] = []
    monitor_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(RECT), wintypes.LPARAM)

    def monitor_callback(handle: int, _dc: int, _rect: Any, _data: int) -> bool:
        info = MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(info)
        if not user32.GetMonitorInfoW(handle, ctypes.byref(info)):
            return True
        bounds = [info.rcMonitor.left, info.rcMonitor.top, info.rcMonitor.right, info.rcMonitor.bottom]
        work_area = [info.rcWork.left, info.rcWork.top, info.rcWork.right, info.rcWork.bottom]
        dpi = None
        try:
            shcore = ctypes.WinDLL("shcore", use_last_error=True)
            get_dpi = shcore.GetDpiForMonitor
            get_dpi.argtypes = [wintypes.HMONITOR, ctypes.c_int, ctypes.POINTER(wintypes.UINT), ctypes.POINTER(wintypes.UINT)]
            get_dpi.restype = ctypes.c_long
            xdpi, ydpi = wintypes.UINT(), wintypes.UINT()
            if get_dpi(handle, 0, ctypes.byref(xdpi), ctypes.byref(ydpi)) == 0:
                dpi = {"x": int(xdpi.value), "y": int(ydpi.value)}
        except (AttributeError, OSError):
            pass
        displays.append({"id": info.szDevice, "name": info.szDevice, "primary": bool(info.dwFlags & 1), "bounds": bounds, "workArea": work_area, "dpi": dpi, "scale": dpi["x"] / 96 if dpi else None})
        rects.append(bounds)
        return True

    user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.c_void_p]
    user32.GetMonitorInfoW.restype = wintypes.BOOL
    user32.EnumDisplayMonitors.argtypes = [wintypes.HDC, ctypes.c_void_p, monitor_proc, wintypes.LPARAM]
    user32.EnumDisplayMonitors.restype = wintypes.BOOL
    if not user32.EnumDisplayMonitors(None, None, monitor_proc(monitor_callback), 0):
        raise ctypes.WinError(ctypes.get_last_error())

    def process_facts(pid: int) -> tuple[str | None, int | None]:
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return None, None
        try:
            created, exited, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
            creation = _filetime_value(created) if kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)) else None
            path_buffer = ctypes.create_unicode_buffer(32768)
            size = wintypes.DWORD(len(path_buffer))
            image_path = path_buffer.value if kernel32.QueryFullProcessImageNameW(handle, 0, path_buffer, ctypes.byref(size)) else None
            return image_path, creation
        finally:
            kernel32.CloseHandle(handle)

    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    foreground = int(user32.GetForegroundWindow() or 0)
    enum_windows_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def window_callback(hwnd: int, _data: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        pid_value = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_value))
        pid = int(pid_value.value)
        if pid <= 0:
            return True
        title_length = max(0, min(user32.GetWindowTextLengthW(hwnd), 32767))
        title_buffer = ctypes.create_unicode_buffer(title_length + 1)
        user32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
        rect = RECT()
        bounds = [rect.left, rect.top, rect.right, rect.bottom] if user32.GetWindowRect(hwnd, ctypes.byref(rect)) else None
        image_path, created = process_facts(pid)
        app = os.path.basename(image_path) if image_path else None
        windows.append({
            "hwnd": int(hwnd), "pid": pid, "processCreatedAt": created, "app": app,
            "appDisplayName": app, "title": title_buffer.value, "bounds": bounds,
            "foreground": int(hwnd) == foreground, "minimized": bool(user32.IsIconic(hwnd)),
            "identityAvailable": created is not None,
        })
        return True

    user32.EnumWindows.argtypes = [enum_windows_proc, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    if not user32.EnumWindows(enum_windows_proc(window_callback), 0):
        raise ctypes.WinError(ctypes.get_last_error())
    union = [min(r[0] for r in rects), min(r[1] for r in rects), max(r[2] for r in rects), max(r[3] for r in rects)] if rects else None
    return {"displays": displays, "windows": windows, "virtualBounds": union, "foregroundHwnd": foreground, "diagnostics": {"dpiAwareness": awareness}}


def _execute_worker_request(request: dict[str, Any]) -> dict[str, Any]:
    operation = request.get("operation")
    payload = request.get("payload") if isinstance(request.get("payload"), dict) else {}
    if operation not in ALLOWED_OPERATIONS:
        return {"ok": False, "payload": None, "diagnostics": {}, "error": {"code": "invalid_operation", "message": "Unsupported native operation"}}
    try:
        if operation == "enumerate":
            result = enumerate_windows()
            return {"ok": True, "payload": result, "diagnostics": result.pop("diagnostics", {}), "error": None}
        if operation == "capture":
            from .capture import worker_capture
            result = worker_capture(payload)
            return {"ok": True, "payload": result, "diagnostics": result.pop("diagnostics", {}), "error": None}
        if operation == "semantics":
            from .semantics import read_window_semantics
            result = read_window_semantics(int(payload["hwnd"]), payload.get("bounds"), payload.get("options", {}))
            return {"ok": True, "payload": result, "diagnostics": result.pop("diagnostics", {}), "error": None}
        from .browser import read_page_semantics
        result = read_page_semantics(int(payload["hwnd"]), payload.get("bounds"), payload.get("options", {}))
        return {"ok": True, "payload": result, "diagnostics": result.pop("diagnostics", {}), "error": None}
    except Exception as exc:
        return {"ok": False, "payload": None, "diagnostics": {"stage": operation}, "error": {"code": getattr(exc, "code", "native_query_failed"), "message": str(exc)}}


def main() -> None:
    try:
        request_line = sys.stdin.buffer.readline()
        if not request_line:
            raise ValueError("worker request is missing")
        request = json.loads(request_line)
        if sys.stdin.buffer.readline().strip():
            raise ValueError("worker accepts exactly one request")
        response = _execute_worker_request(request)
    except Exception:
        response = {"ok": False, "payload": None, "diagnostics": {}, "error": {"code": "invalid_worker_request", "message": "Worker request could not be processed"}}
    sys.stdout.buffer.write(_response_bytes(response))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
