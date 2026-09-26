"""test_config_loading.py — Unit tests for TTSBridgeConfig loading and parsing.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from lifecycle_handlers import (
    TTSBridgeConfig,
    TTSBridgeConfigError,
    _optional_path,
    _parse_lipsync_bridge_config,
    _parse_preset_config,
    _parse_streaming_config,
    _parse_subtitle_sync_config,
    _parse_vendor_config,
    _resolve_path,
)


class TestConfigLoading(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.dir_path = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _create_config_file(self, content: str) -> Path:
        # Create a nested path so parents[3] works as repo_root
        nested_dir = self.dir_path / "a" / "b" / "c"
        nested_dir.mkdir(parents=True, exist_ok=True)
        config_file = nested_dir / "tts_bridge.toml"
        config_file.write_text(content, encoding="utf-8")
        return config_file

    def test_file_not_found(self) -> None:
        non_existent = self.dir_path / "does_not_exist.toml"
        with self.assertRaises(TTSBridgeConfigError) as ctx:
            TTSBridgeConfig.load(non_existent)
        self.assertIn("config file not found", str(ctx.exception))

    def test_load_minimal_defaults(self) -> None:
        toml_content = """
        service_name = "custom_tts"
        port = 8888
        """
        config_file = self._create_config_file(toml_content)
        cfg = TTSBridgeConfig.load(config_file)

        self.assertEqual(cfg.service_name, "custom_tts")
        self.assertEqual(cfg.port, 8888)
        self.assertEqual(cfg.host, "127.0.0.1")
        self.assertEqual(cfg.vendor_port, 9880)
        self.assertEqual(cfg.vendor.api_style, "api_v2")
        self.assertEqual(cfg.preset.prompt_lang, "zh")
        self.assertEqual(cfg.streaming.stream_strategy, "adaptive")
        self.assertFalse(cfg.subtitle_sync.enabled)
        self.assertFalse(cfg.lipsync_bridge.enabled)

    def test_load_full_config(self) -> None:
        toml_content = """
        service_name = "full_tts"
        base_url = "http://localhost:8102/"
        host = "0.0.0.0"
        port = 8102
        vendor_port = 9880
        startup_timeout_ms = 45000
        request_timeout_ms = 5000
        output_dir = "my_output"
        playback_enabled = true

        [vendor]
        api_style = "custom_api"
        python_executable = "python"
        entry_script = "script.py"
        tts_config_path = "config.yaml"
        gpt_model_path = "models/gpt.ckpt"
        sovits_model_path = "models/sovits.pth"
        device = "cuda:0"

        [preset]
        ref_audio_path = "ref.wav"
        prompt_text = "prompt text"
        prompt_lang = "en"
        text_lang = "en"
        text_split_method = "cut1"
        speed_factor = 1.2
        media_type = "mp3"

        [streaming]
        enabled = true
        stream_strategy = "fixed_streaming"
        media_type = "raw"
        sample_rate = 24000
        vendor_streaming_mode = 1
        first_chunk_vendor_streaming_mode = 2
        device = "cuda:0"
        mirror_device = "cpu"

        [subtitle_sync]
        enabled = true
        obs_base_url = "http://127.0.0.1:8104/"
        progress_interval_ms = 50
        fallback_mode = "full"

        [lipsync_bridge]
        enabled = true
        streaming_enabled = true
        base_url = "http://127.0.0.1:8105/"
        request_timeout_ms = 300
        inline_pcm_max_bytes = 8192
        max_workers = 2
        max_pending_requests = 32
        stream_chunk_min_interval_ms = 100
        drop_log_interval_ms = 1000
        """
        config_file = self._create_config_file(toml_content)
        cfg = TTSBridgeConfig.load(config_file)

        self.assertEqual(cfg.service_name, "full_tts")
        self.assertEqual(cfg.base_url, "http://localhost:8102")
        self.assertEqual(cfg.host, "0.0.0.0")
        self.assertTrue(cfg.playback_enabled)
        self.assertEqual(cfg.vendor.device, "cuda:0")
        self.assertEqual(cfg.vendor.api_style, "custom_api")
        self.assertEqual(cfg.preset.speed_factor, 1.2)
        self.assertEqual(cfg.preset.text_split_method, "cut1")
        self.assertEqual(cfg.streaming.stream_strategy, "fixed_streaming")
        self.assertEqual(cfg.streaming.sample_rate, 24000)
        self.assertEqual(cfg.streaming.first_chunk_vendor_streaming_mode, 2)
        self.assertEqual(cfg.streaming.device, "cuda:0")
        self.assertEqual(cfg.streaming.mirror_device, "cpu")
        self.assertTrue(cfg.subtitle_sync.enabled)
        self.assertEqual(cfg.subtitle_sync.obs_base_url, "http://127.0.0.1:8104")
        self.assertTrue(cfg.lipsync_bridge.enabled)
        self.assertTrue(cfg.lipsync_bridge.streaming_enabled)
        self.assertEqual(cfg.lipsync_bridge.base_url, "http://127.0.0.1:8105")
        self.assertEqual(cfg.lipsync_bridge.inline_pcm_max_bytes, 8192)

    def test_vendor_not_dict(self) -> None:
        toml_content = """
        vendor = "not_a_dict"
        """
        config_file = self._create_config_file(toml_content)
        with self.assertRaises(TTSBridgeConfigError) as ctx:
            TTSBridgeConfig.load(config_file)
        self.assertIn("invalid [vendor] section", str(ctx.exception))

    def test_preset_not_dict(self) -> None:
        toml_content = """
        preset = 123
        """
        config_file = self._create_config_file(toml_content)
        with self.assertRaises(TTSBridgeConfigError) as ctx:
            TTSBridgeConfig.load(config_file)
        self.assertIn("invalid [preset] section", str(ctx.exception))

    def test_invalid_streaming_strategy(self) -> None:
        toml_content = """
        [streaming]
        stream_strategy = "invalid_strategy"
        """
        config_file = self._create_config_file(toml_content)
        with self.assertRaises(TTSBridgeConfigError) as ctx:
            TTSBridgeConfig.load(config_file)
        self.assertIn("invalid streaming.stream_strategy", str(ctx.exception))

    def test_path_helpers(self) -> None:
        repo_root = Path("/root/repo")
        # Empty / dot
        self.assertEqual(_resolve_path(repo_root, Path("")), Path(""))
        self.assertEqual(_resolve_path(repo_root, Path(".")), Path("."))
        # Relative
        self.assertEqual(_resolve_path(repo_root, Path("sub/dir")), repo_root / "sub/dir")
        # Optional path
        self.assertIsNone(_optional_path(repo_root, ""))
        self.assertIsNone(_optional_path(repo_root, "   "))
        self.assertEqual(_optional_path(repo_root, "models/test"), repo_root / "models/test")

    def test_lipsync_clamping(self) -> None:
        raw = {
            "request_timeout_ms": 10,  # Below min 50
            "inline_pcm_max_bytes": 100,  # Below min 4096
            "max_workers": 0,  # Below min 1
            "max_pending_requests": -5,  # Below min 1
            "stream_chunk_min_interval_ms": -1,  # Below min 0
            "drop_log_interval_ms": -1,  # Below min 0
        }
        cfg = _parse_lipsync_bridge_config(raw)
        self.assertEqual(cfg.request_timeout_ms, 50)
        self.assertEqual(cfg.inline_pcm_max_bytes, 4096)
        self.assertEqual(cfg.max_workers, 1)
        self.assertEqual(cfg.max_pending_requests, 1)
        self.assertEqual(cfg.stream_chunk_min_interval_ms, 0)
        self.assertEqual(cfg.drop_log_interval_ms, 0)


if __name__ == "__main__":
    unittest.main()
