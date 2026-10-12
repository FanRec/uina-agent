import { Worker } from "node:worker_threads";
import type {
	ActionContext,
	ServiceCompanionContext,
	WorldDef,
} from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { Live2DRuntime, type Live2DRuntimeOptions } from "./runtime.js";
import { VTSClient } from "./adapter/vts-client.js";
import { loadRig, MO_MODEL_ID } from "./models/rig-loader.js";
import { MO_SPEECH } from "./models/mo/speech.js";
import { loadCatalog } from "./models/mo/catalog.js";
import { Live2DRuntimeProxy, type Live2DWorldRuntime } from "./worker/proxy.js";

/**
 * Live2D 世界装配。
 *
 * 工具面按规范定型：
 * express / posture / expression / attention / costume / ambient / status / diagnose / reload；
 * executionMode 显式固定为 parallel（并发是常态，安全由引擎逐轴仲裁与独占声明保证，工具层不串行化）。
 *
 * 工具结果词汇表 + gate 链（中止 → 暂停 → 连接 → 适配）+ 目录词表解析；
 * express / posture / expression / attention 走引擎映射，costume 支持执行（独占 effect:* + 热键），
 * 空间特技统一收拢至 express 动作手势（独占 model:transform），reload 走 VTS 重载与绑定核验。
 * 刻意不做（规范修订 A2/A14/A6）：Timeline、Performance 门面、即兴 beats、自由数值轴。
 */
export interface Live2DAppOptions {
	/** 注入点（测试用）：替换默认的 rig/catalog/client 装配。 */
	runtime?: Live2DRuntimeOptions;
	/** 注入点（测试用）：直接使用预构建的运行时实例（跳过默认装配与 rig 加载）。 */
	instance?: Live2DRuntime;
}

export function createLive2DApp(options: Live2DAppOptions = {}): WorldDef {
	let runtime: Live2DWorldRuntime | undefined;

	// 工具入口统一收口：未启动时如实声明，启动后委托运行时（ActionContext.signal 一并透传）。
	function call(
		action: string,
		run: (
			rt: Live2DWorldRuntime,
			args: Record<string, unknown>,
			ctx: ActionContext,
		) => ToolExecutionResult | Promise<ToolExecutionResult>,
	): (args: Record<string, unknown>, ctx: ActionContext) => Promise<ToolExecutionResult> {
		return async (args, ctx) =>
			runtime
				? run(runtime, args, ctx)
				: { result: `Live2D 世界尚未启动，"${action}" 未执行。`, status: "not_started" };
	}

	return {
		name: "live2d",
		description:
			"Live2D 身体。说话时伴随的小动作（如点头、眨眼、歪头）直接在文字里写 <cue id='动作名'/>；需要主动调整身体姿势、表情、视线或做独立大幅动作时，才调用本工具。",
		executionMode: "parallel",
		defaultState: { enabled: true },
		async onStart(ctx: ServiceCompanionContext) {
			if (runtime) await runtime.stop();
			if (options.instance) {
				runtime = options.instance;
			} else if (options.runtime) {
				// rig 装配失败不阻断世界启动：诚实降级为零注入，status 中 rig=null 可见。
				// 测试注入完整 runtime 装配时跳过真实 rig 装配（不依赖磁盘模型文件）。
				const rig =
					options.runtime.rig ??
					(await loadRig(MO_MODEL_ID).catch((error: unknown) => {
						console.warn("[Live2D] rig 装配失败，保活注入停用:", error);
						return undefined;
					}));
				const catalog = options.runtime.catalog ?? (rig ? loadCatalog(rig.modelID, rig) : undefined);
				runtime = new Live2DRuntime({
					client: new VTSClient(),
					rig,
					catalog,
					speech: MO_SPEECH,
					...options.runtime,
				});
			} else {
				// 生产装配：引擎移入专用 worker 线程——合成时钟与 ws 刷写独立于宿主主事件循环，
				// 主循环阻塞（LLM/TTS/GC）不再把 60fps 注入塌缩成稀疏帧（关键帧卡顿根因）。
				// 入口是纯 JS（engine-entry.mjs）：tsx loader 线程局部，worker 内 .js→.ts 映射失效。
				const worker = new Worker(new URL("./worker/engine-entry.mjs", import.meta.url), {
					name: "live2d-engine",
				});
				runtime = new Live2DRuntimeProxy(worker, (cb) => worker.once("exit", cb));
			}
			await runtime.start(ctx);
		},
		async onStop() {
			const old = runtime;
			runtime = undefined;
			await old?.stop();
		},
		actions: {
			express: {
				description: "做一段独立的大幅动作（非说话伴随动作）。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						motion: { type: "string", description: "动作名称。来自当前模型的动作目录（具体见 status 或报错提示）" },
						atomic: { type: "boolean", description: "被抢占时是否整场取消，默认 true" },
						speech: { type: "string", enum: ["allow", "exclusive"], description: "exclusive 时在播放期间压制说话口型" },
					},
					required: ["motion"],
				},
				run: call("express", (rt, args, ctx) => rt.express(args, ctx)),
			},
			posture: {
				description: "调整身体姿势（站姿/坐姿）。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						name: { type: "string", description: "姿势名称。来自当前模型的姿势目录（如 rest, tuck 等，具体见 status 或报错提示）" },
						hold_ms: { type: "number", minimum: 0, description: "保持时长（毫秒，不填则一直保持）" },
					},
					required: ["name"],
				},
				run: call("posture", (rt, args, ctx) => rt.posture(args, ctx)),
			},
			expression: {
				description: "调整脸部表情。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						name: { type: "string", description: "表情名称。来自当前模型的表情目录（如 smile, smirk 等，具体见 status 或报错提示）" },
						hold_ms: { type: "number", minimum: 0, description: "保持时长（毫秒，不填则一直保持）" },
					},
					required: ["name"],
				},
				run: call("expression", (rt, args, ctx) => rt.expression(args, ctx)),
			},
			attention: {
				description: "调整视线方向。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						target: { type: "string", description: "视线目标。内置: user(看对方), screen(看屏幕), avert_down(看下方), avert_left/right(避开视线)，或当前模型的自定义目标" },
						hold_ms: { type: "number", minimum: 0, description: "保持时长（毫秒，不填则一直保持）" },
					},
					required: ["target"],
				},
				run: call("attention", (rt, args, ctx) => rt.attention(args, ctx)),
			},
			costume: {
				description: "切换外观或配件（如戴眼镜/脱外套）。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						item: { type: "string", description: "外观标识。来自当前模型的外观目录（见 status）" },
					},
					required: ["item"],
				},
				run: call("costume", (rt, args, ctx) => rt.costume(args, ctx)),
			},
			ambient: {
				description:
					"选择持续的环境身体循环（如摇摆晃动），选中后一直保持，与说话/表情/视线并存；再次调用可替换，不传 name 则停止并回到默认静止态。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						name: {
							type: "string",
							description: "环境循环名称。来自当前模型的环境循环目录（如 sway，具体见 status 或报错提示）",
						},
					},
				},
				run: call("ambient", (rt, args, ctx) => rt.ambient(args, ctx)),
			},
			status: {
				description: "查看当前身体状态和可用动作列表。",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				run: call("status", async (rt) => ({ result: await rt.formatStatus(), status: "succeeded" })),
			},
			diagnose: {
				description: "底层诊断快照（仅供技术排查，通常无需调用）。",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				run: call("diagnose", async (rt) => ({ result: await rt.diagnose(), status: "succeeded" })),
			},
			reload: {
				description: "重新加载模型并核验（仅供技术排查，通常无需调用）。",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				run: call("reload", (rt, _args, ctx) => rt.reload(ctx)),
			},
		},
	};
}

export default createLive2DApp();
