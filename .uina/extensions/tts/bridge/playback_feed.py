"""playback_feed.py — 播放事实的唯一发布者与设备控制线程。

- PlaybackEventHub：终局转换事件（不可重复）的 SSE 扇出；
- SubtitleEstimator：按真实播放帧估计字符揭示进度（含原文↔vendor 映射），
  流式段未结束时用每字时长 EMA 作临时分母，合成结束后改用真实帧数；
- PlaybackFeed：唯一的设备输出消费者。把 AudioSink 的真实播放转换投影成
  Lane 状态与事件，按需开关声卡，刷新播放快照，执行保留策略。
  不通过定时器假装播放，不持有第二本播放账。
"""
from __future__ import annotations

import json
import math
import threading
import time
from datetime import datetime, timezone
from queue import Empty, Full, Queue
from typing import Any, Iterator
from uuid import uuid4

from audio_playback import AudioSink
from delivery_lane import DeliveryLane
from models import Segment, Source, StreamingConfig
from playback_projection import PlaybackProjection, PlaybackSnapshotHub
from synthesis_handlers import align_original_to_vendor

STREAM_END = object()

TERMINAL_TASK_TTL_SECONDS = 3600
MAX_TERMINAL_TASKS = 1000


class PlaybackEventHub:
    """终局播放事件的扇出通道。SSE 断连可能漏事件；权威状态按需读取。"""

    def __init__(self) -> None:
        self.subscribers: dict[str, list[Queue[dict[str, Any] | object]]] = {}
        self.stop_event = threading.Event()
        self._lock = threading.RLock()

    def close(self) -> None:
        self.stop_event.set()
        with self._lock:
            subscribers = [
                subscriber
                for subscriber_list in self.subscribers.values()
                for subscriber in subscriber_list
            ]
            self.subscribers.clear()
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(STREAM_END)
            except Full:
                pass

    def publish(
        self,
        kind: str,
        *,
        trace_id: str | None = None,
        generation_id: int | None = None,
        segment_index: int | None = None,
        task_id: str | None = None,
        detail: dict[str, Any] | None = None,
        traceparent: str | None = None,
    ) -> None:
        if not trace_id:
            return
        event = {
            "event_id": f"tts_evt_{uuid4().hex}",
            "kind": kind,
            "trace_id": trace_id,
            "generation_id": generation_id,
            "segment_index": segment_index,
            "task_id": task_id,
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "detail": {
                **(detail or {}),
                **({"traceparent": traceparent} if traceparent else {}),
            },
        }
        with self._lock:
            subscribers = list(self.subscribers.get(trace_id, []))
            if trace_id != "*":
                subscribers.extend(self.subscribers.get("*", []))
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(event)
            except Full:
                pass

    def stream(self, trace_id: str | None = None) -> Iterator[str]:
        subscription_key = trace_id or "*"
        queue: Queue[dict[str, Any] | object] = Queue(maxsize=128)
        with self._lock:
            if self.stop_event.is_set():
                return
            self.subscribers.setdefault(subscription_key, []).append(queue)
        try:
            yield ": connected\n\n"
            while not self.stop_event.is_set():
                try:
                    item = queue.get(timeout=15)
                except Empty:
                    # SSE 心跳：客户端 fetch 有空闲 body 超时（undici 默认 300s），
                    # 无事件期间不发注释会被静默断开（与 PlaybackSnapshotHub 同一模式）。
                    yield ": heartbeat\n\n"
                    continue
                if item is STREAM_END:
                    break
                yield f"event: tts.playback\ndata: {json.dumps(item, ensure_ascii=False)}\n\n"
        finally:
            with self._lock:
                subscribers = self.subscribers.get(subscription_key, [])
                if queue in subscribers:
                    subscribers.remove(queue)
                if not subscribers:
                    self.subscribers.pop(subscription_key, None)


class SubtitleEstimator:
    """按真实播放帧估计字符揭示进度；只称估计，终局不早于末样本。"""

    def __init__(self, *, initial_ms_per_char: float = 270.0) -> None:
        self.ms_per_char = initial_ms_per_char
        self._lock = threading.Lock()

    def estimate_total_ms(self, segment: Segment, sample_rate: int) -> float:
        """段总时长：合成结束后用真实帧数；流式中用每字时长 EMA 临时分母。"""
        if segment.pcm_final and segment.pcm_start_frame is not None and sample_rate > 0:
            return max((segment.pcm_end_frame - segment.pcm_start_frame) / sample_rate * 1000, 1.0)
        compact = sum(1 for ch in segment.original_text if not ch.isspace())
        if compact <= 0:
            return 400.0
        with self._lock:
            ms_per_char = self.ms_per_char * 1.03
        return max(compact * ms_per_char, 400.0)

    def reveal(self, segment: Segment, played_frame: int, sample_rate: int) -> tuple[int, str]:
        """返回 (原文已揭示字符数, 揭示文本)。文字映射走原文↔vendor 对齐。"""
        original = segment.original_text
        if segment.pcm_start_frame is None or sample_rate <= 0:
            return 0, ""
        played_in_seg = min(max(played_frame - segment.pcm_start_frame, 0), max(segment.pcm_end_frame - segment.pcm_start_frame, 0))
        total_ms = self.estimate_total_ms(segment, sample_rate)
        played_ms = played_in_seg / sample_rate * 1000
        vendor_len = len(segment.text)
        if vendor_len == 0:
            return 0, ""
        finished = segment.pcm_final and segment.pcm_end_frame > 0 and played_frame >= segment.pcm_end_frame
        if finished:
            revealed_vendor = vendor_len
        else:
            revealed_vendor = min(vendor_len, math.floor(played_ms / total_ms * vendor_len))
        mapping = align_original_to_vendor(original, segment.text)
        if revealed_vendor <= 0:
            return 0, ""
        original_index = mapping[revealed_vendor - 1] + 1 if revealed_vendor <= len(mapping) else len(original)
        return original_index, original[:original_index]

    def learn(self, segment: Segment, sample_rate: int) -> None:
        """合成结束后用真实时长更新每字时长 EMA（仅为估算服务）。"""
        if not (segment.pcm_final and segment.pcm_start_frame is not None) or sample_rate <= 0:
            return
        actual_ms = (segment.pcm_end_frame - segment.pcm_start_frame) / sample_rate * 1000
        compact = sum(1 for ch in segment.original_text if not ch.isspace())
        if actual_ms <= 0 or compact <= 0:
            return
        actual_per_char = actual_ms / compact
        with self._lock:
            self.ms_per_char = 0.5 * self.ms_per_char + 0.5 * actual_per_char


class PlaybackFeed(threading.Thread):
    """唯一的设备输出消费者与投影发布者。"""

    def __init__(
        self,
        *,
        lane: DeliveryLane,
        sink: AudioSink,
        hub: PlaybackEventHub,
        projection: PlaybackProjection,
        snapshot_hub: PlaybackSnapshotHub,
        config: StreamingConfig,
        progress_interval_ms: int = 33,
        estimator: SubtitleEstimator | None = None,
    ) -> None:
        super().__init__(name="tts-playback-feed", daemon=True)
        self.lane = lane
        self.sink = sink
        self.hub = hub
        self.projection = projection
        self.snapshot_hub = snapshot_hub
        self.config = config
        self.progress_interval_s = max(progress_interval_ms, 10) / 1000
        self.estimator = estimator or SubtitleEstimator()
        self._wake = threading.Event()
        self._stop_requested = threading.Event()
        self._idle_since: float | None = None
        self._open_failed_for: str | None = None
        self._active_projection_key: tuple[str, int] | None = None
        self._next_retention = time.monotonic() + 60.0

    def wake(self) -> None:
        self._wake.set()

    def stop_feed(self) -> None:
        self._stop_requested.set()
        self._wake.set()

    def run(self) -> None:
        while not self._stop_requested.is_set():
            try:
                timeout = self._tick()
            except Exception as exc:  # 控制线程故障必须可见且自愈，不允许悄悄停摆
                print(f"[TTS][feed] tick error: {type(exc).__name__}: {exc}", flush=True)
                timeout = 0.5
            self._wake.wait(timeout)
            self._wake.clear()

    # ── 每拍工作 ────────────────────────────────────────────────────────

    def _tick(self) -> float | None:
        now = time.monotonic()
        snapshot = self.sink.snapshot()
        played_frame = snapshot.played_frames
        self._apply_sink_transitions(snapshot)
        self._finish_stale_projection()
        head = self.lane.head_source()
        self.sink.set_active(head is not None)
        self.sink.set_expecting(self.lane.head_pending_synthesis())
        if head is not None:
            self._idle_since = None
            self._ensure_sink_open(head)
            timeout: float | None = self.progress_interval_s
        else:
            timeout = self._maybe_idle_close(snapshot, now)
        if time.monotonic() >= self._next_retention:
            self._next_retention = time.monotonic() + 60.0
            self.lane.retention(ttl_seconds=TERMINAL_TASK_TTL_SECONDS, max_tasks=MAX_TERMINAL_TASKS)
        if head is not None and self.sink.is_open:
            self._refresh_projection(head, snapshot)
        return timeout

    def _apply_sink_transitions(self, snapshot: Any) -> None:
        for transition in self.sink.take_transitions():
            segment = self.lane.apply_transition(transition.kind, transition.task_id)
            if segment is None:
                continue
            source = self._source_of(transition.trace_id)
            generation = source.generation_id if source is not None else 1
            if transition.kind == "started":
                self._begin_projection(segment, transition)
                self.hub.publish(
                    "playback_started",
                    trace_id=transition.trace_id,
                    generation_id=generation,
                    segment_index=transition.segment_index,
                    task_id=transition.task_id,
                    detail={"playback_started": True},
                    traceparent=segment.traceparent,
                )
            elif transition.kind == "completed":
                self.estimator.learn(segment, self.config.sample_rate)
                self._finish_projection("completed", transition.trace_id)
                self.hub.publish(
                    "completed",
                    trace_id=transition.trace_id,
                    generation_id=generation,
                    segment_index=transition.segment_index,
                    task_id=transition.task_id,
                    detail={
                        "playback_completed": True,
                        "played_frames": snapshot.played_frames,
                        "underruns": self.sink.underruns,
                    },
                    traceparent=segment.traceparent,
                )
                self._wake.set()  # 来源可能就此释放

    def _begin_projection(self, segment: Segment, transition: Any) -> None:
        self._active_projection_key = (transition.trace_id, transition.segment_index)
        total_ms = int(self.estimator.estimate_total_ms(segment, self.config.sample_rate))
        self.projection.begin_segment(
            trace_id=transition.trace_id,
            generation_id=self._generation_of(transition.trace_id),
            segment_index=transition.segment_index,
            text=segment.original_text,
            duration_ms=total_ms,
        )
        self.snapshot_hub.publish(self.projection.snapshot())

    def _finish_projection(self, reason: str, trace_id: str) -> None:
        if self._active_projection_key is None:
            return
        self.projection.finish(reason)
        self.snapshot_hub.publish(self.projection.snapshot())
        self._active_projection_key = None

    def _finish_stale_projection(self) -> None:
        """被取消/收束的片段不再播放且无新片段接管时，收束物理投影，
        不让 OBS 字幕停留在过期的 playing 状态。"""
        if self._active_projection_key is None:
            return
        trace_id, index = self._active_projection_key
        current = self.lane.playing_segment(trace_id)
        if current is None or current.index != index:
            self._finish_projection("interrupted", trace_id)

    def _refresh_projection(self, head: Source, snapshot: Any) -> None:
        if self._active_projection_key is None:
            return
        self.projection.update_progress(snapshot)
        self.snapshot_hub.publish(self.projection.snapshot())
        segment = self._playing_segment_of(head.id)
        if segment is None:
            return
        revealed_count, revealed_text = self.estimator.reveal(segment, snapshot.played_frames, self.config.sample_rate)
        self.hub.publish(
            "subtitle",
            trace_id=head.id,
            generation_id=head.generation_id,
            segment_index=segment.index,
            task_id=segment.task_id,
            detail={
                "played_ms": snapshot.played_ms,
                "buffered_ms": snapshot.buffered_ms,
                "playback_started": snapshot.playback_started,
                "playback_completed": False,
                "revealed_count": revealed_count,
                "revealed_text": revealed_text,
                "rms": snapshot.rms,
                "peak": snapshot.peak,
            },
            traceparent=segment.traceparent,
        )

    def _ensure_sink_open(self, head: Source) -> None:
        if self.sink.is_open:
            self._open_failed_for = None
            self.lane.set_sink_ready(True)
            return
        if self._open_failed_for == head.id:
            return  # 已对该来源失败过：不再反复尝试，等待下一个来源或显式恢复
        try:
            self.sink.open(self.config.sample_rate, 1)
        except Exception as exc:
            self._open_failed_for = head.id
            print(f"[TTS][audio] device open failed: {exc}", flush=True)
            self.lane.set_sink_ready(False)
            failed = self.lane.fail_source(head.id, f"audio device unavailable: {exc}")
            for segment in failed:
                self.hub.publish(
                    "failed",
                    trace_id=head.id,
                    generation_id=head.generation_id,
                    segment_index=segment.index,
                    task_id=segment.task_id,
                    detail={"error": segment.error, "playback_started": False},
                )
            self._wake.set()
            return
        self.lane.set_sink_ready(True)
        self._wake.set()

    def _maybe_idle_close(self, snapshot: Any, now: float) -> float | None:
        """无活动来源时的设备生命周期：普通控制线程按一次空闲超时关闭。"""
        if not self.sink.is_open:
            return None
        if snapshot.buffered_ms > 0 or snapshot.playback_started and not snapshot.segment_finished:
            self._idle_since = None
            return 0.2
        if self._idle_since is None:
            self._idle_since = now
        remaining = self.config.idle_close_ms / 1000 - (now - self._idle_since)
        if remaining <= 0:
            try:
                self.sink.close()
            finally:
                self.lane.set_sink_ready(False)
            self._idle_since = None
            return None
        return remaining

    # ── Lane 访问辅助 ───────────────────────────────────────────────────

    def _source_of(self, trace_id: str) -> Source | None:
        return self.lane.source_of(trace_id)

    def _generation_of(self, trace_id: str) -> int:
        source = self._source_of(trace_id)
        return source.generation_id if source is not None else 1

    def _playing_segment_of(self, trace_id: str) -> Segment | None:
        return self.lane.playing_segment(trace_id)
