import type { WorldDef } from "../../../src/extensions/world-framework/types.js";
import { worldFailed, worldSucceeded } from "../../../src/extensions/world-framework/result.js";
import { loadSoundboardWorldConfig } from "./config.js";
import { SoundCatalog } from "./catalog.js";
import { MpvSoundPlayer, SimulatedSoundPlayer, resolveMpvPath, type SoundPlayer } from "./player.js";
import type { SoundItem, SoundboardWorldConfig } from "./types.js";

export function createSoundboardWorld(config?: SoundboardWorldConfig): WorldDef {
  const mergedConfig = { ...loadSoundboardWorldConfig(), ...config };
  const catalog = new SoundCatalog();

  const mpvPath = resolveMpvPath(mergedConfig.mpvPath);
  const player: SoundPlayer = mpvPath ? new MpvSoundPlayer(mpvPath) : new SimulatedSoundPlayer();

  let lastPlayed: SoundItem | null = null;
  const defaultVolume = mergedConfig.defaultVolume ?? 80;

  return {
    name: "soundboard",
    description: "主体的短时音效反应能力。需要具体音效时 play；名称不确定先 list；status 查看真实或模拟播放状态。",

    async onStart(): Promise<void> {
      await catalog.scan(mergedConfig.soundsDir ?? "./sounds", mergedConfig.soundOverrides);
    },

    async onStop(): Promise<void> {
      await player.close();
    },
    actions: {
      play: {
        description: "播放指定音效；普通文本表达不调用。支持音效 ID 或中文名称，匹配歧义时先 list。返回真实或模拟播放阶段。",
          parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            sound: { type: "string", minLength: 1, description: "音效ID或中文名称（例如 metal_pipe、钢管、报错、升级）" },
            volume: { type: "number", minimum: 0, maximum: 100, description: "播放音量 (0 - 100)，可选" },
          },
          required: ["sound"],
        },
        async run(args: Record<string, unknown>) {
          const query = String(args.sound ?? "").trim();
          if (!query) {
            return worldFailed("参数错误：缺少音效名称。请传入 { sound: '音效ID或中文名' }。", { reason: "missing_sound" });
          }

          const matchResult = catalog.match(query);

          if (matchResult.type === "none") {
            return worldFailed(`未找到与 "${query}" 相关的音效。可调用 list 查看可用音效列表。`, { reason: "sound_not_found", verify: "soundboard/list" });
          }

          if (matchResult.type === "ambiguous") {
            const listText = matchResult.candidates
              .map((c, i) => `${i + 1}. [ID: ${c.id}] ${c.name}`)
              .join("\n");
            return worldFailed(`匹配到 ${matchResult.candidates.length} 个与 "${query}" 相关的音效：\n${listText}\n请指定具体的 [ID] 重新调用，例如：soundboard({ action: "play", params: { sound: "${matchResult.candidates[0].id}" } })`, { reason: "ambiguous_sound", verify: "soundboard/list" });
          }

          const targetSound = matchResult.sound;
          const customVol = typeof args.volume === "number" ? args.volume : defaultVolume;
          const effectiveVol = Math.max(0, Math.min(100, customVol + (targetSound.gainOffset ?? 0)));

          await player.play(targetSound.filepath, effectiveVol);

          lastPlayed = targetSound;
          const simNotice = player.isSimulated ? " (⚠️ 提示: 未检测到 mpv 播放器，处于模拟播放状态)" : "";
          return worldSucceeded(`已播放音效: ${targetSound.name} [ID: ${targetSound.id}]${simNotice}`, { soundId: targetSound.id }, player.isSimulated ? "simulated" : "accepted");
        },
      },

      list: {
        description: "音效名称不确定时按关键词列出可选 ID；返回列表后再调用 play。",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "过滤关键词（可选）" },
          },
        },
        async run(args: Record<string, unknown>) {
          const filter = typeof args.query === "string" ? args.query : undefined;
          const results = catalog.list(filter);

          if (results.length === 0) {
            return worldSucceeded(filter ? `未找到与 "${filter}" 相关的音效` : "音效库暂无可用音效");
          }

          const lines = [`音效列表（共 ${results.length} 个）：`];
          for (let i = 0; i < results.length; i++) {
            const s = results[i];
            lines.push(`  ${i + 1}. [ID: ${s.id}] ${s.name}`);
          }
          lines.push('\n提示：调用 { action: "play", params: { sound: "ID" } } 即可播放。');
          return worldSucceeded(lines.join("\n"));
        },
      },

      stop: {
        description: "停止当前所有音效播放；仅在需要立即收声时调用，返回停止结果。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async run(_args) {
          await player.stop();
          return worldSucceeded("已停止所有正在播放的音效。", undefined, "applied");
        },
      },

      status: {
        description: "查询音效库、活跃播放、模拟/真实播放器和最近播放；不触发播放。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async run(_args) {
          const lines = [
            `状态: ${player.activeCount > 0 ? "▶ 正在播放" : "⏹ 就绪"}`,
            `播放内核: ${player.isSimulated ? "⚠️ 静音模拟器 (未找到 mpv)" : "🔊 MPV 硬件播放器"}`,
            `音效总数: ${catalog.size}`,
            `活跃播放数: ${player.activeCount}`,
            `全局音量: ${defaultVolume}%`,
            `最近播放: ${lastPlayed ? `${lastPlayed.name} [ID: ${lastPlayed.id}]` : "无"}`,
          ];
          return worldSucceeded(lines.join("\n"));
        },
      },
    },
  };
}

export default createSoundboardWorld();
