/**
 * sleep@1 / fish@1（批 18）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 sleep/fish、
 * development-plan.md §10.3 验收口径。
 * 纪律（真服探针 2026-11-01，archive 待归档）：
 * - sleep：前置自检（夜间/占床/有怪/射程）不取身体；入睡证据 = pose 元数据（bot sleep 事件，
 *   经 awaitBodyEvent 窗口）；服务端拒绝无事件；唤醒 = entity_action stop_sleeping（actionId 0，
 *   mineflayer bed.js 的 2 在 1.21.11 是 stop_sprinting——不用 bot.wake）。
 * - fish：抛竿/收竿 = useItem/endUse（finally 必收竿）；咬钩 = world_particles
 *   fishing|bubble×6 距鱼漂 ≤1.23（协议窄口判据）；捕获物落在鱼漂附近，不自动入包
 *   （实测 salmon 掉落 3.9 格），收竿后走近拾取由本动作的短距 drive-walk 兜底。
 */

import type { SelfState } from "../../contracts/body.js";
import type { BodyCallScope, CallableDescriptor, CallContext, NativeCallable } from "../../contracts/capabilities.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import {
	BED_NAMES,
	DAY_TICKS_MAX,
	isBedName,
	isNightTicks,
	NIGHT_TICKS_MAX,
	NIGHT_TICKS_MIN,
	SLEEP_MONSTER_RADIUS,
} from "../shared/activity.js";
import { readValue } from "../shared/observe.js";
import { BLOCK_REACH, blockReach, round2 } from "../shared/reach.js";
import { GRID_POS_SCHEMA } from "../shared/schema.js";
import { fail, resolveGrid } from "../shared/targets.js";
import { readBlockAt, readInventory } from "../shared/views.js";

// ---- 共用小件 ----

interface WorldView {
	dimension: string;
	timeOfDay: string;
	ticks: number;
	weather: string;
}

async function readWorld(ctx: CallContext): Promise<WorldView> {
	return await readValue<WorldView>(ctx.world, "world@1", {}, ctx.signal, "world state");
}

function interrupted(progress: Record<string, unknown>): never {
	fail("INTERRUPTED", "the run was stopped or safety took over mid-action", {
		dispatch: "sent",
		progress,
		recoverable: true,
	});
}

function placeOf(self: SelfState, position: Vec3) {
	return {
		world: self.place.world,
		worldRevision: self.place.worldRevision,
		dimension: self.place.dimension,
		position,
	};
}

function flatDistance(a: Vec3, b: Vec3): number {
	return Math.hypot(a.x - b.x, a.z - b.z);
}

// ---- sleep@1 ----

const sleepDescriptor: CallableDescriptor = {
	ref: "sleep@1",
	summary: "Find a bed nearby (or at `at`) and sleep until morning; refuses with reasons instead of guessing",
	tags: ["body", "activity"],
	input: {
		type: "object",
		properties: { at: GRID_POS_SCHEMA },
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			slept: { type: "boolean" },
			at: { type: "object" },
			until: { type: "string" },
		},
		required: ["slept", "at", "until"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"slept=true means the wake observation arrived and world ticks are back in day range; night/occupied/monster refusals fail before dispatch",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no bed block within 16 blocks (or none at `at`)" },
		{ code: "UNREACHABLE", meaning: "the bed is out of interaction range (walk there first)" },
		{ code: "WRONG_STATE", meaning: "not night, or hostiles near the bed" },
		{ code: "TARGET_NOT_MET", meaning: "the bed is occupied, or the server refused within the evidence window" },
		{ code: "TIMEOUT", meaning: "still night after the morning wait budget (others not sleeping)" },
		{ code: "INTERRUPTED", meaning: "stopped/safety mid-sleep; wakes up before returning" },
	],
	requires: ["connection", "body"],
	examples: [
		{
			input: {},
			output: { slept: true, at: { position: { x: 10, y: 64, z: 3 }, dimension: "overworld" }, until: "morning" },
		},
	],
	implementation: "native",
};

interface SleepInput {
	at?: unknown;
}

const SLEEP_WAIT_WINDOW_MS = 5000;
const MORNING_BUDGET_MS = 90_000;

async function findBed(ctx: CallContext, self: SelfState, raw: SleepInput): Promise<{ position: Vec3; name: string }> {
	if (raw.at != null) {
		const position = resolveGrid(raw.at, self);
		const block = await readBlockAt(ctx.world, position);
		if (block == null) fail("NOT_FOUND", `no block at ${position.x},${position.y},${position.z}`);
		if (!isBedName(block.name))
			fail("NOT_FOUND", `${block.name} at ${position.x},${position.y},${position.z} is not a bed`);
		return { position, name: block.name };
	}
	// 就近搜索：16 色并查（blocks@1 单名限制），取最近。
	const searches = await Promise.all(
		BED_NAMES.map(async (name) => {
			const view = await readValue<{ blocks: { position: Vec3; name: string }[] | null }>(
				ctx.world,
				"blocks@1",
				{ name, radius: 16, limit: 8 },
				ctx.signal,
				"bed search",
			);
			return view.blocks ?? [];
		}),
	);
	let best: { position: Vec3; name: string } | null = null;
	for (const matches of searches) {
		for (const match of matches) {
			if (
				best == null ||
				flatDistance(self.place.position, match.position) < flatDistance(self.place.position, best.position)
			) {
				best = match;
			}
		}
	}
	if (best == null)
		fail("NOT_FOUND", "no bed block within 16 blocks", { hint: "beds beyond loaded range are invisible to blocks@1" });
	return best;
}

export function sleepCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	void deps;
	return {
		descriptor: sleepDescriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as SleepInput;
			const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			const world = await readWorld(ctx);
			if (!isNightTicks(world.ticks) && world.weather !== "thunder") {
				fail(
					"WRONG_STATE",
					`not night (ticks=${String(world.ticks)}); sleep needs ticks ${String(NIGHT_TICKS_MIN)}..${String(NIGHT_TICKS_MAX)}`,
					{
						hint: "use chat@1 `/time set night` only in controlled scenarios",
					},
				);
			}
			const bed = await findBed(ctx, self, raw);
			const reach = blockReach(self, bed.position);
			if (reach > BLOCK_REACH) {
				fail("UNREACHABLE", `bed is out of reach (${round2(reach)} > ${BLOCK_REACH})`, {
					hint: "goto@1 closer first; sleep does not path",
				});
			}
			const bedBlock = await readBlockAt(ctx.world, bed.position);
			if (bedBlock != null && bedBlock.properties.occupied === "true") {
				fail("TARGET_NOT_MET", "the bed is occupied", { hint: "another entity sleeps here" });
			}
			const near = await readValue<{ entities: { name: string; kind: string; position: Vec3 }[] | null }>(
				ctx.world,
				"entities@1",
				{ radius: SLEEP_MONSTER_RADIUS, kind: "all", limit: 64 },
				ctx.signal,
				"monster check",
			);
			const monsters = (near.entities ?? []).filter(
				(entity) => entity.kind === "hostile" && flatDistance(entity.position, bed.position) <= SLEEP_MONSTER_RADIUS,
			);
			if (monsters.length > 0) {
				fail("WRONG_STATE", `${monsters.length} hostile(s) within ${String(SLEEP_MONSTER_RADIUS)} blocks of the bed`, {
					hint: `nearest: ${monsters
						.slice(0, 3)
						.map((entity) => entity.name)
						.join(", ")}`,
				});
			}

			return await ctx.withBody(async (scope: BodyCallScope) => {
				const inventory = await readInventory(scope.world);
				if (inventory.held != null) {
					// 腾空主手：手持物品点床会先触发物品交互而不是入睡。
					await scope.player.equip(null, "hand");
				}
				try {
					await scope.player.interact({
						target: { place: placeOf(self, bed.position), block: bed.position },
						hand: "main",
					});
					const sleep = await scope.player.awaitBodyEvent("sleep", { evidenceMs: 3000 });
					if (sleep.observed === null) interrupted({ phase: "entering_sleep" });
					if (sleep.observed !== true) {
						fail("TARGET_NOT_MET", "the server refused sleep within the evidence window", {
							hint: "re-read block@1 occupied and entities@1 hostiles; the refusal reason is not observable in this protocol path",
							dispatch: "sent",
						});
					}
					// 睡到天亮：优先以服务端时间跳变为完成判据，wake 事件只是提前退出信号。
					const deadline = Date.now() + MORNING_BUDGET_MS;
					for (;;) {
						if (ctx.signal.aborted) interrupted({ phase: "waiting_morning" });
						const now = await readWorld(scope);
						if (now.ticks < DAY_TICKS_MAX || now.ticks > NIGHT_TICKS_MAX) break;
						if (Date.now() >= deadline) {
							fail("TIMEOUT", "still night after the 90s morning wait", {
								hint: "other players may be holding the night; retry sleep@1 later",
								dispatch: "sent",
								progress: { phase: "waiting_morning", ticks: now.ticks },
							});
						}
						const wake = await scope.player.awaitBodyEvent("wake", { evidenceMs: SLEEP_WAIT_WINDOW_MS });
						if (wake.observed === null) interrupted({ phase: "waiting_morning" });
					}
					return plain({
						slept: true,
						at: { position: bed.position, dimension: self.place.dimension },
						until: "morning",
					});
				} finally {
					// 中断也要醒过来：睡态不跨调用残留（验收口径：取消如实）。
					try {
						await scope.player.endSleep();
					} catch {
						// 未入睡或连接已亡时为 not_sent；不吞掉真正的派发结论
					}
				}
			});
		},
	};
}

// ---- fish@1 ----

const fishDescriptor: CallableDescriptor = {
	ref: "fish@1",
	summary: "Cast a fishing rod, reel on bite, and collect what lands; every cast retracts even on timeout",
	tags: ["body", "activity"],
	input: {
		type: "object",
		properties: {
			maxTimeMs: { type: "number", minimum: 5000, maximum: 600000, description: "wall-clock budget (default 60000)" },
		},
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			caught: {
				type: "array",
				items: {
					type: "object",
					properties: { item: { type: "string" }, count: { type: "number" } },
					required: ["item", "count"],
					additionalProperties: false,
				},
			},
			casts: { type: "number" },
		},
		required: ["caught", "casts"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"caught aggregates the inventory delta observed after each bite; rewards that never reached the inventory stay on the ground and are not claimed",
	},
	errors: [
		{ code: "MISSING_MATERIAL", meaning: "no fishing_rod in the inventory" },
		{ code: "WRONG_STATE", meaning: "no bobber appeared after the cast (not facing water)" },
		{ code: "TIMEOUT", meaning: "budget exhausted with no bite (progress keeps casts)" },
		{ code: "INTERRUPTED", meaning: "stopped/safety mid-fishing; the rod is retracted before returning" },
	],
	requires: ["connection", "body"],
	examples: [{ input: { maxTimeMs: 60000 }, output: { caught: [{ item: "cod", count: 1 }], casts: 1 } }],
	implementation: "native",
};

interface FishInput {
	maxTimeMs?: number;
}

const BITE_WINDOW_MS = 30_000;
const COLLECT_POLL_MS = 4000;

function diffCounts(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const delta = (after[name] ?? 0) - (before[name] ?? 0);
		if (delta > 0) out[name] = delta;
	}
	return out;
}

async function pollInventoryDelta(
	scope: BodyCallScope,
	before: Record<string, number>,
	windowMs: number,
	signal: AbortSignal,
): Promise<Record<string, number>> {
	const deadline = Date.now() + windowMs;
	for (;;) {
		if (signal.aborted) return {};
		const after = await readInventory(scope.world);
		const delta = diffCounts(before, after.counts);
		if (Object.keys(delta).length > 0) return delta;
		if (Date.now() >= deadline) return {};
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
}

export function fishCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	void deps;
	return {
		descriptor: fishDescriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as FishInput;
			const inventory = await readInventory(ctx.world);
			if ((inventory.counts["fishing_rod"] ?? 0) <= 0) {
				fail("MISSING_MATERIAL", "no fishing_rod in the inventory");
			}
			const deadline = Date.now() + (raw.maxTimeMs ?? 60_000);
			let casts = 0;
			const caught: Record<string, number> = {};
			// 已抛竿的鱼漂实体 id；null = 没有竿在外。1.21.11 的收竿 = 再发一次 use_item
			//（endUse 的 bot.usingHeldItem 守卫对竿不成立——竿不是"使用中"状态，真服实证）。
			let castOut: number | null = null;

			return await ctx.withBody(async (scope: BodyCallScope) => {
				// 已手持鱼竿就不再点击（手持槽自换会产生不可确认的窗口点击，真服实证）。
				if ((await readInventory(scope.world)).held?.name !== "fishing_rod") {
					await scope.player.equip({ name: "fishing_rod" }, "hand");
				}
				const retract = async (): Promise<void> => {
					const out = castOut;
					castOut = null;
					if (out == null) return;
					try {
						// 闲置咬钩后服务端已自动收竿；鱼漂不在了就别再发 use_item（会变成新的一抛）。
						const around = await readValue<{ entities: { ref: { networkId: number } }[] | null }>(
							scope.world,
							"entities@1",
							{ radius: 32, kind: "all", limit: 128 },
							scope.signal,
							"bobber check",
						);
						if ((around.entities ?? []).some((entity) => entity.ref.networkId === out)) {
							await scope.player.useItem("main");
						}
					} catch {
						// 连接已亡时输入随连接消亡
					}
				};
				try {
					for (;;) {
						if (ctx.signal.aborted) interrupted({ casts, caught });
						if (Date.now() >= deadline) {
							await retract();
							fail("TIMEOUT", `no bite within the budget after ${String(casts)} cast(s)`, {
								dispatch: "sent",
								progress: { casts, caught },
							});
						}
						await scope.player.useItem("main");
						casts++;
						const bobber = await scope.player.awaitBodyEvent("bobber", { evidenceMs: 3000 });
						if (bobber.observed === null) interrupted({ casts, caught });
						if (bobber.observed !== true) {
							await retract();
							fail("WRONG_STATE", "no bobber appeared after the cast", {
								hint: "face open water within ~20 blocks; the cast reached the server but no bobber spawned",
								dispatch: "sent",
								progress: { casts },
							});
						}
						castOut = bobber.vehicleId ?? null;
						// 落点水面核验：鱼漂出生在玩家眼高，满力抛竿飞行约 1 秒——先等落定
						//（位置连续两次读数一致），再判所在格与其下一格是否水。
						const at = await bobberLandedAt(scope, bobber.vehicleId ?? null);
						if (at != null) {
							const here = await readBlockAt(scope.world, {
								x: Math.floor(at.x),
								y: Math.floor(at.y),
								z: Math.floor(at.z),
							});
							const wet = here != null && (here.name === "water" || here.name === "flowing_water");
							const below = wet
								? here
								: await readBlockAt(scope.world, {
										x: Math.floor(at.x),
										y: Math.floor(at.y) - 1,
										z: Math.floor(at.z),
									});
							if (below == null || (below.name !== "water" && below.name !== "flowing_water")) {
								await retract();
								fail(
									"WRONG_STATE",
									`the bobber landed on ${below?.name ?? here?.name ?? "nothing"} at ${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)} — cast toward open water`,
									{
										hint: "face the water and retry; bites only happen with the bobber on water",
										dispatch: "sent",
										progress: { casts, bobberAt: at },
									},
								);
							}
						}
						const bite = await scope.player.awaitBodyEvent("bite", {
							evidenceMs: Math.min(BITE_WINDOW_MS, Math.max(1000, deadline - Date.now())),
						});
						// 收竿无条件先于结算：超时/无咬钩也不能把鱼漂留在水里（验收口径）。
						await scope.player.useItem("main");
						castOut = null;
						if (bite.observed === null) interrupted({ casts, caught });
						if (bite.observed === true) {
							const before = (await readInventory(scope.world)).counts;
							let delta = await pollInventoryDelta(scope, before, COLLECT_POLL_MS, ctx.signal);
							if (Object.keys(delta).length === 0) {
								// 捕获物落在鱼漂附近（实测约 4 格）未入包：走近拾取兜底。
								await collectNearby(scope);
								delta = await pollInventoryDelta(scope, before, 2000, ctx.signal);
							}
							for (const [name, count] of Object.entries(delta)) caught[name] = (caught[name] ?? 0) + count;
							if (Object.keys(caught).length > 0) {
								return plain({
									caught: Object.entries(caught).map(([item, count]) => ({ item, count })),
									casts,
								});
							}
						}
					}
				} finally {
					// 验收口径：超时/取消不留持续使用。
					await retract();
				}
			});
		},
	};
}

/**
 * 等鱼漂落定：出生点在玩家眼高、满力抛竿飞行约 1 秒，位置连续两次读数一致
 * （水平 ±0.15 且 y ±0.15）视为落定；上限 2.5 秒。鱼漂消失（闲置咬钩自动收）返回 null。
 */
async function bobberLandedAt(scope: BodyCallScope, bobberId: number | null): Promise<Vec3 | null> {
	if (bobberId == null) return null;
	const deadline = Date.now() + 2500;
	let last: Vec3 | null = null;
	for (;;) {
		if (scope.signal.aborted) return null;
		const around = await readValue<{ entities: { ref: { networkId: number }; position: Vec3 }[] | null }>(
			scope.world,
			"entities@1",
			{ radius: 32, kind: "all", limit: 128 },
			scope.signal,
			"bobber tracking",
		);
		const current = (around.entities ?? []).find((entity) => entity.ref.networkId === bobberId)?.position ?? null;
		if (current == null && last == null) return null;
		if (current != null && last != null && flatDistance(current, last) < 0.15 && Math.abs(current.y - last.y) < 0.15) {
			return current;
		}
		last = current;
		if (Date.now() >= deadline) return current;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
}

/** 短距走向掉落点（drive-walk 兜底）：只在持身体作用域内使用，步数有界。 */ async function collectNearby(
	scope: BodyCallScope,
): Promise<void> {
	for (let step = 0; step < 6; step++) {
		if (scope.signal.aborted) return;
		const self = await readValue<SelfState>(scope.world, "self@1", {}, scope.signal, "self state");
		const view = await readValue<{
			entities: { name: string; position: Vec3; item: { name: string; count: number } | null }[] | null;
		}>(scope.world, "entities@1", { radius: 12, kind: "all", limit: 64 }, scope.signal, "drop search");
		const drop = (view.entities ?? []).find(
			(entity) => entity.item != null && flatDistance(self.place.position, entity.position) < 8,
		);
		if (drop == null) return;
		const gap = flatDistance(self.place.position, drop.position);
		if (gap <= 1.4) return;
		await scope.player.lookAt(drop.position);
		await scope.player.drive({ keys: { forward: true } }, 8);
	}
}
