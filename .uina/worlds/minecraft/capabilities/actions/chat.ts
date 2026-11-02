/**
 * chat@1：普通消息与服务器指令。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md#chat、driver §7.7。
 * 一次调用 = 一条非空单行文本；派发边界由 Driver 保证，不把"进入上游队列"当成功。
 * 不占 Body，但仍服从当前 run 的取消（signal）与连接门。
 */

import type { CallableDescriptor, CallContext, NativeCallable } from "../../contracts/capabilities.js";
import type { JsonValue } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { fail } from "../shared/targets.js";

/** 版本聊天上限：1.21 客户端单条 256 字符；Driver 不拆分、不截断。 */
const CHAT_LIMIT = 256;

const descriptor: CallableDescriptor = {
	ref: "chat@1",
	summary: "Send one chat line (or slash command) as the client; no body qualification required",
	tags: ["body", "communication"],
	input: {
		type: "object",
		properties: {
			text: {
				type: "string",
				minLength: 1,
				maxLength: CHAT_LIMIT,
				description: "Single line; a leading slash sends a server command; 256 UTF-16 units max",
			},
		},
		required: ["text"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: { sent: { type: "boolean" }, kind: { type: "string", enum: ["message", "command"] } },
		required: ["sent", "kind"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "execution",
		description:
			"The whole text entered the current connection's protocol send boundary; server delivery and command effects are separate facts",
	},
	errors: [
		{ code: "INVALID_INPUT", meaning: "empty, multi-line, NUL, or over the version limit" },
		{ code: "DISCONNECTED", meaning: "client is disconnected or gone" },
		{ code: "INTERRUPTED", meaning: "the run was stopped before dispatch" },
		{ code: "INTERNAL", meaning: "effect recorder faulted, or upstream chat rejected before dispatch" },
	],
	requires: ["connection"],
	examples: [
		{ input: { text: "hello" }, output: { sent: true, kind: "message" } },
		{ input: { text: "/list" }, output: { sent: true, kind: "command" } },
	],
	implementation: "native",
};

export function chatCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const text = (input as { text: string }).text;
			if (text.trim().length === 0) {
				fail("INVALID_INPUT", "chat text is blank", { hint: "send a non-empty line; the driver does not trim" });
			}
			if (/[\r\n]/.test(text)) {
				fail("INVALID_INPUT", "chat text contains a line break", { hint: "one call sends exactly one line" });
			}
			if (text.includes("\u0000")) {
				fail("INVALID_INPUT", "chat text contains a NUL byte");
			}
			if (text.length > CHAT_LIMIT) {
				fail("INVALID_INPUT", `chat text is ${text.length} UTF-16 units, limit is ${CHAT_LIMIT}`, {
					hint: "the driver does not split or truncate messages",
				});
			}
			const receipt = await deps.runtime().chat(text, ctx.signal);
			if (receipt.dispatch !== "sent") {
				fail("INTERNAL", `chat was not dispatched (dispatch=${receipt.dispatch})`, {
					dispatch: receipt.dispatch,
					effects: [receipt.effect],
					recoverable: false,
				});
			}
			return { sent: true, kind: text.startsWith("/") ? "command" : "message" };
		},
	};
}
