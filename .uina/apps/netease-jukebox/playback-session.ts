import type { MusicPlayer, PlayerProgress } from "./player.js";
import type { JukeboxState, SongInfo } from "./types.js";

export interface PlaybackSnapshot {
  readonly status: JukeboxState["status"];
  readonly currentSong: SongInfo | null;
  readonly volume: number;
  readonly availability: MusicPlayer["availability"];
  readonly lastError: string | null;
}

/** Owns playback lifecycle facts and serializes commands sent to a player adapter. */
export class PlaybackSession {
  private currentSong: SongInfo | null = null;
  private lastError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly player: MusicPlayer) {
    player.on("ended", () => {
      this.currentSong = null;
    });
    player.on("error", (info) => {
      const error = info instanceof Error ? info : new Error("播放器发生未知错误");
      this.lastError = error.message;
    });
  }

  get status(): JukeboxState["status"] { return this.player.status; }
  get volume(): number { return this.player.volume; }
  get availability(): MusicPlayer["availability"] { return this.player.availability; }
  get isSimulated(): boolean { return this.player.isSimulated; }

  snapshot(): PlaybackSnapshot {
    return {
      status: this.player.status,
      currentSong: this.currentSong,
      volume: this.player.volume,
      availability: this.player.availability,
      lastError: this.lastError,
    };
  }

  load(url: string, song: SongInfo): Promise<void> {
    return this.enqueue(async () => {
      this.lastError = null;
      await this.player.load(url, song.durationMs, song.id);
      this.currentSong = song;
    });
  }

  pause(): Promise<void> { return this.enqueue(() => this.player.pause()); }
  resume(): Promise<void> { return this.enqueue(() => this.player.resume()); }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      await this.player.stop();
      this.currentSong = null;
    });
  }

  setVolume(volume: number): Promise<void> { return this.enqueue(() => this.player.setVolume(volume)); }

  progress(): Promise<PlayerProgress> { return this.player.progress(); }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    await this.player.close();
    this.currentSong = null;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
