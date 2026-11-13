from __future__ import annotations

import json
import threading

from models import PlaybackProgressSnapshot
from playback_projection import PlaybackProjection, PlaybackSnapshotHub


def progress(*, started: bool = True, finished: bool = False, played_ms: float = 100.0, state: str = "playing") -> PlaybackProgressSnapshot:
    return PlaybackProgressSnapshot(
        playback_started=started,
        played_ms=played_ms,
        played_frames=int(played_ms),
        buffered_ms=20.0,
        segment_finished=finished,
        duration_ms=1000,
        state=state,
        clock_quality="submitted_samples",
    )


def test_playback_identity_is_created_when_segment_is_accepted_and_snapshot_is_atomic() -> None:
    projection = PlaybackProjection(lock=threading.RLock(), source_instance="source-a")
    projection.begin_segment(trace_id="trace", generation_id=1, segment_index=1, text="你好", duration_ms=1000)
    projection.update_progress(progress())

    snapshot = projection.snapshot()

    assert snapshot["state"] == "playing"
    assert snapshot["playback"]["id"]
    assert snapshot["playback"]["caption"]["text"] == "你好"
    assert snapshot["playback"]["positionMs"] == 100.0
    assert snapshot["playback"]["durationMs"] == 1000


def test_revision_changes_for_progress_but_heartbeat_reuses_it() -> None:
    projection = PlaybackProjection(lock=threading.RLock(), source_instance="source-a")
    projection.begin_segment(trace_id="trace", generation_id=1, segment_index=1, text="你好", duration_ms=1000)
    first = projection.snapshot()["revision"]
    projection.update_progress(progress(played_ms=100))
    second = projection.snapshot()["revision"]
    heartbeat = projection.heartbeat()

    assert second > first
    assert heartbeat["revision"] == second


def test_finish_exposes_ended_playback_without_replaying_it_on_idle_bootstrap() -> None:
    projection = PlaybackProjection(lock=threading.RLock(), source_instance="source-a")
    projection.begin_segment(trace_id="trace", generation_id=1, segment_index=1, text="你好", duration_ms=1000)
    projection.update_progress(progress(played_ms=1000, finished=True))
    projection.finish("completed")

    snapshot = projection.snapshot()

    assert snapshot["state"] == "idle"
    assert snapshot["playback"] is None
    assert snapshot["finishReason"] == "completed"
    assert snapshot["endedPlayback"]["id"]
    assert projection.heartbeat()["revision"] == snapshot["revision"]


def test_snapshot_hub_replaces_queued_progress_with_latest_snapshot() -> None:
    projection = PlaybackProjection(lock=threading.RLock(), source_instance="source-a")
    hub = PlaybackSnapshotHub(projection)
    stream = hub.stream()
    first = next(stream)
    assert "event: playback.snapshot" in first
    assert json.loads(first.split("data: ", 1)[1].strip())["state"] == "idle"

    projection.begin_segment(trace_id="trace", generation_id=1, segment_index=1, text="一", duration_ms=1000)
    hub.publish(projection.snapshot())
    projection.update_progress(progress(played_ms=100))
    hub.publish(projection.snapshot())
    payload = next(stream)
    assert json.loads(payload.split("data: ", 1)[1].strip())["playback"]["positionMs"] == 100.0
    stream.close()
