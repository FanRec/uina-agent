import { Worker } from "node:worker_threads";
import type {
	ActionContext,
	ServiceCompanionContext,
	WorldDef,
} from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { type Live2DRuntimeOptions } from "./runtime.js";
import { toolNotStarted, toolRejected, toolSucceeded } from "./results.js";
import { createLive2DRuntime } from "./assembly.js";
import { Live2DRuntimeProxy, type Live2DWorldRuntime } from "./worker/proxy.js";

/**
 * Live2D 世界装配。
 *
 * 工具面按规范定型：
 * express / state（姿势·表情·视线·环境动作组）/ costume / prepare_body / status（含 detail 诊断档）/ reload；
 * executionMode 显式固定为 parallel（并发是常态，安全由引擎逐轴仲裁与独占声明保证，工具层不串行化）。
 *
 * 工具结果词汇表 + gate 链（中止 → 暂停 → 连接 → 适配）+ 目录词表解析；
 * express 走引擎映射，costume 支持执行（独占 effect:* + 热键），
 * 空间特技统一收拢至 express 动作手势（独占 model:transform），reload 走 VTS 重载与绑定核验。
 * 刻意不做（规范修订 A2/A14/A6）：Timeline、Performance 门面、即兴 beats、自由数值轴。
 */
export interface Live2DAppOptions {
	/** 注入点（测试用）：替换默认的 rig/catalog/client 装配。 */
	runtime?: Live2DRuntimeOptions;
	/** 注入点（测试用）：直接使用预构建的运行时实例（跳过默认装配与 rig 加载）。 */
	instance?: Live2DWorldRuntime;
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
			runtime ? run(runtime, args, ctx) : toolNotStarted(`Live2D 世界尚未启动，"${action}" 未执行。`);
	}

	return {
		name: "live2d",
		description:
			"Live2D 身体。说话时的小动作（点头、眨眼）直接在文字里写 <cue id='动作名'/>；需要主动动身体时才调用本工具。拿不准动作名先调 status。",
		executionMode: "parallel",
		defaultState: { enabled: true },
		async onStart(ctx: ServiceCompanionContext) {
			if (runtime) await runtime.stop();
			if (options.instance) {
				runtime = options.instance;
			} else if (options.runtime) {
				runtime = await createLive2DRuntime(options.runtime);
			} else {
				// 生产装配：引擎移入专用 worker 线程——合成时钟与 ws 刷写独立于宿主主事件循环，
				// 主循环阻塞（LLM/TTS/GC）不再把 60fps 注入塌缩成稀疏帧（关键帧卡顿根因）。
				// 入口是纯 JS（engine-entry.mjs）：tsx loader 线程局部，worker 内 .js→.ts 映射失效。
				const worker = new Worker(new URL("./worker/engine-entry.mjs", import.meta.url), {
					name: "live2d-engine",
				});
				runtime = new Live2DRuntimeProxy(worker);
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
				description: "做一个完整的大动作，比如转身、凑近、挥手。说话时的小动作不要调这个。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						motion: { type: "string", description: "动作名称，来自当前模型的动作目录（见 status 或报错提示）" },
						atomic: { type: "boolean", description: "被抢占时是否整场取消，默认 true" },
						speech: { type: "string", enum: ["allow", "exclusive"], description: "exclusive 时在播放期间压制说话口型" },
					},
					required: ["motion"],
				},
				run: call("express", (rt, args, ctx) => rt.express(args, ctx)),
			},
			state: {
				description:
					"调整持续的身体状态：姿势、表情、视线、背景小动作。可一次组合设置多个状态项，未传的项保持不变；姿势表情会一直保持到下次更换。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						posture: { type: "string", description: "姿势名，来自当前模型目录（见 status）" },
						expression: { type: "string", description: "表情名，来自当前模型目录（见 status）" },
						attention: {
							type: "string",
							description: "看向哪里：user(看对方)、screen(看屏幕)、avert_down/left/right(移开视线)，或模型自定义目标",
						},
						ambient: {
							type: ["string", "null"],
							description:
								"背景小动作名，来自当前模型目录（见 status）；传 null 清除选中并回落模型默认 idle，无需设置 idle 名称",
						},
						hold_ms: {
							type: "number",
							minimum: 0,
							description: "本调用的姿势/表情/视线保持多久（毫秒），到期自动回正；不填则一直保持",
						},
					},
				},
				run: call("state", (rt, args, ctx) => rt.state(args, ctx)),
			},
			costume: {
				description: "穿脱外观，比如戴上眼镜、脱掉外套。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						item: { type: "string", description: "外观标识，来自当前模型的外观目录（见 status）" },
					},
					required: ["item"],
				},
				run: call("costume", (rt, args, ctx) => rt.costume(args, ctx)),
			},
			status: {
				description:
					"看身体现在的状态和能做的所有动作。background 显示内部背景循环，running 只表示时钟推进；前景动作期间可让位，不代表 VTS 参数已生效。拿不准名字时先调这个。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						detail: { type: "boolean", description: "true 返回底层诊断快照（引擎内部状态，平时不用）" },
					},
				},
				run: call("status", async (rt, args) => {
					try {
						return toolSucceeded(args.detail === true ? await rt.diagnose() : await rt.formatStatus());
					} catch (error) {
						return toolRejected(
							"engine_error",
							`Live2D 状态读取失败：${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}),
			},
			reload: {
				description: "重载模型并核验绑定。改了模型配置后用。",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				run: call("reload", (rt, _args, ctx) => rt.reload(ctx)),
			},
			prepare_body: {
				description:
					"显式准备当前模型的三个 Uina 躯干输入，并返回在 VTube Studio 中手动映射到身体 yaw/pitch/roll 的步骤。",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				run: call("prepare_body", (rt, _args, ctx) => rt.prepareBody(ctx)),
			},
		},
	};
}

export default createLive2DApp();
