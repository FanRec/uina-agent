import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / ".uina/extensions/tts/bridge"))

from dataclasses import replace

import json
import socket
import tempfile
import uvicorn
from lifecycle_handlers import TTSBridgeConfig
from _testkit import FakeSink, FakeVendor, _wav_bytes
from service import TTSBridgeService
from server import build_app


class DeviceSink(FakeSink):
    """真实验证模式：走真实 AudioSink + 外部 Vendor，不做假消费。"""


with tempfile.TemporaryDirectory(prefix="uina-tts-protocol-") as directory:
    root = Path(directory)
    config = TTSBridgeConfig.load(Path(__file__).resolve().parents[2] / ".uina/extensions/tts/bridge/config/service.toml")
    reference = root / "reference.wav"
    reference.write_bytes(_wav_bytes(b"\x00\x00" * 3200, 32000))
    device_mode = "--device" in sys.argv
    config = replace(config, output_dir=root,
        preset=config.preset if device_mode else replace(config.preset, ref_audio_path=reference),
        streaming=replace(config.streaming, warmup_enabled=False),
        subtitle_sync=replace(config.subtitle_sync, enabled=False), lipsync_bridge=replace(config.lipsync_bridge, enabled=False))
    vendor = FakeVendor()
    vendor.on_stream("vendor failure", RuntimeError("controlled vendor failure"))
    vendor.on_batch("vendor failure", RuntimeError("controlled vendor failure"))
    sink = None if device_mode else FakeSink()
    service = TTSBridgeService(config) if device_mode else TTSBridgeService(config, vendor_manager=vendor, sink=sink)
    if device_mode and not service.vendor_manager.ready():
        raise RuntimeError("Device verification requires an already running external Vendor; it will not start or restart one")
    app = build_app(service)

    @app.get("/test-state")
    def state():
        played: list[str] = []
        if sink is not None:
            for task_id, _start, _pcm in sink.append_log():
                trace = task_id.rsplit(":", 1)[0]
                if trace not in played:
                    played.append(trace)
        tasks = []
        with service.lane.condition:
            briefs = [
                {"id": segment.task_id, "trace": trace_id}
                for trace_id, source in service.lane._sources.items()
                for segment in source.segments.values()
            ]
        for brief in briefs:
            status = service.lane.task_status(brief["id"])
            state_word = status["status"]
            if state_word == "delivered":
                state_word = "completed"
            tasks.append({
                "id": brief["id"],
                "state": state_word,
                "trace": brief["trace"],
                "error": status.get("error", ""),
            })
        return {"played": played, "tasks": tasks}

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    print(json.dumps({"port": sock.getsockname()[1]}), flush=True)
    server = uvicorn.Server(uvicorn.Config(app, log_level="error"))

    @app.post("/test-shutdown")
    def shutdown():
        server.should_exit = True
        return {"status": "succeeded"}

    server.run(sockets=[sock])
