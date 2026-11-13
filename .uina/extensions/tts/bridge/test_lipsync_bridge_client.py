from __future__ import annotations

import base64
import threading

from lipsync_bridge_client import LipsyncBridgeClient, LipsyncBridgeClientConfig


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




class UnsupportedStreamingHttp(FakeHttpClient):
    def post(self, path: str, *, json: dict, timeout: float | None = None):
        self.posts.append((path, json, timeout))
        response = FakeResponse()
        response.status_code = 404 if path.startswith("/v1/lipsync/stream/") else 202
        return response


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


def test_stream_chunks_are_bounded_and_numbered_before_finish() -> None:
    http = FakeHttpClient()
    client = LipsyncBridgeClient(
        LipsyncBridgeClientConfig(
            enabled=True,
            inline_pcm_max_bytes=4,
            stream_chunk_min_interval_ms=10_000,
        ),
        client=http,  # type: ignore[arg-type]
    )

    client.stream_start_async(
        trace_id="trace-1",
        generation_id=1,
        segment_index=1,
        task_id="task-1",
        text="hello",
        sample_rate=16_000,
        duration_ms=10,
    )
    client.stream_chunk_async(task_id="task-1", chunk=b"1234")
    client.stream_chunk_async(task_id="task-1", chunk=b"5678")
    client.stream_finish_async(task_id="task-1")

    assert wait_for(lambda: len(http.posts) == 4)
    assert [post[0] for post in http.posts] == [
        "/v1/lipsync/stream/start",
        "/v1/lipsync/stream/chunk",
        "/v1/lipsync/stream/chunk",
        "/v1/lipsync/stream/finish",
    ]
    assert http.posts[1][1]["chunk_index"] == 0
    assert http.posts[2][1]["chunk_index"] == 1
    assert len(base64.b64decode(http.posts[2][1]["pcm_base64"])) <= 4
    assert http.posts[3][1]["last_chunk_index"] == 1
    client.close()


def test_streaming_bridge_unsupported_falls_back_to_whole_segment_mirror() -> None:
    http = UnsupportedStreamingHttp()
    client = LipsyncBridgeClient(
        LipsyncBridgeClientConfig(enabled=True, inline_pcm_max_bytes=1024),
        client=http,  # type: ignore[arg-type]
    )
    client.stream_start_async(
        trace_id="trace-fallback", generation_id=1, segment_index=1, task_id="task-fallback",
        text="hello", sample_rate=16_000, duration_ms=20,
    )
    client.stream_chunk_async(task_id="task-fallback", chunk=b"\x01\x00\x02\x00")
    client.stream_finish_async(task_id="task-fallback")

    assert wait_for(lambda: any(path == "/v1/lipsync/mirror" for path, _, _ in http.posts))
    assert [path for path, _, _ in http.posts] == [
        "/v1/lipsync/stream/start", "/v1/lipsync/mirror"
    ]
    mirror = http.posts[-1][1]
    assert mirror["task_id"] == "task-fallback"
    assert mirror["pcm_base64"] == base64.b64encode(b"\x01\x00\x02\x00").decode("ascii")
    client.close()
