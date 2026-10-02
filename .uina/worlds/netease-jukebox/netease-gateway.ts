import { NeteaseApiClient } from "./api-client.js";
export interface PlaylistInfo { id: string; name: string; trackCount: number; creator: string | null; }
export interface GatewayResult { code?: number; [key: string]: unknown; }
export interface EditablePlaylist {
  id: string;
  name: string;
  ownerId: string | null;
  editable: boolean;
  trackIds: readonly string[] | null;
}

export class NeteaseUncertainWriteError extends Error {
	readonly effectUnknown = true;
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "NeteaseUncertainWriteError";
	}
}

export class NeteaseGateway {
  private readonly gatewayBaseUrl: string;
  private readonly client: NeteaseApiClient;
  constructor(baseUrl: string) {
    const url = new URL(baseUrl);
    if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname) && !url.hostname.endsWith(".test")) throw new Error("网易云 Gateway 只允许 loopback 地址");
    this.client = new NeteaseApiClient(baseUrl);
    this.gatewayBaseUrl = baseUrl.replace(/\/+$/, "");
  }
  searchSongs(query: string, limit = 10, signal?: AbortSignal) { return this.client.searchSongs(query, limit, signal); }
  getSongInfo(id: string, signal?: AbortSignal) { return this.client.getSongInfo(id, signal); }
  getSongUrl(id: string, signal?: AbortSignal) { return this.client.getSongUrl(id, signal); }
  getLyrics(id: string, signal?: AbortSignal) { return this.client.getLyrics(id, signal); }
  async accountStatus(signal?: AbortSignal): Promise<GatewayResult> { return this.request("/login/status", {}, signal); }
  async playlists(uid: string, signal?: AbortSignal): Promise<PlaylistInfo[]> { const value = await this.request("/user/playlist", { uid }, signal); return Array.isArray(value.playlist) ? value.playlist.map((p: Record<string, unknown>) => ({ id: String(p.id), name: String(p.name ?? "未命名歌单"), trackCount: Number(p.trackCount ?? 0), creator: typeof p.creator === "object" && p.creator ? String((p.creator as Record<string, unknown>).nickname ?? "") : null })) : []; }
  async playlist(id: string, signal?: AbortSignal): Promise<GatewayResult> { return this.request("/playlist/detail", { id }, signal); }
  async playlistForWrite(id: string, signal?: AbortSignal): Promise<EditablePlaylist | null> {
    const value = await this.playlist(id, signal);
    const playlist = value.playlist;
    if (!playlist || typeof playlist !== "object") return null;
    const data = playlist as Record<string, unknown>;
    const creator = data.creator;
    const creatorId = creator && typeof creator === "object" ? (creator as Record<string, unknown>).userId : undefined;
    const trackIds = Array.isArray(data.trackIds)
      ? data.trackIds.map(item => item && typeof item === "object" ? String((item as Record<string, unknown>).id ?? "") : String(item)).filter(Boolean)
      : Array.isArray(data.tracks)
        ? data.tracks.map(item => item && typeof item === "object" ? String((item as Record<string, unknown>).id ?? "") : "").filter(Boolean)
        : null;
    return {
      id: String(data.id ?? id),
      name: String(data.name ?? "未命名歌单"),
      ownerId: creatorId === undefined || creatorId === null ? null : String(creatorId),
      editable: data.editable === true || data.privacy === 0,
      trackIds,
    };
  }
  async likedSongs(uid: string, signal?: AbortSignal): Promise<unknown> { return this.request("/likelist", { uid }, signal); }
  async recentSongs(limit = 20, signal?: AbortSignal): Promise<unknown> { return this.request("/record/recent/song", { limit }, signal); }
  async comments(kind: "song" | "playlist", id: string, limit = 20, signal?: AbortSignal): Promise<unknown> { return this.request(kind === "song" ? "/comment/music" : "/comment/playlist", { id, limit }, signal); }
  async like(songId: string, like: boolean, signal?: AbortSignal): Promise<GatewayResult> { return this.request("/like", { id: songId, like: String(like) }, signal); }
  async createPlaylist(name: string, privacy: "public" | "private", signal?: AbortSignal): Promise<GatewayResult> { return this.request("/playlist/create", { name, privacy: privacy === "private" ? 10 : 0 }, signal, "POST"); }
  async subscribePlaylist(id: string, subscribe: boolean, signal?: AbortSignal): Promise<GatewayResult> { return this.request("/playlist/subscribe", { id, t: subscribe ? 1 : 2 }, signal, "POST"); }
  async updatePlaylist(id: string, name: string | undefined, description: string | undefined, tags: string | undefined, signal?: AbortSignal): Promise<GatewayResult> {
    return this.request("/playlist/update", { id, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { desc: description }), ...(tags === undefined ? {} : { tags }) }, signal, "POST");
  }
  async addToPlaylist(playlistId: string, songId: string, signal?: AbortSignal): Promise<GatewayResult> {
    return this.playlistTrackMutation("playlist_track_add", "add", playlistId, songId, signal);
  }
  async removeFromPlaylist(playlistId: string, songId: string, signal?: AbortSignal): Promise<GatewayResult> {
    return this.playlistTrackMutation("playlist_track_delete", "del", playlistId, songId, signal);
  }
  async comment(kind: "song" | "playlist", id: string, content: string, signal?: AbortSignal): Promise<GatewayResult> { return this.request(kind === "song" ? "/comment" : "/comment", { id, content, type: kind === "song" ? 0 : 2 }, signal, "POST"); }
  private async playlistTrackMutation(path: string, fallbackOperation: "add" | "del", playlistId: string, songId: string, signal?: AbortSignal): Promise<GatewayResult> {
    try {
      return await this.request(`/${path}`, { pid: playlistId, ids: songId }, signal, "POST");
    } catch (error) {
      if (!isFallbackEligible(error)) throw error;
      return this.request("/playlist_tracks", { op: fallbackOperation, pid: playlistId, tracks: songId }, signal, "POST");
    }
  }
  private async request(path: string, params: Record<string, string | number>, signal?: AbortSignal, method: "GET" | "POST" = "GET"): Promise<GatewayResult> {
    const url = new URL(`${this.gatewayBaseUrl}${path}`); if (method === "GET") for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("网易云请求超时")), 15000);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let lastError: unknown;
    try {
      const attempts = method === "GET" ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
        const response = await fetch(url, { method, headers: method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : undefined, body: method === "POST" ? new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])) : undefined, signal: controller.signal });
        if (!response.ok) { if (response.status >= 500 && attempt === 0) continue; throw new Error(`网易云请求失败: HTTP ${response.status}`); }
        const body = await response.json() as GatewayResult;
        if (typeof body.code === "number" && body.code !== 200) throw new Error(`网易云业务请求失败: code ${body.code}`);
        return body;
        } catch (error) {
          lastError = error;
          if (signal?.aborted || attempt === 1) {
            if (method === "POST" && isUncertainWriteError(error))
              throw new NeteaseUncertainWriteError(`网易云写请求结果未知：${error instanceof Error ? error.message : String(error)}`, { cause: error });
            throw error;
          }
        }
      }
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function isFallbackEligible(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (404|405|501)|HTTP 5\d\d|endpoint|not found|不存在/i.test(message);
}

function isUncertainWriteError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /HTTP 5\d\d|timeout|超时|fetch failed|network|socket|ECONN|连接/i.test(message);
}
