import type { ServiceCompanionContext, WorldDef } from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { Live2DRuntime } from "./runtime.js";
import { VTSClient } from "./adapter/vts-client.js";
import { loadRig, MO_MODEL_ID } from "./models/rig-loader.js";
import { MO_SPEECH } from "./models/mo/speech.js";

/**
 * Live2D 世界装配。
 *
 * 工具面按《live2d-world-boundary-spec.md》§2 一次性定型：express / state / costume /
 * flip / spatial / status / diagnose / preview / accept / reload。目录是参数的唯一合法
 * 词表来源；引擎接入前所有具身操作统一返回 not_started。
 *
 * P2-3：VTS 连接、MO rig、保活时钟与 director 合成已接线——模型身份匹配时注入
 * director 合成帧（槽位/动作/自律）；具身工具仍在 P4 接入前统一返回 not_started。
 * 刻意不做（规范修订 A2/A14/A6）：Timeline、Performance 门面、即兴 beats、自由数值轴。
 */
export function createLive2DApp(): WorldDef {
	let runtime: Live2DRuntime | undefined;

	// 工具入口统一收口：未启动时如实声明，启动后委托运行时。
	const call =
		(action: string, run: (rt: Live2DRuntime, args: Record<string, unknown>) => Promise<ToolExecutionResult>) =>
		async (args: Record<string, unknown>): Promise<ToolExecutionResult> =>
			runtime ? run(runtime, args) : { result: `Live2D 世界尚未启动，"${action}" 未执行。`, status: "not_started" };

	return {
		name: "live2d",
		description:
			"Live2D 具身身体。日常表达使用 <cue id='动作名'/>；持续性状态用 state；命名动作用 express。目录以 status 查询为准。",
		executionMode: "parallel",
		defaultState: { enabled: true },
		async onStart(ctx: ServiceCompanionContext) {
			if (runtime) await runtime.stop();
			// rig 装配失败不阻断世界启动：诚实降级为零注入，status 中 rig=null 可见。
			const rig = await loadRig(MO_MODEL_ID).catch((error: unknown) => {
				console.warn("[Live2D] rig 装配失败，保活注入停用:", error);
				return undefined;
			});
			runtime = new Live2DRuntime({ client: new VTSClient(), rig, speech: MO_SPEECH });
			await runtime.start(ctx);
		},
		async onStop() {
			const old = runtime;
			runtime = undefined;
			await old?.stop();
		},
		actions: {
			express: {
				description: "播放当前模型目录中的命名动作。名称来自 status；未接入引擎前不可用。",
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
				run: call("express", (rt) => Promise.resolve(rt.notStarted("express"))),
			},
			state: {
				description:
					"设置持续状态槽：体态 / 神态 / 注视，三槽独立。声明的槽整槽替换，未声明的槽保持不变；hold_ms 到期自动回 neutral。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						posture: { type: "string", description: "目录中的命名姿态" },
						expression: { type: "string", description: "目录中的命名表情" },
						attention: { type: "string", description: "注视目标（user/screen/avert_* 或目录命名）" },
						hold_ms: { type: "number", minimum: 0, description: "保持时长；到期回 neutral；省略为持续" },
					},
				},
				run: call("state", (rt) => Promise.resolve(rt.notStarted("state"))),
			},
			costume: {
				description: "执行模型包登记的外观热键；item='list' 只列出登记项。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: { item: { type: "string" } },
					required: ["item"],
				},
				run: call("costume", (rt) => Promise.resolve(rt.notStarted("costume"))),
			},
			flip: {
				description: "整模型旋转一圈并核实归位；取消后等待归位清理完成。",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				run: call("flip", (rt) => Promise.resolve(rt.notStarted("flip"))),
			},
			spatial: {
				description: "模型整体位移与缩放（VTS MoveModelRequest）。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						x: { type: "number" },
						y: { type: "number" },
						size: { type: "number" },
						duration: { type: "number", minimum: 0, maximum: 2 },
					},
				},
				run: call("spatial", (rt) => Promise.resolve(rt.notStarted("spatial"))),
			},
			status: {
				description: "读取世界启动状态、引擎接入进度、端点事实与动作目录。",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				run: call("status", (rt) => Promise.resolve({ result: rt.formatStatus(), status: "succeeded" as const })),
			},
			diagnose: {
				description: "作者诊断：三层遥测与运行时内部状态，不修改配置。",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				run: call("diagnose", (rt) => Promise.resolve(rt.notStarted("diagnose"))),
			},
			preview: {
				description: "作者会话专用：预览草稿、假 RMS、单控制关键帧。需操作员开启作者会话标记。",
				parameters: { type: "object", additionalProperties: true, properties: {} },
				run: call("preview", (rt) => Promise.resolve(rt.notStarted("preview"))),
			},
			accept: {
				description: "作者会话专用：把当前草稿的内容摘要与人工验收记录写入 acceptance.json 并发布。",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: { evidence: { type: "string", description: "人工画面验收说明" } },
					required: ["evidence"],
				},
				run: call("accept", (rt) => Promise.resolve(rt.notStarted("accept"))),
			},
			reload: {
				description: "显式重新加载当前 VTS 模型并重新核验绑定。",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				run: call("reload", (rt) => Promise.resolve(rt.notStarted("reload"))),
			},
		},
	};
}

export default createLive2DApp();
