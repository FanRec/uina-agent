import type { SongInfo } from "./types.js";

export class NeteaseApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = "http://localhost:3000") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async isHealthy(timeoutMs = 2000): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${this.baseUrl}/login/status`, {
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timer);
      return res !== null && (res.status === 200 || res.status === 301 || res.status === 404);
    } catch {
      return false;
    }
  }

  async searchSongs(query: string, limit = 10): Promise<readonly SongInfo[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    try {
      const url = new URL(`${this.baseUrl}/cloudsearch`);
      url.searchParams.set("keywords", trimmed);
      url.searchParams.set("type", "1");
      url.searchParams.set("limit", String(limit));

      const res = await fetch(url.toString());
      if (!res.ok) {
        return this.fallbackSearch(trimmed, limit);
      }
      const data = (await res.json()) as {
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

      const songs = data.result?.songs;
      if (!Array.isArray(songs) || songs.length === 0) {
        return this.fallbackSearch(trimmed, limit);
      }

      return songs.map((s) => ({
        id: String(s.id),
        name: s.name ?? "未知曲目",
        artists: (s.ar ?? s.artists ?? []).map((a) => a.name).filter(Boolean),
        durationMs: s.dt ?? s.duration ?? null,
        album: s.al?.name ?? s.album?.name,
      }));
    } catch {
      return this.fallbackSearch(trimmed, limit);
    }
  }

  private async fallbackSearch(query: string, limit: number): Promise<readonly SongInfo[]> {
    try {
      const url = new URL(`${this.baseUrl}/search`);
      url.searchParams.set("keywords", query);
      url.searchParams.set("type", "1");
      url.searchParams.set("limit", String(limit));

      const res = await fetch(url.toString());
      if (!res.ok) {
        return [];
      }
      const data = (await res.json()) as {
        result?: {
          songs?: Array<{
            id: number | string;
            name: string;
            artists?: Array<{ name: string }>;
            duration?: number;
            album?: { name: string };
          }>;
        };
      };

      const songs = data.result?.songs ?? [];
      return songs.map((s) => ({
        id: String(s.id),
        name: s.name ?? "未知曲目",
        artists: (s.artists ?? []).map((a) => a.name).filter(Boolean),
        durationMs: s.duration ?? null,
        album: s.album?.name,
      }));
    } catch {
      return [];
    }
  }

  async getSongUrl(songId: string): Promise<string | null> {
    try {
      const url = new URL(`${this.baseUrl}/song/url/v1`);
      url.searchParams.set("id", songId);
      url.searchParams.set("level", "standard");

      const res = await fetch(url.toString());
      if (res.ok) {
        const data = (await res.json()) as {
          data?: Array<{ url?: string; freeTrialInfo?: unknown }>;
        };
        const item = data.data?.[0];
        if (item?.url) {
          return item.url;
        }
      }

      // Fallback to legacy /song/url
      const legacyUrl = new URL(`${this.baseUrl}/song/url`);
      legacyUrl.searchParams.set("id", songId);
      const legRes = await fetch(legacyUrl.toString());
      if (legRes.ok) {
        const legData = (await legRes.json()) as {
          data?: Array<{ url?: string }>;
        };
        return legData.data?.[0]?.url ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }
}
