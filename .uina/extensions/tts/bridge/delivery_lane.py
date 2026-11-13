"""delivery_lane.py — DeliveryLane：Source/Segment 交付事实的唯一所有者。

职责：
- 受理表（幂等 segment_id、Session/Epoch、来源 FIFO、按 index 连续受理）；
- 封口/取消/失败的业务状态推进与来源释放（head 排空后交棒下一来源）；
- 为 SynthesisWorker 提供下一个可执行片段，为 PlaybackFeed 提供状态投影。

不操作声卡、不管理 Vendor 进程、不解析文本语义。
一把锁（Condition）推进全部业务状态；物理播放状态只能由 AudioSink
的真实播放转换（started/completed）或本类的取消/失败收束改变。
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Any
from uuid import uuid4

from models import (
    SYNTHESIS_TERMINAL,
    BridgeError,
    Segment,
    Source,
    StreamingConfig,
)


def playback_state_word(segment: Segment) -> str:
    """播放维度的对外状态词（/subtitle-state 与 Driver 对账用）。"""
    if segment.playback == "completed":
        return "completed"
    if segment.playback == "failed":
        return "failed"
    if segment.playback in {"cancelled", "unknown"}:
        return "cancelled"
    if segment.playback == "playing":
        return "playing"
    if segment.synthesis == "running":
        return "synthesizing"
    return "pending"


def task_status_word(segment: Segment) -> str:
    """任务维度的对外状态词（受理回执与 /tasks 查询共用）。"""
    if segment.playback == "completed":
        return "delivered"
    if segment.playback == "failed":
        return "failed"
    if segment.playback in {"cancelled", "unknown"}:
        return "cancelled"
    if segment.synthesis == "running":
        return "in_progress"
    if segment.synthesis == "queued":
        return "accepted"
    return "in_progress"


class DeliveryLane:
    def __init__(self, config: StreamingConfig) -> None:
        self.config = config
        self.condition = threading.Condition()
        self._sources: dict[str, Source] = {}
        self._source_order: OrderedDict[str, None] = OrderedDict()
        self._tasks: dict[str, Segment] = {}
        self._epoch_by_session: dict[str, str] = {}
        self._blocked_sessions: set[str] = set()
        self._reset_results: dict[str, dict[str, Any]] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._sink_ready = False
        self._closed = False
        # 物理丢弃钩子（服务注入 sink.discard_unplayed_from）：取消与丢弃在
        # 同一把锁事务内完成，后续来源的 PCM 不可能写进未清理的时间线。
        self.discard_hook: Any = None

    # ── Session / Epoch ─────────────────────────────────────────────────

    def reconnect(self, session_id: str) -> dict[str, Any]:
        with self.condition:
            epoch = self._epoch_by_session.setdefault(session_id, uuid4().hex)
        return {"status": "reconnected", "session_id": session_id, "epoch": epoch}

    def reset(
        self,
        session_id: str,
        expected_epoch: str | None = None,
        new_epoch: str | None = None,
        invocation_id: str | None = None,
        *,
        stop_source: Any,
    ) -> dict[str, Any]:
        """轮换代次。旧来源必须全部确认停止后才启用新 epoch。

        `stop_source` 是服务注入的停止执行器（cancel_source 的包装），
        本类不直接操作声卡。
        """
        key = invocation_id or f"reset:{session_id}:{expected_epoch or ''}:{new_epoch or ''}"
        with self.condition:
            cached = self._reset_results.get(key)
            if cached is not None:
                return dict(cached)
            current = self._epoch_by_session.get(session_id)
        # 冻结受理：reset 的停止循环期间，旧 epoch 的新受理会逃过清理。
        with self.condition:
            self._blocked_sessions.add(session_id)
        if expected_epoch is not None and current is not None and current != expected_epoch:
            return {"status": "failed", "reason": "expected_epoch 不匹配", "session_id": session_id, "epoch": current}
        with self.condition:
            trace_ids = [
                trace_id
                for trace_id, source in self._sources.items()
                if source.session_id == session_id
                and (source.input == "open" or any(not segment.terminal for segment in source.segments.values()))
            ]
        stop_failures: list[str] = []
        for trace_id in trace_ids:
            try:
                result = stop_source(trace_id, session_id)
                if result.get("stop_outcome") == "unknown":
                    stop_failures.append(f"{trace_id}: {result.get('status')}")
            except Exception as exc:
                stop_failures.append(f"{trace_id}: {type(exc).__name__}: {exc}")
        if stop_failures:
            # 旧 epoch 的停止未全部确认：不能宣称 reset 成功、不能让新 epoch 出声。
            # 冻结解除：reset 已失败，旧 epoch 的正常运行（含受理）继续。
            with self.condition:
                self._blocked_sessions.discard(session_id)
            return {
                "status": "unknown",
                "session_id": session_id,
                "epoch": current,
                "stopped_traces": trace_ids,
                "stop_failures": stop_failures,
                "reason": "旧 epoch 的停止未全部确认，new epoch 未启用",
            }
        epoch = new_epoch or uuid4().hex
        result = {"status": "reset", "session_id": session_id, "previous_epoch": current, "epoch": epoch, "stopped_traces": trace_ids}
        with self.condition:
            self._epoch_by_session[session_id] = epoch
            self._blocked_sessions.discard(session_id)
            self._reset_results[key] = result
        return result

    # ── 受理 ────────────────────────────────────────────────────────────

    def admit(self, request: Any, *, vendor_text: str, traceparent: str | None = None) -> dict[str, Any]:
        """受理一个句段。受理事实与加入来源 FIFO 在同一锁事务内完成。"""
        session_id = request.session_id or request.trace_id
        with self.condition:
            if self._closed:
                raise BridgeError(503, "tts bridge is stopping")
            if session_id in self._blocked_sessions:
                raise BridgeError(409, "正在停止旧声音，未受理新台词")
            epoch = self._epoch_by_session.setdefault(session_id, uuid4().hex)
            if request.session_id is not None and request.epoch is None:
                raise BridgeError(409, "缺少本次会话的执行身份")
            if request.epoch is not None and request.epoch != epoch:
                raise BridgeError(409, {"reason": "epoch 已失效", "session_id": session_id})
            # 幂等重放优先于来源状态检查：同 ID 同身份重放返回当前真实状态，
            # 不被"来源已封口/索引不连续"拦成新拒绝；同 ID 不同身份明确冲突。
            existing = self._tasks.get(request.segment_id)
            if existing is not None:
                owner = self._source_of_task(existing)
                same_request = (
                    owner is not None
                    and owner.id == request.trace_id
                    and existing.index == int(request.index)
                    and existing.original_text == request.text
                    and existing.text == vendor_text
                )
                if not same_request:
                    raise BridgeError(409, f"task_id already belongs to another request: {request.segment_id}")
                return self._receipt_for(existing, request, deduplicated=True)
            index = int(request.index)
            if index < 1:
                raise BridgeError(409, "segment index 从 1 开始")
            source = self._sources.get(request.trace_id)
            if source is not None:
                if source.input == "cancelled":
                    raise BridgeError(409, "来源已经取消，未受理晚到台词")
                if source.input == "sealed":
                    raise BridgeError(409, "发声来源已封口")
                if index != source.last_accepted_index + 1:
                    raise BridgeError(
                        409,
                        f"segment index 必须连续：期望 {source.last_accepted_index + 1}，收到 {index}",
                    )
            elif index != 1:
                raise BridgeError(409, "新发声来源必须从第 1 段开始")
            # 受理边界容量：超限明确拒绝，不受理后按年龄清除。
            source_pending = source.pending_count() if source is not None else 0
            total_pending = sum(item.pending_count() for item in self._sources.values())
            source_chars = sum(len(segment.original_text) for segment in source.segments.values()) if source is not None else 0
            if source_pending >= self.config.max_source_pending_segments:
                raise BridgeError(503, "来源待播句段超过容量上限")
            if source_chars + len(request.text) > self.config.max_source_pending_chars:
                raise BridgeError(503, "来源待播文本超过容量上限")
            if total_pending >= self.config.max_total_pending_segments:
                raise BridgeError(503, "交付队列积压超过容量上限")
            generation_id = source.generation_id if source is not None else max(int(request.generation_id or 1), 1)
            now = time.time()
            if source is None:
                source = Source(
                    id=request.trace_id,
                    session_id=session_id,
                    epoch=epoch,
                    generation_id=generation_id,
                    accepted_at=now,
                )
                self._sources[request.trace_id] = source
                self._source_order[request.trace_id] = None
            segment = Segment(
                index=index,
                task_id=request.segment_id,
                text=vendor_text,
                original_text=request.text,
                cancel_token=f"cancel_{uuid4().hex[:16]}",
                traceparent=traceparent,
                accepted_at=now,
            )
            source.segments[index] = segment
            source.last_accepted_index = index
            self._tasks[request.segment_id] = segment
            self.condition.notify_all()
            return self._receipt_for(segment, request)

    def _receipt_for(self, segment: Segment, request: Any, *, deduplicated: bool = False) -> dict[str, Any]:
        source = self._sources.get(request.trace_id)
        receipt: dict[str, Any] = {
            "status": "accepted",
            "task_id": segment.task_id,
            "cancel_token": segment.cancel_token,
            "trace_id": request.trace_id,
            "generation_id": source.generation_id if source is not None else 1,
            "segment_index": segment.index,
            "session_id": request.session_id or request.trace_id,
            "epoch": source.epoch if source is not None else None,
        }
        if deduplicated:
            receipt["deduplicated"] = True
            receipt["status"] = task_status_word(segment)
        return receipt

    # ── 封口 ────────────────────────────────────────────────────────────

    def seal(self, request: Any) -> dict[str, Any]:
        """幂等关闭来源输入。accepted 只表示不再接收新句，不表示已说完。"""
        with self.condition:
            source = self._sources.get(request.trace_id)
            if source is None:
                return {"status": "not_found", "trace_id": request.trace_id}
            if request.generation_id is not None and source.generation_id != int(request.generation_id):
                return {"status": "stale", "trace_id": request.trace_id, "generation_id": source.generation_id}
            if request.epoch is not None:
                current = self._epoch_by_session.get(source.session_id)
                if current is not None and request.epoch != current:
                    return {"status": "stale", "trace_id": request.trace_id, "reason": "epoch 已失效"}
            already = source.input == "sealed"
            source.input = "sealed"
            source.sealed_at = source.sealed_at or time.time()
            self._maybe_release_head_locked()
            self.condition.notify_all()
        return {
            "status": "accepted",
            "trace_id": request.trace_id,
            "last_segment_index": source.last_accepted_index,
            "already_sealed": already,
        }

    # ── 取消 ────────────────────────────────────────────────────────────

    def cancel_task(self, request: Any, *, played_frame: int) -> dict[str, Any]:
        """取消单个句段。

        已有 PCM 的句段：从其播放位置（在播）或起点（待播）丢弃未播样本，
        并连带取消其后同来源未终结片段（连续缓冲无法只截断中段而保住后段）。
        """
        with self.condition:
            segment = self._tasks.get(request.task_id)
            if segment is None:
                return {"status": "not_found", "task_id": request.task_id, "cancel_token": ""}
            source = self._source_of_task(segment)
            if source is None or source.id != request.trace_id:
                return {"status": "not_found", "task_id": request.task_id, "cancel_token": ""}
            if segment.terminal:
                return {"status": "too_late", "task_id": segment.task_id, "cancel_token": segment.cancel_token}
            stop_frame: int | None = None
            if segment.pcm_start_frame is not None:
                stop_frame = played_frame if segment.playback == "playing" else segment.pcm_start_frame
            cancelled_count = 0
            now = time.time()
            cancelled_tasks: list[dict[str, Any]] = []
            for other in source.segments.values():
                if other.terminal:
                    continue
                if other is segment or (stop_frame is not None and other.index >= segment.index):
                    other.synthesis = "cancelled"
                    other.playback = "cancelled"
                    other.terminal_at = now
                    self._cancel_events.setdefault(other.task_id, threading.Event()).set()
                    cancelled_count += 1
                    cancelled_tasks.append({"task_id": other.task_id, "segment_index": other.index})
            self._maybe_release_head_locked()
            if stop_frame is not None and self.discard_hook is not None:
                self.discard_hook(stop_frame, True)
            self.condition.notify_all()
        return {
            "status": "cancelled",
            "task_id": segment.task_id,
            "cancel_token": segment.cancel_token,
            "cancelled_task_count": cancelled_count,
            "cancelled_tasks": cancelled_tasks,
            "discard_from_frame": stop_frame,
        }

    def cancel_source(self, request: Any, *, played_frame: int, buffered_end_frame: int) -> dict[str, Any]:
        """取消整个来源。

        immediate：丢弃当前播放位置之后的全部未播样本（截断到静音）。
        segment_boundary：允许当前已开始的片段完整到达尾样本，其余取消。
        返回值含 stop_outcome 与逐段截断快照（估计式字符断点）。
        """
        with self.condition:
            if request.session_id is not None:
                source_probe = self._sources.get(request.trace_id)
                if source_probe is not None and source_probe.session_id != request.session_id:
                    raise BridgeError(409, "不能取消另一会话的来源")
                if request.expected_epoch is not None:
                    current = self._epoch_by_session.get(request.session_id)
                    if current is not None and request.expected_epoch != current:
                        raise BridgeError(409, "取消对象的 epoch 已失效")
            source = self._sources.get(request.trace_id)
            if source is None:
                return {
                    "status": "cancelled",
                    "trace_id": request.trace_id,
                    "mode": request.mode,
                    "cancelled_task_count": 0,
                    "playback_stopped": False,
                    "stop_outcome": "not_playing",
                    "cutoff_segments": [],
                }
            generation_id = source.generation_id
            if request.generation_id is not None and source.generation_id != int(request.generation_id):
                raise BridgeError(409, "取消对象的 generation 已失效")

            # 已释放来源（全部片段终结且不再被播放）：取消是纯 no-op，
            # 绝不能触发物理丢弃——那会误删已接管的新来源的 PCM。
            if all(segment.terminal for segment in source.segments.values()):
                cutoff_segments = [
                    self._cutoff_of(segment, played_frame)
                    for segment in source.segments.values()
                    if segment.pcm_start_frame is not None or segment.playback == "completed"
                ]
                return {
                    "status": "cancelled",
                    "trace_id": request.trace_id,
                    "mode": request.mode,
                    "cancelled_task_count": 0,
                    "cancelled_tasks": [],
                    "playback_stopped": False,
                    "stop_outcome": "not_playing",
                    "discard_from_frame": None,
                    "generation_id": generation_id,
                    "cutoff_segments": sorted(cutoff_segments, key=lambda item: item["segment_index"]),
                }

            def _is_audible(segment: Segment) -> bool:
                # "正在播放"以物理事实为准：片段 PCM 已开始出声（即便 started
                # 转换还没来得及投影到 lane），边界模式也必须让它到达尾样本。
                if segment.terminal:
                    return False
                if segment.playback == "playing":
                    return True
                return segment.pcm_start_frame is not None and played_frame > segment.pcm_start_frame

            playing = next((s for s in source.segments.values() if _is_audible(s)), None)
            had_buffered = any(s.pcm_start_frame is not None and not s.terminal for s in source.segments.values())
            source.input = "cancelled"
            source.generation_id += 1
            source.terminal_reason = "cancelled"
            cancelled_count = 0
            discard_from: int | None = None
            if request.mode == "immediate":
                # 只丢弃未播放样本；已进入输出的部分保留事实。
                discard_from = played_frame
            elif playing is not None and playing.pcm_end_frame:
                discard_from = playing.pcm_end_frame
            elif had_buffered:
                discard_from = min(
                    (s.pcm_start_frame for s in source.segments.values() if s.pcm_start_frame is not None and not s.terminal),
                    default=played_frame,
                )
            cutoff_segments: list[dict[str, Any]] = []
            cancelled_tasks: list[dict[str, Any]] = []
            now = time.time()
            for segment in source.segments.values():
                if segment.terminal:
                    if segment.pcm_start_frame is not None or segment.playback == "completed":
                        cutoff_segments.append(self._cutoff_of(segment, played_frame))
                    continue
                if request.mode == "segment_boundary" and segment is playing:
                    cutoff_segments.append(self._cutoff_of(segment, played_frame))
                    continue
                segment.synthesis = "cancelled"
                segment.playback = "cancelled"
                segment.terminal_at = now
                segment.stop_outcome = "stopped" if request.mode == "immediate" else None
                self._cancel_events.setdefault(segment.task_id, threading.Event()).set()
                cancelled_count += 1
                cancelled_tasks.append({"task_id": segment.task_id, "segment_index": segment.index})
            had_live_audio = playing is not None or any(
                s.pcm_start_frame is not None and not s.terminal for s in source.segments.values()
            )
            if request.mode == "segment_boundary" and playing is not None:
                # 片段尚未到达尾样本，响应时刻无法断言已经无声。
                stop_outcome = "unknown"
            elif discard_from is not None and discard_from < buffered_end_frame:
                stop_outcome = "stopped"
            elif request.mode == "immediate" and had_live_audio:
                # 来源仍在合成/播放中（缓冲瞬时为空也要如实报告"已停止"）。
                stop_outcome = "stopped"
            else:
                stop_outcome = "not_playing"
            self._maybe_release_head_locked()
            if discard_from is not None and self.discard_hook is not None:
                self.discard_hook(discard_from, request.mode == "immediate")
            self.condition.notify_all()
        return {
            "status": "cancelled",
            "trace_id": request.trace_id,
            "mode": request.mode,
            "cancelled_task_count": cancelled_count,
            "cancelled_tasks": cancelled_tasks,
            "playback_stopped": stop_outcome == "stopped",
            "stop_outcome": stop_outcome,
            "discard_from_frame": discard_from,
            "generation_id": generation_id,
            "cutoff_segments": sorted(cutoff_segments, key=lambda item: item["segment_index"]),
        }

    def _cutoff_of(self, segment: Segment, played_frame: int) -> dict[str, Any]:
        return {
            "segment_index": segment.index,
            "task_id": segment.task_id,
            "text": segment.original_text,
            "playback_started": segment.playback_started_at is not None or segment.playback in {"playing", "completed"},
            "playback_completed": segment.playback == "completed",
            "played_frames": (
                max(0, min(played_frame - (segment.pcm_start_frame or 0), segment.pcm_end_frame))
                if segment.pcm_start_frame is not None
                else 0
            ),
        }

    # ── 合成执行者接口 ──────────────────────────────────────────────────

    def set_sink_ready(self, ready: bool) -> None:
        with self.condition:
            if self._sink_ready != ready:
                self._sink_ready = ready
                self.condition.notify_all()

    def wait_for_work(self, timeout: float | None) -> tuple[Source, Segment] | None:
        """取队首来源的下一个待合成片段；无工作时阻塞等待通知。"""
        with self.condition:
            work = self._find_work_locked()
            if work is not None or self._closed or timeout is None:
                return work
            self.condition.wait(timeout)
            return self._find_work_locked()

    def _find_work_locked(self) -> tuple[Source, Segment] | None:
        if self._closed or not self._sink_ready:
            return None
        head = self._head_locked()
        if head is None:
            return None
        for index in sorted(head.segments):
            segment = head.segments[index]
            if segment.synthesis == "queued":
                return head, segment
        return None

    def cancel_event_for(self, task_id: str) -> threading.Event:
        with self.condition:
            return self._cancel_events.setdefault(task_id, threading.Event())

    def mark_synthesis_started(self, task_id: str) -> None:
        with self.condition:
            segment = self._tasks.get(task_id)
            if segment is not None and segment.synthesis == "queued":
                segment.synthesis = "running"
                segment.synth_started_at = time.time()
                self.condition.notify_all()

    def record_pcm_start(self, task_id: str, start_frame: int) -> None:
        with self.condition:
            segment = self._tasks.get(task_id)
            if segment is None:
                return
            segment.pcm_start_frame = start_frame
            segment.pcm_end_frame = start_frame
            segment.first_pcm_at = time.time()

    def record_pcm_progress(self, task_id: str, frames: int) -> None:
        with self.condition:
            segment = self._tasks.get(task_id)
            if segment is None or frames <= 0:
                return
            segment.pcm_end_frame += frames

    def mark_synthesis_finished(self, task_id: str) -> None:
        with self.condition:
            segment = self._tasks.get(task_id)
            if segment is None or segment.synthesis in SYNTHESIS_TERMINAL:
                return
            segment.synthesis = "finished"
            segment.pcm_final = True
            segment.synth_end_at = time.time()
            self.condition.notify_all()

    def fail_segment(self, task_id: str, error: str, *, cancel_rest: bool) -> list[Segment]:
        """合成失败收束：本段 failed，来源剩余未终结片段 cancelled。返回被连带取消的片段。"""
        with self.condition:
            segment = self._tasks.get(task_id)
            if segment is None:
                return []
            source = self._source_of_task(segment)
            now = time.time()
            cancelled: list[Segment] = []
            if segment.synthesis not in SYNTHESIS_TERMINAL:
                segment.synthesis = "failed"
            if not segment.terminal:
                segment.playback = "failed"
                segment.error = error
                segment.terminal_at = now
            if source is not None:
                source.terminal_reason = f"segment failed: {error}"
                if cancel_rest:
                    source.input = "cancelled"
                    for other in source.segments.values():
                        if other is segment or other.terminal:
                            continue
                        other.synthesis = "cancelled"
                        other.playback = "cancelled"
                        other.terminal_at = now
                        self._cancel_events.setdefault(other.task_id, threading.Event()).set()
                        cancelled.append(other)
                self._maybe_release_head_locked()
            self.condition.notify_all()
            return cancelled

    # ── 播放转换（PlaybackFeed 专用） ───────────────────────────────────

    def fail_source(self, trace_id: str, error: str) -> list[Segment]:
        """整来源失败收束（如音频设备不可用）：全部未终结片段 failed。"""
        with self.condition:
            source = self._sources.get(trace_id)
            if source is None:
                return []
            now = time.time()
            failed: list[Segment] = []
            for segment in source.segments.values():
                if segment.terminal:
                    continue
                segment.synthesis = "failed"
                segment.playback = "failed"
                segment.error = error
                segment.terminal_at = now
                self._cancel_events.setdefault(segment.task_id, threading.Event()).set()
                failed.append(segment)
            source.input = "cancelled"
            source.terminal_reason = f"source failed: {error}"
            self._maybe_release_head_locked()
            self.condition.notify_all()
            return failed

    def head_pending_synthesis(self) -> bool:
        """队首来源是否还有未完成的合成工作（用于 sink 的 expecting 标记）。"""
        with self.condition:
            head = self._head_locked()
            if head is None:
                return False
            return any(segment.synthesis in {"queued", "running"} for segment in head.segments.values())

    def apply_transition(self, kind: str, task_id: str) -> Segment | None:
        """应用 AudioSink 的真实播放转换；返回受影响的片段（已终结则 None）。"""
        with self.condition:
            segment = self._tasks.get(task_id)
            if segment is None:
                return None
            now = time.time()
            if kind == "started":
                if segment.terminal:
                    return None
                if segment.playback == "pending":
                    segment.playback = "playing"
                    segment.playback_started_at = now
            elif kind == "completed":
                if segment.terminal:
                    # 已终结（取消/失败）：转换无效，但释放检查照常推进。
                    self._maybe_release_head_locked()
                    self.condition.notify_all()
                    return None
                segment.playback = "completed"
                segment.terminal_at = now
            self._maybe_release_head_locked()
            self.condition.notify_all()
            return segment

    # ── 状态投影 ────────────────────────────────────────────────────────

    def _source_of_task(self, segment: Segment) -> Source | None:
        for source in self._sources.values():
            if source.segments.get(segment.index) is segment:
                return source
        return None

    def _head_locked(self) -> Source | None:
        for trace_id in list(self._source_order):
            source = self._sources.get(trace_id)
            if source is None:
                self._source_order.pop(trace_id, None)
                continue
            return source
        return None

    def head_source(self) -> Source | None:
        with self.condition:
            return self._head_locked()

    def source_of(self, trace_id: str) -> Source | None:
        with self.condition:
            return self._sources.get(trace_id)

    def playing_segment(self, trace_id: str) -> Segment | None:
        with self.condition:
            source = self._sources.get(trace_id)
            if source is None:
                return None
            return next((s for s in source.segments.values() if s.playback == "playing"), None)

    def _maybe_release_head_locked(self) -> bool:
        """队首来源满足释放条件时交棒：已封口/取消 且 全部片段终结。"""
        head = self._head_locked()
        if head is None:
            return False
        if head.input == "open":
            return False
        if not head.all_terminal():
            return False
        self._source_order.pop(head.id, None)
        self.condition.notify_all()
        return True

    def pending_summary(self) -> dict[str, Any]:
        with self.condition:
            head = self._head_locked()
            pending = sum(item.pending_count() for item in self._sources.values())
            return {
                "head_trace": head.id if head is not None else None,
                "active_sources": len(self._source_order),
                "pending_segments": pending,
                "admitted_tasks": len(self._tasks),
            }

    def active_task_count(self) -> int:
        with self.condition:
            return sum(1 for segment in self._tasks.values() if not segment.terminal)

    def get_segment(self, task_id: str) -> Segment | None:
        with self.condition:
            return self._tasks.get(task_id)

    def task_status(self, task_id: str) -> dict[str, Any]:
        with self.condition:
            segment = self._tasks.get(task_id)
            if segment is None:
                return {"status": "not_found", "task_id": task_id}
            source = self._source_of_task(segment)
            return {
                "status": task_status_word(segment),
                "task_id": segment.task_id,
                "trace_id": source.id if source is not None else None,
                "cancel_token": segment.cancel_token,
                "error": segment.error or "",
                "detail": {
                    "segment_index": segment.index,
                    "generation_id": source.generation_id if source is not None else 1,
                    "synthesis": segment.synthesis,
                    "playback": segment.playback,
                    "stop_outcome": segment.stop_outcome,
                    "original_text": segment.original_text,
                    "text": segment.text,
                    "timings": segment.timings(),
                },
                "started_at": segment.synth_started_at,
                "completed_at": segment.terminal_at,
            }

    def batch_task_status(self, task_ids: list[str]) -> dict[str, Any]:
        return {"tasks": [self.task_status(task_id) for task_id in task_ids]}

    def subtitle_state(self, trace_id: str, *, estimator: Any, played_frame: int) -> dict[str, Any]:
        """交付投影：句段列表、正在说、待播、已播完。revealed 为估计值。"""
        with self.condition:
            source = self._sources.get(trace_id)
            if source is None:
                return {
                    "trace_id": trace_id,
                    "is_speaking": False,
                    "current_speaking": None,
                    "pending_segments": [],
                    "completed_segments": [],
                    "segments": [],
                }
            segments_state: list[dict[str, Any]] = []
            pending: list[dict[str, Any]] = []
            completed: list[dict[str, Any]] = []
            current: dict[str, Any] | None = None
            for index in sorted(source.segments):
                segment = source.segments[index]
                state_word = playback_state_word(segment)
                revealed_count, revealed_text = estimator(segment, played_frame)
                entry: dict[str, Any] = {
                    "segment_index": segment.index,
                    "task_id": segment.task_id,
                    "generation_id": source.generation_id,
                    "text": segment.original_text,
                    "state": state_word,
                    "revealed_count": revealed_count,
                    "revealed_text": revealed_text,
                    "playback_started": segment.playback_started_at is not None or segment.playback in {"playing", "completed"},
                    "playback_completed": segment.playback == "completed",
                }
                if segment.stop_outcome:
                    entry["stop_outcome"] = segment.stop_outcome
                if segment.error:
                    entry["error"] = segment.error
                if state_word in {"failed", "cancelled"}:
                    entry["playback_completed"] = False
                segments_state.append(entry)
                if state_word == "completed":
                    completed.append({"index": segment.index, "text": segment.original_text})
                elif state_word == "playing" and current is None:
                    current = {"index": segment.index, "text": segment.original_text, "revealed_text": revealed_text}
                elif state_word in {"pending", "synthesizing"}:
                    pending.append({"index": segment.index, "text": segment.original_text})
            is_speaking = current is not None or any(not segment.terminal for segment in source.segments.values())
            return {
                "trace_id": trace_id,
                "is_speaking": is_speaking,
                "current_speaking": current,
                "pending_segments": pending,
                "completed_segments": completed,
                "segments": segments_state,
            }

    def retention(self, *, ttl_seconds: float, max_tasks: int) -> None:
        """有界终局记录保留：唯一的回收 owner（PlaybackFeed 周期调用）。"""
        now = time.time()
        with self.condition:
            expired_tasks = [
                task_id
                for task_id, segment in self._tasks.items()
                if segment.terminal and segment.terminal_at is not None and now - segment.terminal_at > ttl_seconds
            ]
            surplus = len(self._tasks) - len(expired_tasks) - max_tasks
            if surplus > 0:
                remaining = sorted(
                    (segment for segment in self._tasks.values() if segment.task_id not in set(expired_tasks) and segment.terminal),
                    key=lambda segment: segment.terminal_at or now,
                )
                expired_tasks.extend(segment.task_id for segment in remaining[:surplus])
            for task_id in expired_tasks:
                self._tasks.pop(task_id, None)
                self._cancel_events.pop(task_id, None)
            stale_sources = [
                trace_id
                for trace_id, source in self._sources.items()
                if trace_id not in self._source_order
                and source.input != "open"
                and all(segment.task_id not in self._tasks for segment in source.segments.values())
            ]
            for trace_id in stale_sources:
                self._sources.pop(trace_id, None)

    def close(self) -> None:
        with self.condition:
            self._closed = True
            now = time.time()
            for source in self._sources.values():
                source.input = "cancelled"
                for segment in source.segments.values():
                    if not segment.terminal:
                        segment.synthesis = "cancelled"
                        segment.playback = "cancelled"
                        segment.terminal_at = now
                        self._cancel_events.setdefault(segment.task_id, threading.Event()).set()
            self._source_order.clear()
            self.condition.notify_all()
