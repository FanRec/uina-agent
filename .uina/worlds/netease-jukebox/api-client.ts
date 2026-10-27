import type { SongInfo } from "./types.js";

export class NeteaseRequestError extends Error {
  readonly status?: number;
  readonly attempts: number;
  readonly retryable: boolean;
  /** 服务端把模块内部异常合成的 `{code:404,msg:'Not Found'}`：语义是通道故障，不是资源不存在。 */
  readonly synthesized404: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      attempts?: number;
      retryable?: boolean;
      synthesized404?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "NeteaseRequestError";
    this.status = options.status;
    this.attempts = options.attempts ?? 1;
    this.retryable = options.retryable ?? false;
    this.synthesized404 = options.synthesized404 ?? false;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/**
 * 非 2xx 时的错误分类：
 * - api-enhanced 服务端把"模块 handler 抛出的无 body 裸异常"统一合成为 {code:404, msg:'Not Found'}（server.js catch 分支）。
 *   这是服务端内部故障而非上游 404，同通道重试不会自愈，因此标记 synthesized404 交给调用方换通道；
 * - 其余 4xx 保持不可重试；5xx 瞬态照旧。
 * 响应体中的 msg 会拼入错误消息，让调用方无需看服务端日志即可定性。
 */
async function ensureSuccessfulResponse(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  let detail = "";
  let synthesized404 = false;
  try {
    const text = (await response.text()).slice(0, 400);
    try {
      const body = JSON.parse(text) as { code?: unknown; msg?: unknown; message?: unknown };
      if (body.code === 404 && body.msg === "Not Found") synthesized404 = true;
      const message = typeof body.msg === "string" ? body.msg : typeof body.message === "string" ? body.message : "";
      detail = message || text;
    } catch {
      detail = text;
    }
  } catch {
    // 响应体不可读时退化为仅报告状态码
  }
  throw new NeteaseRequestError(`${operation}: HTTP ${response.status}${detail ? `: ${detail}` : ""}`, {
    status: response.status,
    retryable: isRetryableStatus(response.status),
    synthesized404,
  });
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof NeteaseRequestError) return error.retryable;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  return error instanceof TypeError || /fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(message);
}

function waitForRetry(signal: AbortSignal | undefined, deadline: number): Promise<void> {
  const delayMs = 200;
  if (deadline - Date.now() <= delayMs) return Promise.reject(new Error("网易云请求总时限已到"));
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("网易云请求已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * 把上游歌曲对象投影成 SongInfo。
 *
 * 上游在不同接口里对同一事实用不同键名（`ar` / `artists`、`dt` / `duration`、`al` / `album`），
 * 且每首歌会带 50 余个与本项目无关的字段（码率、版权、标签、跳转信息）。详情、批量详情、
 * 歌单曲目共用这一份映射，避免三处各自猜键名，也保证模型看到的曲目形状一致。
 *
 * 缺少 id 的条目返回 null，由调用方过滤——不伪造占位歌曲。
 */
export function projectSong(raw: unknown): SongInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const song = raw as Record<string, unknown>;
  const id = song.id === undefined || song.id === null ? "" : String(song.id);
  if (!id) return null;
  const artists = Array.isArray(song.ar) ? song.ar : Array.isArray(song.artists) ? song.artists : [];
  const album = song.al && typeof song.al === "object" ? (song.al as Record<string, unknown>).name : song.album;
  const duration = typeof song.dt === "number" ? song.dt : typeof song.duration === "number" ? song.duration : null;
  return {
    id,
    name: typeof song.name === "string" && song.name ? song.name : `歌曲 #${id}`,
    artists: artists
      .map((artist) => (artist && typeof artist === "object" ? String((artist as Record<string, unknown>).name ?? "") : ""))
      .filter(Boolean),
    durationMs: duration,
    ...(typeof album === "string" && album ? { album } : {}),
  };
}

/** 上游 /song/detail 支持逗号分隔 ids（源码注释：不超过 1000），按 100 分块避免 URL 过长。 */
const SONG_DETAIL_CHUNK = 100;

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

    const url = new URL(`${this.baseUrl}/cloudsearch`);
    url.searchParams.set("keywords", trimmed);
    url.searchParams.set("type", "1");
    url.searchParams.set("limit", String(limit));

    const data = await this.request(url.toString(), 15_000, signal, async (res) => {
      await ensureSuccessfulResponse(res, "网易云搜索失败");
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
  }

  /**
   * v1 默认走 xeapi 加密通道，该通道依赖服务端本地的公钥文件；公钥缺失时服务端把 handler
   * 的内部异常合成为 404 Not Found（与"歌曲不存在"同形）。这类故障只破坏通道，不影响账号
   * 与版权，换 weapi 重试一次即可恢复播放；上游 404 不降级，因为换通道同样无解。
   */
  async getSongUrl(songId: string, signal?: AbortSignal): Promise<string | null> {
    try {
      return await this.requestSongUrl(songId, signal);
    } catch (error) {
      if (!(error instanceof NeteaseRequestError) || !error.synthesized404) throw error;
      return await this.requestSongUrl(songId, signal, "weapi");
    }
  }

  private requestSongUrl(songId: string, signal?: AbortSignal, crypto?: "weapi"): Promise<string | null> {
    const url = new URL(`${this.baseUrl}/song/url/v1`);
    url.searchParams.set("id", songId);
    url.searchParams.set("level", "standard");
    if (crypto) url.searchParams.set("crypto", crypto);

    return this.request(url.toString(), 15_000, signal, async (res) => {
      await ensureSuccessfulResponse(res, "网易云播放地址查询失败");
      const data = (await res.json()) as {
        data?: Array<{ url?: string }>;
      };
      const item = data.data?.[0];
      return item?.url ?? null;
    });
  }

  async getLyrics(songId: string, signal?: AbortSignal): Promise<string | null> {
    const id = songId.trim();
    if (!id) throw new Error("歌曲 ID 不能为空");
    const url = new URL(`${this.baseUrl}/lyric`);
    url.searchParams.set("id", id);
    return this.request(url.toString(), 15_000, signal, async (res) => {
      await ensureSuccessfulResponse(res, "网易云歌词查询失败");
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
      await ensureSuccessfulResponse(res, "网易云歌曲详情查询失败");
      const data = await res.json() as { songs?: unknown[] };
      return projectSong(data.songs?.[0]);
    });
  }

  /**
   * 批量取歌曲详情。用于"只有 id 序列"的场景（如红心列表），
   * 让调用方不必自己拼请求，也不必自己猜上游键名。
   *
   * 任一分块失败即抛出，不返回部分结果：残缺的列表会被调用方当成完整列表，
   * 那比明确失败更难发现。降级策略由调用方决定。
   */
  async getSongInfos(songIds: readonly string[], signal?: AbortSignal): Promise<SongInfo[]> {
    const ids = songIds.map((value) => value.trim()).filter(Boolean);
    if (ids.length === 0) return [];
    const songs: SongInfo[] = [];
    for (let start = 0; start < ids.length; start += SONG_DETAIL_CHUNK) {
      const url = new URL(`${this.baseUrl}/song/detail`);
      url.searchParams.set("ids", ids.slice(start, start + SONG_DETAIL_CHUNK).join(","));
      const data = await this.request(url.toString(), 15_000, signal, async (res) => {
        await ensureSuccessfulResponse(res, "网易云歌曲详情查询失败");
        return await res.json() as { songs?: unknown[] };
      });
      for (const raw of data.songs ?? []) {
        const song = projectSong(raw);
        if (song) songs.push(song);
      }
    }
    return songs;
  }

  private async request<T>(url: string, timeoutMs: number, signal: AbortSignal | undefined, read: (response: Response) => T | Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      signal?.throwIfAborted();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new NeteaseRequestError(`网易云请求超时 (${timeoutMs}ms)`, { attempts: attempt - 1, cause: lastError });

      const controller = new AbortController();
      let timer: NodeJS.Timeout;
      let rejectInterrupted: (reason: Error) => void = () => undefined;
      const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
      timer = setTimeout(() => {
        const error = new Error(`网易云请求超时 (${timeoutMs}ms)`);
        controller.abort(error);
        rejectInterrupted(error);
      }, remainingMs);
      const onAbort = () => {
        const error = signal?.reason instanceof Error ? signal.reason : new Error("网易云请求已取消");
        controller.abort(error);
        rejectInterrupted(error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      try {
        const response = await Promise.race([fetch(url, { signal: controller.signal }), interrupted]);
        return await read(response);
      } catch (error) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
      if (controller.signal.aborted) {
          throw new NeteaseRequestError(error instanceof Error ? error.message : String(error), { attempts: attempt, cause: error });
        }
        const retryable = isRetryableError(error);
        if (!retryable || attempt === 2) {
          if (error instanceof NeteaseRequestError) {
            throw new NeteaseRequestError(error.message, {
              status: error.status,
              attempts: attempt,
              retryable: error.retryable,
              synthesized404: error.synthesized404,
              cause: error,
            });
          }
          if (retryable) {
            throw new NeteaseRequestError(`网易云请求失败: ${error instanceof Error ? error.message : String(error)}`, { attempts: attempt, retryable: true, cause: error });
          }
          throw error;
        }
        lastError = error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      if (deadline - Date.now() <= 200) {
        throw new NeteaseRequestError(`网易云请求失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`, { attempts: attempt, retryable: true, cause: lastError });
      }
      await waitForRetry(signal, deadline);
    }
    throw lastError;
  }
}
