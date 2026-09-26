from __future__ import annotations

import threading
from typing import Any, Callable

from audio_playback import playback_timeout_ms


class PlaybackCoordinator:
    def __init__(self, *, lock: threading.Lock, player, sessions_by_trace: dict[str, Any], streaming_config) -> None:
        self._lock = lock
        self._player = player
        self._sessions_by_trace = sessions_by_trace
        self._streaming_config = streaming_config
        self._playback_lock = threading.Lock()
        self._trace_playback_order: list[str] = []

    def _register_trace_locked(self, trace_id: str) -> None:
        if trace_id not in self._trace_playback_order:
            self._trace_playback_order.append(trace_id)

    def current_playback_trace_locked(self) -> str | None:
        while self._trace_playback_order:
            head = self._trace_playback_order[0]
            session = self._sessions_by_trace.get(head)
            if session is None or session.closed:
                self._trace_playback_order.pop(0)
                continue
            if session.expected_end_index is not None and session.next_play_index > session.expected_end_index:
                self._trace_playback_order.pop(0)
                continue
            return head
        return None

    def cancel_trace(self, trace_id: str) -> None:
        with self._lock:
            if trace_id in self._trace_playback_order:
                self._trace_playback_order.remove(trace_id)
            self._notify_all_sessions_locked()

    def finish_trace(self, trace_id: str) -> None:
        with self._lock:
            if trace_id in self._trace_playback_order:
                self._trace_playback_order.remove(trace_id)
            self._notify_all_sessions_locked()

    def check_and_notify_finished(self, trace_id: str) -> None:
        with self._lock:
            session = self._sessions_by_trace.get(trace_id)
            if session is not None and session.expected_end_index is not None:
                if session.next_play_index > session.expected_end_index:
                    if trace_id in self._trace_playback_order:
                        self._trace_playback_order.remove(trace_id)
            self._notify_all_sessions_locked()

    def _notify_all_sessions_locked(self) -> None:
        for session in self._sessions_by_trace.values():
            if session.condition is not None:
                session.condition.notify_all()

    def _wait_for_playback_turn(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
    ) -> Any | None:
        """Trace-level FIFO queue and segment-level sequence barrier wait loop."""
        while True:
            with self._lock:
                self._register_trace_locked(trace_id)
                current_trace = self.current_playback_trace_locked()

                session = self._sessions_by_trace.get(trace_id)
                if session is None or session.generation_id != generation_id or session.closed:
                    return None
                record = session.segments.get(segment_index)
                if record is None or record.state in {"obsolete", "cancelled", "failed", "completed"}:
                    return None

                # Barrier condition: wait until this trace is head and this segment is next
                if (
                    current_trace != trace_id
                    or session.next_play_index != segment_index
                    or record.state != "ready"
                    or record.asset is None
                ):
                    condition = session.condition
                    if condition is None:
                        return None
                    condition.wait(timeout=0.05)
                    continue

                record.state = "playing"
                return record.asset

    def _dispatch_playback_execution(
        self,
        asset: Any,
        playback_runner: Callable[[Any], dict[str, Any]] | None,
    ) -> tuple[dict[str, Any], bool]:
        """Dispatches audio asset to player and returns (result_dict, playback_failed)."""
        result = {"playback_started": True, "playback_completed": False}
        playback_failed = False
        try:
            prebuffer_ms = int(
                asset.metrics.get("prebuffer_ms", self._streaming_config.prebuffer_ms)
                or self._streaming_config.prebuffer_ms
            )
            rebuffer_ms = int(
                asset.metrics.get("rebuffer_ms", self._streaming_config.rebuffer_ms)
                or self._streaming_config.rebuffer_ms
            )
            timeout = playback_timeout_ms(asset.duration_ms, self._streaming_config.drain_timeout_ms)

            if playback_runner is not None:
                result.update(playback_runner(asset))
            elif asset.kind == "pcm" and asset.pcm_stream is not None:
                completed = self._player.play_streaming_chunks_and_wait(
                    sample_rate=asset.sample_rate,
                    chunk_source=asset.pcm_stream,
                    timeout_ms=timeout,
                    prebuffer_ms=prebuffer_ms,
                    rebuffer_ms=rebuffer_ms,
                )
                result.update(self._player.stream_stats())
                result["playback_completed"] = completed
            elif asset.kind == "pcm":
                completed = self._player.play_pcm_and_wait(
                    pcm_bytes=asset.pcm_bytes or b"",
                    sample_rate=asset.sample_rate,
                    timeout_ms=timeout,
                    prebuffer_ms=prebuffer_ms,
                    rebuffer_ms=rebuffer_ms,
                )
                result.update(self._player.stream_stats())
                result["playback_completed"] = completed
            elif asset.artifact_path is None:
                result = {"playback_started": False, "playback_completed": False}
                playback_failed = True
            elif callable(getattr(self._player, "play_file_as_pcm_and_wait", None)):
                completed = self._player.play_file_as_pcm_and_wait(
                    path=asset.artifact_path,
                    timeout_ms=timeout,
                    prebuffer_ms=prebuffer_ms,
                    rebuffer_ms=rebuffer_ms,
                )
                result["playback_completed"] = completed
            else:
                completed = self._player.enqueue_and_wait(
                    asset.artifact_path,
                    wait=True,
                    timeout_ms=timeout,
                )
                result["playback_completed"] = completed
        except Exception as exc:
            playback_failed = True
            result = {
                "playback_started": False,
                "playback_completed": False,
                "playback_error": f"{type(exc).__name__}: {exc}",
            }
        return result, playback_failed

    def _finalize_playback_turn(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
        playback_failed: bool,
        error_msg: str | None,
    ) -> None:
        """Updates segment record state, advances next_play_index, and notifies waiting sessions."""
        with self._lock:
            session = self._sessions_by_trace.get(trace_id)
            if session is not None and session.generation_id == generation_id:
                record = session.segments.get(segment_index)
                if record is not None and record.state == "playing":
                    record.state = "failed" if playback_failed else "completed"
                    if playback_failed and error_msg:
                        record.detail = {**record.detail, "playback_error": error_msg}
                if session.next_play_index == segment_index:
                    session.next_play_index += 1
                if session.expected_end_index is not None and session.next_play_index > session.expected_end_index:
                    if trace_id in self._trace_playback_order:
                        self._trace_playback_order.remove(trace_id)
                    self._notify_all_sessions_locked()
                elif session.condition is not None:
                    session.condition.notify_all()

    def play_ready_segment(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
        playback_runner: Callable[[Any], dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if not self._player.ready:
            return {"playback_started": False, "playback_completed": False}

        asset = self._wait_for_playback_turn(
            trace_id=trace_id,
            generation_id=generation_id,
            segment_index=segment_index,
        )
        if asset is None:
            return {"playback_started": False, "playback_completed": False}

        with self._playback_lock:
            with self._lock:
                session = self._sessions_by_trace.get(trace_id)
                if session is None or session.generation_id != generation_id or session.closed:
                    return {"playback_started": False, "playback_completed": False, "late_result_discarded": True}
                record = session.segments.get(segment_index)
                if record is None or record.state != "playing":
                    return {"playback_started": False, "playback_completed": False, "late_result_discarded": True}

            result, playback_failed = self._dispatch_playback_execution(asset, playback_runner)

            self._finalize_playback_turn(
                trace_id=trace_id,
                generation_id=generation_id,
                segment_index=segment_index,
                playback_failed=playback_failed,
                error_msg=result.get("playback_error"),
            )
            return result

    def finalize_late_result(
        self,
        *,
        is_current_generation: bool,
        playback_result: dict[str, Any],
    ) -> dict[str, Any]:
        if is_current_generation:
            return playback_result
        return {
            "playback_started": False,
            "playback_completed": False,
            "late_result_discarded": True,
        }
