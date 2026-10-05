from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

request = json.loads(sys.stdin.readline())
payload = request.get("payload", {})
marker = payload.get("markerPath")
if marker:
    Path(marker).write_text(str(os.getpid()), encoding="ascii")
if payload.get("sleepMs"):
    import time
    time.sleep(payload["sleepMs"] / 1000)
if payload.get("hang"):
    import time
    time.sleep(60)
if payload.get("stderr"):
    print(payload["stderr"], file=sys.stderr)
if payload.get("fail"):
    raise SystemExit(int(payload["fail"]))
print(json.dumps({"ok": True, "payload": {"operation": request["operation"], "marker": marker}, "diagnostics": {}, "error": None}))
