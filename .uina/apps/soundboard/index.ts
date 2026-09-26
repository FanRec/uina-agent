import type { AppDef, ActionContext } from "../../../src/extensions/app-framework/types.js";
import { loadSoundboardConfig } from "./config.js";
import { SoundCatalog } from "./catalog.js";
import { MpvSoundPlayer, SimulatedSoundPlayer, resolveMpvPath, type SoundPlayer } from "./player.js";
import type { SoundItem, SoundboardConfig } from "./types.js";

export function createSoundboardApp(config?: SoundboardConfig): AppDef {
  const mergedConfig = { ...loadSoundboardConfig(), ...config };
  const catalog = new SoundCatalog();

  const mpvPath = resolveMpvPath(mergedConfig.mpvPath);
  const player: SoundPlayer = mpvPath ? new MpvSoundPlayer(mpvPath) : new SimulatedSoundPlayer();

  let lastPlayed: SoundItem | null = null;
  let volume = mergedConfig.defaultVolume ?? 80;

  return {
    name: "soundboard",
    description: "音效库应用，支持播放各种情绪、反应、提示音效（如鼓掌、欢呼、笑声、XP报错、死亡回归等）",

    async onStart(): Promise<void> {
      await catalog.scan(mergedConfig.soundsDir ?? "./sounds", mergedConfig.soundOverrides);
    },

    async onStop(): Promise<void> {
      await player.close();
    },

    async render(tier: "ambient" | "expanded"): Promise<string> {
      if (tier === "ambient") {
        // 瞬时事件型应用：短音效播放后视口不占用 ambient，保持 0 Token，避免与 Tool Result 产生信息冗余
        return "";
      }

      // expanded 面板：只放推送型状态；音效目录是拉取型信息，经 list 动作按需查询（即时真值优于固化快照）。
      const stateStr = player.activeCount > 0 ? "正在播放" : "就绪";
      const recentStr = lastPlayed ? `\n最近播放: ${lastPlayed.name} [ID: ${lastPlayed.id}]` : "";
      return `[soundboard]
状态: ${stateStr} | 音量: ${volume}% | 共 ${catalog.size} 个音效${recentStr}
[/soundboard]`;
    },

    actions: {
      play: {
        description: "播放指定音效。支持音效ID（如 metal_pipe）或中文名称（如 钢管、报错、升级）",
        parameters: {
          type: "object",
          properties: {
            sound: { type: "string", description: "音效ID或中文名称（例如 metal_pipe、钢管、报错、升级）" },
            volume: { type: "number", description: "播放音量 (0 - 100)，可选" },
          },
          required: ["sound"],
        },
        async run(args: Record<string, unknown>, ctx: ActionContext) {
          const raw = args.sound ?? args.name ?? args.sfx ?? args.id;
          const query = String(raw ?? "").trim();
          if (!query) {
            return "参数错误：缺少音效名称。请传入 { sound: '音效ID或中文名' }。";
          }

          const matchResult = catalog.match(query);

          if (matchResult.type === "none") {
            return `未找到与 "${query}" 相关的音效。可调用 list 查看可用音效列表。`;
          }

          if (matchResult.type === "ambiguous") {
            const listText = matchResult.candidates
              .map((c, i) => `${i + 1}. [ID: ${c.id}] ${c.name}`)
              .join("\n");
            return `匹配到 ${matchResult.candidates.length} 个与 "${query}" 相关的音效：\n${listText}\n请指定具体的 [ID] 重新调用，例如：soundboard({ action: "play", params: { sound: "${matchResult.candidates[0].id}" } })`;
          }

          const targetSound = matchResult.sound;
          const customVol = typeof args.volume === "number" ? args.volume : volume;
          const effectiveVol = Math.max(0, Math.min(100, customVol + (targetSound.gainOffset ?? 0)));

          await player.play(targetSound.filepath, effectiveVol);

          lastPlayed = targetSound;
          ctx.setTier("hidden");

          const simNotice = player.isSimulated ? " (⚠️ 提示: 未检测到 mpv 播放器，处于模拟播放状态)" : "";
          return `已播放音效: ${targetSound.name} [ID: ${targetSound.id}]${simNotice}`;
        },
      },

      list: {
        description: "查看可用音效列表，支持传入 query 关键词进行过滤",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "过滤关键词（可选）" },
          },
        },
        async run(args: Record<string, unknown>) {
          const filter = typeof args.query === "string" ? args.query : undefined;
          const results = catalog.list(filter);

          if (results.length === 0) {
            return filter ? `未找到与 "${filter}" 相关的音效` : "音效库暂无可用音效";
          }

          const lines = [`音效列表（共 ${results.length} 个）：`];
          for (let i = 0; i < results.length; i++) {
            const s = results[i];
            lines.push(`  ${i + 1}. [ID: ${s.id}] ${s.name}`);
          }
          lines.push('\n提示：调用 { action: "play", params: { sound: "ID" } } 即可播放。');
          return lines.join("\n");
        },
      },

      stop: {
        description: "停止当前所有正在播放的音效",
        parameters: { type: "object", properties: {} },
        async run(_args, ctx: ActionContext) {
          await player.stop();
          ctx.setTier("hidden");
          return "已停止所有正在播放的音效。";
        },
      },

      status: {
        description: "查看音效库状态、视口档位、活跃播放数与最近播放记录",
        parameters: { type: "object", properties: {} },
        async run(_args, ctx: ActionContext) {
          const tier = ctx.getTier();
          const tierDesc =
            tier === "hidden"
              ? "hidden (关闭/未展开，0 Token)"
              : tier === "ambient"
              ? "ambient (环境感知)"
              : "expanded (面板已展开)";

          const lines = [
            `状态: ${player.activeCount > 0 ? "▶ 正在播放" : "⏹ 就绪"}`,
            `视口档位: ${tierDesc}`,
            `播放内核: ${player.isSimulated ? "⚠️ 静音模拟器 (未找到 mpv)" : "🔊 MPV 硬件播放器"}`,
            `音效总数: ${catalog.size}`,
            `活跃播放数: ${player.activeCount}`,
            `全局音量: ${volume}%`,
            `最近播放: ${lastPlayed ? `${lastPlayed.name} [ID: ${lastPlayed.id}]` : "无"}`,
          ];
          return lines.join("\n");
        },
      },
    },
  };
}

export default createSoundboardApp();
