/**
 * 能力层动作测试的共享替身：世界读数 + 身体调用 + 子调用派发。
 *
 * 只替换真实环境里难以稳定构造的边界（世界读数、身体副作用、导航），不建第二套玩法：
 * 动作的完成判定、前置顺序、子调用组合仍然走真实实现。
 * 记录 calls 是为了证明"没做多余的事"（例如拿身体之前就失败）。
 */

import type { CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type {
	BodyOps,
	SelfState,
	ItemValue,
	ItemSelector,
	WindowSession,
} from "../../.uina/worlds/minecraft/contracts/body.js";
import type { RegistryKnowledge } from "../../.uina/worlds/minecraft/contracts/knowledge.js";
import type { CallFailure, JsonValue, Observation } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { WorldReadPort } from "../../.uina/worlds/minecraft/contracts/world.js";
import { buildCapabilities } from "../../.uina/worlds/minecraft/capabilities/index.js";
import { buildRegistryKnowledge, type RegistryLike } from "../../.uina/worlds/minecraft/driver/facts/knowledge.js";

export const registry: RegistryLike = {
	version: { minecraftVersion: "1.21.11" },
	itemsByName: {
		air: { id: 0, name: "air" },
		stone: { id: 1, name: "stone", stackSize: 64 },
		dirt: { id: 2, name: "dirt", stackSize: 64 },
		grass_block: { id: 3, name: "grass_block", stackSize: 64 },
		oak_log: { id: 17, name: "oak_log", stackSize: 64 },
		cobblestone: { id: 35, name: "cobblestone", stackSize: 64 },
		bread: { id: 892, name: "bread", stackSize: 64 },
		apple: { id: 893, name: "apple", stackSize: 64 },
		wooden_pickaxe: { id: 913, name: "wooden_pickaxe", stackSize: 1, maxDurability: 59 },
	},
	items: {
		0: { id: 0, name: "air" },
		1: { id: 1, name: "stone" },
		2: { id: 2, name: "dirt" },
		3: { id: 3, name: "grass_block" },
		17: { id: 17, name: "oak_log" },
		35: { id: 35, name: "cobblestone" },
		892: { id: 892, name: "bread" },
		893: { id: 893, name: "apple" },
		913: { id: 913, name: "wooden_pickaxe" },
	},
	blocksByName: {
		stone: { id: 1, name: "stone", harvestTools: { "913": true } },
		dirt: { id: 2, name: "dirt" },
		grass_block: { id: 3, name: "grass_block" },
		oak_log: { id: 17, name: "oak_log" },
		cobblestone: { id: 35, name: "cobblestone" },
	},
	foodsByName: { apple: { foodPoints: 4, saturation: 19.2 } },
	blockLoot: {
		stone: { block: "stone", drops: [{ item: "cobblestone", noSilkTouch: true }] },
		dirt: { block: "dirt", drops: [{ item: "dirt" }] },
		grass_block: { block: "grass_block", drops: [{ item: "dirt" }] },
		oak_log: { block: "oak_log", drops: [{ item: "oak_log" }] },
	},
	entitiesByName: {
		zombie: { type: "hostile", category: "Hostile mobs" },
		item: { type: "other", category: "UNKNOWN" },
	},
	recipes: {},
};

export const knowledge = buildRegistryKnowledge(registry);

export const self: SelfState = {
	place: { world: "wld:t", worldRevision: "wrev:t", dimension: "overworld", position: { x: 10, y: 64, z: 10 } },
	velocity: { x: 0, y: 0, z: 0 },
	health: 20,
	food: 20,
	onGround: true,
	maxHealth: 20,
	saturation: 5,
	oxygen: 20,
	inWater: false,
	inLava: false,
	effects: [],
	xpLevel: 0,
	look: { yaw: 0, pitch: 0 },
};

export interface SlotFixture extends Partial<ItemValue> {
	slot: number;
	name: string;
	count: number;
}

export interface EntityFixture {
	ref: { connection: string; incarnation: string; appearance: string; networkId: number };
	name: string;
	kind: string;
	position: { x: number; y: number; z: number };
	distance: number;
	item: { name: string; count: number } | null;
}

export interface HarnessState {
	blocks: Map<string, { name: string; properties: Record<string, string> } | null>;
	inventory: {
		slots: SlotFixture[];
		counts: Record<string, number>;
		held?: { name: string; count: number };
		selectedSlot?: number | null;
	};
	entities?: EntityFixture[];
}

export function key(position: { x: number; y: number; z: number }): string {
	return `${position.x},${position.y},${position.z}`;
}

export function fact<T>(value: T): Observation<T> {
	return {
		value,
		observedAt: "2026-01-01T00:00:00.000Z",
		source: "server",
		coverage: "complete",
		unknown: [],
		evidence: [],
		cursor: null,
	};
}

export interface HarnessHooks {
	onDig?: (target: { block: { x: number; y: number; z: number } }) => void;
	onEquip?: (slot: string, selector: ItemSelector | null) => void;
	onToss?: (name: string, count: number, selector: ItemSelector) => void;
	digCompletion?: "met" | "not_met" | "unknown";
	/** 步进替身：测试可在里面模拟"走到之后顺手捡起"。 */
	onDrive?: (ticks: number) => void;
	/** 导航替身：测试可在里面模拟"走到之后世界发生了什么"（例如顺手捡起）。 */
	onGoto?: (request: { at: { x: number; y: number; z: number }; tolerance: number }) => void;
	self?: Partial<SelfState>;
	/** 覆盖静态知识：配方类测试要自己的注册表。 */
	knowledge?: RegistryKnowledge;
	/** openContainer 打开的窗口（工作台/熔炉）；不提供则调用即失败。 */
	openWindow?: () => WindowSession;
	/** withInventory 拿到的玩家窗口；不提供则调用即失败。 */
	inventoryWindow?: () => WindowSession;
}

export function makeHarness(state: HarnessState, hooks: HarnessHooks = {}) {
	// Each harness owns mutable world state, including nested place/position fields.
	const selfState: SelfState = structuredClone({ ...self, ...hooks.self });
	const calls: string[] = [];
	const world: WorldReadPort = {
		async read<T>(query: { ref: string; input: JsonValue }): Promise<Observation<T>> {
			if (query.ref === "self@1") return fact(selfState) as Observation<T>;
			if (query.ref === "inventory@1") {
				// 真实 World 每次返回新的纯值；替身必须同样快照，否则"动作前的库存"会被后续变更污染。
				return fact(structuredClone(state.inventory)) as Observation<T>;
			}
			if (query.ref === "block@1") {
				const at = (query.input as { at: { x: number; y: number; z: number } }).at;
				const block = state.blocks.get(key(at)) ?? null;
				return fact({ block: block == null ? null : { ...block, position: at, sign: null } }) as Observation<T>;
			}
			if (query.ref === "blocks@1") {
				const raw = query.input as {
					name: string | { name: string };
					radius?: number;
					limit?: number;
					exclude?: { x: number; y: number; z: number }[];
				};
				const name = typeof raw.name === "string" ? raw.name : raw.name.name;
				const exclude = new Set((raw.exclude ?? []).map((entry) => key(entry)));
				const origin = selfState.place.position;
				const matches = [...state.blocks.entries()]
					.filter(([at, block]) => block != null && block.name === name && !exclude.has(at))
					.map(([at, block]) => {
						const [x, y, z] = at.split(",").map(Number) as [number, number, number];
						return {
							position: { x, y, z },
							name: block?.name ?? name,
							distance: Math.hypot(x - origin.x, y - origin.y, z - origin.z),
						};
					})
					.filter((entry) => entry.distance <= (raw.radius ?? 32))
					.sort((a, b) => a.distance - b.distance)
					.slice(0, raw.limit ?? 64)
					.map(({ position, name: blockName }) => ({ position, name: blockName }));
				return fact({
					blocks: matches,
					count: matches.length,
					truncated: false,
					scanned: { radius: raw.radius ?? 32 },
				}) as Observation<T>;
			}
			if (query.ref === "entities@1") {
				return fact({ entities: state.entities ?? [], scanned: { radius: 16 } }) as Observation<T>;
			}
			throw new Error(`unexpected query ${query.ref}`);
		},
		watch: async () => {
			throw new Error("watch is not used by actions");
		},
		readRecord: async () => {
			throw new Error("readRecord is not used by actions");
		},
	};
	const player = {
		async dig(target: { block: { x: number; y: number; z: number } }) {
			calls.push("dig");
			hooks.onDig?.(target);
			return { effect: "eff:t:1", dispatch: "sent", completion: hooks.digCompletion ?? "met", evidence: [] };
		},
		async equip(item: ItemSelector | null, slot: string) {
			calls.push(`equip:${slot}`);
			hooks.onEquip?.(slot, item);
			return { effect: "eff:t:2", dispatch: "sent", completion: "met", evidence: [] };
		},
		async interact() {
			calls.push("interact");
			return { effect: "eff:t:3", dispatch: "sent", completion: "met", evidence: [] };
		},
		async drive(_input: unknown, ticks: number) {
			calls.push("drive");
			hooks.onDrive?.(ticks);
			return {
				receipt: { effect: "eff:t:4", dispatch: "sent", completion: "met", evidence: [] },
				actualTicks: 40,
				end: fact(selfState),
			};
		},
		async endUse() {
			calls.push("endUse");
			return { effect: "eff:t:5", dispatch: "sent", completion: "met", evidence: [] };
		},
		async attack() {
			calls.push("attack");
			return { receipt: { effect: "eff:t:6", dispatch: "sent", completion: "met", evidence: [] }, hit: true };
		},
		async useItem() {
			calls.push("useItem");
			return { effect: "eff:t:7", dispatch: "sent", completion: "met", evidence: [] };
		},
		async lookAt() {
			calls.push("lookAt");
			return { effect: "eff:t:8", dispatch: "sent", completion: "met", evidence: [] };
		},
		async writeSign() {
			calls.push("writeSign");
			return { effect: "eff:t:9", dispatch: "sent", completion: "met", evidence: [] };
		},
		async toss(selector: ItemSelector, count: number) {
			const name = selector.name;
			calls.push(`toss:${name}x${count}`);
			hooks.onToss?.(name, count, selector);
			// 替换 Driver 的服务端确认边界；玩法核验仍由能力本身执行。
			return {
				receipt: { effect: "eff:t:10", dispatch: "sent", completion: "met", evidence: [] },
				removed: { [name]: count },
				remaining: 0,
			};
		},
		async openContainer() {
			calls.push("openContainer");
			if (hooks.openWindow == null) throw new Error("this harness has no block window");
			return hooks.openWindow();
		},
		async withInventory<T>(work: (window: WindowSession) => Promise<T>): Promise<T> {
			calls.push("withInventory");
			if (hooks.inventoryWindow == null) throw new Error("this harness has no player window");
			const window = hooks.inventoryWindow();
			try {
				return await work(window);
			} finally {
				await window.close({ force: true });
			}
		},
	} as unknown as BodyOps;

	let bodyAcquired = 0;
	let callableTable: {
		descriptor: { ref: string };
		invoke: (ctx: CallContext, input: JsonValue) => Promise<JsonValue>;
	}[] = [];
	const ctx = {
		run: "run:t:1",
		segment: "seg:t:1",
		callId: "call:t:1",
		signal: new AbortController().signal,
		progress: async () => undefined,
		world,
		call: async (ref: string, input: JsonValue) => {
			const found = callableTable.find((entry) => entry.descriptor.ref === ref);
			if (found == null) throw new Error(`no callable ${ref}`);
			return await found.invoke(ctx as unknown as CallContext, input);
		},
		withBody: async <T>(work: (scope: CallContext) => Promise<T>): Promise<T> => {
			bodyAcquired++;
			return await work({ ...ctx, world, player } as unknown as CallContext);
		},
		verify: async () => {
			throw new Error("verify is not used here");
		},
	} as unknown as CallContext;
	const capabilities = buildCapabilities({
		runtime: () => ({ chat: async () => fact(0) as never, navigate: async (_owner, fn) => fn() }),
		gotoDirector: {
			async goto(request: { at: { x: number; y: number; z: number }; tolerance: number }) {
				calls.push(`goto:${key(request.at)}`);
				hooks.onGoto?.(request);
				// 到位：后续动作读到的 self 必须反映"走过去了"，否则射程判定会假失败。
				selfState.place = { ...selfState.place, position: { x: request.at.x, y: request.at.y, z: request.at.z } };
				return {
					receipt: { effect: "eff:t:11", dispatch: "sent", completion: "met", evidence: [] },
					at: request.at,
					ticks: 0,
					dug: 0,
					placed: null,
				};
			},
		} as never,
		knowledge: () => hooks.knowledge ?? knowledge,
	});
	callableTable = capabilities.callables;
	const callable = (ref: string) => {
		const found = capabilities.callables.find((entry) => entry.descriptor.ref === ref);
		if (found == null) throw new Error(`no callable ${ref}`);
		return found;
	};
	return { ctx, calls, callable, bodyAcquired: () => bodyAcquired };
}

export async function failureOf(promise: Promise<unknown>): Promise<CallFailure> {
	try {
		await promise;
	} catch (err) {
		return err as CallFailure;
	}
	throw new Error("expected a CallFailure");
}
