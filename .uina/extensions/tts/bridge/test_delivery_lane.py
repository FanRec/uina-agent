"""test_delivery_lane.py — DeliveryLane 单元测试：受理/封口/取消/幂等/FIFO。"""
from __future__ import annotations

import threading

import pytest

from delivery_lane import DeliveryLane
from models import BridgeError, StreamingConfig
from synthesis_handlers import CancelTraceRequest, SpeakRequest, TurnEndRequest


def make_lane(**overrides) -> DeliveryLane:
    config = StreamingConfig(**overrides) if overrides else StreamingConfig()
    return DeliveryLane(config)


def speak(trace_id: str, index: int, *, text: str = "句子。", segment_id: str | None = None,
          session_id: str | None = None, epoch: str | None = None, **extra) -> SpeakRequest:
    return SpeakRequest(
        trace_id=trace_id,
        segment_id=segment_id or f"{trace_id}:{index}",
        index=index,
        text=text,
        session_id=session_id,
        epoch=epoch,
        **extra,
    )


def test_admission_builds_fifo_order_and_requires_contiguous_index() -> None:
    lane = make_lane()
    lane.admit(speak("t1", 1), vendor_text="一")
    lane.admit(speak("t1", 2), vendor_text="二")
    with pytest.raises(BridgeError) as conflict:
        lane.admit(speak("t1", 4, segment_id="t1:9"), vendor_text="跳段")
    assert conflict.value.status_code == 409
    assert "连续" in str(conflict.value.detail)
    # 新来源必须从 1 开始
    with pytest.raises(BridgeError) as fresh:
        lane.admit(speak("t2", 2), vendor_text="x")
    assert fresh.value.status_code == 409


def test_head_source_is_first_admitted_and_blocks_later_sources() -> None:
    lane = make_lane()
    lane.set_sink_ready(True)
    lane.admit(speak("t1", 1), vendor_text="一")
    lane.admit(speak("t2", 1), vendor_text="乙一")
    head = lane.head_source()
    assert head is not None and head.id == "t1"
    # t2 只能在 t1 释放后才成为 head（wait_for_work 只取 head 的片段）
    assert lane.wait_for_work(0)[0].id == "t1"


def test_seal_closes_input_and_releases_empty_or_terminal_head() -> None:
    lane = make_lane()
    lane.admit(speak("t1", 1), vendor_text="一")
    lane.admit(speak("t2", 1), vendor_text="乙一")
    result = lane.seal(TurnEndRequest(trace_id="t1", last_segment_index=1))
    assert result["status"] == "accepted"
    assert result["last_segment_index"] == 1
    # 段还未终结：head 不释放
    assert lane.head_source().id == "t1"
    # 播放完成转换到达后 head 释放
    lane.apply_transition("completed", "t1:1")
    assert lane.head_source().id == "t2"
    # 幂等封口
    again = lane.seal(TurnEndRequest(trace_id="t1"))
    assert again["status"] == "accepted" and again["already_sealed"] is True


def test_seal_is_idempotent_and_rejects_late_segments() -> None:
    lane = make_lane()
    lane.admit(speak("t1", 1), vendor_text="一")
    lane.seal(TurnEndRequest(trace_id="t1"))
    with pytest.raises(BridgeError) as late:
        lane.admit(speak("t1", 2), vendor_text="迟到的句子")
    assert late.value.status_code == 409


def test_out_of_order_index_rejected_without_creating_holes() -> None:
    lane = make_lane()
    lane.admit(speak("t1", 1), vendor_text="一")
    with pytest.raises(BridgeError):
        lane.admit(speak("t1", 3), vendor_text="跳段")
    # 2 仍然可以被受理（空洞没有形成）
    receipt = lane.admit(speak("t1", 2), vendor_text="二")
    assert receipt["segment_index"] == 2


def test_duplicate_segment_id_replays_current_status_and_conflicts_on_different_text() -> None:
    lane = make_lane()
    first = lane.admit(speak("t1", 1, segment_id="dup"), vendor_text="原文")
    assert first["status"] == "accepted"
    replay = lane.admit(speak("t1", 1, segment_id="dup"), vendor_text="原文")
    assert replay["status"] == "accepted" and replay["deduplicated"] is True
    lane.get_segment("dup").playback = "completed"
    replayed_terminal = lane.admit(speak("t1", 1, segment_id="dup"), vendor_text="原文")
    assert replayed_terminal["status"] == "delivered"
    with pytest.raises(BridgeError) as conflict:
        lane.admit(speak("t1", 1, segment_id="dup"), vendor_text="另一段话")
    assert conflict.value.status_code == 409


def test_epoch_validation_and_reset_flow() -> None:
    lane = make_lane()
    session = "voice-s"
    epoch = lane.reconnect(session)["epoch"]
    lane.admit(speak("t1", 1, session_id=session, epoch=epoch), vendor_text="一")
    with pytest.raises(BridgeError):
        lane.admit(speak("t1", 2, session_id=session, epoch="stale"), vendor_text="二")
    with pytest.raises(BridgeError):
        lane.admit(speak("t9", 1, session_id=session), vendor_text="缺少身份")

    def stop_source(trace_id: str, session: str) -> dict:
        result = lane.cancel_source(CancelTraceRequest(trace_id=trace_id, session_id=session, mode="immediate"), played_frame=0, buffered_end_frame=0)
        assert result["stop_outcome"] in {"stopped", "not_playing"}
        return result

    result = lane.reset(session, expected_epoch=epoch, stop_source=stop_source)
    assert result["status"] == "reset"
    new_epoch = result["epoch"]
    assert new_epoch != epoch
    # 新 epoch 可受理；旧 epoch 被拒绝
    lane.admit(speak("t2", 1, session_id=session, epoch=new_epoch), vendor_text="新代次")
    with pytest.raises(BridgeError):
        lane.admit(speak("t3", 1, session_id=session, epoch=epoch), vendor_text="旧代次")
    # 幂等 reset
    again = lane.reset(session, expected_epoch=new_epoch, stop_source=stop_source)
    assert again["status"] == "reset"


def test_reset_refuses_new_epoch_when_stop_unconfirmed() -> None:
    lane = make_lane()
    session = "voice-s"
    epoch = lane.reconnect(session)["epoch"]
    lane.admit(speak("t1", 1, session_id=session, epoch=epoch), vendor_text="一")

    def stop_source(trace_id: str, session: str) -> dict:
        return {"status": "cancelled", "stop_outcome": "unknown"}

    result = lane.reset(session, expected_epoch=epoch, stop_source=stop_source)
    assert result["status"] == "unknown"
    assert result["epoch"] == epoch  # 新 epoch 未启用


def test_cancel_source_immediate_discards_and_reports_stopped() -> None:
    lane = make_lane()
    lane.admit(speak("t1", 1), vendor_text="一")
    lane.admit(speak("t1", 2), vendor_text="二")
    result = lane.cancel_source(
        CancelTraceRequest(trace_id="t1", mode="immediate"),
        played_frame=10,
        buffered_end_frame=100,
    )
    assert result["status"] == "cancelled"
    assert result["stop_outcome"] == "stopped"
    assert result["cancelled_task_count"] == 2
    assert result["discard_from_frame"] == 10
    assert lane.get_segment("t1:1").playback == "cancelled"
    assert lane.get_segment("t1:2").playback == "cancelled"
    # head 释放（input=cancelled + 全部终结）
    assert lane.head_source() is None


def test_cancel_source_boundary_keeps_playing_segment_unknown_until_done() -> None:
    lane = make_lane()
    lane.admit(speak("t1", 1), vendor_text="一")
    playing = lane.get_segment("t1:1")
    playing.playback = "playing"
    lane.admit(speak("t1", 2), vendor_text="二")
    result = lane.cancel_source(
        CancelTraceRequest(trace_id="t1", mode="segment_boundary"),
        played_frame=5,
        buffered_end_frame=100,
    )
    assert result["stop_outcome"] == "unknown"
    assert playing.playback == "playing"  # 当前片段继续到尾样本
    assert lane.get_segment("t1:2").playback == "cancelled"
    lane.apply_transition("completed", "t1:1")
    assert lane.head_source() is None  # 边界到达后 head 释放


def test_cancel_of_completed_trace_is_a_no_op() -> None:
    lane = make_lane()
    lane.admit(speak("t1", 1), vendor_text="一")
    lane.get_segment("t1:1").playback = "completed"
    lane.apply_transition("completed", "t1:1")
    lane.seal(TurnEndRequest(trace_id="t1"))
    result = lane.cancel_source(CancelTraceRequest(trace_id="t1", mode="immediate"), played_frame=999, buffered_end_frame=999)
    assert result["cancelled_task_count"] == 0
    assert result["stop_outcome"] == "not_playing"


def test_cancel_affects_only_its_own_source() -> None:
    lane = make_lane()
    lane.admit(speak("t1", 1), vendor_text="一")
    lane.admit(speak("t2", 1), vendor_text="乙一")
    lane.cancel_source(CancelTraceRequest(trace_id="t1", mode="immediate"), played_frame=0, buffered_end_frame=0)
    assert lane.get_segment("t2:1").playback == "pending"
    assert lane.head_source().id == "t2"


def test_admission_capacity_rejects_before_accepting() -> None:
    lane = make_lane(max_source_pending_segments=2, max_total_pending_segments=3)
    lane.admit(speak("t1", 1), vendor_text="一")
    lane.admit(speak("t1", 2), vendor_text="二")
    with pytest.raises(BridgeError) as full:
        lane.admit(speak("t1", 3), vendor_text="三")
    assert full.value.status_code == 503
    # 未终结的段占用容量，其他来源也被总量拦住
    lane.admit(speak("t2", 1), vendor_text="乙一")
    with pytest.raises(BridgeError):
        lane.admit(speak("t3", 1), vendor_text="丙一")
    # 释放后可以继续
    for task_id in ("t1:1", "t1:2", "t2:1"):
        lane.get_segment(task_id).playback = "completed"
        lane.apply_transition("completed", task_id)
    lane.seal(TurnEndRequest(trace_id="t1"))
    lane.seal(TurnEndRequest(trace_id="t2"))
    lane.admit(speak("t3", 1), vendor_text="丙一")


def test_cancel_event_is_created_for_cancelled_segments() -> None:
    lane = make_lane()
    lane.admit(speak("t1", 1), vendor_text="一")
    event = lane.cancel_event_for("t1:1")
    assert not event.is_set()
    lane.cancel_source(CancelTraceRequest(trace_id="t1", mode="immediate"), played_frame=0, buffered_end_frame=0)
    assert event.is_set()


def test_work_selection_skips_terminal_segments_in_order() -> None:
    lane = make_lane()
    lane.set_sink_ready(True)
    lane.admit(speak("t1", 1), vendor_text="一")
    lane.admit(speak("t1", 2), vendor_text="二")
    lane.admit(speak("t1", 3), vendor_text="三")
    work1 = lane.wait_for_work(0)
    assert work1[1].task_id == "t1:1"
    lane.mark_synthesis_started("t1:1")
    lane.mark_synthesis_finished("t1:1")
    work2 = lane.wait_for_work(0)
    assert work2[1].task_id == "t1:2"
    # 没有 sink 时不给出工作
    lane.set_sink_ready(False)
    assert lane.wait_for_work(0) is None


def test_fail_segment_cancels_rest_and_releases_head() -> None:
    lane = make_lane()
    lane.admit(speak("t1", 1), vendor_text="一")
    lane.admit(speak("t1", 2), vendor_text="二")
    lane.admit(speak("t2", 1), vendor_text="乙一")
    cancelled = lane.fail_segment("t1:1", "vendor exploded", cancel_rest=True)
    assert lane.get_segment("t1:1").playback == "failed"
    assert [segment.task_id for segment in cancelled] == ["t1:2"]
    assert lane.get_segment("t1:2").playback == "cancelled"
    assert lane.head_source().id == "t2"


def test_retention_bounds_terminal_records() -> None:
    lane = make_lane()
    for index in range(1, 12):
        lane.admit(speak(f"t{index}", 1), vendor_text="x")
        segment = lane.get_segment(f"t{index}:1")
        segment.playback = "completed"
        segment.terminal_at = 0.0
        lane.apply_transition("completed", f"t{index}:1")
        lane.seal(TurnEndRequest(trace_id=f"t{index}"))
    lane.retention(ttl_seconds=0, max_tasks=5)
    assert len(lane._tasks) <= 5  # noqa: SLF001 - 单元测试直接检查内部界
