from __future__ import annotations

import argparse
import asyncio
import json
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse
from fastapi import HTTPException
import uvicorn

from lifecycle_handlers import TTSBridgeConfig, TTSBridgeConfigError
from synthesis_handlers import (
    BatchTaskStatusRequest,
    CancelRequest,
    CancelTraceRequest,
    SpeakRequest,
    GenerateRequest,
    TurnEndRequest,
    ReconnectRequest,
    ResetRequest,
    TestRequest,
    RestartRequest,
    _sanitize_vendor_text,
    _vendor_text_lang_for,
)
from models import DiagnosticCandidate, DiagnosticResult, StreamingProfile

if TYPE_CHECKING:
    from service import TTSBridgeService


def default_config_path() -> Path:
    return Path(__file__).resolve().parent / "config" / "service.toml"


def build_service(config_path: str | Path | None = None) -> Any:
    from service import TTSBridgeService

    config = TTSBridgeConfig.load(config_path or default_config_path())
    return TTSBridgeService(config)


def build_app(service: Any) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        service.startup()
        try:
            yield
        finally:
            service.close()

    app = FastAPI(title="tts_bridge", lifespan=lifespan)

    @app.get("/health")
    def health() -> dict[str, Any]:
        return service.health()

    @app.post("/v1/tts/speak", status_code=202)
    def speak(request: SpeakRequest, raw_request: Request) -> dict[str, Any]:
        return service.admit_speak(request, traceparent=raw_request.headers.get("traceparent"))

    @app.post("/v1/tts/generate", response_class=Response)
    async def generate(request: GenerateRequest, raw_request: Request) -> Response:
        work = asyncio.create_task(service.generate(request.text, timeout_ms=request.timeout_ms))
        try:
            while not work.done():
                if await raw_request.is_disconnected():
                    raise HTTPException(status_code=499, detail="generation cancelled")
                await asyncio.wait({work}, timeout=0.05)
            return Response(content=await work, media_type="audio/wav")
        finally:
            if not work.done():
                work.cancel()
            await asyncio.gather(work, return_exceptions=True)

    @app.get("/v1/tts/tasks/{task_id}")
    def task_status(task_id: str) -> dict[str, Any]:
        return service.task_status(task_id)

    @app.post("/v1/tts/tasks/batch-status")
    def batch_task_status(request: BatchTaskStatusRequest) -> dict[str, Any]:
        return service.batch_task_status(request)

    @app.get("/v1/tts/events")
    def playback_events(trace_id: Optional[str] = None):
        return StreamingResponse(
            service.playback_events(trace_id),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/v1/tts/playback/events")
    def playback_snapshots():
        return StreamingResponse(
            service.playback_snapshots(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/v1/tts/reconnect")
    def reconnect(request: ReconnectRequest) -> dict[str, Any]:
        return service.reconnect(request.session_id)

    @app.post("/v1/tts/reset")
    def reset(request: ResetRequest) -> dict[str, Any]:
        return service.reset(request.session_id, request.expected_epoch, request.new_epoch, request.invocation_id)

    @app.post("/v1/tts/test")
    async def test(request: TestRequest, raw_request: Request) -> dict[str, Any]:
        cancelled = threading.Event()
        work = asyncio.create_task(asyncio.to_thread(service.test, request.scope, request.session_id, request.timeout_ms, cancelled, request.expected_epoch, request.trace_id))
        try:
            while not work.done():
                if await raw_request.is_disconnected():
                    cancelled.set()
                await asyncio.wait({work}, timeout=0.02)
            return await work
        finally:
            cancelled.set()

    @app.post("/v1/tts/restart")
    def restart(request: RestartRequest) -> dict[str, Any]:
        return service.restart(request.target)

    @app.post("/v1/tts/cancel")
    def cancel(request: CancelRequest) -> dict[str, Any]:
        return service.cancel(request)

    @app.post("/v1/tts/cancel-trace")
    def cancel_trace(request: CancelTraceRequest) -> dict[str, Any]:
        return service.cancel_trace(request)

    @app.post("/v1/tts/turn-end")
    def mark_turn_end(request: TurnEndRequest) -> dict[str, Any]:
        return service.mark_turn_end(request)

    @app.get("/v1/tts/subtitle-state")
    def subtitle_state(trace_id: str) -> dict[str, Any]:
        return service.subtitle_state(trace_id)

    return app


def run_server(config_path: str | Path | None = None) -> None:
    # service.py re-exports server helpers at module bottom; import here to
    # avoid a circular import while still resolving the runtime symbol.
    from service import TTSBridgeService

    config = TTSBridgeConfig.load(config_path or default_config_path())
    app = build_app(TTSBridgeService(config))
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")


def run_streaming_diagnostic(config_path: str | Path | None = None, *, text: str, repeats: int = 1) -> dict[str, Any]:
    """离线 A/B 诊断：只测 vendor 合成（首块延迟、块间距、RTF），不播放。

    用于在相同声音模型/参考音频上比较 streaming_mode 与 chunk 参数；
    运行时交付路径本身固定，不做自动策略摆动。
    """
    from vendor_runtime import VendorRuntime

    config = TTSBridgeConfig.load(config_path or default_config_path())
    vendor = VendorRuntime(config, config_error=TTSBridgeConfigError)
    candidates = [
        DiagnosticCandidate(label="mode3_chunk16_gap0.03", vendor_streaming_mode=3, min_chunk_length=16, fragment_interval=0.03),
        DiagnosticCandidate(label="mode2_chunk32_gap0.05", vendor_streaming_mode=2, min_chunk_length=32, fragment_interval=0.05),
        DiagnosticCandidate(label="mode2_chunk48_gap0.10", vendor_streaming_mode=2, min_chunk_length=48, fragment_interval=0.10),
    ]
    try:
        vendor.ensure_running()
        if not vendor.wait_until_ready(max(config.startup_timeout_ms, config.request_timeout_ms)):
            raise TTSBridgeConfigError("vendor tts is not ready for streaming diagnostic")
        preset = config.preset
        if not preset.ref_audio_path:
            raise TTSBridgeConfigError("tts preset ref_audio_path is not configured")
        vendor_text = _sanitize_vendor_text(text)
        if not vendor_text:
            raise TTSBridgeConfigError("diagnostic text is empty after vendor sanitization")
        results: list[DiagnosticResult] = []
        run_count = max(int(repeats), 1)
        for run_index in range(1, run_count + 1):
            for candidate in candidates:
                label = candidate.label if run_count == 1 else f"{candidate.label}#run{run_index}"
                print(f"[TTS][diagnostic] running {label}", flush=True)
                profile = StreamingProfile(
                    label=label,
                    vendor_streaming_mode=candidate.vendor_streaming_mode,
                    min_chunk_length=candidate.min_chunk_length,
                    fragment_interval=candidate.fragment_interval,
                )
                payload: dict[str, Any] = {
                    "text": vendor_text,
                    "text_lang": _vendor_text_lang_for(vendor_text),
                    "ref_audio_path": str(preset.ref_audio_path.resolve()),
                    "prompt_text": preset.prompt_text,
                    "prompt_lang": preset.prompt_lang,
                    "text_split_method": preset.text_split_method,
                    "speed_factor": preset.speed_factor,
                    "streaming_mode": profile.vendor_streaming_mode,
                    "media_type": config.streaming.media_type,
                    "batch_size": config.streaming.batch_size,
                    "fragment_interval": profile.fragment_interval,
                    "min_chunk_length": profile.min_chunk_length,
                }
                started = time.perf_counter()
                first_chunk_ms = None
                total_bytes = 0
                gaps_total_ms = 0.0
                gaps_max_ms = 0.0
                last_chunk_at: float | None = None
                for chunk in vendor.synthesize_stream(payload, timeout_ms=config.streaming.stream_total_timeout_ms):
                    now = time.perf_counter()
                    if first_chunk_ms is None:
                        first_chunk_ms = round((now - started) * 1000, 2)
                    if last_chunk_at is not None:
                        gap_ms = (now - last_chunk_at) * 1000
                        gaps_total_ms += gap_ms
                        gaps_max_ms = max(gaps_max_ms, gap_ms)
                    last_chunk_at = now
                    total_bytes += len(chunk)
                elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
                sample_rate = config.streaming.sample_rate
                duration_ms = round(total_bytes / 2 / sample_rate * 1000, 2) if sample_rate else 0.0
                metrics = {
                    "first_chunk_ms": first_chunk_ms,
                    "total_bytes": total_bytes,
                    "duration_ms": duration_ms,
                    "elapsed_ms": elapsed_ms,
                    "realtime_factor": round(duration_ms / elapsed_ms, 3) if elapsed_ms > 0 else None,
                    "avg_chunk_gap_ms": round(gaps_total_ms / max(total_bytes // 3200, 1), 2),
                    "max_chunk_gap_ms": round(gaps_max_ms, 2),
                }
                print(f"[TTS][diagnostic] {label}: {metrics}", flush=True)
                results.append(DiagnosticResult(label=label, metrics=metrics))
        ranked = sorted(results, key=lambda item: (
            item.metrics.get("first_chunk_ms") or 10**9,
            -(item.metrics.get("realtime_factor") or 0.0),
        ))
        payload = {
            "text": text,
            "repeats": run_count,
            "results": [{"label": item.label, "metrics": item.metrics} for item in ranked],
            "recommended": {"label": ranked[0].label, "metrics": ranked[0].metrics} if ranked else None,
        }
        output_dir = config.output_dir.resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "streaming_diagnostic_results.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return payload
    finally:
        vendor.close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="UChat tts_bridge service")
    parser.add_argument("--serve", action="store_true", help="Run the bridge HTTP service")
    parser.add_argument("--config", default=str(default_config_path()), help="Path to service.toml")
    parser.add_argument("--diagnose-streaming", action="store_true", help="Run streaming diagnostic candidates and save ranking JSON")
    parser.add_argument("--text", default="你大半夜把我叫出来就是为了让我听你测试语音合成？", help="Diagnostic text for streaming benchmark")
    parser.add_argument("--diagnostic-repeats", type=int, default=1, help="Number of times to run each streaming diagnostic candidate")
    return parser.parse_known_args(argv)[0]
