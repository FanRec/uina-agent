import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

import threading
from types import SimpleNamespace
from service import TTSBridgeService
from sliding_window import SlidingWindowState
from playback_coordinator import PlaybackCoordinator
from models import AudioAsset


def test_reset_does_not_enable_epoch_without_stop_confirmation():
    instance = SimpleNamespace(
        _lock=threading.RLock(), _reset_results={}, _epoch_by_session={"s": "old"},
        _sessions_by_trace={"s:one": object()}, _tasks={},
        cancel_trace=lambda request: {"status": "cancelled", "stop_outcome": "unknown", "playback_stopped": False, "cancelled_task_count": 1},
    )
    result = TTSBridgeService._reset_epoch(instance, "s", "old")
    assert result["status"] == "unknown"
    assert instance._epoch_by_session["s"] == "old"


def test_cancel_waits_without_holding_registry_lock():
    lock = threading.RLock()
    observed = []
    class Player:
        def cancel_all(self):
            acquired = threading.Event()
            thread = threading.Thread(target=lambda: (lock.acquire(), acquired.set(), lock.release()))
            thread.start()
            observed.append(acquired.wait(0.2))
            thread.join(0.2)
        is_playing = False
    coordinator = PlaybackCoordinator(lock=lock, player=Player(), sessions_by_trace={}, streaming_config=SimpleNamespace())
    from playback_coordinator import PlaybackLease
    lease = PlaybackLease("t", 1, 1)
    coordinator._active_lease = lease
    coordinator.cancel_if_owner(lease)
    assert observed == [True]


def test_empty_first_index_is_not_skipped_to_hide_missing_speech():
    sessions = {}
    state = SlidingWindowState(lock=threading.RLock(), sessions_by_trace=sessions)
    state.register_segment(trace_id="replacement", generation_id=1, segment_index=1, task_id="id", text="new", state="pending")
    assert sessions["replacement"].next_play_index == 1


def test_failed_playback_is_not_completed():
    lock = threading.RLock()
    sessions = {}
    state = SlidingWindowState(lock=lock, sessions_by_trace=sessions)
    state.register_segment(trace_id="t", generation_id=1, segment_index=1, task_id="id", text="speech", state="playing")
    coordinator = PlaybackCoordinator(lock=lock, player=SimpleNamespace(), sessions_by_trace=sessions, streaming_config=SimpleNamespace())
    coordinator._finalize_playback_turn(trace_id="t", generation_id=1, segment_index=1, playback_failed=True, error_msg="device failed")
    assert sessions["t"].segments[1].state == "failed"
    assert sessions["t"].closed
