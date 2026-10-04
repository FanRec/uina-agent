from __future__ import annotations

from uina_screen_mcp.measure import gate_report, percentile, summarize_samples


def test_percentiles_are_computed_per_scenario() -> None:
    report = summarize_samples([
        {"scenario": "desktop", "phase": "warm", "status": "ok", "durationMs": 10},
        {"scenario": "desktop", "phase": "warm", "status": "ok", "durationMs": 20},
        {"scenario": "window", "phase": "warm", "status": "ok", "durationMs": 100},
    ])
    assert report["scenarios"]["desktop"]["warm"]["p50Ms"] == 10
    assert report["scenarios"]["window"]["warm"]["p50Ms"] == 100
    assert percentile([1, 2, 3, 4], 0.95) == 4


def test_gate_rejects_missing_or_unapproved_criteria() -> None:
    result = gate_report({"scenarios": {}}, {})
    assert result["passed"] is False
    assert any("approved" in error for error in result["errors"])


def test_timeout_samples_are_not_silently_dropped() -> None:
    report = summarize_samples([
        {"scenario": "desktop", "phase": "warm", "status": "ok", "durationMs": 10},
        {"scenario": "desktop", "phase": "warm", "status": "timeout", "durationMs": 5000},
    ])
    assert report["scenarios"]["desktop"]["warm"]["samples"] == 2
    assert report["scenarios"]["desktop"]["warm"]["failureRate"] == 0.5
