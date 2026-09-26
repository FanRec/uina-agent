from __future__ import annotations

import threading
import time
import unittest
from pathlib import Path
import sys
from dataclasses import replace
from queue import Queue
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from models import AudioAsset, BridgeTask, DefaultPreset, GenerationSession, LipsyncBridgeConfig, SegmentKey, SegmentRecord, StreamingConfig, StreamingProfile, SubtitleSyncConfig
from playback_coordinator import PlaybackCoordinator
from service import _AdmittedSpeakTask, BatchTaskStatusRequest, CancelRequest, CancelTraceRequest, SpeakRequest, TTSBridgeService, TurnEndRequest, _log_latency, _sanitize_vendor_text, _vendor_text_lang_for
from sliding_window import SlidingWindowState


class _SlidingWindow:
    def __init__(self) -> None:
        self.closed: list[str] = []

    def close_trace(self, trace_id: str) -> None:
        self.closed.append(trace_id)


class _Player:
    def __init__(self) -> None:
        self.cancelled = False

    def cancel_all(self) -> None:
        self.cancelled = True


class _ReadyPlayer:
    ready = True

    def play_pcm_and_wait(self, **kwargs) -> bool:
        raise RuntimeError("portaudio failed")

    def stream_stats(self) -> dict[str, object]:
        return {}


class _SubtitleSync:
    def __init__(self) -> None:
        self.clear_events: list[dict[str, object]] = []

    def emit_clear(self, *, trace_id: str, generation_id: int, reason: str) -> None:
        self.clear_events.append({"trace_id": trace_id, "generation_id": generation_id, "reason": reason})


class _LipsyncBridge:
    def __init__(self) -> None:
        self.cancelled: list[str] = []
        self.events: list[tuple[str, object]] = []

    def cancel_trace_async(self, *, trace_id: str) -> None:
        self.cancelled.append(trace_id)

    def stream_start_async(self, **kwargs) -> None:
        self.events.append(("start", kwargs))

    def stream_chunk_async(self, *, task_id: str, chunk: bytes) -> None:
        self.events.append(("chunk", {"task_id": task_id, "chunk": chunk}))

    def stream_finish_async(self, *, task_id: str) -> None:
        self.events.append(("finish", {"task_id": task_id}))


class _StreamingPlayer:
    ready = True

    def __init__(self) -> None:
        self.events: list[tuple[str, object]] = []
        self._stats = {"playback_started": True}

    def progress_snapshot(self, *, duration_ms: int) -> object:
        return type(
            "Snapshot",
            (),
            {
                "playback_started": True,
                "played_ms": float(duration_ms),
                "played_samples": 0,
                "buffered_ms": 0.0,
                "segment_finished": True,
                "duration_ms": duration_ms,
            },
        )()

    def start_stream(self, *, sample_rate: int, prebuffer_ms: int, rebuffer_ms: int) -> None:
        self.events.append(("start_stream", sample_rate))

    def resume_or_start_stream(self, *, sample_rate: int, prebuffer_ms: int, rebuffer_ms: int) -> None:
        self.events.append(("start_stream", sample_rate))

    def feed(self, chunk: bytes) -> None:
        self.events.append(("feed", chunk))

    def finish_stream(self) -> None:
        self.events.append(("finish_stream", None))

    def wait_until_drained(self, timeout_ms: int) -> bool:
        self.events.append(("wait_until_drained", timeout_ms))
        return True

    def stream_stats(self) -> dict[str, object]:
        return dict(self._stats)

    def stop_stream(self) -> None:
        self.events.append(("stop_stream", None))


class _WarmupVendor:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.payloads: list[dict[str, object]] = []

    def synthesize_stream(self, payload: dict[str, object], *, timeout_ms: int):
        self.payloads.append({**payload, "timeout_ms": timeout_ms})
        if self.fail:
            raise RuntimeError("vendor cold start failed")
        yield b"\x00\x00"


class _IdleVendor:
    process = None

    def ready(self) -> bool:
        return True

    def close(self) -> None:
        pass


class _IdlePlayback:
    ready = True
    is_playing = False
    is_streaming = False
    supports_streaming = True

    def stop(self) -> None:
        pass


class _ChunkVendor:
    def synthesize_stream(self, payload: dict[str, object], *, timeout_ms: int):
        yield b"\x01\x00"
        yield b"\x02\x00"


def _service_with_admitted_task() -> TTSBridgeService:
    service = TTSBridgeService.__new__(TTSBridgeService)
    service._lock = threading.Lock()
    service._synthesis_lock = threading.Lock()
    service._tasks = {
        "task_1": BridgeTask(task_id="task_1", trace_id="trace_1", state="pending", cancel_token="cancel_1")
    }
    service._admitted_tasks = {
        "task_1": _AdmittedSpeakTask(
            task_id="task_1",
            ref_audio_path=Path("reference.wav"),
            timeout_ms=120000,
            profile=StreamingProfile(
                label="test",
                vendor_streaming_mode=2,
                min_chunk_length=32,
                fragment_interval=0.08,
                prebuffer_ms=120,
                rebuffer_ms=420,
            ),
            use_batch_only=False,
            admitted_at=100.0,
        )
    }
    service._delivery_queue = Queue()
    service._active_delivery_tasks = set()
    service._last_delivery_error = None
    service._playback_event_subscribers = {}
    service._playback_events_stop = threading.Event()
    service._delivery_thread = type("Thread", (), {"is_alive": lambda self: True})()
    service._delivery_executor = type("Executor", (), {"_max_workers": 1})()
    service._next_generation_id_by_trace = {}
    service._sessions_by_trace = {}
    service._first_chunk_events = {}
    service._sliding_window = _SlidingWindow()
    service.player = _Player()
    service.subtitle_sync = _SubtitleSync()
    service.lipsync_bridge = _LipsyncBridge()
    return service


class TTSBridgeCancelTraceTest(unittest.TestCase):
    def test_fixed_streaming_uses_two_sentence_prefetch_without_overloading_vendor(self) -> None:
        config = type(
            "Config",
            (),
            {
                "streaming": StreamingConfig(stream_strategy="fixed_streaming"),
                "subtitle_sync": SubtitleSyncConfig(),
                "lipsync_bridge": LipsyncBridgeConfig(enabled=False),
                "playback_enabled": True,
            },
        )()
        service = TTSBridgeService(config, vendor_manager=_IdleVendor(), player=_IdlePlayback())
        try:
            self.assertLessEqual(config.streaming.first_chunk_gate_timeout_ms, 3000)
            # 预取窗口收敛为超前 1 段：vendor 单推理，超前更多段只会制造
            # 无谓的排队合成与"等待播放"冻结面，不带来任何延迟收益。
            self.assertEqual(service._scheduler.window_size, 2)
            self.assertEqual(service._delivery_executor._max_workers, 3)
        finally:
            service.close()

    def test_batch_task_status_returns_multiple_states_and_not_found(self) -> None:
        service = _service_with_admitted_task()
        service._tasks["task_1"].state = "completed"
        service._tasks["task_1"].completed_at = 123.0
        service._tasks["task_2"] = BridgeTask(
            task_id="task_2",
            trace_id="trace_1",
            state="failed",
            cancel_token="cancel_2",
            error="vendor failed",
        )

        result = service.batch_task_status(BatchTaskStatusRequest(task_ids=["task_1", "task_2", "missing"]))

        self.assertEqual([item["status"] for item in result["tasks"]], ["delivered", "failed", "not_found"])
        self.assertEqual(result["tasks"][1]["error"], "vendor failed")
        self.assertEqual(result["tasks"][2]["task_id"], "missing")

    def test_playback_events_stream_publishes_sse_payloads(self) -> None:
        service = _service_with_admitted_task()
        stream = service.playback_events("trace_1")
        self.assertEqual(next(stream), ": connected\n\n")

        service._publish_playback_event(
            "submitted",
            task=service._tasks["task_1"],
            detail={"queue_size": 1},
        )
        payload = next(stream)

        self.assertIn("event: tts.playback", payload)
        self.assertIn('"kind": "submitted"', payload)
        self.assertIn('"trace_id": "trace_1"', payload)
        stream.close()
        self.assertEqual(service._playback_event_subscribers, {})

    def test_cancel_trace_publishes_cancelled_event_without_subscriber_failure(self) -> None:
        service = _service_with_admitted_task()
        stream = service.playback_events("trace_1")
        next(stream)

        result = service.cancel_trace(CancelTraceRequest(trace_id="trace_1"))
        payload = next(stream)
        stream.close()

        self.assertEqual(result["status"], "cancelled")
        self.assertIn('"kind": "cancelled"', payload)
        self.assertIn('"reason": "cancel_trace"', payload)

    def test_cancel_trace_removes_admitted_pending_task(self) -> None:
        service = _service_with_admitted_task()

        result = service.cancel_trace(CancelTraceRequest(trace_id="trace_1"))

        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["cancelled_task_count"], 1)
        self.assertEqual(service._tasks["task_1"].state, "cancelled")
        self.assertTrue(service._tasks["task_1"].cancel_requested)
        self.assertNotIn("task_1", service._admitted_tasks)
        self.assertTrue(service.player.cancelled)
        self.assertEqual(service._sliding_window.closed, ["trace_1"])
        self.assertEqual(service.subtitle_sync.clear_events[0]["reason"], "cancel_trace")
        self.assertEqual(service.lipsync_bridge.cancelled, ["trace_1"])

    def test_immediate_cancel_returns_grapheme_cutoff(self) -> None:
        service = _service_with_admitted_task()
        service._tasks["task_1"].state = "in_progress"
        service._tasks["task_1"].subtitle_state = {
            "generation_id": 1,
            "segment_index": 1,
            "text": "第一段。第二段。",
            "played_ms": 120.0,
            "revealed_text": "第一段。",
            "revealed_count": 4,
            "playback_started": True,
            "playback_completed": False,
        }

        result = service.cancel_trace(CancelTraceRequest(trace_id="trace_1", mode="immediate"))

        self.assertEqual(result["mode"], "immediate")
        self.assertEqual(result["cutoff_segments"][0]["revealed_text"], "第一段。")
        self.assertEqual(result["cutoff_segments"][0]["revealed_count"], 4)
        self.assertTrue(service.player.cancelled)

    def test_segment_boundary_cancel_waits_for_current_segment_without_stopping_player(self) -> None:
        service = _service_with_admitted_task()
        service.config = type(
            "Config",
            (),
            {"streaming": type("Streaming", (), {"drain_timeout_ms": 50})()},
        )()
        task = service._tasks["task_1"]
        task.state = "in_progress"
        task.subtitle_state = {
            "generation_id": 1,
            "segment_index": 1,
            "text": "当前句。",
            "revealed_text": "当前句。",
            "revealed_count": 4,
            "playback_started": True,
            "playback_completed": False,
        }
        record = SegmentRecord(
            key=SegmentKey(trace_id="trace_1", generation_id=1, segment_index=1),
            task_id="task_1",
            text="当前句。",
            state="playing",
        )
        service._sessions_by_trace = {
            "trace_1": GenerationSession(
                trace_id="trace_1",
                generation_id=1,
                segments={1: record},
            ),
        }

        def finish_current_segment() -> None:
            time.sleep(0.02)
            with service._lock:
                task.state = "completed"
                record.state = "completed"
                task.subtitle_state["playback_completed"] = True

        threading.Thread(target=finish_current_segment, daemon=True).start()
        result = service.cancel_trace(
            CancelTraceRequest(trace_id="trace_1", mode="segment_boundary"),
        )

        self.assertEqual(result["mode"], "segment_boundary")
        self.assertEqual(result["cancelled_task_count"], 0)
        self.assertFalse(service.player.cancelled)
        self.assertTrue(result["cutoff_segments"][0]["playback_completed"])

    def test_task_failure_releases_play_window_without_abandoning_generation(self) -> None:
        service = _service_with_admitted_task()
        condition = threading.Condition(service._lock)
        service._sessions_by_trace = {
            "trace_1": GenerationSession(
                trace_id="trace_1",
                generation_id=2,
                condition=condition,
                segments={
                    1: SegmentRecord(
                        key=SegmentKey(trace_id="trace_1", generation_id=2, segment_index=1),
                        task_id="task_1",
                        text="失败段",
                        state="failed",
                    ),
                    2: SegmentRecord(
                        key=SegmentKey(trace_id="trace_1", generation_id=2, segment_index=2),
                        task_id="task_2",
                        text="后续段",
                        state="pending",
                    ),
                },
            )
        }
        failed = service._tasks["task_1"]
        failed.detail["generation_id"] = 2
        failed.state = "failed"
        service._tasks["task_2"] = BridgeTask(
            task_id="task_2",
            trace_id="trace_1",
            state="pending",
            cancel_token="cancel_2",
        )
        service._tasks["task_2"].detail["generation_id"] = 2
        service._sessions_by_trace["trace_1"].next_play_index = 1

        service._mark_task_failed_and_release_window(task=failed, reason="vendor_stream_failed")

        session = service._sessions_by_trace["trace_1"]
        self.assertFalse(session.closed)
        self.assertEqual(session.segments[1].state, "failed")
        self.assertEqual(session.segments[1].detail["failure_reason"], "vendor_stream_failed")
        self.assertEqual(session.next_play_index, 2)
        self.assertEqual(service._tasks["task_2"].state, "pending")
        self.assertIn("task_1", service._admitted_tasks)
        self.assertFalse(service.player.cancelled)
        self.assertEqual(service.subtitle_sync.clear_events, [])
        self.assertEqual(service.lipsync_bridge.cancelled, [])

    def test_cancel_pending_earliest_segment_releases_window(self) -> None:
        service = _service_with_admitted_task()
        condition = threading.Condition(service._lock)
        service._sessions_by_trace = {
            "trace_1": GenerationSession(
                trace_id="trace_1",
                generation_id=1,
                condition=condition,
                segments={
                    1: SegmentRecord(
                        key=SegmentKey(trace_id="trace_1", generation_id=1, segment_index=1),
                        task_id="task_1",
                        text="第一段",
                        state="pending",
                    ),
                    2: SegmentRecord(
                        key=SegmentKey(trace_id="trace_1", generation_id=1, segment_index=2),
                        task_id="task_2",
                        text="第二段",
                        state="pending",
                    ),
                },
            ),
        }
        service._tasks["task_1"].detail["generation_id"] = 1
        service._tasks["task_1"].detail["segment_index"] = 1
        service._tasks["task_1"].state = "pending"
        service._tasks["task_2"] = BridgeTask(
            task_id="task_2",
            trace_id="trace_1",
            state="pending",
            cancel_token="cancel_2",
        )
        service._tasks["task_2"].detail["generation_id"] = 1
        service._tasks["task_2"].detail["segment_index"] = 2

        result = service.cancel(CancelRequest(task_id="task_1", trace_id="trace_1"))

        self.assertEqual(result["status"], "cancelled")
        session = service._sessions_by_trace["trace_1"]
        self.assertEqual(session.segments[1].state, "cancelled")
        self.assertEqual(session.next_play_index, 2)
        self.assertEqual(service._tasks["task_1"].state, "cancelled")


    def test_health_reports_delivery_worker_summary(self) -> None:
        service = _service_with_admitted_task()
        service.vendor_manager = type(
            "Vendor",
            (),
            {
                "process": None,
                "ready": lambda self: True,
            },
        )()
        service.player.ready = True
        service.player.is_playing = False
        service.player.is_streaming = False
        service.config = type(
            "Config",
            (),
            {
                "playback_enabled": True,
                "request_timeout_ms": 1000,
                "startup_timeout_ms": 2000,
                "streaming": StreamingConfig(),
                "subtitle_sync": type("SubtitleConfig", (), {"enabled": False, "obs_base_url": "", "progress_interval_ms": 33, "fallback_mode": "sentence_only"})(),
                "lipsync_bridge": type(
                    "LipsyncConfig",
                    (),
                    {
                        "enabled": False,
                        "streaming_enabled": False,
                        "base_url": "",
                        "request_timeout_ms": 250,
                        "inline_pcm_max_bytes": 4096,
                    },
                )(),
            },
        )()

        payload = service.health()

        self.assertTrue(payload["delivery_worker_alive"])
        self.assertEqual(payload["delivery_executor_workers"], 1)
        self.assertEqual(payload["active_delivery_tasks"], 0)
        self.assertEqual(payload["admitted_task_count"], 1)
        self.assertIsNotNone(payload["oldest_pending_delivery_age_ms"])

    def test_admission_does_not_reject_only_because_workers_are_busy(self) -> None:
        service = _service_with_admitted_task()
        service._active_delivery_tasks = {"busy"}
        service._delivery_executor = type("Executor", (), {"_max_workers": 1})()
        service._delivery_thread = type("Thread", (), {"is_alive": lambda self: True})()
        service._admitted_tasks["task_1"] = replace(service._admitted_tasks["task_1"], admitted_at=time.perf_counter() - 6.0)

        self.assertFalse(service._should_reject_admission())

    def test_admit_speak_returns_accepted_payload_and_queues_delivery(self) -> None:
        service = _service_with_admitted_task()
        service._tasks = {}
        service._admitted_tasks = {}
        service._delivery_queue = Queue()
        task = BridgeTask(task_id="seg_1", trace_id="trace_1", state="pending", cancel_token="cancel_1")
        task.detail["generation_id"] = 3
        task.detail["segment_index"] = 1
        profile = StreamingProfile(
            label="test",
            vendor_streaming_mode=2,
            min_chunk_length=32,
            fragment_interval=0.08,
            prebuffer_ms=120,
            rebuffer_ms=420,
        )
        with patch.object(
            service,
            "_prepare_speak_task",
            return_value=(task, Path("reference.wav"), 3000, profile, False),
        ), patch.object(service, "_ensure_delivery_worker", return_value=None):
            result = service.admit_speak(SpeakRequest(
                trace_id="trace_1",
                segment_id="seg_1",
                index=1,
                text="晚安空纪！",
                generation_id=3,
            ))

        self.assertEqual(result["status"], "accepted")
        self.assertEqual(result["task_id"], "seg_1")
        self.assertEqual(result["trace_id"], "trace_1")
        self.assertEqual(result["generation_id"], 3)
        self.assertEqual(result["segment_index"], 1)
        self.assertEqual(service._delivery_queue.get_nowait(), "seg_1")
        self.assertIn("seg_1", service._admitted_tasks)

    def test_admission_rejects_when_backlog_exceeds_hard_limit(self) -> None:
        service = _service_with_admitted_task()
        service._delivery_executor = type("Executor", (), {"_max_workers": 1})()
        service._delivery_thread = type("Thread", (), {"is_alive": lambda self: True})()
        template = replace(service._admitted_tasks["task_1"], admitted_at=time.perf_counter())
        service._admitted_tasks["task_1"] = template
        for index in range(2, 34):
            service._admitted_tasks[f"task_{index}"] = replace(template, task_id=f"task_{index}")

        self.assertTrue(service._should_reject_admission())


class TTSBridgeTextSanitizationTest(unittest.TestCase):
    def test_sanitize_vendor_text_removes_non_gbk_symbols(self) -> None:
        self.assertEqual(
            _sanitize_vendor_text("[Speech] 收到~ 一切正常运转中 ✨\n\n现在是 `22:00` 🕐"),
            "收到 一切正常运转中 现在是 22:00",
        )

    def test_sanitize_vendor_text_keeps_multilingual_text(self) -> None:
        # vendor 支持 zh/ja/en/ko/yue；白名单不再按 GBK 过滤，
        # 韩文谚文与重音拉丁字符必须保留（GBK 时代会被删空）。
        self.assertEqual(_sanitize_vendor_text("Hello world, how are you?"), "Hello world, how are you?")
        self.assertEqual(_sanitize_vendor_text("こんにちは、世界。"), "こんにちは、世界。")
        self.assertEqual(_sanitize_vendor_text("안녕하세요, 반갑습니다."), "안녕하세요, 반갑습니다.")
        self.assertEqual(_sanitize_vendor_text("Bonjour, ça va ? Merci."), "Bonjour, ça va ? Merci.")
        self.assertEqual(_sanitize_vendor_text("你好，Hello world！こんにちは。"), "你好，Hello world！こんにちは。")

    def test_sanitize_vendor_text_filters_unsupported_scripts(self) -> None:
        # vendor cleaner 不支持西里尔/阿拉伯/泰文；放行会导致 en-fallback
        # 空文本触发 filter_text 崩溃，必须过滤（与 emoji 同一层防线）。
        self.assertEqual(_sanitize_vendor_text("Привет, мир!"), ", !")
        self.assertEqual(_sanitize_vendor_text("مرحبا بالعالم"), "")
        self.assertEqual(_sanitize_vendor_text("สวัสดี"), "")
        self.assertEqual(_sanitize_vendor_text("✨🕐🚀"), "")

    def test_vendor_text_lang_for_picks_zh_for_pure_cjk_and_auto_for_kana(self) -> None:
        # LangSegment 对无假名的纯 CJK 文本无法区分 zh/ja（'刚启动完，'
        # 会被误判 ja 导致中文读成日语），必须强制 zh；
        # 假名/谚文是强特征，auto 判定可靠且支持混合句。
        self.assertEqual(_vendor_text_lang_for("刚启动完，正在连着。"), "zh")
        self.assertEqual(_vendor_text_lang_for("还没。"), "zh")
        self.assertEqual(_vendor_text_lang_for("晚安，Good night。"), "zh")
        self.assertEqual(_vendor_text_lang_for("你好，Hello world！"), "zh")
        self.assertEqual(_vendor_text_lang_for("こんにちは、世界。"), "auto")
        self.assertEqual(_vendor_text_lang_for("안녕하세요, 반갑습니다."), "auto")
        self.assertEqual(_vendor_text_lang_for("你好，Hello world！こんにちは。"), "auto")

    def test_sanitize_vendor_text_collapses_blank_lines(self) -> None:
        self.assertEqual(_sanitize_vendor_text(" \n\n  \n "), "")
        self.assertEqual(_sanitize_vendor_text("在。\n\n刚启动完，正在连着。"), "在。 刚启动完，正在连着。")

    def test_ensure_vendor_ready_warms_up_after_restart(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service._synthesis_lock = threading.Lock()
        service._warmup_status: dict[str, object] = {"status": "not_started"}
        service.config = type(
            "Config",
            (),
            {
                "startup_timeout_ms": 500,
                "streaming": StreamingConfig(
                    enabled=True,
                    stream_strategy="fixed_streaming",
                    warmup_enabled=True,
                    warmup_text="嗯。",
                    warmup_timeout_ms=1234,
                    first_chunk_min_chunk_length=24,
                    first_chunk_fragment_interval=0.05,
                ),
                "preset": DefaultPreset(
                    ref_audio_path=Path(__file__).resolve(),
                    prompt_text="prompt",
                    prompt_lang="ja",
                    text_lang="zh",
                    text_split_method="cut5",
                    speed_factor=1.0,
                    media_type="wav",
                ),
            },
        )()

        class _RestartVendor(_WarmupVendor):
            def __init__(self) -> None:
                super().__init__()
                self.started = 0

            def ready(self) -> bool:
                return False

            def ensure_running(self) -> bool:
                self.started += 1
                return True

            def wait_until_ready(self, timeout_ms: int) -> bool:
                return True

        vendor = _RestartVendor()
        service.vendor_manager = vendor

        service._ensure_vendor_ready(wait_for_ready=True)

        self.assertEqual(vendor.started, 1)
        self.assertEqual(len(vendor.payloads), 1)
        self.assertEqual(vendor.payloads[0]["text"], "嗯。")

    def test_prepare_speak_task_sends_sanitized_text(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service._lock = threading.Lock()
        service._synthesis_lock = threading.Lock()
        service._tasks: dict[str, object] = {}
        service.config = type(
            "Config",
            (),
            {
                "request_timeout_ms": 120000,
                "streaming": StreamingConfig(
                    enabled=True,
                    stream_strategy="fixed_streaming",
                    warmup_enabled=False,
                    first_chunk_min_chunk_length=24,
                    first_chunk_fragment_interval=0.05,
                ),
                "preset": DefaultPreset(
                    ref_audio_path=Path(__file__).resolve(),
                    prompt_text="prompt",
                    prompt_lang="ja",
                    text_lang="zh",
                    text_split_method="cut5",
                    speed_factor=1.0,
                    media_type="wav",
                ),
            },
        )()
        service.vendor_manager = _IdleVendor()
        service._sliding_window = SlidingWindowState(
            lock=service._lock,
            sessions_by_trace={},
        )
        service._streaming_profile_for_request = lambda *args, **kwargs: StreamingProfile(
            label="test",
            vendor_streaming_mode=2,
            min_chunk_length=32,
            fragment_interval=0.08,
            prebuffer_ms=120,
            rebuffer_ms=420,
        )
        service._should_force_batch_for_trace = lambda trace_id: False
        service._resolve_generation_id = lambda request: 1

        request = SpeakRequest(
            trace_id="trace_1",
            segment_id="task_1",
            index=1,
            text="在。\n\n刚启动完，正在连着。 ✨",
            kind="sentence",
            timeout_ms=60000,
        )
        task, _, _, _, _ = service._prepare_speak_task(request, wait_for_vendor_ready=False)

        self.assertEqual(task.detail["text"], "在。 刚启动完，正在连着。")
        self.assertEqual(task.detail["original_text"], "在。\n\n刚启动完，正在连着。 ✨")


class TTSBridgeLatencyLogTest(unittest.TestCase):
    def test_latency_log_includes_trace_task_and_stage(self) -> None:
        task = BridgeTask(task_id="task_1", trace_id="trace_1", state="pending", cancel_token="cancel_1")
        task.detail["generation_id"] = 2
        task.detail["segment_index"] = 1
        task.detail["latency_trace_started_at"] = 100.0

        with patch("service.time.perf_counter", return_value=100.12345), \
             patch("builtins.print") as printed:
            _log_latency(task, "accepted", queue_size=1)

        line = printed.call_args.args[0]
        self.assertIn("[TTS][latency]", line)
        self.assertIn('"trace_id": "trace_1"', line)
        self.assertIn('"task_id": "task_1"', line)
        self.assertIn('"stage": "accepted"', line)
        self.assertIn('"elapsed_ms": 123.45', line)


class TTSBridgeStreamingProfileTest(unittest.TestCase):
    def test_first_sentence_uses_fast_start_profile_without_changing_later_segments(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service.config = type(
            "Config",
            (),
            {
                "streaming": StreamingConfig(
                    stream_strategy="fixed_streaming",
                    vendor_streaming_mode=2,
                    min_chunk_length=48,
                    fragment_interval=0.10,
                    first_chunk_vendor_streaming_mode=3,
                    first_chunk_min_chunk_length=24,
                    first_chunk_fragment_interval=0.05,
                    first_chunk_prebuffer_ms=100,
                    prebuffer_ms=180,
                    rebuffer_ms=480,
                )
            },
        )()

        first = service._streaming_profile_for_request("trace_1", segment_index=1, text="猜对了。")
        later = service._streaming_profile_for_request("trace_1", segment_index=2)

        self.assertEqual(first.label, "fast_start_first_sentence")
        self.assertEqual(first.vendor_streaming_mode, 3)
        self.assertEqual(first.min_chunk_length, 24)
        self.assertEqual(first.fragment_interval, 0.05)
        self.assertEqual(first.prebuffer_ms, 100)
        self.assertEqual(first.rebuffer_ms, 480)
        self.assertEqual(later.label, "continuity_default")
        self.assertEqual(later.vendor_streaming_mode, 2)
        self.assertEqual(later.min_chunk_length, 48)
        self.assertEqual(later.fragment_interval, 0.10)
        self.assertEqual(later.prebuffer_ms, 180)

    def test_short_later_segment_uses_fast_start_profile(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service.config = type(
            "Config",
            (),
            {
                "streaming": StreamingConfig(
                    stream_strategy="fixed_streaming",
                    min_chunk_length=48,
                    fragment_interval=0.10,
                    first_chunk_min_chunk_length=24,
                    first_chunk_fragment_interval=0.05,
                    first_chunk_prebuffer_ms=100,
                    prebuffer_ms=180,
                    rebuffer_ms=480,
                )
            },
        )()

        short_later = service._streaming_profile_for_request("trace_1", segment_index=2, text="你回来啦！")
        very_short_followup = service._streaming_profile_for_request("trace_1", segment_index=3, text="先欠着。")
        medium_later = service._streaming_profile_for_request(
            "trace_1",
            segment_index=2,
            text="晚安协议作废，今晚你归我了。",
        )
        long_later = service._streaming_profile_for_request(
            "trace_1",
            segment_index=2,
            text="怎么，凌晨绕回来叫一声本初奈的大名，",
        )

        self.assertEqual(short_later.label, "fast_start_first_sentence")
        self.assertEqual(very_short_followup.label, "fast_start_first_sentence")
        self.assertEqual(medium_later.label, "continuity_default")
        self.assertEqual(long_later.label, "continuity_default")

    def test_later_segment_waits_for_first_chunk_gate(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service.config = type(
            "Config",
            (),
            {"streaming": StreamingConfig(stream_strategy="fixed_streaming", first_chunk_gate_timeout_ms=1000)},
        )()
        service._lock = threading.Lock()
        service._synthesis_lock = threading.Lock()
        service._first_chunk_events = {}
        service._task_cancelled_or_stale = lambda task: False
        task = BridgeTask(task_id="task_2", trace_id="trace_1", state="pending", cancel_token="cancel_2")

        event = service._first_chunk_event("trace_1", 1)
        waiter = threading.Thread(
            target=lambda: service._wait_for_first_chunk_priority(task=task, generation_id=1, segment_index=2)
        )
        waiter.start()
        self.assertTrue(waiter.is_alive())
        event.set()
        waiter.join(timeout=0.5)

        self.assertFalse(waiter.is_alive())

    def test_later_segment_waits_for_first_chunk_even_after_first_segment_enters_playing(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service.config = type(
            "Config",
            (),
            {"streaming": StreamingConfig(stream_strategy="fixed_streaming", first_chunk_gate_timeout_ms=1000)},
        )()
        service._lock = threading.Lock()
        service._synthesis_lock = threading.Lock()
        service._first_chunk_events = {}
        service._task_cancelled_or_stale = lambda task: False
        service._sessions_by_trace = {
            "trace_1": GenerationSession(
                trace_id="trace_1",
                generation_id=1,
                segments={
                    1: SegmentRecord(
                        key=SegmentKey(trace_id="trace_1", generation_id=1, segment_index=1),
                        task_id="task_1",
                        text="第一段",
                        state="playing",
                        detail={"playback_started": True},
                    ),
                },
            ),
        }
        task = BridgeTask(task_id="task_2", trace_id="trace_1", state="pending", cancel_token="cancel_2")

        event = service._first_chunk_event("trace_1", 1)
        waiter = threading.Thread(
            target=lambda: service._wait_for_first_chunk_priority(task=task, generation_id=1, segment_index=2)
        )
        waiter.start()
        self.assertTrue(waiter.is_alive())
        event.set()
        waiter.join(timeout=0.5)

        self.assertFalse(waiter.is_alive())

    def test_out_of_order_segment_registration_keeps_playback_start_at_first_segment(self) -> None:
        lock = threading.Lock()
        from sliding_window import SlidingWindowState

        sessions: dict[str, GenerationSession] = {}
        window = SlidingWindowState(lock=lock, sessions_by_trace=sessions)

        window.register_segment(
            trace_id="trace_1",
            generation_id=1,
            segment_index=2,
            task_id="task_2",
            text="第二段",
            state="pending",
        )
        window.register_segment(
            trace_id="trace_1",
            generation_id=1,
            segment_index=1,
            task_id="task_1",
            text="第一段",
            state="pending",
        )

        session = sessions["trace_1"]
        self.assertEqual(session.next_play_index, 1)
        self.assertEqual(session.next_issue_index, 3)

    def test_vendor_warmup_is_best_effort(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        ref_audio_path = Path(__file__).resolve()
        service.config = type(
            "Config",
            (),
            {
                "streaming": StreamingConfig(
                    enabled=True,
                    stream_strategy="fixed_streaming",
                    warmup_enabled=True,
                    warmup_text="嗯。",
                    warmup_timeout_ms=1234,
                    first_chunk_min_chunk_length=24,
                    first_chunk_fragment_interval=0.05,
                ),
                "preset": DefaultPreset(
                    ref_audio_path=ref_audio_path,
                    prompt_text="prompt",
                    prompt_lang="ja",
                    text_lang="zh",
                    text_split_method="cut5",
                    speed_factor=1.0,
                    media_type="wav",
                ),
            },
        )()
        service.vendor_manager = _WarmupVendor()
        service._synthesis_lock = threading.Lock()

        service._warmup_vendor_best_effort()

        self.assertEqual(len(service.vendor_manager.payloads), 1)
        self.assertEqual(service.vendor_manager.payloads[0]["text"], "嗯。")
        self.assertEqual(service.vendor_manager.payloads[0]["timeout_ms"], 1234)
        self.assertEqual(service.vendor_manager.payloads[0]["text_lang"], "zh")

        service.vendor_manager = _WarmupVendor(fail=True)
        service._warmup_vendor_best_effort()

    def test_streaming_payload_uses_auto_text_lang(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service._lock = threading.Lock()
        service._synthesis_lock = threading.Lock()
        service._adaptive_lock = threading.Lock()
        service._adaptive_ms_per_char = 270.0
        service.config = type(
            "Config",
            (),
            {
                "preset": DefaultPreset(
                    ref_audio_path=Path("reference.wav"),
                    prompt_text="",
                    prompt_lang="zh",
                    text_lang="zh",
                    text_split_method="cut0",
                    speed_factor=1.0,
                    media_type="raw",
                ),
                "streaming": StreamingConfig(
                    enabled=True,
                    stream_strategy="fixed_streaming",
                    vendor_streaming_mode=2,
                    min_chunk_length=32,
                    fragment_interval=0.08,
                    prebuffer_ms=10,
                    rebuffer_ms=20,
                    drain_timeout_ms=250,
                ),
                "playback_enabled": False,
            },
        )()
        service.vendor_manager = _WarmupVendor()
        service.player = _StreamingPlayer()
        service.lipsync_bridge = _LipsyncBridge()
        service._task_cancelled_or_stale = lambda task: False
        service._mark_first_chunk_ready = lambda trace_id, generation_id: None
        service._run_subtitle_progress_loop = lambda *, task, duration_ms, duration_holder=None: service.player.progress_snapshot(duration_ms=duration_ms)
        service._player_progress_snapshot = lambda *, duration_ms: service.player.progress_snapshot(duration_ms=duration_ms)
        service._register_ready_segment = lambda **kwargs: True
        service._sliding_window = type(
            "Window",
            (),
            {"is_current_generation": lambda self, *, trace_id, generation_id: True},
        )()
        service._playback = type(
            "Playback",
            (),
            {"finalize_late_result": lambda self, *, is_current_generation, playback_result: playback_result},
        )()
        service._mark_segment_completed = lambda **kwargs: None
        service._record_adaptive_result = lambda trace_id, metrics, used_batch: None
        service._publish_playback_event = lambda *args, **kwargs: None
        service._tasks = {}

        task = BridgeTask(task_id="task_1", trace_id="trace_1", state="in_progress", cancel_token="cancel_1")
        task.detail["text"] = "你好，Hello world！こんにちは。"
        task.detail["generation_id"] = 1
        task.detail["segment_index"] = 1
        service._tasks["task_1"] = task
        profile = StreamingProfile(
            label="test",
            vendor_streaming_mode=2,
            min_chunk_length=32,
            fragment_interval=0.08,
            prebuffer_ms=10,
            rebuffer_ms=20,
        )

        service._speak_streaming(task, ref_audio_path=Path("reference.wav"), timeout_ms=120000, profile=profile)

        self.assertEqual(len(service.vendor_manager.payloads), 1)
        self.assertEqual(service.vendor_manager.payloads[0]["text"], "你好，Hello world！こんにちは。")
        self.assertEqual(service.vendor_manager.payloads[0]["text_lang"], "auto")
        self.assertEqual(service.vendor_manager.payloads[0]["prompt_lang"], "zh")

    def test_mark_turn_end_without_generation_id_preserves_current_first_chunk_event(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service._lock = threading.Lock()
        service._synthesis_lock = threading.Lock()
        service._sessions_by_trace = {
            "trace_1": GenerationSession(trace_id="trace_1", generation_id=3)
        }
        service._first_chunk_events = {
            ("trace_1", 3): threading.Event(),
            ("trace_1", 2): threading.Event(),
        }
        service.lipsync_bridge = type(
            "Lipsync",
            (),
            {"turn_end_async": lambda self, **kwargs: None},
        )()

        result = service.mark_turn_end(TurnEndRequest(trace_id="trace_1"))

        self.assertEqual(result["status"], "accepted")
        self.assertIn(("trace_1", 3), service._first_chunk_events)
        self.assertIn(("trace_1", 2), service._first_chunk_events)


class PlaybackCoordinatorTest(unittest.TestCase):
    def test_playback_exception_releases_next_segment(self) -> None:
        lock = threading.RLock()
        condition = threading.Condition(lock)
        session = GenerationSession(
            trace_id="trace_1",
            generation_id=1,
            next_play_index=1,
            condition=condition,
        )
        record = SegmentRecord(
            key=SegmentKey(trace_id="trace_1", generation_id=1, segment_index=1),
            task_id="task_1",
            text="hello",
            state="ready",
            asset=AudioAsset(
                kind="pcm",
                artifact_path=None,
                sample_rate=32000,
                duration_ms=100,
                media_type="raw",
                pcm_bytes=b"\x00\x00",
            ),
        )
        session.segments[1] = record
        coordinator = PlaybackCoordinator(
            lock=lock,
            player=_ReadyPlayer(),
            sessions_by_trace={"trace_1": session},
            streaming_config=StreamingConfig(),
        )

        result = coordinator.play_ready_segment(trace_id="trace_1", generation_id=1, segment_index=1)

        self.assertFalse(result["playback_completed"])
        self.assertIn("playback_error", result)
        self.assertEqual(record.state, "failed")
        self.assertEqual(session.next_play_index, 2)

    def test_cross_trace_fifo_playback_order(self) -> None:
        lock = threading.RLock()
        condition_1 = threading.Condition(lock)
        condition_2 = threading.Condition(lock)

        session_1 = GenerationSession(
            trace_id="trace_1",
            generation_id=1,
            next_play_index=1,
            expected_end_index=2,
            condition=condition_1,
        )
        session_2 = GenerationSession(
            trace_id="trace_2",
            generation_id=1,
            next_play_index=1,
            expected_end_index=1,
            condition=condition_2,
        )

        def make_record(trace_id: str, seg_idx: int) -> SegmentRecord:
            return SegmentRecord(
                key=SegmentKey(trace_id=trace_id, generation_id=1, segment_index=seg_idx),
                task_id=f"{trace_id}_{seg_idx}",
                text=f"text_{trace_id}_{seg_idx}",
                state="ready",
                asset=AudioAsset(
                    kind="pcm",
                    artifact_path=None,
                    sample_rate=32000,
                    duration_ms=50,
                    media_type="raw",
                    pcm_bytes=b"\x00\x00",
                ),
            )

        session_1.segments[1] = make_record("trace_1", 1)
        session_1.segments[2] = make_record("trace_1", 2)
        session_2.segments[1] = make_record("trace_2", 1)

        coordinator = PlaybackCoordinator(
            lock=lock,
            player=_ReadyPlayer(),
            sessions_by_trace={"trace_1": session_1, "trace_2": session_2},
            streaming_config=StreamingConfig(),
        )

        play_history: list[tuple[str, int]] = []

        def mock_runner(trace_id: str, seg_idx: int):
            def _run(asset):
                play_history.append((trace_id, seg_idx))
                time.sleep(0.02)
                return {"playback_started": True, "playback_completed": True}
            return _run

        t_trace_2 = threading.Thread(
            target=lambda: coordinator.play_ready_segment(
                trace_id="trace_2",
                generation_id=1,
                segment_index=1,
                playback_runner=mock_runner("trace_2", 1),
            )
        )
        t_trace_1_seg1 = threading.Thread(
            target=lambda: coordinator.play_ready_segment(
                trace_id="trace_1",
                generation_id=1,
                segment_index=1,
                playback_runner=mock_runner("trace_1", 1),
            )
        )
        t_trace_1_seg2 = threading.Thread(
            target=lambda: coordinator.play_ready_segment(
                trace_id="trace_1",
                generation_id=1,
                segment_index=2,
                playback_runner=mock_runner("trace_1", 2),
            )
        )

        with lock:
            coordinator._register_trace_locked("trace_1")
            coordinator._register_trace_locked("trace_2")

        t_trace_2.start()
        time.sleep(0.01)
        t_trace_1_seg1.start()
        t_trace_1_seg2.start()

        t_trace_1_seg1.join(timeout=2.0)
        t_trace_1_seg2.join(timeout=2.0)
        t_trace_2.join(timeout=2.0)

        self.assertEqual(play_history, [("trace_1", 1), ("trace_1", 2), ("trace_2", 1)])

    def test_subtitle_state_exposes_rich_progress(self) -> None:
        service = _service_with_admitted_task()
        service._tasks["task_1"].state = "completed"
        service._tasks["task_1"].subtitle_state = {
            "generation_id": 1,
            "segment_index": 1,
            "text": "sentence 1",
            "playback_started": True,
            "playback_completed": True,
        }
        service._tasks["task_2"] = BridgeTask(
            task_id="task_2",
            trace_id="trace_1",
            state="playing",
            cancel_token="cancel_2",
            detail={"segment_index": 2, "text": "sentence 2"},
            subtitle_state={
                "generation_id": 1,
                "segment_index": 2,
                "text": "sentence 2",
                "playback_started": True,
                "playback_completed": False,
                "revealed_text": "sent",
            },
        )
        service._tasks["task_3"] = BridgeTask(
            task_id="task_3",
            trace_id="trace_1",
            state="ready",
            cancel_token="cancel_3",
            detail={"segment_index": 3, "text": "sentence 3"},
        )

        state = service.subtitle_state("trace_1")
        self.assertTrue(state["is_speaking"])
        self.assertIsNotNone(state["current_speaking"])
        self.assertEqual(state["current_speaking"]["index"], 2)
        self.assertEqual(state["current_speaking"]["text"], "sentence 2")
        self.assertEqual(state["current_speaking"]["revealed_text"], "sent")
        self.assertEqual(len(state["completed_segments"]), 1)
        self.assertEqual(state["completed_segments"][0]["index"], 1)
        self.assertEqual(len(state["pending_segments"]), 1)
        self.assertEqual(state["pending_segments"][0]["index"], 3)
        self.assertEqual(state["pending_segments"][0]["text"], "sentence 3")


class TTSBridgeLipsyncPlaybackMirrorTest(unittest.TestCase):
    def test_streaming_task_status_exposes_chunk_progress(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service._lock = threading.Lock()
        service._synthesis_lock = threading.Lock()
        service._adaptive_lock = threading.Lock()
        service._adaptive_ms_per_char = 270.0
        service.config = type(
            "Config",
            (),
            {
                "preset": DefaultPreset(
                    ref_audio_path=Path("reference.wav"),
                    prompt_text="",
                    prompt_lang="zh",
                    text_lang="zh",
                    text_split_method="cut0",
                    speed_factor=1.0,
                    media_type="raw",
                ),
                "streaming": StreamingConfig(drain_timeout_ms=250, prebuffer_ms=10, rebuffer_ms=20),
            },
        )()
        service.vendor_manager = _ChunkVendor()
        service.player = _StreamingPlayer()
        service.lipsync_bridge = _LipsyncBridge()
        service._task_cancelled_or_stale = lambda task: False
        service._mark_first_chunk_ready = lambda trace_id, generation_id: None
        service._run_subtitle_progress_loop = lambda *, task, duration_ms, duration_holder=None: service.player.progress_snapshot(duration_ms=duration_ms)
        service._player_progress_snapshot = lambda *, duration_ms: service.player.progress_snapshot(duration_ms=duration_ms)
        asset_box: dict[str, AudioAsset] = {}

        def register_ready_segment(**kwargs) -> bool:
            asset_box["asset"] = kwargs["asset"]
            return True

        def play_ready_segment(**kwargs) -> dict[str, object]:
            ready_asset = asset_box["asset"]
            return service._play_streaming_asset(
                task=task,
                asset=ready_asset,
                chunk_buffer=ready_asset.pcm_stream,
            )

        service._register_ready_segment = register_ready_segment
        service._play_ready_segment = play_ready_segment
        service._sliding_window = type(
            "Window",
            (),
            {"is_current_generation": lambda self, *, trace_id, generation_id: True},
        )()
        service._playback = type(
            "Playback",
            (),
            {"finalize_late_result": lambda self, *, is_current_generation, playback_result: playback_result},
        )()
        service._record_adaptive_result = lambda trace_id, metrics, used_batch: None
        service._mark_segment_completed = lambda **kwargs: None
        task = BridgeTask(task_id="task_1", trace_id="trace_1", state="in_progress", cancel_token="cancel_1")
        task.detail["generation_id"] = 1
        task.detail["segment_index"] = 1
        task.detail["text"] = "hello"
        service._tasks = {"task_1": task}

        result = service._speak_streaming(
            task,
            Path("reference.wav"),
            1000,
            profile=StreamingProfile(
                label="test",
                vendor_streaming_mode=2,
                min_chunk_length=32,
                fragment_interval=0.08,
                prebuffer_ms=10,
                rebuffer_ms=20,
            ),
        )
        status = service.task_status("task_1")

        self.assertEqual(result["status"], "delivered")
        self.assertEqual(status["detail"]["chunk_count"], 2)
        self.assertEqual(status["detail"]["total_bytes"], 4)
        self.assertIn("last_chunk_at", status["detail"])

    def test_streaming_lipsync_follows_playback_chunks(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service.config = type(
            "Config",
            (),
            {
                "streaming": StreamingConfig(drain_timeout_ms=250, prebuffer_ms=10, rebuffer_ms=20),
                "lipsync_bridge": LipsyncBridgeConfig(enabled=True, streaming_enabled=True),
            },
        )()
        service.player = _StreamingPlayer()
        service.lipsync_bridge = _LipsyncBridge()
        service._run_subtitle_progress_loop = lambda *, task, duration_ms, duration_holder=None: service.player.progress_snapshot(duration_ms=duration_ms)
        service._player_progress_snapshot = lambda *, duration_ms: service.player.progress_snapshot(duration_ms=duration_ms)
        task = BridgeTask(task_id="task_1", trace_id="trace_1", state="in_progress", cancel_token="cancel_1")
        task.detail["generation_id"] = 1
        task.detail["segment_index"] = 1
        task.detail["text"] = "hello"
        asset = AudioAsset(
            kind="pcm",
            artifact_path=None,
            sample_rate=32000,
            duration_ms=100,
            media_type="raw",
            pcm_stream=iter([b"\x01\x00", b"\x02\x00"]),
            metrics={"prebuffer_ms": 10, "rebuffer_ms": 20},
        )

        result = service._play_streaming_asset(task=task, asset=asset, chunk_buffer=asset.pcm_stream)

        self.assertTrue(result["playback_completed"])
        self.assertEqual(
            service.lipsync_bridge.events,
            [
                ("start", {
                    "trace_id": "trace_1",
                    "generation_id": 1,
                    "segment_index": 1,
                    "task_id": "task_1",
                    "text": "hello",
                    "sample_rate": 32000,
                    "duration_ms": 100,
                }),
                ("chunk", {"task_id": "task_1", "chunk": b"\x01\x00"}),
                ("chunk", {"task_id": "task_1", "chunk": b"\x02\x00"}),
                ("finish", {"task_id": "task_1"}),
            ],
        )

    def test_streaming_progress_starts_before_audio_chunks_are_consumed(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service.config = type(
            "Config",
            (),
            {
                "streaming": StreamingConfig(drain_timeout_ms=250, prebuffer_ms=10, rebuffer_ms=20),
                "lipsync_bridge": LipsyncBridgeConfig(enabled=True, streaming_enabled=False),
            },
        )()
        service.player = _StreamingPlayer()
        service.lipsync_bridge = _LipsyncBridge()
        progress_started = threading.Event()
        progress_before_first_chunk: list[bool] = []

        def progress_loop(*, task, duration_ms, duration_holder=None):
            progress_started.set()
            return service.player.progress_snapshot(duration_ms=duration_ms)

        def chunks():
            progress_before_first_chunk.append(progress_started.wait(timeout=0.2))
            yield b"\x01\x00"

        service._run_subtitle_progress_loop = progress_loop
        service._player_progress_snapshot = lambda *, duration_ms: service.player.progress_snapshot(duration_ms=duration_ms)
        task = BridgeTask(task_id="task_1", trace_id="trace_1", state="in_progress", cancel_token="cancel_1")
        task.detail["generation_id"] = 1
        task.detail["segment_index"] = 1
        task.detail["text"] = "hello"
        asset = AudioAsset(
            kind="pcm",
            artifact_path=None,
            sample_rate=32000,
            duration_ms=100,
            media_type="raw",
            pcm_stream=chunks(),
            metrics={"prebuffer_ms": 10, "rebuffer_ms": 20},
        )

        result = service._play_streaming_asset(task=task, asset=asset, chunk_buffer=asset.pcm_stream)

        self.assertTrue(result["playback_completed"])
        self.assertEqual(progress_before_first_chunk, [True])

    def test_streaming_drain_budget_uses_actual_pcm_duration(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service.config = type(
            "Config",
            (),
            {
                "streaming": StreamingConfig(drain_timeout_ms=250, prebuffer_ms=10, rebuffer_ms=20),
                "lipsync_bridge": LipsyncBridgeConfig(enabled=False, streaming_enabled=False),
            },
        )()
        service.player = _StreamingPlayer()
        service.lipsync_bridge = _LipsyncBridge()
        service._run_subtitle_progress_loop = lambda *, task, duration_ms, duration_holder=None: service.player.progress_snapshot(duration_ms=duration_ms)
        service._player_progress_snapshot = lambda *, duration_ms: service.player.progress_snapshot(duration_ms=duration_ms)
        task = BridgeTask(task_id="task_1", trace_id="trace_1", state="in_progress", cancel_token="cancel_1")
        task.detail["generation_id"] = 1
        task.detail["segment_index"] = 1
        task.detail["text"] = "underestimated"
        asset = AudioAsset(
            kind="pcm",
            artifact_path=None,
            sample_rate=1000,
            duration_ms=100,
            media_type="raw",
            pcm_stream=iter([b"\x01\x00" * 4000]),
            metrics={"prebuffer_ms": 10, "rebuffer_ms": 20},
        )

        result = service._play_streaming_asset(task=task, asset=asset, chunk_buffer=asset.pcm_stream)

        self.assertTrue(result["playback_completed"])
        self.assertIn(("wait_until_drained", 4250), service.player.events)

    def test_streaming_lipsync_is_opt_in_to_avoid_duplicate_audio(self) -> None:
        service = TTSBridgeService.__new__(TTSBridgeService)
        service.config = type(
            "Config",
            (),
            {
                "streaming": StreamingConfig(drain_timeout_ms=250, prebuffer_ms=10, rebuffer_ms=20),
                "lipsync_bridge": LipsyncBridgeConfig(enabled=True, streaming_enabled=False),
            },
        )()
        service.player = _StreamingPlayer()
        service.lipsync_bridge = _LipsyncBridge()
        service._run_subtitle_progress_loop = lambda *, task, duration_ms, duration_holder=None: service.player.progress_snapshot(duration_ms=duration_ms)
        service._player_progress_snapshot = lambda *, duration_ms: service.player.progress_snapshot(duration_ms=duration_ms)
        task = BridgeTask(task_id="task_1", trace_id="trace_1", state="in_progress", cancel_token="cancel_1")
        task.detail["generation_id"] = 1
        task.detail["segment_index"] = 1
        task.detail["text"] = "hello"
        asset = AudioAsset(
            kind="pcm",
            artifact_path=None,
            sample_rate=32000,
            duration_ms=100,
            media_type="raw",
            pcm_stream=iter([b"\x01\x00", b"\x02\x00"]),
            metrics={"prebuffer_ms": 10, "rebuffer_ms": 20},
        )

        result = service._play_streaming_asset(task=task, asset=asset, chunk_buffer=asset.pcm_stream)

        self.assertTrue(result["playback_completed"])
        self.assertEqual(service.lipsync_bridge.events, [])
        self.assertEqual(
            service.player.events[:4],
            [
                ("start_stream", 32000),
                ("feed", b"\x01\x00"),
                ("feed", b"\x02\x00"),
                ("finish_stream", None),
            ],
        )
        self.assertEqual(
            service.player.events[:4],
            [
                ("start_stream", 32000),
                ("feed", b"\x01\x00"),
                ("feed", b"\x02\x00"),
                ("finish_stream", None),
            ],
        )


if __name__ == "__main__":
    unittest.main()
