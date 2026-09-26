export interface SongInfo {
  readonly id: string;
  readonly name: string;
  readonly artists: readonly string[];
  readonly durationMs: number | null;
  readonly album?: string;
}

export type PlaybackStatus = "idle" | "playing" | "paused";

export interface JukeboxState {
  readonly status: PlaybackStatus;
  readonly currentSong: SongInfo | null;
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly volume: number;
}

export interface JukeboxAppConfig {
  readonly apiBaseUrl?: string;
  readonly apiEnhancedDir?: string;
  readonly mpvPath?: string;
}
