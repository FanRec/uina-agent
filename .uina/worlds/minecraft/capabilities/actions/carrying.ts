/**
 * Pickup confirms inventory gains. Drop confirms entities in the world because
 * local inventory changes can be client predictions. Pickup can delegate to
 * goto before taking control of the body.
 */

import type { EntityRef, ItemSelector, SelfState } from "../../contracts/body.js";
import type { BodyCallScope, CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { CallFailure, JsonValue, Progress } from "../../contracts/values.js";
import { callFailure, plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import { resolveEntity } from "../shared/entities.js";
import { pollUntil, readValue } from "../shared/observe.js";
import { ENTITY_REACH } from "../shared/reach.js";
import { ITEM_SELECTOR_SCHEMA, VEC3_SCHEMA } from "../shared/schema.js";
import { distance, fail, matchesItem, stripNamespace } from "../shared/targets.js";
import {
	canAccept,
	carrySlotsOf,
	type EntityEntryView,
	type InventorySnapshot,
	positiveDelta,
	readInventory,
	readObservation,
} from "../shared/views.js";

/** 掉落物落点观测半径：丢出去的东西就在脚边，4 格足够覆盖"朝目标丢"的一步。 */
const DROP_GROUND_RADIUS = 4;
const DROP_GROUND_TIMEOUT_MS = 1500;
const DROP_GROUND_INTERVAL_MS = 150;
/** 拾取：超过这个距离才值得用 goto，最后一两格靠身体走过去。 */
const PICKUP_WALK_DISTANCE = 4;
/** 一次步进 5 tick（约 1 格）；GoalNear 在 1 格容差上经常空路径直接 resolve。 */
const PICKUP_STEP_TICKS = 5;
const PICKUP_MAX_ATTEMPTS = 12;
async function trackedEntities(world: CallContext["world"], radius: number): Promise<EntityEntryView[]> {
	const observation = await readObservation<{ entities: EntityEntryView[] }>(world, "entities@1", {
		radius,
		kind: "all",
		limit: 128,
	});
	return observation.value?.entities ?? [];
}

/** 纯移动腿（pickup 的 goto）：走不到只是路线问题，换一个掉落物继续。 */
function isSkippable(err: unknown): boolean {
	const code = (err as CallFailure | undefined)?.code;
	return code === "NOT_FOUND" || code === "UNREACHABLE" || code === "TIMEOUT";
}

function withProgress(err: unknown, progress: Progress): unknown {
	const failure = err as CallFailure;
	if (failure?.name !== "CallFailure") return err;
	return callFailure({
		...failure,
		message: failure.message,
		progress: { ...(failure.progress ?? {}), ...progress },
	});
}

// ---------------------------------------------------------------- drop@1

const dropDescriptor: CallableDescriptor = {
	ref: "drop@1",
	summary: "Drop items from the main inventory, optionally walking to and facing a target first",
	tags: ["body", "items"],
	input: {
		type: "object",
		properties: {
			item: { oneOf: [{ type: "string", minLength: 1 }, ITEM_SELECTOR_SCHEMA] },
			count: { type: "integer", minimum: 1, maximum: 1024 },
			toward: { oneOf: [{ type: "string", minLength: 1 }, { type: "object" }] },
		},
		required: ["item"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			dropped: { type: "object" },
			remaining: { type: "integer", minimum: 0 },
			at: VEC3_SCHEMA,
			toward: { type: "object" },
		},
		required: ["dropped", "remaining", "at"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description: "The declared items left the player and appeared as item entities on the ground",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "the main inventory holds no item matching the selector" },
		{ code: "MISSING_MATERIAL", meaning: "fewer matching items than the declared count (hint carries available)" },
		{ code: "UNREACHABLE", meaning: "the toward target could not be approached" },
		{ code: "TARGET_NOT_MET", meaning: "no dropped item entity was observed on the ground" },
		{ code: "REFERENCE_STALE", meaning: "the toward entity is no longer tracked" },
		{ code: "INTERRUPTED", meaning: "the run was stopped" },
	],
	requires: ["connection", "body"],
	examples: [
		{
			input: { item: "dirt", count: 2 },
			output: { dropped: { dirt: 2 }, remaining: 0, at: { x: 120, y: 64, z: -30 } },
		},
	],
	implementation: "native",
};

interface DropInput {
	item: string | ItemSelector;
	count?: number;
	toward?: string | EntityRef;
}

/** 按槽序把声明数量摊到各具体物品上：选择器命中多个名字时逐项丢弃。 */
function planDrop(matches: { name: string; count: number }[], total: number): { name: string; count: number }[] {
	const byName = new Map<string, number>();
	for (const slot of matches) byName.set(slot.name, (byName.get(slot.name) ?? 0) + slot.count);
	const plan: { name: string; count: number }[] = [];
	let remaining = total;
	for (const [name, count] of byName) {
		if (remaining <= 0) break;
		const take = Math.min(count, remaining);
		plan.push({ name, count: take });
		remaining -= take;
	}
	return plan;
}

function groundCounts(entities: EntityEntryView[], names: string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entity of entities)
		if (entity.item != null && names.includes(entity.item.name))
			counts[entity.item.name] = (counts[entity.item.name] ?? 0) + entity.item.count;
	return counts;
}

// ---------------------------------------------------------------- pickup@1

const pickupDescriptor: CallableDescriptor = {
	ref: "pickup@1",
	summary: "Walk to dropped item entities nearby and pick them up",
	tags: ["body", "items"],
	input: {
		type: "object",
		properties: {
			item: { type: "string", minLength: 1 },
			radius: { type: "integer", minimum: 4, maximum: 16 },
			maxTimeMs: { type: "integer", minimum: 1000, maximum: 120000 },
		},
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: { picked: { type: "object" } },
		required: ["picked"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description: "At least one item entity reached the inventory; `picked` reports the observed gains by item name",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no matching dropped item nearby, or none could be reached" },
		{ code: "INVENTORY_FULL", meaning: "no room in the main inventory for the requested item" },
		{ code: "TIMEOUT", meaning: "the time budget ran out before anything reached the inventory" },
		{ code: "CONTROL_CONFLICT", meaning: "another run held the client while a goto sub-call needed it" },
		{ code: "DISCONNECTED", meaning: "the connection ended during the operation" },
		{ code: "INTERRUPTED", meaning: "the run was stopped" },
	],
	requires: ["connection"],
	examples: [{ input: { item: "dirt" }, output: { picked: { dirt: 2 } } }],
	implementation: "native",
};

interface PickupInput {
	item?: string;
	radius?: number;
	maxTimeMs?: number;
}

// ---------------------------------------------------------------- collect@1

export const carryingModule: MinecraftCapabilityModule = {
	id: "carrying",
	definitions: [
		{
			kind: "action",
			descriptor: dropDescriptor,
			bind:
				() =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as DropInput;
					const inventory = await readInventory(ctx.world);
					const matches = carrySlotsOf(inventory).filter((slot) => matchesItem(raw.item, slot));
					if (matches.length === 0) {
						const wanted = typeof raw.item === "string" ? raw.item : raw.item.name;
						fail("NOT_FOUND", `no ${wanted} in the main inventory`, {
							hint: `main inventory holds: ${
								carrySlotsOf(inventory)
									.map((slot) => slot.name)
									.join(", ") || "nothing"
							}`,
						});
					}
					const available = matches.reduce((total, slot) => total + slot.count, 0);
					const declared = raw.count ?? available;
					if (declared > available) {
						fail("MISSING_MATERIAL", `asked to drop ${declared} but the main inventory holds ${available}`, {
							hint: `available: ${available}`,
						});
					}
					const plan = planDrop(matches, declared);
					const names = plan.map((step) => step.name);
					let toward: EntityRef | null = null;
					if (raw.toward != null) {
						const entity = await resolveEntity(ctx.world, raw.toward);
						toward = entity.ref;
						if (entity.distance > ENTITY_REACH) {
							await ctx.call("goto@1", { at: entity.position, tolerance: 1, maxTimeMs: 60000 });
						}
					}
					const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					const baseline = groundCounts(await trackedEntities(ctx.world, DROP_GROUND_RADIUS), names);
					const removed: Record<string, number> = {};
					let dropped: Record<string, number> = {};
					const remaining = (): number =>
						Math.max(0, declared - Object.values(removed).reduce((sum, count) => sum + count, 0));
					const observe = (entities: EntityEntryView[]): boolean => {
						const counts = groundCounts(entities, names);
						dropped = {};
						for (const name of names) {
							const count = Math.min(removed[name] ?? 0, Math.max(0, (counts[name] ?? 0) - (baseline[name] ?? 0)));
							if (count > 0) dropped[name] = count;
						}
						return remaining() === 0 && names.every((name) => (dropped[name] ?? 0) >= (removed[name] ?? 0));
					};
					try {
						await ctx.withBody(async (scope: BodyCallScope) => {
							if (toward != null) await scope.player.lookAt(toward);
							for (const step of plan) {
								const selector: ItemSelector = {
									...(typeof raw.item === "object" ? raw.item : {}),
									name: step.name,
									substitutions: [],
								};
								const outcome = await scope.player.toss(selector, step.count);
								for (const [name, count] of Object.entries(outcome.removed))
									removed[name] = (removed[name] ?? 0) + count;
								if (outcome.receipt.completion !== "met" || outcome.remaining > 0)
									fail("TARGET_NOT_MET", "drop has no fully confirmed inventory result; it will not be repeated", {
										dispatch: outcome.receipt.dispatch,
										effects: [outcome.receipt.effect],
									});
							}
						});
						const observed = await pollUntil(() => trackedEntities(ctx.world, DROP_GROUND_RADIUS), observe, {
							timeoutMs: DROP_GROUND_TIMEOUT_MS,
							intervalMs: DROP_GROUND_INTERVAL_MS,
							signal: ctx.signal,
						});
						if (!observed.ok)
							fail("TARGET_NOT_MET", `not every removed ${names.join("/")} appeared on the ground`, {
								dispatch: "sent",
							});
						return plain({ dropped, remaining: 0, at: self.place.position, ...(toward != null ? { toward } : {}) });
					} catch (err) {
						const failure = err as CallFailure;
						if (failure?.name !== "CallFailure") throw err;
						const partial = failure.progress?.removed;
						if (partial != null && typeof partial === "object" && !Array.isArray(partial))
							for (const [name, count] of Object.entries(partial))
								if (typeof count === "number") removed[name] = (removed[name] ?? 0) + count;
						try {
							observe(await trackedEntities(ctx.world, DROP_GROUND_RADIUS));
						} catch {
							/* Preserve the original failure when current observations are unavailable. */
						}
						throw withProgress(err, {
							removed,
							dropped,
							remaining: remaining(),
							at: plain(self.place.position),
							...(toward != null ? { toward: plain(toward) } : {}),
						});
					}
				},
		},
		{
			kind: "action",
			descriptor: pickupDescriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as PickupInput;
					const radius = raw.radius ?? 8;
					const budget = raw.maxTimeMs ?? 30000;
					const deadline = Date.now() + budget;
					const wanted = raw.item == null ? null : stripNamespace(raw.item);
					const start = await readInventory(ctx.world);
					const candidates = (await trackedEntities(ctx.world, radius))
						.filter((entity) => entity.item != null && (wanted == null || entity.item.name === wanted))
						.sort((a, b) => a.distance - b.distance || a.ref.networkId - b.ref.networkId);
					if (candidates.length === 0) {
						fail(
							"NOT_FOUND",
							wanted == null
								? `no dropped items within ${radius} blocks`
								: `no dropped ${wanted} within ${radius} blocks`,
							{ hint: "read entities@1 first; out of range is not proof of absence" },
						);
					}
					// 容量前置：一件都装不下就别走过去（走也白走）。
					const acceptable = candidates.some((candidate) => {
						const stackSize = deps.knowledge()?.item(candidate.item?.name ?? "")?.stackSize ?? null;
						return canAccept(start, candidate.item?.name ?? "", stackSize, 1) !== false;
					});
					if (!acceptable) {
						fail("INVENTORY_FULL", `no room for any of the dropped items within ${radius} blocks`, {
							hint: "free a main-inventory slot or a partial stack first",
						});
					}
					let baseline = start;
					const picked: Record<string, number> = {};
					let attempts = 0;
					const absorb = (inventory: InventorySnapshot): boolean => {
						const entries = Object.entries(positiveDelta(baseline, inventory));
						if (entries.length === 0) return false;
						for (const [name, count] of entries) picked[name] = (picked[name] ?? 0) + count;
						baseline = inventory;
						return true;
					};
					for (const candidate of candidates) {
						if (attempts >= PICKUP_MAX_ATTEMPTS || Date.now() >= deadline) break;
						// 上一个候选可能顺手把这个也捡了：走之前确认它还在。
						const present = (await trackedEntities(ctx.world, radius)).some(
							(entity) => entity.ref.networkId === candidate.ref.networkId && entity.item != null,
						);
						if (!present) continue;
						attempts++;
						const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
						const gap = distance(self.place.position, candidate.position);
						if (gap > PICKUP_WALK_DISTANCE) {
							try {
								await ctx.call("goto@1", {
									at: candidate.position,
									tolerance: 2,
									maxTimeMs: Math.max(1000, Math.min(30000, deadline - Date.now())),
								});
							} catch (err) {
								if (isSkippable(err)) continue;
								throw err;
							}
						}
						// 最后一两格用身体走：这一段的 GoalNear 容差太紧，路径规划经常直接
						// resolve 成空路径（驱动层会按 UNREACHABLE 结算），走了反而更稳。
						await ctx.withBody(async (scope: BodyCallScope) => {
							await scope.player.lookAt(candidate.position);
							const bursts = Math.max(2, Math.ceil(gap) + 1);
							for (let i = 0; i < bursts; i++) {
								await scope.player.drive({ keys: { forward: true } }, PICKUP_STEP_TICKS);
								if (absorb(await readInventory(scope.world))) return;
								if (Date.now() >= deadline) return;
							}
						});
					}
					if (Object.keys(picked).length === 0) {
						if (Date.now() >= deadline) {
							fail("TIMEOUT", `pickup budget of ${budget}ms ran out before anything reached the inventory`, {
								hint: "the items may be out of reach or already gone",
								dispatch: "sent",
								progress: { picked: {} },
							});
						}
						fail("NOT_FOUND", `nothing could be picked up within ${radius} blocks`, {
							hint: "the candidates may be unreachable or already gone",
							dispatch: "sent",
							progress: { picked: {} },
						});
					}
					return plain({ picked });
				},
		},
	],
};
