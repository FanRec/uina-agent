import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { resolveMpvPath } from "../../../src/extensions/world-framework/mpv-path.js";
import { worldFailed, worldSucceeded, worldUnknown } from "../../../src/extensions/world-framework/result.js";
import type { WorldDef } from "../../../src/extensions/world-framework/types.js";
import { filterSounds, matchSounds, scanSounds } from "./catalog.js";
import { loadSoundboardWorldConfig } from "./config.js";
import { MpvSoundPlayer, type SoundPlayer } from "./player.js";
import type { SoundboardConfig, SoundItem } from "./types.js";

export interface SoundboardDeps {
	/** 覆盖 config.json 里的字段，测试与预览用。 */
	readonly config?: Partial<SoundboardConfig>;
	/** 覆盖播放器，测试用。 */
	readonly player?: SoundPlayer;
}

/**
 * 三个动词，一个可变状态（活着的 mpv 进程集合，stop 需要它）。
 * 目录、配置、播放器路径每次现读：音效是文件，文件就该是唯一真相。
 */
export function createSoundboardWorld(deps: SoundboardDeps = {}): WorldDef {
	const player = deps.player ?? new MpvSoundPlayer();

	const mergeConfig = (base: SoundboardConfig): SoundboardConfig => ({
		soundsDir: deps.config?.soundsDir ?? base.soundsDir,
		defaultVolume: deps.config?.defaultVolume ?? base.defaultVolume,
		mpvPath: deps.config?.mpvPath ?? base.mpvPath,
		soundOverrides: deps.config?.soundOverrides ?? base.soundOverrides,
	});

	// 工厂必须无参可调、不读宿主也不抛配置错（见 docs/app-development.md），
	// 所以配置在动作内懒读，读坏了变成一条指名文件的失败结果。
	const withConfig = async (
		run: (config: SoundboardConfig) => Promise<ToolExecutionResult>,
	): Promise<ToolExecutionResult> => {
		let base: SoundboardConfig;
		try {
			base = loadSoundboardWorldConfig();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return worldFailed(`配置读取失败: ${detail}。修好 .uina/worlds/soundboard/config.json 后重试。`, {
				reason: "config_invalid",
			});
		}
		return run(mergeConfig(base));
	};

	return {
		name: "soundboard",
		description:
			"播放短音效，可以独立播放，也可以配合说话、动作或正在发生的事情。能用来表达情绪、接梗、强调某个瞬间或营造气氛。用 list 查看可用音效，不要猜测名称。",

		async onStop(): Promise<void> {
			await player.stop();
		},

		actions: {
			play: {
				description: "播放一个音效。sound 传 ID 或名称片段；volume 可选，默认 80。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						sound: { type: "string", minLength: 1, description: "音效 ID 或名称片段" },
						volume: { type: "number", minimum: 0, maximum: 100, description: "音量 0-100，可选；不填用默认值" },
					},
					required: ["sound"],
				},
				run: (params) =>
					withConfig(async (config) => {
						const query = String(params.sound ?? "").trim();
						const sounds = await scanSounds(config.soundsDir, config.soundOverrides);
						if (sounds.length === 0) {
							return worldFailed(`音效目录为空或不存在: ${config.soundsDir}`, { reason: "no_sounds" });
						}

						const matched = matchSounds(sounds, query);

						if (matched.type === "none") {
							return worldFailed(`没有与 "${query}" 匹配的音效。可放的：${soundIds(sounds)}`, {
								reason: "sound_not_found",
							});
						}
						if (matched.type === "ambiguous") {
							const candidates = matched.candidates.map((item, i) => `${i + 1}. [ID: ${item.id}] ${item.name}`);
							return worldFailed(
								`"${query}" 匹配到 ${matched.candidates.length} 个音效：\n${candidates.join("\n")}\n用完整的 ID 再调一次。`,
								{ reason: "ambiguous_sound" },
							);
						}

						const sound = matched.sound;
						const requested = typeof params.volume === "number" ? params.volume : config.defaultVolume;
						const volume = clampVolume(requested + (sound.volumeOffset ?? 0));

						const binary = resolveMpvPath(config.mpvPath);
						if (!binary) {
							return worldFailed(
								"音效播放器未就绪: 没有找到 mpv。把 mpv.exe 的完整路径写进 .uina/worlds/soundboard/config.json 的 mpvPath。",
								{ reason: "player_unavailable" },
							);
						}

						const outcome = await player.play(binary, sound.filepath, volume);
						if (!outcome.ok) {
							if (outcome.reason === "player_exited") {
								return worldFailed(`播放器立即退出（exit=${outcome.exitCode ?? "null"}），"${sound.name}" 没有播放。`, {
									reason: "player_exited",
								});
							}
							return worldFailed(`播放器无法启动: ${outcome.detail}`, { reason: "spawn_failed" });
						}

						// 只在音量与默认值不同时回显——但显式传了非默认值时也回显，
						// 否则偏移恰好抵消掉她的入参，结果里就看不出实际放的是多少。
						const volumeNote =
							volume === config.defaultVolume && requested === config.defaultVolume ? "" : `，音量 ${volume}`;
						return worldSucceeded(
							`播放中: ${sound.name} [ID: ${sound.id}]${volumeNote}`,
							{ soundId: sound.id, volume },
							"accepted",
						);
					}),
			},

			list: {
				description: "列出可放的音效。想知道有什么就调它。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						query: { type: "string", description: "过滤关键词（可选）" },
					},
				},
				run: (params) =>
					withConfig(async (config) => {
						const all = await scanSounds(config.soundsDir, config.soundOverrides);
						if (all.length === 0) {
							return worldFailed(`音效目录为空或不存在: ${config.soundsDir}`, { reason: "no_sounds" });
						}

						const query = typeof params.query === "string" ? params.query : "";
						const shown = filterSounds(all, query);
						if (shown.length === 0) {
							return worldSucceeded(`没有匹配 "${query}" 的音效。全部可放：${soundIds(all)}`);
						}

						const lines = [`音效列表（共 ${shown.length} 个）：`];
						for (const [i, item] of shown.entries()) lines.push(`  ${i + 1}. [ID: ${item.id}] ${item.name}`);
						return worldSucceeded(lines.join("\n"), { count: shown.length });
					}),
			},

			stop: {
				description: "立即停止所有正在播放的音效。",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				run: async () => {
					const { stopped, stragglers } = await player.stop();
					if (stragglers > 0) {
						return worldUnknown(`已停止 ${stopped} 个，${stragglers} 个未确认退出。`, { reason: "stop_unconfirmed" });
					}
					return worldSucceeded(
						stopped > 0 ? `已停止 ${stopped} 个音效。` : "没有正在播放的音效。",
						undefined,
						"applied",
					);
				},
			},
		},
	};
}

const soundIds = (sounds: readonly SoundItem[]): string => sounds.map((sound) => sound.id).join("、");

const clampVolume = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

export default createSoundboardWorld();
