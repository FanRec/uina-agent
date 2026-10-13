import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / ".uina/extensions/tts/bridge"))

from dataclasses import replace
import io
import json
import socket
import tempfile
import threading
import time
import wave
import httpx
import uvicorn
from lifecycle_handlers import TTSBridgeConfig
from models import PlaybackProgressSnapshot
from service import TTSBridgeService
from server import build_app


class Vendor:
    process = None
    ownership = "external"
    def ready(self): return True
    def ensure_running(self): return False
    def wait_until_ready(self, timeout): return True
    def close(self): pass
    def synthesize(self, payload, **kwargs):
        if "vendor failure" in payload["text"]: return httpx.Response(500, content=b"controlled vendor failure")
        if "slow" in payload["text"]: time.sleep(0.05)
        with io.BytesIO() as buffer:
            with wave.open(buffer, "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(8000)
                output.writeframes(b"\x00\x00" * 800)
            return httpx.Response(200, content=buffer.getvalue())
    def synthesize_stream(self, payload, **kwargs):
        if "vendor failure" in payload["text"]: raise RuntimeError("controlled vendor failure")
        yield b"\x01\x00" * 3200


class Player:
    ready = True
    supports_streaming = True
    is_playing = False
    is_streaming = False
    def __init__(self):
        self.played = []
        self.cancelled = threading.Event()
        self.started = False
    def start(self): pass
    def stop(self): self.cancel_all()
    def cancel_all(self):
        self.cancelled.set()
        self.is_playing = self.is_streaming = False
    def bind_segment(self, playback_id):
        self.played.append(playback_id)
    def start_stream(self, **kwargs):
        self.cancelled.clear()
        self.is_playing = self.is_streaming = True
        self.started = True
    resume_or_start_stream = start_stream
    def feed(self, chunk): pass
    def finish_stream(self): self.is_streaming = False
    def wait_until_drained(self, timeout):
        self.cancelled.wait(0.02)
        self.is_playing = False
        return not self.cancelled.is_set()
    def stream_stats(self): return {"playback_started": self.started, "playback_completed": not self.cancelled.is_set()}
    def progress_snapshot(self, duration_ms):
        return PlaybackProgressSnapshot(playback_started=self.started, played_ms=duration_ms if not self.is_playing else 0,
            played_samples=800, buffered_ms=0, segment_finished=not self.is_playing, duration_ms=duration_ms)
    def play_file_as_pcm_and_wait(self, **kwargs):
        self.start_stream()
        if kwargs.get("playback_id"): self.bind_segment(kwargs["playback_id"])
        self.finish_stream()
        return self.wait_until_drained(kwargs["timeout_ms"])


with tempfile.TemporaryDirectory(prefix="uina-tts-protocol-") as directory:
    root = Path(directory)
    config = TTSBridgeConfig.load(Path(__file__).resolve().parents[2] / ".uina/extensions/tts/bridge/config/service.toml")
    reference = root / "reference.wav"
    reference.write_bytes(b"reference")
    device_mode = "--device" in sys.argv
    config = replace(config, output_dir=root, preset=config.preset if device_mode else replace(config.preset, ref_audio_path=reference),
        streaming=replace(config.streaming, warmup_enabled=False),
        subtitle_sync=replace(config.subtitle_sync, enabled=False), lipsync_bridge=replace(config.lipsync_bridge, enabled=False))
    player = Player()
    service = TTSBridgeService(config) if device_mode else TTSBridgeService(config, vendor_manager=Vendor(), player=player)
    if device_mode and not service.vendor_manager.ready():
        raise RuntimeError("Device verification requires an already running external Vendor; it will not start or restart one")
    app = build_app(service)
    @app.get("/test-state")
    def state():
        with service._lock:
            by_playback = {task.detail.get("physical_playback_id"): task for task in service._tasks.values()}
            return {"played": [by_playback[key].trace_id for key in player.played if key in by_playback],
                "tasks": [{"id": task.task_id, "state": task.state, "text": task.detail.get("text"), "trace": task.trace_id, "detail": task.detail, "error": task.error} for task in service._tasks.values()]}
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    print(json.dumps({"port": sock.getsockname()[1]}), flush=True)
    server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
    @app.post("/test-shutdown")
    def shutdown():
        server.should_exit = True
        return {"status": "succeeded"}
    server.run(sockets=[sock])
