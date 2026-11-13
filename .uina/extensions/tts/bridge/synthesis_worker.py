"""synthesis_worker.py — 唯一的合成执行者。

单线程消费 DeliveryLane 队首来源的下一个待合成片段：
- 一次只允许一个 Vendor 推理请求（与 generate/warmup 共享一把 vendor 锁）；
- PCM 按产出顺序写入 AudioSink 的同一条时间线，与播放并行；
- 有界背压：缓冲满时等待消费，等待不是失败，取消立即解除等待；
- 失败收束：尚无 PCM 进入输出路径时允许一次明确的非流式回退；
  已开始播放后绝不从头重合成，避免重复半句话。
"""
from __future__ import annotations

import io
import threading
import time
import wave
from typing import Any, Callable

from audio_playback import AudioSink, StreamResampler, wav_metadata
from delivery_lane import DeliveryLane
from models import DefaultPreset, Segment, Source, StreamingConfig, StreamingProfile
from playback_feed import PlaybackEventHub
from synthesis_handlers import _log_latency, _vendor_text_lang_for


class _SegmentCancelled(Exception):
    pass


def _wav_pcm_bytes(audio_bytes: bytes) -> bytes | None:
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
            return wav_file.readframes(wav_file.getnframes())
    except wave.Error:
        return None


class _WriteState:
    """单个片段的写入状态：sink 句柄、lipsync 流、首个 PCM 时刻。"""

    def __init__(self) -> None:
        self.handle: Any = None
        self.lipsync_started = False
        self.first_chunk_at: float | None = None
        self.chunk_count = 0
        self.total_bytes = 0


class SynthesisWorker(threading.Thread):
    def __init__(
        self,
        *,
        lane: DeliveryLane,
        sink: AudioSink,
        vendor: Any,
        config: StreamingConfig,
        preset: DefaultPreset,
        hub: PlaybackEventHub,
        vendor_lock: threading.Lock,
        profile_for: Callable[[Segment], StreamingProfile],
        fallback_to_batch: bool,
        lipsync: Any = None,
        poll_interval: float = 0.25,
        startup_timeout_ms: int = 30000,
    ) -> None:
        super().__init__(name="tts-synthesis-worker", daemon=True)
        self.lane = lane
        self.sink = sink
        self.vendor = vendor
        self.config = config
        self.preset = preset
        self.hub = hub
        self.vendor_lock = vendor_lock
        self.profile_for = profile_for
        self.fallback_to_batch = fallback_to_batch
        self.lipsync = lipsync
        self.poll_interval = poll_interval
        self.startup_timeout_ms = startup_timeout_ms
        self._stop_requested = threading.Event()

    def stop_worker(self) -> None:
        self._stop_requested.set()
        with self.lane.condition:
            self.lane.condition.notify_all()

    def run(self) -> None:
        while not self._stop_requested.is_set():
            work = self.lane.wait_for_work(self.poll_interval)
            if work is None:
                continue
            source, segment = work
            try:
                self._synthesize(source, segment)
            except Exception as exc:  # pragma: no cover - 兜底：正常失败路径在内部收束
                self._fail(source, segment, f"synthesis worker error: {type(exc).__name__}: {exc}")

    # ── 单个片段 ────────────────────────────────────────────────────────

    def _synthesize(self, source: Source, segment: Segment) -> None:
        task_id = segment.task_id
        profile = self.profile_for(segment)
        self.lane.mark_synthesis_started(task_id)
        self.hub.publish(
            "synthesizing",
            trace_id=source.id,
            generation_id=source.generation_id,
            segment_index=segment.index,
            task_id=task_id,
            detail={
                "stream_profile": profile.label,
                "vendor_streaming_mode": profile.vendor_streaming_mode,
                "min_chunk_length": profile.min_chunk_length,
                "fragment_interval": profile.fragment_interval,
            },
        )
        started_at = time.perf_counter()
        queue_wait_ms = round((time.time() - segment.accepted_at) * 1000, 2) if segment.accepted_at else None
        _log_latency(source.id, task_id, "synthesis_started", queue_wait_ms=queue_wait_ms, stream_profile=profile.label)
        cancel = self.lane.cancel_event_for(task_id)
        state = _WriteState()
        try:
            # Vendor 进程归属本 Bridge 时负责拉起与等待就绪；外部 Vendor 不做管理。
            if not self.vendor.ready():
                self.vendor.ensure_running()
                if not self.vendor.wait_until_ready(self.startup_timeout_ms):
                    raise RuntimeError("vendor tts is not ready")
            if not self.vendor_lock.acquire(timeout=self.config.stall_timeout_ms / 1000):
                raise RuntimeError("vendor is busy with another synthesis")
            try:
                payload = self._stream_payload(segment.text, profile)
                stream = self.vendor.synthesize_stream(
                    payload,
                    timeout_ms=self.config.stream_total_timeout_ms,
                    idle_timeout_ms=self.config.stream_idle_timeout_ms,
                    total_timeout_ms=self.config.stream_total_timeout_ms,
                    cancel_event=cancel,
                )
                for chunk in stream:
                    if cancel.is_set():
                        raise _SegmentCancelled()
                    self._write_pcm(source, segment, chunk, cancel, state)
                if cancel.is_set():
                    raise _SegmentCancelled()
                if state.total_bytes == 0:
                    raise RuntimeError("tts vendor returned empty audio")
            finally:
                self.vendor_lock.release()
            self.sink.finalize_segment(state.handle)
            self.lane.mark_synthesis_finished(task_id)
            if state.lipsync_started and self.lipsync is not None:
                self.lipsync.stream_finish_async(task_id=task_id)
            _log_latency(
                source.id,
                task_id,
                "synthesis_finished",
                synthesis_ms=round((time.perf_counter() - started_at) * 1000, 2),
                first_chunk_ms=round((state.first_chunk_at - started_at) * 1000, 2) if state.first_chunk_at else None,
                chunk_count=state.chunk_count,
                total_bytes=state.total_bytes,
            )
        except _SegmentCancelled:
            # 物理残留已由取消方在同一锁事务内丢弃（lane.discard_hook）；
            # 这里不能再丢弃一次，否则可能误删后续来源刚登记的区间。
            return
        except Exception as exc:
            # 尚无 PCM 进入输出路径：允许一次明确的非流式回退；已开始后绝不重合成。
            if (
                self.fallback_to_batch
                and state.handle is None
                and not cancel.is_set()
                and not self._stop_requested.is_set()
            ):
                try:
                    self._batch_fallback(source, segment, cancel)
                    return
                except Exception as fallback_exc:
                    exc = fallback_exc
            self._fail(source, segment, f"{type(exc).__name__}: {exc}")

    def _write_pcm(self, source: Source, segment: Segment, data: bytes, cancel: threading.Event, state: _WriteState) -> int:
        """把 PCM 拆帧写入 sink，遵守有界容量；返回写入帧数。

        正常背压等待不消耗失败预算；只有输出端持续无消费（设备卡死）
        超过 stall 上限才判定失败。
        """
        frame_bytes = 2  # int16 mono
        written = 0
        offset = 0
        while offset < len(data):
            if cancel.is_set():
                raise _SegmentCancelled()
            buffered = self.sink.buffered_frames()
            room = self.sink.capacity_frames() - buffered
            if room <= 0:
                self._wait_for_consumption(cancel)
                continue
            piece_frames = (len(data) - offset - (len(data) - offset) % frame_bytes) // frame_bytes
            take_frames = min(piece_frames, room)
            take_bytes = take_frames * frame_bytes
            piece = data[offset:offset + take_bytes]
            if not piece:
                break
            if state.handle is None:
                # 登记与活性检查在同一锁事务内：取消方持同一锁标记终局，
                # 因此登记要么发生在取消前（其数据随后被丢弃并拒绝写入），
                # 要么看到终局直接放弃，不会产生取消后的新区间。
                with self.lane.condition:
                    if cancel.is_set() or segment.terminal:
                        raise _SegmentCancelled()
                    state.handle = self.sink.register_segment(trace_id=source.id, index=segment.index, task_id=segment.task_id)
                    self.lane.record_pcm_start(segment.task_id, state.handle.start_frame)
                if self.lipsync is not None:
                    self.lipsync.stream_start_async(
                        trace_id=source.id,
                        generation_id=source.generation_id,
                        segment_index=segment.index,
                        task_id=segment.task_id,
                        text=segment.original_text,
                        sample_rate=self.config.sample_rate,
                        duration_ms=0,
                    )
                    state.lipsync_started = True
                if state.first_chunk_at is None:
                    state.first_chunk_at = time.perf_counter()
                    _log_latency(source.id, segment.task_id, "vendor_first_pcm", total_bytes=take_bytes)
            try:
                self.sink.append(state.handle, piece)
            except RuntimeError:
                # 句段已被取消/收束并从时间线移除：迟到数据绝不入线。
                raise _SegmentCancelled() from None
            frames = len(piece) // frame_bytes
            self.lane.record_pcm_progress(segment.task_id, frames)
            if state.lipsync_started and self.lipsync is not None:
                self.lipsync.stream_chunk_async(task_id=segment.task_id, chunk=piece)
            state.chunk_count += 1
            state.total_bytes += len(piece)
            written += frames
            offset += take_bytes
        return written

    def _wait_for_consumption(self, cancel: threading.Event) -> None:
        """等待播放端消费腾出容量；输出端停滞超限时判定失败。"""
        stall_started = time.perf_counter()
        last_buffered = self.sink.buffered_frames()
        while not self.sink.wait_for_capacity(1, timeout=self.poll_interval):
            if cancel.is_set():
                raise _SegmentCancelled()
            buffered = self.sink.buffered_frames()
            if buffered != last_buffered:
                last_buffered = buffered
                stall_started = time.perf_counter()
            elif time.perf_counter() - stall_started > self.config.stall_timeout_ms / 1000:
                raise RuntimeError(
                    f"audio output stopped consuming for {self.config.stall_timeout_ms}ms (device stalled)"
                )

    def _batch_fallback(self, source: Source, segment: Segment, cancel: threading.Event) -> None:
        """非流式回退：完整合成 WAV，解码为 PCM 后拆块写入同一条时间线。

        与实时讲话共用唯一 Vendor 入口（vendor 锁），不绕过串行所有权。
        """
        payload = self._batch_payload(segment.text)
        if not self.vendor_lock.acquire(timeout=self.config.stall_timeout_ms / 1000):
            raise RuntimeError("vendor is busy with another synthesis")
        try:
            response = self.vendor.synthesize(payload, timeout_ms=self.config.stream_total_timeout_ms)
        finally:
            self.vendor_lock.release()
        if response.status_code != 200:
            raise RuntimeError(f"tts vendor fallback returned {response.status_code}: {response.text[:200]}")
        if cancel.is_set():
            raise _SegmentCancelled()
        duration_ms, sample_rate = wav_metadata(response.content)
        if not duration_ms or not sample_rate:
            raise RuntimeError("tts vendor fallback returned invalid WAV")
        pcm = _wav_pcm_bytes(response.content)
        if not pcm:
            raise RuntimeError("tts vendor fallback WAV has no data chunk")
        if sample_rate != self.config.sample_rate:
            pcm = StreamResampler(sample_rate, self.config.sample_rate).resample(pcm, final=True)
        state = _WriteState()
        self._write_pcm(source, segment, pcm, cancel, state)
        self.sink.finalize_segment(state.handle)
        self.lane.mark_synthesis_finished(segment.task_id)
        if state.lipsync_started and self.lipsync is not None:
            self.lipsync.stream_finish_async(task_id=segment.task_id)
        _log_latency(source.id, segment.task_id, "batch_fallback", duration_ms=duration_ms, sample_rate=sample_rate)

    def _fail(self, source: Source, segment: Segment, error: str) -> None:
        self._discard_unplayed(segment)
        cancelled = self.lane.fail_segment(segment.task_id, error, cancel_rest=True)
        self.hub.publish(
            "failed",
            trace_id=source.id,
            generation_id=source.generation_id,
            segment_index=segment.index,
            task_id=segment.task_id,
            detail={"error": error, "playback_started": segment.playback_started_at is not None},
        )
        for other in cancelled:
            self.hub.publish(
                "cancelled",
                trace_id=source.id,
                generation_id=source.generation_id,
                segment_index=other.index,
                task_id=other.task_id,
                detail={"reason": "source_failed"},
            )
        print(f"[TTS] segment failed trace={source.id} index={segment.index}: {error}", flush=True)

    def _discard_unplayed(self, segment: Segment) -> None:
        """丢弃该片段未播的垃圾 PCM；已进入输出的部分保留事实。"""
        if segment.pcm_start_frame is None:
            return
        played = self.sink.played_frames()
        self.sink.discard_unplayed_from(max(segment.pcm_start_frame, played))

    def _stream_payload(self, text: str, profile: StreamingProfile) -> dict[str, Any]:
        return {
            "text": text,
            "text_lang": _vendor_text_lang_for(text),
            "ref_audio_path": str(self.preset.ref_audio_path),
            "prompt_text": self.preset.prompt_text,
            "prompt_lang": self.preset.prompt_lang,
            "text_split_method": self.preset.text_split_method,
            "speed_factor": self.preset.speed_factor,
            "streaming_mode": profile.vendor_streaming_mode,
            "media_type": self.config.media_type,
            "batch_size": self.config.batch_size,
            "fragment_interval": profile.fragment_interval,
            "min_chunk_length": profile.min_chunk_length,
        }

    def _batch_payload(self, text: str) -> dict[str, Any]:
        return {
            "text": text,
            "text_lang": _vendor_text_lang_for(text),
            "ref_audio_path": str(self.preset.ref_audio_path),
            "prompt_text": self.preset.prompt_text,
            "prompt_lang": self.preset.prompt_lang,
            "text_split_method": self.preset.text_split_method,
            "speed_factor": self.preset.speed_factor,
            "streaming_mode": False,
            "media_type": "wav",
        }
