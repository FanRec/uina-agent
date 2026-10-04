from __future__ import annotations

from collections import defaultdict
from math import ceil
from typing import Any


def percentile(values: list[float], quantile: float) -> float:
    if not values or not 0 <= quantile <= 1:
        raise ValueError("percentile requires non-empty values and quantile in [0, 1]")
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, ceil(len(ordered) * quantile) - 1))
    return ordered[index]


def summarize_samples(samples: list[dict[str, Any]]) -> dict[str, Any]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        scenario = sample.get("scenario")
        phase = sample.get("phase")
        if not isinstance(scenario, str) or not isinstance(phase, str):
            raise ValueError("each sample requires scenario and phase")
        if not isinstance(sample.get("durationMs"), (int, float)) or sample["durationMs"] < 0:
            raise ValueError("each sample requires non-negative durationMs")
        groups[(scenario, phase)].append(sample)
    scenarios: dict[str, Any] = {}
    for (scenario, phase), rows in groups.items():
        failures = sum(1 for row in rows if row.get("status") != "ok")
        durations = [float(row["durationMs"]) for row in rows if row.get("status") == "ok"]
        if not durations:
            p50 = p95 = None
        else:
            p50, p95 = percentile(durations, 0.50), percentile(durations, 0.95)
        scenarios.setdefault(scenario, {})[phase] = {
            "samples": len(rows),
            "failures": failures,
            "failureRate": failures / len(rows),
            "p50Ms": p50,
            "p95Ms": p95,
        }
    return {"scenarios": scenarios, "sampleCount": len(samples)}


def validate_criteria(criteria: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for key in ("approvedAt", "approvedBy", "environment", "defaultMaxDimension", "samples"):
        if not criteria.get(key):
            errors.append(f"missing approved criteria field: {key}")
    if not isinstance(criteria.get("scenarios"), dict) or not criteria["scenarios"]:
        errors.append("missing approved criteria field: scenarios")
    else:
        for scenario, phases in criteria["scenarios"].items():
            if not isinstance(phases, dict):
                errors.append(f"scenario {scenario} must be an object")
                continue
            for phase in ("warm", "cold"):
                gate = phases.get(phase)
                if not isinstance(gate, dict):
                    errors.append(f"scenario {scenario} missing {phase} criteria")
                    continue
                for key in ("p50Ms", "p95Ms", "maxFailureRate"):
                    if not isinstance(gate.get(key), (int, float)):
                        errors.append(f"scenario {scenario}/{phase} missing {key}")
    return errors


def gate_report(report: dict[str, Any], criteria: dict[str, Any]) -> dict[str, Any]:
    errors = validate_criteria(criteria)
    if errors:
        return {"passed": False, "errors": errors}
    failures: list[str] = []
    for scenario, phases in criteria["scenarios"].items():
        actual_phases = report.get("scenarios", {}).get(scenario)
        if not isinstance(actual_phases, dict):
            failures.append(f"missing measured scenario: {scenario}")
            continue
        for phase, gate in phases.items():
            actual = actual_phases.get(phase)
            if not isinstance(actual, dict) or actual.get("p95Ms") is None:
                failures.append(f"missing successful samples: {scenario}/{phase}")
                continue
            if actual["p50Ms"] > gate["p50Ms"]:
                failures.append(f"p50 exceeded: {scenario}/{phase}")
            if actual["p95Ms"] > gate["p95Ms"]:
                failures.append(f"p95 exceeded: {scenario}/{phase}")
            if actual["failureRate"] > gate["maxFailureRate"]:
                failures.append(f"failure rate exceeded: {scenario}/{phase}")
    return {"passed": not failures, "errors": failures}
