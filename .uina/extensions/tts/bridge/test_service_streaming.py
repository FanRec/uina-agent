"""test_service_streaming.py — 端到端交付行为测试（假 Vendor + 假声卡）。

以真实调用路径（admit → worker → sink → feed → 状态/事件）验证：
连续输出、来源 FIFO、取消所有权、失败收束、幂等/未知、封口与设备生命周期。
"""
from __future__ import annotations

import json
import threading
import time

import httpx
import pytest

from _testkit import FakeSink, FakeVendor, _wav_bytes
from lifecycle_handlers import TTSBridgeConfig
from models import DefaultPreset, StreamingConfig, VendorConfig
from service import TTSBridgeService
from synthesis_handlers import (
    BatchTaskStatusRequest,
    CancelTraceRequest,
    SpeakRequest,
    TurnEndRequest,
)


def make_config(*, ref_audio_path=None, **streaming_overrides) -> TTSBridgeConfig:
    streaming = StreamingConfig(
        enabled=True,
        sample_rate=32000,
        warmup_enabled=False,
        fallback_to_batch_on_failure=True,
        **streaming_overrides,
    )
    return TTSBridgeConfig(
        service_name="tts_bridge",
        base_url="http://127.0.0.1:8102",
        host="127.0.0.1",
        port=8102,
        vendor_port=9880,
        startup_timeout_ms=30000,
        request_timeout_ms=120000,
        output_dir=None,  # type: ignore[arg-type]
        playback_enabled=True,
        vendor=VendorConfig(api_style="api_v2", python_executable="python", entry_script=None),  # type: ignore[arg-type]
        preset=DefaultPreset(
            ref_audio_path=ref_audio_path,
            prompt_text="ref",
            prompt_lang="zh",
            text_lang="zh",
            text_split_method="cut5",
            speed_factor=1.0,
            media_type="wav",
        ),
        streaming=streaming,
    )


def make_service(*, vendor=None, sink=None, ref_audio_path=None, **streaming_overrides) -> TTSBridgeService:
    vendor = vendor or FakeVendor()
    sink = sink or FakeSink()
    service = TTSBridgeService(make_config(ref_audio_path=ref_audio_path, **streaming_overrides), vendor_manager=vendor, sink=sink)  # type: ignore[arg-type]
    service.start()
    return service


def speak(trace_id: str, index: int, *, text: str = "句子。", session_id: str | None = None, epoch: str | None = None, **extra) -> SpeakRequest:
    return SpeakRequest(
        trace_id=trace_id,
        segment_id=f"{trace_id}:{index}",
        index=index,
        text=text,
        session_id=session_id,
        epoch=epoch,
        **extra,
    )


def wait_until(predicate, *, timeout_s: float = 5.0, message: str = "condition not met") -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(message)


# ── 连续输出与句段事实 ──────────────────────────────────────────────────


def test_continuous_segments_share_one_stream_without_drain_gaps() -> None:
    service = make_service()
    try:
        service.admit_speak(speak("t1", 1, text="第一句。"))
        service.admit_speak(speak("t1", 2, text="第二句。"))
        service.mark_turn_end(TurnEndRequest(trace_id="t1"))
        wait_until(lambda: service.lane.task_status("t1:1")["status"] == "delivered", message="第一句未播完")
        wait_until(lambda: service.lane.task_status("t1:2")["status"] == "delivered", message="第二句未播完")
        sink = service.sink
        assert isinstance(sink, FakeSink)
        # 两句字节序列连续：总产出 = 两次默认合成的拼接
        assert len(sink.appended_bytes()) == 2 * 32000 * 2
        assert len(sink.open_log()) == 1  # 只打开一次设备
        # 句段在时间线上首尾相接：第二句起点 == 第一句起点 + 第一句帧数
        log = sink.append_log()
        first = [item for item in log if item[0] == "t1:1"]
        second = [item for item in log if item[0] == "t1:2"]
        assert first and second
        first_end = first[0][1] + sum(len(item[2]) for item in first) // 2
        assert second[0][1] == first_end
        # head 排空后释放
        wait_until(lambda: service.lane.head_source() is None, message="head 未释放")
    finally:
        service.close()


def test_fifo_second_source_waits_for_first_completion() -> None:
    service = make_service()
    try:
        slow_started = threading.Event()
        release = threading.Event()

        def slow_first(payload):
            slow_started.set()
            release.wait(timeout=5.0)
            return b"\x01\x00" * 3200

        service.vendor_manager.on_stream("第一句", slow_first)  # type: ignore[attr-defined]
        service.admit_speak(speak("t1", 1, text="第一句。"))
        service.admit_speak(speak("t2", 1, text="乙一。"))
        service.mark_turn_end(TurnEndRequest(trace_id="t1"))
        service.mark_turn_end(TurnEndRequest(trace_id="t2"))
        slow_started.wait(timeout=5.0)
        # t2 已受理但未被合成（t1 仍是 head）
        assert service.lane.task_status("t2:1")["status"] == "accepted"
        release.set()
        wait_until(lambda: service.lane.task_status("t1:1")["status"] == "delivered", message="t1 未播完")
        wait_until(lambda: service.lane.task_status("t2:1")["status"] == "delivered", message="t2 未播完")
        assert isinstance(service.sink, FakeSink)
        # t2 的 PCM 只能出现在 t1 播完之后
        log = service.sink.append_log()
        t1_end = max(start for task_id, start, _ in log if task_id == "t1:1")
        t2_start = min(start for task_id, start, _ in log if task_id == "t2:1")
        assert t2_start >= t1_end
    finally:
        service.close()


def test_cancel_immediate_stops_current_and_later_source_keeps_playing() -> None:
    sink = FakeSink(consume_per_tick=3200, consume_interval_s=0.003)
    vendor = FakeVendor(chunk_delay_s=0.003)
    service = make_service(vendor=vendor, sink=sink)
    try:
        # A：长句（4 秒音频），消费被节流，取消一定发生在播放中
        vendor.on_stream("长句A", lambda payload: b"\x01\x00" * 32000 * 4)  # type: ignore[attr-defined]
        service.admit_speak(speak("tA", 1, text="长句A。"))
        # A 开始真实出声
        wait_until(lambda: sink.played_frames() > 3200, message="A 未开始播放")
        # B 随后受理并在 A 取消后接管
        service.admit_speak(speak("tB", 1, text="B句。"))
        result = service.cancel_trace(CancelTraceRequest(trace_id="tA", mode="immediate"))
        assert result["stop_outcome"] == "stopped"
        assert service.lane.task_status("tA:1")["status"] == "cancelled"
        assert service.lane.get_segment("tA:1").playback == "cancelled"
        wait_until(lambda: service.lane.task_status("tB:1")["status"] == "delivered", message="B 未接管播完", timeout_s=10)
        # B 的音频完整播放，未被 A 的取消截断
        assert len(sink.appended_bytes("tB:1")) == 32000 * 2
        # 迟到的旧来源片段被拒绝
        with pytest.raises(Exception) as late:
            service.admit_speak(speak("tA", 2, text="迟到的句子"))
        assert getattr(late.value, "status_code", None) == 409
    finally:
        service.close()


def test_cancel_of_released_source_is_no_op_and_does_not_touch_new_source() -> None:
    service = make_service()
    try:
        service.admit_speak(speak("tA", 1, text="A句。"))
        service.mark_turn_end(TurnEndRequest(trace_id="tA"))
        wait_until(lambda: service.lane.task_status("tA:1")["status"] == "delivered")
        service.admit_speak(speak("tB", 1, text="B句。"))
        # 旧的 cancel(A)：B 已接管
        result = service.cancel_trace(CancelTraceRequest(trace_id="tA", mode="immediate"))
        assert result["stop_outcome"] == "not_playing"
        wait_until(lambda: service.lane.task_status("tB:1")["status"] == "delivered", message="B 未播完")
        assert isinstance(service.sink, FakeSink)
        assert len(service.sink.appended_bytes("tB:1")) == 32000 * 2
    finally:
        service.close()


def test_vendor_failure_fails_segment_cancels_rest_and_releases_head() -> None:
    service = make_service()
    vendor = service.vendor_manager
    vendor.on_stream("失败句", RuntimeError("controlled vendor failure"))  # type: ignore[attr-defined]
    vendor.on_batch("失败句", RuntimeError("controlled vendor failure"))  # type: ignore[attr-defined]
    try:
        service.admit_speak(speak("tA", 1, text="失败句。"))
        service.admit_speak(speak("tA", 2, text="后续句。"))
        service.admit_speak(speak("tB", 1, text="B句。"))
        wait_until(lambda: service.lane.task_status("tA:1")["status"] == "failed", message="失败未上报")
        wait_until(lambda: service.lane.task_status("tA:2")["status"] == "cancelled", message="后续段未取消")
        wait_until(lambda: service.lane.task_status("tB:1")["status"] == "delivered", message="独立来源未继续")
        head = service.lane.head_source()
        assert head is None or head.id != "tA"
    finally:
        service.close()


def test_batch_fallback_synthesizes_after_stream_failure_before_first_pcm() -> None:
    service = make_service()
    vendor = service.vendor_manager
    vendor.on_stream("回退句", RuntimeError("stream path broken"))  # type: ignore[attr-defined]
    try:
        service.admit_speak(speak("tA", 1, text="回退句。"))
        wait_until(lambda: service.lane.task_status("tA:1")["status"] == "delivered", message="回退未完成", timeout_s=8)
        kinds = [call["kind"] for call in vendor.calls]
        assert "stream" in kinds and "batch" in kinds
    finally:
        service.close()


def test_no_batch_fallback_after_pcm_entered_output_path() -> None:
    service = make_service()
    vendor = service.vendor_manager
    vendor.on_stream_fail_after("中段死亡", b"\x01\x00" * 3200, RuntimeError("vendor died mid-stream"))  # type: ignore[attr-defined]
    try:
        service.admit_speak(speak("tA", 1, text="中段死亡。"))
        wait_until(lambda: service.lane.task_status("tA:1")["status"] == "failed", message="失败未上报")
        assert all(call["kind"] != "batch" for call in vendor.calls)
    finally:
        service.close()


def test_oversized_batch_fallback_splits_writes_and_holds_vendor_lock() -> None:
    """3 秒 WAV 回退（> 2s 有界容量）：拆块写入不突破容量，回退期间 vendor 锁被持有。"""
    sink = FakeSink(consume_per_tick=3200, consume_interval_s=0.002)
    vendor = FakeVendor(chunk_delay_s=0.002)
    service = make_service(vendor=vendor, sink=sink, buffer_seconds=2.0)
    lock_probe: list[bool] = []

    def slow_batch(payload):
        # 回退请求应持有 vendor 锁：此刻锁不可被他人立即取得。
        acquired = service._vendor_lock.acquire(blocking=False)
        lock_probe.append(acquired)
        time.sleep(0.05)
        if acquired:
            service._vendor_lock.release()
        return httpx.Response(200, content=_wav_bytes(b"\x01\x00" * 32000 * 3, 32000))

    vendor.on_stream("回退大句", RuntimeError("stream path broken"))  # type: ignore[attr-defined]
    vendor.on_batch("回退大句", slow_batch)  # type: ignore[attr-defined]
    try:
        service.admit_speak(speak("tA", 1, text="回退大句。"))
        wait_until(lambda: service.lane.task_status("tA:1")["status"] == "delivered", message="大 WAV 回退未完成", timeout_s=15)
        assert lock_probe and lock_probe[0] is False  # 探针拿不到锁：回退持有 vendor 锁
        # 全部 3 秒音频按容量拆块写入，无突破
        assert len(sink.appended_bytes("tA:1")) == 32000 * 3 * 2
        for _task, _start, pcm in sink.append_log():
            assert len(pcm) // 2 <= sink.capacity_frames()
    finally:
        service.close()


def test_cancel_without_takeover_finishes_stale_projection() -> None:
    """播放中取消且无新来源接管：物理投影不得停留在过期 playing 状态。"""
    sink = FakeSink(consume_per_tick=3200, consume_interval_s=0.003)
    vendor = FakeVendor(chunk_delay_s=0.003)
    service = make_service(vendor=vendor, sink=sink)
    try:
        vendor.on_stream("长句B", lambda payload: b"\x01\x00" * 32000 * 4)  # type: ignore[attr-defined]
        service.admit_speak(speak("tB", 1, text="长句B。"))
        wait_until(lambda: sink.played_frames() > 3200, message="未开始播放")
        service.cancel_trace(CancelTraceRequest(trace_id="tB", mode="immediate"))
        wait_until(
            lambda: service.projection.snapshot()["state"] == "idle",
            message="取消后投影未收束",
            timeout_s=5,
        )
    finally:
        service.close()


def test_idempotent_replay_returns_current_status_without_resynthesis() -> None:
    service = make_service()
    try:
        first = service.admit_speak(speak("t1", 1, text="同一句。"))
        replay = service.admit_speak(speak("t1", 1, text="同一句。"))
        assert replay["deduplicated"] is True
        assert replay["status"] in {"accepted", "delivered", "in_progress"}
        wait_until(lambda: service.lane.task_status("t1:1")["status"] == "delivered")
        replay_terminal = service.admit_speak(speak("t1", 1, text="同一句。"))
        assert replay_terminal["status"] == "delivered"
        assert replay_terminal["task_id"] == first["task_id"]
        with pytest.raises(Exception) as conflict:
            service.admit_speak(SpeakRequest(trace_id="t1", segment_id="t1:1", index=1, text="另一句。"))
        assert conflict.value.status_code == 409
    finally:
        service.close()


def test_stale_epoch_and_foreign_session_rejected() -> None:
    service = make_service()
    try:
        epoch = service.lane.reconnect("voice-x")["epoch"]
        service.admit_speak(speak("t1", 1, session_id="voice-x", epoch=epoch, text="一。"))
        with pytest.raises(Exception) as stale:
            service.admit_speak(speak("t1", 2, session_id="voice-x", epoch="stale", text="二。"))
        assert stale.value.status_code == 409
        with pytest.raises(Exception) as foreign:
            service.cancel_trace(CancelTraceRequest(trace_id="t1", session_id="voice-other"))
        assert foreign.value.status_code == 409
    finally:
        service.close()


def test_reset_rotates_epoch_after_confirmed_stop() -> None:
    service = make_service()
    try:
        epoch = service.lane.reconnect("voice-x")["epoch"]
        service.admit_speak(speak("t1", 1, session_id="voice-x", epoch=epoch, text="一。"))
        result = service.reset("voice-x", expected_epoch=epoch)
        assert result["status"] == "reset"
        assert result["epoch"] != epoch
        new_epoch = result["epoch"]
        service.admit_speak(speak("t2", 1, session_id="voice-x", epoch=new_epoch, text="二。"))
        wait_until(lambda: service.lane.task_status("t2:1")["status"] == "delivered", message="新代次未播放")
    finally:
        service.close()


def test_long_queueing_is_not_poisoned_by_age_and_capacity_is_at_admission() -> None:
    sink = FakeSink(consume_per_tick=3200, consume_interval_s=0.002)
    vendor = FakeVendor(chunk_delay_s=0.002)
    service = make_service(vendor=vendor, sink=sink, max_total_pending_segments=16)
    try:
        service.admit_speak(speak("t1", 1, text="慢句。"))
        # 排队大量合法句段：不存在"排队 60s 判失败"的机制
        for index in range(2, 12):
            service.admit_speak(speak("t1", index, text=f"后续{index}。"))
        time.sleep(0.2)
        for index in range(2, 12):
            status = service.lane.task_status(f"t1:{index}")["status"]
            assert status in {"accepted", "in_progress", "delivered"}
        service.mark_turn_end(TurnEndRequest(trace_id="t1", last_segment_index=11))
        for index in range(2, 12):
            wait_until(
                lambda index=index: service.lane.task_status(f"t1:{index}")["status"] == "delivered",
                message=f"第 {index} 段未播完",
                timeout_s=20,
            )
    finally:
        service.close()


def test_subtitle_state_and_task_status_projection() -> None:
    service = make_service()
    try:
        service.admit_speak(speak("t1", 1, text="正在说的句子。"))
        wait_until(lambda: service.lane.task_status("t1:1")["status"] == "delivered")
        state = service.subtitle_state("t1")
        assert state["segments"][0]["text"] == "正在说的句子。"
        assert state["segments"][0]["playback_completed"] is True
        status = service.task_status("t1:1")
        assert status["status"] == "delivered"
        batch = service.batch_task_status(BatchTaskStatusRequest(task_ids=["t1:1", "missing"]))
        assert batch["tasks"][0]["status"] == "delivered"
        assert batch["tasks"][1]["status"] == "not_found"
    finally:
        service.close()


def test_events_publish_once_per_segment_transition() -> None:
    service = make_service()
    try:
        collected: list = []
        iterator = iter(service.playback_events("t1"))
        next(iterator)  # connected

        def pump():
            for chunk in iterator:
                for line in chunk.splitlines():
                    if line.startswith("data: "):
                        collected.append(json.loads(line[6:]))

        pump_thread = threading.Thread(target=pump, daemon=True)
        pump_thread.start()
        service.admit_speak(speak("t1", 1, text="一句。"))
        service.mark_turn_end(TurnEndRequest(trace_id="t1"))
        wait_until(lambda: any(event["kind"] == "completed" for event in collected), message="未收到 completed 事件")
        time.sleep(0.4)
        completed_events = [event for event in collected if event["kind"] == "completed"]
        assert len(completed_events) == 1
        started_events = [event for event in collected if event["kind"] == "playback_started"]
        assert len(started_events) == 1
    finally:
        service.close()


def test_audio_unavailable_rejects_admission_honestly(tmp_path) -> None:
    reference = tmp_path / "ref.wav"
    reference.write_bytes(_wav_bytes(b"\x00\x00" * 320, 32000))
    vendor = FakeVendor()
    sink = FakeSink(ready=False)
    service = TTSBridgeService(make_config(ref_audio_path=reference), vendor_manager=vendor, sink=sink)  # type: ignore[arg-type]
    try:
        service.start()
        with pytest.raises(Exception) as unavailable:
            service.admit_speak(speak("t1", 1, text="一。"))
        assert unavailable.value.status_code == 503
        # 纯生成（无播放）仍然工作
        import asyncio

        audio = asyncio.run(service.generate("生成一句。", timeout_ms=30000))
        assert audio.startswith(b"RIFF")
    finally:
        service.close()


def test_generate_is_pure_synthesis_through_vendor_lock(tmp_path) -> None:
    reference = tmp_path / "ref.wav"
    reference.write_bytes(_wav_bytes(b"\x00\x00" * 320, 32000))
    service = make_service(ref_audio_path=reference)
    try:
        import asyncio

        audio = asyncio.run(service.generate("生成一句。", timeout_ms=30000))
        assert audio.startswith(b"RIFF")
        kinds = [call["kind"] for call in service.vendor_manager.calls]
        assert kinds == ["batch"]
    finally:
        service.close()


def test_idle_sink_is_closed_by_control_thread_after_quiet_period() -> None:
    service = make_service(idle_close_ms=300)
    try:
        service.admit_speak(speak("t1", 1, text="一句。"))
        service.mark_turn_end(TurnEndRequest(trace_id="t1"))
        wait_until(lambda: service.lane.task_status("t1:1")["status"] == "delivered")
        wait_until(lambda: service.lane.head_source() is None, message="head 未释放")
        wait_until(lambda: service.sink.is_open is False, timeout_s=5, message="空闲后未关流")
        # 关流后再来新来源：重新打开并播放
        service.admit_speak(speak("t2", 1, text="新来源。"))
        wait_until(lambda: service.lane.task_status("t2:1")["status"] == "delivered", message="重开后未播放")
        assert isinstance(service.sink, FakeSink)
        assert len(service.sink.open_log()) == 2
    finally:
        service.close()


def test_segment_boundary_cancel_lets_current_segment_finish() -> None:
    sink = FakeSink(consume_per_tick=3200, consume_interval_s=0.003)
    vendor = FakeVendor(chunk_delay_s=0.004)
    service = make_service(vendor=vendor, sink=sink)
    try:
        service.admit_speak(speak("t1", 1, text="边界句。"))
        service.admit_speak(speak("t1", 2, text="取消的后句。"))
        service.mark_turn_end(TurnEndRequest(trace_id="t1"))
        wait_until(lambda: sink.played_frames() > 3200, message="第一段未开始播放")
        result = service.cancel_trace(CancelTraceRequest(trace_id="t1", mode="segment_boundary"))
        assert service.lane.task_status("t1:2")["status"] == "cancelled"
        # 第一段完整到达尾样本
        wait_until(lambda: service.lane.task_status("t1:1")["status"] == "delivered", message="第一段未收束", timeout_s=15)
        assert len(sink.appended_bytes("t1:1")) == 32000 * 2
        wait_until(lambda: service.lane.head_source() is None, message="边界后 head 未释放")
    finally:
        service.close()


def test_playback_test_and_health_report_device_facts() -> None:
    service = make_service()
    try:
        result = service.test("playback", timeout_ms=30000)
        assert result["status"] == "succeeded"
        assert result["playback_completed"] is True
        assert result["path"] == "streaming"
        health = service.health()
        assert health["voice_protocol_version"] == 2
        assert health["player_ready"] is True
        assert health["vendor_ownership"] == "external"
    finally:
        service.close()


def test_playback_test_with_broken_device_reports_failure_without_lie() -> None:
    service = make_service()
    vendor = service.vendor_manager
    vendor.on_stream("语音测试", RuntimeError("controlled vendor failure"))  # type: ignore[attr-defined]
    vendor.on_batch("语音测试", RuntimeError("controlled vendor failure"))  # type: ignore[attr-defined]
    try:
        result = service.test("playback", timeout_ms=30000)
        assert result["status"] == "failed"
        assert result["playback_completed"] is False
    finally:
        service.close()
