import type { ActionContext, ActionDef } from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { worldSucceeded } from "../../../src/extensions/world-framework/result.js";
import { NeteaseRequestError, type NeteaseApiClient } from "./api-client.js";
import { formatLyrics } from "./lyrics.js";
import { LiveLyricsTracker } from "./live-lyrics.js";
import type { NeteaseGateway, EditablePlaylist } from "./netease-gateway.js";
import type { PlaybackCoordinator } from "./playback-coordinator.js";
import { isPlaybackMode, playbackModes } from "./hud-protocol.js";
import type { SongInfo } from "./types.js";

const writeOperations = new Set([
  "playlist_create", "playlist_update", "playlist_track_add", "playlist_track_remove",
  "playlist_subscribe", "playlist_unsubscribe", "like", "unlike", "comment_add",
]);

type ServiceStatus = { running: boolean; detail?: string };
type EnsureService = (ctx: ActionContext) => Promise<ServiceStatus>;

function fail(message: string, reason: string, details?: Record<string, unknown>): ToolExecutionResult {
  return { result: message, status: "failed", details: { reason, ...details } };
}

function unknown(message: string, reason = "external_result_unconfirmed"): ToolExecutionResult {
  return { result: message, status: "unknown", details: { reason } };
}

function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "--:--";
  return `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
}

function isToolResult(value: object): value is ToolExecutionResult {
  return "status" in value;
}

export interface JukeboxApplicationDeps {
  readonly api: NeteaseApiClient;
  readonly gateway: NeteaseGateway;
  readonly playback: PlaybackCoordinator;
  readonly ensureService: EnsureService;
  readonly lyrics?: LiveLyricsTracker;
}

export class JukeboxApplication {
  readonly actions: Record<string, ActionDef>;
  private readonly searchRefs = new Map<string, SongInfo>();
  private readonly lyricsTracker: LiveLyricsTracker;

  constructor(private readonly deps: JukeboxApplicationDeps) {
    this.lyricsTracker = deps.lyrics ?? new LiveLyricsTracker(deps.api);
    this.actions = {
      search: this.action(
        "搜索歌曲并返回稳定的 ref=song:<网易云歌曲ID>，后续 play/queue 应直接使用该 ref；没有查询词不要调用。",
        { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20, default: 10, description: "返回条数上限。" } },
        ["query"],
        this.search.bind(this),
      ),
      play: this.action(
		"播放或入队歌曲；优先使用 search 返回的完整 ref=song:<歌曲ID>。返回受理/模拟阶段，不证明用户听见。",
        { ref: { type: "string" }, song_id: { type: "string" }, query: { type: "string" }, replace_queue: { type: "boolean" }, enqueue: { type: "boolean" } },
        [],
        this.play.bind(this),
      ),
      queue: this.action(
        "管理待播队列：add/list/remove/clear/move/shuffle；只在需要改变队列时使用。",
        { operation: { type: "string", enum: ["add", "list", "remove", "clear", "move", "shuffle"] }, ref: { type: "string" }, song_id: { type: "string" }, query: { type: "string" }, index: { type: "integer", minimum: 0, description: "remove 时：待移除的队列位置。" }, from: { type: "integer", minimum: 0, description: "move 时：原位置。" }, to: { type: "integer", minimum: 0, description: "move 时：目标位置。" } },
        ["operation"],
        this.queue.bind(this),
      ),
      playback: this.action(
        "控制播放、音量、播放模式或查询状态；status 只观察，其余操作会改变播放。",
        { operation: { type: "string", enum: ["pause", "resume", "stop", "next", "previous", "status", "mode", "volume"] }, mode: { type: "string", enum: [...playbackModes] }, level: { type: "number", minimum: 0, maximum: 100, description: "volume 时：音量百分比。" }, clear_queue: { type: "boolean" } },
        ["operation"],
        this.playbackAction.bind(this),
      ),
      lyrics: this.action(
        "查询歌曲完整歌词或当前歌词窗口；没有当前歌曲时返回可处理的失败。",
        { song_id: { type: "string" }, current: { type: "boolean" } },
        [],
        this.lyrics.bind(this),
      ),
      library: this.libraryAction(),
    };
  }

  private action(
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    run: (args: Record<string, unknown>, ctx: ActionContext) => Promise<string | ToolExecutionResult>,
  ): ActionDef {
    return { description, parameters: { type: "object", properties, required, additionalProperties: false }, run: this.guardedRun(run) };
  }

  /** 统一的字符串归一与上游错误包装；action 与 libraryAction 共用。 */
  private guardedRun(run: (args: Record<string, unknown>, ctx: ActionContext) => Promise<string | ToolExecutionResult>): ActionDef["run"] {
    return async (args, ctx) => {
      try {
        const result = await run(args, ctx);
        return typeof result === "string" ? worldSucceeded(result) : result;
      } catch (error) {
        if (error instanceof NeteaseRequestError) return this.requestFailure(error, ctx.operationIdentity);
        throw error;
      }
    };
  }

  /**
   * library 的 16 个 operation 拆成 per-op schema 分支：模型拿到"按操作的精确字段菜单"，
   * 非法组合在 Ajv 门前被拦，不再依赖 handler 散落的校验。confirm 不进 required——
   * 它是政策门（需用户明确要求），由 handler 的专用文案解释；schema 只管格式。
   */
  private libraryAction(): ActionDef {
    const fields: Record<string, Record<string, unknown>> = {
      uid: { type: "string", description: "目标用户 uid；缺省用登录账号。" },
      playlist_id: { type: "string", description: "歌单 ID。" },
      song_id: { type: "string", description: "歌曲 ID。" },
      ref: { type: "string", description: "search 返回的 ref=song:<歌曲ID>。" },
      query: { type: "string", description: "歌曲关键词；ref/song_id 都没有时用于搜索解析。" },
      name: { type: "string", description: "歌单名。" },
      description: { type: "string", description: "歌单描述。" },
      tags: { type: "string", description: "歌单标签。" },
      content: { type: "string", description: "评论内容。" },
      kind: { type: "string", enum: ["song", "playlist"], description: "目标类型。" },
      limit: { type: "integer", minimum: 1, description: "返回条数上限。" },
      privacy: { type: "string", enum: ["public", "private"], description: "新建歌单可见性。" },
    };
    const ops: Array<{ op: string; note: string; fields: string[]; require?: string[]; either?: [string, string] }> = [
      { op: "account_status", note: "查看账号与登录状态。", fields: [] },
      { op: "login_status", note: "查看登录状态。", fields: [] },
      { op: "playlist_list", note: "列出歌单；uid 缺省用登录账号。", fields: ["uid"] },
      { op: "liked_list", note: "列出红心歌曲；uid 缺省用登录账号。", fields: ["uid"] },
      { op: "recent_list", note: "列出最近播放。", fields: ["limit"] },
      { op: "playlist_open", note: "打开歌单详情。", fields: [], require: ["playlist_id"] },
      { op: "comments_list", note: "读评论；song_id 或 playlist_id 至少给一个。", fields: ["kind", "limit", "song_id", "playlist_id"], either: ["song_id", "playlist_id"] },
      { op: "playlist_create", note: "创建歌单。", fields: ["privacy"], require: ["name"] },
      { op: "playlist_update", note: "更新歌单名/描述/标签。", fields: ["name", "description", "tags"], require: ["playlist_id"] },
      { op: "playlist_track_add", note: "加歌曲进歌单；ref/song_id/query 三选一。", fields: ["ref", "song_id", "query"], require: ["playlist_id"] },
      { op: "playlist_track_remove", note: "从歌单移除歌曲；ref/song_id/query 三选一。", fields: ["ref", "song_id", "query"], require: ["playlist_id"] },
      { op: "playlist_subscribe", note: "收藏歌单。", fields: [], require: ["playlist_id"] },
      { op: "playlist_unsubscribe", note: "取消收藏歌单。", fields: [], require: ["playlist_id"] },
      { op: "like", note: "红心歌曲。", fields: [], require: ["song_id"] },
      { op: "unlike", note: "取消红心。", fields: [], require: ["song_id"] },
      { op: "comment_add", note: "发评论；song_id 或 playlist_id 至少给一个。", fields: ["kind", "song_id", "playlist_id"], require: ["content"], either: ["song_id", "playlist_id"] },
    ];
    const branches = ops.map(({ op, note, fields: optionalFields, require, either }): Record<string, unknown> => {
      const requireList = require ?? [];
      // strict Ajv 要求 required 中的每个字段都在 properties 里声明。
      const propKeys = [...new Set([...optionalFields, ...requireList])];
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: { type: "string", const: op, description: note },
          confirm: { type: "boolean", description: "写操作必须传 true；需用户明确要求。" },
          ...Object.fromEntries(propKeys.map((key) => [key, fields[key]])),
        },
        required: ["operation", ...requireList],
        ...(either ? { anyOf: either.map((key) => ({ required: [key], properties: { [key]: fields[key] } })) } : {}),
      };
    });
    return {
      description: "账号/歌单/收藏/评论操作；只有用户明确要求时使用，写操作需要 confirm=true 并核实返回结果。",
      // 顶层不能声明 type:"object"：world-tool 的 closeObjectSchema 会给它补 additionalProperties:false，
      // 与 oneOf 分支的属性声明冲突导致一切调用被拒。分支各自已闭合。
      parameters: { oneOf: branches },
      run: this.guardedRun((args, ctx) => this.library(args, ctx)),
    };
  }

  private requestFailure(error: NeteaseRequestError, stage: string): ToolExecutionResult {
    const retried = error.attempts > 1;
    let retryNote = "";
    if (error.retryable && retried) {
      retryNote = "（已自动重试一次仍失败，请停止本轮重复请求，稍后再试。）";
    } else if (error.retryable) {
      retryNote = "（瞬时故障未能在本次请求时限内恢复，请停止本轮重复请求，稍后再试。）";
    }
    return fail(
      `${error.message}${retryNote}`,
      "upstream_unavailable",
      {
        stage,
        ...(error.status === undefined ? {} : { httpStatus: error.status }),
        attempts: error.attempts,
        retryable: error.retryable,
        retryExhausted: retried && error.retryable,
      },
    );
  }

  private async requireService(ctx: ActionContext): Promise<ToolExecutionResult | null> {
    const service = await this.deps.ensureService(ctx);
    if (service.running) return null;
    return fail(service.detail ? `网易云数据服务不可用：${service.detail}` : "网易云数据服务不可用。", "service_unavailable");
  }

  private async search(args: Record<string, unknown>, ctx: ActionContext): Promise<string | ToolExecutionResult> {
    const unavailable = await this.requireService(ctx);
    if (unavailable) return unavailable;
    const query = String(args.query ?? "").trim();
    if (!query) return fail("缺少搜索关键词。", "invalid_query");
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const songs = await this.deps.api.searchSongs(query, limit, ctx.signal);
    songs.forEach((song) => this.searchRefs.set(`song:${song.id}`, song));
    return songs.length
      ? songs.map((song, index) => `${index + 1}. ref=song:${song.id} ${song.name} - ${song.artists.join(", ")} (${formatMs(song.durationMs)})`).join("\n")
      : `未找到与“${query}”相关的歌曲。`;
  }

  /**
   * 曲目解析的唯一策略所有者：ref → song_id → query 的优先级和各自的失败原因都在这里，
   * 调用方只区分"拿到歌"与"拿到现成的失败结果"。不伪造占位歌曲——查不到就如实失败，
   * 否则"歌曲不存在"会被下游误报成"VIP/版权限制"，甚至拿假 ID 发起歌单写操作。
   */
  private async resolveSong(args: Record<string, unknown>, ctx: ActionContext): Promise<SongInfo | ToolExecutionResult> {
    const ref = String(args.ref ?? "").trim();
    if (ref) {
      const song = this.searchRefs.get(ref);
      return song ?? fail(`歌曲 ref “${ref}” 不存在；请使用最近搜索结果中完整的 ref=song:<歌曲ID>。`, "invalid_ref");
    }
    const id = String(args.song_id ?? "").trim();
    if (id) {
      try {
        return (await this.deps.api.getSongInfo(id, ctx.signal)) ?? fail(`歌曲 #${id} 不存在。`, "song_not_found");
      } catch (error) {
        if (error instanceof NeteaseRequestError) return this.requestFailure(error, "song_detail");
        throw error;
      }
    }
    const query = String(args.query ?? "").trim();
    if (!query) return fail("必须提供 song_id、ref 或 query。", "invalid_song");
    try {
      const song = (await this.deps.api.searchSongs(query, 5, ctx.signal))[0];
      return song ?? fail(`未找到与“${query}”相关的歌曲。`, "song_not_found");
    } catch (error) {
      if (error instanceof NeteaseRequestError) return this.requestFailure(error, "song_search");
      throw error;
    }
  }

  private async play(args: Record<string, unknown>, ctx: ActionContext): Promise<string | ToolExecutionResult> {
    const unavailable = await this.requireService(ctx);
    if (unavailable) return unavailable;
    const song = await this.resolveSong(args, ctx);
    if (isToolResult(song)) return song;
    if (args.enqueue === true) {
      if (args.replace_queue === true) this.deps.playback.clear();
      this.deps.playback.add(song);
      return `已加入队列：${song.name}`;
    }
    try {
      await this.deps.playback.loadSong(song, ctx.signal);
    } catch (error) {
      if (error instanceof NeteaseRequestError) return this.requestFailure(error, "playback_url");
      return fail(`无法播放“${song.name}”：${error instanceof Error ? error.message : String(error)}`, "playback_failed");
    }
    if (args.replace_queue === true) this.deps.playback.clear();
    return worldSucceeded(
      `正在播放：${song.name} - ${song.artists.join(", ")}${this.deps.playback.isSimulated ? "（模拟模式，无实际声音）" : ""}`,
      { songId: song.id },
      this.deps.playback.isSimulated ? "simulated" : "accepted",
    );
  }

  private async queue(args: Record<string, unknown>, ctx: ActionContext): Promise<string | ToolExecutionResult> {
    const operation = String(args.operation);
    switch (operation) {
      case "list": {
        const queue = this.deps.playback.snapshot().queue;
        return queue.map((song, index) => `${index}: ${song.name} - ${song.artists.join(", ")}`).join("\n") || "播放队列为空。";
      }
      case "clear":
        this.deps.playback.clear();
        return "已清空播放队列。";
      case "remove": {
        const removed = this.deps.playback.remove(Number(args.index));
        return removed ? `已移除：${removed.name}` : fail("队列索引无效。", "invalid_index");
      }
      case "move":
        return this.deps.playback.move(Number(args.from), Number(args.to)) ? "已调整队列顺序。" : fail("队列索引无效。", "invalid_index");
      case "shuffle":
        this.deps.playback.shuffle();
        return "已随机打乱队列。";
      case "add":
        break;
      default:
        return fail("未知队列操作。", "invalid_operation");
    }
    const unavailable = await this.requireService(ctx);
    if (unavailable) return unavailable;
    const song = await this.resolveSong(args, ctx);
    if (isToolResult(song)) return song;
    this.deps.playback.add(song);
    return `已加入队列：${song.name}`;
  }

  private async playbackAction(args: Record<string, unknown>, ctx: ActionContext): Promise<string | ToolExecutionResult> {
    const operation = String(args.operation);
    if (operation === "status") { const state = await this.deps.playback.progress().then(() => this.deps.playback.snapshot()); return `状态：${state.status}\n当前：${state.currentSong?.name ?? "无"}\n音量：${state.volume}%\n队列：${state.queue.length}`; }
    if (operation === "pause") { await this.deps.playback.pause(); return "已暂停播放。"; }
    if (operation === "resume") {
      await this.deps.playback.resume();
      const state = this.deps.playback.snapshot();
      if (state.status === "playing" && state.currentSong) return `已恢复播放：${state.currentSong.name}。`;
      if (state.queue.length > 0) return fail(`未能恢复播放：仍有 ${state.queue.length} 首待播，但当前无在播曲目。`, "resume_not_available");
      return "无需恢复：没有在播曲目或待播队列。";
    }
    if (operation === "stop") { await this.deps.playback.stop(args.clear_queue === true); return "已停止播放。"; }
    if (operation === "mode") { const mode = args.mode; if (!isPlaybackMode(mode)) return fail("播放模式无效。", "invalid_mode"); this.deps.playback.setMode(mode); return `播放模式已设为 ${mode}。`; }
    if (operation === "volume") { const level = Number(args.level); if (!Number.isFinite(level) || level < 0 || level > 100) return fail("音量必须是 0 到 100。", "invalid_volume"); await this.deps.playback.setVolume(level); return `音量已设置为 ${this.deps.playback.volume}%。`; }
    if (operation === "next") return this.switchTrack(() => this.deps.playback.playNext(ctx.signal), "下一首", "队列为空。");
    if (operation === "previous") {
      try {
        const outcome = await this.deps.playback.previous(ctx.signal);
        if (!outcome) return fail("没有可返回的上一首。", "not_available");
        return outcome.restarted ? `已回到歌曲开头：${outcome.song.name}。` : `已切换到上一首：${outcome.song.name}。`;
      } catch (error) {
        return fail(`无法播放上一首：${error instanceof Error ? error.message : String(error)}`, "playback_failed");
      }
    }
    return fail("未知播放操作。", "invalid_operation");
  }

  private async switchTrack(load: () => Promise<SongInfo | null>, label: string, emptyReason: string): Promise<string | ToolExecutionResult> {
    try {
      const song = await load();
      return song ? `已切换到${label}：${song.name}。` : fail(emptyReason, "not_available");
    }
    catch (error) { return fail(`无法播放${label}：${error instanceof Error ? error.message : String(error)}`, "playback_failed"); }
  }

  private async lyrics(args: Record<string, unknown>, ctx: ActionContext): Promise<string | ToolExecutionResult> {
    const unavailable = await this.requireService(ctx);
    if (unavailable) return unavailable;
    const song = String(args.song_id ?? "").trim() ? await this.deps.api.getSongInfo(String(args.song_id), ctx.signal) : this.deps.playback.snapshot().currentSong;
    if (!song) return fail("当前没有可查询的歌曲。", "no_current_song");
    const lines = await this.lyricsTracker.getLines(song, ctx.signal);
    if (!lines.length) return `${song.name}\n该歌曲没有可用歌词。`;
    if (args.current === true) {
      const position = (await this.deps.playback.progress()).positionMs;
      const window = this.lyricsTracker.windowFor(song.id, lines, position);
      return `当前歌曲：${song.name} - ${song.artists.join(", ")}\n${[window.previous, window.current, window.next].filter(Boolean).join("\n")}`;
    }
    return `${song.name} - ${song.artists.join(", ")}\n\n${formatLyrics(lines)}`;
  }

  private async library(args: Record<string, unknown>, ctx: ActionContext): Promise<string | ToolExecutionResult> {
    const operation = String(args.operation);
    if (writeOperations.has(operation) && args.confirm !== true) return fail("该账号操作需要 confirm=true。", "confirmation_required");
    const unavailable = await this.requireService(ctx);
    if (unavailable) return unavailable;
    const account = await this.deps.gateway.accountStatus(ctx.signal);
    const accountObject = account as Record<string, unknown>;
    const profile = accountObject.profile as Record<string, unknown> | undefined;
    const accountInfo = accountObject.account as Record<string, unknown> | undefined;
    const uid = String(args.uid ?? profile?.userId ?? accountInfo?.id ?? "");
    if (["account_status", "login_status"].includes(operation)) return JSON.stringify(account);
    if (operation === "playlist_list") { if (!uid) return fail("未能确定登录账号 uid。", "login_required"); return JSON.stringify(await this.deps.gateway.playlists(uid, ctx.signal)); }
    if (operation === "playlist_open") return JSON.stringify(await this.deps.gateway.playlist(String(args.playlist_id), ctx.signal));
    if (operation === "liked_list") { if (!uid) return fail("未能确定登录账号 uid。", "login_required"); return JSON.stringify(await this.deps.gateway.likedSongs(uid, ctx.signal)); }
    if (operation === "recent_list") return JSON.stringify(await this.deps.gateway.recentSongs(Number(args.limit ?? 20), ctx.signal));
    if (operation === "comments_list") return JSON.stringify(await this.deps.gateway.comments(args.kind === "playlist" ? "playlist" : "song", String(args.song_id ?? args.playlist_id), Number(args.limit ?? 20), ctx.signal));
    if (operation === "playlist_create") return JSON.stringify(await this.deps.gateway.createPlaylist(String(args.name ?? ""), args.privacy === "private" ? "private" : "public", ctx.signal));
    if (operation === "playlist_update") return this.updatePlaylist(args, uid, ctx);
    if (operation === "playlist_track_add" || operation === "playlist_track_remove") return this.changePlaylistTrack(operation, args, uid, ctx);
    if (operation === "playlist_subscribe" || operation === "playlist_unsubscribe") return JSON.stringify(await this.deps.gateway.subscribePlaylist(String(args.playlist_id), operation === "playlist_subscribe", ctx.signal));
    if (operation === "like" || operation === "unlike") return JSON.stringify(await this.deps.gateway.like(String(args.song_id), operation === "like", ctx.signal));
    if (operation === "comment_add") return JSON.stringify(await this.deps.gateway.comment(args.kind === "playlist" ? "playlist" : "song", String(args.song_id ?? args.playlist_id), String(args.content ?? ""), ctx.signal));
    return fail(`账号库操作“${operation}”暂未接入。`, "not_implemented");
  }

  private async requireEditablePlaylist(id: string, uid: string, ctx: ActionContext): Promise<EditablePlaylist | ToolExecutionResult> {
    if (!uid) return fail("未能确定登录账号 uid。", "login_required");
    const playlist = await this.deps.gateway.playlistForWrite(id, ctx.signal);
    if (!playlist) return fail("未能读取目标歌单，无法执行账号写操作。", "playlist_not_found");
    if (playlist.ownerId !== uid && !playlist.editable) return fail(`目标歌单不可编辑：${playlist.name}。`, "playlist_not_editable");
    return playlist;
  }

  private async changePlaylistTrack(operation: string, args: Record<string, unknown>, uid: string, ctx: ActionContext): Promise<ToolExecutionResult> {
    const playlistId = String(args.playlist_id ?? "").trim();
    if (!playlistId) return fail("目标歌单 ID 无效。", "invalid_playlist");
    const before = await this.requireEditablePlaylist(playlistId, uid, ctx);
    if (isToolResult(before)) return before;
    const song = await this.resolveSong(args, ctx);
    if (isToolResult(song)) return song;
    if (operation === "playlist_track_add") await this.deps.gateway.addToPlaylist(playlistId, song.id, ctx.signal);
    else await this.deps.gateway.removeFromPlaylist(playlistId, song.id, ctx.signal);
    const after = await this.deps.gateway.playlistForWrite(playlistId, ctx.signal);
    const verified = after?.trackIds;
    if (!verified) return unknown("歌单写操作已发出，但无法确认最终歌单状态。");
    const contains = verified.includes(song.id);
    const expected = operation === "playlist_track_add";
    if (contains !== expected) return unknown("歌单写操作已发出，但网易云返回的歌单状态未达到预期。");
    return { result: `${expected ? "已加入歌单" : "已从歌单移除"}：${song.name}。`, status: "succeeded", details: { playlistId, songId: song.id } };
  }

  private async updatePlaylist(args: Record<string, unknown>, uid: string, ctx: ActionContext): Promise<ToolExecutionResult> {
    const playlistId = String(args.playlist_id ?? "").trim();
    const target = await this.requireEditablePlaylist(playlistId, uid, ctx);
    if (isToolResult(target)) return target;
    await this.deps.gateway.updatePlaylist(playlistId, typeof args.name === "string" ? args.name : undefined, typeof args.description === "string" ? args.description : undefined, typeof args.tags === "string" ? args.tags : undefined, ctx.signal);
    return { result: `已更新歌单信息：${target.name}。`, status: "succeeded", details: { playlistId } };
  }
}
