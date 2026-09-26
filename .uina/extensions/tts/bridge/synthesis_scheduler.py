from __future__ import annotations


class SynthesisScheduler:
    def __init__(self, *, window_size: int = 2) -> None:
        self.window_size = max(int(window_size), 1)

    def prefer_batch_prefetch(
        self,
        *,
        playback_enabled: bool,
        player_is_playing: bool,
        trace_force_batch: bool = False,
    ) -> bool:
        return bool(playback_enabled and player_is_playing and trace_force_batch)

    def should_stream(
        self,
        *,
        streaming_enabled: bool,
        stream_strategy: str,
        use_batch_only: bool,
        prefer_batch_prefetch: bool,
        playback_enabled: bool,
        player_supports_streaming: bool,
    ) -> bool:
        return bool(
            streaming_enabled
            and stream_strategy != "fixed_batch"
            and not use_batch_only
            and not prefer_batch_prefetch
            and playback_enabled
            and player_supports_streaming
        )
