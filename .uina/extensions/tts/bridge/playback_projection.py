from __future__ import annotations

import json
import threading
import time
from copy import deepcopy
from queue import Empty, Full, Queue
from typing import Any, Iterator
from uuid import uuid4

from models import PlaybackProgressSnapshot


class PlaybackProjection:
    """Atomic current-physical-playback projection; no OBS-specific dependency."""

    def __init__(self, *, lock: threading.RLock | threading.Lock | None = None, source_instance: str | None = None) -> None:
        self._lock = lock or threading.RLock()
        self._source_instance = source_instance or str(uuid4())
        self._revision = 0
        self._state = "idle"
        self._playback: dict[str, Any] | None = None
        self._finish_reason: str | None = None
        self._ended_playback: dict[str, Any] | None = None

    def begin_segment(self, *, trace_id: str, generation_id: int, segment_index: int, text: str, duration_ms: int | None) -> str:
        with self._lock:
            playback_id = f"{trace_id}:g{generation_id}:s{segment_index}:{uuid4().hex[:12]}"
            self._playback = {
                "id": playback_id,
                "positionMs": 0.0,
                "durationMs": duration_ms if duration_ms and duration_ms > 0 else None,
                "clockQuality": "unknown",
                "caption": {"text": text, "cues": None},
            }
            self._state = "buffering"
            self._finish_reason = None
            self._ended_playback = None
            self._revision += 1
            return playback_id

    def update_progress(self, progress: PlaybackProgressSnapshot, *, playback_id: str | None = None) -> None:
        with self._lock:
            if self._playback is None or (playback_id is not None and self._playback["id"] != playback_id):
                return
            duration = progress.duration_ms if progress.duration_ms > 0 else None
            position = max(float(progress.played_ms), 0.0)
            if duration is not None:
                position = min(position, float(duration))
            state = progress.state
            if state not in {"playing", "buffering", "paused"}:
                state = "playing" if progress.playback_started else "buffering"
            updated = {
                **self._playback,
                "positionMs": position,
                "durationMs": duration,
                "clockQuality": progress.clock_quality,
            }
            if updated != self._playback or state != self._state:
                self._playback = updated
                self._state = state
                self._revision += 1

    def finish(self, reason: str, *, playback_id: str | None = None) -> None:
        with self._lock:
            if self._playback is None or (playback_id is not None and self._playback["id"] != playback_id):
                return
            self._ended_playback = {
                "id": self._playback["id"],
                "caption": deepcopy(self._playback["caption"]),
            } if reason == "completed" else None
            self._playback = None
            self._state = "idle"
            self._finish_reason = reason
            self._revision += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "version": 1,
                "sourceInstance": self._source_instance,
                "revision": self._revision,
                "state": self._state,
                "playback": deepcopy(self._playback),
                "finishReason": self._finish_reason,
                "endedPlayback": deepcopy(self._ended_playback),
            }

    def heartbeat(self) -> dict[str, Any]:
        return self.snapshot()


class PlaybackSnapshotHub:
    def __init__(self, projection: PlaybackProjection) -> None:
        self._projection = projection
        self._lock = threading.RLock()
        self._subscribers: list[Queue[dict[str, Any] | object]] = []
        self._closed = threading.Event()
        self._end = object()

    def publish(self, snapshot: dict[str, Any]) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for queue in subscribers:
            self._replace(queue, snapshot)

    @staticmethod
    def _replace(queue: Queue[dict[str, Any] | object], snapshot: dict[str, Any] | object) -> None:
        try:
            queue.put_nowait(snapshot)
        except Full:
            try:
                queue.get_nowait()
            except Empty:
                pass
            try:
                queue.put_nowait(snapshot)
            except Full:
                pass

    def stream(self) -> Iterator[str]:
        queue: Queue[dict[str, Any] | object] = Queue(maxsize=1)
        with self._lock:
            if self._closed.is_set():
                return
            self._subscribers.append(queue)
            queue.put_nowait(self._projection.snapshot())
        last_revision = None
        last_yield_at = time.monotonic()
        try:
            while not self._closed.is_set():
                try:
                    # 0.5s heartbeat keeps client-side stale detection (3s) tolerant
                    # to bursts of process load instead of a single missed second.
                    item = queue.get(timeout=0.5)
                except Empty:
                    item = self._projection.heartbeat()
                if item is self._end:
                    break
                now = time.monotonic()
                gap_s = now - last_yield_at
                last_yield_at = now
                if gap_s > 2.0:
                    # The generator was not scheduled for over 2s: starvation by
                    # synthesis/playback load (GIL contention). Clients abort the
                    # stream after 3s of silence, so gaps near 3s are the
                    # reconnect-storm signature worth surfacing.
                    print(
                        f"[TTS][stream-stall] playback snapshot stream gap {gap_s:.2f}s (revision={item.get('revision')})",
                        flush=True,
                    )
                if item["revision"] == last_revision:
                    yield ": heartbeat\n\n"
                else:
                    last_revision = item["revision"]
                    yield f"event: playback.snapshot\ndata: {json.dumps(item, ensure_ascii=False)}\n\n"
        finally:
            with self._lock:
                if queue in self._subscribers:
                    self._subscribers.remove(queue)

    def close(self) -> None:
        self._closed.set()
        with self._lock:
            subscribers = list(self._subscribers)
            self._subscribers.clear()
        for queue in subscribers:
            self._replace(queue, self._end)
