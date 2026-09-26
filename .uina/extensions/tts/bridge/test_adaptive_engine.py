"""test_adaptive_engine.py — Unit tests for AdaptiveStrategyEngine.
"""
from __future__ import annotations

import unittest

from adaptive_engine import AdaptiveStrategyEngine
from models import StreamingConfig


class TestAdaptiveStrategyEngine(unittest.TestCase):
    def setUp(self) -> None:
        self.config = StreamingConfig(
            stream_strategy="adaptive",
            adaptive_playback_start_latency_ms=1600,
            adaptive_rebuffer_threshold=2,
            adaptive_max_chunk_gap_ms=400.0,
            adaptive_realtime_factor_threshold=0.85,
            adaptive_batch_recovery_successes=2,
            vendor_streaming_mode=2,
            min_chunk_length=48,
            fragment_interval=0.10,
            prebuffer_ms=180,
            rebuffer_ms=480,
        )
        self.engine = AdaptiveStrategyEngine(self.config, initial_ms_per_char=200.0)

    def test_initial_state(self) -> None:
        self.assertFalse(self.engine.should_force_batch("trace_1"))
        self.assertIsNone(self.engine.get_conservative_profile("trace_1"))

    def test_non_adaptive_strategy_ignores_results(self) -> None:
        non_adaptive_cfg = StreamingConfig(stream_strategy="fixed_streaming")
        engine = AdaptiveStrategyEngine(non_adaptive_cfg)
        engine.record_result(
            "trace_1",
            {"rebuffer_count": 10},
            used_batch=False,
        )
        self.assertFalse(engine.should_force_batch("trace_1"))
        self.assertIsNone(engine.get_conservative_profile("trace_1"))

    def test_streaming_success_maintains_normal_state(self) -> None:
        normal_metrics = {
            "playback_start_latency_ms": 500,
            "rebuffer_count": 0,
            "max_chunk_gap_ms": 100.0,
            "realtime_factor": 1.5,
        }
        self.engine.record_result("trace_1", normal_metrics, used_batch=False)
        self.assertFalse(self.engine.should_force_batch("trace_1"))
        self.assertIsNone(self.engine.get_conservative_profile("trace_1"))

    def test_breach_playback_start_latency(self) -> None:
        metrics = {"playback_start_latency_ms": 2000}
        self.engine.record_result("trace_1", metrics, used_batch=False)
        self.assertTrue(self.engine.should_force_batch("trace_1"))
        profile = self.engine.get_conservative_profile("trace_1")
        self.assertIsNotNone(profile)
        self.assertEqual(profile.label, "adaptive_recovery_conservative")

    def test_breach_rebuffer_count(self) -> None:
        metrics = {"rebuffer_count": 2}
        self.engine.record_result("trace_1", metrics, used_batch=False)
        self.assertTrue(self.engine.should_force_batch("trace_1"))

    def test_breach_max_chunk_gap(self) -> None:
        metrics = {"max_chunk_gap_ms": 450.0}
        self.engine.record_result("trace_1", metrics, used_batch=False)
        self.assertTrue(self.engine.should_force_batch("trace_1"))

    def test_breach_low_realtime_factor(self) -> None:
        metrics = {"realtime_factor": 0.5}
        self.engine.record_result("trace_1", metrics, used_batch=False)
        self.assertTrue(self.engine.should_force_batch("trace_1"))

    def test_batch_recovery_annealing(self) -> None:
        # First breach
        self.engine.record_result("trace_1", {"rebuffer_count": 3}, used_batch=False)
        self.assertTrue(self.engine.should_force_batch("trace_1"))

        # 1st batch success: still forced
        self.engine.record_result("trace_1", {}, used_batch=True)
        self.assertTrue(self.engine.should_force_batch("trace_1"))

        # 2nd batch success: recovers
        self.engine.record_result("trace_1", {}, used_batch=True)
        self.assertFalse(self.engine.should_force_batch("trace_1"))

    def test_conservative_stream_recovery_annealing(self) -> None:
        # Force batch
        self.engine.record_result("trace_1", {"rebuffer_count": 3}, used_batch=False)
        self.assertTrue(self.engine.should_force_batch("trace_1"))

        normal_metrics = {
            "playback_start_latency_ms": 500,
            "rebuffer_count": 0,
            "max_chunk_gap_ms": 100.0,
            "realtime_factor": 1.5,
        }
        # 1st normal stream success: still forced
        self.engine.record_result("trace_1", normal_metrics, used_batch=False)
        self.assertTrue(self.engine.should_force_batch("trace_1"))

        # 2nd normal stream success: recovers
        self.engine.record_result("trace_1", normal_metrics, used_batch=False)
        self.assertFalse(self.engine.should_force_batch("trace_1"))

    def test_duration_estimation_empty_text(self) -> None:
        self.assertEqual(self.engine.estimate_duration_ms("", speed_factor=1.0), 1000)
        self.assertEqual(self.engine.estimate_duration_ms("   ", speed_factor=1.0), 1000)

    def test_duration_estimation_and_ema(self) -> None:
        # Initial ms_per_char = 200.0
        # Text: 10 chars -> 10 * 200.0 * 1.03 / 1.0 = 2060ms
        estimated = self.engine.estimate_duration_ms("abcdefghij", speed_factor=1.0)
        self.assertEqual(estimated, 2060)

        # Update with actual 3000ms for 10 chars at speed 1.0 (actual = 300ms/char)
        # New EMA = 0.5 * 200 + 0.5 * 300 = 250.0
        self.engine.update_duration(actual_ms=3000, char_count=10, speed_factor=1.0)
        self.assertAlmostEqual(self.engine.ms_per_char, 250.0)

        # New estimate: 10 * 250.0 * 1.03 / 1.0 = 2575ms
        self.assertEqual(self.engine.estimate_duration_ms("abcdefghij", speed_factor=1.0), 2575)

    def test_update_duration_invalid_inputs(self) -> None:
        prev = self.engine.ms_per_char
        self.engine.update_duration(actual_ms=0, char_count=10, speed_factor=1.0)
        self.assertEqual(self.engine.ms_per_char, prev)
        self.engine.update_duration(actual_ms=1000, char_count=0, speed_factor=1.0)
        self.assertEqual(self.engine.ms_per_char, prev)

    def test_reset_trace(self) -> None:
        self.engine.record_result("trace_1", {"rebuffer_count": 3}, used_batch=False)
        self.assertTrue(self.engine.should_force_batch("trace_1"))
        self.engine.reset_trace("trace_1")
        self.assertFalse(self.engine.should_force_batch("trace_1"))


if __name__ == "__main__":
    unittest.main()
