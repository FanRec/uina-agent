import type { AppDef, ActionContext } from "../../../src/extensions/app-framework/types.js";
import { NeteaseApiClient } from "./api-client.js";
import { loadJukeboxConfig } from "./config.js";
import { SimulatedMusicPlayer, MpvPlayer, resolveMpvPath, type MusicPlayer } from "./player.js";
import { CompanionManager } from "./companion.js";
import type { JukeboxState, JukeboxAppConfig, SongInfo } from "./types.js";

function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) {
    return "--:--";
  }
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function createJukeboxApp(config?: JukeboxAppConfig): AppDef {
  const mergedConfig = { ...loadJukeboxConfig(), ...config };
  const apiClient = new NeteaseApiClient(mergedConfig.apiBaseUrl ?? "http://localhost:3000");
  const companionManager = new CompanionManager(
    mergedConfig.apiEnhancedDir ?? "E:\\Uina\\ThirdParty\\api-enhanced",
    3000,
  );

  const mpvPath = resolveMpvPath(mergedConfig.mpvPath);
  const player: MusicPlayer = mpvPath ? new MpvPlayer(mpvPath) : new SimulatedMusicPlayer();

  let state: JukeboxState = {
    status: "idle",
    currentSong: null,
    positionMs: 0,
    durationMs: null,
    volume: 80,
  };

  let lastContext: ActionContext | null = null;

  player.on("ended", () => {
    state = {
      ...state,
      status: "idle",
      positionMs: 0,
      currentSong: null,
    };
    if (lastContext) {
      lastContext.setTier("hidden");
    }
  });

  return {
    name: "jukebox",
    description: "网易云音乐点歌机，支持歌曲搜索、点播播放、音量控制和状态查询",
    defaultState: {
      enabled: true,
      tier: "hidden",
    },

    async onStart(): Promise<void> {
      void companionManager.ensureRunning(apiClient).catch(() => {});
    },

    async onStop(): Promise<void> {
      await player.stop();
      await player.close();
      await companionManager.stop();
    },

    async render(tier: "ambient" | "expanded"): Promise<string> {
      if (tier === "ambient") {
        // ambient 模式下保持静态元数据，不携带秒级跳动的时间戳，保护 Prompt Cache 前缀；
        // 空闲状态返回空字符串，严格遵循 0-Token 常态退火规范。不查 progress（省一次跨进程 IPC）。
        if (player.status === "playing" && state.currentSong) {
          return `[jukebox] 正在播放: ${state.currentSong.name} - ${state.currentSong.artists.join(", ")}`;
        }
        if (player.status === "paused" && state.currentSong) {
          return `[jukebox] 已暂停: ${state.currentSong.name} - ${state.currentSong.artists.join(", ")}`;
        }
        return "";
      }

      // expanded panel：推送型状态；曲目/进度保留（compaction 后这是确认"现在放什么"的唯一渠道，
      // 容错答即说谎）；搜索结果列表是拉取型信息，经 search 动作按需查询。
      // progress 查询（跨进程 IPC）只在此分支发生，ambient 每轮渲染不付这个成本。
      const progress = await player.progress();
      const currentPos = formatMs(progress.positionMs);
      const currentDur = formatMs(progress.durationMs);
      const statusStr = player.status === "playing" ? "播放中" : player.status === "paused" ? "已暂停" : "空闲";
      const coreStr = player.isSimulated ? "模拟(无声)" : "mpv";
      const songStr = state.currentSong
        ? `当前曲目: ${state.currentSong.name} - ${state.currentSong.artists.join(", ")}\n进度: ${currentPos} / ${currentDur}`
        : "当前曲目: 无";
      return `[jukebox]
状态: ${statusStr} | 内核: ${coreStr} | 音量: ${player.volume}%
${songStr}
[/jukebox]`;
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
          lastContext = ctx;
          await companionManager.ensureRunning(apiClient);

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
            const results = await apiClient.searchSongs(rawQuery.trim(), 5);
            if (results.length === 0) {
              return `未搜索到关于 "${rawQuery}" 的歌曲`;
            }
            songToPlay = results[0];
          } else {
            return "参数错误：必须提供搜索关键词或歌曲ID。例如 { query: 'World is Mine' } 或 { song_id: '22677570' }。";
          }

          const playUrl = await apiClient.getSongUrl(songToPlay.id);
          if (!playUrl) {
            if (player.isSimulated) {
              await player.load("simulated://stream", songToPlay.durationMs);
              state = {
                ...state,
                status: "playing",
                currentSong: songToPlay,
              };
              ctx.setTier("ambient");
              return `正在模拟播放: ${songToPlay.name} - ${songToPlay.artists.join(", ")} (⚠️ 提示: 未获取到音频流且处于模拟模式，无实际声音)`;
            }
            return `无法获取歌曲 "${songToPlay.name}" (ID: ${songToPlay.id}) 的播放音频流`;
          }

          await player.load(playUrl, songToPlay.durationMs);
          state = {
            ...state,
            status: "playing",
            currentSong: songToPlay,
          };
          ctx.setTier("ambient");

          const simNotice = player.isSimulated
            ? " (⚠️ 提示: 本地未检测到 mpv 播放器，处于静音模拟模式，无实际声音输出)"
            : "";
          return `正在播放: ${songToPlay.name} - ${songToPlay.artists.join(", ")}${simNotice}`;
        },
      },

      pause: {
        description: "暂停当前播放",
        parameters: { type: "object", properties: {} },
        async run() {
          if (player.status !== "playing") {
            return "当前未在播放";
          }
          await player.pause();
          state = { ...state, status: "paused" };
          return "已暂停播放";
        },
      },

      resume: {
        description: "恢复播放",
        parameters: { type: "object", properties: {} },
        async run() {
          if (player.status !== "paused") {
            return "当前未处于暂停状态";
          }
          await player.resume();
          state = { ...state, status: "playing" };
          return "已恢复播放";
        },
      },

      stop: {
        description: "停止播放",
        parameters: { type: "object", properties: {} },
        async run(_args, ctx: ActionContext) {
          lastContext = ctx;
          await player.stop();
          state = { ...state, status: "idle", currentSong: null };
          ctx.setTier("hidden");
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
            return `当前音量: ${player.volume}%。如需调整请输入 { level: 0-100 }。`;
          }

          const level = typeof raw === "number" ? raw : Number(raw);
          if (isNaN(level) || level < 0 || level > 100) {
            return "参数错误：音量必须是 0 到 100 之间的数字。例如 { level: 80 }。";
          }
          await player.setVolume(level);
          state = { ...state, volume: player.volume };
          return `音量已设置为 ${player.volume}%`;
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
        async run(args: Record<string, unknown>) {
          await companionManager.ensureRunning(apiClient);
          const raw = args.query ?? args.keyword ?? args.keywords ?? args.song ?? args.name ?? args.q;
          const query = String(raw ?? "").trim();
          if (!query) {
            return "参数错误：缺少搜索关键词。请传入 { query: '歌名' }（也支持 keyword 或 q）。";
          }
          const limit = typeof args.limit === "number" ? args.limit : 10;
          const songs = await apiClient.searchSongs(query, limit);
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

      status: {
        description: "查看当前播放状态、视口档位、当前曲目、播放进度和音量",
        parameters: { type: "object", properties: {} },
        async run(_args, ctx: ActionContext) {
          const progress = await player.progress();
          const currentPos = formatMs(progress.positionMs);
          const currentDur = formatMs(progress.durationMs);
          const tier = ctx.getTier();
          const tierDesc =
            tier === "hidden"
              ? "hidden (关闭/未展开，0 Token)"
              : tier === "ambient"
              ? "ambient (环境感知)"
              : "expanded (面板已展开)";

          const lines = [
            `状态: ${player.status === "playing" ? "▶ 播放中" : player.status === "paused" ? "⏸ 已暂停" : "⏹ 空闲"}`,
            `视口档位: ${tierDesc}`,
            `播放内核: ${player.isSimulated ? "⚠️ 静音模拟器 (未找到 mpv，无声音输出)" : "🔊 MPV 硬件解码音频输出"}`,
            `音量: ${player.volume}%`,
          ];
          if (state.currentSong) {
            lines.push(`当前曲目: ${state.currentSong.name} - ${state.currentSong.artists.join(", ")}`);
            lines.push(`专辑: ${state.currentSong.album ?? "无"}`);
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

export default createJukeboxApp();
