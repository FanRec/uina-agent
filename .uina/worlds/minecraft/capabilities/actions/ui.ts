/**
 * ui.act@1：对"已经打开的服务器界面"做一次受控操作。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md#ui-act、public-api §4.5。
 *
 * 为什么与 container 系列分开：
 * - 菜单可能由 /menu、NPC 或聊天链接打开，没有 BlockTarget 可 openContainer；
 * - 菜单按钮是"点一下看服务器怎么反应"，不是物品搬运事务，不该背 CAS 预测的包袱；
 * - 物品搬运仍归 container@1 / window.click（WindowSession 的 CAS + diverged/unknown）。
 *
 * 每次调用只做三件事：校验观察前态（screenRef + uiRevision + buttonDigest）、
 * 派发一次真实协议包、报告界面是否转移。不重试、不预测业务成功。
 */

import type { BodyCallScope, CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { UiActInput, UiActOutcome } from "../../contracts/ui.js";
import type { JsonSchema, JsonValue } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import { fail } from "../shared/targets.js";

const STRING = { type: "string", minLength: 1 } as const;

const UI_ACT_INPUT: JsonSchema = {
	oneOf: [
		{
			type: "object",
			properties: {
				kind: { type: "string", enum: ["click_slot"] },
				screenRef: STRING,
				uiRevision: { type: "integer", minimum: 0 },
				slot: { type: "integer", minimum: 0 },
				button: { type: "string", enum: ["left", "right"] },
				buttonDigest: STRING,
			},
			required: ["kind", "screenRef", "uiRevision", "slot", "button", "buttonDigest"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				kind: { type: "string", enum: ["submit_dialog"] },
				screenRef: STRING,
				uiRevision: { type: "integer", minimum: 0 },
				buttonRef: STRING,
				values: { type: "object" },
			},
			required: ["kind", "screenRef", "uiRevision", "buttonRef"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				kind: { type: "string", enum: ["activate_text"] },
				eventRef: STRING,
				actionRef: STRING,
			},
			required: ["kind", "eventRef", "actionRef"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				kind: { type: "string", enum: ["close"] },
				screenRef: STRING,
				uiRevision: { type: "integer", minimum: 0 },
			},
			required: ["kind", "screenRef", "uiRevision"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				kind: { type: "string", enum: ["book_page"] },
				screenRef: STRING,
				uiRevision: { type: "integer", minimum: 0 },
				page: { type: "integer", minimum: 0 },
			},
			required: ["kind", "screenRef", "uiRevision", "page"],
			additionalProperties: false,
		},
	],
};

export const descriptor: CallableDescriptor = {
	ref: "ui.act@1",
	summary:
		"Act once on the server interface that is already open (click a menu slot, submit a dialog button, run a chat text action, or close the window)",
	tags: ["body", "ui"],
	input: UI_ACT_INPUT,
	output: {
		type: "object",
		properties: {
			outcome: {
				type: "string",
				enum: ["screen_opened", "screen_closed", "updated", "sent", "unknown", "unsupported"],
			},
			screenRef: { type: "string" },
			uiRevision: { type: "integer" },
			uiKind: { type: "string", enum: ["none", "container", "dialog", "book"] },
			detail: { type: "string" },
			elapsedMs: { type: "integer" },
		},
		required: ["outcome", "screenRef", "uiRevision", "detail"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "execution",
		description:
			"One write entered the current connection's protocol send boundary. outcome describes the interface observation that followed (screen_opened/screen_closed/updated) or 'sent' when no attributable change is expected. This is never a business-success claim: purchase/teleport/claim results must be verified with other facts",
	},
	errors: [
		{ code: "UI_STALE", meaning: "screenRef, uiRevision or buttonDigest no longer matches the current interface" },
		{ code: "INVALID_INPUT", meaning: "unknown slot, missing digest on an empty slot, or an undeclared dialog input" },
		{ code: "UNSUPPORTED_WINDOW", meaning: "the action kind has no serverbound encoding on 1.21.11" },
		{ code: "CONTROL_CONFLICT", meaning: "a container item transaction owns this body right now" },
		{ code: "CONTROL_INVALID", meaning: "no body qualification, or the run was stopped" },
		{ code: "DISCONNECTED", meaning: "client is disconnected or gone" },
	],
	requires: ["body", "connection"],
	examples: [
		{
			input: {
				kind: "click_slot",
				screenRef: "screen:ui1:3",
				uiRevision: 7,
				slot: 11,
				button: "left",
				buttonDigest: "9f2c1a",
			},
			output: {
				outcome: "screen_opened",
				screenRef: "screen:ui1:4",
				uiRevision: 9,
				detail: "the server replaced the interface",
			},
		},
		{
			input: {
				kind: "submit_dialog",
				screenRef: "dialog:ui1:play:2",
				uiRevision: 12,
				buttonRef: "dialog:ui1:play:2/b0",
				values: {},
			},
			output: { outcome: "sent", screenRef: "dialog:ui1:play:2", uiRevision: 12, detail: "no attributable change" },
		},
		{
			input: { kind: "close", screenRef: "screen:ui1:3", uiRevision: 7 },
			output: { outcome: "screen_closed", screenRef: "none", uiRevision: 8, detail: "the server closed the interface" },
		},
	],
	implementation: "native",
};

/** outcome → 面向调用方的下一步提示（不是业务结论）。 */
function hintOf(outcome: UiActOutcome): string | null {
	switch (outcome) {
		case "screen_opened":
		case "screen_closed":
		case "updated":
			return "re-read ui@1: the interface changed, and the new screenRef/uiRevision are the only valid basis for the next action";
		case "sent":
			return "no interface change was observed; the button may only run a command. Check chat/events@1 and world facts before assuming the business effect";
		case "unknown":
			return "the write may or may not have left the client; re-read ui@1 before acting again, and do not replay the same business click blindly";
		case "unsupported":
			return "this action has no serverbound encoding on this protocol version";
	}
}

export const uiActModule: MinecraftCapabilityModule = {
	id: "ui-act",
	definitions: [
		{
			kind: "action",
			descriptor,
			bind:
				() =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const request = input as UiActInput;
					return ctx.withBody(async (scope: BodyCallScope) => {
						const receipt = await scope.player.uiAct(request);
						const hint = hintOf(receipt.outcome);
						if (receipt.dispatch === "not_sent") {
							fail("CONTROL_INVALID", `ui.act was not dispatched (${receipt.diagnostics.detail})`, {
								dispatch: "not_sent",
								recoverable: true,
								...(hint == null ? {} : { hint }),
							});
						}
						return {
							outcome: receipt.outcome,
							screenRef: receipt.screen?.screenRef ?? "none",
							uiRevision: receipt.screen?.uiRevision ?? receipt.diagnostics.uiRevisionAfter,
							uiKind: receipt.screen?.kind ?? "none",
							detail: receipt.diagnostics.detail,
							elapsedMs: receipt.diagnostics.elapsedMs,
						} as JsonValue;
					});
				},
		},
	],
};
