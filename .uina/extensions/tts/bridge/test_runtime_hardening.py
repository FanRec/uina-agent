"""test_runtime_hardening.py — 生命周期与运维边界测试（新架构）。"""
from __future__ import annotations

import time

import pytest

from _testkit import FakeSink, FakeVendor, _wav_bytes
from lifecycle_handlers import TTSBridgeConfig
from models import DefaultPreset, StreamingConfig, VendorConfig
from playback_feed import PlaybackEventHub
from service import TTSBridgeService
from synthesis_handlers import SpeakRequest


def make_service(*, vendor=None, sink=None, ref_audio_path=None, **streaming_overrides) -> TTSBridgeService:
    vendor = vendor or FakeVendor()
    sink = sink or FakeSink()
    config = TTSBridgeConfig(
        service_name="test",
        base_url="http://127.0.0.1:0",
        host="127.0.0.1",
        port=0,
        vendor_port=0,
        startup_timeout_ms=1000,
        request_timeout_ms=1000,
        output_dir=None,  # type: ignore[arg-type]
        playback_enabled=True,
        vendor=VendorConfig(api_style="api_v2", python_executable="unused", entry_script=None),  # type: ignore[arg-type]
        preset=DefaultPreset(
            ref_audio_path=ref_audio_path,
            prompt_text="ref",
            prompt_lang="zh",
            text_lang="zh",
            text_split_method="cut5",
            speed_factor=1.0,
            media_type="wav",
        ),
        streaming=StreamingConfig(**{"enabled": True, "warmup_enabled": False, **streaming_overrides}),
    )
    return TTSBridgeService(config, vendor_manager=vendor, sink=sink)  # type: ignore[arg-type]


def speak(trace_id: str, index: int, *, text: str = "句子。") -> SpeakRequest:
    return SpeakRequest(trace_id=trace_id, segment_id=f"{trace_id}:{index}", index=index, text=text)


def test_closed_event_hub_cannot_be_reopened_by_subscribe():
    hub = PlaybackEventHub()
    hub.close()
    stream = hub.stream("*")
    with pytest.raises(StopIteration):
        next(iter(stream))


def test_close_marks_pending_delivery_terminal_and_stops_threads(tmp_path):
    reference = tmp_path / "ref.wav"
    reference.write_bytes(_wav_bytes(b"\x00\x00" * 320, 32000))
    sink = FakeSink(consume_per_tick=3200, consume_interval_s=0.02)
    vendor = FakeVendor(chunk_delay_s=0.02)
    service = make_service(vendor=vendor, sink=sink, ref_audio_path=reference)
    service.start()
    service.admit_speak(speak("t1", 1, text="慢句。"))
    time.sleep(0.05)
    service.close()
    status = service.lane.task_status("t1:1")["status"]
    assert status in {"cancelled", "delivered"}
    assert service.lane.head_source() is None
    # close 后再次 close 是幂等 no-op
    service.close()
    assert service._closing.is_set()


def test_external_vendor_cannot_be_restarted():
    vendor = FakeVendor()
    vendor.ownership = "external"
    service = make_service(vendor=vendor)
    result = service.restart("vendor")
    assert result["status"] == "not_started"
    assert "不是当前 Bridge 明确拥有" in result["reason"]


def test_warmup_skips_when_vendor_busy_and_reports_status(tmp_path):
    reference = tmp_path / "ref.wav"
    reference.write_bytes(_wav_bytes(b"\x00\x00" * 320, 32000))
    service = make_service(ref_audio_path=reference, warmup_enabled=True, warmup_text="嗯。")
    # 预热锁被真实讲话持有：best-effort 跳过，不阻塞
    service._vendor_lock.acquire()
    try:
        service._warmup_vendor_best_effort()
        assert service._warmup_status["status"] == "skipped"
        assert service._warmup_status["reason"] == "vendor_busy"
    finally:
        service._vendor_lock.release()
    service.close()


def test_admission_after_close_is_refused():
    vendor = FakeVendor()
    sink = FakeSink()
    service = make_service(vendor=vendor, sink=sink)
    service.start()
    service.close()
    with pytest.raises(Exception) as refused:
        service.admit_speak(speak("t1", 1))
    assert refused.value.status_code == 503


def test_retention_bounds_terminal_tasks():
    service = make_service()
    try:
        for index in range(1, 12):
            service.admit_speak(speak(f"t{index}", 1))
        # 模拟全部终结并到期
        for index in range(1, 12):
            segment = service.lane.get_segment(f"t{index}:1")
            segment.playback = "completed"
            segment.terminal_at = time.time() - 7200
            service.lane.apply_transition("completed", f"t{index}:1")
        service.lane.retention(ttl_seconds=3600, max_tasks=5)
        assert len(service.lane._tasks) <= 5  # noqa: SLF001 - 直接验证有界保留
        for index in range(1, 12):
            assert service.lane.task_status(f"t{index}:1")["status"] == "not_found"
    finally:
        service.close()
