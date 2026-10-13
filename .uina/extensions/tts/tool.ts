import type { Tool, ToolExecutionContext, ToolExecutionResult } from "../../../src/tools/broker.js";
import type { TtsVoiceOutputDriver } from "./driver-impl.js";

type Component = "bridge" | "vendor" | "player" | "extension";

export function createTtsTool(driver: TtsVoiceOutputDriver): Tool {
	return {
		executionMode: "sequential",
		def: {
			type: "function",
			function: {
				name: "tts",
				description:
					"检查声音问题。inspect 查看证据，test 验证合成或播放，recover 尝试恢复连接与交付；重启需明确指定目标。不改变静音偏好，不重播旧台词。",
				parameters: {
					type: "object",
					oneOf: [
						{
							additionalProperties: false,
							properties: {
								action: { const: "inspect" },
								component: {
									enum: ["bridge", "vendor", "player", "extension"],
									description: "省略时给出总览；指定组件展开证据。",
								},
							},
							required: ["action"],
						},
						{ additionalProperties: false, properties: { action: { const: "recover" } }, required: ["action"] },
						{
							additionalProperties: false,
							properties: {
								action: { const: "recover" },
								operation: { const: "restart" },
								target: { enum: ["bridge", "vendor"] },
							},
							required: ["action", "operation", "target"],
						},
						{
							additionalProperties: false,
							properties: {
								action: { const: "test" },
								scope: {
									enum: ["synthesis", "playback"],
									description: "默认只测合成；playback 排队播放测试音并等待播完，静音时不播放。",
								},
							},
							required: ["action"],
						},
					],
				},
			},
		},
		run: async (
			args: Record<string, unknown>,
			signal?: AbortSignal,
			context?: ToolExecutionContext,
		): Promise<ToolExecutionResult> => {
			signal?.throwIfAborted();
			const action = args.action;
			if (action === "inspect") {
				const details = await driver.inspect();
				const component = args.component as Component | undefined;
				return {
					result: renderInspect(details, component),
					status: details.status === "unknown" ? "unknown" : "succeeded",
					details,
				};
			}
			if (action === "test") {
				const scope = (args.scope === "playback" ? "playback" : "synthesis") as "synthesis" | "playback";
				const details = await driver.test(scope, signal);
				return { result: renderTest(details), status: toToolStatus(details.status), details };
			}
			if (action === "recover") {
				if (args.operation === "restart") {
					const target = args.target === "vendor" ? "vendor" : "bridge";
					const details = await driver.recover("restart", context?.invocationId, target, signal);
					return { result: renderRecover(details), status: toToolStatus(details.status), details };
				}
				const details = await driver.recover("auto", context?.invocationId, undefined, signal);
				return { result: renderRecover(details), status: toToolStatus(details.status), details };
			}
			return { result: "tts action 未执行：参数不符合维护合同。", status: "not_started" };
		},
	};
}

function toToolStatus(value: unknown): ToolExecutionResult["status"] {
	if (value === "failed") return "failed";
	if (value === "unknown" || value === "uncertain") return "unknown";
	if (value === "not_started") return "not_started";
	if (value === "cancelled") return "cancelled";
	return "succeeded";
}
function text(value: unknown): string {
	return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
}
function renderInspect(details: Record<string, unknown>, component?: Component): string {
	const health = (details.health ?? {}) as Record<string, unknown>;
	const local = (details.driver ?? {}) as Record<string, unknown>;
	const ownership = (details.ownership ?? {}) as Record<string, unknown>;
	const value = (v: unknown) => (v === true ? "是" : v === false ? "否" : "未知");
	const lines: string[] = [];
	if (!component || component === "bridge")
		lines.push(
			`服务可达：${value(details.reachable)}；协议兼容：${value(details.compatible)}；可自行重启：${value(ownership.bridge === "owned")}`,
		);
	if (!component || component === "vendor")
		lines.push(`模型接口可达：${value(health.vendor_ready)}；可自行重启：${value(ownership.vendor === "owned")}`);
	if (!component || component === "player")
		lines.push(`播放器就绪：${value(health.player_ready)}；设备正在播放：${value(health.is_playing)}`);
	if (!component || component === "extension")
		lines.push(
			`当前静音：${value(local.muted)}；待播：${local.pendingSegments ?? "未知"}；失败：${local.failedSegments ?? "未知"}；结果未知：${local.unknownSegments ?? "未知"}；因未确认的声音阻止新发声：${value(local.barrier)}`,
		);
	const config = health.effective_config as Record<string, unknown> | undefined;
	const streaming = config?.streaming as Record<string, unknown> | undefined;
	if (component === "bridge")
		lines.push(
			`声音协议版本：${health.voice_protocol_version ?? "未知"}；排队任务：${health.pending_delivery_tasks ?? "未知"}；交付线程存活：${value(health.delivery_worker_alive)}；处理中：${health.active_delivery_tasks ?? "未知"}`,
		);
	if (component === "vendor")
		lines.push(
			`当前路径：${health.streaming_enabled === true ? "流式" : health.streaming_enabled === false ? "整段合成" : "未知"}；采样率：${streaming?.sample_rate ?? "未知"}；受理后尚未处理：${health.admitted_task_count ?? "未知"}`,
		);
	if (component === "player")
		lines.push(
			`播放启用：${value(health.playback_enabled)}；当前任务：${health.active_playback_task_id ?? "无已知活动任务"}；设备：${streaming?.device ?? "系统默认"}；停止未确认：${value(local.stopUnconfirmed)}`,
		);
	if (component === "extension")
		lines.push(
			`已播完：${local.spokenSegments ?? "未知"}；已取消：${local.cancelledSegments ?? "未知"}；维护中：${value(local.maintenance)}；最近设备观察：${typeof local.observedAt === "number" ? new Date(local.observedAt).toISOString() : "尚无"}`,
		);
	const verification = health.last_verification as Record<string, unknown> | undefined;
	lines.push(
		verification
			? `最近测试：${text(verification.scope)}，${text(verification.status)}；这是当时的结果。`
			: "尚无合成或播放测试结果；接口可达不代表能发声。",
	);
	if (details.reason) lines.push(`未确认：${text(details.reason)}`);
	const error = health.last_delivery_error as Record<string, unknown> | undefined;
	if (error?.error) lines.push(`最近错误：${text(error.error)}`);
	const localError = local.lastError as Record<string, unknown> | undefined;
	if (localError?.reason && (!component || component === "extension"))
		lines.push(`最近${text(localError.stage)}错误（当时）：${text(localError.reason)}`);
	lines.push(
		`可用动作：${Array.isArray(details.availableActions) ? (details.availableActions.length ? details.availableActions.map((action) => (typeof action === "string" ? action : JSON.stringify(action))).join("、") : "当前没有可确认的恢复动作，请由服务启动方处理") : "test 或 recover"}`,
	);
	return lines.join("\n");
}
function renderTest(details: Record<string, unknown>): string {
	if (details.status === "cancelled") return `测试已取消：${text(details.reason ?? "未继续播放")}。`;
	if (details.status === "not_started") return `测试未执行：${text(details.reason ?? "当前不能执行这项测试")}。`;
	if (details.status === "unknown") return `测试结果未知：${text(details.reason ?? "未取得完成确认")}。`;
	if (details.status === "failed") return `测试失败：${text(details.reason ?? "实际验证路径失败")}。`;
	const path = details.path === "streaming" ? "（流式）" : details.path === "batch" ? "（整段合成）" : "";
	return details.scope === "playback"
		? `播放测试通过${path}：测试音已播完，尚未验证用户是否听见。`
		: `合成测试通过${path}：生成了有效音频${typeof details.duration_ms === "number" ? `，时长 ${details.duration_ms} 毫秒` : ""}；没有播放。`;
}
function renderRecover(details: Record<string, unknown>): string {
	const operation = details.operation === "restart" ? "重启" : "恢复";
	if (details.status === "cancelled") return `${operation}已取消。`;
	if (details.status === "failed") return `${operation}失败：${text(details.reason ?? "未取得恢复确认")}。`;
	if (details.status === "unknown")
		return `${operation}结果未知：${text(details.reason ?? "未取得确认")}。旧台词不会自动重播。`;
	if (details.status === "not_started")
		return `${operation}未执行：${text(details.reason ?? "当前不能执行这项操作")}。`;
	return `${operation}完成：已重新连接${details.stoppedOldWork ? "，旧声音已确认停止" : "并检查发声记录"}；旧台词未重播。${details.feedback === "polling" ? "实时反馈未接通，仍可按记录查询。" : ""}尚未测试新的合成或播放。`;
}
