/**
 * 观察窗口：动作派发后按固定预算复读事实，决定 met / not_met / unknown。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §2.5、§4；经验见
 * dev/MC-WORLD.md 第 9 条（服务端确认窗口）。预算集中在各能力文件顶部，
 * 不做用户配置，也不把"等久一点"当成成功。
 */

import type { ExactRef, JsonValue, Observation } from "../../contracts/values.js";
import type { WorldReadPort } from "../../contracts/world.js";
import { fail } from "./targets.js";

export interface PollOptions {
	timeoutMs: number;
	intervalMs: number;
	signal: AbortSignal;
}

export interface PollResult<T> {
	ok: boolean;
	/** 最后一次观察（超时时可用于解释现状）。 */
	last: T | null;
	elapsedMs: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortReason());
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortReason());
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function abortReason(): Error {
	const err = new Error("observation window interrupted");
	err.name = "AbortError";
	return err;
}

/**
 * 轮询直到 done；超时返回 ok=false 与最后一次观察。
 * 中止不是超时：立刻抛 INTERRUPTED，让调用方按已派发/未知结算。
 */
export async function pollUntil<T>(
	probe: () => Promise<T>,
	done: (value: T) => boolean,
	options: PollOptions,
): Promise<PollResult<T>> {
	const startedAt = Date.now();
	let last: T | null = null;
	for (;;) {
		if (options.signal.aborted) {
			fail("INTERRUPTED", "observation window interrupted by run stop", {
				dispatch: "sent",
				recoverable: true,
			});
		}
		last = await probe();
		if (done(last)) return { ok: true, last, elapsedMs: Date.now() - startedAt };
		const elapsed = Date.now() - startedAt;
		if (elapsed >= options.timeoutMs) return { ok: false, last, elapsedMs: elapsed };
		await sleep(Math.min(options.intervalMs, options.timeoutMs - elapsed), options.signal);
	}
}

/** 读一个查询值并保证 value 非 null（null 表示当前不可得，按 WRONG_STATE 如实失败）。 */
export async function readValue<T>(
	world: WorldReadPort,
	ref: ExactRef,
	input: JsonValue,
	signal: AbortSignal,
	what: string,
): Promise<T> {
	const observation = (await world.read<T>({ ref, input })) as Observation<T>;
	void signal;
	if (observation.value == null) {
		fail("WRONG_STATE", `${what} is not available: ${observation.unknown.join("; ") || "unknown"}`, {
			hint: `coverage=${observation.coverage}`,
			recoverable: true,
		});
	}
	return observation.value;
}

/**
 * 整次调用的墙钟预算：中断立刻上抛，超时按 TIMEOUT 结算。
 * 与 pollUntil 分开是因为调用方在两次观察之间还要做别的派发。
 */
export function checkBudget(ctx: { signal: AbortSignal }, deadline: number, what: string): void {
	if (ctx.signal.aborted) fail("INTERRUPTED", `${what} action was stopped`, { recoverable: false });
	if (Date.now() >= deadline) fail("TIMEOUT", `${what} exceeded its time budget`);
}

/** 等待墙钟但不持身体、不开窗口（世界侧等待的唯一写法）。 */
export async function waitFor(ctx: { signal: AbortSignal }, delayMs: number, what: string): Promise<void> {
	checkBudget(ctx, Number.POSITIVE_INFINITY, what);
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			try {
				checkBudget(ctx, Number.POSITIVE_INFINITY, what);
			} catch (error) {
				reject(error);
			}
		};
		const timer = setTimeout(() => {
			ctx.signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		ctx.signal.addEventListener("abort", onAbort, { once: true });
	});
}
