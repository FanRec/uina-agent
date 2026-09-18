import type { ExtensionActivation } from "../runner.js";
import type { SessionAccess } from "../../session/types.js";

/** Tool implementations resolve the executing subject; inherited tools never rewind their parent. */
export function activateSessionTools(resolve: (ownerId: string) => SessionAccess): ExtensionActivation {
	return (api) => {
		api.registerTool({
			def: {
				type: "function",
				function: {
					name: "session_list",
					description:
						"List mainline or read-only archived session nodes. Use canRewind to find safe historical targets. Preview is abbreviated; session_read returns full content.",
					parameters: {
						type: "object",
						properties: {
							scope: { type: "string", enum: ["main", "all"] },
							after: { type: "string", minLength: 1 },
							limit: { type: "integer", minimum: 1 },
						},
						additionalProperties: false,
					},
				},
			},
			run: async (args, _signal, context) => ({
				status: "succeeded",
				result: JSON.stringify(resolve(context?.ownerId ?? "root").list(args)),
			}),
		});

		api.registerTool({
			def: {
				type: "function",
				function: {
					name: "session_read",
					description:
						"Read one session node by id, including archived history. This does not change context or replay tools.",
					parameters: {
						type: "object",
						properties: {
							id: { type: "string", minLength: 1 },
						},
						required: ["id"],
						additionalProperties: false,
					},
				},
			},
			run: async (args, _signal, context) => {
				const id = typeof args?.id === "string" ? args.id.trim() : "";
				if (!id) {
					throw new Error("session_read 需要提供有效的 id");
				}
				return {
					status: "succeeded",
					result: JSON.stringify(resolve(context?.ownerId ?? "root").read(id)),
				};
			},
		});

		api.registerTool({
			def: {
				type: "function",
				function: {
					name: "session_rewind",
					description:
						"Request context rewind to a safe ancestor on the current mainline when an entire reasoning path is wrong. Provide reason and optional lessons note. The current tool batch settles first; scheduled is not committed. Abandoned paths remain readable. Files, background work and external effects are NOT undone; verify state before repeating actions. Later human inputs remain available.",
					parameters: {
						type: "object",
						properties: {
							targetId: { type: "string", minLength: 1 },
							reason: { type: "string", minLength: 1 },
							note: { type: "string" },
						},
						required: ["targetId", "reason"],
						additionalProperties: false,
					},
				},
			},
			run: async (args, signal, context) => {
				const targetId = typeof args?.targetId === "string" ? args.targetId.trim() : "";
				const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
				if (!targetId || !reason) {
					throw new Error("session_rewind 需要提供有效的 targetId 与 reason");
				}
				const summary = typeof args?.note === "string" ? args.note : undefined;
				const access = resolve(context?.ownerId ?? "root");
				const result = await access.requestRewind(
					{ targetId, reason, ...(summary ? { note: summary } : {}) },
					context?.callerId ?? api.id,
					signal,
				);
				return {
					status: "succeeded",
					result: JSON.stringify(result),
				};
			},
		});

		api.registerCommand({
			name: "rewind",
			description: "回溯当前主线：/rewind <target-id> <原因>，外部状态不撤销",
			handler: async (args) => {
				const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
				if (!match) {
					throw new Error("用法：/rewind <target-id> <原因>");
				}
				const result = await api.session.requestRewind({ targetId: match[1], reason: match[2] });
				api.ui.notify(`回溯请求 ${result.requestId}: ${result.status}`, "info", 5000);
			},
		});
	};
}
