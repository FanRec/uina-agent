/**
 * 物品在身体与世界之间的闭环：collect@1（采集）、pickup@1（拾取）、drop@1（丢弃）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 collect/pickup/drop。
 * 三者的完成口径都落在可观察的变化上，谁也不拿"我做了动作"冒充"世界变了"：
 * - collect 的 acquired 只算本次新增入包的匹配物品，破坏但没入包不算；
 * - pickup 只报观察到的库存增量，一个没捡到就是 NOT_FOUND；
 * - drop 的完成不看本地库存（mineflayer 的窗口点击是本地预测），而看地面掉落物实体。
 *
 * 组合动作允许调子能力：collect 组合 goto/mine/pickup，pickup 组合 goto。
 * 但都**不持身体**——Driver 的 Body 槽与 goto 槽互斥，一步一取放才是干净的所有权。
 */

import type { EntityRef, ItemSelector, SelfState } from "../../contracts/body.js";
import type { BodyCallScope, CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { HarvestRequirement, ItemSource } from "../../contracts/knowledge.js";
import type { CallFailure, JsonValue, Progress, Vec3 } from "../../contracts/values.js";
import { callFailure, plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import { resolveEntity } from "../shared/entities.js";
import { pollUntil, readValue } from "../shared/observe.js";
import { blockReach, ENTITY_REACH } from "../shared/reach.js";
import { ITEM_SELECTOR_SCHEMA, VEC3_SCHEMA } from "../shared/schema.js";
import { distance, fail, matchesItem, stripNamespace } from "../shared/targets.js";
import { canHarvest } from "../shared/tools.js";
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
const PICKUP_WINDOW_INTERVAL_MS = 200;
const PICKUP_MAX_ATTEMPTS = 12;
/** 采集：3 格以内直接挖（矿的射程是 4.5，留余量），否则先走位。 */
const COLLECT_APPROACH = 3;
const COLLECT_DROP_TIMEOUT_MS = 1500;
/** 单格走位上限：一格方块不该吃掉整次采集的预算，卡住就换下一格。 */
const COLLECT_APPROACH_TIMEOUT_MS = 15000;
const COLLECT_BUDGET_BASE_MS = 20000;
const COLLECT_BUDGET_PER_ITEM_MS = 20000;
const COLLECT_BUDGET_MAX_MS = 300000;
const FRONTIER_LIMIT = 16;
/** blocks@1 的 exclude 上限；真正的去重靠本地 tried 集合。 */
const EXCLUDE_LIMIT = 32;

async function trackedEntities(world: CallContext["world"], radius: number): Promise<EntityEntryView[]> {
	const observation = await readObservation<{ entities: EntityEntryView[] }>(world, "entities@1", {
		radius,
		kind: "all",
		limit: 128,
	});
	return observation.value?.entities ?? [];
}

function posKey(position: Vec3): string {
	return `${position.x},${position.y},${position.z}`;
}

function centerOf(position: Vec3): Vec3 {
	return { x: position.x + 0.5, y: position.y, z: position.z + 0.5 };
}

/** 正踩在这一格上：挖它会把自己埋进一格竖井，后面的走位全废，所以排到最后。 */
function isUnderfoot(position: Vec3, self: SelfState): boolean {
	return (
		position.x === Math.floor(self.place.position.x) &&
		position.z === Math.floor(self.place.position.z) &&
		position.y === Math.floor(self.place.position.y) - 1
	);
}

function blockSources(sources: ItemSource[]): { block: string; harvest: HarvestRequirement }[] {
	const blocks: { block: string; harvest: HarvestRequirement }[] = [];
	for (const source of sources) {
		if (source.kind === "block") blocks.push({ block: source.block, harvest: source.harvest });
	}
	return blocks;
}

/** 纯移动腿（pickup 的 goto）：走不到只是路线问题，换一个掉落物继续。 */
function isSkippable(err: unknown): boolean {
	const code = (err as CallFailure | undefined)?.code;
	return code === "NOT_FOUND" || code === "UNREACHABLE" || code === "TIMEOUT";
}

type CandidateKind = "permanent" | "transient" | "unknown";

interface CandidateAttempt {
	at: Vec3;
	kind: CandidateKind;
	reason: string;
	/** 失败发生时的观察依据；世界换代后瞬时排除才有据可查。 */
	basis: { worldRevision: string | null; observedAt: string };
}

/**
 * 接近目标的失败（goto）：移动超时只是预算问题，不修改世界，
 * 可以换候选继续；不能把"走不过去"当成"已挖了但不知道结果"。
 */
export function approachKind(err: unknown): CandidateKind | null {
	const code = (err as CallFailure | undefined)?.code;
	if (code === "NOT_FOUND") return "permanent";
	if (code === "UNREACHABLE" || code === "TIMEOUT") return "transient";
	return null;
}

/**
 * 挖源方块的失败（mine）：TIMEOUT 必须先看 dispatch/effects。
 * 已经派发或已有 effect 时结果未知——换候选会把"可能已挖掉"当成没发生。
 */
export function mineKind(err: unknown): CandidateKind | null {
	const failure = err as CallFailure | undefined;
	const code = failure?.code;
	if (code === "NOT_FOUND") return "permanent";
	if (code === "UNREACHABLE") return "transient";
	if (code === "TIMEOUT") {
		const dispatched = failure?.dispatch === "sent" || (failure?.effects?.length ?? 0) > 0;
		return dispatched ? "unknown" : "transient";
	}
	return null;
}

/** 子调用失败 → 保留局部诊断字段，数量以本次组合动作的累计进度为准。 */
function withProgress(err: unknown, progress: Progress): unknown {
	const failure = err as CallFailure;
	if (failure?.name !== "CallFailure") return err;
	return callFailure({
		code: failure.code,
		source: failure.source,
		message: failure.message,
		hint: failure.hint,
		dispatch: failure.dispatch,
		progress: { ...(failure.progress ?? {}), ...progress },
		effects: failure.effects ?? [],
		recoverable: failure.recoverable,
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

const collectDescriptor: CallableDescriptor = {
	ref: "collect@1",
	summary: "Gather a number of an item by mining the blocks that drop it, walking to each one",
	tags: ["body", "gathering"],
	input: {
		type: "object",
		properties: {
			item: { type: "string", minLength: 1 },
			count: { type: "integer", minimum: 1, maximum: 1024 },
			radius: { type: "integer", minimum: 4, maximum: 64 },
			digThrough: { type: "boolean" },
			tool: { oneOf: [{ type: "string", minLength: 1 }, ITEM_SELECTOR_SCHEMA] },
		},
		required: ["item"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			mined: { type: "integer", minimum: 0 },
			acquired: { type: "integer", minimum: 0 },
			collected: { type: "object" },
			remaining: { type: "integer", minimum: 0 },
			toolsUsed: { type: "array", items: { type: "string" } },
		},
		required: ["mined", "acquired", "collected", "remaining", "toolsUsed"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"The inventory gained at least the requested count of the item during this call; blocks broken without a pickup do not count",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "the item has no block source, or no source block is left within the radius" },
		{ code: "MISSING_TOOL", meaning: "no inventory tool can harvest any source block (hint carries required)" },
		{ code: "MISSING_MATERIAL", meaning: "the requested tool is not in the inventory" },
		{ code: "INVENTORY_FULL", meaning: "no room for another matching item" },
		{ code: "UNREACHABLE", meaning: "too many source blocks could not be reached or broken" },
		{ code: "TIMEOUT", meaning: "the internal budget ran out with fewer items than requested" },
		{ code: "WRONG_STATE", meaning: "static knowledge is not ready" },
		{ code: "CONTROL_CONFLICT", meaning: "another run held the client while a sub-call needed it" },
		{ code: "DISCONNECTED", meaning: "the connection ended during the operation" },
		{ code: "INTERRUPTED", meaning: "the run was stopped" },
	],
	requires: ["connection"],
	examples: [
		{
			input: { item: "oak_log", count: 8 },
			output: { mined: 8, acquired: 8, collected: { oak_log: 8 }, remaining: 0, toolsUsed: [] },
		},
	],
	implementation: "native",
};

interface CollectInput {
	item: string;
	count?: number;
	radius?: number;
	digThrough?: boolean;
	tool?: string | ItemSelector;
}

/**
 * 采集前沿：按来源方块逐个搜，合并去重，滤掉已经试过的格子。
 * 永久排除（源方块已不在）与瞬时排除（路线暂不可达）分开：
 * 瞬时项在真正拿到资源后释放，允许环境变化后重新评估；永久项不无限重试。
 */
async function gatherFrontier(
	ctx: CallContext,
	blockNames: string[],
	radius: number,
	tried: Map<string, CandidateAttempt>,
): Promise<Vec3[]> {
	const exclude = [...tried.values()]
		.filter((attempt) => attempt.kind === "permanent" || attempt.kind === "transient")
		.slice(-EXCLUDE_LIMIT)
		.map((attempt) => ({ x: attempt.at.x, y: attempt.at.y, z: attempt.at.z }));
	const frontier: Vec3[] = [];
	const seen = new Set<string>();
	for (const name of blockNames) {
		const observation = await readObservation<{ blocks: { position: Vec3; name: string }[] }>(ctx.world, "blocks@1", {
			name,
			radius,
			limit: FRONTIER_LIMIT,
			exclude,
		});
		for (const block of observation.value?.blocks ?? []) {
			const key = posKey(block.position);
			if (tried.has(key) || seen.has(key)) continue;
			seen.add(key);
			frontier.push(block.position);
		}
	}
	return frontier;
}

/** 等这一格的掉落入包；等不到就返回 null（由调用方决定要不要 pickup 兜底）。 */
async function waitForGain(
	ctx: CallContext,
	baseline: InventorySnapshot,
	item: string,
	timeoutMs: number,
): Promise<InventorySnapshot | null> {
	const observed = await pollUntil(
		() => readInventory(ctx.world),
		(inventory) => (inventory.counts[item] ?? 0) > (baseline.counts[item] ?? 0),
		{ timeoutMs, intervalMs: PICKUP_WINDOW_INTERVAL_MS, signal: ctx.signal },
	);
	return observed.ok ? observed.last : null;
}

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
		{
			kind: "action",
			descriptor: collectDescriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as CollectInput;
					const knowledge = deps.knowledge();
					if (knowledge == null) {
						fail("WRONG_STATE", "static knowledge is not ready", {
							hint: "registry-backed queries need the connection data; retry once the client is ready",
						});
					}
					const item = knowledge.canonicalItemName(raw.item);
					if (item == null) {
						fail("NOT_FOUND", `unknown item ${raw.item}`, { hint: "check item@1 for the canonical name" });
					}
					const info = knowledge.item(item);
					const sources = blockSources(info?.sources ?? []);
					if (sources.length === 0) {
						fail("NOT_FOUND", `${item} has no block source in this version's data`, {
							hint:
								info?.sourcesComplete === false
									? "drop/trade data is incomplete for this version; sources may be missing"
									: "check item@1 for the recorded sources",
						});
					}
					const count = raw.count ?? 1;
					const radius = raw.radius ?? 32;
					const start = await readInventory(ctx.world);
					// 可预判的失败全部在移动之前：白跑 20 格才发现没镐，是这个动作最没价值的行为。
					const requestedTool = raw.tool;
					if (requestedTool != null && !start.slots.some((slot) => matchesItem(requestedTool, slot))) {
						const wanted = typeof requestedTool === "string" ? requestedTool : requestedTool.name;
						fail("MISSING_MATERIAL", `requested tool ${wanted} is not in the inventory`, {
							hint: `inventory holds: ${start.slots.map((slot) => slot.name).join(", ") || "nothing"}`,
						});
					}
					const harvestable = sources.filter((source) => canHarvest(knowledge, start, source.block, requestedTool));
					if (harvestable.length === 0) {
						const required = [
							...new Set(sources.flatMap((source) => (source.harvest.kind === "tools" ? source.harvest.names : []))),
						];
						fail("MISSING_TOOL", `no inventory tool can harvest any source block of ${item}`, {
							hint: `required: ${required.join(", ") || "unknown"}`,
						});
					}
					const stackSize = info?.stackSize ?? null;
					const budget = Math.min(COLLECT_BUDGET_MAX_MS, count * COLLECT_BUDGET_PER_ITEM_MS + COLLECT_BUDGET_BASE_MS);
					const deadline = Date.now() + budget;
					let baseline = start;
					let mined = 0;
					let acquired = 0;
					const collected: Record<string, number> = {};
					const toolsUsed = new Set<string>();
					const tried = new Map<string, CandidateAttempt>();
					let frontier: Vec3[] = [];
					let attempts = 0;
					let skipped = 0;
					/** 最近一次被跳过的原因：放弃时要说清楚是哪一步在挡路，而不是只说"试过了"。 */
					const lastSkip: { current: { code: string; message: string } | null } = { current: null };
					const maxAttempts = Math.max(8, count * 4);
					const skipOf = (err: unknown): void => {
						const failure = err as CallFailure;
						lastSkip.current = { code: failure.code ?? "UNKNOWN", message: failure.message ?? "" };
					};
					const recordAttempt = (at: Vec3, kind: CandidateKind, err: unknown, worldRevision: string | null): void => {
						const failure = err as CallFailure;
						tried.set(posKey(at), {
							at,
							kind,
							reason: `${failure?.code ?? "UNKNOWN"}: ${failure?.message ?? String(err)}`,
							basis: { worldRevision, observedAt: new Date().toISOString() },
						});
					};
					const progressOf = (): Progress => ({
						mined,
						acquired,
						collected: { ...collected },
						remaining: Math.max(0, count - acquired),
						attempted: attempts,
						skipped,
						toolsUsed: [...toolsUsed],
					});

					while (acquired < count) {
						if (Date.now() >= deadline) {
							fail(
								"TIMEOUT",
								`collect budget of ${budget}ms ran out with ${acquired}/${count} ${item}` +
									(lastSkip.current == null ? "" : ` (last: ${lastSkip.current.code}: ${lastSkip.current.message})`),
								{
									hint: "retry with the remaining count",
									dispatch: "sent",
									progress: progressOf(),
								},
							);
						}
						const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
						if (canAccept(baseline, item, stackSize, 1) === false) {
							fail("INVENTORY_FULL", `no room for another ${item}`, {
								hint: "free a main-inventory slot first",
								dispatch: "sent",
								progress: progressOf(),
							});
						}
						if (frontier.length === 0) {
							// 候选耗尽但"已挖数 > 已入包数"：掉落物可能还在地上。
							// 先做一次有界清扫再判定资源耗尽，别把未入包的挖除数当成没有资源。
							if (mined > acquired) {
								try {
									await ctx.call("pickup@1", { item, radius: 8, maxTimeMs: 8000 });
								} catch {
									// 清扫失败不掩盖事实：下面的库存读数会如实反映拿到多少。
								}
								const swept = await readInventory(ctx.world);
								const sweptGain = positiveDelta(baseline, swept)[item] ?? 0;
								if (sweptGain > 0) {
									acquired += sweptGain;
									collected[item] = (collected[item] ?? 0) + sweptGain;
									baseline = swept;
									await ctx.progress(progressOf());
								}
								if (acquired >= count) break;
							}
							frontier = await gatherFrontier(
								ctx,
								harvestable.map((source) => source.block),
								radius,
								tried,
							);
							if (frontier.length === 0) {
								fail(
									"NOT_FOUND",
									`no ${harvestable.map((source) => source.block).join("/")} left within ${radius} blocks` +
										(lastSkip.current == null
											? ""
											: ` (last skipped cell: ${lastSkip.current.code}: ${lastSkip.current.message})`),
									{
										hint: "widen radius, or move to where the block occurs",
										dispatch: mined > 0 ? "sent" : "not_sent",
										progress: progressOf(),
									},
								);
							}
						}
						frontier.sort((a, b) => distance(a, self.place.position) - distance(b, self.place.position));
						// 脚下那格留到最后：一格竖井会让后续每次 goto 都失败，比少挖一格贵得多。
						const pickIndex = frontier.length > 1 && isUnderfoot(frontier[0] as Vec3, self) ? 1 : 0;
						const target = frontier.splice(pickIndex, 1)[0];
						if (target == null) continue;
						const key = posKey(target);
						if (tried.has(key)) continue;
						if (attempts >= maxAttempts) {
							fail(
								"UNREACHABLE",
								`gave up after ${attempts} block attempts with ${acquired}/${count} ${item}` +
									(lastSkip.current == null ? "" : ` (last: ${lastSkip.current.code}: ${lastSkip.current.message})`),
								{
									hint: "the remaining blocks could not be reached or broken",
									dispatch: "sent",
									progress: progressOf(),
								},
							);
						}
						attempts++;
						if (blockReach(self, target) > COLLECT_APPROACH) {
							try {
								await ctx.call("goto@1", {
									at: centerOf(target),
									tolerance: 1,
									digThrough: raw.digThrough ?? false,
									maxTimeMs: Math.max(1000, Math.min(COLLECT_APPROACH_TIMEOUT_MS, deadline - Date.now())),
								});
							} catch (err) {
								const kind = approachKind(err);
								if (kind != null) {
									skipOf(err);
									recordAttempt(target, kind, err, self.place.worldRevision);
									skipped += 1;
									continue;
								}
								throw withProgress(err, progressOf());
							}
						}
						let value: { broken?: boolean; tool?: string };
						try {
							value = (await ctx.call("mine@1", {
								at: target,
								collect: false,
								...(raw.tool != null ? { tool: raw.tool } : {}),
							})) as { broken?: boolean; tool?: string };
						} catch (err) {
							const kind = mineKind(err);
							// 已派发但结果未知：换候选会把"可能已挖掉"当成没发生。
							// 保留 Effect 与进度，交给上层重新观察或决策。
							if (kind === "unknown") throw withProgress(err, progressOf());
							if (kind != null) {
								skipOf(err);
								recordAttempt(target, kind, err, self.place.worldRevision);
								skipped += 1;
								continue;
							}
							throw withProgress(err, progressOf());
						}
						if (value?.broken !== true) continue;
						mined++;
						if (value.tool != null) toolsUsed.add(value.tool);
						// 掉落观察归这一层：mine 的 dropped 只在拾取半径内可见，且它自己只等一次。
						if ((await waitForGain(ctx, baseline, item, COLLECT_DROP_TIMEOUT_MS)) == null) {
							try {
								await ctx.call("pickup@1", { item, radius: 4, maxTimeMs: 5000 });
							} catch {
								// 兜底失败不掩盖已完成的采集：下面的库存读数会如实反映拿到多少。
							}
						}
						const after = await readInventory(ctx.world);
						const gained = positiveDelta(baseline, after)[item] ?? 0;
						if (gained > 0) {
							acquired += gained;
							collected[item] = (collected[item] ?? 0) + gained;
							// 世界已经变化（源方块消失/路线可能改变）：释放瞬时排除，
							// 让此前不可达的候选在下一次前沿重建时重新评估。
							for (const [positionKey, attempt] of tried) if (attempt.kind === "transient") tried.delete(positionKey);
							frontier = [];
						}
						baseline = after;
						await ctx.progress(progressOf());
					}
					return plain({ mined, acquired, collected, remaining: 0, toolsUsed: [...toolsUsed] });
				},
		},
	],
};
