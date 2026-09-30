export type PlaybackMode = "single_once" | "queue_order" | "list_loop" | "single_loop" | "shuffle";

export interface HudTrack {
  id: string;
  name: string;
  artists: string[];
  albumName: string | null;
  durationMs: number | null;
}

export interface BroadcastHudSnapshot {
  version: 1;
  sourceInstance: string;
  revision: number;
  updatedAt: string;
  source: { id: string; kind: "music"; label: string };
  connection: { status: "connected" | "degraded" | "disconnected"; lastError: string | null };
  playback: {
    status: "idle" | "loading" | "playing" | "paused" | "stopped" | "error";
    playMode: PlaybackMode;
    volumePercent: number;
    currentTrack: HudTrack | null;
    positionMs: number;
    durationMs: number | null;
  };
  lyrics: { previous: string | null; current: string | null; next: string | null };
  queue: { items: HudTrack[]; total: number };
  spectrum: { source: "audio" | "silent"; bands: number[]; energy: number; beat: number };
}

export function toHudTrack(track: { id: string; name: string; artists: readonly string[]; album?: string; durationMs: number | null }): HudTrack {
  return { id: track.id, name: track.name, artists: [...track.artists], albumName: track.album ?? null, durationMs: track.durationMs };
}
