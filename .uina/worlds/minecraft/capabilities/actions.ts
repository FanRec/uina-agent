/**
 * K1 动作子集：chat@1 与 goto@1（I1 原生 callable）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §3；plan §9。
 * chat 经 Runtime chat 旁路（不占 Body，效果归属当前调用 frame）；goto 经
 * Runtime 受控独占导航作用域包住 Driver GotoDirector（独占期效果归属当前调用）。
 * 输入校验由 Runtime 受理时按 descriptor schema 完成（Ajv）；此处只补默认值。
 * 输出仅投影 EffectReceipt 的判断面；效果事实本体经 runtime.readRecord 读取。
 */

import type { ControlOwner } from "../contracts/body.js";
import type { CallContext, CallableDescriptor, NativeCallable } from "../contracts/capabilities.js";
import type { EffectReceipt, JsonValue, JsonSchema, Ref, Vec3 } from "../contracts/values.js";
import type { GotoDirector, GotoRequest } from "../driver/goto.js";

/** 能力层使用的 Runtime 接缝（结构最小面；组合根注入 MinecraftRuntime）。 */
export interface CapabilityRuntime {
	/** chat 旁路（不占 Body）；必须在活动调用 frame 内使用。 */
	chat(text: string, signal: AbortSignal): Promise<EffectReceipt>;
	/** 受控独占导航作用域；独占期内效果事实归属给定 owner。 */
	navigate<T>(owner: ControlOwner, fn: () => Promise<T>): Promise<T>;
}

export interface ActionDeps {
	/** open 完成前调用显式失败（受理只会发生在 open 之后）。 */
	runtime: () => CapabilityRuntime;
	gotoDirector: GotoDirector;
}

const GOTO_AT_SCHEMA: JsonSchema = {
	type: "object",
	properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
	required: ["x", "y", "z"],
	additionalProperties: false,
};

const DISPATCH_ENUM: JsonSchema = { type: "string", enum: ["not_sent", "sent", "unknown"] };
const COMPLETION_ENUM: JsonSchema = { type: "string", enum: ["met", "not_met", "unknown"] };

const RECEIPT_PROJECTION: JsonSchema = {
	type: "object",
	properties: {
		effect: { type: "string" },
		dispatch: DISPATCH_ENUM,
		completion: COMPLETION_ENUM,
	},
	required: ["effect", "dispatch", "completion"],
	additionalProperties: false,
};

const chatDescriptor: CallableDescriptor = {
	ref: "chat@1",
	summary: "Send one chat line (or slash command) as the client; no body qualification required",
	tags: ["body", "communication"],
	input: {
		type: "object",
		properties: {
			text: {
				type: "string",
				minLength: 1,
				maxLength: 256,
				description: "Single line; the version chat limit is 256 and the driver rejects instead of splitting",
			},
		},
		required: ["text"],
		additionalProperties: false,
	},
	output: RECEIPT_PROJECTION,
	access: "act",
	completion: {
		scope: "execution",
		description:
			"Chat completes when the text has been handed to the protocol layer in a single write; server delivery and command effects are separate facts",
	},
	errors: [
		{ code: "INVALID_INPUT", meaning: "text is empty, multi-line, or over the version chat limit" },
		{ code: "DISCONNECTED", meaning: "client is disconnected or gone" },
		{ code: "INTERRUPTED", meaning: "the run was stopped before dispatch" },
		{ code: "INTERNAL", meaning: "effect recorder faulted, or upstream chat rejected before dispatch" },
	],
	requires: ["connection"],
	examples: [{ input: { text: "hello" }, output: { effect: "eff:1", dispatch: "sent", completion: "met" } }],
	implementation: "native",
};

const gotoDescriptor: CallableDescriptor = {
	ref: "goto@1",
	summary:
		"Walk the client to a target position (controlled exclusive navigation; mutually exclusive with body qualifications)",
	tags: ["body", "navigation"],
	input: {
		type: "object",
		properties: {
			at: GOTO_AT_SCHEMA,
			tolerance: { type: "integer", minimum: 1, maximum: 8, description: "GoalNear radius in blocks" },
			sprint: { type: "boolean" },
			digThrough: { type: "boolean" },
			timeoutMs: {
				type: "number",
				minimum: 1000,
				maximum: 600000,
				description: "Wall-clock budget; timeout is reported, never success",
			},
		},
		required: ["at"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			effect: { type: "string" },
			at: GOTO_AT_SCHEMA,
			ticks: { type: "integer", minimum: 0 },
			dispatch: DISPATCH_ENUM,
			completion: COMPLETION_ENUM,
		},
		required: ["effect", "at", "ticks", "dispatch", "completion"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "execution",
		description:
			"Goto completes when GoalNear proximity is satisfied; standing-posture verification belongs to later capability work",
	},
	errors: [
		{ code: "UNREACHABLE", meaning: "pathfinder found no path or could not plan within its think budget" },
		{ code: "TIMEOUT", meaning: "wall-clock budget exhausted before arrival" },
		{ code: "CONTROL_CONFLICT", meaning: "a body qualification or another navigation holds the client" },
		{ code: "INTERRUPTED", meaning: "the run was stopped before arrival" },
		{ code: "DISCONNECTED", meaning: "the connection ended during navigation" },
		{ code: "INVALID_INPUT", meaning: "non-finite target, or tolerance/timeout out of range" },
	],
	requires: ["connection"],
	examples: [
		{
			input: { at: { x: 8, y: 64, z: 0 }, tolerance: 2 },
			output: { effect: "eff:2", at: { x: 7.5, y: 64, z: 0 }, ticks: 24, dispatch: "sent", completion: "met" },
		},
	],
	implementation: "native",
};

function chatCallable(deps: ActionDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: chatDescriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const { text } = input as { text: string };
			const receipt = await deps.runtime().chat(text, ctx.signal);
			return { effect: receipt.effect, dispatch: receipt.dispatch, completion: receipt.completion };
		},
	};
}

function gotoCallable(deps: ActionDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: gotoDescriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as unknown as {
				at: Vec3;
				tolerance?: number;
				sprint?: boolean;
				digThrough?: boolean;
				timeoutMs?: number;
			};
			const request: GotoRequest = {
				at: raw.at,
				tolerance: raw.tolerance ?? 2,
				sprint: raw.sprint ?? false,
				digThrough: raw.digThrough ?? false,
				timeoutMs: raw.timeoutMs ?? 30000,
			};
			const owner: ControlOwner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId };
			const outcome = await deps.runtime().navigate(owner, () => deps.gotoDirector.goto(request, ctx.signal));
			const at = outcome.at;
			return {
				effect: outcome.receipt.effect,
				at: { x: at.x, y: at.y, z: at.z },
				ticks: outcome.ticks,
				dispatch: outcome.receipt.dispatch,
				completion: outcome.receipt.completion,
			};
		},
	};
}

export interface BuiltActions {
	callables: NativeCallable<JsonValue, JsonValue>[];
	refs: Ref[];
}

export function createActions(deps: ActionDeps): BuiltActions {
	const callables = [chatCallable(deps), gotoCallable(deps)];
	const seen = new Set<string>();
	for (const callable of callables) {
		if (seen.has(callable.descriptor.ref)) {
			throw new Error(`duplicate callable ref: ${callable.descriptor.ref}`);
		}
		seen.add(callable.descriptor.ref);
	}
	return { callables, refs: [...seen] };
}
