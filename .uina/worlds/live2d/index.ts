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

/**
 * Live2D 世界装配。
 *
 * 工具面按规范定型：
 * express / posture / expression / attention / costume / status / diagnose / reload；
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
	let runtime: Live2DRuntime | undefined;

	// 工具入口统一收口：未启动时如实声明，启动后委托运行时（ActionContext.signal 一并透传）。
	function call(
		action: string,
		run: (
			rt: Live2DRuntime,
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
			"Live2D 具身身体。日常表达使用 <cue id='动作名'/>；持续姿态/表情/注视分别用 posture/expression/attention；命名动作用 express。目录以 status 查询为准。",
		executionMode: "parallel",
		defaultState: { enabled: true },
		async onStart(ctx: ServiceCompanionContext) {
			if (runtime) await runtime.stop();
			if (options.instance) {
				runtime = options.instance;
			} else {
				// rig 装配失败不阻断世界启动：诚实降级为零注入，status 中 rig=null 可见。
				// 测试注入完整 runtime 装配时跳过真实 rig 装配（不依赖磁盘模型文件）。
				const rig =
					options.runtime?.rig ??
					(await loadRig(MO_MODEL_ID).catch((error: unknown) => {
						console.warn("[Live2D] rig 装配失败，保活注入停用:", error);
						return undefined;
					}));
				const catalog = options.runtime?.catalog ?? (rig ? loadCatalog(rig.modelID, rig) : undefined);
				runtime = new Live2DRuntime({
					client: new VTSClient(),
					rig,
					catalog,
					speech: MO_SPEECH,
					...options.runtime,
				});
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
				description: "播放当前模型目录中的命名动作。名称来自 status；atomic=true 时任一轴被抢占即整场取消。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						motion: { type: "string", description: "目录中的命名动作" },
						atomic: { type: "boolean", description: "任一轴被抢占即整场取消；命名表演默认 true" },
						speech: { type: "string", enum: ["allow", "exclusive"], description: "exclusive 时压制口型" },
					},
					required: ["motion"],
				},
				run: call("express", (rt, args, ctx) => rt.express(args, ctx)),
			},
			posture: {
				description: "设置持续体态槽（整槽替换）。可用姿态见 status；hold_ms 到期自动回 neutral。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						name: { type: "string", description: "目录中的命名姿态" },
						hold_ms: { type: "number", minimum: 0, description: "保持时长（毫秒）；到期回 neutral；省略为持续" },
					},
					required: ["name"],
				},
				run: call("posture", (rt, args, ctx) => rt.posture(args, ctx)),
			},
			expression: {
				description: "设置持续神态槽（整槽替换）。可用表情见 status；hold_ms 到期自动回 neutral。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						name: { type: "string", description: "目录中的命名表情" },
						hold_ms: { type: "number", minimum: 0, description: "保持时长（毫秒）；到期回 neutral；省略为持续" },
					},
					required: ["name"],
				},
				run: call("expression", (rt, args, ctx) => rt.expression(args, ctx)),
			},
			attention: {
				description: "设置注视目标。内置 user/screen/avert_* 或目录命名；hold_ms 到期自动回 neutral。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						target: { type: "string", description: "注视目标（user/screen/avert_* 或目录命名）" },
						hold_ms: { type: "number", minimum: 0, description: "保持时长（毫秒）；到期回 neutral；省略为持续" },
					},
					required: ["target"],
				},
				run: call("attention", (rt, args, ctx) => rt.attention(args, ctx)),
			},
			costume: {
				description: "执行模型包登记的外观热键。可用外观见 status。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						item: { type: "string", description: "目录中的外观标识" },
					},
					required: ["item"],
				},
				run: call("costume", (rt, args, ctx) => rt.costume(args, ctx)),
			},
			status: {
				description: "读取世界启动状态、连接与适配事实与动作目录。",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				run: call("status", (rt) => ({ result: rt.formatStatus(), status: "succeeded" })),
			},
			diagnose: {
				description: "作者诊断：运行时内部状态只读快照，不修改配置。",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				run: call("diagnose", (rt) => ({ result: rt.diagnose(), status: "succeeded" })),
			},
			reload: {
				description: "显式重新加载当前 VTS 模型并重新核验绑定。",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				run: call("reload", (rt, _args, ctx) => rt.reload(ctx)),
			},
		},
	};
}

export default createLive2DApp();
