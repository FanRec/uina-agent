from __future__ import annotations

import base64
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from models import AudioAsset


@dataclass(frozen=True)
class LipsyncBridgeClientConfig:
    enabled: bool = False
    base_url: str = "http://127.0.0.1:8105"
    request_timeout_ms: int = 250
    inline_pcm_max_bytes: int = 4 * 1024 * 1024
    max_workers: int = 1
    max_pending_requests: int = 16
    stream_chunk_min_interval_ms: int = 20
    drop_log_interval_ms: int = 2000


class LipsyncBridgeClient:
    def __init__(self, config: LipsyncBridgeClientConfig, *, client: httpx.Client | None = None) -> None:
        self.config = config
        self.client = client or httpx.Client(base_url=config.base_url.rstrip("/"), trust_env=False)
        self._executor = ThreadPoolExecutor(max_workers=max(1, config.max_workers))
        self._pending_slots = threading.BoundedSemaphore(max(max(1, config.max_workers), config.max_pending_requests))
        self._lock = threading.Lock()
        self._last_stream_chunk_sent_at: dict[str, float] = {}
        self._stream_chunk_buffers: dict[str, bytearray] = {}
        self._last_drop_log_at: dict[str, float] = {}

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
        self.client.close()

    def mirror_asset_async(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
        task_id: str,
        text: str,
        asset: AudioAsset,
    ) -> None:
        if not self.config.enabled:
            return
        payload = {
            "trace_id": trace_id,
            "generation_id": generation_id,
            "segment_index": segment_index,
            "task_id": task_id,
            "text": text,
            "sample_rate": asset.sample_rate,
            "duration_ms": asset.duration_ms,
            "media_type": asset.media_type,
        }
        if asset.kind == "file" and asset.artifact_path is not None:
            payload["audio_path"] = str(asset.artifact_path)
        elif asset.kind == "pcm" and asset.pcm_bytes is not None:
            if len(asset.pcm_bytes) > self.config.inline_pcm_max_bytes:
                print(
                    "[LIPSYNC] skip mirror: PCM payload too large "
                    f"({len(asset.pcm_bytes)} bytes > {self.config.inline_pcm_max_bytes})",
                    flush=True,
                )
                return
            payload["pcm_base64"] = base64.b64encode(asset.pcm_bytes).decode("ascii")
        elif asset.kind == "pcm" and asset.pcm_stream is not None:
            done = asset.metrics.get("pcm_buffer_done")
            buffer = asset.metrics.get("pcm_buffer")
            if not isinstance(buffer, bytearray) or not callable(getattr(done, "wait", None)):
                return
            self._mirror_pcm_buffer_when_ready(
                payload=payload,
                buffer=buffer,
                wait_for_ready=done.wait,
                label=f"mirror_stream:{task_id}",
            )
            return
        else:
            return
        self._fire_and_forget("/v1/lipsync/mirror", payload, label=f"mirror:{task_id}")

    def _mirror_pcm_buffer_when_ready(
        self,
        *,
        payload: dict[str, Any],
        buffer: bytearray,
        wait_for_ready: Callable[[float | None], bool],
        label: str,
    ) -> None:
        if not self.config.enabled:
            return

        def _run() -> None:
            if not wait_for_ready(10.0):
                print(f"[LIPSYNC] skip mirror: timed out waiting for streaming PCM buffer for {label}", flush=True)
                return
            pcm_bytes = bytes(buffer)
            if not pcm_bytes:
                print(f"[LIPSYNC] skip mirror: empty streaming PCM buffer for {label}", flush=True)
                return
            if len(pcm_bytes) > self.config.inline_pcm_max_bytes:
                print(
                    "[LIPSYNC] skip mirror: streaming PCM payload too large "
                    f"({len(pcm_bytes)} bytes > {self.config.inline_pcm_max_bytes})",
                    flush=True,
                )
                return
            current_payload = dict(payload)
            current_payload["pcm_base64"] = base64.b64encode(pcm_bytes).decode("ascii")
            self._post_json("/v1/lipsync/mirror", current_payload, label=label)

        self._executor.submit(_run)

    def stream_start_async(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
        task_id: str,
        text: str,
        sample_rate: int,
        duration_ms: int,
        prebuffer_ms: int | None = None,
        rebuffer_ms: int | None = None,
    ) -> None:
        if not self.config.enabled:
            return
        payload: dict[str, Any] = {
            "trace_id": trace_id,
            "generation_id": generation_id,
            "segment_index": segment_index,
            "task_id": task_id,
            "text": text,
            "sample_rate": sample_rate,
            "duration_ms": duration_ms,
        }
        if prebuffer_ms is not None and prebuffer_ms > 0:
            payload["prebuffer_ms"] = prebuffer_ms
        if rebuffer_ms is not None and rebuffer_ms > 0:
            payload["rebuffer_ms"] = rebuffer_ms
        self._fire_and_forget(
            "/v1/lipsync/stream/start",
            payload,
            label=f"stream_start:{task_id}",
        )

    def stream_chunk_async(self, *, task_id: str, chunk: bytes) -> None:
        if not self.config.enabled or not chunk:
            return
        now = time.perf_counter()
        min_interval = max(self.config.stream_chunk_min_interval_ms, 0) / 1000
        with self._lock:
            buffer = self._stream_chunk_buffers.setdefault(task_id, bytearray())
            buffer.extend(chunk)
            if min_interval > 0:
                last_sent_at = self._last_stream_chunk_sent_at.get(task_id, 0.0)
                if now - last_sent_at < min_interval:
                    return
                self._last_stream_chunk_sent_at[task_id] = now
            data = bytes(buffer)
            buffer.clear()
        if len(data) > self.config.inline_pcm_max_bytes:
            print(
                "[LIPSYNC] skip stream chunk: PCM payload too large "
                f"({len(data)} bytes > {self.config.inline_pcm_max_bytes})",
                flush=True,
            )
            return
        self._fire_and_forget_lazy(
            "/v1/lipsync/stream/chunk",
            lambda: {
                "task_id": task_id,
                "pcm_base64": base64.b64encode(data).decode("ascii"),
            },
            label=f"stream_chunk:{task_id}",
        )

    def stream_finish_async(self, *, task_id: str) -> None:
        if not self.config.enabled:
            return
        with self._lock:
            self._last_stream_chunk_sent_at.pop(task_id, None)
            remaining = bytes(self._stream_chunk_buffers.pop(task_id, b""))
        timeout = max(self.config.request_timeout_ms / 1000, 0.05)

        def _finish() -> None:
            if remaining:
                self._post_json(
                    "/v1/lipsync/stream/chunk",
                    {"task_id": task_id, "pcm_base64": base64.b64encode(remaining).decode("ascii")},
                    label=f"stream_chunk_final:{task_id}",
                    timeout=timeout,
                )
            self._post_json(
                "/v1/lipsync/stream/finish",
                {"task_id": task_id},
                label=f"stream_finish:{task_id}",
                timeout=timeout,
            )

        if not self._pending_slots.acquire(blocking=False):
            self._log_drop(f"stream_finish:{task_id}")
            return

        def _run() -> None:
            try:
                _finish()
            finally:
                self._pending_slots.release()

        self._executor.submit(_run)

    def cancel_trace_async(self, *, trace_id: str) -> None:
        if not self.config.enabled:
            return
        self._fire_and_forget("/v1/lipsync/cancel-trace", {"trace_id": trace_id}, label=f"cancel:{trace_id}")

    def turn_end_async(self, *, trace_id: str, generation_id: int | None, last_segment_index: int | None) -> None:
        if not self.config.enabled:
            return
        self._fire_and_forget(
            "/v1/lipsync/turn-end",
            {
                "trace_id": trace_id,
                "generation_id": generation_id,
                "last_segment_index": last_segment_index,
            },
            label=f"turn_end:{trace_id}",
        )

    def _fire_and_forget(self, path: str, payload: dict[str, Any], *, label: str) -> None:
        self._fire_and_forget_lazy(path, lambda: payload, label=label)

    def _fire_and_forget_lazy(self, path: str, payload_factory: Callable[[], dict[str, Any]], *, label: str) -> None:
        if not self._pending_slots.acquire(blocking=False):
            self._log_drop(label)
            return
        timeout = max(self.config.request_timeout_ms / 1000, 0.05)

        def _run() -> None:
            try:
                self._post_json(path, payload_factory(), label=label, timeout=timeout)
            finally:
                self._pending_slots.release()

        self._executor.submit(_run)

    def _log_drop(self, label: str) -> None:
        now = time.perf_counter()
        family = label.split(":", 1)[0]
        interval = max(self.config.drop_log_interval_ms, 0) / 1000
        with self._lock:
            last = self._last_drop_log_at.get(family, 0.0)
            if interval > 0 and now - last < interval:
                return
            self._last_drop_log_at[family] = now
        print(f"[LIPSYNC] drop bridge request for {label}: pending queue full", flush=True)

    def _post_json(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        label: str,
        timeout: float | None = None,
    ) -> None:
        try:
            response = self.client.post(path, json=payload, timeout=timeout or max(self.config.request_timeout_ms / 1000, 0.05))
            if response.status_code not in {200, 202}:
                print(
                    f"[LIPSYNC] bridge request failed for {label}: "
                    f"{response.status_code} {response.text[:200]}",
                    flush=True,
                )
                return
            try:
                body = response.json()
            except Exception:
                body = None
            if isinstance(body, dict) and body.get("status") in {"failed", "dropped_busy"}:
                print(
                    f"[LIPSYNC] bridge request rejected for {label}: "
                    f"{body}",
                    flush=True,
                )
        except Exception as exc:
            print(f"[LIPSYNC] bridge request error for {label}: {exc}", flush=True)
