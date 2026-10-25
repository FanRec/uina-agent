/**
 * 靠近目标：可达性归调用方（capabilities.md §4），动作自己不做寻路算法，
 * 只在这一处表达"够不着就 goto 一次，委托身体则明确拒绝"。
 */
import type { SelfState } from "../../contracts/body.js";
import type { CallContext } from "../../contracts/capabilities.js";
import type { Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import { readValue } from "./observe.js";
import { BLOCK_REACH, blockReach } from "./reach.js";
import { fail } from "./targets.js";

/** 祖先已把身体委托下来：可以继续用它，但不能另起一条导航。 */
export function delegated(ctx: CallContext): boolean {
	return "player" in ctx;
}

export async function approachBlock(ctx: CallContext, position: Vec3, what: string): Promise<void> {
	if (ctx.signal.aborted) fail("INTERRUPTED", `${what} action was stopped`, { recoverable: false });
	const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
	if (blockReach(self, position) <= BLOCK_REACH) return;
	if (delegated(ctx)) {
		fail("CONTROL_CONFLICT", "delegated body cannot start an independent navigation", {
			hint: "goto@1 before the ancestor withBody; a delegated target must already be within reach",
		});
	}
	await ctx.call("goto@1", { at: plain(position), tolerance: 1, maxTimeMs: 30000 });
	if (ctx.signal.aborted) fail("INTERRUPTED", `${what} action was stopped`, { recoverable: false });
}
