/**
 * 靠近目标：可达性归调用方（capabilities.md §4），动作自己不做寻路算法，
 * 只在这一处表达"够不着就 goto 一次，委托身体则明确拒绝"。
 *
 * 换位（§5 局部自治）也在这里：目标够近但 Driver 判定视线受阻时，允许在
 * **释放 Body 之后**走到少量无需挖掘/搭建的合法站位再重试。候选只表达
 * "接下来去哪儿尝试"，能不能点仍由派发时的 Driver 决定。
 */
import type { SelfState } from "../../contracts/body.js";
import type { BodyCallScope, CallContext } from "../../contracts/capabilities.js";
import type { CallFailure, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import { isReplaceableName } from "../../construction/target.js";
import { readValue } from "./observe.js";
import { BLOCK_REACH, blockReach } from "./reach.js";
import { fail } from "./targets.js";
import { readObservation } from "./views.js";

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

/**
 * Driver 在派发前拒绝、且确认没有发出任何写：只有这种失败允许换位重试。
 * 已派发或效果未知的交互绝不因为换一个站位再发一次。
 */
export function blockedInteraction(error: unknown): boolean {
	const failure = error as Partial<CallFailure> | null;
	return failure?.name === "CallFailure" && failure.code === "UNREACHABLE" && failure.dispatch === "not_sent";
}

/** 站位候选最多试两个：局部自治有界，不变成通用 Planner。 */
export const RELOCATION_LIMIT = 2;

interface RegionSample {
	origin: Vec3;
	shape: [number, number, number];
	palette: { name: string }[];
	cells: number[];
}

/** 一次读回目标周围 5×3×5 的体素；未加载格返回 null（未知不当空气）。 */
async function readVoxels(ctx: CallContext, from: Vec3, to: Vec3): Promise<(position: Vec3) => string | null> {
	const observation = await readObservation<RegionSample>(ctx.world, "region@1", plain({ from, to }));
	const sample = observation.value;
	if (sample == null) return () => null;
	const [nx, ny, nz] = sample.shape;
	return (position) => {
		const dx = position.x - sample.origin.x;
		const dy = position.y - sample.origin.y;
		const dz = position.z - sample.origin.z;
		if (dx < 0 || dy < 0 || dz < 0 || dx >= nx || dy >= ny || dz >= nz) return null;
		const index = dy * nx * nz + dz * nx + dx;
		return sample.palette[sample.cells[index] ?? -1]?.name ?? null;
	};
}

const isAirName = (name: string): boolean =>
	name === "air" ||
	name === "minecraft:air" ||
	name === "cave_air" ||
	name === "minecraft:cave_air" ||
	name === "void_air" ||
	name === "minecraft:void_air";

/** 目标周围的局部站位环：一圈 8 格 + 距离 2 的四个正面。 */
const RELOCATION_RINGS: readonly (readonly [number, number])[] = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
	[1, 1],
	[1, -1],
	[-1, 1],
	[-1, -1],
	[2, 0],
	[-2, 0],
	[0, 2],
	[0, -2],
];

/**
 * 目标周围"站得住且不用改地形"的候选站位，按水平距离排序。
 *
 * 只读世界、不宣称能点：脚位与头位必须是空气、脚下必须是实心方块，
 * 距离只做初筛；真正的可达性由 goto 与派发时的 Driver 射线判定。
 */
export async function relocationSpots(ctx: CallContext, target: Vec3, self: SelfState): Promise<Vec3[]> {
	// 站人候选可以比目标低两格（墙顶的屋顶格要从地面跳放），它的脚下格就再低一格：
	// 区域必须多读两层，否则低两格的候选"脚下读不到"被跳过（真服实测：3×3 木屋
	// 只剩前墙上角时，屋外地面站位全在区域外，候选为 0）。
	const from = { x: target.x - 2, y: target.y - 3, z: target.z - 2 };
	const to = { x: target.x + 2, y: target.y + 1, z: target.z + 2 };
	const voxel = await readVoxels(ctx, from, to);
	const here = {
		x: Math.floor(self.place.position.x),
		y: Math.floor(self.place.position.y),
		z: Math.floor(self.place.position.z),
	};
	const spots: { at: Vec3; score: number }[] = [];
	const seen = new Set<string>();
	for (const [dx, dz] of RELOCATION_RINGS) {
		for (const dy of [0, -1, -2]) {
			const at = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
			const key = `${at.x},${at.y},${at.z}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (at.x === here.x && at.y === here.y && at.z === here.z) continue;
			const feet = voxel(at);
			const head = voxel({ x: at.x, y: at.y + 1, z: at.z });
			const below = voxel({ x: at.x, y: at.y - 1, z: at.z });
			if (feet == null || head == null || below == null) continue;
			if (!isAirName(feet) || !isAirName(head)) continue;
			if (isReplaceableName(below)) continue;
			const horizontal = Math.hypot(dx, dz);
			if (horizontal > BLOCK_REACH - 1) continue;
			spots.push({ at, score: horizontal + Math.abs(dy) * 0.4 });
		}
	}
	return spots.sort((a, b) => a.score - b.score).map((spot) => spot.at);
}

/**
 * 换位尝试的诊断：候选走了几个、真正走到了几个。
 * 调用方用它把 remaining 的原因写准——"没走到"和"走到了仍被挡"是两件事。
 */
export interface RelocationTrace {
	tried: number;
	reached: number;
}

export interface RelocationOptions {
	/** 诊断计数（可选）。 */
	trace?: RelocationTrace;
	/** 每个候选站位的 goto 预算；施工批量放置要短（默认 15s 会把预算耗光）。 */
	maxWalkMs?: number;
}

/**
 * 在 Block 目标上执行一次身体工作；Driver 以"视线受阻/未派发"拒绝时，
 * 释放 Body、走到最多两个候选站位、重新取 Body 再试一次。
 *
 * 只在 withBody 之外导航（不在已持有的身体里嵌套 goto）；work 里的窗口
 * 写操作一旦开始，任何失败都按原语义冒泡，不换位重放。
 */
export async function withRelocation<T>(
	ctx: CallContext,
	position: Vec3,
	what: string,
	work: (scope: BodyCallScope) => Promise<T>,
	options: RelocationOptions = {},
): Promise<T> {
	const trace = options.trace;
	try {
		return await ctx.withBody(work);
	} catch (error) {
		if (!blockedInteraction(error) || delegated(ctx)) throw error;
		const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
		const spots = await relocationSpots(ctx, position, self);
		let last: unknown = error;
		for (const spot of spots.slice(0, RELOCATION_LIMIT)) {
			if (ctx.signal.aborted) fail("INTERRUPTED", `${what} action was stopped`, { recoverable: false });
			if (trace != null) trace.tried += 1;
			try {
				await ctx.call("goto@1", {
					at: plain(spot),
					tolerance: 1,
					maxTimeMs: options.maxWalkMs ?? 15000,
				});
			} catch {
				// 走不到这个候选就换下一个；候选本身不宣称可站，只表达尝试。
				continue;
			}
			if (trace != null) trace.reached += 1;
			try {
				return await ctx.withBody(work);
			} catch (next) {
				if (!blockedInteraction(next)) throw next;
				last = next;
			}
		}
		throw last;
	}
}
