"""service.py — TTS Bridge 装配与对外用例层。

组合 DeliveryLane（唯一交付事实所有者）、SynthesisWorker（唯一合成执行者）、
AudioSink（唯一播放物理权威）与 PlaybackFeed（唯一事实发布者/设备控制线程）。
本层只做：装配、HTTP 用例转发、健康投影与进程所有权；不持有第二本播放账。
"""
from __future__ import annotations

import asyncio
import io
import struct
import sys
import threading
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import httpx
from fastapi import HTTPException

from audio_playback import AudioSink, wav_metadata
from delivery_lane import DeliveryLane
from lifecycle_handlers import TTSBridgeConfig, TTSBridgeConfigError
from lipsync_bridge_client import LipsyncBridgeClient
from models import BridgeError, Segment, Source, StreamingConfig, StreamingProfile
from playback_feed import PlaybackEventHub, PlaybackFeed, SubtitleEstimator
from playback_projection import PlaybackProjection, PlaybackSnapshotHub
from synthesis_handlers import (
    CancelTraceRequest,
    SpeakRequest,
    TurnEndRequest,
    _log_latency,
    _sanitize_vendor_text,
    _vendor_text_lang_for,
)
from vendor_runtime import VendorRuntime


def _bridge_http_error(exc: BridgeError) -> HTTPException:
    detail = exc.detail
    if isinstance(detail, dict):
        return HTTPException(status_code=exc.status_code, detail=detail)
    return HTTPException(status_code=exc.status_code, detail=str(detail))


class TTSBridgeService:
    def __init__(
        self,
        config: Any,
        *,
        vendor_manager: VendorRuntime | None = None,
        sink: AudioSink | None = None,
        lane: DeliveryLane | None = None,
        hub: PlaybackEventHub | None = None,
        projection: PlaybackProjection | None = None,
        snapshot_hub: PlaybackSnapshotHub | None = None,
        feed: PlaybackFeed | None = None,
        worker: Any = None,
        lipsync: LipsyncBridgeClient | None = None,
    ) -> None:
        self.config = config
        streaming: StreamingConfig = config.streaming
        self.vendor_manager = vendor_manager or VendorRuntime(config, config_error=TTSBridgeConfigError)
        self.sink = sink or AudioSink(
            device=streaming.device,
            mirror_device=streaming.mirror_device,
            start_prebuffer_ms=streaming.start_prebuffer_ms,
            priming_ms=streaming.device_priming_ms,
            buffer_seconds=streaming.buffer_seconds,
        )
        self.lane = lane or DeliveryLane(streaming)
        self.lane.discard_hook = lambda frame, drop_straddler: self.sink.discard_unplayed_from(
            frame, drop_straddler=drop_straddler
        )
        self.hub = hub or PlaybackEventHub()
        self.projection = projection or PlaybackProjection()
        self.snapshot_hub = snapshot_hub or PlaybackSnapshotHub(self.projection)
        self.estimator = SubtitleEstimator()
        self.feed = feed or PlaybackFeed(
            lane=self.lane,
            sink=self.sink,
            hub=self.hub,
            projection=self.projection,
            snapshot_hub=self.snapshot_hub,
            config=streaming,
            progress_interval_ms=config.subtitle_sync.progress_interval_ms,
            estimator=self.estimator,
        )
        self.lipsync = lipsync or LipsyncBridgeClient(config.lipsync_bridge)
        self._vendor_lock = threading.Lock()
        self.worker = worker  # type: ignore[assignment]
        if self.worker is None:
            from synthesis_worker import SynthesisWorker

            self.worker = SynthesisWorker(
                lane=self.lane,
                sink=self.sink,
                vendor=self.vendor_manager,
                config=streaming,
                preset=config.preset,
                hub=self.hub,
                vendor_lock=self._vendor_lock,
                profile_for=self._profile_for,
                fallback_to_batch=streaming.fallback_to_batch_on_failure,
                lipsync=self.lipsync if config.lipsync_bridge.enabled else None,
                startup_timeout_ms=config.startup_timeout_ms,
            )
        self._closing = threading.Event()
        self._warmup_thread: threading.Thread | None = None
        self._warmup_status: dict[str, Any] = {"status": "not_started"}
        self._last_verification: dict[str, Any] | None = None

    # ── 生命周期 ────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._closing.is_set():
            raise RuntimeError("tts bridge is closed")
        self.vendor_manager.ensure_running()
        self.feed.start()
        self.worker.start()

    def startup(self) -> None:
        self.start()
        self._warmup_status = {"status": "waiting_for_vendor", "startup_timeout_ms": self.config.startup_timeout_ms, "at": time.time()}
        self._warmup_thread = threading.Thread(target=self._warmup_after_vendor_ready, name="tts-bridge-warmup", daemon=True)
        self._warmup_thread.start()

    def _warmup_after_vendor_ready(self) -> None:
        wait_timeout = max(self.config.startup_timeout_ms, self.config.streaming.warmup_timeout_ms)
        if not self.vendor_manager.wait_until_ready(wait_timeout):
            self._warmup_status = {"status": "skipped", "reason": "vendor_not_ready", "at": time.time()}
            print("[TTS][warmup] skipped: vendor_not_ready", flush=True)
            return
        for attempt in range(1, 4):
            if self._closing.is_set():
                return
            self._warmup_vendor_best_effort()
            if self._warmup_status.get("status") == "completed":
                self._warmup_status["attempt"] = attempt
                return
            if attempt < 3:
                time.sleep(0.25 * attempt)

    def _warmup_vendor_best_effort(self) -> None:
        streaming = self.config.streaming
        preset = self.config.preset
        if not streaming.enabled or not streaming.warmup_enabled:
            self._warmup_status = {"status": "skipped", "reason": "disabled", "at": time.time()}
            return
        if not preset.ref_audio_path:
            self._warmup_status = {"status": "skipped", "reason": "missing_ref_audio_path", "at": time.time()}
            return
        try:
            ref_audio_path = preset.ref_audio_path.resolve()
            if not ref_audio_path.exists():
                self._warmup_status = {"status": "skipped", "reason": "ref_audio_not_found", "ref_audio_path": str(ref_audio_path), "at": time.time()}
                return
            warmup_text = _sanitize_vendor_text(streaming.warmup_text)
            if not warmup_text:
                self._warmup_status = {"status": "skipped", "reason": "empty_warmup_text", "at": time.time()}
                return
            profile = self._profile_for(None)
            payload: dict[str, Any] = {
                "text": warmup_text,
                "text_lang": _vendor_text_lang_for(warmup_text),
                "ref_audio_path": str(ref_audio_path),
                "prompt_text": preset.prompt_text,
                "prompt_lang": preset.prompt_lang,
                "text_split_method": preset.text_split_method,
                "speed_factor": preset.speed_factor,
                "streaming_mode": profile.vendor_streaming_mode,
                "media_type": streaming.media_type,
                "batch_size": streaming.batch_size,
                "fragment_interval": profile.fragment_interval,
                "min_chunk_length": profile.min_chunk_length,
            }
            if not self._vendor_lock.acquire(timeout=2.0):
                # 真实讲话优先于尚未开始的预热：拿不到锁就跳过本轮。
                self._warmup_status = {"status": "skipped", "reason": "vendor_busy", "at": time.time()}
                return
            started_at = time.perf_counter()
            try:
                first_chunk_bytes = 0
                for chunk in self.vendor_manager.synthesize_stream(payload, timeout_ms=streaming.warmup_timeout_ms):
                    if chunk and len(chunk) >= 2:
                        first_chunk_bytes = len(chunk)
                        break
                if first_chunk_bytes < 2:
                    raise RuntimeError("warmup returned no valid PCM")
            finally:
                self._vendor_lock.release()
            elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
            self._warmup_status = {"status": "completed", "elapsed_ms": elapsed_ms, "first_chunk_bytes": first_chunk_bytes, "profile": profile.label, "at": time.time()}
            print(f"[TTS][warmup] completed elapsed_ms={elapsed_ms} first_chunk_bytes={first_chunk_bytes}", flush=True)
        except Exception as exc:
            self._warmup_status = {"status": "skipped", "reason": f"{type(exc).__name__}: {exc}", "at": time.time()}
            print(f"[TTS][warmup] skipped: {exc}", flush=True)

    def close(self) -> None:
        if self._closing.is_set():
            return
        self._closing.set()
        self.lane.close()
        self.worker.stop_worker()
        self.feed.stop_feed()
        if self.worker.ident is not None:
            self.worker.join(timeout=2.0)
        if self.feed.ident is not None:
            self.feed.join(timeout=2.0)
        snapshot_hub = self.snapshot_hub
        if snapshot_hub is not None:
            snapshot_hub.close()
        self.hub.close()
        try:
            self.sink.close()
        except Exception as exc:
            print(f"[TTS][audio] sink close error at shutdown: {exc}", flush=True)
        if self._warmup_thread is not None and self._warmup_thread.is_alive():
            self._warmup_thread.join(timeout=0.5)
        self.lipsync.close()
        self.vendor_manager.close()

    # ── 健康与配置投影 ──────────────────────────────────────────────────

    def health(self) -> dict[str, Any]:
        vendor_pid = None
        if self.vendor_manager.process is not None and self.vendor_manager.process.poll() is None:
            vendor_pid = self.vendor_manager.process.pid
        vendor_ready = self.vendor_manager.ready()
        streaming = self.config.streaming
        vendor_ownership = str(getattr(self.vendor_manager, "ownership", "unknown"))
        lane_summary = self.lane.pending_summary()
        return {
            "service_ready": True,
            "voice_protocol_version": 2,
            "bridge_ready": True,
            # The HTTP endpoint cannot prove who owns the enclosing Bridge process.
            # Companion supplies that separate fact; do not infer it from reachability.
            "ownership": {"bridge": "unknown", "vendor": vendor_ownership},
            "vendor_ownership": vendor_ownership,
            "vendor_ready": vendor_ready,
            "vendor_pid": vendor_pid,
            "player_ready": self.sink.ready and self.config.playback_enabled,
            "playback_enabled": self.config.playback_enabled,
            "streaming_enabled": streaming.enabled,
            "subtitle_sync_enabled": self.config.subtitle_sync.enabled,
            "lipsync_bridge_enabled": self.config.lipsync_bridge.enabled,
            "is_playing": self.sink.is_open and self.sink.buffered_ms() > 0,
            "is_streaming": self.sink.is_open,
            "lane": lane_summary,
            "pending_delivery_tasks": lane_summary["pending_segments"],
            "active_delivery_tasks": lane_summary["pending_segments"],
            "warmup": dict(self._warmup_status),
            "last_verification": self._last_verification,
            "effective_config": {
                "request_timeout_ms": self.config.request_timeout_ms,
                "startup_timeout_ms": self.config.startup_timeout_ms,
                "playback_enabled": self.config.playback_enabled,
                "streaming": {
                    "enabled": bool(streaming.enabled),
                    "media_type": streaming.media_type,
                    "sample_rate": streaming.sample_rate,
                    "vendor_streaming_mode": streaming.vendor_streaming_mode,
                    "min_chunk_length": streaming.min_chunk_length,
                    "fragment_interval": streaming.fragment_interval,
                    "first_chunk_vendor_streaming_mode": streaming.first_chunk_vendor_streaming_mode,
                    "first_chunk_min_chunk_length": streaming.first_chunk_min_chunk_length,
                    "first_chunk_fragment_interval": streaming.first_chunk_fragment_interval,
                    "warmup_enabled": streaming.warmup_enabled,
                    "warmup_status": dict(self._warmup_status),
                    "batch_size": streaming.batch_size,
                    "start_prebuffer_ms": streaming.start_prebuffer_ms,
                    "device_priming_ms": streaming.device_priming_ms,
                    "buffer_seconds": streaming.buffer_seconds,
                    "idle_close_ms": streaming.idle_close_ms,
                    "stream_idle_timeout_ms": streaming.stream_idle_timeout_ms,
                    "stream_total_timeout_ms": streaming.stream_total_timeout_ms,
                    "stall_timeout_ms": streaming.stall_timeout_ms,
                    "fallback_to_batch_on_failure": streaming.fallback_to_batch_on_failure,
                    "device": streaming.device,
                    "mirror_device": streaming.mirror_device,
                },
                "subtitle_sync": {
                    "enabled": self.config.subtitle_sync.enabled,
                    "obs_base_url": self.config.subtitle_sync.obs_base_url,
                    "progress_interval_ms": self.config.subtitle_sync.progress_interval_ms,
                },
                "lipsync_bridge": {
                    "enabled": self.config.lipsync_bridge.enabled,
                    "streaming_enabled": self.config.lipsync_bridge.streaming_enabled,
                    "base_url": self.config.lipsync_bridge.base_url,
                    "request_timeout_ms": self.config.lipsync_bridge.request_timeout_ms,
                    "inline_pcm_max_bytes": self.config.lipsync_bridge.inline_pcm_max_bytes,
                },
            },
        }

    # ── 受理 / 封口 ─────────────────────────────────────────────────────

    def admit_speak(self, request: Any, traceparent: str | None = None) -> dict[str, Any]:
        vendor_text = _sanitize_vendor_text(request.text)
        if not vendor_text:
            raise HTTPException(status_code=400, detail="text must not be empty")
        # 发送给 vendor 的文本必须经过 sanitize：原始文本可能含换行、零宽字符、
        # emoji 或非 GBK 符号，vendor 的 filter_text 会直接抛 ValueError 导致
        # 连接重置与 vendor 重启。raw text 仅用于字幕/回执对照。
        if vendor_text != request.text:
            print(f"[TTS] sanitized text for vendor: original={request.text[:40]!r} sanitized={vendor_text[:40]!r}", flush=True)
        if not self.config.playback_enabled or not self.sink.ready:
            raise HTTPException(status_code=503, detail="audio playback is unavailable on this deployment")
        try:
            receipt = self.lane.admit(request, vendor_text=vendor_text, traceparent=traceparent)
        except BridgeError as exc:
            raise _bridge_http_error(exc) from exc
        self.hub.publish(
            "submitted",
            trace_id=request.trace_id,
            generation_id=receipt["generation_id"],
            segment_index=receipt["segment_index"],
            task_id=receipt["task_id"],
            detail={"queue_size": receipt["segment_index"]},
            traceparent=traceparent,
        )
        _log_latency(
            request.trace_id,
            receipt["task_id"],
            "accepted",
            segment_index=receipt["segment_index"],
            traceparent=traceparent,
        )
        self.feed.wake()
        return receipt

    def mark_turn_end(self, request: Any) -> dict[str, Any]:
        result = self.lane.seal(request)
        self.feed.wake()
        return {"status": result["status"], "trace_id": request.trace_id}

    # ── 停止 ────────────────────────────────────────────────────────────

    def _discard(self, frame: int | None, *, drop_straddler: bool) -> None:
        if frame is None:
            return
        try:
            self.sink.discard_unplayed_from(frame, drop_straddler=drop_straddler)
        except Exception as exc:
            print(f"[TTS][audio] discard failed: {exc}", flush=True)

    def cancel(self, request: Any) -> dict[str, Any]:
        snapshot = self.sink.snapshot()
        try:
            result = self.lane.cancel_task(request, played_frame=snapshot.played_frames)
        except BridgeError as exc:
            raise _bridge_http_error(exc) from exc
        if result["status"] == "cancelled":
            self._discard(result.get("discard_from_frame"), drop_straddler=True)
            for task in result.get("cancelled_tasks", []):
                self.hub.publish(
                    "cancelled",
                    trace_id=request.trace_id,
                    segment_index=task["segment_index"],
                    task_id=task["task_id"],
                    detail={"reason": "cancel", "stop_outcome": "stopped"},
                )
        self.feed.wake()
        return {key: value for key, value in result.items() if key not in {"cancelled_tasks"}}

    def cancel_trace(self, request: Any) -> dict[str, Any]:
        snapshot = self.sink.snapshot()
        try:
            result = self.lane.cancel_source(
                request,
                played_frame=snapshot.played_frames,
                buffered_end_frame=snapshot.played_frames + self.sink.buffered_frames(),
            )
        except BridgeError as exc:
            raise _bridge_http_error(exc) from exc
        drop_straddler = request.mode == "immediate"
        self._discard(result.get("discard_from_frame"), drop_straddler=drop_straddler)
        for task in result.get("cancelled_tasks", []):
            self.hub.publish(
                "cancelled",
                trace_id=request.trace_id,
                generation_id=result.get("generation_id"),
                segment_index=task["segment_index"],
                task_id=task["task_id"],
                detail={"reason": "cancel_trace", "stop_outcome": result.get("stop_outcome")},
            )
        self.lipsync.cancel_trace_async(trace_id=request.trace_id)
        self.feed.wake()
        return {key: value for key, value in result.items() if key not in {"cancelled_tasks", "discard_from_frame"}}

    def reconnect(self, session_id: str) -> dict[str, Any]:
        result = self.lane.reconnect(session_id)
        result["health"] = self.health()
        return result

    def reset(self, session_id: str, expected_epoch: str | None = None, new_epoch: str | None = None, invocation_id: str | None = None) -> dict[str, Any]:
        def stop_source(trace_id: str, session: str) -> dict[str, Any]:
            return self.cancel_trace(CancelTraceRequest(trace_id=trace_id, session_id=session, mode="immediate"))

        result = self.lane.reset(session_id, expected_epoch, new_epoch, invocation_id, stop_source=stop_source)
        self.feed.wake()
        return result

    # ── 状态投影 ────────────────────────────────────────────────────────

    def task_status(self, task_id: str) -> dict[str, Any]:
        return self.lane.task_status(task_id)

    def batch_task_status(self, request: Any) -> dict[str, Any]:
        return self.lane.batch_task_status(list(request.task_ids))

    def subtitle_state(self, trace_id: str) -> dict[str, Any]:
        snapshot = self.sink.snapshot()
        estimator = lambda segment, played: self.estimator.reveal(segment, played, self.config.streaming.sample_rate)  # noqa: E731
        return self.lane.subtitle_state(trace_id, estimator=estimator, played_frame=snapshot.played_frames)

    def playback_events(self, trace_id: str | None = None):
        yield from self.hub.stream(trace_id)

    def playback_snapshots(self):
        yield from self.snapshot_hub.stream()

    # ── 纯合成（无播放） ────────────────────────────────────────────────

    async def generate(self, text: str, *, timeout_ms: int) -> bytes:
        """Pure synthesis: no task, playback epoch, artifact, subtitle or mouth events."""
        deadline = time.perf_counter() + timeout_ms / 1000

        def remaining_ms() -> int:
            if self._closing.is_set():
                raise HTTPException(status_code=503, detail="bridge is stopping")
            remaining = int((deadline - time.perf_counter()) * 1000)
            if remaining <= 0:
                raise HTTPException(status_code=504, detail="generation timed out")
            return remaining

        remaining_ms()
        if not text.strip():
            raise HTTPException(status_code=422, detail="text is empty")
        ref_audio_path = self.config.preset.ref_audio_path
        if self.config.vendor.api_style != "legacy":
            if ref_audio_path is None or not ref_audio_path.is_file():
                raise HTTPException(status_code=503, detail="reference audio is unavailable")
            ref_audio_path = ref_audio_path.resolve()
        # A disconnected caller can leave the queue without waiting for another synthesis.
        while not self._vendor_lock.acquire(blocking=False):
            await asyncio.sleep(min(0.05, remaining_ms() / 1000))
        work = None
        try:
            remaining = remaining_ms()
            payload: dict[str, Any] = {"media_type": "wav"}
            if self.config.vendor.api_style == "legacy":
                payload.update({"text": text, "text_language": self.config.preset.text_lang})
            else:
                payload.update({
                    "text": text,
                    "text_lang": _vendor_text_lang_for(text),
                    "ref_audio_path": str(ref_audio_path),
                    "prompt_text": self.config.preset.prompt_text,
                    "prompt_lang": self.config.preset.prompt_lang,
                    "text_split_method": self.config.preset.text_split_method,
                    "speed_factor": self.config.preset.speed_factor,
                    "streaming_mode": False,
                })
            try:
                work = asyncio.create_task(self.vendor_manager.synthesize_file(payload, timeout_ms=remaining))
                while not work.done():
                    await asyncio.wait({work}, timeout=min(0.05, remaining_ms() / 1000))
                response = await work
            except httpx.TimeoutException as exc:
                raise HTTPException(status_code=504, detail="tts vendor request timed out") from exc
            except httpx.HTTPError as exc:
                raise HTTPException(status_code=502, detail="tts vendor request failed") from exc
            remaining_ms()
            if response.status_code != 200:
                raise HTTPException(status_code=502, detail="tts vendor rejected synthesis")
            audio = response.content
            try:
                _validate_generated_wav(audio)
            except ValueError as exc:
                raise HTTPException(status_code=502, detail="vendor returned invalid or incomplete WAV") from exc
            duration_ms, sample_rate = wav_metadata(audio)
            if not duration_ms or not sample_rate:
                raise HTTPException(status_code=502, detail="vendor returned invalid or incomplete WAV")
            return audio
        finally:
            try:
                if work is not None and not work.done():
                    work.cancel()
                    await asyncio.gather(work, return_exceptions=True)
            finally:
                self._vendor_lock.release()

    # ── 按需验证与维护 ──────────────────────────────────────────────────

    def test(self, scope: str, session_id: str | None = None, timeout_ms: int = 120000, cancellation=None, expected_epoch: str | None = None, trace_id: str | None = None) -> dict[str, Any]:
        if scope not in {"synthesis", "playback"}:
            return {"status": "not_started", "scope": scope, "reason": "不支持的测试范围"}
        started = time.monotonic()
        deadline = started + max(timeout_ms, 1) / 1000
        cancel = cancellation or threading.Event()
        sid = session_id or "uina-test"
        trace = trace_id or sid + ":test-" + uuid4().hex
        if not trace.startswith(sid + ":"):
            return {"status": "not_started", "scope": scope, "reason": "播放测试来源不属于当前会话"}

        def remaining():
            if cancel.is_set():
                raise RuntimeError("测试已取消")
            budget = int((deadline - time.monotonic()) * 1000)
            if budget <= 0:
                raise TimeoutError("测试超时")
            return budget

        try:
            if scope == "playback":
                if not self.config.playback_enabled or not self.sink.ready:
                    return {"status": "not_started", "scope": scope, "reason": "播放器已禁用或音频设备不可用，未播放测试音"}
                receipt = self.admit_speak(
                    SpeakRequest(
                        trace_id=trace,
                        session_id=sid,
                        source_id=trace,
                        epoch=expected_epoch or self.lane.reconnect(sid)["epoch"],
                        segment_id=trace + ":1",
                        index=1,
                        text="语音测试。",
                        timeout_ms=remaining(),
                    )
                )
                task_id = receipt["task_id"]
                self.mark_turn_end(TurnEndRequest(trace_id=trace, last_segment_index=1))
                segment = self._wait_segment_terminal(task_id, remaining)
                duration_ms = None
                if segment.pcm_start_frame is not None and segment.pcm_final:
                    duration_ms = round(
                        (segment.pcm_end_frame - segment.pcm_start_frame) / self.config.streaming.sample_rate * 1000,
                        2,
                    )
                result = {
                    "status": {
                        "completed": "succeeded",
                        "failed": "failed",
                        "cancelled": "cancelled",
                        "unknown": "unknown",
                    }.get(segment.playback, "unknown"),
                    "scope": scope,
                    "playback_started": segment.playback_started_at is not None,
                    "playback_completed": segment.playback == "completed",
                    "duration_ms": duration_ms,
                    "sample_rate": self.config.streaming.sample_rate,
                    "path": "streaming",
                }
                if result["status"] != "succeeded":
                    result["reason"] = segment.error or "播放没有完成"
            else:
                self._ensure_vendor_ready(wait_for_ready=True, timeout_ms=remaining())
                ref = self._resolve_ref_audio_path()
                profile = self._profile_for(None)
                payload: dict[str, Any] = {
                    "text": _sanitize_vendor_text("语音测试。"),
                    "text_lang": _vendor_text_lang_for("语音测试。"),
                    "ref_audio_path": str(ref),
                    "prompt_text": self.config.preset.prompt_text,
                    "prompt_lang": self.config.preset.prompt_lang,
                    "text_split_method": self.config.preset.text_split_method,
                    "speed_factor": self.config.preset.speed_factor,
                    "streaming_mode": profile.vendor_streaming_mode,
                    "media_type": self.config.streaming.media_type,
                    "batch_size": self.config.streaming.batch_size,
                    "fragment_interval": profile.fragment_interval,
                    "min_chunk_length": profile.min_chunk_length,
                }
                if not self._vendor_lock.acquire(timeout=remaining() / 1000):
                    raise TimeoutError("等待模型超时")
                try:
                    total = 0
                    first_chunk_ms = None
                    synth_started = time.perf_counter()
                    for chunk in self.vendor_manager.synthesize_stream(
                        payload,
                        timeout_ms=remaining(),
                        idle_timeout_ms=self.config.streaming.stream_idle_timeout_ms,
                        total_timeout_ms=self.config.streaming.stream_total_timeout_ms,
                        cancel_event=cancel,
                    ):
                        if first_chunk_ms is None:
                            first_chunk_ms = round((time.perf_counter() - synth_started) * 1000, 2)
                        total += len(chunk)
                    if total == 0 or total % 2:
                        raise RuntimeError("模型没有返回有效 PCM")
                    rate = self.config.streaming.sample_rate
                    result = {
                        "status": "succeeded",
                        "scope": scope,
                        "audio_bytes": total,
                        "first_chunk_ms": first_chunk_ms,
                        "sample_rate": rate,
                        "duration_ms": total / 2 / rate * 1000,
                        "path": "streaming",
                        "playback_started": False,
                    }
                finally:
                    self._vendor_lock.release()
                remaining()
            result["elapsed_ms"] = round((time.monotonic() - started) * 1000, 2)
        except Exception as error:
            result = {"status": "cancelled" if cancel.is_set() else "failed", "scope": scope, "reason": str(error)}
            if scope == "playback":
                stopped = self.cancel_trace(CancelTraceRequest(trace_id=trace))
                if stopped.get("stop_outcome") not in {"stopped", "not_playing"}:
                    result = {"status": "unknown", "scope": scope, "reason": "测试已取消或超时，但停止尚未确认"}
        self._last_verification = {**result, "verified_at": time.time()}
        return result

    def _wait_segment_terminal(self, task_id: str, remaining) -> Segment:
        while True:
            status = self.lane.task_status(task_id)
            if status["status"] in {"delivered", "failed", "cancelled"}:
                segment = self.lane.get_segment(task_id)
                if segment is None:
                    raise RuntimeError("task record vanished")
                return segment
            time.sleep(0.02)
            remaining()

    def restart(self, target: str) -> dict[str, Any]:
        if target != "vendor":
            return {"status": "not_started", "target": target, "reason": "Bridge 不能在自身进程内重启自己"}
        ownership = str(getattr(self.vendor_manager, "ownership", "unknown"))
        if ownership != "owned":
            return {"status": "not_started", "target": target, "ownership": ownership, "reason": "Vendor 不是当前 Bridge 明确拥有的进程"}
        stopped = self.vendor_manager.stop_owned()
        if stopped.get("status") != "stopped":
            result = {"status": "unknown", "target": target, "ownership": ownership, "stop": stopped, "reason": "Vendor 停止结果未确认"}
            return result
        try:
            started = self.vendor_manager.ensure_running()
            ready = self.vendor_manager.wait_until_ready(self.config.startup_timeout_ms)
            if not started or not ready:
                return {
                    "status": "unknown",
                    "target": target,
                    "ownership": self.vendor_manager.ownership,
                    "started": started,
                    "ready": ready,
                    "reason": "Vendor 重启后未确认 ready",
                }
            return {"status": "succeeded", "target": target, "ownership": self.vendor_manager.ownership, "ready": True}
        except Exception as exc:
            return {"status": "unknown", "target": target, "reason": f"Vendor 重启失败：{type(exc).__name__}: {exc}"}

    # ── 内部 ────────────────────────────────────────────────────────────

    def _profile_for(self, segment: Segment | None) -> StreamingProfile:
        """固定流式 profile：首句可用配置的快速 profile，其余走质量基线。"""
        streaming = self.config.streaming
        default = StreamingProfile(
            label="continuity_default",
            vendor_streaming_mode=streaming.vendor_streaming_mode,
            min_chunk_length=streaming.min_chunk_length,
            fragment_interval=streaming.fragment_interval,
        )
        first_chunk_fast = (
            streaming.first_chunk_vendor_streaming_mode is not None
            and (segment is None or segment.index == 1)
        )
        if first_chunk_fast:
            return StreamingProfile(
                label="fast_start_first_sentence",
                vendor_streaming_mode=streaming.first_chunk_vendor_streaming_mode or streaming.vendor_streaming_mode,
                min_chunk_length=streaming.first_chunk_min_chunk_length,
                fragment_interval=streaming.first_chunk_fragment_interval,
            )
        return default

    def _resolve_ref_audio_path(self) -> Path:
        preset = self.config.preset
        if not preset.ref_audio_path:
            raise HTTPException(status_code=500, detail="tts preset ref_audio_path is not configured")
        ref_audio_path = preset.ref_audio_path.resolve()
        if not ref_audio_path.exists():
            raise HTTPException(status_code=500, detail=f"tts preset ref audio not found: {ref_audio_path}")
        return ref_audio_path

    def _ensure_vendor_ready(self, *, wait_for_ready: bool, timeout_ms: int | None = None) -> None:
        vendor_ready = self.vendor_manager.ready()
        if vendor_ready:
            return
        started = self.vendor_manager.ensure_running()
        if not wait_for_ready:
            return
        if not self.vendor_manager.wait_until_ready(
            min(self.config.startup_timeout_ms, timeout_ms) if timeout_ms is not None else self.config.startup_timeout_ms
        ):
            print("[TTS] vendor NOT ready after wait", flush=True)
            raise HTTPException(status_code=503, detail="vendor tts is not ready")
        if started:
            # vendor 崩溃/重启后冷启动，首个请求 first chunk 会慢（~6s）。
            # 主动 warmup 一次，让后续请求回到 ~400-700ms 首块延迟。
            self._warmup_vendor_best_effort()


def _validate_generated_wav(audio: bytes) -> None:
    """Validate the complete PCM file, including frame alignment and every chunk boundary."""
    if len(audio) < 44 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE" or int.from_bytes(audio[4:8], "little") + 8 != len(audio):
        raise ValueError("invalid RIFF/WAVE length")
    frame_size = 0
    has_data = False
    offset = 12
    while offset < len(audio):
        if offset + 8 > len(audio):
            raise ValueError("incomplete chunk header")
        name = audio[offset:offset + 4]
        size = int.from_bytes(audio[offset + 4:offset + 8], "little")
        offset += 8
        if offset + size > len(audio):
            raise ValueError("incomplete chunk")
        if name == b"fmt ":
            if frame_size or size < 16:
                raise ValueError("invalid format chunk")
            encoding, channels, rate, byte_rate, frame_size, bits = struct.unpack_from("<HHIIHH", audio, offset)
            if encoding != 1 or not channels or not rate or bits not in {8, 16, 24, 32}:
                raise ValueError("invalid PCM format")
            if frame_size != channels * bits // 8 or byte_rate != rate * frame_size:
                raise ValueError("invalid PCM alignment or rate")
        elif name == b"data":
            if not frame_size or has_data or not size or size % frame_size:
                raise ValueError("invalid PCM data")
            has_data = True
        offset += size + size % 2
    if offset != len(audio) or not has_data:
        raise ValueError("incomplete WAV")

