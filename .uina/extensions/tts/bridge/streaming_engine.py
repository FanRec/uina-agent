"""streaming_engine.py — 流式合成引擎与会话管理。

从 service.py 中解耦出来的流式合成核心：
负责构建 vendor 流式合成请求、持有合成串行锁、消费 chunk 流、监控 chunk gap / 延迟指标、
管理 PCM 缓冲与背压队列、以及异常/超时的统一处理与分类。
"""
from __future__ import annotations

import inspect
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import httpx

from models import AudioAsset, BridgeTask, DefaultPreset, StreamingConfig, StreamingProfile
from synthesis_handlers import (
    STREAM_PUT_STALL_TIMEOUT_S,
    StreamingSynthesisError,
    _PCMChunkStream,
    _log_latency,
    _vendor_text_lang_for,
)


class StreamingSession:
    def __init__(
        self,
        *,
        task: BridgeTask,
        profile: StreamingProfile,
        sample_rate: int,
        media_type: str,
        live_stream: _PCMChunkStream,
        audio_buffer: bytearray,
        producer_thread: threading.Thread,
        producer_done: threading.Event,
        stream_cancel_event: threading.Event,
        producer_state: dict[str, Any],
        started_at: float,
        estimated_duration_ms: int,
    ) -> None:
        self.task = task
        self.profile = profile
        self.sample_rate = sample_rate
        self.media_type = media_type
        self.live_stream = live_stream
        self.audio_buffer = audio_buffer
        self.producer_thread = producer_thread
        self.producer_done = producer_done
        self.stream_cancel_event = stream_cancel_event
        self.producer_state = producer_state
        self.started_at = started_at
        self.estimated_duration_ms = estimated_duration_ms

        self.asset = AudioAsset(
            kind="pcm",
            artifact_path=None,
            sample_rate=sample_rate,
            duration_ms=estimated_duration_ms,
            media_type=media_type,
            pcm_stream=live_stream,
            metrics={
                "streaming": True,
                "stream_profile": profile.label,
                "prebuffer_ms": profile.prebuffer_ms,
                "rebuffer_ms": profile.rebuffer_ms,
                "pcm_buffer": audio_buffer,
                "pcm_buffer_done": producer_done,
            },
        )

    def close(self) -> None:
        self.live_stream.close()
        self.producer_thread.join(timeout=1.0)

    def wait_for_producer(self, timeout: float = 1.0) -> None:
        self.producer_thread.join(timeout=timeout)

    @property
    def producer_error(self) -> tuple[str, Exception] | None:
        return self.producer_state.get("error")

    def compute_synthesis_metrics(self) -> dict[str, Any]:
        total_bytes = len(self.audio_buffer)
        duration_ms = int(total_bytes / 2 / self.sample_rate * 1000) if self.sample_rate > 0 else 0
        chunk_count = int(self.producer_state.get("chunk_count", 0))
        chunk_gap_total_ms = float(self.producer_state.get("chunk_gap_total_ms", 0.0))
        chunk_gap_max_ms = float(self.producer_state.get("chunk_gap_max_ms", 0.0))
        chunk_gap_over_120ms = int(self.producer_state.get("chunk_gap_over_120ms", 0))
        chunk_audio_total_ms = float(self.producer_state.get("chunk_audio_total_ms", 0.0))
        first_chunk_at = self.producer_state.get("first_chunk_at")

        avg_chunk_gap_ms = round(chunk_gap_total_ms / max(chunk_count - 1, 1), 2) if chunk_count > 1 else 0.0
        avg_chunk_audio_ms = round(chunk_audio_total_ms / max(chunk_count, 1), 2) if chunk_count > 0 else 0.0
        latency_ms = round((time.perf_counter() - self.started_at) * 1000, 2)
        realtime_factor = round(duration_ms / latency_ms, 3) if latency_ms > 0 else None
        first_chunk_latency_ms = round((first_chunk_at - self.started_at) * 1000, 2) if first_chunk_at is not None else None

        return {
            "total_bytes": total_bytes,
            "duration_ms": duration_ms,
            "chunk_count": chunk_count,
            "avg_chunk_gap_ms": avg_chunk_gap_ms,
            "max_chunk_gap_ms": round(chunk_gap_max_ms, 2),
            "chunk_gap_over_120ms": chunk_gap_over_120ms,
            "avg_chunk_audio_ms": avg_chunk_audio_ms,
            "latency_ms": latency_ms,
            "realtime_factor": realtime_factor,
            "first_chunk_latency_ms": first_chunk_latency_ms,
        }


class StreamingSynthesisEngine:
    def __init__(
        self,
        *,
        vendor_manager: Any = None,
        synthesis_lock: threading.Lock | None = None,
        streaming_config: StreamingConfig | None = None,
        preset_config: DefaultPreset | None = None,
        service: Any = None,
    ) -> None:
        self._vendor_manager = vendor_manager
        self._synthesis_lock = synthesis_lock
        self._streaming = streaming_config
        self._preset = preset_config
        self._service = service

    @property
    def vendor_manager(self) -> Any:
        if self._service is not None and hasattr(self._service, "vendor_manager"):
            return self._service.vendor_manager
        return self._vendor_manager

    @property
    def synthesis_lock(self) -> threading.Lock:
        if self._service is not None and hasattr(self._service, "_synthesis_lock"):
            return self._service._synthesis_lock
        return self._synthesis_lock or threading.Lock()

    @property
    def streaming(self) -> Any:
        if self._service is not None and hasattr(self._service, "config") and hasattr(self._service.config, "streaming"):
            return self._service.config.streaming
        return self._streaming

    @property
    def preset(self) -> Any:
        if self._service is not None and hasattr(self._service, "config") and hasattr(self._service.config, "preset"):
            return self._service.config.preset
        return self._preset

    def start_stream(
        self,
        *,
        task: BridgeTask,
        ref_audio_path: Path,
        timeout_ms: int,
        profile: StreamingProfile,
        estimated_duration_ms: int,
        on_first_chunk: Callable[[], None],
        is_cancelled: Callable[[], bool],
    ) -> StreamingSession:
        payload: dict[str, Any] = {
            "text": task.detail["text"],
            "text_lang": _vendor_text_lang_for(task.detail["text"]),
            "ref_audio_path": str(ref_audio_path),
            "prompt_text": self.preset.prompt_text,
            "prompt_lang": self.preset.prompt_lang,
            "text_split_method": self.preset.text_split_method,
            "speed_factor": self.preset.speed_factor,
            "streaming_mode": profile.vendor_streaming_mode,
            "media_type": self.streaming.media_type,
            "batch_size": self.streaming.batch_size,
            "fragment_interval": profile.fragment_interval,
            "min_chunk_length": profile.min_chunk_length,
        }

        started_at = time.perf_counter()
        _log_latency(
            task,
            "streaming_started",
            stream_profile=profile.label,
            min_chunk_length=profile.min_chunk_length,
            fragment_interval=profile.fragment_interval,
            prebuffer_ms=profile.prebuffer_ms,
            rebuffer_ms=profile.rebuffer_ms,
        )

        audio_buffer = bytearray()
        producer_done = threading.Event()
        stream_cancel_event = threading.Event()
        task.stream_cancel_event = stream_cancel_event

        producer_state: dict[str, Any] = {
            "error": None,
            "audio_buffer": audio_buffer,
            "done": producer_done,
            "chunk_count": 0,
            "chunk_gap_total_ms": 0.0,
            "chunk_gap_max_ms": 0.0,
            "chunk_gap_over_120ms": 0,
            "chunk_audio_total_ms": 0.0,
            "first_chunk_at": None,
            "started_at": started_at,
        }

        live_stream = _PCMChunkStream()

        def _produce() -> None:
            chunk_count = 0
            chunk_gap_total_ms = 0.0
            chunk_gap_max_ms = 0.0
            chunk_gap_over_120ms = 0
            chunk_audio_total_ms = 0.0
            last_chunk_at: float | None = None
            first_chunk_at: float | None = None

            try:
                if stream_cancel_event.is_set() or is_cancelled():
                    task.cancel_requested = True
                    return

                if not self.synthesis_lock.acquire(timeout=self.streaming.synthesis_lock_timeout_ms / 1000):
                    producer_state["error"] = (
                        "lock_timeout",
                        RuntimeError(
                            f"timed out waiting for synthesis lock after {self.streaming.synthesis_lock_timeout_ms}ms"
                        ),
                    )
                    return
                try:
                    synth = self.vendor_manager.synthesize_stream
                    try:
                        synth_signature = inspect.signature(synth)
                        supports_stream_guards = all(
                            name in synth_signature.parameters
                            for name in ("idle_timeout_ms", "total_timeout_ms", "cancel_event")
                        )
                    except (TypeError, ValueError):
                        supports_stream_guards = False
                    if supports_stream_guards:
                        stream_iter = synth(
                            payload,
                            timeout_ms=timeout_ms,
                            idle_timeout_ms=self.streaming.stream_idle_timeout_ms,
                            total_timeout_ms=self.streaming.stream_total_timeout_ms,
                            cancel_event=stream_cancel_event,
                        )
                    else:
                        stream_iter = synth(payload, timeout_ms=timeout_ms)
                    for chunk in stream_iter:
                        if is_cancelled():
                            task.cancel_requested = True
                            print(f"[TTS] streaming cancelled for task {task.task_id}", flush=True)
                            break
                        now = time.perf_counter()
                        if last_chunk_at is not None:
                            gap_ms = (now - last_chunk_at) * 1000
                            chunk_gap_total_ms += gap_ms
                            chunk_gap_max_ms = max(chunk_gap_max_ms, gap_ms)
                            if gap_ms >= 120:
                                chunk_gap_over_120ms += 1
                        if first_chunk_at is None:
                            first_chunk_at = now
                            task.detail["first_chunk_latency_ms"] = round((now - started_at) * 1000, 2)
                            on_first_chunk()
                            _log_latency(
                                task,
                                "vendor_first_chunk",
                                vendor_first_chunk_ms=task.detail["first_chunk_latency_ms"],
                                chunk_bytes=len(chunk),
                            )
                        last_chunk_at = now
                        audio_buffer.extend(chunk)
                        if not live_stream.put(chunk, timeout=STREAM_PUT_STALL_TIMEOUT_S):
                            producer_state["error"] = (
                                "stalled",
                                RuntimeError(
                                    f"playback consumption stalled: no queue space for {timeout_ms} audio within {STREAM_PUT_STALL_TIMEOUT_S}s"
                                ),
                            )
                            break
                        chunk_count += 1
                        chunk_audio_total_ms += len(chunk) / 2 / self.streaming.sample_rate * 1000
                        task.detail["chunk_count"] = chunk_count
                        task.detail["total_bytes"] = len(audio_buffer)
                        task.detail["last_chunk_at"] = round(now * 1000, 2)
                        task.detail["stream_audio_ms"] = round(chunk_audio_total_ms, 2)
                finally:
                    self.synthesis_lock.release()

            except httpx.TimeoutException as exc:
                producer_state["error"] = ("timeout", exc)
            except httpx.HTTPError as exc:
                producer_state["error"] = ("http", exc)
            except Exception as exc:
                producer_state["error"] = ("vendor", exc)

            finally:
                producer_state["chunk_count"] = chunk_count
                producer_state["chunk_gap_total_ms"] = chunk_gap_total_ms
                producer_state["chunk_gap_max_ms"] = chunk_gap_max_ms
                producer_state["chunk_gap_over_120ms"] = chunk_gap_over_120ms
                producer_state["chunk_audio_total_ms"] = chunk_audio_total_ms
                producer_state["first_chunk_at"] = first_chunk_at
                on_first_chunk()
                live_stream.close()
                producer_done.set()

        producer_thread = threading.Thread(target=_produce, name=f"tts-stream-producer-{task.task_id}", daemon=True)
        producer_thread.start()

        return StreamingSession(
            task=task,
            profile=profile,
            sample_rate=self.streaming.sample_rate,
            media_type=self.streaming.media_type,
            live_stream=live_stream,
            audio_buffer=audio_buffer,
            producer_thread=producer_thread,
            producer_done=producer_done,
            stream_cancel_event=stream_cancel_event,
            producer_state=producer_state,
            started_at=started_at,
            estimated_duration_ms=estimated_duration_ms,
        )
