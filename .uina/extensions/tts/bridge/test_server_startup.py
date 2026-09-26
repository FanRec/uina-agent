from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path
import sys

BRIDGE_DIR = Path(__file__).resolve().parent
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

import server


class RunServerTests(unittest.TestCase):
    def test_run_server_resolves_tts_service_at_runtime(self) -> None:
        config = SimpleNamespace(host="127.0.0.1", port=8102)
        service = object()
        app = object()

        with (
            patch.object(server.TTSBridgeConfig, "load", return_value=config),
            patch("service.TTSBridgeService", return_value=service),
            patch.object(server, "build_app", return_value=app),
            patch.object(server.uvicorn, "run") as uvicorn_run,
        ):
            server.run_server("service.toml")

        uvicorn_run.assert_called_once_with(
            app,
            host="127.0.0.1",
            port=8102,
            log_level="info",
        )


if __name__ == "__main__":
    unittest.main()
