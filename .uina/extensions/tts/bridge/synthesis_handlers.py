"""synthesis_handlers.py — 合成相关的自包含模块级组件。

本模块承载 TTS 合成路径中不依赖 TTSBridgeService 实例状态的纯组件：
vendor 文本清洗、流式 PCM 队列、延迟/时长估算、请求模型，以及合成相关常量。
``TTSBridgeService`` 类（含全部方法内逻辑）保留在 service.py；
这里只搬模块级、无 ``self`` 依赖的定义，语义与原文件逐条等价。
"""
from __future__ import annotations

import json
import threading
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from queue import Empty, Full, Queue
from typing import Any, Literal, Optional
from uuid import uuid4

import httpx
from pydantic import BaseModel, Field

from models import BridgeTask, StreamingProfile


class StreamingSynthesisError(RuntimeError):
    def __init__(self, detail: str, *, status_code: int, fallback_allowed: bool) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code
        self.fallback_allowed = fallback_allowed


_STREAM_END = object()

# 流式音频队列无消费空间的停滞阈值。正常背压（播放端短暂慢）在几秒内恢复；
# 超过该阈值说明播放端已停滞（设备故障等），producer 必须显式失败并释放
# 合成锁，而不是永久自旋冻结 vendor 推理。失败会明确上报，不静默丢句。
STREAM_PUT_STALL_TIMEOUT_S = 30.0
SHORT_SEGMENT_FAST_START_CHAR_LIMIT = 10


class _PCMChunkStream:
    def __init__(self, *, max_chunks: int = 64, on_chunk=None) -> None:
        self._queue: Queue[bytes | object] = Queue(maxsize=max(max_chunks, 1))
        self._closed = False
        self._on_chunk = on_chunk

    def put(self, chunk: bytes, *, timeout: float | None = None) -> bool:
        """入队一个音频 chunk。

        队列满时阻塞等待消费端腾出空间（背压 = 合法等待，不丢弃）。
        ``timeout`` 秒后仍无空间则返回 False，由调用方决定失败上报。
        """
        deadline = None if timeout is None else time.perf_counter() + timeout
        while not self._closed:
            try:
                self._queue.put(chunk, timeout=0.05)
                if self._on_chunk is not None:
                    try:
                        self._on_chunk(chunk)
                    except Exception:
                        pass
                return True
            except Full:
                if deadline is not None and time.perf_counter() >= deadline:
                    return False
                continue
        return False

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            while True:
                try:
                    self._queue.put(_STREAM_END, timeout=0.05)
                    return
                except Full:
                    try:
                        self._queue.get_nowait()
                    except Empty:
                        continue

    def __iter__(self):
        while True:
            item = self._queue.get()
            if item is _STREAM_END:
                break
            yield item


@dataclass(frozen=True)
class _AdmittedSpeakTask:
    task_id: str
    ref_audio_path: Path
    timeout_ms: int
    profile: StreamingProfile
    use_batch_only: bool
    admitted_at: float


def _latency_ms_since(started_at: float | None) -> float | None:
    if started_at is None:
        return None
    return round((time.perf_counter() - started_at) * 1000, 2)


def _log_latency(task: BridgeTask, stage: str, **detail: Any) -> None:
    started_at = task.detail.get("latency_trace_started_at")
    elapsed_ms = _latency_ms_since(started_at if isinstance(started_at, float) else None)
    payload = {
        "trace_id": task.trace_id,
        "task_id": task.task_id,
        "generation_id": task.detail.get("generation_id"),
        "segment_index": task.detail.get("segment_index"),
        "stage": stage,
        "elapsed_ms": elapsed_ms,
        "traceparent": task.detail.get("traceparent"),
        **detail,
    }
    print(f"[TTS][latency] {json.dumps(payload, ensure_ascii=False)}", flush=True)


def _estimate_stream_duration_ms_static(text: str, *, speed_factor: float) -> int:
    """静态估算回退：仅用于无法访问实例的场景。"""
    compact = "".join(ch for ch in text if not ch.isspace())
    if not compact:
        return 1000
    adjusted_speed = max(speed_factor, 0.2)
    return max(int(len(compact) * 300 / adjusted_speed), 400)


def _sanitize_vendor_text(text: str) -> str:
    text = text.strip()
    for tag in ("[Speech]", "[Speak]", "[说话]", "[发言]"):
        if text.lower().startswith(tag.lower()):
            text = text[len(tag):].lstrip()
    replacements = {
        "\u200b": "",
        "\u200c": "",
        "\u200d": "",
        "\ufeff": "",
        "\u2728": "",
        "\ufe0f": "",
        "\n": " ",
        "\r": " ",
        "`": "",
        "*": "",
        "_": "",
    }
    sanitized = "".join(replacements.get(ch, ch) for ch in text)
    sanitized = "".join(ch if _is_vendor_text_char_supported(ch) else "" for ch in sanitized)
    sanitized = " ".join(sanitized.split())
    return sanitized.strip()


def _is_vendor_text_char_supported(ch: str) -> bool:
    if ch in "\t\n\r":
        return True
    if ch.isspace():
        return True
    category_ord = ord(ch)
    if category_ord < 32:
        return False
    category = unicodedata.category(ch)
    # emoji/符号类一律过滤：vendor cleaner 无法处理，且可能触发 filter_text 异常
    if category.startswith("S"):
        return False
    if category.startswith("L"):
        # 只放行 vendor cleaner 支持的语言（zh/ja/en/ko/yue）
        if 0x0041 <= category_ord <= 0x005A or 0x0061 <= category_ord <= 0x007A:
            return True  # 英文（ASCII）
        if 0x00C0 <= category_ord <= 0x024F:
            return True  # 拉丁扩展（重音字母 é/ñ/ü 等）
        if 0x3040 <= category_ord <= 0x30FF:
            return True  # 平假名/片假名（日文）
        if 0x3130 <= category_ord <= 0x318F or 0xAC00 <= category_ord <= 0xD7AF:
            return True  # 谚文（韩文）
        if 0x4E00 <= category_ord <= 0x9FFF:
            return True  # CJK 统一表意文字（中/日汉字/韩汉字）
        if 0xFF21 <= category_ord <= 0xFF3A or 0xFF41 <= category_ord <= 0xFF5A:
            return True  # 全角拉丁（日文文本常见）
        return False  # 其他书写系统（阿拉伯/西里尔/泰文等）vendor 不支持
    if category.startswith("N"):
        return 0x0030 <= category_ord <= 0x0039 or 0xFF10 <= category_ord <= 0xFF19
    # 标点与括号（中英文标点、引号、破折号）
    return category in ("Po", "Pc", "Pd", "Ps", "Pe", "Pi", "Pf")


def _vendor_text_lang_for(text: str) -> str:
    """决定发送给 vendor 的 text_lang。

    LangSegment 对"纯 CJK 汉字、无假名"的文本无法区分 zh/ja（实测
    '刚启动完，'、'还没。' 会被误判为 ja，导致中文读成日语）。vendor
    的指定语言模式（getTexts(text, lang)）会以用户输入为准修正判定，
    且 en 段仍自动保留英文，所以：
    - 含假名（平假名/片假名）或谚文 → auto：这些字符是强语言特征，
      LangSegment 无参判定可靠（ja/ko 实测 100% 正确），且混合句
      （如 中英日三语）需要按段自动识别；
    - 其余（中文为主、可含英文/数字）→ zh：让 vendor 以中文为准，
      杜绝 zh/ja 误判，英文段仍按英文 cleaner 处理。
    """
    for ch in text:
        cp = ord(ch)
        if 0x3040 <= cp <= 0x30FF or 0xAC00 <= cp <= 0xD7AF:
            return "auto"
    return "zh"


class SpeakRequest(BaseModel):
    trace_id: str
    segment_id: str
    index: int
    text: str
    kind: str = "sentence"
    timeout_ms: int = 3000
    generation_id: Optional[int] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class CancelRequest(BaseModel):
    task_id: str
    trace_id: str


class CancelTraceRequest(BaseModel):
    trace_id: str
    mode: Literal["immediate", "segment_boundary"] = "immediate"


class TurnEndRequest(BaseModel):
    trace_id: str
    generation_id: Optional[int] = None
    last_segment_index: Optional[int] = None


class BatchTaskStatusRequest(BaseModel):
    task_ids: list[str] = Field(min_length=1, max_length=200)
