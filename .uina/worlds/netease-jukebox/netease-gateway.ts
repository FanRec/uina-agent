import { NeteaseApiClient, projectSong } from "./api-client.js";
import type { SongInfo } from "./types.js";
export interface PlaylistInfo { id: string; name: string; trackCount: number; creator: string | null; }
export interface GatewayResult { code?: number; [key: string]: unknown; }
export interface EditablePlaylist {
  id: string;
  name: string;
  ownerId: string | null;
  editable: boolean;
  trackIds: readonly string[] | null;
  description: string;
  tags: readonly string[];
}

/**
 * 歌单的分页投影。
 *
 * `playableTotal` 是上游实际给出的曲目数，`declaredTotal` 是它声称的总数
 * （`trackIds` 长度与 `trackCount` 取大者）。两者不等说明上游只返回了部分曲目
 * （下架或不可见），`missing` 如实暴露差值——不伪造占位歌曲，也不假装齐全。
 *
 * 翻页一律以 `playableTotal` 为准。若拿 `declaredTotal` 算 `nextOffset`，
 * 会指向不存在的页，调用方翻到空页却仍被告知"还有更多"。
 */
export interface PlaylistView {
  id: string;
  name: string;
  creator: string | null;
  declaredTotal: number;
  playableTotal: number;
  missing: number;
  description?: string;
  tracks: SongInfo[];
  paging: {
    offset: number;
    limit: number;
    returned: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
}

class NeteaseGatewayHttpError extends Error {
	constructor(readonly status: number) {
		super(`网易云请求失败: HTTP ${status}`);
		this.name = "NeteaseGatewayHttpError";
	}
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
  /**
   * 歌单详情的分页投影。
   *
   * 上游 /playlist/detail 一次返回三份同源数据：`tracks`（每首 50 余字段）、
   * `privileges`（每条约 1 KB 版权对象）、`trackIds`。232 首的歌单实测 565 KB，
   * 而模型只需要"哪首、谁唱的、多长"。投影后单首约 143 字节，一页 50 首约 8 KB。
   *
   * 结构化事实不截断——截断后的 JSON 是坏对象，比不给更糟；列表的正确处理是分页。
   */
  async playlistView(id: string, offset = 0, limit = 50, signal?: AbortSignal): Promise<PlaylistView> {
    const value = await this.fetchPlaylist(id, signal);
    const raw = value.playlist;
    const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const allTracks = Array.isArray(data.tracks) ? data.tracks : [];
    const trackIds = Array.isArray(data.trackIds) ? data.trackIds : [];
    const playableTotal = allTracks.length;
    const declaredTotal = Math.max(trackIds.length, Number(data.trackCount ?? 0) || 0);
    const start = Math.max(0, Math.floor(offset));
    const size = Math.max(1, Math.floor(limit));
    // 按原始切片推进分页：projectSong 可能丢弃无 id 的条目，用过滤后的条数算 nextOffset 会漏条目。
    const slice = allTracks.slice(start, start + size);
    const tracks = slice.map(projectSong).filter((song): song is SongInfo => song !== null);
    const nextOffset = start + slice.length;
    const creator = data.creator;
    return {
      id: String(data.id ?? id),
      name: String(data.name ?? "未命名歌单"),
      creator: creator && typeof creator === "object" ? String((creator as Record<string, unknown>).nickname ?? "") : null,
      declaredTotal,
      playableTotal,
      missing: Math.max(0, declaredTotal - playableTotal),
      ...(typeof data.description === "string" && data.description ? { description: data.description } : {}),
      tracks,
      paging: {
        offset: start,
        limit: size,
        returned: tracks.length,
        hasMore: nextOffset < playableTotal,
        nextOffset: nextOffset < playableTotal ? nextOffset : null,
      },
    };
  }

  /** 未投影的原始歌单响应。只允许内部使用：它的体积与形状都不适合直接交给模型。 */
  private async fetchPlaylist(id: string, signal?: AbortSignal): Promise<GatewayResult> { return this.request("/playlist/detail", { id }, signal); }

  async playlistForWrite(id: string, signal?: AbortSignal): Promise<EditablePlaylist | null> {
    const value = await this.fetchPlaylist(id, signal);
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
      // privacy 是可见性（0 = 公开），不是可编辑；上游不下发 editable 时不能据此推断写权限。
      editable: data.editable === true,
      trackIds,
      description: typeof data.description === "string" ? data.description : "",
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    };
  }
  /**
   * 红心歌曲的 id 序列。/likelist 只给 id，不同服务版本可能把 ids 包在 data 里；
   * 认不出的形状返回空数组，由调用方按"没有红心歌曲"处理，不逐层猜。
   */
  async likedSongIds(uid: string, signal?: AbortSignal): Promise<string[]> {
    const value = await this.request("/likelist", { uid }, signal);
    const nested = value.data && typeof value.data === "object" ? (value.data as Record<string, unknown>) : undefined;
    const raw = Array.isArray(value.ids) ? value.ids : Array.isArray(nested?.ids) ? nested.ids : [];
    return raw.map((item) => String(item)).filter(Boolean);
  }
  async recentSongs(limit = 20, signal?: AbortSignal): Promise<unknown> { return this.request("/record/recent/song", { limit }, signal); }
  async comments(kind: "song" | "playlist", id: string, limit = 20, signal?: AbortSignal): Promise<unknown> { return this.request(kind === "song" ? "/comment/music" : "/comment/playlist", { id, limit }, signal); }
  async like(songId: string, like: boolean, signal?: AbortSignal): Promise<GatewayResult> { return this.request("/like", { id: songId, like: String(like) }, signal); }
  async createPlaylist(name: string, privacy: "public" | "private", signal?: AbortSignal): Promise<GatewayResult> { return this.request("/playlist/create", { name, privacy: privacy === "private" ? 10 : 0 }, signal, "POST"); }
  async subscribePlaylist(id: string, subscribe: boolean, signal?: AbortSignal): Promise<GatewayResult> { return this.request("/playlist/subscribe", { id, t: subscribe ? 1 : 2 }, signal, "POST"); }
  /**
   * 编辑歌单。
   *
   * 上游把 name/desc/tags 当成整份状态一起提交，没有"保持不变"这个取值：缺 desc 就是清空，
   * 缺 name 就是改名成字符串 "undefined"。所以三个参数都是必填，由调用方补齐当前值。
   */
  async updatePlaylist(id: string, name: string, description: string, tags: string, signal?: AbortSignal): Promise<GatewayResult> {
    return this.request("/playlist/update", { id, name, desc: description, tags }, signal, "POST");
  }
  async addToPlaylist(playlistId: string, songId: string, signal?: AbortSignal): Promise<GatewayResult> {
    return this.playlistTracks("add", playlistId, songId, signal);
  }
  async removeFromPlaylist(playlistId: string, songId: string, signal?: AbortSignal): Promise<GatewayResult> {
    return this.playlistTracks("del", playlistId, songId, signal);
  }
  /**
   * 歌曲歌单的增删只有这一个端点。
   *
   * 名字更像的 playlist/track/add 与 playlist/track/delete 是「视频歌单」那两个接口（文档
   * 「收藏视频到视频歌单」一节），拿它们操作普通歌曲歌单，上游一律回 401「无权限操作歌单」。
   * 那条 401 与登录态无关，换 cookie 也不会好。
   */
  private playlistTracks(operation: "add" | "del", playlistId: string, songId: string, signal?: AbortSignal): Promise<GatewayResult> {
    return this.request("/playlist/tracks", { op: operation, pid: playlistId, tracks: songId }, signal, "POST");
  }
  async comment(kind: "song" | "playlist", id: string, content: string, signal?: AbortSignal): Promise<GatewayResult> { return this.request(kind === "song" ? "/comment" : "/comment", { id, content, type: kind === "song" ? 0 : 2 }, signal, "POST"); }
  private async request(path: string, params: Record<string, string | number>, signal?: AbortSignal, method: "GET" | "POST" = "GET"): Promise<GatewayResult> {
    signal?.throwIfAborted();
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
        if (!response.ok) {
          const httpError = new NeteaseGatewayHttpError(response.status);
          if (method === "GET" && isTransientStatus(response.status) && attempt === 0) {
            lastError = httpError;
            await waitForRetry(signal);
            continue;
          }
          throw wrapUncertainWrite(httpError, method);
        }
        const body = await response.json() as GatewayResult;
        if (typeof body.code === "number" && body.code !== 200) throw new Error(`网易云业务请求失败: code ${body.code}`);
        return body;
        } catch (error) {
          lastError = error;
          if (signal?.aborted || controller.signal.aborted || attempt === 1 || method !== "GET" || !isTransientNetworkError(error)) {
            throw wrapUncertainWrite(error, method);
          }
        }
      }
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
    }
    throw wrapUncertainWrite(lastError instanceof Error ? lastError : new Error(String(lastError)), method);
  }
}

/** POST 写请求的超时/网络/5xx 属于副作用未确认：包装后由 world-tool 归入 unknown，禁止盲重试。 */
function wrapUncertainWrite(error: unknown, method: "GET" | "POST"): unknown {
  if (method !== "POST" || error instanceof NeteaseUncertainWriteError || !isUncertainWriteError(error)) return error;
  return new NeteaseUncertainWriteError(`网易云写请求结果未知：${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

function isTransientStatus(status: number): boolean {
	return status === 502 || status === 503 || status === 504;
}

function waitForRetry(signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, 200);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason instanceof Error ? signal.reason : new Error("网易云请求已取消"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

function isTransientNetworkError(error: unknown): boolean {
	if (error instanceof NeteaseGatewayHttpError) return false;
	if (error instanceof DOMException && error.name === "AbortError") return false;
	const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
	return error instanceof TypeError || /fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(message);
}

function isUncertainWriteError(error: unknown): boolean {
	if (error instanceof NeteaseGatewayHttpError) return [408, 500, 502, 503, 504].includes(error.status);
	const message = error instanceof Error ? error.message : String(error);
	return /HTTP 5\d\d|timeout|超时|fetch failed|network|socket|ECONN|连接/i.test(message);
}
