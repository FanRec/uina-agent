import type { ActionContext, AppDef, ServiceCompanionContext } from "../../../src/extensions/app-framework/types.js";
import { Live2DRuntime } from "./runtime.js";
import type { VTSClient } from "./vts-client.js";
import type { BasePoseName, ExpressParams } from "./types.js";

export * from "./runtime.js";

// 模块级单一聚合根引用
let currentRuntime: Live2DRuntime | null = null;

/**
 * 测试注入缝：替换 VTS 物理传输（与 pacing-ticker 的 setTickerEngineForTest 同形）。
 *
 * 生产路径不需要它——Live2D 自建客户端并连接本机 VTube Studio。测试无法满足
 * "本机运行 VTS 且用户已在弹窗中授权"这一前提，故留一条显式替换口。
 * 传 null 恢复真实客户端。它刻意不是宿主上下文里的字段：宿主从不提供 VTS 客户端，
 * 把它写成 ctx 字段会让读者误以为这是一条已连通的生产接缝。
 */
let vtsClientOverride: VTSClient | null = null;

export function setVtsClientForTest(client: VTSClient | null): void {
	vtsClientOverride = client;
}

export function getLive2DRuntime(): Live2DRuntime | null {
	return currentRuntime;
}

export const live2dApp: AppDef = {
	name: "live2d",
	description:
		"控制当前在屏幕上呈现的 Live2D 虚拟二次元立绘形象（Mo）。日常说话时优先在台词中使用 <cue id='...'/> 进行 0 开销的自然肢体伴随（如微笑、点头、歪头）；仅在需要主动调整中长期人设体态、触发装扮、或进行多步显式表演分镜时调用本工具。",

	defaultState: {
		enabled: true,
		tier: "ambient",
	},

	async onStart(ctx: ServiceCompanionContext): Promise<void> {
		if (currentRuntime) {
			await currentRuntime.stop();
			currentRuntime = null;
		}

		const runtime = new Live2DRuntime(vtsClientOverride ? { vtsClient: vtsClientOverride } : undefined);
		currentRuntime = runtime;

		await runtime.start(ctx);

		ctx.signal.addEventListener(
			"abort",
			() => {
				if (currentRuntime === runtime) {
					void runtime.stop();
					currentRuntime = null;
				}
			},
			{ once: true },
		);
	},

	async onStop(): Promise<void> {
		if (currentRuntime) {
			await currentRuntime.stop();
			currentRuntime = null;
		}
	},

	render(tier: "ambient" | "expanded"): string {
		if (!currentRuntime) {
			return tier === "ambient"
				? "[Live2D 虚拟形象 (Mo): 离线 (未启动)]"
				: "=== [Live2D 虚拟形象 (Mo)] ===\n状态: 离线 (应用未启动)\n==============================";
		}
		return currentRuntime.render(tier);
	},

	actions: {
		express: {
			description:
				"执行两步连贯分镜（beats）或即兴肢体表演（例如先扭头避开视线，再悄悄看回用户）。日常说话中的自然微笑、点头、歪头请直接在回复台词中使用 <cue id='...'/>（0 工具开销）；本工具仅在需要强烈情绪表演或分步连续动作时调用。",
			parameters: {
				type: "object",
				properties: {
					head: {
						type: "string",
						enum: ["tilt_left", "tilt_right", "nod", "shake", "lowered", "lifted"],
						description: "头部体态（tilt_left/right=歪头, nod=点头, shake=摇头, lowered=低头, lifted=仰头）",
					},
					gaze: {
						type: "string",
						enum: ["user", "away_left", "away_right", "down", "side_peek"],
						description: "视线方向（user=注视用户, side_peek=斜向偷看, down=垂眸, away_left/right=看旁边）",
					},
					face: {
						type: "string",
						enum: ["shy", "smug", "pout", "sparkle", "shocked", "tender_smile", "laugh"],
						description: "面相微表情（shy=脸红害羞, smug=坏笑得意, pout=嘟嘴傲娇, sparkle=眼眸闪烁, shocked=惊讶睁大, tender_smile=温柔微笑, laugh=开怀大笑眯眼）",
					},
					intensity: {
						type: "number",
						minimum: 0.1,
						maximum: 1.0,
						description: "情绪力度（0.2=克制小心, 0.6=正常, 1.0=夸张强烈），默认 0.6",
					},
					beats: {
						type: "array",
						maxItems: 2,
						description: "【高级小巧思】两步连续微动作（例如: 先看向别处，再悄悄看回用户）",
						items: {
							type: "object",
							properties: {
								head: { type: "string" },
								gaze: { type: "string" },
								face: { type: "string" },
								hold_ms: { type: "number", description: "维持时间(毫秒)，建议 400~1500" },
							},
						},
					},
				},
			},
			async run(args: Record<string, unknown>, ctx: ActionContext) {
				if (!currentRuntime) {
					return {
						result: "执行失败：Live2D 应用尚未启动。",
						status: "failed" as const,
						details: { reason: "app_not_started", effectStatus: "not_started" },
					};
				}
				return currentRuntime.executeExpress(args as unknown as ExpressParams, ctx);
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
				if (!currentRuntime) {
					return {
						result: "执行失败：Live2D 应用尚未启动。",
						status: "failed" as const,
						details: { reason: "app_not_started", effectStatus: "not_started" },
					};
				}
				return currentRuntime.executeCostume(String(args.item ?? ""), ctx);
			},
		},

		pose: {
			description:
				"切换全身基准体态与心境氛围（持续循环生效，作为人设底座）：playful（元气调皮大歪头，适合轻松活泼互动）、focused（正坐前倾仰头，适合认真倾听与专注工作）、relaxed（低头微斜闲适放松，适合闲聊待机）、shy_side（娇羞侧身偏头）、confident（自信挺胸昂首）、listening（侧耳前倾倾听）。默认持续常驻生效，直至下次主动切换；若指定了 duration_ms（> 0）则在保持指定时间后自然平滑回正。",
			parameters: {
				type: "object",
				properties: {
					name: {
						type: "string",
						enum: ["relaxed", "focused", "playful", "shy_side", "confident", "listening"],
						description:
							"基准姿态名称：playful=元气调皮大歪头, focused=专注认真正坐, relaxed=闲适放松待机, shy_side=娇羞侧身偏头, confident=自信挺胸昂首, listening=侧耳前倾倾听",
					},
					duration_ms: {
						type: "number",
						description: "可选。姿态保持时长（毫秒）。默认 0（持续保持循环生效直至下次切换）。若传入大于 0 的数值，则在保持指定时间后自然平滑回归 relaxed 待机。",
					},
				},
				required: ["name"],
			},
			async run(args: Record<string, unknown>, ctx: ActionContext) {
				if (!currentRuntime) {
					return {
						result: "执行失败：Live2D 应用尚未启动。",
						status: "failed" as const,
						details: { reason: "app_not_started", effectStatus: "not_started" },
					};
				}
				const name = String(args.name) as BasePoseName;
				const durationMs = typeof args.duration_ms === "number" ? args.duration_ms : 0;
				return currentRuntime.executePose(name, durationMs, ctx);
			},
		},

		flip: {
			description:
				"控制模型在屏幕上进行一次 360° 腾空翻转特技跳跃（持续约 1.2 秒）。适合在打招呼、恶作剧成功、庆祝获胜或极其兴奋时使用。",
			async run(_args: Record<string, unknown>, ctx: ActionContext) {
				if (!currentRuntime) {
					return {
						result: "执行失败：Live2D 应用尚未启动。",
						status: "failed" as const,
						details: { reason: "app_not_started", effectStatus: "not_started" },
					};
				}
				return currentRuntime.executeFlip(ctx);
			},
		},
	},
};

export default live2dApp;
