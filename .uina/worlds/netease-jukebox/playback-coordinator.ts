import type { MusicPlayer, PlayerProgress } from "./player.js";
import type { SongInfo } from "./types.js";
import type { PlaybackMode } from "./hud-protocol.js";

export interface TrackLoader { (song: SongInfo, signal?: AbortSignal): Promise<{ url: string | null; song: SongInfo }>; }
export interface PlaybackCoordinatorSnapshot {
  status: "idle" | "loading" | "playing" | "paused" | "stopped" | "error";
  currentSong: SongInfo | null; queue: readonly SongInfo[]; history: readonly SongInfo[];
  playMode: PlaybackMode; volume: number; availability: MusicPlayer["availability"];
  lastError: string | null; positionMs: number; durationMs: number | null;
}

export class PlaybackCoordinator {
  private currentSong: SongInfo | null = null;
  private lastError: string | null = null;
  private queue: SongInfo[] = [];
  private history: SongInfo[] = [];
  private operations: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private playModeValue: PlaybackMode = "queue_order";
  private position: PlayerProgress = { positionMs: 0, durationMs: null };
  private loader: TrackLoader | null = null;
  private listeners = new Set<(snapshot: PlaybackCoordinatorSnapshot) => void>();

  constructor(private readonly player: MusicPlayer, private readonly queueLimit = 100, private readonly historyLimit = 50) {
    player.on("ended", () => { void this.handleEnded(); });
    player.on("error", info => { this.lastError = info instanceof Error ? info.message : "播放器发生未知错误"; this.currentSong = null; this.emit(); });
  }
  setLoader(loader: TrackLoader): void { this.loader = loader; }
  get isSimulated(): boolean { return this.player.isSimulated; }
  get availability(): MusicPlayer["availability"] { return this.player.availability; }
  get volume(): number { return this.player.volume; }
  get status(): PlaybackCoordinatorSnapshot["status"] { return this.player.status === "idle" && this.lastError ? "error" : this.player.status; }
  get mode(): PlaybackMode { return this.playModeValue; }
  snapshot(): PlaybackCoordinatorSnapshot { return { status: this.status, currentSong: this.currentSong, queue: [...this.queue], history: [...this.history], playMode: this.playModeValue, volume: this.player.volume, availability: this.player.availability, lastError: this.lastError, ...this.position }; }
  subscribe(listener: (snapshot: PlaybackCoordinatorSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setMode(mode: PlaybackMode): void { this.playModeValue = mode; this.emit(); }
  async progress(): Promise<PlayerProgress> { this.position = await this.player.progress(); return this.position; }
  load(url: string, song: SongInfo): Promise<void> { return this.enqueue(() => this.loadInternal(url, song)); }
  async loadSong(song: SongInfo, signal?: AbortSignal): Promise<void> { if (!this.loader) throw new Error("播放加载器未配置"); const generation = ++this.generation; return this.enqueue(async () => { const loaded = await this.loader!(song, signal); if (generation !== this.generation) throw new Error("播放项已被新操作取代"); if (!loaded.url && !this.isSimulated) throw new Error("歌曲没有可用播放地址"); await this.loadInternal(loaded.url ?? "simulated://stream", loaded.song); }); }
  add(song: SongInfo): void { if (this.queue.length >= this.queueLimit) throw new Error(`播放队列已满（上限 ${this.queueLimit}）`); this.queue.push(song); this.emit(); }
  remove(index: number): SongInfo | null { if (!Number.isInteger(index) || index < 0 || index >= this.queue.length) return null; const [song] = this.queue.splice(index, 1); this.emit(); return song ?? null; }
  move(from: number, to: number): boolean { if (![from, to].every(Number.isInteger) || from < 0 || to < 0 || from >= this.queue.length || to >= this.queue.length) return false; const [song] = this.queue.splice(from, 1); if (!song) return false; this.queue.splice(to, 0, song); this.emit(); return true; }
  shuffle(): void { for (let i = this.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.queue[i], this.queue[j]] = [this.queue[j]!, this.queue[i]!]; } this.emit(); }
  clear(): void { this.queue = []; this.emit(); }
  async playNext(signal?: AbortSignal): Promise<SongInfo | null> {
    const index = this.playModeValue === "shuffle" ? (this.queue.length ? Math.floor(Math.random() * this.queue.length) : -1) : 0;
    const song = index >= 0 ? this.queue[index] ?? null : null;
    if (!song) return null;
    await this.loadSong(song, signal);
    this.queue.splice(index, 1);
    this.emit();
    return song;
  }
  async playPrevious(signal?: AbortSignal): Promise<SongInfo | null> {
    if (this.currentSong && this.position.positionMs > 5000) return this.currentSong;
    const song = this.history.pop() ?? null;
    if (!song) return null;
    try { await this.loadSong(song, signal); } catch (error) { this.history.push(song); throw error; }
    this.emit();
    return song;
  }
  pause(): Promise<void> { return this.enqueue(() => this.player.pause()); }
  resume(): Promise<void> { return this.enqueue(() => this.player.resume()); }
  stop(clearQueue = false): Promise<void> { this.generation++; if (clearQueue) this.queue = []; return this.enqueue(async () => { await this.player.stop(); this.currentSong = null; this.lastError = null; this.position = { positionMs: 0, durationMs: null }; this.emit(); }); }
  setVolume(volume: number): Promise<void> { return this.enqueue(async () => { await this.player.setVolume(volume); this.emit(); }); }
  async close(): Promise<void> { this.generation++; await this.player.stop().catch(() => undefined); await this.operations.catch(() => undefined); await this.player.close(); this.listeners.clear(); }
  private async loadInternal(url: string, song: SongInfo): Promise<void> { const old = this.currentSong; if (old && old.id !== song.id) this.history = [old, ...this.history.filter(item => item.id !== old.id)].slice(0, this.historyLimit); this.lastError = null; this.currentSong = null; this.position = { positionMs: 0, durationMs: song.durationMs }; this.emit(); try { await this.player.load(url, song.durationMs, song.id); this.currentSong = song; this.emit(); } catch (error) { this.lastError = error instanceof Error ? error.message : String(error); this.emit(); throw error; } }
  private async handleEnded(): Promise<void> { const ended = this.currentSong; if (!ended) return; if (this.playModeValue === "single_loop") { try { await this.loadSong(ended); } catch { /* state contains the failure */ } return; } this.history = [ended, ...this.history.filter(item => item.id !== ended.id)].slice(0, this.historyLimit); this.currentSong = null; this.position = { positionMs: 0, durationMs: null }; this.emit(); if (this.playModeValue === "single_once") return; if (this.playModeValue === "list_loop") this.queue.push(ended); if (!this.loader) return; try { await this.playNext(); } catch { /* state contains the failure */ } }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> { const result = this.operations.then(operation); this.operations = result.catch(() => undefined); return result; }
  private emit(): void { const snapshot = this.snapshot(); for (const listener of this.listeners) listener(snapshot); }
}
