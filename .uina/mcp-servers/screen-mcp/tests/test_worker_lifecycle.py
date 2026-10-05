from __future__ import annotations

import ctypes

import asyncio
import os
import sys
from pathlib import Path

import pytest

from uina_screen_mcp.worker import QueryRunner, _response_bytes, default_worker_command

FIXTURE = Path(__file__).parent / "fixtures" / "worker_reply.py"


def runner() -> QueryRunner:
    return QueryRunner([sys.executable, str(FIXTURE)])


def test_worker_response_is_utf8_independent_of_console_code_page() -> None:
    encoded = _response_bytes({"ok": False, "error": {"message": "不可见字符\u200b"}})

    assert "不可见字符\u200b" in encoded.decode("utf-8")


def test_default_worker_command_uses_venv_python_for_console_launcher(tmp_path: Path) -> None:
    scripts = tmp_path / "Scripts"
    scripts.mkdir()
    python = scripts / "python.exe"
    python.write_bytes(b"")
    launcher = scripts / "uina-screen-mcp.exe"

    assert default_worker_command(str(launcher)) == [str(python), "-m", "uina_screen_mcp.worker"]


def test_default_worker_command_keeps_direct_python(tmp_path: Path) -> None:
    python = tmp_path / "python.exe"

    assert default_worker_command(str(python)) == [str(python), "-m", "uina_screen_mcp.worker"]


def assert_process_reaped(pid: int) -> None:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    kernel32.GetExitCodeProcess.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        assert ctypes.get_last_error() in (87, 1168)
        return
    try:
        exit_code = ctypes.c_ulong()
        assert kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
        assert exit_code.value != 259
    finally:
        kernel32.CloseHandle(handle)


async def wait_for_file(path: Path) -> None:
    for _ in range(100):
        if path.exists() and path.stat().st_size > 0:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"worker did not create marker: {path}")


@pytest.mark.asyncio
async def test_timeout_reaps_child(tmp_path: Path) -> None:
    marker = tmp_path / "pid"
    query = runner()
    with pytest.raises(TimeoutError):
        await query.run("enumerate", {"hang": True, "markerPath": str(marker)}, 0.2)
    await wait_for_file(marker)
    pid = int(marker.read_text())
    await query.close()
    assert_process_reaped(pid)


@pytest.mark.asyncio
async def test_cancel_while_waiting_never_spawns(tmp_path: Path) -> None:
    marker_a, marker_b = tmp_path / "a", tmp_path / "b"
    query = runner()
    first = asyncio.create_task(query.run("enumerate", {"sleepMs": 300, "markerPath": str(marker_a)}, 2))
    await wait_for_file(marker_a)
    second = asyncio.create_task(query.run("enumerate", {"markerPath": str(marker_b)}, 2))
    await asyncio.sleep(0.02)
    second.cancel()
    with pytest.raises(asyncio.CancelledError):
        await second
    await first
    assert not marker_b.exists()
    await query.close()


@pytest.mark.asyncio
async def test_cancel_during_native_reaps_child(tmp_path: Path) -> None:
    marker = tmp_path / "pid"
    query = runner()
    task = asyncio.create_task(query.run("enumerate", {"hang": True, "markerPath": str(marker)}, 10))
    await wait_for_file(marker)
    pid = int(marker.read_text())
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert_process_reaped(pid)
    await query.close()


@pytest.mark.asyncio
async def test_close_waits_for_active_child(tmp_path: Path) -> None:
    marker = tmp_path / "pid"
    query = runner()
    task = asyncio.create_task(query.run("enumerate", {"sleepMs": 400, "markerPath": str(marker)}, 2))
    await wait_for_file(marker)
    pid = int(marker.read_text())
    await query.close()
    assert task.done()
    assert_process_reaped(pid)


@pytest.mark.asyncio
async def test_repeated_cancel_still_reaps_child(tmp_path: Path) -> None:
    marker = tmp_path / "pid"
    query = runner()
    task = asyncio.create_task(query.run("enumerate", {"hang": True, "markerPath": str(marker)}, 10))
    await wait_for_file(marker)
    pid = int(marker.read_text())
    task.cancel()
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert_process_reaped(pid)
    await query.close()


@pytest.mark.asyncio
async def test_next_call_works_after_timeout() -> None:
    query = runner()
    with pytest.raises(TimeoutError):
        await query.run("enumerate", {"hang": True}, 0.1)
    result = await query.run("enumerate", {}, 2)
    assert result["ok"] is True
    await query.close()


@pytest.mark.asyncio
async def test_stderr_does_not_become_protocol() -> None:
    query = runner()
    result = await query.run("enumerate", {"stderr": "diagnostic only"}, 2)
    assert result["ok"] is True
    assert "diagnostic only" not in str(result)
    await query.close()







@pytest.mark.asyncio
async def test_nonzero_worker_includes_stderr() -> None:
    query = runner()
    result = await query.run("enumerate", {"fail": 7, "stderr": "native launch detail"}, 2)
    assert result["ok"] is False
    assert result["error"]["code"] == "worker_failed"
    assert "native launch detail" in result["error"]["message"]
    await query.close()
