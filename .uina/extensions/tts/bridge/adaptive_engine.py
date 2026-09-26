"""adaptive_engine.py — Adaptive streaming strategy and duration learning engine.

Encapsulates:
- Trace-level adaptive streaming strategy (force_batch vs streaming fallback/recovery).
- Real-time synthesis metric evaluation (playback start latency, rebuffer count, max gap, RTF).
- Exponential Moving Average (EMA) learning of ms_per_char for duration estimation.
"""
from __future__ import annotations

import threading
from typing import Any

from models import AdaptiveTraceState, StreamingConfig, StreamingProfile


class AdaptiveStrategyEngine:
    """Manages adaptive streaming fallback, recovery states, and duration estimation."""

    def __init__(self, config: StreamingConfig, *, initial_ms_per_char: float = 270.0) -> None:
        self.config = config
        self.states: dict[str, AdaptiveTraceState] = {}
        self.ms_per_char = initial_ms_per_char
        self.lock = threading.Lock()

    def get_state(self, trace_id: str) -> AdaptiveTraceState:
        return self.states.setdefault(trace_id, AdaptiveTraceState())

    def should_force_batch(self, trace_id: str) -> bool:
        if self.config.stream_strategy != "adaptive":
            return False
        state = self.states.get(trace_id)
        return bool(state is not None and state.force_batch)

    def record_result(self, trace_id: str, metrics: dict[str, Any], *, used_batch: bool) -> None:
        if self.config.stream_strategy != "adaptive":
            return

        state = self.get_state(trace_id)
        if used_batch:
            self._record_batch_result(state)
            return

        self._record_streaming_result(state, metrics)

    def _record_batch_result(self, state: AdaptiveTraceState) -> None:
        state.consecutive_batch_successes += 1
        if state.consecutive_batch_successes >= self.config.adaptive_batch_recovery_successes:
            state.force_batch = False
            state.consecutive_batch_successes = 0
            state.conservative_stream_successes = 0
        else:
            state.force_batch = True

    def _record_streaming_result(self, state: AdaptiveTraceState, metrics: dict[str, Any]) -> None:
        state.consecutive_batch_successes = 0
        if self._is_threshold_breached(metrics):
            state.force_batch = True
            state.conservative_stream_successes = 0
            return

        if state.force_batch:
            state.conservative_stream_successes += 1
            if state.conservative_stream_successes >= self.config.adaptive_batch_recovery_successes:
                state.force_batch = False
                state.conservative_stream_successes = 0
        else:
            state.conservative_stream_successes = 0

    def _is_threshold_breached(self, metrics: dict[str, Any]) -> bool:
        playback_start_latency_ms = float(metrics.get("playback_start_latency_ms") or 0.0)
        rebuffer_count = int(metrics.get("rebuffer_count", 0) or 0)
        max_chunk_gap_ms = float(metrics.get("max_chunk_gap_ms") or 0.0)
        realtime_factor = float(metrics.get("realtime_factor") or 0.0)

        return (
            playback_start_latency_ms > self.config.adaptive_playback_start_latency_ms
            or rebuffer_count >= self.config.adaptive_rebuffer_threshold
            or max_chunk_gap_ms >= self.config.adaptive_max_chunk_gap_ms
            or realtime_factor < self.config.adaptive_realtime_factor_threshold
        )

    def get_conservative_profile(self, trace_id: str) -> StreamingProfile | None:
        """Returns conservative profile if trace is in force_batch/recovery state, else None."""
        if self.config.stream_strategy != "adaptive":
            return None
        state = self.states.get(trace_id)
        if state is not None and state.force_batch:
            return StreamingProfile(
                label="adaptive_recovery_conservative",
                vendor_streaming_mode=self.config.vendor_streaming_mode,
                min_chunk_length=max(self.config.min_chunk_length, 48),
                fragment_interval=max(self.config.fragment_interval, 0.10),
                prebuffer_ms=max(self.config.prebuffer_ms, 180),
                rebuffer_ms=max(self.config.rebuffer_ms, 480),
            )
        return None

    def estimate_duration_ms(self, text: str, *, speed_factor: float) -> int:
        """自适应估算 segment 总时长。

        用历史 segment 的实际每字时长（按 speed_factor=1.0 归一化）预测当前 segment。
        3% 安全余量确保估算略偏大，字幕几乎完全对齐但不超前。
        """
        compact = "".join(ch for ch in text if not ch.isspace())
        if not compact:
            return 1000
        adjusted_speed = max(speed_factor, 0.2)
        with self.lock:
            ms_per_char = self.ms_per_char * 1.03 / adjusted_speed
        return max(int(len(compact) * ms_per_char), 400)

    def update_duration(self, actual_ms: int, char_count: int, speed_factor: float) -> None:
        """producer 完成后用实际时长更新自适应历史（EMA）。"""
        if char_count <= 0 or actual_ms <= 0:
            return
        adjusted_speed = max(speed_factor, 0.2)
        actual_ms_per_char_normalized = actual_ms / char_count * adjusted_speed
        with self.lock:
            self.ms_per_char = (
                0.5 * self.ms_per_char + 0.5 * actual_ms_per_char_normalized
            )

    def reset_trace(self, trace_id: str) -> None:
        self.states.pop(trace_id, None)
