import type { Tool, ToolExecutionContext, ToolExecutionResult } from "../../../src/tools/broker.js";
import type { SpeechSession } from "./session.js";

/**
 * speech 工具（输出表达体系 §8.2）：普通对话用 <speech> 标签（不调用工具）；
 * 工具只用于额外发声、停止、查询与持续静音设置。Tool Schema 与回执只谈自己的
 * 业务操作：说话格式属于 Guidance，当前能力属于 Capability，持续故障属于
 * Capability，必要的新异步结局属于内部 Runtime Input。
 */
export function createSpeechTool(session: SpeechSession): Tool {
	return {
		executionMode: "sequential",
		def: {
			type: "function",
			function: {
				name: "speech",
				description:
					"额外发声与声音控制。正常说话直接用 <speech> 标签，不必调用本工具。say 额外说一句（replace=true 先停旧话再说）；stop 停止指定或全部发声；status 按需查看；set_muted 设置持续静音偏好。受理不等于已播出，播放完成也不代表对方听见。",
				parameters: {
					type: "object",
					oneOf: [
						{
							additionalProperties: false,
							properties: {
								action: { const: "say" },
								text: { type: "string", minLength: 1, description: "要发出的纯文本；不解析任何标记" },
								replace: { type: "boolean", description: "true 时先停止现有声音再说；旧声音停止未确认时不受理新台词" },
							},
							required: ["action", "text"],
						},
						{
							additionalProperties: false,
							properties: {
								action: { const: "stop" },
								target: { type: "string", description: "Utterance ID；省略时停止全部发声" },
							},
							required: ["action"],
						},
						{ additionalProperties: false, properties: { action: { const: "status" } }, required: ["action"] },
						{
							additionalProperties: false,
							properties: { action: { const: "set_muted" }, muted: { type: "boolean" } },
							required: ["action", "muted"],
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
			if (action === "say") {
				const text = typeof args.text === "string" ? args.text : "";
				if (!text.trim()) return { result: "say 未执行：台词为空。", status: "not_started" };
				const outcome = await session.say(text, args.replace === true, {
					callId: context?.callerId ?? "direct",
					...(context?.invocationId ? { invocationId: context.invocationId } : {}),
				});
				if (!outcome.accepted) {
					// 未受理不生成“已说”文字；受理结果未知时如实写未知，不自动重播。
					return outcome.audio === "unknown"
						? {
								result: `台词受理结果未知：${outcome.reason ?? "未取得确认"}；未自动重播。`,
								status: "unknown",
							}
						: {
								result: `台词未受理：${outcome.reason ?? "发声路径不可用"}。`,
								status: "failed",
							};
				}
				// 受理 ≠ 已播出：正文如实说明音频事实，不写"已经播放"。
				const audioNote =
					outcome.audio === "queued"
						? "音频已受理，正在交付队列中；是否播完以播放结果为准。"
						: outcome.audio === "not_played"
							? "当前没有音频进入交付路径（静音或服务不可用）；文字已受理。"
							: "音频交付结果未知；未自动重播。";
				return {
					result: `台词已受理（Utterance ${outcome.utteranceId}）。${audioNote}`,
					status: "succeeded",
					details: {
						speech: { version: 1, utteranceId: outcome.utteranceId, text, accepted: true },
					},
				};
			}
			if (action === "stop") {
				const target = typeof args.target === "string" && args.target.trim() ? args.target.trim() : undefined;
				const outcome = await session.stop(target);
				if (outcome.outcome === "unknown")
					return {
						result: `停止结果未知：${outcome.reason ?? "未取得停止确认"}；在确认之前不会在同一输出路径上提交替换音频。`,
						status: "unknown",
					};
				if (outcome.outcome === "failed")
					return { result: `停止失败：${outcome.reason ?? "停止请求未成功"}。`, status: "failed" };
				if (outcome.outcome === "no_op") return { result: "无需停止：没有对应的声音来源。", status: "succeeded" };
				const breakpoint =
					outcome.segmentIndex !== undefined
						? `（最近在播第 ${outcome.segmentIndex} 句${outcome.segmentText ? `「${outcome.segmentText.slice(0, 20)}」` : ""}）`
						: "";
				return { result: `已停止对应发声${breakpoint}。`, status: "succeeded" };
			}
			if (action === "status") {
				const status = await session.status();
				const lines = [
					`声音偏好：${status.muted ? "已静音" : "允许发声"}`,
					`发声服务：${status.hasDriver ? (status.online === undefined ? "状态未知" : status.online ? "已连接" : "未连接") : "驱动未挂载"}`,
					`当前正在说：${status.currentLine ?? "无"}`,
				];
				if (status.pendingSegments !== undefined) lines.push(`待播句数：${status.pendingSegments}`);
				if (status.stopUnconfirmed) lines.push("注意：上一次停止结果未确认，新语音提交会被阻断");
				lines.push(`进行中的表达：${status.activeUtterances}`);
				return { result: lines.join("；") + "。", status: "succeeded", details: status };
			}
			if (action === "set_muted") {
				const muted = args.muted === true;
				const result = await session.setMuted(muted);
				const persistedNote = result.persisted
					? "偏好已保存"
					: "偏好已在当前会话改变，但保存失败";
				if (muted) {
					const physicalNote =
						result.physical === "interrupted"
							? "当前声音已停止"
							: result.physical === "unknown"
								? "当前声音是否停止未确认"
								: result.physical === "failed"
									? "当前声音停止失败"
									: "当前没有需要停止的声音";
					return { result: `${persistedNote}；${physicalNote}。解除静音后只播新内容，不会重播旧台词。`, status: "succeeded", details: result };
				}
				return {
					result: `${persistedNote}；已允许后续发声${result.isOnline === false ? "（发声服务当前不可用，恢复后新内容可以发声）" : ""}。`,
					status: "succeeded",
					details: result,
				};
			}
			return { result: "speech action 未执行：参数不符合 speech 合同。", status: "not_started" };
		},
	};
}
