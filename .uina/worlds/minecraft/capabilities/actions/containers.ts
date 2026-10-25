/** 容器动作：导航在自有身体之外，窗口与槽位搬移在同一身体作用域内。 */
import type { BodyCallScope, CallContext, CallableDescriptor, NativeCallable } from "../../contracts/capabilities.js";
import type { BlockTarget, EntityRef, SelfState, WindowSession, WindowSnapshot } from "../../contracts/body.js";
import type { CallFailure, JsonSchema, JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { GRID_POS_SCHEMA, ITEM_SELECTOR_SCHEMA } from "../shared/schema.js";
import { BLOCK_REACH, ENTITY_REACH, blockReach } from "../shared/reach.js";
import { readValue } from "../shared/observe.js";
import { readBlockAt, readObservation, type EntityEntryView } from "../shared/views.js";
import { assertSameDimension, distance, fail, resolveGrid, resolvePoint } from "../shared/targets.js";
import {
	transferRoom,
	transferWindow,
	windowItem,
	windowRegion,
	type TransferSelection,
} from "../shared/window-transfer.js";

const BLOCK_CONTAINERS = [
	"chest",
	"trapped_chest",
	"ender_chest",
	"barrel",
	"hopper",
	"dispenser",
	"dropper",
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
}

interface TransferInput extends Omit<TransferSelection, "direction"> {
	from?: unknown;
	to?: unknown;
}

function interrupted(ctx: CallContext): void {
	if (ctx.signal.aborted) fail("INTERRUPTED", "container action was stopped", { recoverable: false });
}

function delegated(ctx: CallContext): boolean {
	return "player" in ctx;
}

function blockCandidate(raw: unknown, self: SelfState): Candidate {
	const point = resolvePoint(raw, self);
	assertSameDimension(point, self, "container");
	const block = resolveGrid(raw, self);
	return {
		target: { block, place: { ...self.place, position: block } },
		position: block,
		endpoint: plain({ position: block, dimension: self.place.dimension }),
		entity: false,
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
		return { target: ref, position: entity.position, endpoint: plain(ref), entity: true };
	}
	const candidate = blockCandidate(raw, self);
	const block = await readBlockAt(ctx.world, candidate.position);
	if (block == null || !BLOCK_CONTAINERS.includes(block.name.replace(/^minecraft:/, "")))
		fail("NOT_FOUND", "target is not a currently observed supported container");
	return candidate;
}

async function nearbyCandidates(ctx: CallContext): Promise<Candidate[]> {
	const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
	const blocks: Candidate[] = [];
	for (const name of BLOCK_CONTAINERS) {
		interrupted(ctx);
		const observation = await readObservation<{ blocks: { position: Vec3 }[] }>(ctx.world, "blocks@1", {
			name,
			radius: 16,
			limit: 3,
		});
		for (const block of observation.value.blocks) blocks.push(blockCandidate(block.position, self));
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
		blocks.push({ target: entity.ref, position: entity.position, endpoint: plain(entity.ref), entity: true });
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
	const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
	const reach = candidate.entity
		? distance(self.place.position, candidate.position)
		: blockReach(self, candidate.position);
	if (reach <= (candidate.entity ? ENTITY_REACH : BLOCK_REACH)) return;
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
	return ctx.withBody(async (scope) => {
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
		"Approach a container, read its server-confirmed contents, and close it; delegated bodies require an already reachable target",
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

export function containerCallable(_deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: containerDescriptor,
		async invoke(ctx, input) {
			const candidate = await explicitCandidate(ctx, (input as { at: unknown }).at);
			return withWindow(ctx, candidate, async (window) => {
				const snapshot = (await window.snapshot()).value;
				const region = windowRegion(snapshot, "container");
				const slots = snapshot.slots
					.filter((slot) => region.includes(slot.slot) && slot.item != null)
					.map((slot) => {
						const item = windowItem(slot.item);
						return { slot: slot.slot, name: item?.name, count: item?.count };
					});
				return plain({
					at: candidate.endpoint,
					type: snapshot.type,
					slots,
					freeSlots: region.length - slots.length,
					properties: snapshot.properties,
				});
			});
		},
	};
}

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

export function transferCallable(_deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: transferDescriptor,
		async invoke(ctx, input) {
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
			const identity = {
				from: direction === "from" ? selected.endpoint : "inventory",
				to: direction === "to" ? selected.endpoint : "inventory",
				containersChecked: checked,
			};
			try {
				return await withWindow(ctx, selected, async (window) => {
					const amounts = await transferWindow(window, selection, async (progress) =>
						ctx.progress(plain({ ...identity, ...progress }) as never),
					);
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
	};
}

export type { WindowSnapshot };
