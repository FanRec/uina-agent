from __future__ import annotations

from audio_playback import AudioPlayback


def test_mirror_device_created_and_feed_forwarded() -> None:
    player = AudioPlayback(mirror_device="CABLE Input (VB-Audio Virtual Cable)")

    assert player._mirror is not None
    assert player._mirror._device == "CABLE Input (VB-Audio Virtual Cable)"
    assert player._mirror._mirror is None

    player._streaming = True
    player._mirror._streaming = True
    player.feed(b"\x01\x00" * 8)

    assert player._mirror._available_bytes_locked() == 16


def test_audio_callback_consumes_buffer_without_early_rebuffer() -> None:
    player = AudioPlayback()
    player._streaming = True
    player._stream_finished = False
    player._playback_started = True
    player._prebuffer_bytes = 20
    player._rebuffer_resume_bytes = 20
    player._low_water_bytes = 20
    player._buffer.extend(b"abcdefgh")

    out = bytearray(4)
    player._audio_callback(out, 2, None, None)

    assert bytes(out) == b"abcd"
    assert player._available_bytes_locked() == 4
    assert player.stream_stats()["buffered_bytes"] == 4
    assert player.stream_stats()["rebuffer_count"] == 0


def test_audio_callback_rebuffers_only_when_next_period_cannot_be_filled() -> None:
    player = AudioPlayback()
    player._streaming = True
    player._stream_finished = False
    player._playback_started = True
    player._prebuffer_bytes = 20
    player._rebuffer_resume_bytes = 20
    player._buffer.extend(b"ab")

    out = bytearray(b"xxxx")
    player._audio_callback(out, 2, None, None)

    assert bytes(out) == b"\x00\x00\x00\x00"
    assert player._available_bytes_locked() == 2
    assert player.stream_stats()["rebuffer_count"] == 1
    assert player.stream_stats()["underrun_count"] == 1


def test_start_stream_uses_rebuffer_threshold_for_resume() -> None:
    player = AudioPlayback()
    player.start_stream(sample_rate=1000, channels=1, prebuffer_ms=20, rebuffer_ms=80)

    assert player._prebuffer_bytes == 40  # 20ms * 1000Hz * 1ch * 2 bytes
    assert player._rebuffer_bytes == 160  # 80ms * 1000Hz * 1ch * 2 bytes
    assert player._rebuffer_resume_bytes == player._prebuffer_bytes

    player._playback_started = True
    player._streaming = True
    player._stream_finished = False
    player._rebuffering = True
    player._buffer.clear()
    player._read_pos = 0
    # Enough for prebuffer, not enough for rebuffer resume.
    player._buffer.extend(b"\x01" * 40)

    out = bytearray(4)
    player._audio_callback(out, 2, None, None)

    assert player._rebuffering is False
    assert bytes(out) == b"\x01\x01\x01\x01"

    player.stop_stream()


def _pcm_from_amplitude(amplitude: float, count: int) -> bytes:
    value = int(round(32767 * amplitude))
    return b"".join(value.to_bytes(2, "little", signed=True) for _ in range(count))


def test_measure_pcm_level_matches_analytic_rms() -> None:
    import math

    from audio_playback import measure_pcm_level

    # 振幅 0.5 满量程的正弦：RMS 理论值 0.5/sqrt(2) ≈ 0.3536
    samples = [int(round(16384 * math.sin(2 * math.pi * i / 256))) for i in range(256)]
    pcm = b"".join(s.to_bytes(2, "little", signed=True) for s in samples)

    rms, peak = measure_pcm_level(pcm)

    assert abs(rms - 0.5 / math.sqrt(2)) < 0.01
    assert abs(peak - 0.5) < 0.01


def test_measure_pcm_level_degrades_instead_of_raising() -> None:
    from audio_playback import measure_pcm_level

    assert measure_pcm_level(b"\x00\x00" * 64) == (0.0, 0.0)
    assert measure_pcm_level(b"") == (0.0, 0.0)
    # 奇数字节长度无法 cast 成 16-bit：必须退化为 0，绝不允许测量异常影响发声
    assert measure_pcm_level(b"\x01\x02\x03") == (0.0, 0.0)


def test_feed_updates_level_and_progress_snapshot_carries_it() -> None:
    from audio_playback import AudioPlayback

    player = AudioPlayback()
    player._streaming = True
    player._stream_channels = 1
    player._stream_sample_rate = 32000

    player.feed(_pcm_from_amplitude(0.5, 64))
    snapshot = player.progress_snapshot(duration_ms=1000)
    assert abs(snapshot.rms - 0.5) < 0.02
    assert abs(snapshot.peak - 0.5) < 0.02

    # 停流必须清零：否则下一段音频的起始口型会先张开
    player.stop_stream()
    assert player.progress_snapshot(duration_ms=1000).rms == 0.0
    assert player.progress_snapshot(duration_ms=1000).peak == 0.0
