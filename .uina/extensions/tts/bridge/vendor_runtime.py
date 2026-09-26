from __future__ import annotations

import os
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Iterator

import httpx


class VendorRuntime:
    def __init__(self, config, *, client: httpx.Client | None = None, config_error: type[Exception] = RuntimeError) -> None:
        self.config = config
        self._config_error = config_error
        self.process: subprocess.Popen[str] | None = None
        self.client = client or httpx.Client(base_url=f"http://127.0.0.1:{config.vendor_port}", trust_env=False)
        self._vendor_log_path: Path | None = None

    @property
    def vendor_base_url(self) -> str:
        return f"http://127.0.0.1:{self.config.vendor_port}"

    def ensure_running(self) -> bool:
        """确保 vendor 进程在运行；返回 True 表示本次启动了新进程。"""
        if self.ready():
            return False
        if self.process is not None and self.process.poll() is None:
            return False
        self._cleanup_process()
        self._wait_for_port_free()
        entry_script = self.config.vendor.entry_script.resolve()
        cmd = [self.config.vendor.python_executable, str(entry_script), "-a", "127.0.0.1", "-p", str(self.config.vendor_port)]
        if self.config.vendor.api_style == "legacy":
            if self.config.vendor.gpt_model_path is None or self.config.vendor.sovits_model_path is None:
                raise self._config_error("legacy vendor requires gpt_model_path and sovits_model_path")
            if self.config.preset.ref_audio_path is None:
                raise self._config_error("legacy vendor requires preset.ref_audio_path")
            cmd.extend(
                [
                    "-d",
                    self.config.vendor.device,
                    "-g",
                    str(self.config.vendor.gpt_model_path.resolve()),
                    "-s",
                    str(self.config.vendor.sovits_model_path.resolve()),
                    "-dr",
                    str(self.config.preset.ref_audio_path.resolve()),
                    "-dt",
                    self.config.preset.prompt_text,
                    "-dl",
                    self.config.preset.prompt_lang,
                ]
            )
        else:
            if self.config.vendor.tts_config_path is None:
                raise self._config_error("api_v2 vendor requires tts_config_path")
            cmd.extend(["-c", str(self.config.vendor.tts_config_path.resolve())])
        log_dir = self.config.output_dir.resolve().parent / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        self._vendor_log_path = log_dir / "vendor_stderr.log"
        vendor_log_file = self._vendor_log_path.open("a", encoding="utf-8")
        try:
            print(f"[TTS] starting vendor: {' '.join(cmd[:3])}...", flush=True)
            # PYTHONUTF8: vendor stdout 在 Windows 下默认 GBK，韩文等非 GBK
            # 字符打印（TTS.py 的 norm_text 日志）会抛 UnicodeEncodeError，
            # 导致 /tts 返回 400。强制 UTF-8 输出，多语言文本才能合成。
            env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
            self.process = subprocess.Popen(
                cmd,
                cwd=str(entry_script.parent),
                # GPT-SoVITS uses tqdm on stdout. Windows' DEVNULL handle can
                # reject flush(), which makes an otherwise valid /tts request fail.
                stdout=vendor_log_file,
                stderr=vendor_log_file,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                text=True,
                env=env,
            )
            return True
        finally:
            vendor_log_file.close()

    def _cleanup_process(self) -> None:
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        self.process = None

    def _wait_for_port_free(self, timeout: float = 10.0) -> None:
        deadline = time.perf_counter() + timeout
        while time.perf_counter() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.config.vendor_port), timeout=0.3):
                    time.sleep(0.5)
            except (ConnectionRefusedError, OSError):
                return
        print(f"[TTS] warning: port {self.config.vendor_port} still in use after {timeout}s", flush=True)

    def ready(self) -> bool:
        try:
            response = self.client.get("/docs", timeout=0.5)
        except httpx.HTTPError:
            return False
        return response.status_code == 200

    def wait_until_ready(self, timeout_ms: int) -> bool:
        deadline = time.perf_counter() + (timeout_ms / 1000)
        while time.perf_counter() < deadline:
            if self.ready():
                return True
            if self.process is not None and self.process.poll() is not None:
                return False
            time.sleep(0.2)
        return self.ready()

    def synthesize(self, payload: dict[str, Any], *, timeout_ms: int) -> httpx.Response:
        endpoint = "/" if self.config.vendor.api_style == "legacy" else "/tts"
        return self.client.post(
            endpoint,
            json=payload,
            timeout=max(timeout_ms / 1000, 0.1),
        )

    def synthesize_stream(
        self,
        payload: dict[str, Any],
        *,
        timeout_ms: int,
        idle_timeout_ms: int | None = None,
        total_timeout_ms: int | None = None,
        cancel_event: threading.Event | None = None,
    ) -> Iterator[bytes]:
        endpoint = "/" if self.config.vendor.api_style == "legacy" else "/tts"
        read_timeout = max((idle_timeout_ms or timeout_ms) / 1000, 0.1)
        if cancel_event is not None and cancel_event.is_set():
            return

        timeout = httpx.Timeout(
            connect=read_timeout,
            read=read_timeout,
            write=read_timeout,
            pool=read_timeout,
        )
        total_deadline = None
        if total_timeout_ms:
            total_deadline = time.perf_counter() + max(total_timeout_ms / 1000, 0.1)
        with self.client.stream("POST", endpoint, json=payload, timeout=timeout) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes(chunk_size=4096):
                if cancel_event is not None and cancel_event.is_set():
                    break
                if total_deadline is not None and time.perf_counter() > total_deadline:
                    raise httpx.TimeoutException(
                        f"tts vendor stream exceeded total timeout of {total_timeout_ms}ms"
                    )
                if chunk:
                    yield chunk

    def close(self) -> None:
        self.client.close()
        self._cleanup_process()
