from __future__ import annotations

import base64
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Callable
from dataclasses import dataclass, field
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


@dataclass
class _StreamState:
    metadata: dict[str, Any] = field(default_factory=dict)
    buffer: bytearray = field(default_factory=bytearray)
    fallback_buffer: bytearray = field(default_factory=bytearray)
    fallback_overflow: bool = False
    unsupported: bool = False
    sequence: int = 0
    last_sent_at: float = 0.0
    cancelled: threading.Event = field(default_factory=threading.Event)
    tail: threading.Event | None = None

    def release(self) -> None:
        self.cancelled.set()
        self.buffer.clear()
        self.fallback_buffer.clear()


class LipsyncBridgeClient:
    def __init__(self, config: LipsyncBridgeClientConfig, *, client: httpx.Client | None = None) -> None:
        self.config = config
        self.client = client or httpx.Client(base_url=config.base_url.rstrip("/"), trust_env=False)
        self._executor = ThreadPoolExecutor(max_workers=max(1, config.max_workers))
        self._capacity = max(1, config.max_pending_requests)
        self._pending_slots = threading.BoundedSemaphore(self._capacity)
        self._lock = threading.RLock()
        self._closed = threading.Event()
        self._streams: dict[str, _StreamState] = {}
        self._last_drop_log_at: dict[str, float] = {}

    def close(self) -> None:
        with self._lock:
            if self._closed.is_set():
                return
            self._closed.set()
            for state in self._streams.values():
                state.release()
            self._streams.clear()
        self._executor.shutdown(wait=False, cancel_futures=True)
        self.client.close()

    def mirror_asset_async(
        self, *, trace_id: str, generation_id: int, segment_index: int,
        task_id: str, text: str, asset: AudioAsset,
    ) -> None:
        if not self.config.enabled or self._closed.is_set():
            return
        payload = {
            "trace_id": trace_id, "generation_id": generation_id,
            "segment_index": segment_index, "task_id": task_id, "text": text,
            "sample_rate": asset.sample_rate, "duration_ms": asset.duration_ms,
            "media_type": asset.media_type,
        }
        if asset.kind == "file" and asset.artifact_path is not None:
            payload["audio_path"] = str(asset.artifact_path)
        elif asset.kind == "pcm" and asset.pcm_bytes is not None:
            if len(asset.pcm_bytes) > self.config.inline_pcm_max_bytes:
                self._log_drop(f"mirror_size:{task_id}")
                return
            payload["pcm_base64"] = base64.b64encode(asset.pcm_bytes).decode("ascii")
        elif asset.kind == "pcm" and asset.pcm_stream is not None:
            done = asset.metrics.get("pcm_buffer_done")
            buffer = asset.metrics.get("pcm_buffer")
            if isinstance(buffer, bytearray) and callable(getattr(done, "wait", None)):
                self._mirror_pcm_buffer_when_ready(
                    payload=payload, buffer=buffer, wait_for_ready=done.wait,
                    label=f"mirror_stream:{task_id}",
                )
            return
        else:
            return
        self._fire_and_forget("/v1/lipsync/mirror", payload, label=f"mirror:{task_id}")

    def _mirror_pcm_buffer_when_ready(
        self, *, payload: dict[str, Any], buffer: bytearray,
        wait_for_ready: Callable[[float | None], bool], label: str,
    ) -> None:
        def send() -> None:
            deadline = time.monotonic() + 10.0
            while not self._closed.is_set():
                if wait_for_ready(0.05):
                    break
                if time.monotonic() >= deadline:
                    self._log_drop(label)
                    return
            if self._closed.is_set() or not buffer or len(buffer) > self.config.inline_pcm_max_bytes:
                return
            current = {**payload, "pcm_base64": base64.b64encode(bytes(buffer)).decode("ascii")}
            self._post_json("/v1/lipsync/mirror", current, label=label)
        self._submit(send, label=label)

    def stream_start_async(
        self, *, trace_id: str, generation_id: int, segment_index: int,
        task_id: str, text: str, sample_rate: int, duration_ms: int,
        prebuffer_ms: int | None = None, rebuffer_ms: int | None = None,
    ) -> None:
        if not self.config.enabled or self._closed.is_set():
            return
        payload: dict[str, Any] = {
            "trace_id": trace_id, "generation_id": generation_id,
            "segment_index": segment_index, "task_id": task_id, "text": text,
            "sample_rate": sample_rate, "duration_ms": duration_ms,
        }
        if prebuffer_ms is not None and prebuffer_ms > 0:
            payload["prebuffer_ms"] = prebuffer_ms
        if rebuffer_ms is not None and rebuffer_ms > 0:
            payload["rebuffer_ms"] = rebuffer_ms
        with self._lock:
            if len(self._streams) >= self._capacity and task_id not in self._streams:
                self._log_drop(f"stream_start:{task_id}")
                return
            old = self._streams.pop(task_id, None)
            if old is not None:
                old.release()
            state = _StreamState(metadata={**payload, "media_type": "raw"})
            self._streams[task_id] = state
            def send() -> None:
                state.unsupported = self._post_json(
                    "/v1/lipsync/stream/start", payload, label=f"stream_start:{task_id}"
                ) in {404, 405, 501}
            if not self._submit(send, label=f"stream_start:{task_id}", state=state):
                self._streams.pop(task_id, None)
                state.release()

    def stream_chunk_async(self, *, task_id: str, chunk: bytes) -> None:
        if not self.config.enabled or self._closed.is_set() or not chunk:
            return
        with self._lock:
            state = self._streams.get(task_id)
            if state is None:
                # Also support callers that use the chunk API without start.
                if len(self._streams) >= self._capacity:
                    self._log_drop(f"stream_chunk:{task_id}")
                    return
                state = _StreamState(metadata={"task_id": task_id})
                self._streams[task_id] = state
            limit = max(2, self.config.inline_pcm_max_bytes // 2 * 2)
            if not state.fallback_overflow:
                if len(state.fallback_buffer) + len(chunk) <= limit:
                    state.fallback_buffer.extend(chunk)
                else:
                    state.fallback_buffer.clear()
                    state.fallback_overflow = True
            # Keep the latest aligned PCM when the side channel is slower.
            if len(chunk) >= limit:
                state.buffer[:] = chunk[-limit:]
            else:
                overflow = max(0, len(state.buffer) + len(chunk) - limit)
                if overflow:
                    del state.buffer[:overflow + overflow % 2]
                state.buffer.extend(chunk)
            now = time.monotonic()
            if now - state.last_sent_at < max(0, self.config.stream_chunk_min_interval_ms) / 1000:
                return
            data = bytes(state.buffer)
            state.buffer.clear()
            index = state.sequence
            def send() -> None:
                if state.unsupported:
                    return
                status = self._post_json(
                    "/v1/lipsync/stream/chunk",
                    {"task_id": task_id, "chunk_index": index, "pcm_base64": base64.b64encode(data).decode("ascii")},
                    label=f"stream_chunk:{task_id}",
                )
                if status in {404, 405, 501}:
                    state.unsupported = True
            if self._submit(send, label=f"stream_chunk:{task_id}", state=state):
                state.sequence += 1
                state.last_sent_at = now

    def stream_finish_async(self, *, task_id: str) -> None:
        if not self.config.enabled or self._closed.is_set():
            return
        with self._lock:
            state = self._streams.get(task_id) or _StreamState(metadata={"task_id": task_id})
            remaining = bytes(state.buffer)
            state.buffer.clear()
            def finish() -> None:
                try:
                    if not state.unsupported and remaining:
                        status = self._post_json(
                            "/v1/lipsync/stream/chunk",
                            {"task_id": task_id, "chunk_index": state.sequence, "pcm_base64": base64.b64encode(remaining).decode("ascii")},
                            label=f"stream_chunk_final:{task_id}",
                        )
                        state.sequence += 1
                        state.unsupported = status in {404, 405, 501}
                    if not state.unsupported:
                        status = self._post_json(
                            "/v1/lipsync/stream/finish",
                            {"task_id": task_id, "last_chunk_index": state.sequence - 1},
                            label=f"stream_finish:{task_id}",
                        )
                        state.unsupported = status in {404, 405, 501}
                    if state.unsupported and state.fallback_buffer and not state.fallback_overflow:
                        self._post_json(
                            "/v1/lipsync/mirror",
                            {**state.metadata, "pcm_base64": base64.b64encode(bytes(state.fallback_buffer)).decode("ascii")},
                            label=f"mirror_fallback:{task_id}",
                        )
                finally:
                    with self._lock:
                        if self._streams.get(task_id) is state:
                            self._streams.pop(task_id, None)
                        state.release()
            if not self._submit(finish, label=f"stream_finish:{task_id}", state=state):
                self._streams.pop(task_id, None)
                state.release()

    def cancel_trace_async(self, *, trace_id: str) -> None:
        with self._lock:
            for task_id, state in list(self._streams.items()):
                if state.metadata.get("trace_id") == trace_id:
                    self._streams.pop(task_id, None)
                    state.release()
        self._fire_and_forget("/v1/lipsync/cancel-trace", {"trace_id": trace_id}, label=f"cancel:{trace_id}")

    def turn_end_async(self, *, trace_id: str, generation_id: int | None, last_segment_index: int | None) -> None:
        self._fire_and_forget(
            "/v1/lipsync/turn-end",
            {"trace_id": trace_id, "generation_id": generation_id, "last_segment_index": last_segment_index},
            label=f"turn_end:{trace_id}",
        )

    def _submit(self, work: Callable[[], None], *, label: str, state: _StreamState | None = None) -> bool:
        # Submission and the predecessor chain share one lock, including with
        # close(), so executor FIFO cannot race the per-task ordering chain.
        with self._lock:
            if not self.config.enabled or self._closed.is_set():
                return False
            if not self._pending_slots.acquire(blocking=False):
                self._log_drop(label)
                return False
            done = threading.Event()
            predecessor = state.tail if state is not None else None
            if state is not None:
                state.tail = done
            def run() -> None:
                if predecessor is not None:
                    while not predecessor.wait(0.05):
                        if self._closed.is_set() or (state is not None and state.cancelled.is_set()):
                            return
                if not self._closed.is_set() and not (state is not None and state.cancelled.is_set()):
                    work()
            try:
                future = self._executor.submit(run)
            except RuntimeError:
                done.set()
                self._pending_slots.release()
                return False
            def completed(_future) -> None:
                done.set()
                self._pending_slots.release()
            future.add_done_callback(completed)
            return True

    def _fire_and_forget(self, path: str, payload: dict[str, Any], *, label: str) -> None:
        self._submit(lambda: self._post_json(path, payload, label=label), label=label)

    def _log_drop(self, label: str) -> None:
        now = time.monotonic()
        family = label.split(":", 1)[0]
        interval = max(self.config.drop_log_interval_ms, 0) / 1000
        with self._lock:
            if interval > 0 and now - self._last_drop_log_at.get(family, 0.0) < interval:
                return
            self._last_drop_log_at[family] = now
        print(f"[LIPSYNC] drop bridge request for {label}: side channel capacity reached", flush=True)

    def _post_json(self, path: str, payload: dict[str, Any], *, label: str) -> int | None:
        if self._closed.is_set():
            return None
        try:
            response = self.client.post(
                path, json=payload, timeout=max(self.config.request_timeout_ms / 1000, 0.05),
            )
            if response.status_code not in {200, 202}:
                print(f"[LIPSYNC] bridge request failed for {label}: {response.status_code} {response.text[:200]}", flush=True)
            else:
                try:
                    body = response.json()
                except Exception:
                    body = None
                if isinstance(body, dict) and body.get("status") in {"failed", "dropped_busy"}:
                    print(f"[LIPSYNC] bridge request rejected for {label}: {body}", flush=True)
            return int(response.status_code)
        except Exception as exc:
            print(f"[LIPSYNC] bridge request error for {label}: {exc}", flush=True)
            return None
