from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from queue import Empty, Full, Queue
from typing import Any, Iterator
from uuid import uuid4

from models import BridgeTask

STREAM_END = object()


class TaskRegistry:
    def __init__(self, *, lock: threading.Lock | threading.RLock | None = None) -> None:
        self._tasks: dict[str, BridgeTask] = {}
        self._lock = threading.RLock()

    @property
    def tasks(self) -> dict[str, BridgeTask]:
        return self._tasks

    @tasks.setter
    def tasks(self, value: dict[str, BridgeTask]) -> None:
        with self._lock:
            self._tasks = value

    def get(self, task_id: str) -> BridgeTask | None:
        with self._lock:
            return self._tasks.get(task_id)

    def set(self, task: BridgeTask) -> None:
        with self._lock:
            self._tasks[task.task_id] = task

    def remove(self, task_id: str) -> BridgeTask | None:
        with self._lock:
            return self._tasks.pop(task_id, None)

    def values(self) -> list[BridgeTask]:
        with self._lock:
            return list(self._tasks.values())

    def trace_tasks(self, trace_id: str) -> list[BridgeTask]:
        with self._lock:
            return [task for task in self._tasks.values() if task.trace_id == trace_id]

    def __contains__(self, task_id: str) -> bool:
        with self._lock:
            return task_id in self._tasks

    def __iter__(self):
        with self._lock:
            return iter(list(self._tasks.keys()))


class PlaybackEventHub:
    def __init__(self, *, lock: threading.Lock | threading.RLock | None = None) -> None:
        self.subscribers: dict[str, list[Queue[dict[str, Any] | object]]] = {}
        self.stop_event = threading.Event()
        self._lock = threading.RLock()

    def close(self) -> None:
        self.stop_event.set()
        with self._lock:
            subscribers = [
                subscriber
                for subscriber_list in self.subscribers.values()
                for subscriber in subscriber_list
            ]
            self.subscribers.clear()
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(STREAM_END)
            except Full:
                pass

    def publish(
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
        current_trace_id = trace_id or (task.trace_id if task is not None else None)
        if not current_trace_id:
            return
        current_generation_id = generation_id
        current_segment_index = segment_index
        current_task_id = task_id
        if task is not None:
            current_generation_id = current_generation_id if current_generation_id is not None else int(task.detail.get("generation_id", 1) or 1)
            current_segment_index = current_segment_index if current_segment_index is not None else int(task.detail.get("segment_index", 0) or 0)
            current_task_id = current_task_id or task.task_id
        event = {
            "event_id": f"tts_evt_{uuid4().hex}",
            "kind": kind,
            "trace_id": current_trace_id,
            "generation_id": current_generation_id,
            "segment_index": current_segment_index,
            "task_id": current_task_id,
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "detail": {
                **(detail or {}),
                **({"traceparent": task.detail.get("traceparent")} if task is not None and task.detail.get("traceparent") else {}),
            },
        }
        with self._lock:
            subscribers = list(self.subscribers.get(current_trace_id, []))
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(event)
            except Full:
                pass

    def stream(self, trace_id: str) -> Iterator[str]:
        queue: Queue[dict[str, Any] | object] = Queue(maxsize=128)
        self.stop_event.clear()
        with self._lock:
            self.subscribers.setdefault(trace_id, []).append(queue)
        try:
            yield ": connected\n\n"
            while not self.stop_event.is_set():
                try:
                    item = queue.get(timeout=0.5)
                except Empty:
                    continue
                if item is STREAM_END:
                    break
                yield f"event: tts.playback\ndata: {json.dumps(item, ensure_ascii=False)}\n\n"
        finally:
            with self._lock:
                subscribers = self.subscribers.get(trace_id, [])
                if queue in subscribers:
                    subscribers.remove(queue)
                if not subscribers:
                    self.subscribers.pop(trace_id, None)
