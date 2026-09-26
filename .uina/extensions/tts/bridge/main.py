from __future__ import annotations

from pathlib import Path
import sys
import traceback

if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import parse_args, run_server, run_streaming_diagnostic


def main() -> None:
    config_path = Path(__file__).resolve().parent / "config" / "service.toml"
    args = parse_args()
    if args.diagnose_streaming:
        try:
            result = run_streaming_diagnostic(
                args.config,
                text=args.text,
                repeats=args.diagnostic_repeats,
            )
        except Exception:
            traceback.print_exc()
            raise
        print(result, flush=True)
        return
    if args.serve:
        run_server(args.config)
        return
    print(f"tts_bridge ready: {config_path}")


if __name__ == "__main__":
    main()
