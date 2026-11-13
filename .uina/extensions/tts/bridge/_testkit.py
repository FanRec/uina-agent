"""_testkit.py — Bridge 测试支持：假声卡与假 Vendor。

FakeSink 与真实 AudioSink 保持同一接口（lane/worker/feed/service 视角），
用一条消费线程模拟设备拉取：立即消费可用 PCM（不做实时 pacing），
产生与真实回调一致的 started/completed 转换与欠载计数。
"""
from __future__ import annotations

import io
import threading
import time
import wave
from collections import deque
from typing import Any

from audio_playback import Transition
from models import PlaybackProgressSnapshot


class _FakeSegment:
    """FakeSink 的句段句柄：属性名与真实 _SinkSegment 对齐。"""

    def __init__(self, trace_id: str, index: int, task_id: str, start: int) -> None:
        self.trace_id = trace_id
        self.index = index
        self.task_id = task_id
        self.start_frame = start
        self.end_frame = start
        self.final = False
        self.dropped = False
        self.started = False
        self.completed = False


class FakeSink:
    """测试用声卡：接口与 AudioSink 对齐，消费速度由 pacing 控制。"""

    def __init__(self, *, sample_rate: int = 32000, ready: bool = True, realtime: bool = False,
                 consume_per_tick: int | None = None, consume_interval_s: float = 0.004) -> None:
        self.ready = ready
        self._consume_per_tick = consume_per_tick
        self._consume_interval_s = consume_interval_s
        self._sample_rate = sample_rate
        self._lock = threading.Condition()
        self._buffer = bytearray()
        self._buffer_frames = 0
        self._played_frames = 0
        self._playback_started = False
        self._streaming = False
        self._active = False
        self._expecting = False
        self._underruns = 0
        self._segments: deque[_FakeSegment] = deque()
        self._transitions: list[Transition] = []
        self._max_buffer_frames = sample_rate * 2
        self._appended: list[tuple[str, int, bytes]] = []  # (task_id, start_frame, bytes)
        self._discarded: list[int] = []
        self._opened: list[int] = []
        self._realtime = realtime
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="fake-sink-consumer", daemon=True)
        self._thread.start()

    # ── 与 AudioSink 相同的接口 ─────────────────────────────────────────

    @property
    def mirror(self) -> None:
        return None

    @property
    def lock_skips(self) -> int:
        return 0

    @property
    def underruns(self) -> int:
        with self._lock:
            return self._underruns

    @property
    def is_open(self) -> bool:
        with self._lock:
            return self._streaming

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    def open(self, sample_rate: int, channels: int = 1) -> None:
        if not self.ready:
            raise RuntimeError("audio output is unavailable on this machine")
        with self._lock:
            self._sample_rate = sample_rate
            self._streaming = True
            self._playback_started = False
            self._played_frames = 0
            self._buffer.clear()
            self._buffer_frames = 0
            self._segments.clear()
            self._opened.append(sample_rate)
            self._lock.notify_all()

    def close(self) -> None:
        with self._lock:
            self._streaming = False
            self._buffer.clear()
            self._buffer_frames = 0
            self._segments.clear()
            self._lock.notify_all()

    def set_active(self, active: bool) -> None:
        with self._lock:
            self._active = active

    def set_expecting(self, expecting: bool) -> None:
        with self._lock:
            self._expecting = expecting

    def buffered_ms(self) -> float:
        with self._lock:
            return self._buffer_frames / max(self._sample_rate, 1) * 1000

    def buffered_frames(self) -> int:
        with self._lock:
            return self._buffer_frames

    def played_frames(self) -> int:
        with self._lock:
            return self._played_frames

    def capacity_frames(self) -> int:
        return self._max_buffer_frames

    def wait_for_capacity(self, frames: int, *, timeout: float = 0.25) -> bool:
        with self._lock:
            deadline = time.perf_counter() + timeout
            while self._buffer_frames > 0 and self._buffer_frames + frames > self._max_buffer_frames:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    return False
                self._lock.wait(remaining)
            return True

    def register_segment(self, *, trace_id: str, index: int, task_id: str) -> _FakeSegment:
        with self._lock:
            start = self._played_frames + self._buffer_frames
            segment = _FakeSegment(trace_id, index, task_id, start)
            self._segments.append(segment)
            return segment

    def append(self, handle: _FakeSegment, pcm: bytes) -> None:
        if not pcm:
            return
        with self._lock:
            if handle.dropped:
                raise RuntimeError("segment was discarded (cancelled)")
            if not self._segments or self._segments[-1] is not handle:
                raise RuntimeError("stale segment write rejected")
            frames = len(pcm) // 2
            self._buffer.extend(pcm)
            self._buffer_frames += frames
            handle.end_frame = self._played_frames + self._buffer_frames
            self._appended.append((handle.task_id, handle.start_frame, pcm))
            self._lock.notify_all()

    def finalize_segment(self, handle: _FakeSegment) -> None:
        with self._lock:
            if handle.dropped:
                return
            handle.end_frame = self._played_frames + self._buffer_frames
            handle.final = True
            self._lock.notify_all()

    def discard_unplayed_from(self, frame: int, *, drop_straddler: bool = False) -> int:
        with self._lock:
            keep = max(frame - self._played_frames, 0)
            dropped = max(self._buffer_frames - keep, 0)
            if dropped:
                self._buffer_frames = keep
                del self._buffer[keep * 2:]
            while self._segments and self._segments[-1].start_frame >= frame:
                self._segments.pop().dropped = True
            if drop_straddler and self._segments and self._segments[-1].end_frame >= frame:
                self._segments.pop().dropped = True
            if dropped:
                self._discarded.append(frame)
            self._lock.notify_all()
            return dropped

    def take_transitions(self) -> list[Transition]:
        with self._lock:
            out = self._transitions
            self._transitions = []
            return out

    def snapshot(self, *, duration_ms: int = 0, playback_id: str | None = None) -> PlaybackProgressSnapshot:
        with self._lock:
            finished = not self._active and self._buffer_frames == 0 and not self._segments
            return PlaybackProgressSnapshot(
                playback_started=self._playback_started and self._played_frames > 0,
                played_ms=round(self._played_frames / max(self._sample_rate, 1) * 1000, 2),
                played_frames=self._played_frames,
                buffered_ms=round(self._buffer_frames / max(self._sample_rate, 1) * 1000, 2),
                segment_finished=finished,
                duration_ms=duration_ms,
                state="playing" if self._playback_started else "idle",
                clock_quality="submitted_samples",
            )

    # ── 测试观测 ────────────────────────────────────────────────────────

    def appended_bytes(self, task_id: str | None = None) -> bytes:
        with self._lock:
            if task_id is None:
                return b"".join(item[2] for item in self._appended)
            return b"".join(item[2] for item in self._appended if item[0] == task_id)

    def append_log(self) -> list[tuple[str, int, bytes]]:
        with self._lock:
            return list(self._appended)

    def discard_log(self) -> list[int]:
        with self._lock:
            return list(self._discarded)

    def open_log(self) -> list[int]:
        with self._lock:
            return list(self._opened)

    def stop_sink(self) -> None:
        self._stop.set()
        with self._lock:
            self._lock.notify_all()

    # ── 消费线程（模拟设备拉取） ────────────────────────────────────────

    def _run(self) -> None:
        while not self._stop.is_set():
            with self._lock:
                if not self._streaming:
                    self._lock.wait(timeout=0.005)
                    continue
                # 缓冲已空也要检查转换：句段可能在最后一次消费后才 finalize。
                self._emit_locked()
                if self._buffer_frames == 0 or not self._segments:
                    self._lock.wait(timeout=0.005)
                    continue
                if not self._playback_started:
                    # 模拟真实设备的启动预缓冲语义：等 start 门槛或生产者收尾。
                    self._playback_started = True
                self._emit_locked()
                head = self._segments[0]
                available = self._buffer_frames
                if available <= 0:
                    if self._expecting or self._active:
                        self._underruns += 1
                    self._lock.wait(timeout=0.005)
                    continue
                if self._realtime:
                    take = min(available, max(self._sample_rate // 100, 1))
                elif self._consume_per_tick is not None:
                    take = min(available, self._consume_per_tick)
                else:
                    take = available
                del self._buffer[:take * 2]
                self._buffer_frames -= take
                self._played_frames += take
                self._lock.notify_all()
            if self._realtime:
                time.sleep(take / self._sample_rate)
            with self._lock:
                self._emit_locked()

    def _emit_locked(self) -> None:
        while self._segments:
            head = self._segments[0]
            if not head.started and self._played_frames > head.start_frame:
                head.started = True
                self._transitions.append(Transition("started", head.trace_id, head.index, head.task_id))
            if head.final and not head.completed and self._played_frames >= head.end_frame:
                head.completed = True
                self._transitions.append(Transition("completed", head.trace_id, head.index, head.task_id))
                self._segments.popleft()
                continue
            break


class FakeVendor:
    """可控 Vendor：流式分块产出、可编程失败与停滞。"""

    def __init__(self, *, chunk_size: int = 3200, sample_rate: int = 32000, chunk_delay_s: float = 0.0) -> None:
        self.chunk_size = chunk_size
        self.sample_rate = sample_rate
        self.chunk_delay_s = chunk_delay_s
        self.process = None
        self.ownership = "external"
        self.stream_handlers: list[Any] = []  # callable(payload) -> bytes | Exception | None(默认)
        self.batch_handlers: list[Any] = []
        # (matcher, data, exception)：先产出 data，随后抛出异常（中途失败）
        self.stream_fail_after: list[Any] = []
        self.calls: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def ready(self) -> bool:
        return True

    def ensure_running(self) -> bool:
        return False

    def wait_until_ready(self, timeout: int) -> bool:
        return True

    def close(self) -> None:
        pass

    def _handler_for(self, text: str, handlers: list[Any]) -> Any:
        for matcher, handler in handlers:
            if matcher in text:
                return handler
        return None

    def on_stream(self, matcher: str, handler: Any) -> None:
        self.stream_handlers.append((matcher, handler))

    def on_batch(self, matcher: str, handler: Any) -> None:
        self.batch_handlers.append((matcher, handler))

    def on_stream_fail_after(self, matcher: str, data: bytes, exception: Exception) -> None:
        self.stream_fail_after.append((matcher, data, exception))

    def synthesize_stream(self, payload: dict[str, Any], **kwargs) -> Any:
        with self._lock:
            self.calls.append({"kind": "stream", "payload": dict(payload), "kwargs": kwargs})
        text = payload["text"]
        for matcher, data, exception in self.stream_fail_after:
            if matcher in text:
                cancel = kwargs.get("cancel_event")

                def failing():
                    offset = 0
                    while offset < len(data):
                        if cancel is not None and cancel.is_set():
                            return
                        yield data[offset:offset + self.chunk_size]
                        offset += self.chunk_size
                        if self.chunk_delay_s:
                            time.sleep(self.chunk_delay_s)
                    raise exception

                return failing()
        handler = self._handler_for(text, self.stream_handlers)
        if handler is not None:
            result = handler(payload)
            if isinstance(result, Exception):
                raise result
            if result is None:
                return iter(())
            data = result
        else:
            data = b"\x01\x00" * self.sample_rate  # 默认 1 秒 PCM
        cancel = kwargs.get("cancel_event")

        def generate():
            offset = 0
            while offset < len(data):
                if cancel is not None and cancel.is_set():
                    return
                yield data[offset:offset + self.chunk_size]
                offset += self.chunk_size
                if self.chunk_delay_s:
                    time.sleep(self.chunk_delay_s)

        return generate()

    async def synthesize_file(self, payload: dict[str, Any], *, timeout_ms: int) -> Any:
        import asyncio

        return await asyncio.to_thread(self.synthesize, payload, timeout_ms=timeout_ms)

    def synthesize(self, payload: dict[str, Any], **kwargs) -> Any:
        import httpx

        with self._lock:
            self.calls.append({"kind": "batch", "payload": dict(payload), "kwargs": kwargs})
        text = payload["text"]
        handler = self._handler_for(text, self.batch_handlers)
        if handler is not None:
            result = handler(payload)
            if isinstance(result, Exception):
                raise result
            if isinstance(result, httpx.Response):
                return result
        return httpx.Response(200, content=_wav_bytes(b"\x02\x00" * self.sample_rate, self.sample_rate))


def _wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    with io.BytesIO() as buffer:
        with wave.open(buffer, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            output.writeframes(pcm)
        return buffer.getvalue()
