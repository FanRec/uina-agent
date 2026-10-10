import type {
	ActionContext,
	WorldDef,
	ServiceCompanionContext,
} from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { worldSucceeded } from "../../../src/extensions/world-framework/result.js";
import { Live2DRuntime } from "./runtime.js";
import { BASE_POSE_NAMES, BASE_POSE_DESCRIPTIONS, type BasePoseName, type ExpressParams } from "./types.js";

import { FACE_EXPRESSIONS, GAZE_DIRECTIONS, HEAD_POSES, MOTION_NAMES } from "./motion-library.js";

const poseDescription = BASE_POSE_NAMES.map((name) => `${name}=${BASE_POSE_DESCRIPTIONS[name]}`).join(", ");

export function createLive2DApp(): WorldDef {
	let currentRuntime: Live2DRuntime | null = null;
	const notStarted = (): ToolExecutionResult => ({
		result: "执行失败：Live2D 应用尚未启动。",
		status: "failed",
		details: { reason: "app_not_started", effectStatus: "not_started" },
	});
	const app: WorldDef = {
		name: "live2d",
		description:
			"控制当前在屏幕上呈现的 Live2D 形象。日常说话时优先在台词中使用 <cue id='...'/> 进行自然肢体伴随（如微笑、点头、歪头）；调整持续体态、触发装扮、或编排显式表演时调用本工具。动作能力取决于当前模型适配。",

		defaultState: {
			enabled: true,
		},

		async onStart(ctx: ServiceCompanionContext): Promise<void> {
			if (currentRuntime) {
				await currentRuntime.stop();
			}

			const runtime = new Live2DRuntime();
			currentRuntime = runtime;

			await runtime.start(ctx);
		},

		async onStop(): Promise<void> {
			if (currentRuntime) {
				await currentRuntime.stop();
				currentRuntime = null;
			}
		},
		actions: {
			express: {
				description:
					"播放命名动作（motion）、连贯分镜（beats）或即兴肢体表演（例如先扭头避开视线，再悄悄看回用户）。日常说话中的自然微笑、点头、歪头可在台词中使用 <cue id='动作名'/>；需要明确控制强度、留存或原子抢占时使用本工具。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						motion: {
							type: "string",
							enum: [...MOTION_NAMES],
							description: "命名动作；与 head/gaze/face 或 beats 二选一",
						},
						atomic: {
							type: "boolean",
							description: "true 时任一通道被抢占则取消整场；命名表演默认 true，即兴片段默认 false",
						},
						speech: {
							type: "string",
							enum: ["blend", "exclusive"],
							description:
								"blend 自然叠加说话嘴型；exclusive 保留动作嘴部编排，结束后渐恢复嘴型。默认 blend，哈欠默认 exclusive",
						},
						head: {
							type: "string",
							enum: [...HEAD_POSES],
							description:
								"头部体态（tilt_left/right=歪头, turn_left/right=转头, neutral=回到基准头姿, nod=完整点头, shake=完整左右摇头, lowered=低头, lifted=仰头；连续点头/摇头可使用对应 cue）",
						},
						gaze: {
							type: "string",
							enum: [...GAZE_DIRECTIONS],
							description: "视线方向（user=注视用户, side_peek=斜向偷看, down=垂眸, away_left/right=看旁边）",
						},
						face: {
							type: "string",
							enum: [...FACE_EXPRESSIONS],
							description:
								"面相微表情（shy=脸红害羞, smug=坏笑得意, pout=嘟嘴傲娇, sparkle=抬眉兴奋微笑, shocked=惊讶睁大, tender_smile=温柔微笑, laugh=开怀大笑眯眼, winking=单眼眨眼, smug_grin=得意坏笑, sleepy_yawn=犯困打哈欠）",
						},
						intensity: {
							type: "number",
							minimum: 0,
							maximum: 1.0,
							description: "情绪力度（0.3=克制小心, 0.6=收敛, 1.0=满幅生动），默认 1.0",
						},
						latch_last: {
							type: "boolean",
							description:
								"动作完成后是否留存最终通道目标；false 平滑融回当前持续姿态、反射与待机，true 保留至后续姿态或动作替换",
						},
						transition: {
							type: "string",
							enum: ["snappy", "smooth", "gentle"],
							description:
								"动作缓动节奏风格（snappy=快速, smooth=标准平滑, gentle=柔和舒缓；节拍含过渡，末尾另有舒适收势），默认 smooth",
						},
						beats: {
							type: "array",
							description: "连续微动作（例如: 先看向别处，再悄悄看回用户）",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									head: { type: "string", enum: [...HEAD_POSES] },
									gaze: { type: "string", enum: [...GAZE_DIRECTIONS] },
									face: { type: "string", enum: [...FACE_EXPRESSIONS] },
									hold_ms: {
										type: "number",
										exclusiveMinimum: 0,
										description: "步骤总时长（包含过渡，毫秒），必须大于 0",
									},
									intensity: { type: "number", minimum: 0, maximum: 1, description: "本步骤强度；默认使用整体强度" },
									latch: {
										type: "boolean",
										description: "最后一步是否留存（其他步骤只在本步骤期间展示）",
									},
								},
							},
						},
					},
				},
				async run(args: Record<string, unknown>, ctx: ActionContext) {
					const runtime = currentRuntime;
					if (!runtime) return notStarted();
					return runtime.executeExpress(args as unknown as ExpressParams, ctx);
				},
			},

			costume: {
				description:
					"切换模型的服装、发型或触发配饰道具热键。可直接传入热键名称或 ID；若不清楚当前模型支持哪些装扮，可传入 'list' 查询当前可用的全部热键。",
				parameters: {
					type: "object",
					properties: {
						item: {
							type: "string",
							description: "热键名称或 ID（例如当前模型配置的 Glasses, Cat Ears 等），或传入 'list' 查询可用热键",
						},
					},
					required: ["item"],
				},
				async run(args: Record<string, unknown>, ctx: ActionContext) {
					const runtime = currentRuntime;
					if (!runtime) return notStarted();
					return runtime.executeCostume(String(args.item ?? ""), ctx);
				},
			},

			pose: {
				description: `切换持续生效的基准体态：${poseDescription}。默认常驻直至主动切换；duration_ms > 0 时到期平滑回到 relaxed。实际表现受模型绑定与物理限制。`,
				parameters: {
					type: "object",
					properties: {
						name: {
							type: "string",
							enum: [...BASE_POSE_NAMES],
							description: `基准姿态名称：${poseDescription}`,
						},
						duration_ms: {
							type: "number",
							minimum: 0,
							description:
								"可选。姿态保持时长（毫秒）。默认 0（持续保持生效直至下次切换）。若传入大于 0 的数值，则在保持指定时间后自然平滑回归 relaxed 待机。",
						},
					},
					required: ["name"],
				},
				async run(args: Record<string, unknown>, ctx: ActionContext) {
					const runtime = currentRuntime;
					if (!runtime) return notStarted();
					const name = String(args.name) as BasePoseName;
					const durationMs = typeof args.duration_ms === "number" ? args.duration_ms : 0;
					return runtime.executePose(name, durationMs, ctx);
				},
			},

			flip: {
				description:
					"控制模型在屏幕上进行一次 360° 腾空翻转特技跳跃（飞行约 0.9 秒，随后归位并核实原位置）。适合在打招呼、恶作剧成功、庆祝获胜或极其兴奋时使用。",
				async run(_args: Record<string, unknown>, ctx: ActionContext) {
					const runtime = currentRuntime;
					if (!runtime) return notStarted();
					return runtime.executeFlip(ctx);
				},
			},

			status: {
				description:
					"查询当前 Live2D 虚拟形象的即时物理与具身状态（包括 VTS 物理在线状态、具身注册、口型通道接线、当前姿态、当前服装、最近线索与可用热键）。当用户询问身体状态、口型是否接通、或排查动作状态时调用。",
				async run(_args: Record<string, unknown>, _ctx: ActionContext) {
					const runtime = currentRuntime;
					if (!runtime) return notStarted();
					return worldSucceeded(runtime.formatStatus());
				},
			},
		},
	};
	return app;
}

export default createLive2DApp();
