/**
 * 测试样板共享件：native callable 构建器、CallFailure 捕获、轮询等待。
 *
 * 只收编各测试文件逐字重复的样板；summary/completion 等进入生产校验路径的字段
 * 一律由调用方显式给值（缺省值仅对应 decision/durable-wait 原有的 `native()`），
 * 不引入任何测试此前没有的默认语义。
 */

import type { NativeCallable } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { CallFailure, ExactRef, JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";

/**
 * 构建一个 native 动作的 NativeCallable：descriptor 形状全仓一致，
 * summary / completion 由调用方按各文件原有取值显式传入。
 */
export function nativeCallable(
	ref: ExactRef,
	invoke: NativeCallable<JsonValue, JsonValue>["invoke"],
	options: {
		summary?: string;
		completion?: { scope: "execution" | "capability"; description: string };
	} = {},
): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: {
			ref,
			summary: options.summary ?? ref,
			input: {},
			output: {},
			access: "act",
			completion: options.completion ?? { scope: "execution", description: ref },
			errors: [],
			requires: [],
			examples: [],
			implementation: "native",
		},
		invoke,
	};
}

/** 捕获 CallFailure；调用未失败时显式失败。异步（Promise）版。 */
export async function captureFailure(promise: Promise<unknown>): Promise<CallFailure> {
	try {
		await promise;
	} catch (err) {
		return err as CallFailure;
	}
	throw new Error("expected the call to reject with CallFailure, but it resolved");
}

/** 捕获 CallFailure；调用未失败时显式失败。同步（thunk）版。 */
export function captureFailureSync(run: () => unknown): CallFailure {
	try {
		run();
	} catch (err) {
		return err as CallFailure;
	}
	throw new Error("expected the call to throw CallFailure, but it returned");
}

/** 条件轮询：超时显式失败，不把"还没到"静默当成通过。 */
export async function pollUntil(condition: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`condition not met in time (${timeoutMs}ms)`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
