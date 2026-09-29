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
  private generation = 0;
  private loading = false;

  constructor(private readonly player: MusicPlayer) {
    player.on("ended", () => {
      this.currentSong = null;
    });
    player.on("error", (info) => {
      const error = info instanceof Error ? info : new Error("播放器发生未知错误");
      this.lastError = error.message;
      this.currentSong = null;
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
    const generation = ++this.generation;
    const interruption = this.loading ? this.player.stop() : Promise.resolve();
    void interruption.catch(() => undefined);
    return this.enqueue(async () => {
      await interruption;
      if (generation !== this.generation) throw new Error("播放项已被新操作取代");
      this.lastError = null;
      this.loading = true;
      try {
        await this.player.load(url, song.durationMs, song.id);
        if (generation !== this.generation) throw new Error("播放项已被新操作取代");
        this.currentSong = song;
      } catch (error) {
        if (generation === this.generation) this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    });
  }

  pause(): Promise<void> { return this.enqueue(() => this.player.pause()); }
  resume(): Promise<void> { return this.enqueue(() => this.player.resume()); }

  stop(): Promise<void> {
    this.generation++;
    const stopping = this.player.stop();
    void stopping.catch(() => undefined);
    return this.enqueue(async () => {
      await stopping;
      this.currentSong = null;
    });
  }

  setVolume(volume: number): Promise<void> { return this.enqueue(() => this.player.setVolume(volume)); }

  progress(): Promise<PlayerProgress> { return this.player.progress(); }

  async close(): Promise<void> {
    this.generation++;
    if (this.loading) await this.player.stop().catch(() => undefined);
    await this.queue.catch(() => undefined);
    try {
      await this.player.close();
    } finally {
      this.currentSong = null;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
