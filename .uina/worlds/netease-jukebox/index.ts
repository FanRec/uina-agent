import type { WorldDef, ActionContext } from "../../../src/extensions/world-framework/types.js";
import { NeteaseApiClient } from "./api-client.js";
import { loadJukeboxConfig } from "./config.js";
import { SimulatedMusicPlayer, UnavailableMusicPlayer, MpvPlayer, resolveMpvPath, type MusicPlayer } from "./player.js";
import { PlaybackSession } from "./playback-session.js";
import { CompanionManager } from "./companion.js";
import { formatLyrics, parseLrc, type LyricLine } from "./lyrics.js";
import type { JukeboxWorldConfig, SongInfo } from "./types.js";

function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) {
    return "--:--";
  }
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function songLabel(song: Pick<SongInfo, "name" | "artists">): string {
  return `${song.name}${song.artists.length ? ` - ${song.artists.join(", ")}` : ""}`;
}

export function createJukeboxWorld(config?: JukeboxWorldConfig): WorldDef {
  const mergedConfig = { ...loadJukeboxConfig(), ...config };
  const apiClient = new NeteaseApiClient(mergedConfig.apiBaseUrl ?? "http://localhost:3000");
  const companionManager = new CompanionManager(
    mergedConfig.apiEnhancedDir ?? "E:\\Uina\\ThirdParty\\api-enhanced",
    mergedConfig.apiPort ?? 3000,
  );

  const mpvPath = resolveMpvPath(mergedConfig.mpvPath);
  const player: MusicPlayer = mergedConfig.simulation
    ? new SimulatedMusicPlayer()
    : mpvPath
      ? new MpvPlayer(mpvPath)
      : new UnavailableMusicPlayer();

  const playback = new PlaybackSession(player);
  const lyricCache = new Map<string, readonly LyricLine[] | null>();

  async function loadLyrics(songId: string, signal: AbortSignal): Promise<readonly LyricLine[] | null> {
    const cached = lyricCache.get(songId);
    if (cached !== undefined) return cached;
    const raw = await apiClient.getLyrics(songId, signal);
    const parsed = raw === null ? null : parseLrc(raw);
    lyricCache.set(songId, parsed);
    return parsed;
  }

  return {
    name: "jukebox",
    description: "网易云音乐点歌机，支持歌曲搜索、点播播放、音量控制和状态查询",
    defaultState: {
      enabled: true,
    },

    async onStart(): Promise<void> {},

    async onStop(): Promise<void> {
      try {
        await playback.stop();
      } finally {
        try {
          await playback.close();
        } finally {
          await companionManager.stop();
        }
      }
    },
    actions: {
      play: {
        description: "播放指定歌曲，支持通过关键词搜索播放或直接指定 song_id",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词（如歌名、歌手）" },
            song_id: { type: "string", description: "网易云音乐歌曲 ID（支持数字或数字字符串）" },
          },
        },
        async run(args: Record<string, unknown>, ctx: ActionContext) {
          const service = await companionManager.ensureRunning(apiClient, 10000, ctx.signal);
          if (!service.running) {
            return { result: "网易云伴生服务不可用。", status: "failed", details: { reason: "service_unavailable" } };
          }

          const rawId = args.song_id ?? args.id ?? args.songId ?? args.music_id;
          const rawQuery = args.query ?? args.keyword ?? args.keywords ?? args.song ?? args.name ?? args.q;

          let songToPlay: SongInfo | null = null;

          if (rawId !== undefined && String(rawId).trim()) {
            const id = String(rawId).trim();
            songToPlay = {
              id,
              name: `歌曲 #${id}`,
              artists: ["未知歌手"],
              durationMs: null,
            };
          } else if (typeof rawQuery === "string" && rawQuery.trim()) {
            const results = await apiClient.searchSongs(rawQuery.trim(), 5, ctx.signal);
            if (results.length === 0) {
              return `未搜索到关于 "${rawQuery}" 的歌曲`;
            }
            songToPlay = results[0];
          } else {
            return "参数错误：必须提供搜索关键词或歌曲ID。例如 { query: 'World is Mine' } 或 { song_id: '22677570' }。";
          }

          const playUrl = await apiClient.getSongUrl(songToPlay.id, ctx.signal);
          if (!playUrl) {
            if (playback.isSimulated) {
              await playback.load("simulated://stream", songToPlay);
              return `正在模拟播放: ${songToPlay.name} - ${songToPlay.artists.join(", ")} (⚠️ 提示: 未获取到音频流且处于模拟模式，无实际声音)`;
            }
            return {
              result: `无法获取歌曲 "${songToPlay.name}" (ID: ${songToPlay.id}) 的播放音频流`,
              status: "failed",
              details: { reason: "audio_url_unavailable" },
            };
          }

          await playback.load(playUrl, songToPlay);
          const simNotice = playback.availability === "simulation"
            ? " (⚠️ 提示: 本地未检测到 mpv 播放器，处于静音模拟模式，无实际声音输出)"
            : "";
          return `正在播放: ${songToPlay.name} - ${songToPlay.artists.join(", ")}${simNotice}`;
        },
      },

      pause: {
        description: "暂停当前播放",
        parameters: { type: "object", properties: {} },
        async run() {
          if (playback.status !== "playing") {
            return "当前未在播放";
          }
          await playback.pause();
          return "已暂停播放";
        },
      },

      resume: {
        description: "恢复播放",
        parameters: { type: "object", properties: {} },
        async run() {
          if (playback.status !== "paused") {
            return "当前未处于暂停状态";
          }
          await playback.resume();
          return "已恢复播放";
        },
      },

      stop: {
        description: "停止播放",
        parameters: { type: "object", properties: {} },
        async run(_args) {
          await playback.stop();
          return "已停止播放";
        },
      },

      volume: {
        description: "调整播放音量 (0 - 100)。留空 params 时查询当前音量",
        parameters: {
          type: "object",
          properties: {
            level: { type: "number", description: "音量百分比 (0 - 100)" },
          },
        },
        async run(args: Record<string, unknown>) {
          const raw = args.level ?? args.volume ?? args.value ?? args.percent;
          if (raw === undefined) {
            return `当前音量: ${playback.volume}%。如需调整请输入 { level: 0-100 }。`;
          }

          const level = typeof raw === "number" ? raw : Number(raw);
          if (isNaN(level) || level < 0 || level > 100) {
            return "参数错误：音量必须是 0 到 100 之间的数字。例如 { level: 80 }。";
          }
          await playback.setVolume(level);
          return `音量已设置为 ${playback.volume}%`;
        },
      },

      search: {
        description: "搜索网易云音乐歌曲",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词（歌名、歌手）" },
            limit: { type: "number", description: "返回数量（默认 10）" },
          },
          required: ["query"],
        },
        async run(args: Record<string, unknown>, ctx: ActionContext) {
          const service = await companionManager.ensureRunning(apiClient, 10000, ctx.signal);
          if (!service.running) {
            return { result: "网易云伴生服务不可用。", status: "failed", details: { reason: "service_unavailable" } };
          }
          const raw = args.query ?? args.keyword ?? args.keywords ?? args.song ?? args.name ?? args.q;
          const query = String(raw ?? "").trim();
          if (!query) {
            return "参数错误：缺少搜索关键词。请传入 { query: '歌名' }（也支持 keyword 或 q）。";
          }
          const limit = typeof args.limit === "number" ? args.limit : 10;
          const songs = await apiClient.searchSongs(query, limit, ctx.signal);
          if (songs.length === 0) {
            return `未找到与 "${query}" 相关的歌曲`;
          }
          const lines = [`找到 ${songs.length} 首关于 "${query}" 的歌曲:`];
          for (let i = 0; i < songs.length; i++) {
            const s = songs[i];
            lines.push(`${i + 1}. [${s.id}] ${s.name} - ${s.artists.join(", ")} (${formatMs(s.durationMs)})`);
          }
          lines.push("\n提示：可使用 { action: \"play\", params: { song_id: \"ID\" } } 直接播放。");
          return lines.join("\n");
        },
      },

      lyrics: {
        description: "查询指定歌曲或当前播放歌曲的完整歌词。",
        parameters: {
          type: "object",
          properties: {
            song_id: { type: "string", description: "网易云音乐歌曲 ID；不传则查询当前歌曲。" },
          },
        },
        async run(args: Record<string, unknown>, ctx: ActionContext) {
          const service = await companionManager.ensureRunning(apiClient, 10000, ctx.signal);
          if (!service.running) return { result: "网易云伴生服务不可用。", status: "failed", details: { reason: "service_unavailable" } };
          const requestedId = String(args.song_id ?? args.id ?? "").trim();
          const current = playback.snapshot().currentSong;
          if (!requestedId && !current) return { result: "当前没有正在播放的歌曲，无法查询歌词。", status: "failed", details: { reason: "no_current_song" } };
          const song = requestedId ? await apiClient.getSongInfo(requestedId, ctx.signal) : current;
          if (!song) return { result: "当前没有正在播放的歌曲，无法查询歌词。", status: "failed", details: { reason: "no_current_song" } };
          const lines = await loadLyrics(song.id, ctx.signal);
          const title = `歌曲：${songLabel(song)}`;
          if (!lines || lines.length === 0) return `${title}\n该歌曲没有可用歌词。`;
          return `${title}\n\n${formatLyrics(lines)}`;
        },
      },

      current_lyrics: {
        description: "查询当前播放位置的歌词和附近几行。",
        parameters: { type: "object", properties: {} },
        async run(_args: Record<string, unknown>, ctx: ActionContext) {
          const song = playback.snapshot().currentSong;
          if (!song) return { result: "当前没有正在播放的歌曲，无法查询当前歌词。", status: "failed", details: { reason: "no_current_song" } };
          const service = await companionManager.ensureRunning(apiClient, 10000, ctx.signal);
          if (!service.running) return { result: "网易云伴生服务不可用。", status: "failed", details: { reason: "service_unavailable" } };
          let progress;
          try {
            progress = await playback.progress();
          } catch (error) {
            return { result: `无法确认当前歌词位置：${error instanceof Error ? error.message : String(error)}`, status: "failed", details: { reason: "progress_unavailable" } };
          }
          const lines = await loadLyrics(song.id, ctx.signal);
          const output = [`当前歌曲：${songLabel(song)}`, `播放位置：${formatMs(progress.positionMs)}`, ""];
          if (!lines || lines.length === 0) {
            output.push("该歌曲没有可用歌词。");
            return output.join("\n");
          }
          const currentIndex = lines.findLastIndex((line) => line.timeMs <= progress.positionMs);
          if (currentIndex < 0) {
            output.push("当前句：尚未开始", "", `下一句：${lines[0]!.text}`);
            return output.join("\n");
          }
          for (let index = Math.max(0, currentIndex - 2); index <= Math.min(lines.length - 1, currentIndex + 2); index++) {
            const label = index === currentIndex ? "当前句" : index < currentIndex ? "上一句" : "下一句";
            output.push(`${label}：${lines[index]!.text}`);
          }
          return output.join("\n");
        },
      },

      status: {
        description: "查看当前播放状态、当前曲目、播放进度和音量",
        parameters: { type: "object", properties: {} },
        async run(_args) {
          const snapshot = playback.snapshot();
          const progress = await playback.progress();
          const currentPos = formatMs(progress.positionMs);
          const currentDur = formatMs(progress.durationMs);
          const lines = [
            `状态: ${snapshot.status === "playing" ? "▶ 播放中" : snapshot.status === "paused" ? "⏸ 已暂停" : "⏹ 空闲"}`,
            `播放内核: ${snapshot.availability === "simulation" ? "⚠️ 静音模拟器 (未找到 mpv，无声音输出)" : snapshot.availability === "real" ? "🔊 MPV 硬件解码音频输出" : "播放器不可用"}`,
            `音量: ${snapshot.volume}%`,
          ];
          if (snapshot.lastError) lines.push(`错误: ${snapshot.lastError}`);
          if (snapshot.currentSong) {
            lines.push(`当前曲目: ${snapshot.currentSong.name} - ${snapshot.currentSong.artists.join(", ")}`);
            lines.push(`专辑: ${snapshot.currentSong.album ?? "无"}`);
            lines.push(`进度: ${currentPos} / ${currentDur}`);
          } else {
            lines.push("当前曲目: 无");
          }
          return lines.join("\n");
        },
      },
    },
  };
}

export default createJukeboxWorld();
