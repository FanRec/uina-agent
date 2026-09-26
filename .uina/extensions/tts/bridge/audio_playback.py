from __future__ import annotations

import io
import queue
import threading
import time
import wave
from pathlib import Path
from queue import Queue
from typing import Any, Callable, TypeVar

from models import PlaybackProgressSnapshot

T = TypeVar("T")


def _wav_metadata(audio_bytes: bytes) -> tuple[int | None, int | None]:
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
            frame_count = wav_file.getnframes()
            sample_rate = wav_file.getframerate()
            duration_ms = int((frame_count / sample_rate) * 1000) if sample_rate > 0 else None
            return duration_ms, sample_rate
    except wave.Error:
        return None, None


def pcm_bytes_for_ms(sample_rate: int, channels: int, milliseconds: int) -> int:
    bytes_per_ms = max(sample_rate * channels * 2 / 1000, 1)
    return max(int(milliseconds * bytes_per_ms), 0)


def playback_timeout_ms(duration_ms: int, drain_timeout_ms: int) -> int:
    return max(duration_ms + 250, drain_timeout_ms, 750)


# 电平测量的最大采样点数：包络只需趋势，不必逐样本精算。
# 跨步采样把每包成本压到常数级，避免在投递线程上做整包遍历。
_LEVEL_MAX_SAMPLES = 1024


def measure_pcm_level(pcm_bytes: bytes) -> tuple[float, float]:
    """测量 16-bit 有符号小端 PCM 的 (rms, peak)，归一到 0.0~1.0。

    刻意只做测量、不做包络平滑——攻击/释放由消费端按其渲染节拍完成。
    任何异常一律退化为 (0.0, 0.0)：测量绝不允许影响发声。
    """
    try:
        if not pcm_bytes or len(pcm_bytes) < 2:
            return (0.0, 0.0)
        # cast 要求长度为 2 的倍数且缓冲连续；不满足时抛错并由 except 兜住
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


def _resolve_output_device_index(device: str, sd: Any) -> str | int:
    """按名称解析输出设备；同名多后端时优先 WASAPI（低延迟）。

    只在 PortAudio 音频线程内调用（经由 AudioExecutor），保证初始化线程一致。
    """
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
    惰性启动：线程在第一次 call 时才创建，首次 PortAudio 初始化因此发生在
    音频线程而非服务启动线程。
    """

    def __init__(self) -> None:
        self._queue: queue.Queue[tuple[Callable[[], T], queue.Queue[tuple[str, T | BaseException]]] | None] = queue.Queue()
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

    def call(self, fn: Callable[[], T], timeout: float = 8.0) -> T:
        self._ensure_thread()
        result: queue.Queue[tuple[str, T | BaseException]] = queue.Queue()
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


class AudioPlayback:
    """音频播放器。

    两种模式：
    - 流式模式（sounddevice）：声卡立即启动，预填静音，feed() 到了就播。
    - 文件模式（winsound 回退）：enqueue(path) 排队播放完整 WAV 文件。
    """

    def __init__(self, device: str | None = None, *, mirror_device: str | int | None = None) -> None:
        self._device = device
        self._sd = None
        self._stream = None
        self._buffer: bytearray = bytearray()
        self._buffer_read_pos = 0
        self._buffer_lock = threading.Condition()
        self._streaming = False
        self._stream_sample_rate = 0
        self._stream_channels = 1
        self._stream_finished = False
        self._stream_started_at_ms: float | None = None
        self._first_feed_at_ms: float | None = None
        self._playback_started_at_ms: float | None = None
        self._playback_started = False
        self._played_bytes = 0
        # 最近一次喂入音频的电平测量（由 feed 在锁外算出、在锁内落值）。
        # 只存最近测量：包络平滑由消费端负责，这里不做时间衰减。
        self._level_rms = 0.0
        self._level_peak = 0.0
        self._underrun_count = 0
        self._tail_padding_count = 0
        self._prebuffer_bytes = 0
        self._rebuffer_bytes = 0
        self._low_water_bytes = 0
        self._rebuffer_resume_bytes = 0
        self._rebuffering = False
        self._rebuffer_count = 0
        self._rebuffer_started_at_ms: float | None = None
        self._rebuffer_total_ms = 0.0
        self._max_buffer_bytes = 0
        self._silence_buffer = bytearray(65536)
        self._drained = threading.Event()
        self._queue: Queue[tuple[Path, threading.Event | None]] = Queue()
        self._file_lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._current_file: Path | None = None
        self._sd_available = self._check_sounddevice()
        self._winsound_available = self._check_winsound()
        # 镜像输出：同一路 PCM 同时送往副设备（如虚拟声卡），用于嘴型同步。
        # 主/镜像实例共享进程级音频线程，保证 PortAudio 单线程。
        self._mirror: AudioPlayback | None = None
        if mirror_device is not None:
            self._mirror = AudioPlayback(device=mirror_device)
        self._stream_source_sample_rate = 0
        self._resampler_state: Any = None
        self._idle_timer: threading.Timer | None = None

    @staticmethod
    def _check_sounddevice() -> bool:
        try:
            import importlib.util

            return importlib.util.find_spec("sounddevice") is not None
        except (ImportError, ValueError):
            return False

    @staticmethod
    def _check_winsound() -> bool:
        try:
            import winsound  # noqa: F401

            return True
        except ImportError:
            return False

    def start_stream(
        self,
        sample_rate: int,
        channels: int = 1,
        *,
        prebuffer_ms: int = 160,
        rebuffer_ms: int = 220,
    ) -> None:
        if not self._sd_available:
            return
        if self._sd is None:
            import sounddevice as sd

            self._sd = sd
        # 主扬声器始终保持模型原生采样率（如 32000Hz），零重采样保证最高音质。
        self._stream_source_sample_rate = sample_rate
        self.stop_stream()
        with self._buffer_lock:
            self._cancel_idle_stop_locked()
            self._buffer.clear()
            self._buffer_read_pos = 0
            self._stream_finished = False
            self._stream_started_at_ms = round(time.perf_counter() * 1000, 2)
            self._first_feed_at_ms = None
            self._playback_started_at_ms = None
            self._playback_started = False
            # 新一段音频不得继承上一段的电平，否则首帧口型会先张开
            self._level_rms = 0.0
            self._level_peak = 0.0
            self._stream_sample_rate = sample_rate
            self._stream_channels = channels
            self._played_bytes = 0
            self._underrun_count = 0
            self._tail_padding_count = 0
            self._rebuffering = False
            self._rebuffer_count = 0
            self._rebuffer_started_at_ms = None
            self._rebuffer_total_ms = 0.0
            self._max_buffer_bytes = 0
            self._prebuffer_bytes = pcm_bytes_for_ms(sample_rate, channels, prebuffer_ms)
            self._rebuffer_bytes = max(pcm_bytes_for_ms(sample_rate, channels, rebuffer_ms), self._prebuffer_bytes)
            self._rebuffer_resume_bytes = self._prebuffer_bytes
            self._max_buffer_bytes = max(
                self._rebuffer_bytes * 4,
                pcm_bytes_for_ms(sample_rate, channels, 2000),
            )
            self._low_water_bytes = pcm_bytes_for_ms(sample_rate, channels, 20)
            self._ensure_silence_capacity_locked(pcm_bytes_for_ms(sample_rate, channels, 250))
            self._drained.clear()
        self._streaming = True
        self._resampler_state = None
        latency_seconds = max(min(prebuffer_ms / 1000, 0.12), 0.04)
        AUDIO_EXECUTOR.call(
            lambda: self._open_sounddevice_stream(sample_rate, channels, latency_seconds)
        )
        if self._mirror is not None:
            try:
                # 镜像输出（如 VB-CABLE WASAPI）通常仅支持 44100/48000/96000，
                # 若主采样率非 48kHz 则镜像流目标设为 48kHz，在 feed 侧单独为镜像重采样。
                mirror_sr = 48000 if sample_rate != 48000 else sample_rate
                self._mirror.start_stream(
                    sample_rate=mirror_sr,
                    channels=channels,
                    prebuffer_ms=prebuffer_ms,
                    rebuffer_ms=rebuffer_ms,
                )
            except Exception as e:
                print(f"[TTS][audio] mirror device start failed (isolated): {e}", flush=True)

    def _open_sounddevice_stream(
        self,
        sample_rate: int,
        channels: int,
        latency_seconds: float,
    ) -> None:
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

    def _audio_callback(self, outdata, frame_count, time_info, status) -> None:
        needed = len(outdata)
        # 音频实时线程绝不等待 Python 锁：feed 线程短暂持锁时本帧写静音，
        # 下一帧再消费。跳帧不丢数据（缓冲数据仍完整保留），只是延迟消费。
        if not self._buffer_lock.acquire(blocking=False):
            self._fill_silence_now(outdata, 0, needed)
            return
        wrote = 0
        try:
            if not self._streaming:
                self._write_silence(outdata, 0, needed)
                return
            if not self._playback_started:
                available = self._available_bytes_locked()
                can_start = available >= self._prebuffer_bytes or (self._stream_finished and available > 0)
                if can_start:
                    self._playback_started = True
                    self._playback_started_at_ms = round(time.perf_counter() * 1000, 2)
                elif self._stream_finished and available <= 0:
                    self._drained.set()
                    self._write_silence(outdata, 0, needed)
                    return
                else:
                    self._write_silence(outdata, 0, needed)
                    return
            if self._rebuffering:
                available = self._available_bytes_locked()
                can_resume = available >= self._rebuffer_resume_bytes or (self._stream_finished and available > 0)
                if can_resume:
                    self._rebuffering = False
                    if self._rebuffer_started_at_ms is not None:
                        self._rebuffer_total_ms += round(time.perf_counter() * 1000, 2) - self._rebuffer_started_at_ms
                        self._rebuffer_started_at_ms = None
                elif self._stream_finished and available <= 0:
                    self._drained.set()
                    self._write_silence(outdata, 0, needed)
                    return
                else:
                    self._write_silence(outdata, 0, needed)
                    return
                # can_resume：恢复后继续消费本帧数据，不浪费一帧静音
            available = self._available_bytes_locked()
            if available < needed and not self._stream_finished:
                self._rebuffering = True
                self._rebuffer_count += 1
                self._underrun_count += 1
                self._rebuffer_started_at_ms = round(time.perf_counter() * 1000, 2)
                self._write_silence(outdata, 0, needed)
                return
            take = min(available, needed)
            if take:
                start = self._buffer_read_pos
                end = start + take
                view = memoryview(self._buffer)
                outdata[:take] = view[start:end]
                del view
                self._buffer_read_pos = end
                self._played_bytes += take
                self._buffer_lock.notify_all()
                wrote = take
            if take < needed and self._stream_finished:
                self._tail_padding_count += 1
            if self._stream_finished and self._available_bytes_locked() <= 0:
                self._drained.set()
                self._schedule_idle_stop_locked()
            if wrote < needed:
                self._write_silence(outdata, wrote, needed - wrote)
        finally:
            self._buffer_lock.release()

    def feed(self, pcm_bytes: bytes) -> None:
        if not self._streaming:
            return
        # 电平测量在锁外完成：它是 O(样本数) 的工作，绝不允许延长 _buffer_lock 的持有时间。
        level_rms, level_peak = measure_pcm_level(pcm_bytes)
        data = pcm_bytes
        with self._buffer_lock:
            self._level_rms = level_rms
            self._level_peak = level_peak
            self._cancel_idle_stop_locked()
            self._compact_buffer_locked()
            while (
                self._streaming
                and self._max_buffer_bytes > 0
                and self._available_bytes_locked() + len(data) > self._max_buffer_bytes
            ):
                self._buffer_lock.wait(timeout=0.05)
                self._compact_buffer_locked()
            if not self._streaming:
                return
            if self._first_feed_at_ms is None:
                self._first_feed_at_ms = round(time.perf_counter() * 1000, 2)
                # Windows DAC 唤醒爬坡保护：首包前注入 120ms 静音，确保物理声卡上电稳定，不吃首字
                if self._stream_sample_rate > 0 and self._stream_channels > 0:
                    warmup_bytes = pcm_bytes_for_ms(self._stream_sample_rate, self._stream_channels, 120)
                    if warmup_bytes > 0:
                        self._buffer.extend(b"\x00" * warmup_bytes)
            self._buffer.extend(data)
        if self._mirror is not None:
            try:
                mirror_data = self._resample_for_mirror(pcm_bytes)
                self._mirror.feed(mirror_data)
            except Exception:
                pass

    def _resample_for_mirror(self, pcm_bytes: bytes) -> bytes:
        if self._mirror is None or not pcm_bytes:
            return pcm_bytes
        source = self._stream_sample_rate
        target = getattr(self._mirror, "_stream_sample_rate", 0)
        if source <= 0 or target <= 0 or source == target:
            return pcm_bytes
        try:
            import audioop

            converted, self._resampler_state = audioop.ratecv(
                pcm_bytes, 2, 1, source, target, self._resampler_state
            )
            return converted
        except Exception:
            self._resampler_state = None
            return pcm_bytes

    def _schedule_idle_stop_locked(self, delay_seconds: float = 3.0) -> None:
        self._cancel_idle_stop_locked()
        timer = threading.Timer(delay_seconds, self._on_idle_timeout)
        timer.daemon = True
        self._idle_timer = timer
        timer.start()

    def _cancel_idle_stop_locked(self) -> None:
        if self._idle_timer is not None:
            self._idle_timer.cancel()
            self._idle_timer = None

    def _on_idle_timeout(self) -> None:
        with self._buffer_lock:
            if not self._streaming or not self._stream_finished or self._available_bytes_locked() > 0:
                return
        self.stop_stream()

    def finish_stream(self) -> None:
        with self._buffer_lock:
            self._stream_finished = True
            if self._available_bytes_locked() <= 0:
                self._drained.set()
                self._schedule_idle_stop_locked()
        if self._mirror is not None:
            try:
                self._mirror.finish_stream()
            except Exception:
                pass

    def resume_stream(self) -> None:
        """连续 segment 场景：重置 finish 标志，让 player 继续接受 feed 并等待新数据。

        与 stop_stream + start_stream 不同，不清空缓冲区、不重建 sounddevice 流，
        避免前一个 segment 还没播完的 PCM 被丢弃。
        """
        if not self._streaming:
            return
        with self._buffer_lock:
            self._cancel_idle_stop_locked()
            self._stream_finished = False
            self._drained.clear()
        if self._mirror is not None:
            self._mirror.resume_stream()

    def resume_or_start_stream(
        self,
        sample_rate: int,
        channels: int = 1,
        *,
        prebuffer_ms: int = 160,
        rebuffer_ms: int = 220,
    ) -> None:
        """连续 segment：已 streaming 且采样率一致时只 resume，否则 stop+start 重建流。"""
        if (
            self._streaming
            and self._stream is not None
            and self._stream_sample_rate == sample_rate
            and self._stream_channels == channels
        ):
            self.resume_stream()
            return
        self.start_stream(
            sample_rate=sample_rate,
            channels=channels,
            prebuffer_ms=prebuffer_ms,
            rebuffer_ms=rebuffer_ms,
        )

    def wait_until_drained(self, timeout_ms: int) -> bool:
        ok = self._drained.wait(timeout=max(timeout_ms / 1000, 0.0))
        if ok and self._streaming:
            # 硬件声卡 WASAPI DMA 环形缓冲排空保护：
            # _drained 在 Python 内存缓冲消费完时触发，此时驱动缓冲区仍有 50-100ms 音频在排队发往 DAC。
            # 留出 90ms 物理排空余量，确保句末最后一个音节/尾音完整发声，避免声卡被掐断吞字。
            time.sleep(0.09)
        return ok

    def stream_stats(self) -> dict[str, Any]:
        with self._buffer_lock:
            first_chunk_latency_ms = None
            playback_start_latency_ms = None
            if self._stream_started_at_ms is not None and self._first_feed_at_ms is not None:
                first_chunk_latency_ms = round(self._first_feed_at_ms - self._stream_started_at_ms, 2)
            if self._stream_started_at_ms is not None and self._playback_started_at_ms is not None:
                playback_start_latency_ms = round(self._playback_started_at_ms - self._stream_started_at_ms, 2)
            return {
                "first_chunk_latency_ms": first_chunk_latency_ms,
                "playback_start_latency_ms": playback_start_latency_ms,
                "playback_started": self._playback_started,
                "underrun_count": self._underrun_count,
                "tail_padding_count": self._tail_padding_count,
                "rebuffer_count": self._rebuffer_count,
                "buffered_bytes": self._available_bytes_locked(),
                "prebuffer_bytes": self._prebuffer_bytes,
                "rebuffer_bytes": self._rebuffer_bytes,
                "rebuffer_resume_bytes": self._rebuffer_resume_bytes,
            }

    def progress_snapshot(self, *, duration_ms: int) -> PlaybackProgressSnapshot:
        with self._buffer_lock:
            played_samples = 0
            if self._stream_channels > 0:
                played_samples = self._played_bytes // max(self._stream_channels * 2, 1)
            # 优先用 wall-clock 计算 played_ms：自 DAC 开始播放以来经过的真实时间，
            # 扣除 rebuffer 累计时间（underrun 期间 DAC 静音，字幕应等声音）。
            # 这比 _played_bytes/sample_rate 更准确，因为后者包含 DAC 输出缓冲延迟。
            played_ms = 0.0
            if self._playback_started and self._playback_started_at_ms is not None:
                now_ms = round(time.perf_counter() * 1000, 2)
                elapsed_ms = now_ms - self._playback_started_at_ms
                played_ms = max(0.0, elapsed_ms - self._rebuffer_total_ms)
                if self._rebuffering and self._rebuffer_started_at_ms is not None:
                    played_ms = max(0.0, played_ms - (now_ms - self._rebuffer_started_at_ms))
            elif self._stream_sample_rate > 0:
                played_ms = played_samples / self._stream_sample_rate * 1000
            buffered_ms = 0.0
            if self._stream_sample_rate > 0 and self._stream_channels > 0:
                buffered_samples = self._available_bytes_locked() // max(self._stream_channels * 2, 1)
                buffered_ms = buffered_samples / self._stream_sample_rate * 1000
            return PlaybackProgressSnapshot(
                playback_started=self._playback_started,
                played_ms=min(round(played_ms, 2), float(duration_ms)),
                played_samples=played_samples,
                buffered_ms=round(buffered_ms, 2),
                segment_finished=bool(self._stream_finished and self._available_bytes_locked() <= 0 and self._drained.is_set()),
                duration_ms=duration_ms,
                rms=self._level_rms,
                peak=self._level_peak,
            )

    def stop_stream(self) -> None:
        with self._buffer_lock:
            self._cancel_idle_stop_locked()
            self._streaming = False
            self._stream_finished = True
            self._buffer.clear()
            self._buffer_read_pos = 0
            self._played_bytes = 0
            self._stream_sample_rate = 0
            self._stream_channels = 1
            self._max_buffer_bytes = 0
            self._level_rms = 0.0
            self._level_peak = 0.0
            self._drained.set()
            self._buffer_lock.notify_all()
        if self._stream is not None:
            AUDIO_EXECUTOR.call(self._close_sounddevice_stream)
        if self._mirror is not None:
            self._mirror.stop_stream()

    def _close_sounddevice_stream(self) -> None:
        try:
            self._stream.stop()
            self._stream.close()
        except Exception:
            pass
        self._stream = None

    @property
    def is_streaming(self) -> bool:
        return self._streaming and self._stream is not None

    @property
    def supports_streaming(self) -> bool:
        return self._sd_available

    def start(self) -> None:
        if not self._winsound_available:
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="tts-audio-player", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        self.stop_stream()
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None

    def enqueue(self, path: Path) -> None:
        self.enqueue_and_wait(path, wait=False)

    def enqueue_and_wait(self, path: Path, *, wait: bool = True, timeout_ms: int | None = None) -> bool:
        if not self._winsound_available:
            return False
        completed = threading.Event() if wait else None
        self._queue.put((path, completed))
        self._wake.set()
        if completed is None:
            return True
        timeout_seconds = None if timeout_ms is None else max(timeout_ms / 1000, 0.0)
        return completed.wait(timeout=timeout_seconds)

    def play_pcm_and_wait(
        self,
        *,
        pcm_bytes: bytes,
        sample_rate: int,
        timeout_ms: int,
        prebuffer_ms: int = 60,
        rebuffer_ms: int = 120,
    ) -> bool:
        if not self._sd_available:
            return False
        self.start_stream(sample_rate=sample_rate, prebuffer_ms=prebuffer_ms, rebuffer_ms=rebuffer_ms)
        self.feed(pcm_bytes)
        self.finish_stream()
        return self.wait_until_drained(timeout_ms)

    def play_streaming_chunks_and_wait(
        self,
        *,
        sample_rate: int,
        chunk_source,
        timeout_ms: int,
        prebuffer_ms: int = 60,
        rebuffer_ms: int = 120,
    ) -> bool:
        if not self._sd_available:
            return False
        self.start_stream(sample_rate=sample_rate, prebuffer_ms=prebuffer_ms, rebuffer_ms=rebuffer_ms)
        try:
            for chunk in chunk_source:
                self.feed(chunk)
        finally:
            self.finish_stream()
        return self.wait_until_drained(timeout_ms)

    def play_file_as_pcm_and_wait(self, *, path: Path, timeout_ms: int, prebuffer_ms: int = 60, rebuffer_ms: int = 120) -> bool:
        if not self._sd_available:
            return False
        try:
            with wave.open(str(path), "rb") as wav_file:
                sample_rate = wav_file.getframerate()
                channels = wav_file.getnchannels()
                pcm_bytes = wav_file.readframes(wav_file.getnframes())
        except (wave.Error, FileNotFoundError):
            return False
        if sample_rate <= 0 or channels <= 0:
            return False
        self.start_stream(sample_rate=sample_rate, channels=channels, prebuffer_ms=prebuffer_ms, rebuffer_ms=rebuffer_ms)
        self.feed(pcm_bytes)
        self.finish_stream()
        return self.wait_until_drained(timeout_ms)

    def cancel_all(self) -> None:
        with self._file_lock:
            while not self._queue.empty():
                try:
                    _, completed = self._queue.get_nowait()
                except Exception:
                    break
                if completed is not None:
                    completed.set()
        self.stop_stream()

    def _available_bytes_locked(self) -> int:
        return max(len(self._buffer) - self._buffer_read_pos, 0)

    def _compact_buffer_locked(self) -> None:
        if self._buffer_read_pos <= 0:
            return
        if self._buffer_read_pos >= len(self._buffer):
            self._buffer.clear()
            self._buffer_read_pos = 0
            return
        if self._buffer_read_pos >= len(self._buffer) // 2:
            del self._buffer[:self._buffer_read_pos]
            self._buffer_read_pos = 0

    def _ensure_silence_capacity_locked(self, needed: int) -> None:
        if needed > len(self._silence_buffer):
            self._silence_buffer.extend(b"\x00" * (needed - len(self._silence_buffer)))

    def _write_silence(self, outdata, start: int, count: int) -> None:
        if count <= 0:
            return
        if count > len(self._silence_buffer):
            with self._buffer_lock:
                self._ensure_silence_capacity_locked(count)
        view = memoryview(self._silence_buffer)
        outdata[start:start + count] = view[:count]
        del view

    def _fill_silence_now(self, outdata, start: int, count: int) -> None:
        """无锁静音填充：仅在音频回调拿不到缓冲锁时使用。

        绝不访问共享缓冲（_silence_buffer 可能正被锁内扩容），
        只用 outdata 自身可写的零填充。兼容 sounddevice numpy 数组与
        测试用 bytearray。
        """
        if count <= 0:
            return
        try:
            outdata.fill(0)
        except AttributeError:
            try:
                outdata[start : start + count] = b"\x00" * count
            except Exception:
                pass

    @property
    def is_playing(self) -> bool:
        return self._current_file is not None or self._streaming

    @property
    def ready(self) -> bool:
        return self._sd_available or self._winsound_available

    def _run(self) -> None:
        import winsound

        while not self._stop.is_set():
            self._wake.wait(timeout=0.1)
            self._wake.clear()
            while not self._stop.is_set():
                if self._queue.empty():
                    break
                path, completed = self._queue.get()
                self._current_file = path
                try:
                    winsound.PlaySound(str(path), winsound.SND_FILENAME)
                except Exception:
                    pass
                finally:
                    self._current_file = None
                    if completed is not None:
                        completed.set()
