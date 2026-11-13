from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal


# Source 输入侧：open=继续受理；sealed=不再受理；cancelled=已取消。
SourceInput = Literal["open", "sealed", "cancelled"]
# 合成维度：queued=待合成；running=Vendor 推理中；终局 finished/failed/cancelled。
SynthesisState = Literal["queued", "running", "finished", "failed", "cancelled"]
# 播放维度：pending=尚无音频可播；playing/completed 由 AudioSink 真实推进；
# cancelled/failed 为终局；unknown 仅表示物理停止无法确认。
PlaybackState = Literal["pending", "playing", "completed", "cancelled", "failed", "unknown"]

PLAYBACK_TERMINAL: frozenset[str] = frozenset({"completed", "cancelled", "failed", "unknown"})
SYNTHESIS_TERMINAL: frozenset[str] = frozenset({"finished", "failed", "cancelled"})


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
    """流式交付参数。所有时长都是可测参数，不是正确性公理。"""

    enabled: bool = True
    media_type: str = "raw"
    sample_rate: int = 32000
    vendor_streaming_mode: int = 2
    min_chunk_length: int = 32
    fragment_interval: float = 0.08
    # 首句快速 profile（首句延迟优先；是否启用由听感实测决定）。
    first_chunk_vendor_streaming_mode: int | None = None
    first_chunk_min_chunk_length: int = 16
    first_chunk_fragment_interval: float = 0.03
    warmup_enabled: bool = True
    warmup_text: str = "嗯。"
    warmup_timeout_ms: int = 25000
    batch_size: int = 1
    # 设备冷启动（打开声卡）时的预热静音与预缓冲；只在真实打开设备时生效一次。
    device_priming_ms: int = 120
    start_prebuffer_ms: int = 300
    # 有界背压：未播放 PCM 上限（秒）。超过后合成生产者等待消费，不是失败。
    buffer_seconds: float = 2.0
    # 播放完全空闲后多久关闭声卡（由普通控制线程执行，非回调）。
    idle_close_ms: int = 3000
    # Vendor 流式请求的读空闲与总时限；只约束真正开始的 I/O。
    stream_idle_timeout_ms: int = 60000
    stream_total_timeout_ms: int = 120000
    # Vendor 流无消费进展的停滞上限（设备完全卡死时收束，正常背压不受此约束）。
    stall_timeout_ms: int = 60000
    # 合成失败且尚无任何 PCM 进入输出路径时，允许的一次非流式回退。
    fallback_to_batch_on_failure: bool = True
    # 受理边界容量（超限在受理前明确拒绝，不受理后按年龄清除）。
    max_source_pending_segments: int = 48
    max_source_pending_chars: int = 4000
    max_total_pending_segments: int = 64
    device: str | None = None
    mirror_device: str | None = None


@dataclass(frozen=True)
class StreamingProfile:
    label: str
    vendor_streaming_mode: int
    min_chunk_length: int
    fragment_interval: float


@dataclass(frozen=True)
class SubtitleSyncConfig:
    """字幕刷新节拍与演示配置；OBS 消费播放快照 SSE，本配置只控制刷新频率。"""

    enabled: bool = False
    obs_base_url: str = "http://127.0.0.1:8104"
    progress_interval_ms: int = 33


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
    """AudioSink 播放位置的只读快照。

    clock_quality: dac=以 PortAudio DAC 估计的可听位置；submitted_samples=已提交
    帧数估计；unknown=无时钟。位置只统计有效语音样本，补静音不推进。
    """

    playback_started: bool
    played_ms: float
    played_frames: int
    buffered_ms: float
    segment_finished: bool
    duration_ms: int
    rms: float = 0.0
    peak: float = 0.0
    state: str = "idle"
    clock_quality: str = "unknown"
    playback_id: str | None = None


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


@dataclass
class Segment:
    """一个句段的交付事实。合成与播放是两个独立推进的维度。"""

    index: int
    task_id: str
    text: str  # 发送给 vendor 的规范化文本
    original_text: str  # 上游原文（字幕/回执对照）
    cancel_token: str
    traceparent: str | None = None
    synthesis: SynthesisState = "queued"
    playback: PlaybackState = "pending"
    # 在 AudioSink 连续时间线上的有效语音帧区间；end_frame 在合成结束时才最终确定。
    pcm_start_frame: int | None = None
    pcm_end_frame: int = 0
    pcm_final: bool = False
    error: str | None = None
    stop_outcome: str | None = None
    accepted_at: float | None = None
    synth_started_at: float | None = None
    first_pcm_at: float | None = None
    synth_end_at: float | None = None
    playback_started_at: float | None = None
    terminal_at: float | None = None

    @property
    def terminal(self) -> bool:
        return self.playback in PLAYBACK_TERMINAL

    def timings(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "accepted_at": self.accepted_at,
            "synth_started_at": self.synth_started_at,
            "first_pcm_at": self.first_pcm_at,
            "synth_end_at": self.synth_end_at,
            "playback_started_at": self.playback_started_at,
            "terminal_at": self.terminal_at,
            "pcm_start_frame": self.pcm_start_frame,
            "pcm_end_frame": self.pcm_end_frame if self.pcm_final else None,
        }
        return data


@dataclass
class Source:
    """一个发声来源（= Driver 的 trace）。按首次受理顺序进入全局 FIFO。"""

    id: str
    session_id: str
    epoch: str
    generation_id: int = 1
    input: SourceInput = "open"
    last_accepted_index: int = 0
    segments: dict[int, Segment] = field(default_factory=dict)
    accepted_at: float | None = None
    sealed_at: float | None = None
    terminal_reason: str | None = None

    def all_terminal(self) -> bool:
        return all(segment.terminal for segment in self.segments.values())

    def pending_count(self) -> int:
        return sum(1 for segment in self.segments.values() if not segment.terminal)


class BridgeError(Exception):
    """对外 HTTP 语义的业务错误。"""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
