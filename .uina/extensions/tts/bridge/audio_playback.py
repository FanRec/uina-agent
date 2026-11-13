"""audio_playback.py — AudioSink：主声卡上的连续 PCM 时间线。

职责（唯一播放物理权威）：
- 打开/关闭 RawOutputStream（所有 sounddevice 调用走进程级音频线程）；
- 有界 PCM 缓冲与实时回调消费：跨句段连续输出，欠载补静音并计数；
- 按累计有效语音帧维护句段区间，回调产生一次性 started/completed 转换；
- DAC 估计的可听位置与声学电平测量（生产侧按窗计算，回调只做映射）；
- best-effort 镜像输出：独立有界队列、非阻塞投递、独立线程消费。

回调内绝不做：锁阻塞等待、线程/定时器创建、IO、大对象计算。
句段是同一条时间线上的区间，不是一场独立的声卡播放事务。
"""
from __future__ import annotations

import io
import math
import queue
import threading
import time
import wave
from collections import deque
from dataclasses import dataclass
from typing import Any, NamedTuple

from models import PlaybackProgressSnapshot


def wav_metadata(audio_bytes: bytes) -> tuple[int | None, int | None]:
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
            frame_count = wav_file.getnframes()
            sample_rate = wav_file.getframerate()
            duration_ms = int((frame_count / sample_rate) * 1000) if sample_rate > 0 else None
            return duration_ms, sample_rate
    except wave.Error:
        return None, None


def _time_info_value(time_info: Any, name: str, default: float = 0.0) -> float:
    if isinstance(time_info, dict):
        value = time_info.get(name, default)
    else:
        value = getattr(time_info, name, default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def frames_for_ms(sample_rate: int, channels: int, milliseconds: float) -> int:
    if sample_rate <= 0:
        return 0
    return max(int(sample_rate * max(milliseconds, 0) / 1000), 0)


class Transition(NamedTuple):
    kind: str  # "started" | "completed"
    trace_id: str
    segment_index: int
    task_id: str


# 电平测量的最大采样点数：包络只需趋势，不必逐样本精算。
_LEVEL_MAX_SAMPLES = 1024
_LEVEL_WINDOW_MS = 20


def measure_pcm_level(pcm_bytes: bytes) -> tuple[float, float]:
    """测量 16-bit 有符号小端 PCM 的 (rms, peak)，归一到 0.0~1.0。

    刻意只做测量、不做包络平滑——攻击/释放由消费端按其渲染节拍完成。
    任何异常一律退化为 (0.0, 0.0)：测量绝不允许影响发声。
    """
    try:
        if not pcm_bytes or len(pcm_bytes) < 2:
            return (0.0, 0.0)
        samples = memoryview(pcm_bytes).cast("h")
        total = len(samples)
        if total <= 0:
            return (0.0, 0.0)
        stride = max(1, total // _LEVEL_MAX_SAMPLES)
        peak = 0
        acc = 0
        count = 0
        for index in range(0, total, stride):
            value = samples[index]
            magnitude = value if value >= 0 else -value
            if magnitude > peak:
                peak = magnitude
            acc += value * value
            count += 1
        if count == 0:
            return (0.0, 0.0)
        rms = (acc / count) ** 0.5 / 32768.0
        return (min(1.0, rms), min(1.0, peak / 32768.0))
    except Exception:
        return (0.0, 0.0)


class StreamResampler:
    """int16 流式线性重采样，维护跨块连续状态。

    只用于 best-effort 镜像与批量 WAV 的采样率对齐；主声卡始终按
    vendor 原生采样率输出，零重采样。不依赖 audioop（Python 3.13 已移除）。
    """

    def __init__(self, source_rate: int, target_rate: int) -> None:
        self.source_rate = max(int(source_rate), 1)
        self.target_rate = max(int(target_rate), 1)
        self._step = self.source_rate / self.target_rate
        self._abs_pos = 0.0  # 输出样本在输入流（绝对样本坐标）上的位置
        self._consumed = 0  # 已消费的输入样本总数
        self._carry = 0  # 上一块最后一个样本（跨块插值用）

    def resample(self, pcm: bytes, *, final: bool = False) -> bytes:
        if self.source_rate == self.target_rate or not pcm:
            return pcm
        samples = memoryview(pcm).cast("h")
        count = len(samples)
        if count == 0:
            return b""
        out = bytearray()
        step = self._step
        pos = self._abs_pos
        base = self._consumed
        while True:
            index = int(pos)
            fraction = pos - index
            left_index = index - base
            right_index = left_index + 1
            if left_index < 0:
                left = self._carry
            elif left_index < count:
                left = samples[left_index]
            else:
                break  # 需要更多输入
            if right_index < 0:
                right = self._carry
            elif right_index < count:
                right = samples[right_index]
            elif final:
                right = left  # 收尾：保持最后一个样本
            else:
                break  # 等待下一块，保持跨块连续
            value = int(left + (right - left) * fraction)
            value = max(-32768, min(32767, value))
            out += value.to_bytes(2, "little", signed=True)
            pos += step
        self._abs_pos = pos
        self._consumed = base + count
        self._carry = samples[count - 1]
        return bytes(out)


def _resolve_output_device_index(device: str, sd: Any) -> str | int:
    """按名称解析输出设备；同名多后端时优先 WASAPI（低延迟）。"""
    candidates: list[tuple[int, Any]] = []
    try:
        for index, item in enumerate(sd.query_devices()):
            if int(item.get("max_output_channels", 0) or 0) <= 0:
                continue
            if str(item.get("name", "")).strip() == device.strip():
                candidates.append((index, item))
    except Exception:
        return device
    if not candidates:
        return device
    if len(candidates) == 1:
        return candidates[0][0]
    hostapi_priority = {2: 0, 3: 1, 0: 2}
    candidates.sort(
        key=lambda pair: hostapi_priority.get(int(pair[1].get("hostapi", -1)), 9)
    )
    return candidates[0][0]


class AudioExecutor:
    """进程级 PortAudio 专用线程：所有 sounddevice 调用都在同一线程执行。

    PortAudio 的 WASAPI 后端在主线程初始化后，其他线程创建流会触发 WDM-KS
    失败（-9999）。把初始化与全部流操作收敛到单一音频线程可彻底规避。
    """

    def __init__(self) -> None:
        self._queue: queue.Queue[tuple[Any, queue.Queue[tuple[str, Any]]] | None] = queue.Queue()
        self._thread: threading.Thread | None = None

    def _ensure_thread(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="uina-portaudio", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                break
            fn, result = item
            try:
                result.put(("ok", fn()))
            except BaseException as exc:  # noqa: BLE001
                result.put(("err", exc))

    def call(self, fn: Any, timeout: float = 8.0) -> Any:
        self._ensure_thread()
        result: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._queue.put((fn, result))
        status, value = result.get(timeout=timeout)
        if status == "err":
            raise value
        return value

    def close(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            self._queue.put(None)
            self._thread.join(timeout=2)
            self._thread = None


AUDIO_EXECUTOR = AudioExecutor()


@dataclass
class _SinkSegment:
    trace_id: str
    index: int
    task_id: str
    start_frame: int
    end_frame: int = 0
    final: bool = False
    dropped: bool = False
    started_emitted: bool = False
    completed_emitted: bool = False


@dataclass
class _LevelWindow:
    start_frame: int
    end_frame: int
    rms: float
    peak: float


class AudioSink:
    """主声卡输出。一个交付会话共享同一条流与同一条 PCM 时间线。"""

    def __init__(
        self,
        device: str | None = None,
        *,
        mirror_device: str | None = None,
        start_prebuffer_ms: int = 300,
        resume_min_ms: int = 20,
        priming_ms: int = 120,
        buffer_seconds: float = 2.0,
    ) -> None:
        self._device = device
        self._sd = None
        self._sd_available = self._check_sounddevice()
        self._lock = threading.Condition()
        self._stream = None
        self._streaming = False
        self._sample_rate = 0
        self._channels = 1
        # 缓冲里是尚未播放的有效 PCM；绝对位置 = _played_frames + _buffer_frames。
        self._buffer = bytearray()
        self._buffer_frames = 0
        self._played_frames = 0
        self._playback_started = False
        self._in_starvation = False
        self._underruns = 0
        self._lock_skips = 0
        self._segments: deque[_SinkSegment] = deque()
        self._transitions: queue.SimpleQueue[Transition] = queue.SimpleQueue()
        self._level_windows: deque[_LevelWindow] = deque()
        self._level_consumed = 0
        self._last_level = (0.0, 0.0)
        # 冷启动参数（ms；打开设备时换算为帧）。
        self._start_prebuffer_ms = start_prebuffer_ms
        self._resume_min_ms = resume_min_ms
        self._priming_ms = priming_ms
        self._buffer_seconds = buffer_seconds
        self._start_prebuffer_frames = 0
        self._resume_min_frames = 0
        self._max_buffer_frames = 0
        # 冷启动预热静音：打开设备后首段输出前消费，不推进有效帧位置。
        self._priming: bytearray = bytearray()
        self._active = False
        self._expecting = False
        # DAC 估计：把回调提交的帧区间映射到预计可听时刻。
        self._dac_slots = [[0.0, 0.0, 0.0, 0.0] for _ in range(128)]
        self._dac_count = 0
        self._mirror: _MirrorOutput | None = None
        if mirror_device is not None:
            self._mirror = _MirrorOutput(mirror_device)

    @staticmethod
    def _check_sounddevice() -> bool:
        try:
            import importlib.util

            return importlib.util.find_spec("sounddevice") is not None
        except (ImportError, ValueError):
            return False

    @property
    def ready(self) -> bool:
        return self._sd_available

    @property
    def is_open(self) -> bool:
        with self._lock:
            return self._streaming and self._stream is not None

    @property
    def mirror(self) -> _MirrorOutput | None:
        return self._mirror

    @property
    def underruns(self) -> int:
        with self._lock:
            return self._underruns

    @property
    def lock_skips(self) -> int:
        with self._lock:
            return self._lock_skips

    # ── 控制线程接口 ────────────────────────────────────────────────────

    def open(self, sample_rate: int, channels: int = 1) -> None:
        """按需要打开主输出流；同采样率复用，不同采样率先关再开。"""
        if not self._sd_available:
            raise RuntimeError("audio output is unavailable on this machine")
        with self._lock:
            if self._streaming and self._stream is not None and self._sample_rate == sample_rate and self._channels == channels:
                return
        if self._streaming:
            self.close()
        latency_seconds = 0.06
        AUDIO_EXECUTOR.call(lambda: self._open_stream(sample_rate, channels, latency_seconds))
        with self._lock:
            self._sample_rate = sample_rate
            self._channels = channels
            self._streaming = True
            self._playback_started = False
            self._in_starvation = False
            self._underruns = 0
            self._lock_skips = 0
            self._buffer.clear()
            self._buffer_frames = 0
            self._played_frames = 0
            self._segments.clear()
            self._level_windows.clear()
            self._level_consumed = 0
            self._last_level = (0.0, 0.0)
            self._dac_count = 0
            self._priming = bytearray(frames_for_ms(sample_rate, channels, self._priming_ms) * channels * 2)
            self._start_prebuffer_frames = frames_for_ms(sample_rate, channels, self._start_prebuffer_ms)
            self._resume_min_frames = frames_for_ms(sample_rate, channels, self._resume_min_ms)
            self._max_buffer_frames = frames_for_ms(sample_rate, channels, self._buffer_seconds * 1000)
        if self._mirror is not None:
            self._mirror.start(
                source_rate=sample_rate,
                target_rate=48000 if sample_rate != 48000 else sample_rate,
                channels=channels,
            )

    def close(self) -> None:
        """关闭输出流并丢弃未播内容；只由控制线程调用。"""
        with self._lock:
            was_open = self._streaming
            self._streaming = False
            self._buffer.clear()
            self._buffer_frames = 0
            self._segments.clear()
            self._level_windows.clear()
            self._last_level = (0.0, 0.0)
            self._playback_started = False
            self._in_starvation = False
            self._priming.clear()
            self._lock.notify_all()
        if self._mirror is not None:
            self._mirror.close()
        if was_open and self._stream is not None:
            AUDIO_EXECUTOR.call(self._close_stream)

    def _close_stream(self) -> None:
        stream = self._stream
        self._stream = None
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass

    def set_active(self, active: bool) -> None:
        with self._lock:
            self._active = active

    def set_expecting(self, expecting: bool) -> None:
        with self._lock:
            self._expecting = expecting
            self._lock.notify_all()

    def buffered_ms(self) -> float:
        with self._lock:
            if self._sample_rate <= 0:
                return 0.0
            return self._buffer_frames / self._sample_rate * 1000

    def buffered_frames(self) -> int:
        with self._lock:
            return self._buffer_frames

    def played_frames(self) -> int:
        with self._lock:
            return self._played_frames

    def capacity_frames(self) -> int:
        with self._lock:
            return self._max_buffer_frames

    def wait_for_capacity(self, frames: int, *, timeout: float = 0.25) -> bool:
        """等待缓冲腾出 frames 的空间（有界背压等待，不是失败）。

        由回调消费时唤醒；超时返回 False 由调用方决定继续等待或收束。
        """
        with self._lock:
            deadline = time.perf_counter() + timeout
            while self._buffer_frames > 0 and self._buffer_frames + frames > self._max_buffer_frames:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    return False
                self._lock.wait(remaining)
            return self._buffer_frames + frames <= self._max_buffer_frames

    # ── 生产者（SynthesisWorker）接口 ──────────────────────────────────

    def register_segment(self, *, trace_id: str, index: int, task_id: str) -> _SinkSegment:
        """登记句段区间起点：当前缓冲末端（绝对帧位置）。返回句段句柄。"""
        with self._lock:
            start = self._played_frames + self._buffer_frames
            segment = _SinkSegment(trace_id=trace_id, index=index, task_id=task_id, start_frame=start)
            self._segments.append(segment)
            return segment

    def append(self, handle: _SinkSegment, pcm: bytes) -> None:
        """向句段句柄追加有效 PCM；同时延伸区间终点并登记电平窗。

        句柄已被丢弃（取消/失败收束）或写入顺序过期时明确拒绝：
        取消后的迟到数据绝不允许进入时间线。
        容量由生产者遵守（DeliveryLane 背压）；这里只负责登记。
        镜像是 best-effort：投递不阻塞、不丢主缓冲数据。
        """
        if not pcm:
            return
        if self._sample_rate <= 0:
            raise RuntimeError("audio sink is not open")
        if self._mirror is not None:
            self._mirror.submit(pcm)
        with self._lock:
            if handle.dropped:
                raise RuntimeError("segment was discarded (cancelled)")
            if not self._segments or self._segments[-1] is not handle:
                raise RuntimeError("stale segment write rejected")
            frame_bytes = max(self._channels * 2, 1)
            frames = len(pcm) // frame_bytes
            self._buffer.extend(pcm)
            self._buffer_frames += frames
            handle.end_frame = self._played_frames + self._buffer_frames
            # 电平测量在生产侧完成：O(样本数) 的工作不进入实时回调。
            window_frames = max(frames_for_ms(self._sample_rate, self._channels, _LEVEL_WINDOW_MS), 1)
            window_bytes = window_frames * frame_bytes
            origin = self._played_frames + self._buffer_frames - frames
            offset = 0
            while offset < len(pcm):
                part = pcm[offset:offset + window_bytes]
                rms, peak = measure_pcm_level(part)
                part_frames = len(part) // frame_bytes
                start_frame = origin + offset // frame_bytes
                self._level_windows.append(_LevelWindow(start_frame, start_frame + part_frames, rms, peak))
                offset += window_bytes
            self._lock.notify_all()

    def finalize_segment(self, handle: _SinkSegment) -> None:
        """锁定句段终点：之后它才允许产生 completed。"""
        with self._lock:
            if handle.dropped:
                return
            handle.end_frame = self._played_frames + self._buffer_frames
            handle.final = True
            self._lock.notify_all()

    def discard_unplayed_from(self, frame: int, *, drop_straddler: bool = False) -> int:
        """丢弃绝对位置 frame 之后的未播样本；返回实际丢弃的帧数。

        用于来源取消/合成失败：只丢属于该来源的未播数据，已进入输出的
        部分保留事实。`drop_straddler` 表示跨越 frame 的句段本身已被取消
        （其剩余数据不会再来），须从时间线移除；边界模式下正在播放的句段
        还会继续写入，必须保留。
        frame <= 已播放位置时不动缓冲。
        """
        with self._lock:
            keep = max(frame - self._played_frames, 0)
            dropped = max(self._buffer_frames - keep, 0)
            if dropped:
                frame_bytes = max(self._channels * 2, 1)
                self._buffer_frames = keep
                del self._buffer[keep * frame_bytes:]
            # 无论缓冲里是否还有数据：被取消区间上的登记本身已死，必须移除，
            # 否则它会永远挡住后续句段的 started/completed 转换。
            while self._segments and self._segments[-1].start_frame >= frame:
                self._segments.pop().dropped = True
            if (
                drop_straddler
                and self._segments
                and self._segments[-1].end_frame >= frame
            ):
                # end == frame（数据恰好被消费完、合成又被取消）同样必须移除：
                # 它永远等不到 finalize，会挡住后续句段的转换。
                self._segments.pop().dropped = True
            if dropped:
                while self._level_windows and self._level_windows[-1].start_frame >= frame:
                    self._level_windows.pop()
            self._lock.notify_all()
            return dropped

    def take_transitions(self) -> list[Transition]:
        transitions: list[Transition] = []
        try:
            while True:
                transitions.append(self._transitions.get_nowait())
        except queue.Empty:
            return transitions

    # ── 快照（只读） ───────────────────────────────────────────────────

    def snapshot(self, *, duration_ms: int = 0, playback_id: str | None = None) -> PlaybackProgressSnapshot:
        with self._lock:
            rate = self._sample_rate
            now = time.perf_counter() * 1000
            played_frames = self._played_frames
            quality = "submitted_samples" if rate > 0 else "unknown"
            audible = False
            if self._dac_count:
                quality = "dac"
                for index in range(self._dac_count - 1, max(-1, self._dac_count - len(self._dac_slots) - 1), -1):
                    slot = self._dac_slots[index % len(self._dac_slots)]
                    if now >= slot[0]:
                        audible = now < slot[1]
                        ratio = min(1.0, max(0.0, (now - slot[0]) / max(slot[1] - slot[0], 0.001)))
                        played_frames = int(slot[2] + (slot[3] - slot[2]) * ratio)
                        break
            elif self._playback_started:
                # submitted-sample 观察的是最后被提交的样本；回退一个位置避免超前。
                played_frames = max(0, played_frames - 1)
            played_ms = played_frames / rate * 1000 if rate > 0 else 0.0
            buffered_ms = self._buffer_frames / rate * 1000 if rate > 0 else 0.0
            level_active = audible or (self._playback_started and not self._in_starvation and self._buffer_frames > 0)
            position = played_frames
            level_rms = level_peak = 0.0
            if level_active and position == self._level_consumed:
                level_rms, level_peak = self._last_level
            while len(self._level_windows) > 1 and self._level_windows[1].start_frame <= position:
                window = self._level_windows.popleft()
                if level_active and window.end_frame > self._level_consumed:
                    level_rms = max(level_rms, window.rms)
                    level_peak = max(level_peak, window.peak)
            if level_active and self._level_windows:
                window = self._level_windows[0]
                if window.start_frame <= position < window.end_frame:
                    level_rms = max(level_rms, window.rms)
                    level_peak = max(level_peak, window.peak)
            self._level_consumed = max(position, self._level_consumed)
            self._last_level = (level_rms, level_peak)
            segment_finished = self._buffer_frames == 0 and not self._segments and not self._active
            return PlaybackProgressSnapshot(
                playback_started=self._playback_started and played_frames > 0,
                played_ms=round(min(played_ms, float(duration_ms)) if duration_ms > 0 else played_ms, 2),
                played_frames=played_frames,
                buffered_ms=round(buffered_ms, 2),
                segment_finished=segment_finished,
                duration_ms=duration_ms,
                rms=level_rms,
                peak=level_peak,
                state="playing" if self._playback_started and not self._in_starvation else ("buffering" if self._active else "idle"),
                clock_quality=quality,
                playback_id=playback_id,
            )

    # ── 实时回调 ───────────────────────────────────────────────────────

    def _open_stream(self, sample_rate: int, channels: int, latency_seconds: float) -> None:
        if self._sd is None:
            import sounddevice as sd

            self._sd = sd
        if isinstance(self._device, str):
            self._device = _resolve_output_device_index(self._device, self._sd)
        self._stream = self._sd.RawOutputStream(
            samplerate=sample_rate,
            channels=channels,
            dtype="int16",
            device=self._device,
            latency=latency_seconds,
            callback=self._audio_callback,
        )
        self._stream.start()

    def _audio_callback(self, outdata, frame_count, time_info, status) -> None:  # noqa: ANN001
        needed = len(outdata)
        # 音频实时线程绝不等待 Python 锁：拿不到锁就整帧写静音，
        # 缓冲数据不丢，只是这一帧延迟消费（计为可诊断欠载）。
        if not self._lock.acquire(blocking=False):
            self._lock_skips += 1
            self._fill_silence(outdata)
            return
        try:
            if not self._streaming:
                self._write_silence(outdata, 0, needed)
                return
            available = self._buffer_frames
            if not self._playback_started:
                can_start = (
                    available >= self._start_prebuffer_frames
                    or (available > 0 and not (self._expecting or self._active))
                )
                if not can_start:
                    self._write_silence(outdata, 0, needed)
                    return
                self._playback_started = True
            consumed = self._consume_locked(outdata, needed, time_info)
            if consumed < needed:
                if self._buffer_frames == 0 and not self._priming and (self._expecting or self._active):
                    if not self._in_starvation:
                        self._in_starvation = True
                        self._underruns += 1
                self._write_silence(outdata, consumed, needed - consumed)
            if self._in_starvation and self._buffer_frames >= self._resume_min_frames:
                self._in_starvation = False
        finally:
            self._lock.release()

    def _consume_locked(self, outdata, needed: int, time_info) -> int:
        """从预热静音与缓冲复制最多 needed 字节；返回实际写字节数。

        先消费冷启动预热静音（不推进有效帧位置），再消费真实 PCM。
        跨句段边界：同一次回调先完成旧段转换、再开始新段，保证因果顺序。
        """
        written = 0
        if self._priming:
            prime = min(len(self._priming), needed - written)
            outdata[written:written + prime] = self._priming[:prime]
            del self._priming[:prime]
            written += prime
        take = min(needed - written, len(self._buffer))
        if take:
            view = memoryview(self._buffer)
            outdata[written:written + take] = view[:take]
            del view
            del self._buffer[:take]
            frame_bytes = max(self._channels * 2, 1)
            before = self._played_frames
            self._played_frames += take // frame_bytes
            self._buffer_frames -= take // frame_bytes
            if time_info is not None and self._sample_rate > 0:
                dac = _time_info_value(time_info, "outputBufferDacTime")
                current = _time_info_value(time_info, "currentTime")
                if dac > 0 and math.isfinite(dac) and math.isfinite(current) and -0.02 <= dac - current <= 1.0:
                    slot = self._dac_slots[self._dac_count % len(self._dac_slots)]
                    slot[0] = time.perf_counter() * 1000 + (dac - current) * 1000
                    slot[1] = slot[0] + take / frame_bytes / self._sample_rate * 1000
                    slot[2] = before
                    slot[3] = self._played_frames
                    self._dac_count += 1
            written += take
        # 消费推进：唤醒等容量/等排空的生产者与控制方。
        self._lock.notify_all()
        self._emit_transitions_locked()
        return written

    def _emit_transitions_locked(self) -> None:
        """回调内的轻量状态通知：一次性 started/completed 转换入队。"""
        while self._segments:
            head = self._segments[0]
            if not head.started_emitted and self._played_frames > head.start_frame:
                head.started_emitted = True
                self._transitions.put_nowait(Transition("started", head.trace_id, head.index, head.task_id))
            if head.final and not head.completed_emitted and self._played_frames >= head.end_frame:
                head.completed_emitted = True
                self._transitions.put_nowait(Transition("completed", head.trace_id, head.index, head.task_id))
                self._segments.popleft()
                continue
            break

    def _write_silence(self, outdata, start: int, count: int) -> None:  # noqa: ANN001
        if count <= 0:
            return
        try:
            outdata[start:start + count] = bytes(count)
        except (TypeError, ValueError):
            try:
                outdata[start:start + count] = bytearray(count)
            except Exception:
                pass

    def _fill_silence(self, outdata) -> None:  # noqa: ANN001
        """无锁静音填充：仅在音频回调拿不到缓冲锁时使用。"""
        try:
            outdata.fill(0)
        except AttributeError:
            try:
                outdata[:] = bytes(len(outdata))
            except Exception:
                pass


class _MirrorOutput:
    """best-effort 镜像输出：独立有界队列 + 独立线程，绝不阻塞主路径。

    队列满时丢最旧的副本并做限频诊断；镜像设备故障只影响镜像自身。
    采样率转换维护跨块连续状态；转换不可用时显式停用镜像而不是错播。
    """

    def __init__(self, device: str | None, *, max_queue_ms: int = 500) -> None:
        self._device = device
        self._sd = None
        # Condition（内含 RLock）：等待时释放锁，submit/回调不会被饿死。
        self._lock = threading.Condition()
        self._queue: deque[bytes] = deque()
        self._queue_bytes = 0
        self._max_queue_bytes = max(1, max_queue_ms * 64)  # 64 bytes/ms @ mono int16
        self._source_rate = 0
        self._target_rate = 0
        self._stream = None
        self._thread: threading.Thread | None = None
        self._resampler: StreamResampler | None = None
        self._buffer = bytearray()
        self._pending = b""
        self._last_drop_log = 0.0
        self._closed = threading.Event()

    def start(self, *, source_rate: int, target_rate: int, channels: int) -> None:
        with self._lock:
            self._source_rate = source_rate
            self._target_rate = target_rate
            self._resampler = StreamResampler(source_rate, target_rate) if source_rate != target_rate else None
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="uina-tts-mirror", daemon=True)
            self._thread.start()

    def submit(self, pcm: bytes) -> None:
        if self._closed.is_set():
            return
        with self._lock:
            if self._thread is None:
                return  # 镜像未启动：直接丢弃副本，不积压。
            if self._queue_bytes + len(pcm) > self._max_queue_bytes:
                while self._queue and self._queue_bytes + len(pcm) > self._max_queue_bytes:
                    self._queue_bytes -= len(self._queue.popleft())
                now = time.monotonic()
                if now - self._last_drop_log > 2.0:
                    self._last_drop_log = now
                    print("[TTS][audio] mirror queue overflow: dropped oldest copy (main output unaffected)", flush=True)
            self._queue.append(pcm)
            self._queue_bytes += len(pcm)
            self._lock.notify_all()

    def close(self) -> None:
        self._closed.set()
        with self._lock:
            self._queue.clear()
            self._queue_bytes = 0
            self._lock.notify_all()
        stream = self._stream
        self._stream = None
        if stream is not None:
            try:
                AUDIO_EXECUTOR.call(lambda: (stream.stop(), stream.close()))
            except Exception:
                pass

    def _run(self) -> None:
        while not self._closed.is_set():
            chunk = None
            with self._lock:
                while not self._closed.is_set() and not self._queue:
                    self._lock.wait(timeout=0.5)
                if self._closed.is_set():
                    return
                chunk = self._queue.popleft()
                self._queue_bytes -= len(chunk)
            try:
                self._feed(chunk)
            except Exception as exc:
                print(f"[TTS][audio] mirror feed failed (isolated): {exc}", flush=True)
                with self._lock:
                    self._stream = None
                    self._buffer.clear()

    def _ensure_stream(self) -> Any:
        if self._stream is not None:
            return self._stream
        if self._sd is None:
            import sounddevice as sd

            self._sd = sd
        with self._lock:
            rate = self._target_rate
        if rate <= 0:
            raise RuntimeError("mirror target rate unknown")
        device = self._device

        def _open() -> Any:
            resolved = device
            if isinstance(resolved, str):
                resolved = _resolve_output_device_index(resolved, self._sd)
            stream = self._sd.RawOutputStream(
                samplerate=rate,
                channels=1,
                dtype="int16",
                device=resolved,
                latency=0.1,
                callback=self._mirror_callback,
            )
            stream.start()
            return stream

        # PortAudio 流的创建必须走进程级音频线程（WASAPI 后端对多线程初始化敏感）。
        stream = AUDIO_EXECUTOR.call(_open)
        with self._lock:
            self._stream = stream
        return stream

    def _feed(self, pcm: bytes) -> None:
        self._ensure_stream()
        data = self._pending + pcm
        self._pending = b""
        if len(data) % 2:
            self._pending = data[-1:]
            data = data[:-1]
        if not data:
            return
        converted = self._resampler.resample(data) if self._resampler is not None else data
        if converted:
            with self._lock:
                self._buffer.extend(converted)

    def _mirror_callback(self, outdata, frame_count, time_info, status) -> None:  # noqa: ANN001
        needed = len(outdata)
        if not self._lock.acquire(blocking=False):
            try:
                outdata.fill(0)
            except AttributeError:
                outdata[:] = bytes(needed)
            return
        try:
            take = min(needed, len(self._buffer))
            if take:
                outdata[:take] = self._buffer[:take]
                del self._buffer[:take]
            if take < needed:
                try:
                    outdata[take:] = bytes(needed - take)
                except Exception:
                    pass
        finally:
            self._lock.release()
