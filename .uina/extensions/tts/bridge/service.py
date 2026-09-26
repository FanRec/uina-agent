from __future__ import annotations

import argparse
import hashlib
import io
import json
import inspect

import math
import sys
import threading
import time
import unicodedata

if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 and older GPT-SoVITS runtimes.
    import tomli as tomllib
import wave
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from queue import Empty, Full, Queue
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal, Optional
from uuid import uuid4

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from audio_playback import AudioPlayback, playback_timeout_ms
from adaptive_engine import AdaptiveStrategyEngine
from lipsync_bridge_client import LipsyncBridgeClient
from models import (
    AdaptiveTraceState,
    AudioAsset,
    BridgeTask,
    DefaultPreset,
    DiagnosticCandidate,
    DiagnosticResult,
    GenerationSession,
    LipsyncBridgeConfig,
    PlaybackProgressSnapshot,
    SubtitleSyncConfig,
    StreamStrategy,
    StreamingConfig,
    StreamingProfile,
    VendorConfig,
)
from playback_coordinator import PlaybackCoordinator
from runtime_components import PlaybackEventHub, TaskRegistry
from sliding_window import SlidingWindowState
from subtitle_sync import SubtitleSyncEmitter, _graphemes
from synthesis_scheduler import SynthesisScheduler
from vendor_runtime import VendorRuntime
from lifecycle_handlers import (
    TTSBridgeConfig,
    TTSBridgeConfigError,
    _optional_path,
    _resolve_path,
)
from audio_playback import _wav_metadata
from streaming_engine import StreamingSession, StreamingSynthesisEngine
from synthesis_handlers import (
    BatchTaskStatusRequest,
    CancelRequest,
    CancelTraceRequest,
    SHORT_SEGMENT_FAST_START_CHAR_LIMIT,
    STREAM_PUT_STALL_TIMEOUT_S,
    SpeakRequest,
    StreamingSynthesisError,
    TurnEndRequest,
    _AdmittedSpeakTask,
    _PCMChunkStream,
    _STREAM_END,
    _estimate_stream_duration_ms_static,
    _latency_ms_since,
    _log_latency,
    _sanitize_vendor_text,
    _vendor_text_lang_for,
)

_DELIVERY_STOP = object()
SYNTHESIS_PREFETCH_WINDOW_SIZE = 2
MIN_FIXED_STREAMING_DELIVERY_WORKERS = 2
MAX_FIXED_STREAMING_DELIVERY_WORKERS = 3



class TTSBridgeService:
    def __init__(
        self,
        config: TTSBridgeConfig,
        *,
        vendor_manager: VendorRuntime | None = None,
        player: AudioPlayback | None = None,
    ) -> None:
        self.config = config
        self.vendor_manager = vendor_manager or VendorRuntime(config, config_error=TTSBridgeConfigError)
        self.player = player or AudioPlayback(
            device=config.streaming.device,
            mirror_device=config.streaming.mirror_device,
        )
        self.subtitle_sync = SubtitleSyncEmitter(config.subtitle_sync)
        self.lipsync_bridge = LipsyncBridgeClient(config.lipsync_bridge)
        self._lock = threading.Lock()
        self._real_task_registry = TaskRegistry(lock=self._lock)
        self._real_playback_event_hub = PlaybackEventHub(lock=self._lock)
        self._real_adaptive_engine = AdaptiveStrategyEngine(self.config.streaming)
        self._sessions_by_trace: dict[str, GenerationSession] = {}
        self._next_generation_id_by_trace: dict[str, int] = {}
        self._first_chunk_events: dict[tuple[str, int], threading.Event] = {}
        self._admitted_tasks: dict[str, _AdmittedSpeakTask] = {}
        self._delivery_queue: Queue[str | object] = Queue()
        self._delivery_stop = threading.Event()
        self._delivery_thread: threading.Thread | None = None
        self._active_delivery_tasks: set[str] = set()
        self._last_delivery_error: dict[str, Any] | None = None
        self._warmup_status: dict[str, Any] = {"status": "not_started"}
        # 全局合成串行锁：vendor 是单推理（api_v2 async 端点内同步推理），
        # 并发 /tts 请求只会交错竞争模型状态。合成端一次只允许一个 vendor
        # 请求在飞，播放与合成仍可重叠（合成持锁期间播放不受影响）。
        self._synthesis_lock = threading.Lock()
        self._sliding_window = SlidingWindowState(lock=self._lock, sessions_by_trace=self._sessions_by_trace)
        self._scheduler = SynthesisScheduler(window_size=SYNTHESIS_PREFETCH_WINDOW_SIZE)
        delivery_workers = (
            1
            if self.config.streaming.stream_strategy == "adaptive"
            else min(
                max(
                    self._scheduler.window_size + 1,
                    MIN_FIXED_STREAMING_DELIVERY_WORKERS,
                ),
                MAX_FIXED_STREAMING_DELIVERY_WORKERS,
            )
        )
        self._delivery_executor = ThreadPoolExecutor(max_workers=delivery_workers, thread_name_prefix="tts-bridge-delivery")
        self._playback = PlaybackCoordinator(
            lock=self._lock,
            player=self.player,
            sessions_by_trace=self._sessions_by_trace,
            streaming_config=self.config.streaming,
        )
        self._real_streaming_engine = StreamingSynthesisEngine(
            vendor_manager=self.vendor_manager,
            synthesis_lock=self._synthesis_lock,
            streaming_config=getattr(self.config, "streaming", None),
            preset_config=getattr(self.config, "preset", None),
            service=self,
        )

    @property
    def streaming_engine(self) -> StreamingSynthesisEngine:
        if not hasattr(self, "_real_streaming_engine") or self._real_streaming_engine is None:
            self._real_streaming_engine = StreamingSynthesisEngine(
                vendor_manager=getattr(self, "vendor_manager", None),
                synthesis_lock=getattr(self, "_synthesis_lock", None) or threading.Lock(),
                streaming_config=getattr(getattr(self, "config", None), "streaming", None),
                preset_config=getattr(getattr(self, "config", None), "preset", None),
                service=self,
            )
        return self._real_streaming_engine

    @streaming_engine.setter
    def streaming_engine(self, value: StreamingSynthesisEngine) -> None:
        self._real_streaming_engine = value

    @property
    def _task_registry(self) -> TaskRegistry:
        if not hasattr(self, "_real_task_registry"):
            self._real_task_registry = TaskRegistry(lock=getattr(self, "_lock", None) or threading.Lock())
        return self._real_task_registry

    @_task_registry.setter
    def _task_registry(self, value: TaskRegistry) -> None:
        self._real_task_registry = value

    @property
    def _tasks(self) -> dict[str, BridgeTask]:
        return self._task_registry.tasks

    @_tasks.setter
    def _tasks(self, value: dict[str, BridgeTask]) -> None:
        self._task_registry.tasks = value

    @property
    def _playback_event_hub(self) -> PlaybackEventHub:
        if not hasattr(self, "_real_playback_event_hub"):
            self._real_playback_event_hub = PlaybackEventHub(lock=getattr(self, "_lock", None) or threading.Lock())
        return self._real_playback_event_hub

    @_playback_event_hub.setter
    def _playback_event_hub(self, value: PlaybackEventHub) -> None:
        self._real_playback_event_hub = value

    @property
    def _playback_event_subscribers(self) -> dict[str, set[Queue[dict[str, Any] | None]]]:
        return self._playback_event_hub.subscribers

    @_playback_event_subscribers.setter
    def _playback_event_subscribers(self, value: dict[str, set[Queue[dict[str, Any] | None]]]) -> None:
        self._playback_event_hub.subscribers = value

    @property
    def _playback_events_stop(self) -> threading.Event:
        return self._playback_event_hub.stop_event

    @_playback_events_stop.setter
    def _playback_events_stop(self, value: threading.Event) -> None:
        self._playback_event_hub.stop_event = value

    @property
    def adaptive_engine(self) -> AdaptiveStrategyEngine:
        if not hasattr(self, "_real_adaptive_engine") or self._real_adaptive_engine is None:
            config = getattr(self, "config", None)
            streaming = config.streaming if config else StreamingConfig()
            self._real_adaptive_engine = AdaptiveStrategyEngine(streaming)
        return self._real_adaptive_engine

    @adaptive_engine.setter
    def adaptive_engine(self, engine: AdaptiveStrategyEngine) -> None:
        self._real_adaptive_engine = engine

    @property
    def _adaptive_state_by_trace(self) -> dict[str, AdaptiveTraceState]:
        return self.adaptive_engine.states

    @_adaptive_state_by_trace.setter
    def _adaptive_state_by_trace(self, value: dict[str, AdaptiveTraceState]) -> None:
        self.adaptive_engine.states = value

    @property
    def _adaptive_ms_per_char(self) -> float:
        return self.adaptive_engine.ms_per_char

    @_adaptive_ms_per_char.setter
    def _adaptive_ms_per_char(self, value: float) -> None:
        self.adaptive_engine.ms_per_char = value

    @property
    def _adaptive_lock(self) -> threading.Lock:
        return self.adaptive_engine.lock

    @_adaptive_lock.setter
    def _adaptive_lock(self, value: threading.Lock) -> None:
        self.adaptive_engine.lock = value

    def health(self) -> dict[str, Any]:
        vendor_pid = None
        if self.vendor_manager.process is not None and self.vendor_manager.process.poll() is None:
            vendor_pid = self.vendor_manager.process.pid
        vendor_ready = self.vendor_manager.ready()
        streaming = self.config.streaming
        return {
            "service_ready": True,
            "vendor_ready": vendor_ready,
            "vendor_pid": vendor_pid,
            "player_ready": self.player.ready and self.config.playback_enabled,
            "playback_enabled": self.config.playback_enabled,
            "streaming_enabled": self.config.streaming.enabled,
            "subtitle_sync_enabled": self.config.subtitle_sync.enabled,
            "lipsync_bridge_enabled": self.config.lipsync_bridge.enabled,
            "is_playing": self.player.is_playing,
            "is_streaming": self.player.is_streaming,
            "active_playback_task_id": self._active_playback_task_id(),
            "pending_delivery_tasks": self._delivery_queue.qsize(),
            "delivery_worker_alive": bool(self._delivery_thread is not None and self._delivery_thread.is_alive()),
            "delivery_executor_workers": self._delivery_executor._max_workers,
            "active_delivery_tasks": len(self._active_delivery_tasks),
            "admitted_task_count": len(self._admitted_tasks),
            "oldest_pending_delivery_age_ms": self._oldest_pending_delivery_age_ms(),
            "last_delivery_error": self._last_delivery_error,
            "effective_config": {
                "request_timeout_ms": self.config.request_timeout_ms,
                "startup_timeout_ms": self.config.startup_timeout_ms,
                "playback_enabled": self.config.playback_enabled,
                "streaming": {
                    "enabled": bool(streaming.enabled),
                    "stream_strategy": streaming.stream_strategy,
                    "media_type": streaming.media_type,
                    "sample_rate": streaming.sample_rate,
                    "vendor_streaming_mode": streaming.vendor_streaming_mode,
                    "min_chunk_length": streaming.min_chunk_length,
                    "fragment_interval": streaming.fragment_interval,
                    "first_chunk_vendor_streaming_mode": streaming.first_chunk_vendor_streaming_mode,
                    "first_chunk_min_chunk_length": streaming.first_chunk_min_chunk_length,
                    "first_chunk_fragment_interval": streaming.first_chunk_fragment_interval,
                    "first_chunk_prebuffer_ms": streaming.first_chunk_prebuffer_ms,
                    "first_chunk_gate_timeout_ms": streaming.first_chunk_gate_timeout_ms,
                    "warmup_enabled": streaming.warmup_enabled,
                    "warmup_text": streaming.warmup_text,
                    "warmup_timeout_ms": streaming.warmup_timeout_ms,
                    "warmup_status": dict(getattr(self, "_warmup_status", {"status": "not_started"})),
                    "batch_size": streaming.batch_size,
                    "prebuffer_ms": streaming.prebuffer_ms,
                    "rebuffer_ms": streaming.rebuffer_ms,
                    "drain_timeout_ms": streaming.drain_timeout_ms,
                    "stream_idle_timeout_ms": streaming.stream_idle_timeout_ms,
                    "stream_total_timeout_ms": streaming.stream_total_timeout_ms,
                    "synthesis_lock_timeout_ms": streaming.synthesis_lock_timeout_ms,
                    "max_delivery_task_ms": streaming.max_delivery_task_ms,

                    "fallback_to_batch_on_failure": streaming.fallback_to_batch_on_failure,
                    "adaptive_playback_start_latency_ms": streaming.adaptive_playback_start_latency_ms,
                    "adaptive_rebuffer_threshold": streaming.adaptive_rebuffer_threshold,
                    "adaptive_max_chunk_gap_ms": streaming.adaptive_max_chunk_gap_ms,
                    "adaptive_realtime_factor_threshold": streaming.adaptive_realtime_factor_threshold,
                    "adaptive_batch_recovery_successes": streaming.adaptive_batch_recovery_successes,
                    "device": streaming.device,
                },
                "subtitle_sync": {
                    "enabled": self.config.subtitle_sync.enabled,
                    "obs_base_url": self.config.subtitle_sync.obs_base_url,
                    "progress_interval_ms": self.config.subtitle_sync.progress_interval_ms,
                    "fallback_mode": self.config.subtitle_sync.fallback_mode,
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

    def start(self) -> None:
        self.vendor_manager.ensure_running()
        if self.config.playback_enabled:
            self.player.start()
        self._ensure_delivery_worker()

    def startup(self) -> None:
        self.start()
        if self.vendor_manager.wait_until_ready(self.config.startup_timeout_ms):
            self._warmup_vendor_best_effort()
            return
        self._warmup_status = {
            "status": "waiting_for_vendor",
            "startup_timeout_ms": self.config.startup_timeout_ms,
            "at": time.time(),
        }
        print(
            f"[TTS][warmup] waiting for vendor in background after startup_timeout_ms={self.config.startup_timeout_ms}",
            flush=True,
        )
        threading.Thread(target=self._warmup_after_vendor_ready, name="tts-bridge-warmup", daemon=True).start()

    def _warmup_after_vendor_ready(self) -> None:
        if not self.vendor_manager.wait_until_ready(max(self.config.startup_timeout_ms, self.config.streaming.warmup_timeout_ms)):
            self._warmup_status = {
                "status": "skipped",
                "reason": "vendor_not_ready",
                "at": time.time(),
            }
            print("[TTS][warmup] skipped: vendor_not_ready", flush=True)
            return
        self._warmup_vendor_best_effort()

    def _warmup_vendor_best_effort(self) -> None:
        with self._synthesis_lock:
            self._warmup_vendor_locked()

    def _warmup_vendor_locked(self) -> None:
        streaming = self.config.streaming
        preset = self.config.preset
        if not streaming.enabled or not streaming.warmup_enabled:
            self._warmup_status = {
                "status": "skipped",
                "reason": "disabled",
                "at": time.time(),
            }
            print("[TTS][warmup] skipped: disabled", flush=True)
            return
        if not preset.ref_audio_path:
            self._warmup_status = {
                "status": "skipped",
                "reason": "missing_ref_audio_path",
                "at": time.time(),
            }
            print("[TTS][warmup] skipped: missing_ref_audio_path", flush=True)
            return
        try:
            ref_audio_path = preset.ref_audio_path.resolve()
            if not ref_audio_path.exists():
                self._warmup_status = {
                    "status": "skipped",
                    "reason": "ref_audio_not_found",
                    "ref_audio_path": str(ref_audio_path),
                    "at": time.time(),
                }
                print(f"[TTS][warmup] skipped: ref_audio_not_found path={ref_audio_path}", flush=True)
                return
            warmup_text = _sanitize_vendor_text(streaming.warmup_text)
            if not warmup_text:
                self._warmup_status = {
                    "status": "skipped",
                    "reason": "empty_warmup_text",
                    "at": time.time(),
                }
                print("[TTS][warmup] skipped: empty_warmup_text", flush=True)
                return
            profile = self._first_chunk_streaming_profile()
            payload: dict[str, Any] = {
                "text": warmup_text,
                # 动态语言：纯中文/中文夹英文 → zh（以中文为准，避免 zh/ja 误判）；
                # 含假名/谚文 → auto（混合语言按段自动识别）
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
            started_at = time.perf_counter()
            first_chunk_bytes = 0
            for chunk in self.vendor_manager.synthesize_stream(payload, timeout_ms=streaming.warmup_timeout_ms):
                first_chunk_bytes = len(chunk)
                break
            elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
            self._warmup_status = {
                "status": "completed",
                "elapsed_ms": elapsed_ms,
                "first_chunk_bytes": first_chunk_bytes,
                "profile": profile.label,
                "at": time.time(),
            }
            print(
                f"[TTS][warmup] completed elapsed_ms={elapsed_ms} first_chunk_bytes={first_chunk_bytes} "
                f"profile={profile.label}",
                flush=True,
            )
        except Exception as exc:
            self._warmup_status = {
                "status": "skipped",
                "reason": f"{type(exc).__name__}: {exc}",
                "at": time.time(),
            }
            print(f"[TTS][warmup] skipped: {exc}", flush=True)

    def close(self) -> None:
        self._playback_event_hub.close()
        self._delivery_stop.set()
        self._delivery_queue.put(_DELIVERY_STOP)
        if self._delivery_thread is not None:
            self._delivery_thread.join(timeout=2.0)
        self._delivery_executor.shutdown(wait=False, cancel_futures=True)
        self.player.stop()
        self.subtitle_sync.close()
        self.lipsync_bridge.close()
        self.vendor_manager.close()

    def _ensure_delivery_worker(self) -> None:
        if self._delivery_thread is not None and self._delivery_thread.is_alive():
            return
        self._delivery_stop.clear()
        self._delivery_thread = threading.Thread(target=self._run_delivery_worker, name="tts-bridge-delivery", daemon=True)
        self._delivery_thread.start()

    def _run_delivery_worker(self) -> None:
        active_futures: set[Future[Any]] = set()
        while not self._delivery_stop.is_set():
            active_futures = {future for future in active_futures if not future.done()}
            if len(active_futures) >= self._delivery_executor._max_workers:
                done, pending = wait(active_futures, timeout=0.02, return_when=FIRST_COMPLETED)
                active_futures = set(pending)
                active_futures.update(future for future in done if not future.done())
                continue
            item = self._delivery_queue.get()
            if item is _DELIVERY_STOP:
                break
            task_id = str(item)
            admitted = self._admitted_tasks.pop(task_id, None)
            if admitted is None:
                continue
            active_futures.add(self._delivery_executor.submit(self._deliver_admitted_task, admitted))

    def _deliver_admitted_task(self, admitted: _AdmittedSpeakTask) -> None:
        task_id = admitted.task_id
        with self._lock:
            task = self._tasks.get(task_id)
        if task is None or task.cancel_requested or task.state == "cancelled":
            if task is not None:
                with self._lock:
                    self._release_window_for_cancelled_task_locked(task)

            return
        try:
            self._ensure_vendor_ready(wait_for_ready=True)
            self._active_delivery_tasks.add(task_id)
            self._deliver_prepared_task(
                task=task,
                ref_audio_path=admitted.ref_audio_path,
                timeout_ms=admitted.timeout_ms,
                profile=admitted.profile,
                use_batch_only=admitted.use_batch_only,
            )
        except Exception as exc:
            task.state = "failed"
            task.completed_at = time.time()
            if isinstance(exc, HTTPException):
                task.error = str(exc.detail)
            else:
                task.error = str(exc)
            self._last_delivery_error = {
                "task_id": task.task_id,
                "trace_id": task.trace_id,
                "generation_id": int(task.detail.get("generation_id", 1) or 1),
                "error": task.error,
                "at": time.time(),
            }
            self._publish_playback_event(
                "failed",
                task=task,
                detail={"error": task.error, "reason": "task_delivery_failed"},
            )
            self._mark_task_failed_and_release_window(task=task, reason="task_delivery_failed")
        finally:
            self._active_delivery_tasks.discard(task_id)

    def speak(self, request: SpeakRequest, traceparent: str | None = None) -> dict[str, Any]:
        task, ref_audio_path, timeout, profile, use_batch_only = self._prepare_speak_task(request, wait_for_vendor_ready=True, traceparent=traceparent)
        return self._deliver_prepared_task(
            task=task,
            ref_audio_path=ref_audio_path,
            timeout_ms=timeout,
            profile=profile,
            use_batch_only=use_batch_only,
        )

    def admit_speak(self, request: SpeakRequest, traceparent: str | None = None) -> dict[str, Any]:
        task, ref_audio_path, timeout, profile, use_batch_only = self._prepare_speak_task(request, wait_for_vendor_ready=False, traceparent=traceparent)
        self._ensure_delivery_worker()
        if self._should_reject_admission():
            task.state = "failed"
            task.completed_at = time.time()
            task.error = "tts delivery worker is not accepting new tasks"
            raise HTTPException(status_code=503, detail=task.error)
        self._admitted_tasks[task.task_id] = _AdmittedSpeakTask(
            task_id=task.task_id,
            ref_audio_path=ref_audio_path,
            timeout_ms=timeout,
            profile=profile,
            use_batch_only=use_batch_only,
            admitted_at=time.perf_counter(),
        )
        self._delivery_queue.put(task.task_id)
        self._publish_playback_event(
            "submitted",
            task=task,
            detail={
                "queue_size": self._delivery_queue.qsize(),
                "stream_profile": profile.label,
                "use_batch_only": use_batch_only,
            },
        )
        _log_latency(
            task,
            "accepted",
            queue_size=self._delivery_queue.qsize(),
            stream_profile=profile.label,
            use_batch_only=use_batch_only,
        )
        return {
            "status": "accepted",
            "task_id": task.task_id,
            "cancel_token": task.cancel_token,
            "trace_id": task.trace_id,
            "generation_id": int(task.detail.get("generation_id", 1) or 1),
            "segment_index": int(task.detail.get("segment_index", 0) or 0),
        }

    def _publish_playback_event(
        self,
        kind: str,
        *,
        task: BridgeTask | None = None,
        trace_id: str | None = None,
        generation_id: int | None = None,
        segment_index: int | None = None,
        task_id: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> None:
        self._playback_event_hub.publish(
            kind,
            task=task,
            trace_id=trace_id,
            generation_id=generation_id,
            segment_index=segment_index,
            task_id=task_id,
            detail=detail,
        )

    def playback_events(self, trace_id: str):
        yield from self._playback_event_hub.stream(trace_id)

    def _ensure_runtime_component_aliases(self) -> None:
        pass

    def task_status(self, task_id: str) -> dict[str, Any]:
        with self._lock:
            task = self._task_registry.get(task_id)
        if task is None:
            return {"status": "not_found", "task_id": task_id}
        if task.state == "completed":
            status = "delivered"
        elif task.state == "in_progress":
            status = "in_progress"
        elif task.state == "pending":
            status = "accepted"
        elif task.state == "failed":
            status = "failed"
        else:
            status = "cancelled"
        return {
            "status": status,
            "task_id": task.task_id,
            "trace_id": task.trace_id,
            "cancel_token": task.cancel_token,
            "audio_id": task.audio_id or "",
            "audio_path": task.artifact_path or "",
            "error": task.error or "",
            "detail": dict(task.detail),
            "started_at": task.started_at,
            "completed_at": task.completed_at,
        }

    def batch_task_status(self, request: BatchTaskStatusRequest) -> dict[str, Any]:
        return {
            "tasks": [self.task_status(task_id) for task_id in request.task_ids],
        }

    def _oldest_pending_delivery_age_ms(self) -> float | None:
        if not self._admitted_tasks:
            return None
        oldest = min(item.admitted_at for item in self._admitted_tasks.values())
        return round(max(time.perf_counter() - oldest, 0.0) * 1000, 2)

    def _should_reject_admission(self) -> bool:
        worker_dead = self._delivery_thread is None or not self._delivery_thread.is_alive()
        if worker_dead:
            return True
        max_workers = int(self._delivery_executor._max_workers)
        # 防止积压任务永久占住 admission 名额：超过 max_delivery_task_ms 的
        # 排队任务直接失败并移出，避免长回复把队列打到 503。
        now = time.perf_counter()
        stale_ids = [
            task_id
            for task_id, admitted in self._admitted_tasks.items()
            if now - admitted.admitted_at > getattr(
                getattr(getattr(self, "config", None), "streaming", None),
                "max_delivery_task_ms",
                60000,
            ) / 1000
        ]
        for task_id in stale_ids:
            self._admitted_tasks.pop(task_id, None)
            task = self._tasks.get(task_id)
            if task is not None:
                task.state = "failed"
                task.error = "delivery admission expired"
                task.completed_at = time.time()
                with self._lock:
                    self._release_window_for_cancelled_task_locked(task)
        if stale_ids:
            print(f"[TTS] expired {len(stale_ids)} stale admitted tasks", flush=True)


        if len(self._admitted_tasks) >= max(max_workers * 16, 32):
            return True
        return False

    def _prepare_speak_task(
        self,
        request: SpeakRequest,
        *,
        wait_for_vendor_ready: bool,
        traceparent: str | None = None,
    ) -> tuple[BridgeTask, Path, int, StreamingProfile, bool]:
        vendor_text = _sanitize_vendor_text(request.text)
        if not vendor_text:
            raise HTTPException(status_code=400, detail="text must not be empty")
        ref_audio_path = self._resolve_ref_audio_path()
        streaming = self.config.streaming
        vendor_ready = self.vendor_manager.ready()
        if vendor_text != request.text:
            print(f"[TTS] sanitized text for vendor: original={request.text[:40]!r} sanitized={vendor_text[:40]!r}", flush=True)
        print(f"[TTS] speak: text={vendor_text[:40]!r} vendor_ready={vendor_ready} streaming={streaming.enabled}", flush=True)
        self._ensure_vendor_ready(wait_for_ready=wait_for_vendor_ready)

        generation_id = self._resolve_generation_id(request)
        task_id = request.segment_id
        cancel_token = f"cancel_{uuid4().hex[:16]}"
        task = BridgeTask(task_id=task_id, trace_id=request.trace_id, state="pending", cancel_token=cancel_token)
        with self._lock:
            self._tasks[task_id] = task

        # 发送给 vendor 的文本必须经过 sanitize：原始文本可能含换行、零宽字符、
        # emoji 或非 GBK 符号，vendor 的 filter_text 对切分后全空白/异常字符的
        # 文本直接抛 ValueError，导致 ASGI 异常与连接重置（WinError 10054），
        # 进而触发 vendor 重启（~20s 冷启动）。raw text 仅用于字幕/诊断。
        task.detail["text"] = vendor_text
        task.detail["original_text"] = request.text
        task.detail["segment_index"] = int(request.index)
        task.detail["generation_id"] = generation_id
        task.detail["latency_trace_started_at"] = time.perf_counter()
        if traceparent:
            task.detail["traceparent"] = traceparent
        task.detail["first_chunk_priority"] = bool(request.metadata.get("first_chunk_priority", False))
        self._register_segment(
            trace_id=request.trace_id,
            generation_id=generation_id,
            segment_index=int(request.index),
            task_id=task_id,
            text=request.text,
            state="pending",
        )
        profile = self._streaming_profile_for_request(
            request.trace_id,
            first_chunk_priority=bool(request.metadata.get("first_chunk_priority", False)),
            segment_index=int(request.index),
            text=vendor_text,
        )
        task.detail["stream_profile"] = profile.label
        task.detail["stream_strategy"] = streaming.stream_strategy

        timeout = min(request.timeout_ms, self.config.request_timeout_ms)

        use_batch_only = self._should_force_batch_for_trace(request.trace_id)
        return task, ref_audio_path, timeout, profile, use_batch_only

    def _deliver_prepared_task(
        self,
        *,
        task: BridgeTask,
        ref_audio_path: Path,
        timeout_ms: int,
        profile: StreamingProfile,
        use_batch_only: bool,
    ) -> dict[str, Any]:
        generation_id = int(task.detail.get("generation_id", 1) or 1)
        task.state = "in_progress"
        if task.started_at is None:
            task.started_at = time.time()
        self._publish_playback_event(
            "synthesizing",
            task=task,
            detail={
                "stream_profile": profile.label,
                "use_batch_only": use_batch_only,
                "vendor_streaming_mode": profile.vendor_streaming_mode,
                "min_chunk_length": profile.min_chunk_length,
                "fragment_interval": profile.fragment_interval,
                "prebuffer_ms": profile.prebuffer_ms,
                "rebuffer_ms": profile.rebuffer_ms,
            },
        )
        _log_latency(task, "worker_started")
        result = self._deliver_task(
            task=task,
            ref_audio_path=ref_audio_path,
            timeout_ms=timeout_ms,
            profile=profile,
            use_batch_only=use_batch_only,
        )
        task.detail["delivery_result"] = dict(result)
        return result

    def _resolve_ref_audio_path(self) -> Path:
        preset = self.config.preset
        if not preset.ref_audio_path:
            raise HTTPException(status_code=500, detail="tts preset ref_audio_path is not configured")
        ref_audio_path = preset.ref_audio_path.resolve()
        if not ref_audio_path.exists():
            raise HTTPException(status_code=500, detail=f"tts preset ref audio not found: {ref_audio_path}")
        return ref_audio_path

    def _ensure_vendor_ready(self, *, wait_for_ready: bool) -> None:
        vendor_ready = self.vendor_manager.ready()
        if vendor_ready:
            return
        started = self.vendor_manager.ensure_running()
        if not wait_for_ready:
            return
        if not self.vendor_manager.wait_until_ready(self.config.startup_timeout_ms):
            print(f"[TTS] vendor NOT ready after wait", flush=True)
            raise HTTPException(status_code=503, detail="vendor tts is not ready")
        if started:
            # vendor 崩溃/重启后冷启动，首个请求 first chunk 会慢（~6s）。
            # 主动 warmup 一次，让后续请求回到 ~400-700ms 首块延迟。
            self._warmup_vendor_best_effort()

    def _deliver_task(
        self,
        *,
        task: BridgeTask,
        ref_audio_path: Path,
        timeout_ms: int,
        profile: StreamingProfile,
        use_batch_only: bool,
    ) -> dict[str, Any]:
        streaming = self.config.streaming
        generation_id = int(task.detail.get("generation_id", 1) or 1)
        segment_index = int(task.detail.get("segment_index", 0) or 0)
        self._wait_for_first_chunk_priority(task=task, generation_id=generation_id, segment_index=segment_index)
        trace_force_batch = self._should_force_batch_for_trace(task.trace_id)
        prefer_batch_prefetch = self._scheduler.prefer_batch_prefetch(
            playback_enabled=self.config.playback_enabled,
            player_is_playing=self.player.is_playing,
            trace_force_batch=trace_force_batch,
        )
        use_batch_only = bool(use_batch_only and not prefer_batch_prefetch)
        self._sliding_window.wait_for_issue_window(
            trace_id=task.trace_id,
            generation_id=generation_id,
            segment_index=segment_index,
            window_size=self._scheduler.window_size + (1 if prefer_batch_prefetch else 0),
        )
        with self._lock:
            session = self._sessions_by_trace.get(task.trace_id)
            if session is not None and session.generation_id == generation_id:
                record = session.segments.get(segment_index)
                if record is not None and record.state not in {"obsolete", "cancelled"}:
                    record.state = "synthesizing"
        if self._scheduler.should_stream(
            streaming_enabled=streaming.enabled,
            stream_strategy=streaming.stream_strategy,
            use_batch_only=use_batch_only,
            prefer_batch_prefetch=prefer_batch_prefetch,
            playback_enabled=self.config.playback_enabled,
            player_supports_streaming=self.player.supports_streaming,
        ):
            try:
                return self._speak_streaming(task, ref_audio_path, timeout_ms, profile=profile)
            except StreamingSynthesisError as exc:
                if streaming.fallback_to_batch_on_failure and exc.fallback_allowed and not task.cancel_requested:
                    print(f"[TTS] streaming unavailable, fallback to batch for task {task.task_id}: {exc.detail}", flush=True)
                    return self._speak_batch(task, ref_audio_path, timeout_ms, adaptive_fallback=True)
                raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
        return self._speak_batch(
            task,
            ref_audio_path,
            timeout_ms,
            adaptive_fallback=(streaming.stream_strategy == "fixed_batch" or use_batch_only),
        )

    def _wait_for_first_chunk_priority(self, *, task: BridgeTask, generation_id: int, segment_index: int) -> None:
        streaming = self.config.streaming
        if (
            streaming.stream_strategy != "fixed_streaming"
            or segment_index <= 1
            or streaming.first_chunk_gate_timeout_ms <= 0
            or self._task_cancelled_or_stale(task)
        ):
            return
        event = self._first_chunk_event(task.trace_id, generation_id)
        if event.is_set():
            return
        waited = event.wait(streaming.first_chunk_gate_timeout_ms / 1000)
        if not waited:
            print(
                f"[TTS] first chunk priority gate timed out for {task.task_id} "
                f"after {streaming.first_chunk_gate_timeout_ms}ms "
                f"(trace={task.trace_id}, generation={generation_id}, segment={segment_index}, "
                f"first_segment_started={self._first_segment_playback_started(trace_id=task.trace_id, generation_id=generation_id)})",
                flush=True,
            )

    def _first_chunk_event(self, trace_id: str, generation_id: int) -> threading.Event:
        key = (trace_id, generation_id)
        with self._lock:
            event = self._first_chunk_events.get(key)
            if event is None:
                event = threading.Event()
                self._first_chunk_events[key] = event
            return event

    def _mark_first_chunk_ready(self, trace_id: str, generation_id: int) -> None:
        self._first_chunk_event(trace_id, generation_id).set()

    def _first_segment_playback_started(self, *, trace_id: str, generation_id: int) -> bool:
        sessions = getattr(self, "_sessions_by_trace", None)
        if sessions is None:
            return False
        with self._lock:
            session = sessions.get(trace_id)
            if session is None or session.generation_id != generation_id:
                return False
            first = session.segments.get(1)
            if first is None:
                return False
            if first.state in {"playing", "completed"}:
                return True
            detail = first.detail
            return bool(detail.get("playback_started") or detail.get("playback_completed"))

    def _estimate_stream_duration_ms(self, text: str, *, speed_factor: float) -> int:
        """自适应估算 segment 总时长。"""
        return self.adaptive_engine.estimate_duration_ms(text, speed_factor=speed_factor)

    def _update_adaptive_duration(self, actual_ms: int, char_count: int, speed_factor: float) -> None:
        """producer 完成后用实际时长更新自适应历史（EMA）。"""
        self.adaptive_engine.update_duration(actual_ms, char_count, speed_factor)

    def _speak_streaming(self, task: BridgeTask, ref_audio_path: Path, timeout_ms: int, *, profile: StreamingProfile) -> dict[str, Any]:
        """流式合成 + 实时播放：边合成边播，最低延迟。"""
        streaming = self.config.streaming
        preset = self.config.preset
        text_for_duration = str(task.detail.get("text", ""))
        estimated_duration_ms = self._estimate_stream_duration_ms(text_for_duration, speed_factor=preset.speed_factor)
        generation_id = int(task.detail.get("generation_id", 1) or 1)
        segment_index = int(task.detail.get("segment_index", 0) or 0)

        stream_session = self.streaming_engine.start_stream(
            task=task,
            ref_audio_path=ref_audio_path,
            timeout_ms=timeout_ms,
            profile=profile,
            estimated_duration_ms=estimated_duration_ms,
            on_first_chunk=lambda: self._mark_first_chunk_ready(task.trace_id, generation_id),
            is_cancelled=lambda: self._task_cancelled_or_stale(task),
        )

        registered = self._register_ready_segment(
            trace_id=task.trace_id,
            generation_id=generation_id,
            segment_index=segment_index,
            task_id=task.task_id,
            text=text_for_duration,
            asset=stream_session.asset,
            detail={
                "duration_ms": estimated_duration_ms,
                "sample_rate": streaming.sample_rate,
                "latency_ms": 0.0,
                "streaming_mode": True,
                "stream_profile": profile.label,
            },
        )
        if not registered:
            task.state = "cancelled"
            task.completed_at = time.time()
            stream_session.close()
            return {
                "status": "cancelled",
                "task_id": task.task_id,
                "audio_id": "",
                "cancel_token": task.cancel_token,
                "audio_path": "",
                "duration_ms": 0,
                "sample_rate": streaming.sample_rate,
                "media_type": streaming.media_type,
                "playback_started": False,
                "playback_completed": False,
                "streaming_mode": True,
                "late_result_discarded": True,
            }

        playback_result = self._play_ready_segment(trace_id=task.trace_id, generation_id=generation_id, segment_index=segment_index)
        _log_latency(
            task,
            "playback_result",
            playback_started=playback_result.get("playback_started", False),
            playback_completed=playback_result.get("playback_completed", False),
            first_chunk_latency_ms=playback_result.get("first_chunk_latency_ms"),
            playback_start_latency_ms=playback_result.get("playback_start_latency_ms"),
            rebuffer_count=playback_result.get("rebuffer_count"),
        )
        playback_result = self._playback.finalize_late_result(
            is_current_generation=self._sliding_window.is_current_generation(trace_id=task.trace_id, generation_id=generation_id),
            playback_result=playback_result,
        )
        playback_start_latency_ms = playback_result.get("playback_start_latency_ms")
        if playback_start_latency_ms is not None:
            playback_start_latency_ms = float(playback_start_latency_ms)

        stream_session.wait_for_producer(timeout=1.0)
        producer_error = stream_session.producer_error
        if producer_error is not None:
            kind, exc = producer_error
            playback_started = self._player_playback_started()
            if not playback_started:
                with self._lock:
                    session = self._sessions_by_trace.get(task.trace_id)
                    if session is not None and session.generation_id == generation_id:
                        record = session.segments.get(segment_index)
                        if record is not None:
                            record.state = "failed"
                            record.asset = None
                            record.detail = {}
                        session.next_play_index = min(session.next_play_index, segment_index)
                        if session.condition is not None:
                            session.condition.notify_all()
            fallback_allowed = not playback_started
            if not fallback_allowed:
                task.state = "failed"
                task.completed_at = time.time()
                task.error = str(exc)
            if kind == "timeout":
                raise StreamingSynthesisError("tts vendor request timed out", status_code=504, fallback_allowed=fallback_allowed) from exc
            if kind == "lock_timeout":
                raise StreamingSynthesisError(
                    f"tts synthesis lock timeout: {exc}",
                    status_code=503,
                    fallback_allowed=fallback_allowed,
                ) from exc
            if kind == "stalled":
                # 播放端停滞（队列无消费空间）。任务已在上方标记 failed；
                # 不 fallback 到 batch（播放端同样无法消费），明确失败上报。
                raise StreamingSynthesisError(
                    f"tts playback consumption stalled: {exc}",
                    status_code=503,
                    fallback_allowed=False,
                ) from exc
            raise StreamingSynthesisError(f"tts vendor request failed: {exc}", status_code=502, fallback_allowed=fallback_allowed) from exc

        if task.cancel_requested:
            task.state = "cancelled"
            task.completed_at = time.time()
            return {
                "status": "cancelled",
                "task_id": task.task_id,
                "audio_id": "",
                "cancel_token": task.cancel_token,
                "audio_path": "",
                "duration_ms": 0,
                "sample_rate": streaming.sample_rate,
                "media_type": streaming.media_type,
                "playback_started": False,
                "streaming_mode": True,
            }

        synth_metrics = stream_session.compute_synthesis_metrics()
        total_bytes = synth_metrics["total_bytes"]
        duration_ms = synth_metrics["duration_ms"]
        chunk_count = synth_metrics["chunk_count"]
        avg_chunk_gap_ms = synth_metrics["avg_chunk_gap_ms"]
        max_chunk_gap_ms = synth_metrics["max_chunk_gap_ms"]
        chunk_gap_over_120ms = synth_metrics["chunk_gap_over_120ms"]
        avg_chunk_audio_ms = synth_metrics["avg_chunk_audio_ms"]
        latency_ms = synth_metrics["latency_ms"]
        realtime_factor = synth_metrics["realtime_factor"]
        first_chunk_latency_ms = synth_metrics["first_chunk_latency_ms"]

        # 用实际时长更新自适应历史，让后续 segment 的估算自动适应当前语速倍率和电脑性能
        if duration_ms > 0:
            compact_char_count = len("".join(ch for ch in text_for_duration if not ch.isspace()))
            self._update_adaptive_duration(
                actual_ms=duration_ms,
                char_count=compact_char_count,
                speed_factor=preset.speed_factor,
            )

        if total_bytes <= 0:
            print(f"[TTS] streaming vendor returned empty audio", flush=True)
            raise StreamingSynthesisError("tts vendor returned empty audio", status_code=502, fallback_allowed=True)

        audio_id = hashlib.sha1(str(task.task_id).encode()).hexdigest()[:16]

        playback_first_chunk_latency_ms = playback_result.get("first_chunk_latency_ms")
        if playback_first_chunk_latency_ms is None:
            playback_first_chunk_latency_ms = first_chunk_latency_ms
        first_chunk_latency_ms = playback_first_chunk_latency_ms
        underrun_count = int(playback_result.get("underrun_count", 0) or 0)
        tail_padding_count = int(playback_result.get("tail_padding_count", 0) or 0)
        rebuffer_count = int(playback_result.get("rebuffer_count", 0) or 0)

        detail = {
            "duration_ms": duration_ms,
            "sample_rate": streaming.sample_rate,
            "latency_ms": latency_ms,
            "total_bytes": total_bytes,
            "stream_profile": profile.label,
            "chunk_count": chunk_count,
            "first_chunk_latency_ms": first_chunk_latency_ms,
            "playback_start_latency_ms": playback_start_latency_ms,
            "underrun_count": underrun_count,
            "tail_padding_count": tail_padding_count,
            "rebuffer_count": rebuffer_count,
            "avg_chunk_gap_ms": avg_chunk_gap_ms,
            "max_chunk_gap_ms": max_chunk_gap_ms,
            "chunk_gap_over_120ms": chunk_gap_over_120ms,
            "avg_chunk_audio_ms": avg_chunk_audio_ms,
            "realtime_factor": realtime_factor,
            "drain_timeout_ms": max(duration_ms + 1500, streaming.drain_timeout_ms),
            "playback_completed": False,
        }

        task.completed_at = time.time()
        task.audio_id = audio_id
        task.detail = {
            **task.detail,
            **detail,
        }
        task.detail["playback_started"] = playback_result["playback_started"]
        task.detail["playback_completed"] = playback_result["playback_completed"]
        task.detail["first_chunk_latency_ms"] = first_chunk_latency_ms
        task.detail["playback_start_latency_ms"] = playback_start_latency_ms
        task.detail["underrun_count"] = underrun_count
        task.detail["tail_padding_count"] = tail_padding_count
        task.detail["rebuffer_count"] = rebuffer_count

        if not playback_result["playback_completed"]:
            task.state = "failed"
            task.error = str(playback_result.get("playback_error") or "Audio playback did not complete.")
            self._publish_playback_event(
                "failed",
                task=task,
                detail={
                    "audio_id": audio_id,
                    "duration_ms": duration_ms,
                    "playback_started": playback_result["playback_started"],
                    "playback_completed": False,
                    "error": task.error,
                },
            )
            return {
                "status": "failed",
                "task_id": task.task_id,
                "audio_id": audio_id,
                "error": task.error,
                "playback_started": playback_result["playback_started"],
                "playback_completed": False,
            }

        task.state = "completed"
        self._mark_segment_completed(
            trace_id=task.trace_id,
            generation_id=generation_id,
            segment_index=segment_index,
            detail=task.detail,
        )
        self._publish_playback_event(
            "completed",
            task=task,
            detail={
                "audio_id": audio_id,
                "duration_ms": duration_ms,
                "playback_started": playback_result["playback_started"],
                "playback_completed": playback_result["playback_completed"],
                "chunk_count": chunk_count,
            },
        )
        self._record_adaptive_result(task.trace_id, task.detail, used_batch=False)
        print(
            "[TTS] streamed: "
            f"{duration_ms}ms audio in {latency_ms}ms "
            f"({total_bytes} bytes, chunks={chunk_count}, first_chunk={first_chunk_latency_ms}, "
            f"playback_start={playback_start_latency_ms}, underrun={underrun_count}, "
            f"tail_padding={tail_padding_count}, rebuffer={rebuffer_count}, avg_gap={avg_chunk_gap_ms}ms, "
            f"max_gap={max_chunk_gap_ms}ms, avg_chunk_audio={avg_chunk_audio_ms}ms, "
            f"rtf={realtime_factor})",
            flush=True,
        )

        return {
            "status": "delivered",
            "task_id": task.task_id,
            "audio_id": audio_id,
            "cancel_token": task.cancel_token,
            "audio_path": "",
            "duration_ms": duration_ms,
            "sample_rate": streaming.sample_rate,
            "media_type": streaming.media_type,
            "stream_profile": profile.label,
            "playback_started": playback_result["playback_started"],
            "playback_completed": playback_result["playback_completed"],
            "first_chunk_latency_ms": first_chunk_latency_ms,
            "playback_start_latency_ms": playback_start_latency_ms,
            "chunk_count": chunk_count,
            "underrun_count": underrun_count,
            "tail_padding_count": tail_padding_count,
            "rebuffer_count": rebuffer_count,
            "avg_chunk_gap_ms": avg_chunk_gap_ms,
            "max_chunk_gap_ms": max_chunk_gap_ms,
            "chunk_gap_over_120ms": chunk_gap_over_120ms,
            "avg_chunk_audio_ms": avg_chunk_audio_ms,
            "realtime_factor": realtime_factor,
            "streaming_mode": True,
            "late_result_discarded": bool(playback_result.get("late_result_discarded", False)),
        }

    def _speak_batch(self, task: BridgeTask, ref_audio_path: Path, timeout_ms: int, *, adaptive_fallback: bool = False) -> dict[str, Any]:
        """传统批量合成：等完整 WAV 返回后播放。"""
        preset = self.config.preset
        payload: dict[str, Any] = {"media_type": preset.media_type}
        if self.config.vendor.api_style == "legacy":
            payload.update({"text": task.detail["text"], "text_language": preset.text_lang})
        else:
            payload.update({
                "text": task.detail["text"],
                # 动态语言：纯中文/中文夹英文 → zh（以中文为准，避免 zh/ja 误判）；
                # 含假名/谚文 → auto（混合语言按段自动识别）
                "text_lang": _vendor_text_lang_for(task.detail["text"]),
                "ref_audio_path": str(ref_audio_path),
                "prompt_text": preset.prompt_text,
                "prompt_lang": preset.prompt_lang,
                "text_split_method": preset.text_split_method,
                "speed_factor": preset.speed_factor,
                "streaming_mode": False,
            })

        synth = self._synthesize_batch_audio(task, payload=payload, timeout_ms=timeout_ms, media_type=preset.media_type)
        if synth is None:
            return self._cancelled_delivery_receipt(
                task=task,
                sample_rate=0,
                media_type=preset.media_type,
                extra={"batch_mode": True, "adaptive_fallback": adaptive_fallback},
            )
        return self._play_batch_artifact(task, synth=synth, adaptive_fallback=adaptive_fallback)

    def _synthesize_batch_audio(
        self,
        task: BridgeTask,
        *,
        payload: dict[str, Any],
        timeout_ms: int,
        media_type: str,
    ) -> dict[str, Any] | None:
        started_at = time.perf_counter()
        try:
            if not self._synthesis_lock.acquire(timeout=self.config.streaming.synthesis_lock_timeout_ms / 1000):
                task.state = "failed"
                task.completed_at = time.time()
                task.error = "timed out waiting for synthesis lock"
                raise HTTPException(status_code=503, detail=task.error)
            try:
                response = self.vendor_manager.synthesize(payload, timeout_ms=timeout_ms)
            finally:
                self._synthesis_lock.release()

        except httpx.TimeoutException as exc:
            task.state = "failed"
            task.completed_at = time.time()
            task.error = str(exc)
            raise HTTPException(status_code=504, detail="tts vendor request timed out") from exc
        except httpx.HTTPError as exc:
            task.state = "failed"
            task.completed_at = time.time()
            task.error = str(exc)
            raise HTTPException(status_code=502, detail=f"tts vendor request failed: {exc}") from exc

        if response.status_code != 200:
            task.state = "failed"
            task.completed_at = time.time()
            task.error = response.text
            print(f"[TTS] vendor error {response.status_code}: {response.text[:500]}", flush=True)
            raise HTTPException(status_code=502, detail=self._vendor_failure_detail(response))

        if self._task_cancelled_or_stale(task):
            task.state = "cancelled"
            task.completed_at = time.time()
            return None

        audio_bytes = response.content
        duration_ms, sample_rate = _wav_metadata(audio_bytes)
        if sample_rate is None or duration_ms is None or duration_ms <= 0:
            task.state = "failed"
            task.completed_at = time.time()
            task.error = "tts vendor returned empty audio"
            print(f"[TTS] vendor returned empty audio: {len(audio_bytes)} bytes", flush=True)
            raise HTTPException(status_code=502, detail="tts vendor returned empty audio")

        audio_id = hashlib.sha1(audio_bytes).hexdigest()[:16]
        artifact_path = self._write_audio_artifact(
            task_id=task.task_id, audio_id=audio_id, audio_bytes=audio_bytes, media_type=media_type,
        )
        latency_ms = round((time.perf_counter() - started_at) * 1000, 2)
        print(f"[TTS] delivered: {duration_ms}ms audio in {latency_ms}ms ({len(audio_bytes)} bytes)", flush=True)
        return {
            "audio_id": audio_id,
            "artifact_path": artifact_path,
            "duration_ms": duration_ms,
            "sample_rate": sample_rate,
            "latency_ms": latency_ms,
        }

    def _play_batch_artifact(
        self,
        task: BridgeTask,
        *,
        synth: dict[str, Any],
        adaptive_fallback: bool,
    ) -> dict[str, Any]:
        asset = AudioAsset(
            kind="file",
            artifact_path=Path(str(synth["artifact_path"])),
            sample_rate=int(synth["sample_rate"]),
            duration_ms=int(synth["duration_ms"]),
            media_type=self.config.preset.media_type,
            metrics={"batch_mode": True, "adaptive_fallback": adaptive_fallback},
        )
        generation_id = int(task.detail.get("generation_id", 1) or 1)
        segment_index = int(task.detail.get("segment_index", 0) or 0)
        registered = self._register_ready_segment(
            trace_id=task.trace_id,
            generation_id=generation_id,
            segment_index=segment_index,
            task_id=task.task_id,
            text=str(task.detail.get("text", "")),
            asset=asset,
            detail={
                "duration_ms": synth["duration_ms"],
                "sample_rate": synth["sample_rate"],
                "latency_ms": synth["latency_ms"],
                "batch_mode": True,
                "adaptive_fallback": adaptive_fallback,
            },
        )
        if not registered:
            task.state = "cancelled"
            task.completed_at = time.time()
            return {
                "status": "cancelled",
                "task_id": task.task_id,
                "audio_id": "",
                "cancel_token": task.cancel_token,
                "audio_path": "",
                "duration_ms": 0,
                "sample_rate": int(synth["sample_rate"]),
                "media_type": self.config.preset.media_type,
                "playback_started": False,
                "playback_completed": False,
                "batch_mode": True,
                "adaptive_fallback": adaptive_fallback,
                "late_result_discarded": True,
            }
        playback_result = self._play_ready_segment(trace_id=task.trace_id, generation_id=generation_id, segment_index=segment_index)
        playback_result = self._playback.finalize_late_result(
            is_current_generation=self._sliding_window.is_current_generation(trace_id=task.trace_id, generation_id=generation_id),
            playback_result=playback_result,
        )
        task.completed_at = time.time()
        task.audio_id = str(synth["audio_id"])
        task.artifact_path = str(synth["artifact_path"])
        task.detail = {
            **task.detail,
            "duration_ms": synth["duration_ms"],
            "sample_rate": synth["sample_rate"],
            "latency_ms": synth["latency_ms"],
            "batch_mode": True,
            "adaptive_fallback": adaptive_fallback,
            "playback_started": playback_result["playback_started"],
            "playback_completed": playback_result["playback_completed"],
            "late_result_discarded": bool(playback_result.get("late_result_discarded", False)),
        }
        if not playback_result["playback_completed"]:
            task.state = "failed"
            task.error = str(playback_result.get("playback_error") or "Audio playback did not complete.")
            self._publish_playback_event(
                "failed",
                task=task,
                detail={
                    "audio_id": task.audio_id,
                    "duration_ms": synth["duration_ms"],
                    "playback_started": playback_result["playback_started"],
                    "playback_completed": False,
                    "error": task.error,
                },
            )
            return {
                "status": "failed",
                "task_id": task.task_id,
                "audio_id": synth["audio_id"],
                "error": task.error,
                "playback_started": playback_result["playback_started"],
                "playback_completed": False,
            }
        task.state = "completed"
        self._record_adaptive_result(task.trace_id, task.detail, used_batch=True)
        self._mark_segment_completed(
            trace_id=task.trace_id,
            generation_id=generation_id,
            segment_index=segment_index,
            detail=task.detail,
        )
        self._publish_playback_event(
            "completed",
            task=task,
            detail={
                "audio_id": task.audio_id,
                "duration_ms": synth["duration_ms"],
                "playback_started": playback_result["playback_started"],
                "playback_completed": playback_result["playback_completed"],
                "batch_mode": True,
                "adaptive_fallback": adaptive_fallback,
            },
        )

        return {
            "status": "delivered",
            "task_id": task.task_id,
            "audio_id": synth["audio_id"],
            "cancel_token": task.cancel_token,
            "audio_path": str(synth["artifact_path"]),
            "duration_ms": synth["duration_ms"],
            "sample_rate": synth["sample_rate"],
            "media_type": self.config.preset.media_type,
            "playback_started": playback_result["playback_started"],
            "playback_completed": playback_result["playback_completed"],
            "batch_mode": True,
            "adaptive_fallback": adaptive_fallback,
            "late_result_discarded": bool(playback_result.get("late_result_discarded", False)),
        }

    def _play_streaming_asset(self, *, task: BridgeTask, asset: AudioAsset, chunk_buffer: list[bytes]) -> dict[str, Any]:
        prebuffer_ms = int(asset.metrics.get("prebuffer_ms", self.config.streaming.prebuffer_ms) or self.config.streaming.prebuffer_ms)
        rebuffer_ms = int(asset.metrics.get("rebuffer_ms", self.config.streaming.rebuffer_ms) or self.config.streaming.rebuffer_ms)
        generation_id = int(task.detail.get("generation_id", 1) or 1)
        segment_index = int(task.detail.get("segment_index", 0) or 0)

        def mirror_playback_chunks(chunks):
            lipsync_config = getattr(self.config, "lipsync_bridge", None)
            if not bool(getattr(lipsync_config, "streaming_enabled", False)):
                yield from chunks
                return
            # 嘴型同步链路不复用 tts_bridge 的 prebuffer/rebuffer（340/380ms）。
            # VB-Cable 只需极小 prebuffer（lipsync_bridge 默认 20ms）即可开始输出，
            # 否则 VTube Studio 采样会滞后于真实喇叭播放，导致嘴型慢一拍。
            self.lipsync_bridge.stream_start_async(
                trace_id=task.trace_id,
                generation_id=generation_id,
                segment_index=segment_index,
                task_id=task.task_id,
                text=str(task.detail.get("text", "")),
                sample_rate=asset.sample_rate,
                duration_ms=asset.duration_ms,
            )
            try:
                for chunk in chunks:
                    self.lipsync_bridge.stream_chunk_async(task_id=task.task_id, chunk=chunk)
                    yield chunk
            finally:
                self.lipsync_bridge.stream_finish_async(task_id=task.task_id)

        if not callable(getattr(self.player, "progress_snapshot", None)):
            if asset.pcm_stream is not None:
                play_streaming = getattr(self.player, "play_streaming_chunks_and_wait", None)
                if callable(play_streaming):
                    playback_completed = play_streaming(
                        sample_rate=asset.sample_rate,
                        chunk_source=mirror_playback_chunks(asset.pcm_stream),
                        timeout_ms=playback_timeout_ms(asset.duration_ms, self.config.streaming.drain_timeout_ms),
                        prebuffer_ms=prebuffer_ms,
                        rebuffer_ms=rebuffer_ms,
                    )
                else:
                    start_stream = getattr(self.player, "start_stream", None)
                    feed = getattr(self.player, "feed", None)
                    finish_stream = getattr(self.player, "finish_stream", None)
                    wait_until_drained = getattr(self.player, "wait_until_drained", None)
                    if not all(callable(item) for item in (start_stream, feed, finish_stream, wait_until_drained)):
                        return self._play_streaming_asset(task=task, asset=AudioAsset(
                            kind="pcm",
                            artifact_path=None,
                            sample_rate=asset.sample_rate,
                            duration_ms=asset.duration_ms,
                            media_type=asset.media_type,
                            pcm_bytes=asset.pcm_bytes,
                            metrics=asset.metrics,
                        ), chunk_buffer=[asset.pcm_bytes or b""])
                    resume_or_start = getattr(self.player, "resume_or_start_stream", None) or start_stream
                    resume_or_start(sample_rate=asset.sample_rate, prebuffer_ms=prebuffer_ms, rebuffer_ms=rebuffer_ms)
                    try:
                        for chunk in mirror_playback_chunks(asset.pcm_stream):
                            feed(chunk)
                    finally:
                        finish_stream()
                    playback_completed = bool(wait_until_drained(playback_timeout_ms(asset.duration_ms, self.config.streaming.drain_timeout_ms)))
                stats = self.player.stream_stats()
                snapshot = self._run_subtitle_progress_loop(task=task, duration_ms=asset.duration_ms)
                return {
                    **stats,
                    "playback_started": bool(stats.get("playback_started", False)),
                    "playback_completed": playback_completed,
                    "played_ms": snapshot.played_ms,
                    "buffered_ms": snapshot.buffered_ms,
                }
            playback_completed = self.player.play_pcm_and_wait(
                pcm_bytes=asset.pcm_bytes or b"",
                sample_rate=asset.sample_rate,
                timeout_ms=playback_timeout_ms(asset.duration_ms, self.config.streaming.drain_timeout_ms),
                prebuffer_ms=prebuffer_ms,
                rebuffer_ms=rebuffer_ms,
            )
            stats = self.player.stream_stats()
            snapshot = self._run_subtitle_progress_loop(task=task, duration_ms=asset.duration_ms)
            return {
                **stats,
                "playback_started": bool(stats.get("playback_started", False)),
                "playback_completed": playback_completed,
                "played_ms": snapshot.played_ms,
                "buffered_ms": snapshot.buffered_ms,
            }
        start_stream = getattr(self.player, "resume_or_start_stream", None) or self.player.start_stream
        start_stream(
            sample_rate=asset.sample_rate,
            prebuffer_ms=prebuffer_ms,
            rebuffer_ms=rebuffer_ms,
        )
        duration_holder: dict[str, float] = {}
        snapshot_box: dict[str, PlaybackProgressSnapshot] = {}
        progress_thread = threading.Thread(
            target=lambda: snapshot_box.setdefault(
                "snapshot",
                self._run_subtitle_progress_loop(task=task, duration_ms=asset.duration_ms, duration_holder=duration_holder),
            ),
            daemon=True,
        )
        progress_thread.start()
        streamed_bytes = 0
        try:
            for chunk in mirror_playback_chunks(chunk_buffer):
                if task.cancel_requested:
                    break
                streamed_bytes += len(chunk)
                self.player.feed(chunk)
        finally:
            self.player.finish_stream()
            # producer 完成后用真实字节计算总时长，一次性写入 duration_holder。
            # 不在循环内用动态增长的 stream_audio_ms 更新分母，否则播放初期分母
            # 偏小导致 ratio 偏大、字幕超前。
            if streamed_bytes > 0 and asset.sample_rate > 0:
                duration_holder["ms"] = streamed_bytes / 2 / asset.sample_rate * 1000
        actual_duration_ms = (
            int(streamed_bytes / 2 / asset.sample_rate * 1000)
            if asset.sample_rate > 0
            else asset.duration_ms
        )
        drain_duration_ms = max(asset.duration_ms, actual_duration_ms)
        timeout_ms = int(
            asset.metrics.get("drain_timeout_ms")
            or playback_timeout_ms(drain_duration_ms, self.config.streaming.drain_timeout_ms)
        )
        playback_completed = self.player.wait_until_drained(timeout_ms)
        progress_thread.join(timeout=1.0)
        snapshot = snapshot_box.get("snapshot", self._player_progress_snapshot(duration_ms=asset.duration_ms))
        stats = self.player.stream_stats()
        # 连续分句间保持声卡流开启，由 AudioPlayback 内部闲置计时器或 cancel_all 负责收尾，
        # 不在此处掐断声卡，彻底杜绝句末 Pop 声与字尾丢失。
        return {
            **stats,
            "playback_started": bool(stats.get("playback_started", False)),
            "playback_completed": playback_completed,
            "played_ms": snapshot.played_ms,
            "buffered_ms": snapshot.buffered_ms,
        }

    def _play_file_asset(self, *, task: BridgeTask, asset: AudioAsset) -> dict[str, Any]:
        if asset.artifact_path is None:
            return {"playback_started": False, "playback_completed": False}
        if not callable(getattr(self.player, "progress_snapshot", None)):
            timeout_ms = playback_timeout_ms(asset.duration_ms, self.config.streaming.drain_timeout_ms)
            playback_completed = self.player.enqueue_and_wait(asset.artifact_path, wait=True, timeout_ms=timeout_ms)
            snapshot = self._run_subtitle_progress_loop(task=task, duration_ms=asset.duration_ms)
            return {
                "playback_started": snapshot.playback_started,
                "playback_completed": playback_completed,
                "played_ms": snapshot.played_ms,
                "buffered_ms": snapshot.buffered_ms,
            }
        timeout_ms = playback_timeout_ms(asset.duration_ms, self.config.streaming.drain_timeout_ms)
        snapshot_box: dict[str, PlaybackProgressSnapshot] = {}
        progress_thread = threading.Thread(
            target=lambda: snapshot_box.setdefault("snapshot", self._run_subtitle_progress_loop(task=task, duration_ms=asset.duration_ms)),
            daemon=True,
        )
        progress_thread.start()
        playback_completed = self.player.play_file_as_pcm_and_wait(
            path=asset.artifact_path,
            timeout_ms=timeout_ms,
            prebuffer_ms=self.config.streaming.prebuffer_ms,
            rebuffer_ms=self.config.streaming.rebuffer_ms,
        )
        progress_thread.join(timeout=1.0)
        snapshot = snapshot_box.get("snapshot", self._player_progress_snapshot(duration_ms=asset.duration_ms))
        return {
            "playback_started": snapshot.playback_started,
            "playback_completed": playback_completed,
            "played_ms": snapshot.played_ms,
            "buffered_ms": snapshot.buffered_ms,
        }

    def _play_batch_asset(self, *, task: BridgeTask, asset: AudioAsset) -> dict[str, Any]:
        return self._play_file_asset(task=task, asset=asset)

    def _run_subtitle_progress_loop(self, *, task: BridgeTask, duration_ms: int, duration_holder: dict[str, float] | None = None) -> PlaybackProgressSnapshot:
        generation_id = int(task.detail.get("generation_id", 1) or 1)
        segment_index = int(task.detail.get("segment_index", 0) or 0)

        def current_duration() -> int:
            # producer 完成前用估算值（保守偏大，字幕稍慢但不超前）；
            # producer 完成后用 duration_holder 的精确字节换算值，字幕立即校正到真实时长。
            # 不取 max：若估算偏大，max 会让 effective_duration 始终等于估算值，
            # 字幕一直慢，直到 segment_finished 时 revealed=total，剩余字符瞬间显示，
            # 造成"语音结束时一股脑快速出来"的现象。
            # stream_audio_ms 是已接收的音频时长（非总时长），不能作为分母，否则 ratio 偏大、字幕超前。
            if duration_holder is not None:
                dynamic = duration_holder.get("ms")
                if dynamic and dynamic > 0:
                    return int(dynamic)
            return duration_ms

        def remember_snapshot(snapshot: PlaybackProgressSnapshot) -> PlaybackProgressSnapshot:
            text = str(task.detail.get("text", ""))
            graphemes = _graphemes(text)
            if snapshot.segment_finished:
                revealed_count = len(graphemes)
            elif snapshot.duration_ms > 0:
                revealed_count = min(
                    len(graphemes),
                    max(0, math.floor(snapshot.played_ms / snapshot.duration_ms * len(graphemes))),
                )
            else:
                revealed_count = 0
            subtitle_state = {
                "generation_id": generation_id,
                "segment_index": segment_index,
                "text": text,
                "played_ms": snapshot.played_ms,
                "playback_started": snapshot.playback_started,
                "playback_completed": snapshot.segment_finished,
                "revealed_text": "".join(graphemes[:revealed_count]),
                "revealed_count": revealed_count,
            }
            with self._lock:
                task.subtitle_state = subtitle_state
            self._publish_playback_event(
                "playback_started" if snapshot.playback_started and not snapshot.segment_finished else "subtitle",
                task=task,
                detail={
                    "played_ms": snapshot.played_ms,
                    "buffered_ms": snapshot.buffered_ms,
                    "playback_started": snapshot.playback_started,
                    "playback_completed": snapshot.segment_finished,
                    # 声学电平随进度事件一并下发：消费端（口型）不需要第二条通道。
                    # 只给测量值，包络平滑由消费端按自己的渲染节拍做。
                    "rms": snapshot.rms,
                    "peak": snapshot.peak,
                },
            )
            return snapshot

        progress_snapshot = getattr(self.player, "progress_snapshot", None)
        if not callable(progress_snapshot):
            subtitle_sync_config = getattr(self.subtitle_sync, "config", None)
            fallback_mode = getattr(subtitle_sync_config, "fallback_mode", "sentence_only")
            if fallback_mode == "sentence_only":
                snapshot = self.subtitle_sync.emit_estimated_progress(
                    trace_id=task.trace_id,
                    generation_id=generation_id,
                    segment_index=segment_index,
                    task_id=task.task_id,
                    text=str(task.detail.get("text", "")),
                    duration_ms=duration_ms,
                    cancel_requested=lambda: task.cancel_requested,
                )
                remember_snapshot(snapshot)
            else:
                snapshot = self._player_progress_snapshot(duration_ms=duration_ms)
                remember_snapshot(snapshot)
        else:
            snapshot = self.subtitle_sync.run_progress_loop(
                trace_id=task.trace_id,
                generation_id=generation_id,
                segment_index=segment_index,
                task_id=task.task_id,
                text=str(task.detail.get("text", "")),
                duration_ms=current_duration(),
                snapshot_getter=lambda: remember_snapshot(progress_snapshot(duration_ms=current_duration())),
                cancel_requested=lambda: task.cancel_requested,
            )
        remember_snapshot(snapshot)
        with self._lock:
            session = self._sessions_by_trace.get(task.trace_id)
            if session is not None and session.generation_id == generation_id:
                if session.expected_end_index == segment_index and snapshot.segment_finished:
                    self.subtitle_sync.emit_turn_end(
                        trace_id=task.trace_id,
                        generation_id=generation_id,
                        task_id=task.task_id,
                        segment_index=segment_index,
                    )
        return snapshot

    def _player_progress_snapshot(self, *, duration_ms: int) -> PlaybackProgressSnapshot:
        progress_snapshot = getattr(self.player, "progress_snapshot", None)
        if callable(progress_snapshot):
            return progress_snapshot(duration_ms=duration_ms)
        stats = {}
        stream_stats = getattr(self.player, "stream_stats", None)
        if callable(stream_stats):
            stats = dict(stream_stats() or {})
        return PlaybackProgressSnapshot(
            playback_started=bool(stats.get("playback_started", False)),
            played_ms=float(duration_ms if stats.get("playback_started", False) else 0.0),
            played_samples=0,
            buffered_ms=0.0,
            segment_finished=True,
            duration_ms=duration_ms,
        )

    def _player_playback_started(self) -> bool:
        stream_stats = getattr(self.player, "stream_stats", None)
        if callable(stream_stats):
            stats = dict(stream_stats() or {})
            return bool(stats.get("playback_started", False))
        return False

    def cancel(self, request: CancelRequest) -> dict[str, Any]:
        with self._lock:
            task = self._tasks.get(request.task_id)
            if task is None or task.trace_id != request.trace_id:
                return {
                    "status": "not_found",
                    "task_id": request.task_id,
                    "cancel_token": "",
                }
            if task.state in {"completed", "failed"}:
                return {
                    "status": "too_late",
                    "task_id": task.task_id,
                    "cancel_token": task.cancel_token,
                }
            task.cancel_requested = True
            if task.stream_cancel_event is not None:
                task.stream_cancel_event.set()

            # 立即停止播放（流式和文件模式）
            self.player.cancel_all()
            if task.state == "pending":
                task.state = "cancelled"
                task.completed_at = time.time()
                self._release_window_for_cancelled_task_locked(task)

            response = {
                "status": "cancelled",
                "task_id": task.task_id,
                "cancel_token": task.cancel_token,
            }
        self._publish_playback_event("cancelled", task=task, detail={"reason": "cancel"})
        return response

    def cancel_trace(self, request: CancelTraceRequest) -> dict[str, Any]:
        affected: list[BridgeTask]
        boundary_task_ids: list[str] = []
        immediate_cutoff_segments: list[dict[str, Any]] = []
        with self._lock:
            if request.mode == "immediate":
                immediate_cutoff_segments = self._cutoff_segments_for_trace_locked(request.trace_id)
            session = self._sessions_by_trace.get(request.trace_id)
            playing_task_ids = {
                record.task_id
                for record in (session.segments.values() if session is not None else [])
                if record.state == "playing"
            }
            affected = [task for task in self._tasks.values() if task.trace_id == request.trace_id and task.state not in {"completed", "failed", "cancelled", "obsolete"}]
            for task in affected:
                if request.mode == "segment_boundary" and task.task_id in playing_task_ids:
                    boundary_task_ids.append(task.task_id)
                    continue
                task.cancel_requested = True
                if task.stream_cancel_event is not None:
                    task.stream_cancel_event.set()

                if task.state == "pending":
                    task.state = "cancelled"
                    task.completed_at = time.time()
                elif task.state in {"ready", "synthesizing"}:
                    task.state = "obsolete"
                    task.completed_at = time.time()
            if session is not None:
                session.closed = True
            for task_id in list(self._admitted_tasks.keys()):
                task = self._tasks.get(task_id)
                if task is not None and task.trace_id == request.trace_id:
                    self._admitted_tasks.pop(task_id, None)
            self._next_generation_id_by_trace[request.trace_id] = self._next_generation_id_by_trace.get(request.trace_id, 1) + 1
            generation_id = self._next_generation_id_by_trace[request.trace_id]
            first_chunk_events = getattr(self, "_first_chunk_events", {})
            for key, event in list(first_chunk_events.items()):
                if key[0] == request.trace_id:
                    event.set()
                    first_chunk_events.pop(key, None)
        self._sliding_window.close_trace(request.trace_id)
        if request.mode == "immediate" or not boundary_task_ids:
            self.player.cancel_all()
            self.subtitle_sync.emit_clear(trace_id=request.trace_id, generation_id=generation_id, reason="cancel_trace")
            self.lipsync_bridge.cancel_trace_async(trace_id=request.trace_id)
        else:
            deadline = time.monotonic() + max(self.config.streaming.drain_timeout_ms, 30_000) / 1000
            while time.monotonic() < deadline:
                with self._lock:
                    active_session = self._sessions_by_trace.get(request.trace_id)
                    still_playing = active_session is not None and any(
                        record.task_id in boundary_task_ids and record.state == "playing"
                        for record in active_session.segments.values()
                    )
                if not still_playing:
                    break
                time.sleep(0.01)
            self.subtitle_sync.emit_clear(trace_id=request.trace_id, generation_id=generation_id, reason="cancel_trace")
            self.lipsync_bridge.cancel_trace_async(trace_id=request.trace_id)
        if hasattr(self, "_playback") and self._playback is not None:
            self._playback.cancel_trace(request.trace_id)
        cancelled_tasks = [task for task in affected if task.task_id not in boundary_task_ids]
        for task in cancelled_tasks:
            self._publish_playback_event("cancelled", task=task, detail={"reason": "cancel_trace"})
        return {
            "status": "cancelled",
            "trace_id": request.trace_id,
            "mode": request.mode,
            "cancelled_task_count": len(cancelled_tasks),
            "cutoff_segments": (
                immediate_cutoff_segments
                if request.mode == "immediate"
                else self._cutoff_segments_for_trace(request.trace_id)
            ),
        }

    def _cutoff_segments_for_trace(self, trace_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return self._cutoff_segments_for_trace_locked(trace_id)

    def _cutoff_segments_for_trace_locked(self, trace_id: str) -> list[dict[str, Any]]:
        states = [
            {
                "generation_id": int(task.subtitle_state.get("generation_id", task.detail.get("generation_id", 1)) or 1),
                "segment_index": int(task.subtitle_state.get("segment_index", task.detail.get("segment_index", 0)) or 0),
                "task_id": task.task_id,
                "text": str(task.subtitle_state.get("text", task.detail.get("text", ""))),
                "revealed_text": str(task.subtitle_state.get("revealed_text", "")),
                "revealed_count": int(task.subtitle_state.get("revealed_count", 0) or 0),
                "playback_started": bool(task.subtitle_state.get("playback_started", False)),
                "playback_completed": bool(task.subtitle_state.get("playback_completed", False)),
            }
            for task in self._tasks.values()
            if task.trace_id == trace_id
            and task.subtitle_state
            and int(task.subtitle_state.get("segment_index", 0) or 0) > 0
        ]
        return sorted(states, key=lambda item: item["segment_index"])

    def mark_turn_end(self, request: TurnEndRequest) -> dict[str, Any]:
        with self._lock:
            session = self._sessions_by_trace.get(request.trace_id)
            if session is None:
                return {"status": "not_found", "trace_id": request.trace_id}
            if request.generation_id is not None and session.generation_id != int(request.generation_id):
                return {"status": "stale", "trace_id": request.trace_id, "generation_id": session.generation_id}
            if request.last_segment_index is not None:
                session.expected_end_index = max(int(request.last_segment_index), 1)
            elif session.expected_end_index is None:
                session.expected_end_index = max(session.segments.keys(), default=0)
            if session.condition is not None:
                session.condition.notify_all()
        if hasattr(self, "_playback") and self._playback is not None:
            self._playback.check_and_notify_finished(request.trace_id)
        self.lipsync_bridge.turn_end_async(
            trace_id=request.trace_id,
            generation_id=request.generation_id,
            last_segment_index=request.last_segment_index,
        )
        return {"status": "accepted", "trace_id": request.trace_id}

    def _release_window_for_cancelled_task_locked(self, task: BridgeTask) -> None:
        """Release the sliding-window barrier for a cancelled task.

        Must be called with ``self._lock`` held.  A cancelled pending/early
        segment must advance ``next_play_index`` and notify waiters, otherwise
        later segments can wait forever in ``wait_for_issue_window``.
        """
        generation_id = int(task.detail.get("generation_id", 1) or 1)
        session = self._sessions_by_trace.get(task.trace_id)
        if session is None or session.generation_id != generation_id:
            return
        for index, record in session.segments.items():
            if record.task_id != task.task_id:
                continue
            if record.state not in {"completed", "failed", "cancelled", "obsolete"}:
                record.state = "cancelled"
            if session.next_play_index == index:
                session.next_play_index += 1
            break
        if session.condition is not None:
            session.condition.notify_all()


    def _mark_task_failed_and_release_window(self, *, task: BridgeTask, reason: str) -> None:
        generation_id = int(task.detail.get("generation_id", 1) or 1)
        with self._lock:
            session = self._sessions_by_trace.get(task.trace_id)
            if session is not None and session.generation_id == generation_id:
                for index, record in session.segments.items():
                    if record.task_id != task.task_id:
                        continue
                    record.state = "failed"
                    record.detail = {
                        **record.detail,
                        "error": task.error or reason,
                        "failure_reason": reason,
                    }
                    if session.next_play_index == index:
                        session.next_play_index += 1
                    break
                if session.condition is not None:
                    session.condition.notify_all()
            first_chunk_event = self._first_chunk_events.get((task.trace_id, generation_id))
            if first_chunk_event is not None:
                first_chunk_event.set()
        print(
            "[TTS][task] failed "
            f"trace_id={task.trace_id} generation_id={generation_id} "
            f"task_id={task.task_id} reason={reason}",
            flush=True,
        )

    def subtitle_state(self, trace_id: str) -> dict[str, Any]:
        with self._lock:
            tasks = [task for task in self._tasks.values() if task.trace_id == trace_id]
            session = self._sessions_by_trace.get(trace_id)

            def _get_seg_index(t: BridgeTask) -> int:
                return int(t.subtitle_state.get("segment_index") or t.detail.get("segment_index") or 0)

            tasks.sort(key=_get_seg_index)

            segments_state: list[dict[str, Any]] = []
            pending_segments: list[dict[str, Any]] = []
            completed_segments: list[dict[str, Any]] = []
            current_speaking: dict[str, Any] | None = None

            for task in tasks:
                seg_idx = _get_seg_index(task)
                text = str(task.subtitle_state.get("text") or task.detail.get("text") or "")
                rec = session.segments.get(seg_idx) if session is not None else None
                rec_state = rec.state if rec is not None else task.state

                sub_state = dict(task.subtitle_state) if task.subtitle_state else {}
                sub_state.setdefault("generation_id", int(task.detail.get("generation_id", 1) or 1))
                sub_state.setdefault("segment_index", seg_idx)
                sub_state.setdefault("text", text)

                is_completed = bool(sub_state.get("playback_completed")) or rec_state == "completed" or task.state == "completed"
                is_started = bool(sub_state.get("playback_started")) or rec_state in {"playing", "completed"}

                if is_completed:
                    sub_state["playback_started"] = True
                    sub_state["playback_completed"] = True
                    sub_state.setdefault("revealed_text", text)
                    sub_state.setdefault("revealed_count", len(text))
                    completed_segments.append({"index": seg_idx, "text": text})
                elif is_started or rec_state == "playing":
                    sub_state["playback_started"] = True
                    sub_state["playback_completed"] = False
                    revealed = str(sub_state.get("revealed_text", ""))
                    if current_speaking is None:
                        current_speaking = {
                            "index": seg_idx,
                            "text": text,
                            "revealed_text": revealed,
                        }
                elif rec_state not in {"cancelled", "failed", "obsolete"} and task.state not in {"cancelled", "failed", "obsolete"}:
                    sub_state.setdefault("playback_started", False)
                    sub_state.setdefault("playback_completed", False)
                    pending_segments.append({"index": seg_idx, "text": text})

                segments_state.append(sub_state)

            is_speaking = bool(
                current_speaking is not None
                or len(pending_segments) > 0
                or (session is not None and not session.closed and session.expected_end_index is not None and session.next_play_index <= session.expected_end_index)
            )

            return {
                "trace_id": trace_id,
                "is_speaking": is_speaking,
                "current_speaking": current_speaking,
                "pending_segments": pending_segments,
                "completed_segments": completed_segments,
                "segments": segments_state,
            }

    def diagnose_streaming(self, *, text: str, trace_id: str = "diag_streaming", repeats: int = 1) -> dict[str, Any]:
        candidates = [
            DiagnosticCandidate(label="mode3_chunk16_gap0.04", vendor_streaming_mode=3, min_chunk_length=16, fragment_interval=0.04),
            DiagnosticCandidate(label="mode2_chunk16_gap0.04", vendor_streaming_mode=2, min_chunk_length=16, fragment_interval=0.04),
            DiagnosticCandidate(label="mode2_chunk24_gap0.05", vendor_streaming_mode=2, min_chunk_length=24, fragment_interval=0.05),
            DiagnosticCandidate(label="mode2_chunk32_gap0.08", vendor_streaming_mode=2, min_chunk_length=32, fragment_interval=0.08),
            DiagnosticCandidate(label="mode2_chunk40_gap0.09", vendor_streaming_mode=2, min_chunk_length=40, fragment_interval=0.09),
            DiagnosticCandidate(label="mode2_chunk48_gap0.10", vendor_streaming_mode=2, min_chunk_length=48, fragment_interval=0.10),
            DiagnosticCandidate(label="mode2_chunk64_gap0.12", vendor_streaming_mode=2, min_chunk_length=64, fragment_interval=0.12),
        ]
        results: list[DiagnosticResult] = []
        base_request = SpeakRequest(
            trace_id=trace_id,
            segment_id=f"diag_{uuid4().hex[:8]}",
            index=1,
            text=text,
            kind="sentence",
            timeout_ms=self.config.request_timeout_ms,
            metadata={"diagnostic": True},
        )
        run_count = max(int(repeats), 1)
        generation_id = 1
        for run_index in range(1, run_count + 1):
            for candidate in candidates:
                result_label = candidate.label if run_count == 1 else f"{candidate.label}#run{run_index}"
                print(f"[TTS][diagnostic] running {result_label}", flush=True)
                profile = StreamingProfile(
                    label=candidate.label,
                    vendor_streaming_mode=candidate.vendor_streaming_mode,
                    min_chunk_length=candidate.min_chunk_length,
                    fragment_interval=candidate.fragment_interval,
                    prebuffer_ms=self.config.streaming.prebuffer_ms,
                    rebuffer_ms=self.config.streaming.rebuffer_ms,
                )
                request = base_request.model_copy(update={
                    "segment_id": f"diag_{candidate.label}_{uuid4().hex[:6]}",
                    "generation_id": generation_id,
                    "metadata": {
                        "diagnostic": True,
                        "generation_id": generation_id,
                        "diagnostic_run": run_index,
                    },
                })
                generation_id += 1
                result = self._run_diagnostic_candidate(request=request, profile=profile)
                result["diagnostic_run"] = run_index
                print(f"[TTS][diagnostic] {result_label}: {result}", flush=True)
                results.append(DiagnosticResult(label=result_label, metrics=result))

        ranked = sorted(results, key=self._diagnostic_sort_key)
        recommended = ranked[0] if ranked else None
        payload = {
            "trace_id": trace_id,
            "text": text,
            "repeats": run_count,
            "results": [{"label": item.label, "metrics": item.metrics} for item in ranked],
            "recommended": {
                "label": recommended.label,
                "metrics": recommended.metrics,
            } if recommended is not None else None,
        }
        output_dir = self.config.output_dir.resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "streaming_diagnostic_results.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return payload

    def _streaming_profile_for_request(
        self,
        trace_id: str,
        *,
        first_chunk_priority: bool = False,
        segment_index: int = 0,
        text: str = "",
    ) -> StreamingProfile:
        streaming = self.config.streaming
        default_profile = StreamingProfile(
            label="continuity_default",
            vendor_streaming_mode=streaming.vendor_streaming_mode,
            min_chunk_length=streaming.min_chunk_length,
            fragment_interval=streaming.fragment_interval,
            prebuffer_ms=streaming.prebuffer_ms,
            rebuffer_ms=streaming.rebuffer_ms,
        )
        compact_text_length = len("".join(str(text).split()))
        if (
            streaming.stream_strategy == "fixed_streaming"
            and (
                first_chunk_priority
                or segment_index == 1
                or (0 < compact_text_length <= SHORT_SEGMENT_FAST_START_CHAR_LIMIT)
            )
        ):
            return self._first_chunk_streaming_profile()
        conservative_profile = self.adaptive_engine.get_conservative_profile(trace_id)
        if conservative_profile is not None:
            return conservative_profile
        return default_profile

    def _first_chunk_streaming_profile(self) -> StreamingProfile:
        streaming = self.config.streaming
        return StreamingProfile(
            label="fast_start_first_sentence",
            vendor_streaming_mode=streaming.first_chunk_vendor_streaming_mode or streaming.vendor_streaming_mode,
            min_chunk_length=streaming.first_chunk_min_chunk_length,
            fragment_interval=streaming.first_chunk_fragment_interval,
            prebuffer_ms=streaming.first_chunk_prebuffer_ms,
            rebuffer_ms=streaming.rebuffer_ms,
        )

    def _resolve_generation_id(self, request: SpeakRequest) -> int:
        explicit = request.generation_id
        if explicit is None:
            explicit = request.metadata.get("generation_id")
        if explicit is not None:
            generation_id = max(int(explicit), 1)
        else:
            generation_id = 1
            with self._lock:
                if request.trace_id in self._next_generation_id_by_trace:
                    generation_id = self._next_generation_id_by_trace[request.trace_id]
                else:
                    self._next_generation_id_by_trace[request.trace_id] = generation_id
        with self._lock:
            self._next_generation_id_by_trace[request.trace_id] = max(self._next_generation_id_by_trace.get(request.trace_id, 1), generation_id)
            session = self._sessions_by_trace.get(request.trace_id)
            if session is None or session.generation_id != generation_id:
                self._sessions_by_trace[request.trace_id] = GenerationSession(
                    trace_id=request.trace_id,
                    generation_id=generation_id,
                    condition=threading.Condition(self._lock),
                )
        return generation_id

    def _register_segment(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
        task_id: str,
        text: str,
        state,
    ):
        return self._sliding_window.register_segment(
            trace_id=trace_id,
            generation_id=generation_id,
            segment_index=segment_index,
            task_id=task_id,
            text=text,
            state=state,
        )

    def _notify_session(self, trace_id: str) -> None:
        self._sliding_window.notify_trace(trace_id)

    def _record_adaptive_result(self, trace_id: str, metrics: dict[str, Any], *, used_batch: bool) -> None:
        self.adaptive_engine.record_result(trace_id, metrics, used_batch=used_batch)

    def _should_force_batch_for_trace(self, trace_id: str) -> bool:
        return self.adaptive_engine.should_force_batch(trace_id)

    def _register_ready_segment(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
        task_id: str,
        text: str,
        asset: AudioAsset,
        detail: dict[str, Any],
    ) -> bool:
        return self._sliding_window.register_ready_segment(
            trace_id=trace_id,
            generation_id=generation_id,
            segment_index=segment_index,
            task_id=task_id,
            text=text,
            asset=asset,
            detail=detail,
        )

    def _play_ready_segment(self, *, trace_id: str, generation_id: int, segment_index: int) -> dict[str, Any]:
        if not self.config.playback_enabled:
            return {"playback_started": False, "playback_completed": False}
        return self._playback.play_ready_segment(
            trace_id=trace_id,
            generation_id=generation_id,
            segment_index=segment_index,
            playback_runner=lambda asset: self._play_asset_with_subtitles(
                trace_id=trace_id,
                generation_id=generation_id,
                segment_index=segment_index,
                asset=asset,
            ),
        )

    def _mark_segment_completed(self, *, trace_id: str, generation_id: int, segment_index: int, detail: dict[str, Any]) -> None:
        self._sliding_window.mark_segment_completed(
            trace_id=trace_id,
            generation_id=generation_id,
            segment_index=segment_index,
            detail=detail,
        )

    def _play_asset_with_subtitles(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
        asset: AudioAsset,
    ) -> dict[str, Any]:
        with self._lock:
            session = self._sessions_by_trace.get(trace_id)
            if session is None or session.generation_id != generation_id:
                return {"playback_started": False, "playback_completed": False}
            record = session.segments.get(segment_index)
            if record is None:
                return {"playback_started": False, "playback_completed": False}
            task = self._tasks.get(record.task_id)
        if task is None:
            return {"playback_started": False, "playback_completed": False}
        if asset.pcm_stream is None:
            self.lipsync_bridge.mirror_asset_async(
                trace_id=trace_id,
                generation_id=generation_id,
                segment_index=segment_index,
                task_id=task.task_id,
                text=str(task.detail.get("text", "")),
                asset=asset,
            )
        if asset.kind == "pcm" and asset.pcm_stream is not None:
            return self._play_streaming_asset(task=task, asset=asset, chunk_buffer=asset.pcm_stream)
        if asset.kind == "pcm":
            return self._play_streaming_asset(task=task, asset=asset, chunk_buffer=[asset.pcm_bytes or b""])
        return self._play_batch_asset(task=task, asset=asset)

    def _run_diagnostic_candidate(self, *, request: SpeakRequest, profile: StreamingProfile) -> dict[str, Any]:
        preset = self.config.preset
        if not preset.ref_audio_path:
            raise TTSBridgeConfigError("tts preset ref_audio_path is not configured")
        ref_audio_path = preset.ref_audio_path.resolve()
        vendor_text = _sanitize_vendor_text(request.text)
        if not vendor_text:
            raise TTSBridgeConfigError("diagnostic text is empty after vendor sanitization")
        task = BridgeTask(
            task_id=request.segment_id,
            trace_id=request.trace_id,
            state="pending",
            cancel_token=f"cancel_{uuid4().hex[:16]}",
        )
        task.state = "in_progress"
        task.started_at = time.time()
        task.detail["text"] = vendor_text
        if vendor_text != request.text:
            task.detail["original_text"] = request.text
            task.detail["text_sanitized_for_vendor"] = True
        task.detail["segment_index"] = int(request.index)
        generation_id = self._resolve_generation_id(request)
        task.detail["generation_id"] = generation_id
        task.detail["first_chunk_priority"] = True
        with self._lock:
            self._tasks[task.task_id] = task
        self._register_segment(
            trace_id=request.trace_id,
            generation_id=generation_id,
            segment_index=int(request.index),
            task_id=task.task_id,
            text=vendor_text,
            state="pending",
        )
        timeout = min(request.timeout_ms, self.config.request_timeout_ms)
        return self._speak_streaming(task, ref_audio_path, timeout, profile=profile)

    def _diagnostic_sort_key(self, result: DiagnosticResult) -> tuple[int, int, int, float, float, float]:
        metrics = result.metrics
        playback_start_latency_ms = float(metrics.get("playback_start_latency_ms") or 0.0)
        rebuffer_count = int(metrics.get("rebuffer_count", 9999) or 9999)
        underrun_count = int(metrics.get("underrun_count", 9999) or 9999)
        max_chunk_gap_ms = float(metrics.get("max_chunk_gap_ms") or 999999.0)
        realtime_factor = float(metrics.get("realtime_factor") or 0.0)
        meets_latency = 0 if playback_start_latency_ms <= 2000 else 1
        return (
            meets_latency,
            rebuffer_count,
            underrun_count,
            playback_start_latency_ms,
            max_chunk_gap_ms,
            -realtime_factor,
        )

    def _write_audio_artifact(self, *, task_id: str, audio_id: str, audio_bytes: bytes, media_type: str) -> Path:
        output_dir = self.config.output_dir.resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        artifact_path = output_dir / f"{task_id}_{audio_id}.{media_type}"
        artifact_path.write_bytes(audio_bytes)
        return artifact_path

    def _task_cancelled_or_stale(self, task: BridgeTask) -> bool:
        generation_id = int(task.detail.get("generation_id", 1) or 1)
        if task.cancel_requested or task.state in {"cancelled", "obsolete"}:
            return True
        return not self._sliding_window.is_current_generation(trace_id=task.trace_id, generation_id=generation_id)

    def _cancelled_delivery_receipt(
        self,
        *,
        task: BridgeTask,
        sample_rate: int,
        media_type: str,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "status": "cancelled",
            "task_id": task.task_id,
            "audio_id": "",
            "cancel_token": task.cancel_token,
            "audio_path": "",
            "duration_ms": 0,
            "sample_rate": sample_rate,
            "media_type": media_type,
            "playback_started": False,
            "playback_completed": False,
            "late_result_discarded": True,
            **(extra or {}),
        }

    def _active_playback_task_id(self) -> str | None:
        with self._lock:
            for task in self._tasks.values():
                if task.state == "in_progress":
                    return task.task_id
        return None

    def _vendor_failure_detail(
        self,
        response: httpx.Response | None,
        body: bytes | None = None,
        *,
        status_code: int | None = None,
    ) -> str:
        if response is not None:
            text = (body if body is not None else response.content).decode("utf-8", errors="replace")
            current_status = response.status_code
        else:
            text = (body or b"").decode("utf-8", errors="replace")
            current_status = int(status_code or 500)
        detail = f"tts vendor returned {current_status}: {text}"
        lowered = text.lower()
        if "请输入有效文本" in text:
            return "vendor_text_preprocess_failed"
        if "timed out" in lowered:
            return "vendor_timeout"
        return detail


from server import (
    build_app,
    build_service,
    default_config_path,
    parse_args,
    run_server,
    run_streaming_diagnostic,
)


