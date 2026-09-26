from __future__ import annotations

import threading
from typing import Any

from models import AudioAsset, GenerationSession, SegmentKey, SegmentRecord, SegmentState


class SlidingWindowState:
    def __init__(self, *, lock: threading.Lock, sessions_by_trace: dict[str, GenerationSession]) -> None:
        self._lock = lock
        self._sessions_by_trace = sessions_by_trace

    def get_session(self, *, trace_id: str, generation_id: int) -> GenerationSession:
        with self._lock:
            session = self._sessions_by_trace.get(trace_id)
            if session is None or session.generation_id != generation_id:
                session = GenerationSession(
                    trace_id=trace_id,
                    generation_id=generation_id,
                    condition=threading.Condition(self._lock),
                )
                self._sessions_by_trace[trace_id] = session
            return session

    def register_segment(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
        task_id: str,
        text: str,
        state: SegmentState,
    ) -> SegmentRecord:
        session = self.get_session(trace_id=trace_id, generation_id=generation_id)
        with self._lock:
            record = session.segments.get(segment_index)
            if record is None:
                record = SegmentRecord(
                    key=SegmentKey(trace_id=trace_id, generation_id=generation_id, segment_index=segment_index),
                    task_id=task_id,
                    text=text,
                    state=state,
                )
                session.segments[segment_index] = record
            else:
                record.task_id = task_id
                record.text = text
                record.state = state
            session.next_issue_index = max(session.next_issue_index, segment_index + 1)
            if not any(
                item.state in {"ready", "playing", "completed"}
                for item in session.segments.values()
                if item.key.segment_index < segment_index
            ):
                session.next_play_index = min(session.next_play_index, segment_index)
            if session.condition is not None:
                session.condition.notify_all()
            return record

    def wait_for_issue_window(self, *, trace_id: str, generation_id: int, segment_index: int, window_size: int) -> None:
        session = self.get_session(trace_id=trace_id, generation_id=generation_id)
        with self._lock:
            if session.closed:
                return
            window_limit = session.next_play_index + max(window_size - 1, 0)
            while segment_index > window_limit and not session.closed:
                condition = session.condition
                if condition is None:
                    break
                condition.wait(timeout=0.05)
                window_limit = session.next_play_index + max(window_size - 1, 0)

    def is_current_generation(self, *, trace_id: str, generation_id: int) -> bool:
        with self._lock:
            session = self._sessions_by_trace.get(trace_id)
            return bool(session is not None and session.generation_id == generation_id and not session.closed)

    def register_ready_segment(
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
        with self._lock:
            session = self._sessions_by_trace.get(trace_id)
            if session is None or session.generation_id != generation_id or session.closed:
                return False
            record = session.segments.get(segment_index)
            if record is None:
                record = SegmentRecord(
                    key=SegmentKey(trace_id=trace_id, generation_id=generation_id, segment_index=segment_index),
                    task_id=task_id,
                    text=text,
                )
                session.segments[segment_index] = record
                if not any(
                    item.state in {"ready", "playing", "completed"}
                    for item in session.segments.values()
                    if item.key.segment_index < segment_index
                ):
                    session.next_play_index = min(session.next_play_index, segment_index)
            if record.state in {"obsolete", "cancelled", "completed"}:
                return False
            record.asset = asset
            record.detail = dict(detail)
            record.state = "ready"
            if session.condition is not None:
                session.condition.notify_all()
            return True

    def mark_segment_completed(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
        detail: dict[str, Any],
    ) -> None:
        with self._lock:
            session = self._sessions_by_trace.get(trace_id)
            if session is None or session.generation_id != generation_id:
                return
            record = session.segments.get(segment_index)
            if record is None:
                return
            record.detail = dict(detail)
            if record.state not in {"completed", "obsolete", "cancelled"}:
                record.state = "completed"
            if session.next_play_index == segment_index:
                session.next_play_index += 1
            if session.condition is not None:
                session.condition.notify_all()

    def notify_trace(self, trace_id: str) -> None:
        with self._lock:
            session = self._sessions_by_trace.get(trace_id)
            if session is not None and session.condition is not None:
                session.condition.notify_all()

    def close_trace(self, trace_id: str) -> GenerationSession | None:
        with self._lock:
            session = self._sessions_by_trace.get(trace_id)
            if session is None:
                return None
            session.closed = True
            for record in session.segments.values():
                if record.state in {"pending", "synthesizing", "ready"}:
                    record.state = "obsolete"
                elif record.state == "playing":
                    record.state = "cancelled"
            if session.condition is not None:
                session.condition.notify_all()
            return session
