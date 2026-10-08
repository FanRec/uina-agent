from __future__ import annotations

import argparse
import asyncio
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
)

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
    def test(request: TestRequest) -> dict[str, Any]:
        return service.test(request.scope, request.session_id)

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
    service = build_service(config_path or default_config_path())
    try:
        service.start()
        diagnostic_startup_timeout_ms = max(
            service.config.startup_timeout_ms,
            service.config.request_timeout_ms,
        )
        print(
            f"[TTS][diagnostic] waiting for vendor readiness up to {diagnostic_startup_timeout_ms}ms",
            flush=True,
        )
        if not service.vendor_manager.wait_until_ready(diagnostic_startup_timeout_ms):
            raise TTSBridgeConfigError("vendor tts is not ready for streaming diagnostic")
        return service.diagnose_streaming(text=text, repeats=repeats)
    finally:
        service.close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="UChat tts_bridge service")
    parser.add_argument("--serve", action="store_true", help="Run the bridge HTTP service")
    parser.add_argument("--config", default=str(default_config_path()), help="Path to service.toml")
    parser.add_argument("--diagnose-streaming", action="store_true", help="Run streaming diagnostic candidates and save ranking JSON")
    parser.add_argument("--text", default="你大半夜把我叫出来就是为了让我听你测试语音合成？", help="Diagnostic text for streaming benchmark")
    parser.add_argument("--diagnostic-repeats", type=int, default=1, help="Number of times to run each streaming diagnostic candidate")
    return parser.parse_known_args(argv)[0]
