"""lifecycle_handlers.py — 生命周期/配置相关的自包含模块级组件。

本模块承载 TTS bridge 的配置结构与解析，以及不依赖 ``TTSBridgeService``
实例状态的路径工具。``TTSBridgeService`` 类的 startup/shutdown/健康检查方法
保留在 service.py；这里只搬模块级、无 ``self`` 依赖的定义，语义与原文件逐条等价。
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 and older GPT-SoVITS runtimes.
    import tomli as tomllib

from models import (
    DefaultPreset,
    LipsyncBridgeConfig,
    StreamingConfig,
    SubtitleSyncConfig,
    VendorConfig,
)


class TTSBridgeConfigError(RuntimeError):
    pass


def _resolve_path(repo_root: Path, value: Path) -> Path:
    raw = str(value).strip()
    if raw in {"", "."}:
        return value
    return value if value.is_absolute() else (repo_root / value)


def _optional_path(repo_root: Path, raw: str) -> Path | None:
    normalized = str(raw).strip()
    if not normalized:
        return None
    return _resolve_path(repo_root, Path(normalized))


def _parse_vendor_config(repo_root: Path, raw: Any) -> VendorConfig:
    if not isinstance(raw, dict):
        raise TTSBridgeConfigError("invalid [vendor] section")
    return VendorConfig(
        api_style=str(raw.get("api_style", "api_v2")).strip() or "api_v2",
        python_executable=str(
            _resolve_path(repo_root, Path(str(raw.get("python_executable", sys.executable))))
        ).strip()
        or sys.executable,
        entry_script=_resolve_path(
            repo_root,
            Path(str(raw.get("entry_script", "services/tts_bridge/vendor/gpt_sovits_v2pro/api_v2.py"))),
        ),
        tts_config_path=_optional_path(
            repo_root,
            str(
                raw.get(
                    "tts_config_path",
                    "services/tts_bridge/vendor/gpt_sovits_v2pro/GPT_SoVITS/configs/tts_infer.yaml",
                )
            ),
        ),
        gpt_model_path=_optional_path(repo_root, str(raw.get("gpt_model_path", ""))),
        sovits_model_path=_optional_path(repo_root, str(raw.get("sovits_model_path", ""))),
        device=str(raw.get("device", "cpu")).strip() or "cpu",
    )


def _parse_preset_config(repo_root: Path, raw: Any) -> DefaultPreset:
    if not isinstance(raw, dict):
        raise TTSBridgeConfigError("invalid [preset] section")
    return DefaultPreset(
        ref_audio_path=_optional_path(repo_root, str(raw.get("ref_audio_path", ""))),
        prompt_text=str(raw.get("prompt_text", "")),
        prompt_lang=str(raw.get("prompt_lang", "zh")).strip() or "zh",
        text_lang=str(raw.get("text_lang", "zh")).strip() or "zh",
        text_split_method=str(raw.get("text_split_method", "cut5")).strip() or "cut5",
        speed_factor=float(raw.get("speed_factor", 1.0)),
        media_type=str(raw.get("media_type", "wav")).strip() or "wav",
    )


def _parse_streaming_config(raw: Any) -> StreamingConfig:
    streaming_raw = raw if isinstance(raw, dict) else {}
    streaming_device_raw = str(streaming_raw.get("device", "")).strip()
    streaming_mirror_device_raw = str(streaming_raw.get("mirror_device", "")).strip()
    stream_strategy_raw = str(streaming_raw.get("stream_strategy", "adaptive")).strip() or "adaptive"
    if stream_strategy_raw not in {"adaptive", "fixed_streaming", "fixed_batch"}:
        raise TTSBridgeConfigError(f"invalid streaming.stream_strategy: {stream_strategy_raw}")
    return StreamingConfig(
        enabled=bool(streaming_raw.get("enabled", True)),
        stream_strategy=stream_strategy_raw,  # type: ignore[arg-type]
        media_type=str(streaming_raw.get("media_type", "raw")).strip() or "raw",
        sample_rate=int(streaming_raw.get("sample_rate", 32000)),
        vendor_streaming_mode=int(streaming_raw.get("vendor_streaming_mode", 2)),
        min_chunk_length=int(streaming_raw.get("min_chunk_length", 48)),
        fragment_interval=float(streaming_raw.get("fragment_interval", 0.10)),
        first_chunk_vendor_streaming_mode=(
            int(streaming_raw["first_chunk_vendor_streaming_mode"])
            if "first_chunk_vendor_streaming_mode" in streaming_raw
            else None
        ),
        first_chunk_min_chunk_length=max(1, int(streaming_raw.get("first_chunk_min_chunk_length", 24))),
        first_chunk_fragment_interval=max(0.01, float(streaming_raw.get("first_chunk_fragment_interval", 0.05))),
        first_chunk_prebuffer_ms=max(0, int(streaming_raw.get("first_chunk_prebuffer_ms", 100))),
        first_chunk_gate_timeout_ms=max(0, int(streaming_raw.get("first_chunk_gate_timeout_ms", 1800))),
        warmup_enabled=bool(streaming_raw.get("warmup_enabled", True)),
        warmup_text=str(streaming_raw.get("warmup_text", "嗯。")).strip() or "嗯。",
        warmup_timeout_ms=max(1000, int(streaming_raw.get("warmup_timeout_ms", 25000))),
        batch_size=int(streaming_raw.get("batch_size", 1)),
        prebuffer_ms=int(streaming_raw.get("prebuffer_ms", 260)),
        rebuffer_ms=int(streaming_raw.get("rebuffer_ms", 420)),
        drain_timeout_ms=int(streaming_raw.get("drain_timeout_ms", 2000)),
        stream_idle_timeout_ms=max(1000, int(streaming_raw.get("stream_idle_timeout_ms", 60000))),
        stream_total_timeout_ms=max(1000, int(streaming_raw.get("stream_total_timeout_ms", 120000))),
        synthesis_lock_timeout_ms=max(1000, int(streaming_raw.get("synthesis_lock_timeout_ms", 60000))),
        max_delivery_task_ms=max(5000, int(streaming_raw.get("max_delivery_task_ms", 60000))),
        fallback_to_batch_on_failure=bool(streaming_raw.get("fallback_to_batch_on_failure", True)),
        adaptive_playback_start_latency_ms=int(streaming_raw.get("adaptive_playback_start_latency_ms", 2000)),
        adaptive_rebuffer_threshold=int(streaming_raw.get("adaptive_rebuffer_threshold", 2)),
        adaptive_max_chunk_gap_ms=float(streaming_raw.get("adaptive_max_chunk_gap_ms", 400.0)),
        adaptive_realtime_factor_threshold=float(streaming_raw.get("adaptive_realtime_factor_threshold", 0.85)),
        adaptive_batch_recovery_successes=int(streaming_raw.get("adaptive_batch_recovery_successes", 2)),
        device=streaming_device_raw or None,
        mirror_device=streaming_mirror_device_raw or None,
    )


def _parse_subtitle_sync_config(raw: Any) -> SubtitleSyncConfig:
    subtitle_sync_raw = raw if isinstance(raw, dict) else {}
    return SubtitleSyncConfig(
        enabled=bool(subtitle_sync_raw.get("enabled", False)),
        obs_base_url=str(subtitle_sync_raw.get("obs_base_url", "http://127.0.0.1:8104")).strip().rstrip("/"),
        progress_interval_ms=int(subtitle_sync_raw.get("progress_interval_ms", 33)),
        fallback_mode=str(subtitle_sync_raw.get("fallback_mode", "sentence_only")).strip() or "sentence_only",
    )


def _parse_lipsync_bridge_config(raw: Any) -> LipsyncBridgeConfig:
    lipsync_bridge_raw = raw if isinstance(raw, dict) else {}
    return LipsyncBridgeConfig(
        enabled=bool(lipsync_bridge_raw.get("enabled", False)),
        streaming_enabled=bool(lipsync_bridge_raw.get("streaming_enabled", False)),
        base_url=str(lipsync_bridge_raw.get("base_url", "http://127.0.0.1:8105")).strip().rstrip("/"),
        request_timeout_ms=max(50, int(lipsync_bridge_raw.get("request_timeout_ms", 250) or 250)),
        inline_pcm_max_bytes=max(4096, int(lipsync_bridge_raw.get("inline_pcm_max_bytes", 4 * 1024 * 1024) or 4 * 1024 * 1024)),
        max_workers=max(1, int(lipsync_bridge_raw.get("max_workers", 1) or 1)),
        max_pending_requests=max(1, int(lipsync_bridge_raw.get("max_pending_requests", 16) or 16)),
        stream_chunk_min_interval_ms=max(0, int(lipsync_bridge_raw.get("stream_chunk_min_interval_ms", 160) or 160)),
        drop_log_interval_ms=max(0, int(lipsync_bridge_raw.get("drop_log_interval_ms", 2000) or 2000)),
    )


@dataclass(frozen=True)
class TTSBridgeConfig:
    service_name: str
    base_url: str
    host: str
    port: int
    vendor_port: int
    startup_timeout_ms: int
    request_timeout_ms: int
    output_dir: Path
    playback_enabled: bool
    vendor: VendorConfig
    preset: DefaultPreset
    streaming: StreamingConfig
    subtitle_sync: SubtitleSyncConfig = SubtitleSyncConfig()
    lipsync_bridge: LipsyncBridgeConfig = LipsyncBridgeConfig()

    @classmethod
    def load(cls, path: str | Path) -> "TTSBridgeConfig":
        config_path = Path(path)
        if not config_path.exists():
            raise TTSBridgeConfigError(f"config file not found: {config_path}")
        repo_root = config_path.resolve().parents[3]
        raw = tomllib.loads(config_path.read_text(encoding="utf-8-sig"))

        service_name = str(raw.get("service_name", "tts_bridge")).strip() or "tts_bridge"
        base_url = str(raw.get("base_url", "http://127.0.0.1:8102")).strip().rstrip("/")
        host = str(raw.get("host", "127.0.0.1")).strip() or "127.0.0.1"
        port = int(raw.get("port", 8102))
        vendor_port = int(raw.get("vendor_port", 9880))
        startup_timeout_ms = int(raw.get("startup_timeout_ms", 30000))
        request_timeout_ms = int(raw.get("request_timeout_ms", 3000))
        output_dir = _resolve_path(repo_root, Path(str(raw.get("output_dir", "services/tts_bridge/output"))))
        playback_enabled = bool(raw.get("playback_enabled", False))

        return cls(
            service_name=service_name,
            base_url=base_url,
            host=host,
            port=port,
            vendor_port=vendor_port,
            startup_timeout_ms=startup_timeout_ms,
            request_timeout_ms=request_timeout_ms,
            output_dir=output_dir,
            playback_enabled=playback_enabled,
            vendor=_parse_vendor_config(repo_root, raw.get("vendor", {})),
            preset=_parse_preset_config(repo_root, raw.get("preset", {})),
            streaming=_parse_streaming_config(raw.get("streaming", {})),
            subtitle_sync=_parse_subtitle_sync_config(raw.get("subtitle_sync", {})),
            lipsync_bridge=_parse_lipsync_bridge_config(raw.get("lipsync_bridge", {})),
        )
