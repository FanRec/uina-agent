from dataclasses import replace
from pathlib import Path
import threading
import time
import io
import wave
import httpx
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from lifecycle_handlers import TTSBridgeConfig
from models import AudioAsset, BridgeTask, GenerationSession, SegmentKey, SegmentRecord
from playback_projection import PlaybackProjection, PlaybackSnapshotHub
from runtime_components import PlaybackEventHub
from service import TTSBridgeService
from synthesis_handlers import SpeakRequest, TurnEndRequest


class Vendor:
    process = None
    def ready(self): return True
    def ensure_running(self): return False
    def wait_until_ready(self, timeout): return True
    def close(self): pass
    def synthesize_stream(self, payload, **kwargs): yield b"\x01\x00"


class Player:
    ready = True
    is_playing = False
    is_streaming = False
    supports_streaming = True
    def start(self): pass
    def stop(self): pass
    def cancel_all(self): pass


@pytest.fixture
def service(tmp_path):
    config = TTSBridgeConfig.load(Path(__file__).parent / "config/service.toml")
    config = replace(config, output_dir=tmp_path, preset=replace(config.preset, ref_audio_path=tmp_path / "ref.wav"), lipsync_bridge=replace(config.lipsync_bridge, enabled=False))
    config.preset.ref_audio_path.write_bytes(b"reference")
    instance = TTSBridgeService(config, vendor_manager=Vendor(), player=Player())
    yield instance
    instance.close()


def task(id, *, age=0, state="completed"):
    return BridgeTask(task_id=id, trace_id="trace", state=state, cancel_token="c", completed_at=time.time()-age)


def test_retention_keeps_active_tasks_and_bounds_terminal_summaries(service):
    service._tasks = {str(i): task(str(i)) for i in range(1100)}
    service._tasks["expired"] = task("expired", age=3601)
    service._tasks["active"] = task("active", state="in_progress")
    service._prune_terminal_state()
    assert len(service._tasks) == 1001
    assert service.task_status("expired")["status"] == "not_found"
    assert service.task_status("active")["status"] == "in_progress"


def test_retention_deletes_only_owned_artifacts_and_keeps_recent_query(service):
    old = service.config.output_dir / "old.wav"
    recent = service.config.output_dir / "recent.wav"
    unrelated = service.config.output_dir / "unrelated.wav"
    for file in [old, recent, unrelated]: file.write_bytes(b"audio")
    expired = task("old", age=3601)
    expired.artifact_path = str(old)
    current = task("recent")
    current.artifact_path = str(recent)
    service._tasks = {"old": expired, "recent": current}
    service._prune_terminal_state()
    assert not old.exists()
    assert recent.exists() and unrelated.exists()
    assert service.task_status("recent")["audio_path"] == str(recent)


def test_duplicate_admission_does_not_resynthesize_and_conflict_does_not_replace(service):
    request = SpeakRequest(trace_id="trace", segment_id="id", index=1, text="hello")
    with patch.object(service, "_ensure_delivery_worker"), patch.object(service, "_should_reject_admission", return_value=False):
        first = service.admit_speak(request)
        second = service.admit_speak(request)
        with pytest.raises(HTTPException) as conflict:
            service.admit_speak(request.model_copy(update={"text": "different"}))
    assert first["task_id"] == second["task_id"]
    assert service._delivery_queue.qsize() == 1
    assert conflict.value.status_code == 409
    assert service._tasks["id"].detail["original_text"] == "hello"


def test_completion_releases_trace_metadata_after_turn_end(service):
    service._tasks = {"id": task("id")}
    record = SegmentRecord(key=SegmentKey("trace",1,1), task_id="id", text="hello", state="completed")
    service._sessions_by_trace["trace"] = GenerationSession(trace_id="trace",generation_id=1,next_play_index=2,segments={1:record})
    service._next_generation_id_by_trace["trace"] = 1
    service._first_chunk_events[("trace",1)] = threading.Event()
    service.mark_turn_end(TurnEndRequest(trace_id="trace",last_segment_index=1))
    assert "trace" not in service._sessions_by_trace
    assert ("trace",1) not in service._first_chunk_events
    assert "trace" not in service._next_generation_id_by_trace
    assert service.task_status("id")["status"] == "delivered"


def test_snapshot_heartbeat_does_not_repeat_payload():
    projection = PlaybackProjection()
    hub = PlaybackSnapshotHub(projection)
    stream = hub.stream()
    assert "data:" in next(stream)
    assert next(stream).startswith(": heartbeat")
    stream.close()
    hub.close()


def test_closed_event_hub_cannot_be_reopened_by_subscribe():
    hub = PlaybackEventHub()
    hub.close()
    stream = hub.stream()
    assert next(stream, None) is None
    assert hub.stop_event.is_set()


def test_warmup_empty_stream_is_failure(service):
    service.vendor_manager.synthesize_stream = lambda *args, **kwargs: iter(())
    service._warmup_vendor_best_effort()
    assert service._warmup_status["status"] != "completed"


def test_close_marks_pending_delivery_terminal_and_does_not_restart_worker(service):
    service._tasks = {"waiting": task("waiting", state="pending")}
    service.close()
    assert service._tasks["waiting"].state in {"cancelled", "unknown"}
    with pytest.raises(HTTPException):
        service.admit_speak(SpeakRequest(trace_id="new",segment_id="new",index=1,text="hello"))


def _valid_wav() -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(8000)
        wav_file.writeframes(b"\x00\x00" * 800)
    return buffer.getvalue()


class SynthVendor(Vendor):
    ownership = "external"

    def synthesize(self, payload, *, timeout_ms):
        return httpx.Response(200, content=_valid_wav())


def test_synthesis_test_executes_vendor_and_validates_audio(service):
    service.vendor_manager = SynthVendor()
    result = service.test("synthesis", "test-session")
    assert result["status"] == "succeeded"
    assert result["duration_ms"] > 0
    assert result["sample_rate"] == 8000
    assert service.health()["last_verification"]["scope"] == "synthesis"


def test_playback_test_uses_real_player_path_without_unmuting(service):
    service.vendor_manager = SynthVendor()
    service.player.enqueue_and_wait = lambda *args, **kwargs: True
    result = service.test("playback", "test-session")
    assert result["status"] == "succeeded"
    assert result["playback_started"] is True
    assert result["playback_completed"] is True


def test_external_vendor_cannot_be_restarted(service):
    service.vendor_manager = SynthVendor()
    result = service.restart("vendor")
    assert result["status"] == "not_started"
    assert result["ownership"] == "external"
