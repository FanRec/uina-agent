import type { SongInfo } from "./types.js";

export class NeteaseApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = "http://localhost:3000") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async isHealthy(timeoutMs = 2000, signal?: AbortSignal): Promise<boolean> {
    try {
      return await this.request(`${this.baseUrl}/login/status`, timeoutMs, signal, (res) => res.ok && res.status === 200);
    } catch {
      return false;
    }
  }

  async searchSongs(query: string, limit = 10, signal?: AbortSignal): Promise<readonly SongInfo[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    try {
      const url = new URL(`${this.baseUrl}/cloudsearch`);
      url.searchParams.set("keywords", trimmed);
      url.searchParams.set("type", "1");
      url.searchParams.set("limit", String(limit));

      const data = await this.request(url.toString(), 15_000, signal, async (res) => {
        if (!res.ok) throw new Error(`网易云搜索失败: HTTP ${res.status}`);
        return await res.json() as {
        result?: {
          songs?: Array<{
            id: number | string;
            name: string;
            ar?: Array<{ name: string }>;
            artists?: Array<{ name: string }>;
            dt?: number;
            duration?: number;
            al?: { name: string };
            album?: { name: string };
          }>;
        };
        };
      });

      const songs = data.result?.songs;
      if (!Array.isArray(songs)) throw new Error("网易云搜索响应格式错误");

      return songs.map((s) => ({
        id: String(s.id),
        name: s.name ?? "未知曲目",
        artists: (s.ar ?? s.artists ?? []).map((a) => a.name).filter(Boolean),
        durationMs: s.dt ?? s.duration ?? null,
        album: s.al?.name ?? s.album?.name,
      }));
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async getSongUrl(songId: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const url = new URL(`${this.baseUrl}/song/url/v1`);
      url.searchParams.set("id", songId);
      url.searchParams.set("level", "standard");

      return await this.request(url.toString(), 15_000, signal, async (res) => {
        if (res.ok) {
          const data = (await res.json()) as {
          data?: Array<{ url?: string; freeTrialInfo?: unknown }>;
          };
          const item = data.data?.[0];
          if (item?.url) return item.url;
        }
        return null;
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async getLyrics(songId: string, signal?: AbortSignal): Promise<string | null> {
    const id = songId.trim();
    if (!id) throw new Error("歌曲 ID 不能为空");
    const url = new URL(`${this.baseUrl}/lyric`);
    url.searchParams.set("id", id);
    return this.request(url.toString(), 15_000, signal, async (res) => {
      if (!res.ok) throw new Error(`网易云歌词查询失败: HTTP ${res.status}`);
      const data = await res.json() as { lrc?: { lyric?: unknown } };
      if (data.lrc?.lyric === undefined || data.lrc.lyric === null) return null;
      if (typeof data.lrc.lyric !== "string") throw new Error("网易云歌词响应格式错误");
      return data.lrc.lyric;
    });
  }

  async getSongInfo(songId: string, signal?: AbortSignal): Promise<SongInfo | null> {
    const id = songId.trim();
    if (!id) throw new Error("歌曲 ID 不能为空");
    const url = new URL(`${this.baseUrl}/song/detail`);
    url.searchParams.set("ids", id);
    return this.request(url.toString(), 15_000, signal, async (res) => {
      if (!res.ok) throw new Error(`网易云歌曲详情查询失败: HTTP ${res.status}`);
      const data = await res.json() as {
        songs?: Array<{
          id: number | string;
          name?: string;
          ar?: Array<{ name?: string }>;
          dt?: number;
          al?: { name?: string };
        }>;
      };
      const song = data.songs?.[0];
      if (!song) return null;
      return {
        id: String(song.id),
        name: song.name ?? `歌曲 #${id}`,
        artists: (song.ar ?? []).map((artist) => artist.name ?? "").filter(Boolean),
        durationMs: song.dt ?? null,
        album: song.al?.name,
      };
    });
  }

  private async request<T>(url: string, timeoutMs: number, signal: AbortSignal | undefined, read: (response: Response) => T | Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    let timer: NodeJS.Timeout;
    let rejectInterrupted: (reason: Error) => void = () => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    timer = setTimeout(() => {
      const error = new Error(`网易云请求超时 (${timeoutMs}ms)`);
      controller.abort(error);
      rejectInterrupted(error);
    }, timeoutMs);
    const onAbort = () => {
      const error = signal?.reason instanceof Error ? signal.reason : new Error("网易云请求已取消");
      controller.abort(error);
      rejectInterrupted(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([fetch(url, { signal: controller.signal }).then(read), interrupted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
