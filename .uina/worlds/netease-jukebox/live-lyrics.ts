import { parseLrc, type LyricLine } from "./lyrics.js";
import type { SongInfo } from "./types.js";

export interface LyricsApi {
  getLyrics(songId: string, signal?: AbortSignal): Promise<string | null>;
}

export interface LyricsWindow {
  previous: string | null;
  current: string | null;
  next: string | null;
}

export class LiveLyricsTracker {
  private static readonly maxCacheEntries = 128;
  private readonly cache = new Map<string, readonly LyricLine[] | null>();
  private activeSongId: string | null = null;
  private activeLines: readonly LyricLine[] | null = null;
  private selectionGeneration = 0;
  private selectionAbort: AbortController | null = null;

  constructor(private readonly api: LyricsApi) {}

  async select(song: SongInfo, signal?: AbortSignal): Promise<void> {
    await this.selectInternal(song, signal, [], false);
  }

  async selectWithRetry(song: SongInfo, signal?: AbortSignal): Promise<void> {
    await this.selectInternal(song, signal, [2000, 4000, 8000], true);
  }

  private async selectInternal(song: SongInfo, signal: AbortSignal | undefined, delays: readonly number[], cancelPrevious: boolean): Promise<void> {
    if (cancelPrevious) this.selectionAbort?.abort();
    const controller = new AbortController();
    this.selectionAbort = controller;
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const generation = ++this.selectionGeneration;
    this.activeSongId = song.id;
    this.activeLines = this.cache.get(song.id) ?? null;
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (!this.isCurrentSelection(song.id, generation)) return;
        combined.throwIfAborted();
        try {
          const lines = await this.load(song, combined);
          if (this.isCurrentSelection(song.id, generation) && !combined.aborted) this.activeLines = lines;
          return;
        } catch (error) {
          if (combined.aborted) throw error;
          if (!this.isCurrentSelection(song.id, generation)) return;
          const delayMs = delays[attempt];
          if (delayMs === undefined) throw error;
          await wait(delayMs, combined);
        }
      }
    } finally {
      if (this.selectionAbort === controller) this.selectionAbort = null;
    }
  }

  async getLines(song: SongInfo, signal?: AbortSignal): Promise<readonly LyricLine[]> {
    return (await this.load(song, signal)) ?? [];
  }

  private isCurrentSelection(songId: string, generation: number): boolean {
    return this.activeSongId === songId && this.selectionGeneration === generation;
  }

  clear(): void {
    this.selectionAbort?.abort();
    this.selectionAbort = null;
    this.selectionGeneration++;
    this.activeSongId = null;
    this.activeLines = null;
  }

  window(positionMs: number): LyricsWindow {
    return this.windowFor(this.activeSongId, this.activeLines, positionMs);
  }

  windowFor(songId: string | null, lines: readonly LyricLine[] | null, positionMs: number): LyricsWindow {
    if (!songId || !lines?.length) return { previous: null, current: null, next: null };
    let currentIndex = -1;
    for (let index = 0; index < lines.length; index++) {
      if (lines[index]!.timeMs > positionMs) break;
      currentIndex = index;
    }
    return {
      previous: currentIndex > 0 ? lines[currentIndex - 1]!.text : null,
      current: currentIndex >= 0 ? lines[currentIndex]!.text : null,
      next: lines[currentIndex + 1]?.text ?? null,
    };
  }

  private async load(song: SongInfo, signal?: AbortSignal): Promise<readonly LyricLine[] | null> {
    if (this.cache.has(song.id)) return this.cache.get(song.id) ?? null;
    const raw = await this.api.getLyrics(song.id, signal);
    const lines = raw ? parseLrc(raw) : null;
    this.cache.set(song.id, lines);
    this.trimCache();
    return lines;
  }

  private trimCache(): void {
    while (this.cache.size > LiveLyricsTracker.maxCacheEntries) {
      this.cache.delete(this.cache.keys().next().value!);
    }
  }
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("歌词请求已取消"));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("歌词请求已取消"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
