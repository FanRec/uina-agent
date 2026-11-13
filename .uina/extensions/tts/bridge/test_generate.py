import io
import asyncio
import time
import threading
import wave
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock
from unittest.mock import AsyncMock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from lifecycle_handlers import TTSBridgeConfig
from models import DefaultPreset, VendorConfig, StreamingConfig
from server import build_app
from service import TTSBridgeService
from vendor_runtime import VendorRuntime


def wav_bytes():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\0\0" * 800)
    return output.getvalue()


def generate(service, text="hello", *, timeout_ms=1000):
    return asyncio.run(service.generate(text, timeout_ms=timeout_ms))


@pytest.fixture
def service(tmp_path):
    reference = tmp_path / "ref.wav"
    reference.write_bytes(wav_bytes())
    config = TTSBridgeConfig(
        service_name="test", base_url="http://127.0.0.1:0", host="127.0.0.1", port=0, vendor_port=0,
        startup_timeout_ms=1000, request_timeout_ms=1000, output_dir=tmp_path, playback_enabled=False,
        vendor=VendorConfig(api_style="v2", python_executable="unused", entry_script=Path("unused")),
        preset=DefaultPreset(ref_audio_path=reference, prompt_text="reference", prompt_lang="zh", text_lang="zh",
                             text_split_method="cut5", speed_factor=1.0, media_type="wav"),
        streaming=StreamingConfig(enabled=False, warmup_enabled=False),
    )
    vendor = Mock()
    vendor.synthesize_file = AsyncMock(return_value=httpx.Response(200, content=wav_bytes()))
    sink = Mock()
    instance = TTSBridgeService(config, vendor_manager=vendor, sink=sink)
    yield instance
    instance.close()


def test_generate_is_pure_synthesis_and_preserves_text(service):
    text = "  你好\n（这些字也要保留）🙂  "
    before = service.lane.active_task_count()
    result = generate(service, text)
    assert result == wav_bytes()
    payload = service.vendor_manager.synthesize_file.call_args.args[0]
    assert payload["text"] == text
    assert payload["media_type"] == "wav" and payload["streaming_mode"] is False
    assert 0 < service.vendor_manager.synthesize_file.call_args.kwargs["timeout_ms"] <= 1000
    assert service.lane.active_task_count() == before
    assert list(service.config.output_dir.glob("uina-tts-*")) == []


@pytest.mark.parametrize("body", [b"", b"not audio", wav_bytes()[:70]])
def test_generate_rejects_bad_or_partial_audio(service, body):
    service.vendor_manager.synthesize_file.return_value = httpx.Response(200, content=body)
    with pytest.raises(HTTPException) as failure:
        generate(service)
    assert failure.value.status_code == 502


@pytest.mark.parametrize("defect", ["zero_rate", "wrong_byte_rate", "unaligned_data"])
def test_generate_rejects_invalid_pcm_metadata_before_http_success(service, defect):
    audio = bytearray(wav_bytes())
    if defect == "zero_rate":
        audio[24:28] = (0).to_bytes(4, "little")
    elif defect == "wrong_byte_rate":
        audio[28:32] = (1).to_bytes(4, "little")
    else:
        audio.append(0)
        audio[4:8] = (len(audio) - 8).to_bytes(4, "little")
        audio[40:44] = (1601).to_bytes(4, "little")
    service.vendor_manager.synthesize_file.return_value = httpx.Response(200, content=bytes(audio))
    response = TestClient(build_app(service)).post("/v1/tts/generate", json={"text": "hello"})
    assert response.status_code == 502


def test_cancellation_while_waiting_does_not_dispatch(service):
    async def scenario():
        service._vendor_lock.acquire()
        try:
            request = asyncio.create_task(service.generate("hello", timeout_ms=1000))
            await asyncio.sleep(0)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
        finally:
            service._vendor_lock.release()
    asyncio.run(scenario())
    service.vendor_manager.synthesize_file.assert_not_called()


def test_late_audio_is_discarded_and_lock_released(service):
    async def scenario():
        request = asyncio.create_task(service.generate("hello", timeout_ms=1000))
        async def synthesize(*args, **kwargs):
            request.cancel()
            return httpx.Response(200, content=wav_bytes())
        service.vendor_manager.synthesize_file.side_effect = synthesize
        with pytest.raises(asyncio.CancelledError):
            await request
    asyncio.run(scenario())
    assert service._vendor_lock.acquire(blocking=False)
    service._vendor_lock.release()


def test_generate_endpoint_returns_audio_not_admission_or_playback(service):
    client = TestClient(build_app(service))
    response = client.post("/v1/tts/generate", json={"text": "hello", "timeout_ms": 1000})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content == wav_bytes()
    assert client.post("/v1/tts/generate", json={"text": " "}).status_code == 422
    assert client.post("/v1/tts/generate", json={"text": "hello", "path": "elsewhere"}).status_code == 422


@pytest.mark.parametrize("timeout", [True, "1000", 0, -1, 2147483648])
def test_generate_rejects_invalid_deadline_at_parameter_boundary(service, timeout):
    response = TestClient(build_app(service)).post("/v1/tts/generate", json={"text": "hello", "timeout_ms": timeout})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "timeout_ms"]
    service.vendor_manager.synthesize_file.assert_not_called()


def test_lock_waiting_expires_without_dispatch(service):
    service._vendor_lock.acquire()
    try:
        with pytest.raises(HTTPException) as failure:
            generate(service, timeout_ms=30)
        assert failure.value.status_code == 504
        service.vendor_manager.synthesize_file.assert_not_called()
    finally:
        service._vendor_lock.release()


def test_legacy_payload_preserves_configured_language(service):
    service.config = replace(service.config, vendor=replace(service.config.vendor, api_style="legacy"))
    assert generate(service, "hello") == wav_bytes()
    payload = service.vendor_manager.synthesize_file.call_args.args[0]
    assert payload == {"media_type": "wav", "text": "hello", "text_language": "zh"}


def test_endpoint_cancellation_closes_request_and_releases_lock(service):
    async def scenario():
        started = asyncio.Event()
        stopped = asyncio.Event()
        async def pending(*args, **kwargs):
            started.set()
            try:
                await asyncio.sleep(10)
            finally:
                stopped.set()
        service.vendor_manager.synthesize_file.side_effect = pending
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=build_app(service)), base_url="http://test") as client:
            request = asyncio.create_task(client.post("/v1/tts/generate", json={"text": "hello"}))
            await asyncio.wait_for(started.wait(), timeout=1)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert stopped.is_set()
            assert service._vendor_lock.acquire(blocking=False)
            service._vendor_lock.release()
    asyncio.run(scenario())


@pytest.mark.parametrize("abort", [False, True])
def test_slow_drip_cannot_keep_synthesis_lock_after_deadline_or_cancel(service, abort):
    class SlowVendor(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.send_header("Content-Length", "20")
            self.end_headers()
            try:
                for _ in range(20):
                    self.wfile.write(b"x")
                    self.wfile.flush()
                    time.sleep(0.025)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), SlowVendor)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    service.vendor_manager = VendorRuntime(replace(service.config, vendor_port=server.server_port))
    try:
        async def scenario():
            request = asyncio.create_task(service.generate("hello", timeout_ms=1000 if abort else 100))
            if abort:
                asyncio.get_running_loop().call_later(0.08, request.cancel)
            start = time.perf_counter()
            with pytest.raises(asyncio.CancelledError if abort else HTTPException) as failure:
                await request
            assert time.perf_counter() - start < 0.3
            if not abort:
                assert failure.value.status_code == 504
        asyncio.run(scenario())
        assert service._vendor_lock.acquire(blocking=False)
        service._vendor_lock.release()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
