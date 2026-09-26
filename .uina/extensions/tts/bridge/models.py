from __future__ import annotations

import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal


TaskState = Literal["pending", "in_progress", "completed", "cancelled", "failed", "obsolete"]
StreamStrategy = Literal["adaptive", "fixed_streaming", "fixed_batch"]
SegmentState = Literal["pending", "synthesizing", "ready", "playing", "completed", "cancelled", "obsolete", "failed"]


@dataclass(frozen=True)
class VendorConfig:
    api_style: str
    python_executable: str
    entry_script: Path
    tts_config_path: Path | None = None
    gpt_model_path: Path | None = None
    sovits_model_path: Path | None = None
    device: str = "cpu"


@dataclass(frozen=True)
class DefaultPreset:
    ref_audio_path: Path | None
    prompt_text: str
    prompt_lang: str
    text_lang: str
    text_split_method: str
    speed_factor: float
    media_type: str


@dataclass(frozen=True)
class StreamingConfig:
    enabled: bool = True
    stream_strategy: StreamStrategy = "adaptive"
    media_type: str = "raw"
    sample_rate: int = 32000
    vendor_streaming_mode: int = 2
    min_chunk_length: int = 32
    fragment_interval: float = 0.08
    first_chunk_vendor_streaming_mode: int | None = None
    first_chunk_min_chunk_length: int = 24
    first_chunk_fragment_interval: float = 0.05
    first_chunk_prebuffer_ms: int = 100
    first_chunk_gate_timeout_ms: int = 1800
    warmup_enabled: bool = True
    warmup_text: str = "嗯。"
    warmup_timeout_ms: int = 25000
    batch_size: int = 1
    prebuffer_ms: int = 120
    rebuffer_ms: int = 420
    drain_timeout_ms: int = 2000
    stream_idle_timeout_ms: int = 60000
    stream_total_timeout_ms: int = 120000
    synthesis_lock_timeout_ms: int = 60000
    max_delivery_task_ms: int = 60000

    fallback_to_batch_on_failure: bool = True
    adaptive_playback_start_latency_ms: int = 1600
    adaptive_rebuffer_threshold: int = 2
    adaptive_max_chunk_gap_ms: float = 400.0
    adaptive_realtime_factor_threshold: float = 0.85
    adaptive_batch_recovery_successes: int = 2
    device: str | None = None
    mirror_device: str | None = None


@dataclass(frozen=True)
class StreamingProfile:
    label: str
    vendor_streaming_mode: int
    min_chunk_length: int
    fragment_interval: float
    prebuffer_ms: int
    rebuffer_ms: int


@dataclass(frozen=True)
class SubtitleSyncConfig:
    enabled: bool = False
    obs_base_url: str = "http://127.0.0.1:8104"
    progress_interval_ms: int = 16
    fallback_mode: str = "sentence_only"


@dataclass(frozen=True)
class LipsyncBridgeConfig:
    enabled: bool = False
    streaming_enabled: bool = False
    base_url: str = "http://127.0.0.1:8105"
    request_timeout_ms: int = 250
    inline_pcm_max_bytes: int = 4 * 1024 * 1024
    max_workers: int = 1
    max_pending_requests: int = 16
    stream_chunk_min_interval_ms: int = 20
    drop_log_interval_ms: int = 2000


@dataclass(frozen=True)
class PlaybackProgressSnapshot:
    playback_started: bool
    played_ms: float
    played_samples: int
    buffered_ms: float
    segment_finished: bool
    duration_ms: int
    # 声学电平测量（0.0~1.0）。带默认值以免影响既有构造点。
    # 只承载"最近一段音频测到多少"，不做包络平滑——平滑是消费者的职责。
    rms: float = 0.0
    peak: float = 0.0


@dataclass(frozen=True)
class SubtitleProgressEvent:
    trace_id: str
    generation_id: int
    segment_index: int
    task_id: str
    action: Literal["segment_start", "segment_progress", "segment_complete", "sentence", "turn_end", "clear"]
    text: str
    revealed_text: str = ""
    revealed_count: int = 0
    playback_started: bool = False
    playback_completed: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class AdaptiveTraceState:
    force_batch: bool = False
    consecutive_batch_successes: int = 0
    conservative_stream_successes: int = 0


@dataclass(frozen=True)
class DiagnosticCandidate:
    label: str
    vendor_streaming_mode: int
    min_chunk_length: int
    fragment_interval: float


@dataclass(frozen=True)
class DiagnosticResult:
    label: str
    metrics: dict[str, Any]


@dataclass(frozen=True)
class SegmentKey:
    trace_id: str
    generation_id: int
    segment_index: int


@dataclass(frozen=True)
class AudioAsset:
    kind: Literal["file", "pcm"]
    artifact_path: Path | None
    sample_rate: int
    duration_ms: int
    media_type: str
    pcm_bytes: bytes | None = None
    pcm_stream: Any | None = None
    metrics: dict[str, Any] = field(default_factory=dict)


@dataclass
class SegmentRecord:
    key: SegmentKey
    task_id: str
    text: str
    state: SegmentState = "pending"
    asset: AudioAsset | None = None
    detail: dict[str, Any] = field(default_factory=dict)
    cancel_requested: bool = False


@dataclass
class GenerationSession:
    trace_id: str
    generation_id: int
    next_play_index: int = 1
    next_issue_index: int = 1
    expected_end_index: int | None = None
    closed: bool = False
    segments: dict[int, SegmentRecord] = field(default_factory=dict)
    condition: threading.Condition | None = field(default=None, repr=False, compare=False)


@dataclass
class BridgeTask:
    task_id: str
    trace_id: str
    state: TaskState
    cancel_token: str
    cancel_requested: bool = False
    stream_cancel_event: Any | None = field(default=None, repr=False, compare=False)

    started_at: float | None = None
    completed_at: float | None = None
    audio_id: str | None = None
    artifact_path: str | None = None
    error: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)
    subtitle_state: dict[str, Any] = field(default_factory=dict)
