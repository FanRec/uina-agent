"""synthesis_handlers.py — 请求模型与 vendor 文本处理（无服务实例依赖）。

承载 TTS Bridge 的 HTTP 请求模型、vendor 文本清洗与延迟日志。
调度、队列、播放状态一律不在这里；它们属于 DeliveryLane/AudioSink/PlaybackFeed。
"""
from __future__ import annotations

import json
import time
import unicodedata
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class GenerateRequest(BaseModel):
    model_config = {"extra": "forbid"}
    text: str = Field(min_length=1, pattern=r"\S")
    timeout_ms: int = Field(default=120000, gt=0, le=2147483647, strict=True)


def _latency_ms_since(started_at: float | None) -> float | None:
    if started_at is None:
        return None
    return round((time.perf_counter() - started_at) * 1000, 2)


def _log_latency(trace_id: str, task_id: str, stage: str, started_at: float | None = None, **detail: Any) -> None:
    payload = {
        "trace_id": trace_id,
        "task_id": task_id,
        "stage": stage,
        "elapsed_ms": _latency_ms_since(started_at),
        **detail,
    }
    print(f"[TTS][latency] {json.dumps(payload, ensure_ascii=False)}", flush=True)


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


def align_original_to_vendor(original: str, vendor: str) -> list[int]:
    """原文 → vendor 文本的字符映射（vendor 文本是原文清洗后的子序列）。

    返回长度为 len(vendor) 的列表：第 i 个 vendor 字符在原文中的索引。
    清洗只会删除字符、折叠空白，不会重排，因此双指针即可对齐；
    对不上的尾部字符统一映射到最后一个匹配位置，保证前缀揭示单调。
    """
    mapping: list[int] = []
    j = 0
    for i, ch in enumerate(vendor):
        while j < len(original) and original[j] != ch:
            j += 1
        if j >= len(original):
            mapping.append(mapping[-1] if mapping else 0)
        else:
            mapping.append(j)
            j += 1
    return mapping


class SpeakRequest(BaseModel):
    trace_id: str
    segment_id: str
    index: int
    text: str
    kind: str = "sentence"
    timeout_ms: int = 3000
    generation_id: Optional[int] = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    session_id: Optional[str] = None
    invocation_id: Optional[str] = None
    source_id: Optional[str] = None
    source_seq: Optional[int] = None
    epoch: Optional[str] = None


class CancelRequest(BaseModel):
    task_id: str
    trace_id: str


class CancelTraceRequest(BaseModel):
    trace_id: str
    session_id: Optional[str] = None
    expected_epoch: Optional[str] = None
    generation_id: Optional[int] = None
    mode: Literal["immediate", "segment_boundary"] = "immediate"


class TurnEndRequest(BaseModel):
    trace_id: str
    session_id: Optional[str] = None
    epoch: Optional[str] = None
    generation_id: Optional[int] = None
    last_segment_index: Optional[int] = None


class ReconnectRequest(BaseModel):
    session_id: str


class ResetRequest(BaseModel):
    session_id: str
    expected_epoch: Optional[str] = None
    new_epoch: Optional[str] = None
    invocation_id: Optional[str] = None


class TestRequest(BaseModel):
    expected_epoch: Optional[str] = None
    trace_id: Optional[str] = None
    scope: Literal["synthesis", "playback"] = "synthesis"
    session_id: Optional[str] = None
    timeout_ms: int = 120000


class RestartRequest(BaseModel):
    target: Literal["vendor"]


class BatchTaskStatusRequest(BaseModel):
    task_ids: list[str] = Field(min_length=1, max_length=200)
