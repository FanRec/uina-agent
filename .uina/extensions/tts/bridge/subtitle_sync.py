from __future__ import annotations

import math
import logging
import threading
import time
from typing import Callable

import httpx

from models import PlaybackProgressSnapshot, SubtitleProgressEvent, SubtitleSyncConfig

logger = logging.getLogger("services.tts_bridge.subtitle_sync")


def _graphemes(text: str) -> list[str]:
    try:
        import regex  # type: ignore

        return regex.findall(r"\X", text)
    except Exception:
        return list(text)


class SubtitleSyncEmitter:
    def __init__(self, config: SubtitleSyncConfig, *, client: httpx.Client | None = None) -> None:
        self.config = config
        self.client = client or httpx.Client(base_url=config.obs_base_url.rstrip("/"), trust_env=False)
        self._lock = threading.Lock()

    def close(self) -> None:
        self.client.close()

    def emit(self, event: SubtitleProgressEvent) -> None:
        if not self.config.enabled:
            return
        payload = {
            "trace_id": event.trace_id,
            "task_id": event.task_id,
            "text": event.text,
            "action": event.action,
            "metadata": {
                "generation_id": event.generation_id,
                "segment_index": event.segment_index,
                "revealed_text": event.revealed_text,
                "revealed_count": event.revealed_count,
                "playback_started": event.playback_started,
                "playback_completed": event.playback_completed,
                **dict(event.metadata),
            },
        }
        with self._lock:
            try:
                self.client.post("/v1/obs/subtitle", json=payload, timeout=0.5)
            except Exception as exc:
                logger.warning(
                    "obs subtitle emit failed",
                    extra={
                        "trace_id": event.trace_id,
                        "stage": "subtitle_sync",
                        "service": "tts_bridge",
                        "status": "degraded",
                        "action": event.action,
                        "segment_index": event.segment_index,
                        "error": str(exc),
                    },
                )

    def emit_clear(self, *, trace_id: str, generation_id: int, reason: str) -> None:
        self.emit(
            SubtitleProgressEvent(
                trace_id=trace_id,
                generation_id=generation_id,
                segment_index=0,
                task_id=f"{trace_id}_clear",
                action="clear",
                text="",
                playback_completed=True,
                metadata={"reason": reason},
            )
        )

    def emit_turn_end(self, *, trace_id: str, generation_id: int, task_id: str, segment_index: int) -> None:
        self.emit(
            SubtitleProgressEvent(
                trace_id=trace_id,
                generation_id=generation_id,
                segment_index=segment_index,
                task_id=task_id,
                action="turn_end",
                text="",
                playback_started=True,
                playback_completed=True,
            )
        )

    def emit_sentence(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
        task_id: str,
        text: str,
        playback_started: bool = False,
        playback_completed: bool = False,
        metadata: dict[str, object] | None = None,
    ) -> None:
        revealed = _graphemes(text)
        self.emit(
            SubtitleProgressEvent(
                trace_id=trace_id,
                generation_id=generation_id,
                segment_index=segment_index,
                task_id=task_id,
                action="sentence",
                text=text,
                revealed_text=text,
                revealed_count=len(revealed),
                playback_started=playback_started,
                playback_completed=playback_completed,
                metadata=dict(metadata or {}),
            )
        )

    def emit_estimated_progress(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
        task_id: str,
        text: str,
        duration_ms: int,
        cancel_requested: Callable[[], bool],
    ) -> PlaybackProgressSnapshot:
        graphemes = _graphemes(text)
        total = len(graphemes)
        interval_ms = max(self.config.progress_interval_ms, 10)
        self.emit(
            SubtitleProgressEvent(
                trace_id=trace_id,
                generation_id=generation_id,
                segment_index=segment_index,
                task_id=task_id,
                action="segment_start",
                text=text,
                revealed_text="",
                revealed_count=0,
                playback_started=True,
                playback_completed=False,
                metadata={"duration_ms": duration_ms, "estimated": True},
            )
        )
        started_at = time.perf_counter() * 1000
        last_revealed = 0
        last_elapsed_ms = 0.0
        while True:
            if cancel_requested():
                break
            elapsed_ms = max((time.perf_counter() * 1000) - started_at, 0.0)
            last_elapsed_ms = min(elapsed_ms, float(duration_ms))
            ratio = 1.0 if duration_ms <= 0 else min(elapsed_ms / duration_ms, 1.0)
            revealed = min(total, math.floor(ratio * total))
            if revealed != last_revealed:
                last_revealed = revealed
                self.emit(
                    SubtitleProgressEvent(
                        trace_id=trace_id,
                        generation_id=generation_id,
                        segment_index=segment_index,
                        task_id=task_id,
                        action="segment_progress" if revealed < total else "segment_complete",
                        text=text,
                        revealed_text="".join(graphemes[:revealed]),
                        revealed_count=revealed,
                        playback_started=True,
                        playback_completed=revealed >= total,
                        metadata={"duration_ms": duration_ms, "estimated": True},
                    )
                )
            if revealed >= total:
                return PlaybackProgressSnapshot(
                    playback_started=True,
                    played_ms=float(duration_ms),
                    played_samples=0,
                    buffered_ms=0.0,
                    segment_finished=True,
                    duration_ms=duration_ms,
                )
            time.sleep(interval_ms / 1000)
        return PlaybackProgressSnapshot(
            playback_started=True,
            played_ms=last_elapsed_ms,
            played_samples=0,
            buffered_ms=0.0,
            segment_finished=False,
            duration_ms=duration_ms,
        )

    def run_progress_loop(
        self,
        *,
        trace_id: str,
        generation_id: int,
        segment_index: int,
        task_id: str,
        text: str,
        duration_ms: int,
        snapshot_getter: Callable[[], PlaybackProgressSnapshot],
        cancel_requested: Callable[[], bool],
    ) -> PlaybackProgressSnapshot:
        graphemes = _graphemes(text)
        total = len(graphemes)
        started_sent = False
        last_revealed = -1
        interval_s = max(self.config.progress_interval_ms, 10) / 1000
        final_snapshot = snapshot_getter()

        while True:
            if cancel_requested():
                return final_snapshot
            snapshot = snapshot_getter()
            final_snapshot = snapshot
            if snapshot.playback_started and not started_sent:
                started_sent = True
                self.emit(
                    SubtitleProgressEvent(
                        trace_id=trace_id,
                        generation_id=generation_id,
                        segment_index=segment_index,
                        task_id=task_id,
                        action="segment_start",
                        text=text,
                        revealed_text="",
                        revealed_count=0,
                        playback_started=True,
                        playback_completed=False,
                    )
                )
            revealed = 0
            effective_duration = snapshot.duration_ms if snapshot.duration_ms > 0 else duration_ms
            if effective_duration > 0 and total > 0:
                ratio = max(0.0, min(snapshot.played_ms / effective_duration, 1.0))
                revealed = min(total, math.floor(ratio * total))
            if snapshot.segment_finished:
                revealed = total
            if revealed != last_revealed and started_sent:
                last_revealed = revealed
                self.emit(
                    SubtitleProgressEvent(
                        trace_id=trace_id,
                        generation_id=generation_id,
                        segment_index=segment_index,
                        task_id=task_id,
                        action="segment_progress" if revealed < total else "segment_complete",
                        text=text,
                        revealed_text="".join(graphemes[:revealed]),
                        revealed_count=revealed,
                        playback_started=snapshot.playback_started,
                        playback_completed=snapshot.segment_finished,
                        metadata={"duration_ms": duration_ms},
                    )
                )
            if snapshot.segment_finished:
                return snapshot
            time.sleep(interval_s)
