from __future__ import annotations

import base64
import threading

from lipsync_bridge_client import LipsyncBridgeClient, LipsyncBridgeClientConfig
from models import AudioAsset


class FakeHttpClient:
    def __init__(self) -> None:
        self.posts: list[tuple[str, dict, float | None]] = []

    def post(self, path: str, *, json: dict, timeout: float | None = None):
        self.posts.append((path, json, timeout))
        return FakeResponse()

    def close(self) -> None:
        pass


class FakeResponse:
    status_code = 202
    text = ""


class BlockingHttpClient:
    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()
        self.posts: list[tuple[str, dict, float | None]] = []

    def post(self, path: str, *, json: dict, timeout: float | None = None):
        self.entered.set()
        self.release.wait(timeout=1.0)
        self.posts.append((path, json, timeout))
        return FakeResponse()

    def close(self) -> None:
        self.release.set()


def test_mirrors_streaming_pcm_buffer_when_ready() -> None:
    http = FakeHttpClient()
    client = LipsyncBridgeClient(
        LipsyncBridgeClientConfig(enabled=True, inline_pcm_max_bytes=1024),
        client=http,  # type: ignore[arg-type]
    )
    ready = threading.Event()
    buffer = bytearray(b"\x01\x02\x03\x04")
    asset = AudioAsset(
        kind="pcm",
        artifact_path=None,
        sample_rate=32000,
        duration_ms=10,
        media_type="raw",
        pcm_stream=iter(()),
        metrics={
            "pcm_buffer": buffer,
            "pcm_buffer_done": ready,
        },
    )

    client.mirror_asset_async(
        trace_id="trace-1",
        generation_id=1,
        segment_index=1,
        task_id="task-1",
        text="hello",
        asset=asset,
    )
    ready.set()

    assert wait_for(lambda: len(http.posts) == 1)
    path, payload, _ = http.posts[0]
    assert path == "/v1/lipsync/mirror"
    assert payload["trace_id"] == "trace-1"
    assert payload["pcm_base64"] == base64.b64encode(bytes(buffer)).decode("ascii")
    client.close()


def test_stream_chunk_posts_low_latency_events() -> None:
    http = FakeHttpClient()
    client = LipsyncBridgeClient(
        LipsyncBridgeClientConfig(enabled=True, inline_pcm_max_bytes=1024),
        client=http,  # type: ignore[arg-type]
    )

    client.stream_start_async(
        trace_id="trace-1",
        generation_id=2,
        segment_index=1,
        task_id="task-1",
        text="hello",
        sample_rate=48000,
        duration_ms=100,
    )
    client.stream_chunk_async(task_id="task-1", chunk=b"\x01\x00")
    client.stream_finish_async(task_id="task-1")

    assert wait_for(lambda: len(http.posts) == 3)
    assert [post[0] for post in http.posts] == [
        "/v1/lipsync/stream/start",
        "/v1/lipsync/stream/chunk",
        "/v1/lipsync/stream/finish",
    ]
    assert http.posts[1][1]["pcm_base64"] == base64.b64encode(b"\x01\x00").decode("ascii")
    client.close()


def test_stream_chunks_are_rate_limited_per_task() -> None:
    http = FakeHttpClient()
    client = LipsyncBridgeClient(
        LipsyncBridgeClientConfig(
            enabled=True,
            inline_pcm_max_bytes=1024,
            stream_chunk_min_interval_ms=10_000,
        ),
        client=http,  # type: ignore[arg-type]
    )

    client.stream_chunk_async(task_id="task-1", chunk=b"\x01\x00")
    client.stream_chunk_async(task_id="task-1", chunk=b"\x02\x00")

    assert wait_for(lambda: len(http.posts) == 1)
    assert http.posts[0][1]["pcm_base64"] == base64.b64encode(b"\x01\x00").decode("ascii")
    client.close()


def test_drops_lipsync_requests_when_pending_queue_is_full() -> None:
    http = BlockingHttpClient()
    client = LipsyncBridgeClient(
        LipsyncBridgeClientConfig(enabled=True, max_workers=1, max_pending_requests=1),
        client=http,  # type: ignore[arg-type]
    )

    client.stream_finish_async(task_id="first")
    assert http.entered.wait(timeout=1.0)
    client.stream_finish_async(task_id="second")

    http.release.set()
    assert wait_for(lambda: len(http.posts) == 1)
    assert http.posts[0][1]["task_id"] == "first"
    client.close()


def wait_for(predicate, *, timeout_s: float = 1.0) -> bool:
    import time

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False
