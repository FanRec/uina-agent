"""test_audio_sink.py — AudioSink 实时回调与时间线行为测试。

直接驱动 `_audio_callback`（不依赖 sounddevice），验证：
跨句段连续输出、欠载补静音不推进有效位置、转换一次性、
取消后迟到写入被拒绝、冷启动预热静音只出现一次。
所有断言以字节为单位（int16 单声道 = 2 字节/帧）。
"""
from __future__ import annotations

import pytest

from audio_playback import AudioSink, StreamResampler, measure_pcm_level


class TimeInfo:
    def __init__(self, current: float, dac: float) -> None:
        self.currentTime = current
        self.outputBufferDacTime = dac


class OutBuffer:
    """bytearray 兼容 outdata 的最小可写视图。"""

    def __init__(self, size: int) -> None:
        self.data = bytearray(size)

    def __len__(self) -> int:
        return len(self.data)

    def __getitem__(self, item):
        return self.data[item]

    def __setitem__(self, item, value):
        self.data[item] = value


def make_sink(**overrides) -> AudioSink:
    sink = AudioSink(
        start_prebuffer_ms=overrides.pop("start_prebuffer_ms", 0),
        resume_min_ms=overrides.pop("resume_min_ms", 0),
        priming_ms=overrides.pop("priming_ms", 0),
        buffer_seconds=overrides.pop("buffer_seconds", 1.0),
        **overrides,
    )
    # 不经过设备线程：直接模拟"已打开"的流状态。
    with sink._lock:
        sink._sample_rate = 32000
        sink._channels = 1
        sink._streaming = True
        sink._start_prebuffer_frames = 0
        sink._resume_min_frames = 0
        sink._max_buffer_frames = 32000  # 1 秒
        sink._priming = bytearray()
    return sink


def run_callback(sink: AudioSink, frames: int, *, dac_ahead_ms: float = 5.0) -> OutBuffer:
    out = OutBuffer(frames * 2)
    now = 1000.0
    sink._audio_callback(out, frames, TimeInfo(now, now + dac_ahead_ms / 1000), None)
    return out


def pcm(seconds: float, value: int = 100) -> bytes:
    """int16 单声道 PCM：seconds 秒 @32kHz，恒定幅值。"""
    sample = value.to_bytes(2, "little", signed=True)
    return sample * int(32000 * seconds)


def test_segments_flow_continuously_across_one_callback() -> None:
    sink = make_sink()
    h1 = sink.register_segment(trace_id="t1", index=1, task_id="t1:1")
    sink.append(h1, pcm(0.5, value=1000))
    sink.finalize_segment(h1)
    h2 = sink.register_segment(trace_id="t1", index=2, task_id="t1:2")
    sink.append(h2, pcm(0.5, value=2000))
    sink.finalize_segment(h2)
    # 一次回调跨过两句段：先完成旧段，再开始新段
    out = run_callback(sink, 32000)
    transitions = sink.take_transitions()
    assert [t.kind for t in transitions] == ["started", "completed", "started", "completed"]
    assert [t.task_id for t in transitions] == ["t1:1", "t1:1", "t1:2", "t1:2"]
    # 输出字节与两句段串接完全一致（无插入静音）
    assert bytes(out.data[:32000]) == pcm(0.5, value=1000)
    assert bytes(out.data[32000:64000]) == pcm(0.5, value=2000)
    assert sink.played_frames() == 32000


def test_underrun_inserts_silence_without_advancing_valid_frames() -> None:
    sink = make_sink()
    sink.set_active(True)
    h1 = sink.register_segment(trace_id="t1", index=1, task_id="t1:1")
    sink.append(h1, pcm(0.25, value=1000))
    sink.finalize_segment(h1)
    # 消费一半（8000 字节 = 4000 帧），再消费剩余一半
    out = run_callback(sink, 4000)
    assert bytes(out.data[:8000]) == pcm(0.25, value=1000)[:8000]
    assert sink.played_frames() == 4000
    out = run_callback(sink, 4000)
    assert bytes(out.data[:8000]) == pcm(0.25, value=1000)[8000:16000]
    assert sink.played_frames() == 8000
    # 缓冲已空且仍在交付中：补静音、欠载计一次、有效位置不推进
    out = run_callback(sink, 4000)
    assert out.data == bytearray(8000)
    assert sink.played_frames() == 8000
    assert sink.underruns == 1
    # 后续新数据恰好播放一次
    h2 = sink.register_segment(trace_id="t1", index=2, task_id="t1:2")
    sink.append(h2, pcm(0.1, value=3000))
    sink.finalize_segment(h2)
    out = run_callback(sink, 4000)
    assert bytes(out.data[:6400]) == pcm(0.1, value=3000)
    assert sink.played_frames() == 11200


def test_started_fires_once_per_segment() -> None:
    sink = make_sink()
    h1 = sink.register_segment(trace_id="t1", index=1, task_id="t1:1")
    sink.append(h1, pcm(0.1, value=500))
    sink.finalize_segment(h1)
    out = run_callback(sink, 3200)
    kinds = [t.kind for t in sink.take_transitions()]
    assert kinds == ["started", "completed"]
    assert bytes(out.data[:6400]) == pcm(0.1, value=500)


def test_cancelled_segment_rejects_late_writes_and_next_segment_can_register() -> None:
    sink = make_sink()
    h1 = sink.register_segment(trace_id="tA", index=1, task_id="tA:1")
    sink.append(h1, pcm(0.25, value=1000))
    # 取消：从当前播放位置丢弃（模拟 immediate，缓冲里全部未播）
    sink.discard_unplayed_from(sink.played_frames(), drop_straddler=True)
    with pytest.raises(RuntimeError, match="discarded"):
        sink.append(h1, pcm(0.1))
    # 后续来源在同一时间线上正常登记与写入
    h2 = sink.register_segment(trace_id="tB", index=1, task_id="tB:1")
    sink.append(h2, pcm(0.1, value=3000))
    sink.finalize_segment(h2)
    out = run_callback(sink, 3200)
    assert bytes(out.data[:6400]) == pcm(0.1, value=3000)
    transitions = sink.take_transitions()
    assert [t.task_id for t in transitions] == ["tB:1", "tB:1"]
    assert [t.kind for t in transitions] == ["started", "completed"]
    assert sink.played_frames() == 3200


def test_boundary_discard_keeps_straddling_segment_writable() -> None:
    sink = make_sink()
    h1 = sink.register_segment(trace_id="t1", index=1, task_id="t1:1")
    sink.append(h1, pcm(0.5, value=1000))
    h2 = sink.register_segment(trace_id="t1", index=2, task_id="t1:2")
    sink.append(h2, pcm(0.5, value=2000))
    end1 = h1.end_frame
    # 边界取消：从第一段终点丢弃后续，第一段仍可继续写入
    dropped = sink.discard_unplayed_from(end1, drop_straddler=False)
    assert dropped > 0
    assert h2.dropped is True
    with pytest.raises(RuntimeError, match="discarded"):
        sink.append(h2, pcm(0.1))
    # 第一段继续合成：追加与 finalize 正常
    sink.append(h1, pcm(0.1, value=1500))
    sink.finalize_segment(h1)
    run_callback(sink, 32000)
    transitions = sink.take_transitions()
    assert [t.task_id for t in transitions] == ["t1:1", "t1:1"]
    assert sink.played_frames() == end1 + 3200


def test_buffer_capacity_is_bounded_and_backpressure_wait_returns() -> None:
    sink = make_sink(buffer_seconds=0.5)
    h1 = sink.register_segment(trace_id="t1", index=1, task_id="t1:1")
    with sink._lock:
        sink._max_buffer_frames = 15000
    sink.append(h1, pcm(0.4, value=1000))
    assert sink.buffered_frames() == 12800
    # 已满：wait_for_capacity 立即返回 False
    assert sink.wait_for_capacity(3200, timeout=0.01) is False
    # 消费后有空间
    run_callback(sink, 6400)
    assert sink.wait_for_capacity(3200, timeout=0.1) is True


def test_priming_silence_only_once_and_does_not_advance_valid_frames() -> None:
    sink = make_sink()
    with sink._lock:
        sink._priming = bytearray(3200)  # 50ms 的预热静音（3200 字节）
        sink._streaming = True
    h1 = sink.register_segment(trace_id="t1", index=1, task_id="t1:1")
    sink.append(h1, pcm(0.2, value=1000))
    sink.finalize_segment(h1)
    # 第一次回调：预热静音在前，有效位置只统计真实样本
    out = run_callback(sink, 6400)
    assert out.data[:3200] == bytearray(3200)
    assert bytes(out.data[3200:12800]) == pcm(0.2, value=1000)[:9600]
    assert sink.played_frames() == 4800
    # 第二次回调：预热已耗尽，不再出现；剩余真实样本 + 欠载静音
    out2 = run_callback(sink, 6400)
    assert bytes(out2.data[:3200]) == pcm(0.2, value=1000)[9600:12800]
    assert out2.data[3200:] == bytearray(9600)
    assert sink.played_frames() == 6400


def test_measure_pcm_level_matches_analytic_rms() -> None:
    amplitude = 16384
    samples = [amplitude if i % 2 == 0 else -amplitude for i in range(3200)]
    pcm_bytes = b"".join(sample.to_bytes(2, "little", signed=True) for sample in samples)
    rms, peak = measure_pcm_level(pcm_bytes)
    assert peak == pytest.approx(amplitude / 32768, abs=1e-6)
    assert rms == pytest.approx(amplitude / 32768, abs=1e-6)
    assert measure_pcm_level(b"") == (0.0, 0.0)


def test_stream_resampler_keeps_continuity_and_rate() -> None:
    resampler = StreamResampler(32000, 48000)
    # 1 秒恒定非零信号（32000 样本），分两块喂入
    input_pcm = (b"\x10\x28") * 32000  # 0x2810 = 10256
    first = resampler.resample(input_pcm[:32000])
    second = resampler.resample(input_pcm[32000:], final=True)
    out = first + second
    assert len(out) // 2 == 48000
    samples = [int.from_bytes(out[i:i + 2], "little", signed=True) for i in range(0, len(out), 2)]
    assert all(value == 10256 for value in samples)


def test_sink_snapshot_reports_dac_quality_and_buffer() -> None:
    sink = make_sink()
    h1 = sink.register_segment(trace_id="t1", index=1, task_id="t1:1")
    sink.append(h1, pcm(0.5, value=1000))
    snapshot = sink.snapshot(duration_ms=500)
    assert snapshot.buffered_ms == pytest.approx(500.0, abs=1.0)
    assert snapshot.playback_started is False
    run_callback(sink, 16000)
    snapshot = sink.snapshot(duration_ms=500)
    assert snapshot.playback_started is True
    assert snapshot.clock_quality == "dac"
    assert 0 < snapshot.played_frames <= 16000


def test_close_discards_pending_and_stops_callbacks() -> None:
    sink = make_sink()
    h1 = sink.register_segment(trace_id="t1", index=1, task_id="t1:1")
    sink.append(h1, pcm(0.5, value=1000))
    sink.close()
    assert sink.is_open is False
    with sink._lock:
        sink._streaming = True  # 模拟回调仍被设备驱动的瞬间
    out = run_callback(sink, 3200)
    assert out.data == bytearray(6400)  # 关闭后回调只写静音
    assert sink.played_frames() == 0
