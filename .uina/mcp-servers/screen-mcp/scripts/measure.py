from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).parent))
from smoke import run  # noqa: E402
from uina_screen_mcp.measure import gate_report, summarize_samples


async def probe(tool: str, arguments: str, samples: int) -> dict[str, object]:
    rows: list[dict[str, object]] = []
    for index in range(samples):
        started = time.perf_counter()
        try:
            exit_code = await run(argparse.Namespace(python=None, tool=tool, args=arguments, check_only=False, timeout=30))
            status = "ok" if exit_code == 0 else "error"
        except Exception as exc:
            status = "error"
            _ = exc
        rows.append({"scenario": tool, "phase": "cold", "sample": index + 1, "status": status, "durationMs": (time.perf_counter() - started) * 1000})
    return {"tool": tool, "samples": rows, **summarize_samples(rows)}


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=False)
    probe_parser = subparsers.add_parser("probe")
    probe_parser.add_argument("--tool", default="Screenshot")
    probe_parser.add_argument("--args", default="{}")
    probe_parser.add_argument("--samples", type=int, default=5)
    probe_parser.add_argument("--output", type=Path)
    gate_parser = subparsers.add_parser("gate")
    gate_parser.add_argument("--report", type=Path, required=True)
    gate_parser.add_argument("--criteria", type=Path, required=True)
    gate_parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "gate":
        report = gate_report(json.loads(args.report.read_text(encoding="utf-8")), json.loads(args.criteria.read_text(encoding="utf-8")))
    else:
        report = asyncio.run(probe(args.tool, args.args, args.samples))
    text = json.dumps(report, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if report.get("passed", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
