import type { Tool, ToolExecutionContext, ToolExecutionResult } from "../../../src/tools/broker.js";
import type { PlaybackBreakpoint, InterruptResult } from "./driver.js";
import { describeDelivery } from "./driver.js";
import { VoiceSession } from "./session.js";

function describeBreakpoint(bp: PlaybackBreakpoint): string {
	const anchor = bp.segmentText
		? `，句首「${bp.segmentText.slice(0, 20)}${bp.segmentText.length > 20 ? "…" : ""}」`
		: "";
	const position = bp.committedCharEnd > 0 ? `估计播到第 ${bp.committedCharEnd} 个字` : "字位置暂未确认";
	return `（最近观察：第 ${bp.segmentIndex} 句，${position}${anchor}）`;
}
function renderInterruption(result: InterruptResult): Pick<ToolExecutionResult, "result" | "status"> {
	if (result.breakpoint)
		return { result: `已停止当前发声并清空未播内容${describeBreakpoint(result.breakpoint)}。`, status: "succeeded" };
	if (result.outcome === "no_op")
		return { result: `无需停止：${result.reason ?? "当前没有发声"}。`, status: "succeeded" };
	if (result.outcome === "unknown") return { result: `停止结果未知：${result.reason}。`, status: "unknown" };
	if (result.outcome === "failed") return { result: `停止失败：${result.reason}。`, status: "failed" };
	return { result: "已停止当前发声，但没有可用播放断点。", status: "succeeded" };
}

export function createVoiceTool(session: VoiceSession): Tool {
	return {
		executionMode: "sequential",
		def: {
			type: "function",
			function: {
				name: "voice",
				description:
					"正文在朗读开启时自动读出，不必再 speak。额外说一句用 speak；替换旧话加 replace=true。interrupt 临时停止，status 按需查看，manage 按用户要求改变偏好；mute 立即停止并保持静音。故障用 tts 检查。播放记录不代表对方听见，听觉反馈以对方为准。",
				parameters: {
					type: "object",
					oneOf: [
						{ additionalProperties: false, properties: { action: { const: "interrupt" } }, required: ["action"] },
						{ additionalProperties: false, properties: { action: { const: "status" } }, required: ["action"] },
						{
							additionalProperties: false,
							properties: {
								action: { const: "speak" },
								text: { type: "string", minLength: 1 },
								replace: { type: "boolean" },
							},
							required: ["action", "text"],
						},
						{
							additionalProperties: false,
							properties: { action: { const: "manage" }, operation: { enum: ["mute", "unmute"] } },
							required: ["action", "operation"],
						},
						{
							additionalProperties: false,
							properties: {
								action: { const: "manage" },
								operation: { const: "set_text_reading" },
								enabled: { type: "boolean" },
							},
							required: ["action", "operation", "enabled"],
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
			if (action === "speak") {
				const text = typeof args.text === "string" ? args.text.trim() : "";
				if (!text) return { result: "speak 未执行：台词为空。", status: "not_started" };
				const result = await session.speak(text, args.replace === true, context, signal);
				if (!result) return { result: "speak 未执行：发声驱动未挂载。", status: "not_started" };
				const outcome = result as { status?: string; reason?: string };
				if (outcome.status === "completed")
					return { result: "这次调用的台词已播放完成，没有重播。", status: "succeeded", details: result };
				if (outcome.status === "cancelled")
					return {
						result: `${outcome.reason ?? "这段台词已取消"}，不会继续播放。`,
						status: "cancelled",
						details: result,
					};
				if (outcome.status === "not_started")
					return {
						result: `台词未提交：${outcome.reason ?? "发声路径不可用"}。`,
						status: "not_started",
						details: result,
					};
				if (outcome.status === "unknown" || outcome.status === "uncertain")
					return {
						result: `发声结果未知：${outcome.reason ?? "未取得交付确认"}。未自动重播。`,
						status: "unknown",
						details: result,
					};
				if (outcome.status === "failed" || outcome.status === "rejected")
					return {
						result: `${outcome.status === "failed" ? "台词没能播完" : "台词未接受"}：${outcome.reason ?? "服务拒绝发声"}。`,
						status: "failed",
						details: result,
					};
				if (outcome.status === "accepted")
					return { result: "台词已受理，尚未确认播放完成；未自动重播。", status: "unknown", details: result };
				return { result: "服务未返回可识别的发声结论，播放结果未知；未自动重播。", status: "unknown", details: result };
			}
			if (action === "interrupt")
				return { ...renderInterruption(await session.interrupt()), details: await session.getStatus() };
			if (action === "status") {
				const status = await session.getStatus();
				return {
					result: [
						`语音偏好：${status.voiceState === "enabled" ? "允许发声" : "已静音"}`,
						`正文朗读：${status.readAssistantText ? "开启" : "关闭"}`,
						`声音：${describeDelivery(status.snapshot)}`,
						...(status.snapshot.observedAt
							? [`播放观察时间（UTC）：${new Date(status.snapshot.observedAt).toISOString()}`]
							: ["尚无设备播放观察"]),
					].join("；"),
					status: "succeeded",
					details: status,
				};
			}
			if (action === "manage") {
				const operation = args.operation;
				if (operation === "mute" || operation === "unmute") {
					const result = await session.setMuted(operation === "mute");
					if (result.status === "unknown" || result.status === "failed")
						return {
							status: result.status,
							result: `${result.persisted === false ? "偏好已在当前会话改变，但保存失败" : "偏好已保存"}；当前声音${operation === "unmute" ? "是否可用未确认" : result.status === "unknown" ? "停止未确认" : "停止失败"}：${result.reason ?? "未取得停止结果"}。`,
							details: result,
						};
					// 主副作用是偏好转换（§6.2）：偏好已改变即 succeeded；物理/持久化后果另行说明。
					const physical =
						result.isOnline === false || (result as { ok?: boolean }).ok === false || result.persisted === false;
					const note =
						operation === "unmute" && result.isOnline === false
							? "已允许发声，但发声服务当前不可用；修复后新内容可以发声。"
							: operation === "mute"
								? (result as { ok?: boolean }).ok === false
									? "静音偏好已改变；当前发声服务不可用，未确认停止。"
									: "已停止声音并保持静音。"
								: "已允许后续发声。";
					return {
						result: physical ? `${note}（${result.reason ?? "发声服务或偏好保存尚未确认"}）` : note,
						status: "succeeded",
						details: result,
					};
				}
				const enabled = typeof args.enabled === "boolean" ? args.enabled : undefined;
				if (enabled === undefined) return { result: "set_text_reading 需要 enabled 布尔值。", status: "not_started" };
				const result = await session.setTextReading(enabled);
				const note = `正文自动朗读已${enabled ? "开启" : "关闭"}。`;
				return {
					result:
						result.persisted === false || result.reason ? `${note}（${result.reason ?? "偏好仅内存生效"}）` : note,
					status: "succeeded",
					details: result,
				};
			}
			return { result: "voice action 未执行：参数不符合 voice 合同。", status: "not_started" };
		},
	};
}
