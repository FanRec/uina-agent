import type { ActionContext, ActionDef } from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import type { NeteaseApiClient } from "./api-client.js";
import { formatLyrics, parseLrc, type LyricLine } from "./lyrics.js";
import type { NeteaseGateway, EditablePlaylist } from "./netease-gateway.js";
import type { PlaybackCoordinator } from "./playback-coordinator.js";
import type { PlaybackMode } from "./hud-protocol.js";
import type { SongInfo } from "./types.js";

const modes = ["single_once", "queue_order", "list_order", "list_loop", "single_loop", "shuffle"] as const;
const writeOperations = new Set([
  "playlist_create", "playlist_update", "playlist_track_add", "playlist_track_remove",
  "playlist_subscribe", "playlist_unsubscribe", "like", "unlike", "comment_add",
]);

type ServiceStatus = { running: boolean };
type EnsureService = (ctx: ActionContext) => Promise<ServiceStatus>;

function fail(message: string, reason: string): ToolExecutionResult {
  return { result: message, status: "failed", details: { reason } };
}

function unknown(message: string, reason = "external_result_unconfirmed"): ToolExecutionResult {
  return { result: message, status: "unknown", details: { reason } };
}

function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "--:--";
  return `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
}

function isToolResult(value: EditablePlaylist | ToolExecutionResult): value is ToolExecutionResult {
  return "status" in value;
}

export interface JukeboxApplicationDeps {
  readonly api: NeteaseApiClient;
  readonly gateway: NeteaseGateway;
  readonly playback: PlaybackCoordinator;
  readonly ensureService: EnsureService;
}

export class JukeboxApplication {
  readonly actions: Record<string, ActionDef>;
  private readonly searchRefs = new Map<string, SongInfo>();
  private lyricLines: readonly LyricLine[] | null = null;
  private lyricSongId: string | null = null;

  constructor(private readonly deps: JukeboxApplicationDeps) {
    this.actions = {
      search: this.action(
        "搜索歌曲并返回可引用结果",
        { query: { type: "string" }, limit: { type: "number" } },
        ["query"],
        this.search.bind(this),
      ),
      play: this.action(
        "立即播放歌曲；默认保留待播队列",
        { ref: { type: "string" }, song_id: { type: "string" }, query: { type: "string" }, replace_queue: { type: "boolean" }, enqueue: { type: "boolean" } },
        [],
        this.play.bind(this),
      ),
      queue: this.action(
        "管理待播队列：add、list、remove、clear、move、shuffle",
        { operation: { type: "string", enum: ["add", "list", "remove", "clear", "move", "shuffle"] }, ref: { type: "string" }, song_id: { type: "string" }, query: { type: "string" }, index: { type: "number" }, from: { type: "number" }, to: { type: "number" } },
        ["operation"],
        this.queue.bind(this),
      ),
      playback: this.action(
        "控制播放、音量、播放模式或查询状态",
        { operation: { type: "string", enum: ["pause", "resume", "stop", "next", "previous", "status", "mode", "volume"] }, mode: { type: "string", enum: [...modes] }, level: { type: "number" }, clear_queue: { type: "boolean" } },
        ["operation"],
        this.playbackAction.bind(this),
      ),
      lyrics: this.action(
        "查询完整歌词或当前歌词窗口",
        { song_id: { type: "string" }, current: { type: "boolean" } },
        [],
        this.lyrics.bind(this),
      ),
      current_lyrics: this.action(
        "兼容旧调用：查询当前歌词窗口，请优先使用 lyrics(current=true)",
        {},
        [],
        (args, ctx) => this.lyrics({ ...args, current: true }, ctx),
      ),
      library: this.action("网易云账号、歌单、收藏和评论操作；写操作需要 confirm=true", {
        operation: { type: "string", enum: ["account_status", "login_status", "playlist_list", "playlist_open", "playlist_create", "playlist_update", "playlist_track_add", "playlist_track_remove", "playlist_subscribe", "playlist_unsubscribe", "liked_list", "like", "unlike", "recent_list", "comments_list", "comment_add"] },
        uid: { type: "string" }, playlist_id: { type: "string" }, song_id: { type: "string" }, ref: { type: "string" },
        name: { type: "string" }, description: { type: "string" }, tags: { type: "string" }, content: { type: "string" },
        kind: { type: "string", enum: ["song", "playlist"] }, limit: { type: "number" }, confirm: { type: "boolean" },
        privacy: { type: "string", enum: ["public", "private"] },
      }, ["operation"], this.library.bind(this)),
    };
  }

  private action(
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    run: (args: Record<string, unknown>, ctx: ActionContext) => Promise<string | ToolExecutionResult>,
  ): ActionDef {
    return { description, parameters: { type: "object", properties, ...(required.length ? { required } : {}) }, run };
  }

  private async requireService(ctx: ActionContext): Promise<ToolExecutionResult | null> {
    const service = await this.deps.ensureService(ctx);
    return service.running ? null : fail("网易云数据服务不可用。", "service_unavailable");
  }

  private async search(args: Record<string, unknown>, ctx: ActionContext): Promise<string | ToolExecutionResult> {
    const unavailable = await this.requireService(ctx);
    if (unavailable) return unavailable;
    const query = String(args.query ?? "").trim();
    if (!query) return fail("缺少搜索关键词。", "invalid_query");
    const limit = Math.min(20, Math.max(1, Number(args.limit ?? 10)));
    const songs = await this.deps.api.searchSongs(query, limit, ctx.signal);
    songs.forEach((song, index) => this.searchRefs.set(`search:${index}`, song));
    return songs.length
      ? songs.map((song, index) => `${index + 1}. ref=search:${index} id=${song.id} ${song.name} - ${song.artists.join(", ")} (${formatMs(song.durationMs)})`).join("\n")
      : `未找到与“${query}”相关的歌曲。`;
  }

  private async resolveSong(args: Record<string, unknown>, ctx: ActionContext): Promise<SongInfo | null> {
    const ref = String(args.ref ?? "").trim();
    if (ref) return this.searchRefs.get(ref) ?? null;
    const id = String(args.song_id ?? args.id ?? "").trim();
    if (id) return (await this.deps.api.getSongInfo(id, ctx.signal)) ?? { id, name: `歌曲 #${id}`, artists: ["未知歌手"], durationMs: null };
    const query = String(args.query ?? args.keyword ?? "").trim();
    return query ? (await this.deps.api.searchSongs(query, 5, ctx.signal))[0] ?? null : null;
  }

  private async play(args: Record<string, unknown>, ctx: ActionContext): Promise<string | ToolExecutionResult> {
    const unavailable = await this.requireService(ctx);
    if (unavailable) return unavailable;
    const song = await this.resolveSong(args, ctx);
    if (!song) return fail("必须提供 song_id、ref 或 query。", "invalid_song");
    if (args.replace_queue === true) this.deps.playback.clear();
    if (args.enqueue === true) {
      this.deps.playback.add(song);
      return `已加入队列：${song.name}`;
    }
    const url = await this.deps.api.getSongUrl(song.id, ctx.signal);
    if (!url && !this.deps.playback.isSimulated) return fail(`无法获取“${song.name}”的播放地址。`, "audio_url_unavailable");
    await this.deps.playback.load(url ?? "simulated://stream", song);
    return `正在播放：${song.name} - ${song.artists.join(", ")}${this.deps.playback.isSimulated ? "（模拟模式，无实际声音）" : ""}`;
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
    if (!song) return fail("必须提供 song_id、ref 或 query。", "invalid_song");
    this.deps.playback.add(song);
    return `已加入队列：${song.name}`;
  }

  private async playbackAction(args: Record<string, unknown>, ctx: ActionContext): Promise<string | ToolExecutionResult> {
    const operation = String(args.operation);
    if (operation === "status") { const state = await this.deps.playback.progress().then(() => this.deps.playback.snapshot()); return `状态：${state.status}\n当前：${state.currentSong?.name ?? "无"}\n音量：${state.volume}%\n队列：${state.queue.length}`; }
    if (operation === "pause") { await this.deps.playback.pause(); return "已暂停播放。"; }
    if (operation === "resume") { await this.deps.playback.resume(); return "已恢复播放。"; }
    if (operation === "stop") { await this.deps.playback.stop(args.clear_queue === true); return "已停止播放。"; }
    if (operation === "mode") { const mode = String(args.mode); if (!(modes as readonly string[]).includes(mode)) return fail("播放模式无效。", "invalid_mode"); this.deps.playback.setMode(mode as PlaybackMode); return `播放模式已设为 ${mode}。`; }
    if (operation === "volume") { const level = Number(args.level); if (!Number.isFinite(level) || level < 0 || level > 100) return fail("音量必须是 0 到 100。", "invalid_volume"); await this.deps.playback.setVolume(level); return `音量已设置为 ${this.deps.playback.volume}%。`; }
    if (operation === "next") return this.switchTrack(() => this.deps.playback.playNext(ctx.signal), "下一首");
    if (operation === "previous") return this.switchTrack(() => this.deps.playback.playPrevious(ctx.signal), "上一首");
    return fail("未知播放操作。", "invalid_operation");
  }

  private async switchTrack(load: () => Promise<SongInfo | null>, label: string): Promise<string | ToolExecutionResult> {
    try {
      const song = await load();
      if (song) return `已切换到${label}：${song.name}。`;
      if (label === "下一首") return "队列为空。";
      return fail("没有可返回的上一首。", "not_available");
    }
    catch (error) { return fail(`无法播放${label}：${error instanceof Error ? error.message : String(error)}`, "playback_failed"); }
  }

  private async lyrics(args: Record<string, unknown>, ctx: ActionContext): Promise<string | ToolExecutionResult> {
    const unavailable = await this.requireService(ctx);
    if (unavailable) return unavailable;
    const song = String(args.song_id ?? "").trim() ? await this.deps.api.getSongInfo(String(args.song_id), ctx.signal) : this.deps.playback.snapshot().currentSong;
    if (!song) return fail("当前没有可查询的歌曲。", "no_current_song");
    if (!this.lyricLines || this.lyricSongId !== song.id) { const raw = await this.deps.api.getLyrics(song.id, ctx.signal); this.lyricLines = raw ? parseLrc(raw) : null; this.lyricSongId = song.id; }
    if (!this.lyricLines?.length) return `${song.name}\n该歌曲没有可用歌词。`;
    if (args.current === true) { const position = (await this.deps.playback.progress()).positionMs; const index = this.lyricLines.findLastIndex(line => line.timeMs <= position); return `当前歌曲：${song.name} - ${song.artists.join(", ")}\n${this.lyricLines.slice(Math.max(0, index - 1), index + 2).map(line => line.text).join("\n")}`; }
    return `${song.name} - ${song.artists.join(", ")}\n\n${formatLyrics(this.lyricLines)}`;
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
    if (!song) return fail("必须提供有效的 song_id 或搜索 ref。", "invalid_song");
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
