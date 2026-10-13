import sys
import threading
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).parent))

from audio_playback import AudioPlayback
from lifecycle_handlers import TTSBridgeConfig
from models import AudioAsset
from playback_coordinator import PlaybackCoordinator, PlaybackLease
from service import TTSBridgeService
from sliding_window import SlidingWindowState
from synthesis_handlers import SpeakRequest, TurnEndRequest


def coordinator_with_ready_segment(player):
    lock = threading.RLock()
    sessions = {}
    state = SlidingWindowState(lock=lock, sessions_by_trace=sessions)
    state.register_segment(trace_id="t", generation_id=1, segment_index=1,
        task_id="id", text="speech", state="ready")
    sessions["t"].segments[1].asset = AudioAsset(kind="pcm", artifact_path=None,
        sample_rate=32000, duration_ms=20, media_type="raw", pcm_bytes=b"\x01\x00")
    coordinator = PlaybackCoordinator(lock=lock, player=player,
        sessions_by_trace=sessions,
        streaming_config=SimpleNamespace(prebuffer_ms=1, rebuffer_ms=1, drain_timeout_ms=50))
    return coordinator, sessions


class TimeoutPlayer:
    ready = True

    def __init__(self, stop_fails=False):
        self.is_playing = False
        self.stop_fails = stop_fails
        self.cancel_count = 0

    def arm_playback(self, is_cancelled):
        self.is_cancelled = is_cancelled

    def play_pcm_and_wait(self, **kwargs):
        self.is_playing = True
        return False

    def stream_stats(self):
        return {"playback_started": True}

    def cancel_all(self):
        self.cancel_count += 1
        if self.stop_fails:
            raise RuntimeError("device stop failed")
        self.is_playing = False

    def stop(self):
        self.cancel_all()


def test_playback_timeout_stops_physical_player_before_releasing_lease():
    player = TimeoutPlayer()
    coordinator, sessions = coordinator_with_ready_segment(player)
    result = coordinator.play_ready_segment(trace_id="t", generation_id=1, segment_index=1)
    assert result["playback_completed"] is False
    assert player.cancel_count >= 1
    assert player.is_playing is False
    assert coordinator._active_lease is None
    assert sessions["t"].segments[1].state == "failed"


def test_failed_timeout_stop_preserves_lease_and_reports_unknown():
    player = TimeoutPlayer(stop_fails=True)
    coordinator, _ = coordinator_with_ready_segment(player)
    result = coordinator.play_ready_segment(trace_id="t", generation_id=1, segment_index=1)
    assert player.is_playing is True
    assert coordinator._active_lease == PlaybackLease("t", 1, 1)
    assert result.get("stop_outcome") == "unknown"


def test_cancelled_arm_cannot_open_a_late_audio_stream():
    player = AudioPlayback()
    player._sd_available = True
    player._sd = object()
    cancelled = threading.Event()
    opened = []
    with patch.object(player, "_open_sounddevice_stream", side_effect=lambda *args: opened.append(args)), \
            patch("audio_playback.AUDIO_EXECUTOR.call", side_effect=lambda fn: fn()):
        player.arm_playback(cancelled.is_set)
        cancelled.set()
        player.cancel_all()
        try:
            player.start_stream(32000, prebuffer_ms=1, rebuffer_ms=1)
        except RuntimeError:
            pass
    assert opened == []
    assert player.is_playing is False


def test_audio_device_stop_error_remains_unconfirmed():
    def refuse_stop():
        raise RuntimeError("device refused stop")

    player = AudioPlayback()
    stream = SimpleNamespace(stop=refuse_stop)
    player._stream = stream
    with patch("audio_playback.AUDIO_EXECUTOR.call", side_effect=lambda fn: fn()):
        with pytest.raises(RuntimeError, match="device refused stop"):
            player.cancel_all()
    assert player._stream is stream


def test_bridge_can_release_source_sealed_at_last_admitted_index_after_http400():
    class Vendor:
        process = None
        def ready(self): return True
        def ensure_running(self): return False
        def wait_until_ready(self, timeout): return True
        def close(self): pass

    config = TTSBridgeConfig.load(Path(__file__).parent / "config/service.toml")
    config = replace(config,
        lipsync_bridge=replace(config.lipsync_bridge, enabled=False),
        subtitle_sync=replace(config.subtitle_sync, enabled=False))
    service = TTSBridgeService(config, vendor_manager=Vendor(), player=TimeoutPlayer())
    try:
        with patch.object(service, "_resolve_ref_audio_path", return_value=Path("unused")), \
                patch.object(service, "_ensure_delivery_worker"), \
                patch.object(service, "_should_reject_admission", return_value=False):
            service.admit_speak(SpeakRequest(trace_id="old", segment_id="old:1", index=1, text="first"))
            with pytest.raises(HTTPException) as rejected:
                service.admit_speak(SpeakRequest(trace_id="old", segment_id="old:2", index=2, text=chr(0x20000)))
            assert rejected.value.status_code == 400
            session = service._sessions_by_trace["old"]
            session.segments[1].state = "completed"
            session.next_play_index = 2
            service.admit_speak(SpeakRequest(trace_id="new", segment_id="new:1", index=1, text="new speech"))
            service.mark_turn_end(TurnEndRequest(trace_id="old", last_segment_index=1))
            with service._lock:
                assert service._playback.current_playback_trace_locked() == "new"
    finally:
        service.close()
