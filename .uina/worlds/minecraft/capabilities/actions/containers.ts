/** 容器动作：导航在自有身体之外，窗口与槽位搬移在同一身体作用域内。 */

import type { BlockTarget, EntityRef, SelfState, WindowSession, WindowSnapshot } from "../../contracts/body.js";
import type { BodyCallScope, CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { CallFailure, JsonSchema, JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import { approachBlock, delegated, withRelocation } from "../shared/approach.js";
import { readValue } from "../shared/observe.js";
import { ENTITY_REACH } from "../shared/reach.js";
import { GRID_POS_SCHEMA, ITEM_SELECTOR_SCHEMA } from "../shared/schema.js";
import { assertSameDimension, distance, fail, resolveGrid, resolvePoint } from "../shared/targets.js";
import { type EntityEntryView, readBlockAt, readObservation } from "../shared/views.js";
import { type TransferSelection, transferRoom, transferWindow, windowItem } from "../shared/window-transfer.js";

const BLOCK_CONTAINERS = [
	"chest",
	"trapped_chest",
	"ender_chest",
	"barrel",
	"hopper",
	"dispenser",
	"dropper",
	"furnace",
	"shulker_box",
	...[
		"white",
		"orange",
		"magenta",
		"light_blue",
		"yellow",
		"lime",
		"pink",
		"gray",
		"light_gray",
		"cyan",
		"purple",
		"blue",
		"brown",
		"green",
		"red",
		"black",
	].map((color) => `${color}_shulker_box`),
];
/**
 * 自动搜索的候选：熔炉只接受显式端点。按名字搜到炉子再往里塞东西，
 * 会把燃料放进 input 槽而没人能看出错——宁可不搜。
 */
const SEARCHABLE_CONTAINERS = BLOCK_CONTAINERS.filter((name) => name !== "furnace");
const ENTITY_REF_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		connection: { type: "string" },
		incarnation: { type: "string" },
		appearance: { type: "string" },
		networkId: { type: "integer" },
	},
	required: ["connection", "incarnation", "appearance", "networkId"],
	additionalProperties: false,
};
const ENDPOINT_SCHEMA: JsonSchema = { oneOf: [GRID_POS_SCHEMA, ENTITY_REF_SCHEMA, { const: "nearest" }] };

interface Candidate {
	target: BlockTarget | EntityRef;
	position: Vec3;
	endpoint: JsonValue;
	entity: boolean;
	/** 方块名（去掉命名空间）；实体容器为 null。 */
	block: string | null;
}

interface TransferInput extends Omit<TransferSelection, "direction"> {
	from?: unknown;
	to?: unknown;
}

function interrupted(ctx: CallContext): void {
	if (ctx.signal.aborted) fail("INTERRUPTED", "container action was stopped", { recoverable: false });
}

function blockCandidate(raw: unknown, self: SelfState, block: string | null = null): Candidate {
	const point = resolvePoint(raw, self);
	assertSameDimension(point, self, "container");
	const target = resolveGrid(raw, self);
	return {
		target: { block: target, place: { ...self.place, position: target } },
		position: target,
		endpoint: plain({ position: target, dimension: self.place.dimension }),
		entity: false,
		block,
	};
}

async function explicitCandidate(ctx: CallContext, raw: unknown): Promise<Candidate> {
	const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
	if (raw != null && typeof raw === "object" && "networkId" in raw) {
		const ref = raw as EntityRef;
		const entities = await readObservation<{ entities: EntityEntryView[] }>(ctx.world, "entities@1", {
			radius: 64,
			kind: "all",
			limit: 128,
		});
		const entity = entities.value.entities.find(
			(entry) =>
				entry.ref.networkId === ref.networkId &&
				entry.ref.connection === ref.connection &&
				entry.ref.incarnation === ref.incarnation &&
				entry.ref.appearance === ref.appearance,
		);
		if (entity == null) fail("REFERENCE_STALE", "container entity is no longer tracked with that identity");
		return { target: ref, position: entity.position, endpoint: plain(ref), entity: true, block: null };
	}
	const candidate = blockCandidate(raw, self);
	const block = await readBlockAt(ctx.world, candidate.position);
	const name = block?.name.replace(/^minecraft:/, "") ?? null;
	if (name != null && name === "crafting_table") {
		fail("NOT_FOUND", "target is a crafting table, not a container", {
			hint: "use craft@1 for a crafting table; container@1/transfer@1 only handle storage blocks and furnaces",
		});
	}
	if (name == null || !BLOCK_CONTAINERS.includes(name))
		fail("NOT_FOUND", "target is not a currently observed supported container");
	return { ...candidate, block: name };
}

async function nearbyCandidates(ctx: CallContext): Promise<Candidate[]> {
	const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
	const blocks: Candidate[] = [];
	for (const name of SEARCHABLE_CONTAINERS) {
		interrupted(ctx);
		const observation = await readObservation<{ blocks: { position: Vec3 }[] }>(ctx.world, "blocks@1", {
			name,
			radius: 16,
			limit: 3,
		});
		for (const block of observation.value.blocks) blocks.push(blockCandidate(block.position, self, name));
	}
	const entities = await readObservation<{ entities: EntityEntryView[] }>(ctx.world, "entities@1", {
		radius: 16,
		kind: "all",
		limit: 128,
	});
	for (const entity of entities.value.entities) {
		if (
			!["chest_minecart", "hopper_minecart", "chest_boat", "chest_raft"].includes(entity.name) &&
			!entity.name.endsWith("_chest_boat") &&
			!entity.name.endsWith("_chest_raft")
		)
			continue;
		blocks.push({
			target: entity.ref,
			position: entity.position,
			endpoint: plain(entity.ref),
			entity: true,
			block: null,
		});
	}
	const seen = new Set<string>();
	return blocks
		.filter((candidate) => {
			const key = JSON.stringify(candidate.endpoint);
			if (seen.has(key) || distance(candidate.position, self.place.position) > 16) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => distance(a.position, self.place.position) - distance(b.position, self.place.position));
}

async function approach(ctx: CallContext, candidate: Candidate): Promise<void> {
	interrupted(ctx);
	if (!candidate.entity) {
		await approachBlock(ctx, candidate.position, "container");
		return;
	}
	const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
	if (distance(self.place.position, candidate.position) <= ENTITY_REACH) return;
	if (delegated(ctx))
		fail("CONTROL_CONFLICT", "delegated body cannot start an independent navigation", {
			hint: "goto@1 before the ancestor withBody; a delegated container must already be within reach",
		});
	await ctx.call("goto@1", { at: plain(candidate.position), tolerance: 1, maxTimeMs: 30000 });
	interrupted(ctx);
}

async function withWindow<T>(
	ctx: CallContext,
	candidate: Candidate,
	work: (window: WindowSession, scope: BodyCallScope) => Promise<T>,
): Promise<T> {
	await approach(ctx, candidate);
	// §5 局部自治：够近但视线受阻时换少量安全站位；窗口写操作不重放。
	return withRelocation(ctx, candidate.position, candidate.block ?? "container", async (scope) => {
		interrupted(ctx);
		const window = await scope.player.openContainer(candidate.target);
		try {
			return await work(window, scope);
		} finally {
			await window.close({ force: true });
		}
	});
}

const containerDescriptor: CallableDescriptor = {
	ref: "container@1",
	summary:
		"Approach a container or furnace, read its server-confirmed contents, and close it; delegated bodies require an already reachable target",
	tags: ["container", "inventory"],
	input: { type: "object", properties: { at: GRID_POS_SCHEMA }, required: ["at"], additionalProperties: false },
	output: { type: "object" },
	access: "act",
	implementation: "native",
	requires: ["connection", "body", "window"],
	completion: {
		scope: "capability",
		description: "The container was opened, observed from a server snapshot, and closed",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "target is not a supported observed container" },
		{ code: "UNREACHABLE", meaning: "container cannot be reached" },
		{ code: "WRONG_STATE", meaning: "window could not be opened or is unsupported" },
		{ code: "CONTROL_CONFLICT", meaning: "delegated body would need independent navigation" },
		{ code: "INTERRUPTED", meaning: "action was stopped" },
	],
	examples: [
		{
			input: { at: { x: 1, y: 64, z: 1 } },
			output: {
				at: { position: { x: 1, y: 64, z: 1 }, dimension: "overworld" },
				type: "minecraft:generic_9x3",
				slots: [],
				freeSlots: 27,
			},
		},
	],
};

const transferDescriptor: CallableDescriptor = {
	ref: "transfer@1",
	summary:
		"Move a fixed item list between the player and one container, confirming each click; delegated bodies require reachable containers",
	tags: ["container", "inventory"],
	input: {
		type: "object",
		properties: {
			from: ENDPOINT_SCHEMA,
			to: ENDPOINT_SCHEMA,
			item: { oneOf: [{ type: "string", minLength: 1 }, ITEM_SELECTOR_SCHEMA] },
			count: { type: "integer", minimum: 1, maximum: 1024 },
			all: { const: true },
		},
		allOf: [
			{
				oneOf: [
					{ required: ["from"], not: { required: ["to"] } },
					{ required: ["to"], not: { required: ["from"] } },
				],
			},
			{
				oneOf: [
					{ required: ["item"], not: { required: ["all"] } },
					{ required: ["all"], not: { anyOf: [{ required: ["item"] }, { required: ["count"] }] } },
				],
			},
		],
		additionalProperties: false,
	},
	output: { type: "object" },
	access: "act",
	implementation: "native",
	requires: ["connection", "body", "window"],
	completion: {
		scope: "capability",
		description:
			"The fixed requested list moved between actual source/destination slots with server confirmation; cursor remainder is returned and window closed",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no suitable container or matching source item" },
		{ code: "MISSING_MATERIAL", meaning: "source exhausted before requested count" },
		{ code: "INVENTORY_FULL", meaning: "destination lacks room; progress retains moved and remaining" },
		{ code: "CONFLICT", meaning: "window changed before click" },
		{ code: "TARGET_NOT_MET", meaning: "a click result could not be confirmed; unknown clicks are never repeated" },
		{ code: "CONTROL_CONFLICT", meaning: "delegated body would need independent navigation" },
		{ code: "WRONG_STATE", meaning: "window or selector data is unavailable" },
		{ code: "REFERENCE_STALE", meaning: "entity/window identity expired" },
		{ code: "INTERRUPTED", meaning: "action was stopped" },
	],
	examples: [
		{
			input: { to: "nearest", item: "dirt", count: 5 },
			output: {
				from: "inventory",
				to: { position: { x: 1, y: 64, z: 1 }, dimension: "overworld" },
				moved: { dirt: 5 },
				remaining: {},
				containersChecked: 1,
			},
		},
		{
			input: { from: { position: { x: 1, y: 64, z: 2 }, dimension: "overworld" }, item: "iron_ingot" },
			output: {
				from: { position: { x: 1, y: 64, z: 2 }, dimension: "overworld" },
				to: "inventory",
				moved: { iron_ingot: 3 },
				remaining: {},
				containersChecked: 1,
			},
		},
	],
};

function candidateFailure(err: unknown): boolean {
	const failure = err as CallFailure;
	return (
		failure.dispatch !== "unknown" &&
		(["NOT_FOUND", "UNREACHABLE"].includes(failure.code) ||
			(failure.dispatch === "not_sent" && failure.code === "CONTROL_CONFLICT"))
	);
}

export type { WindowSnapshot };

export const containersModule: MinecraftCapabilityModule = {
	id: "containers",
	definitions: [
		{
			kind: "action",
			descriptor: containerDescriptor,
			bind:
				() =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const candidate = await explicitCandidate(ctx, (input as { at: unknown }).at);
					return withWindow(ctx, candidate, async (window) => {
						const snapshot = (await window.snapshot()).value;
						// 业务槽 = 除玩家区以外的全部区域：普通容器是 container，熔炉是 input/fuel/result。
						const regions = snapshot.layout.regions.filter((region) => region.name !== "player");
						const slots = snapshot.slots
							.filter((slot) => slot.item != null && regions.some((region) => region.slots.includes(slot.slot)))
							.map((slot) => {
								const item = windowItem(slot.item);
								const region = regions.find((entry) => entry.slots.includes(slot.slot));
								return { region: region?.name, slot: slot.slot, name: item?.name, count: item?.count };
							});
						const total = regions.reduce((sum, region) => sum + region.slots.length, 0);
						return plain({
							at: candidate.endpoint,
							type: snapshot.type,
							slots,
							freeSlots: total - slots.length,
							properties: snapshot.properties,
						});
					});
				},
		},
		{
			kind: "action",
			descriptor: transferDescriptor,
			bind:
				() =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as TransferInput;
					const direction = raw.from !== undefined ? "from" : "to";
					const endpoint = raw.from ?? raw.to;
					const selection: TransferSelection = {
						direction,
						...(raw.all ? { all: true } : { item: raw.item, count: raw.count }),
					};
					let checked = 0;
					let selected: Candidate | undefined;
					if (endpoint === "nearest") {
						const candidates = await nearbyCandidates(ctx);
						let fallback: Candidate | undefined;
						for (const candidate of candidates) {
							if (checked >= 3) break;
							try {
								const suitability = await withWindow(ctx, candidate, async (window) => {
									checked++;
									return transferRoom((await window.snapshot()).value, selection);
								});
								if (!suitability.matches) continue;
								if (direction === "from" || suitability.same) {
									selected = candidate;
									break;
								}
								if (suitability.room) fallback ??= candidate;
							} catch (err) {
								if (!candidateFailure(err)) throw err;
							}
						}
						selected ??= fallback;
						if (selected == null)
							fail("NOT_FOUND", "no suitable container found within 16 blocks", {
								progress: { containersChecked: checked },
							});
					} else {
						selected = await explicitCandidate(ctx, endpoint);
						checked = 1;
					}
					if (selected.block === "furnace" && direction === "to") {
						fail("WRONG_STATE", "furnace input and fuel slots are loaded by smelt@1, not transfer@1", {
							hint: "transfer@1 only takes a furnace result out: {from:{position}, item}; use smelt@1 to load",
						});
					}
					// 炉子只有结果槽是纯交换格：input/fuel 由 smelt@1 按槽位语义写入。
					const regions = selected.block === "furnace" ? { block: "result", player: "player" } : undefined;
					const identity = {
						from: direction === "from" ? selected.endpoint : "inventory",
						to: direction === "to" ? selected.endpoint : "inventory",
						containersChecked: checked,
					};
					try {
						return await withWindow(ctx, selected, async (window) => {
							const amounts = await transferWindow(window, selection, {
								regions,
								onProgress: async (progress) => ctx.progress(plain({ ...identity, ...progress }) as never),
							});
							return plain({ ...identity, ...amounts });
						});
					} catch (err) {
						if (err instanceof Error && err.name === "CallFailure") {
							const failure = err as CallFailure;
							failure.progress = plain({ ...identity, ...failure.progress }) as CallFailure["progress"];
						}
						throw err;
					}
				},
		},
	],
};
