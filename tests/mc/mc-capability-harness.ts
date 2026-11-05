/**
 * 能力层动作测试的共享替身：世界读数 + 身体调用 + 子调用派发。
 *
 * 只替换真实环境里难以稳定构造的边界（世界读数、身体副作用、导航），不建第二套玩法：
 * 动作的完成判定、前置顺序、子调用组合仍然走真实实现。
 * 记录 calls 是为了证明"没做多余的事"（例如拿身体之前就失败）。
 */

import { builtinCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import type {
	BodyOps,
	ItemSelector,
	ItemValue,
	SelfState,
	WindowSession,
} from "../../.uina/worlds/minecraft/contracts/body.js";
import type { CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { RegistryKnowledge } from "../../.uina/worlds/minecraft/contracts/knowledge.js";
import type { CallFailure, JsonValue, Observation } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { SurfaceProbe, WorldReadPort } from "../../.uina/worlds/minecraft/contracts/world.js";
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
		gravel: { id: 213, name: "gravel", stackSize: 64 },
		bread: { id: 892, name: "bread", stackSize: 64 },
		apple: { id: 893, name: "apple", stackSize: 64 },
		wooden_pickaxe: { id: 913, name: "wooden_pickaxe", stackSize: 1, maxDurability: 59 },
		// 批 15 工作站测试用（brew / enchant / anvil / grindstone / trade）
		potion: { id: 900, name: "potion", stackSize: 1 },
		glass_bottle: { id: 901, name: "glass_bottle", stackSize: 64 },
		nether_wart: { id: 902, name: "nether_wart", stackSize: 64 },
		blaze_powder: { id: 903, name: "blaze_powder", stackSize: 64 },
		lapis_lazuli: { id: 904, name: "lapis_lazuli", stackSize: 64 },
		diamond_sword: { id: 905, name: "diamond_sword", stackSize: 1, maxDurability: 1561 },
		emerald: { id: 906, name: "emerald", stackSize: 64 },
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
		900: { id: 900, name: "potion" },
		901: { id: 901, name: "glass_bottle" },
		902: { id: 902, name: "nether_wart" },
		903: { id: 903, name: "blaze_powder" },
		904: { id: 904, name: "lapis_lazuli" },
		905: { id: 905, name: "diamond_sword" },
		906: { id: 906, name: "emerald" },
	},
	blocksByName: {
		stone: { id: 1, name: "stone", harvestTools: { "913": true } },
		dirt: { id: 2, name: "dirt" },
		grass_block: { id: 3, name: "grass_block" },
		oak_log: { id: 17, name: "oak_log" },
		cobblestone: { id: 35, name: "cobblestone" },
		gravel: { id: 213, name: "gravel" },
		// 工作站方块（批 15）：findStation/readBlockAt 都按名字匹配。
		brewing_stand: { id: 1182, name: "brewing_stand" },
		enchanting_table: { id: 1183, name: "enchanting_table" },
		anvil: { id: 1184, name: "anvil" },
		grindstone: { id: 1185, name: "grindstone" },
	},
	foodsByName: { apple: { foodPoints: 4, saturation: 19.2 } },
	blockLoot: {
		stone: { block: "stone", drops: [{ item: "cobblestone", noSilkTouch: true }] },
		dirt: { block: "dirt", drops: [{ item: "dirt" }] },
		grass_block: { block: "grass_block", drops: [{ item: "dirt" }] },
		oak_log: { block: "oak_log", drops: [{ item: "oak_log" }] },
		gravel: { block: "gravel", drops: [{ item: "gravel" }] },
	},
	entitiesByName: {
		zombie: { type: "hostile", category: "Hostile mobs" },
		item: { type: "other", category: "UNKNOWN" },
		villager: { type: "passive", category: "Passive mobs" },
		wandering_trader: { type: "passive", category: "Passive mobs" },
	},
	// 服务器下发的附魔注册表与 minecraft-data 同序；能力层只按编号取名。
	enchantmentsArray: [
		{ id: 13, name: "fortune", maxLevel: 3 },
		{ id: 33, name: "sharpness", maxLevel: 5 },
	],
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
	/** world@1 替身（批 18 sleep 用）：缺省白天晴天。 */
	world?: { ticks: number; weather: string; dimension?: string };
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
	/** 步进替身：测试可在里面模拟"走到之后顺手捡起"；第二参是可变的 self（载具驾驶读数）。 */
	onDrive?: (ticks: number, selfState: SelfState) => void;
	/** 导航替身：测试可在里面模拟"走到之后世界发生了什么"（例如顺手捡起）。 */
	onGoto?: (request: { at: { x: number; y: number; z: number }; tolerance: number }) => void;
	/** goto 替身抛出的失败（如逃跑腿被围死）；设置后 goto 不再位移，直接抛出。 */
	gotoFailure?: () => unknown;
	/**
	 * self 读回前的一次回调：服务端在"条件满足的当下"改变身体状态时用（例如站在点亮的
	 * 门里被传送——这不是任何动作的后果，所以不该挂在 drive/interact 上）。
	 */
	onSelf?: (selfState: SelfState) => void;
	self?: Partial<SelfState>;
	/** 覆盖静态知识：配方类测试要自己的注册表。 */
	knowledge?: RegistryKnowledge;
	/** fight 测试：attack 派发时的世界副作用（目标消失、掉落出现等）。 */
	onAttack?: () => void;
	/** attack 替身返回的死亡证据（默认 true）。 */
	attackDead?: boolean;
	/** SurfaceProbe 注入（surface/fight 测试）；缺省 null。 */
	surface?: () => SurfaceProbe | null;
	/** openContainer 打开的窗口（工作台/熔炉）；不提供则调用即失败。 */
	openWindow?: () => WindowSession;
	/** withInventory 拿到的玩家窗口；不提供则调用即失败。 */
	inventoryWindow?: () => WindowSession;
	/** interact 派发时的世界副作用（place/build 用：把方块真的放上去）。 */
	onInteract?: (
		target: { place: { x: number; y: number; z: number }; block: { x: number; y: number; z: number } },
		face: { x: number; y: number; z: number },
	) => void;
	/** build.plan@1 的替身：build@1 只读一次计划，测试直接给出计划结果。 */
	buildPlan?: (input: JsonValue) => unknown;
	/**
	 * awaitBodyEvent 替身（批 18）：按 kind 返回窗口结论（可 async）；测试在回调里
	 * 顺手改世界（例如 sleep 事件同时把 ticks 跳到白天）。缺省 = 窗口走完没观察到。
	 */
	bodyEvent?: (
		kind: string,
		options: { passengerId?: number; detached?: boolean },
	) =>
		| { observed: boolean | null; vehicleId?: number | null }
		| Promise<{ observed: boolean | null; vehicleId?: number | null }>;
	/** leashedBySelf 替身（批 18）：缺省 = 未拴（interact 路径照走）。 */
	leashedBySelf?: () => boolean;
}

export function makeHarness(state: HarnessState, hooks: HarnessHooks = {}) {
	// Each harness owns mutable world state, including nested place/position fields.
	const selfState: SelfState = structuredClone({ ...self, ...hooks.self });
	const calls: string[] = [];
	const world: WorldReadPort = {
		async read<T>(query: { ref: string; input: JsonValue }): Promise<Observation<T>> {
			if (query.ref === "self@1") {
				hooks.onSelf?.(selfState);
				return fact(selfState) as Observation<T>;
			}
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
			if (query.ref === "world@1") {
				const w = state.world ?? { ticks: 1000, weather: "clear", dimension: selfState.place.dimension };
				return fact({
					dimension: w.dimension ?? selfState.place.dimension,
					timeOfDay: "unknown",
					ticks: w.ticks,
					dayCount: null,
					weather: w.weather,
					biome: null,
					difficulty: null,
					gameMode: null,
					spawn: null,
				}) as Observation<T>;
			}
			if (query.ref === "build.plan@1") {
				if (hooks.buildPlan == null) throw new Error("this harness has no build plan");
				return fact(hooks.buildPlan(query.input)) as Observation<T>;
			}
			if (query.ref === "region@1") {
				// 与真实读取器同口径：palette + xzy 索引，未登记的格子是空气，
				// 登记为 null 的格子是"未加载"（-1，不是空气）。
				const raw = query.input as {
					from: { x: number; y: number; z: number };
					to: { x: number; y: number; z: number };
				};
				const origin = {
					x: Math.min(raw.from.x, raw.to.x),
					y: Math.min(raw.from.y, raw.to.y),
					z: Math.min(raw.from.z, raw.to.z),
				};
				const nx = Math.abs(raw.to.x - raw.from.x) + 1;
				const ny = Math.abs(raw.to.y - raw.from.y) + 1;
				const nz = Math.abs(raw.to.z - raw.from.z) + 1;
				const palette: { name: string; properties: Record<string, string> }[] = [{ name: "air", properties: {} }];
				const paletteIndex = new Map<string, number>([["air{}", 0]]);
				const cells: number[] = new Array(nx * ny * nz).fill(0);
				let missing = 0;
				for (let y = origin.y; y < origin.y + ny; y++) {
					for (let z = origin.z; z < origin.z + nz; z++) {
						for (let x = origin.x; x < origin.x + nx; x++) {
							const index = (y - origin.y) * nx * nz + (z - origin.z) * nx + (x - origin.x);
							if (!state.blocks.has(key({ x, y, z }))) continue;
							const block = state.blocks.get(key({ x, y, z }));
							if (block == null) {
								cells[index] = -1;
								missing += 1;
								continue;
							}
							const paletteKey = `${block.name}${JSON.stringify(block.properties)}`;
							let slot = paletteIndex.get(paletteKey);
							if (slot == null) {
								slot = palette.length;
								palette.push({ name: block.name, properties: block.properties });
								paletteIndex.set(paletteKey, slot);
							}
							cells[index] = slot;
						}
					}
				}
				return fact({
					origin,
					shape: [nx, ny, nz],
					palette,
					cells,
					order: "xzy",
					missing,
					scanned: { chunksLoaded: 1 },
				}) as Observation<T>;
			}
			if (query.ref === "entities@1") {
				// 与真实读取器同口径：kind 过滤（all/hostile/passive/player）。
				const kind = (query.input as { kind?: string }).kind;
				const entities = (state.entities ?? []).filter(
					(entity) => kind == null || kind === "all" || entity.kind === kind,
				);
				return fact({
					entities,
					scanned: { radius: (query.input as { radius?: number }).radius ?? 16 },
				}) as Observation<T>;
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
		async interact(request: {
			target: { place: { x: number; y: number; z: number }; block: { x: number; y: number; z: number } };
			face: { x: number; y: number; z: number };
		}) {
			calls.push("interact");
			hooks.onInteract?.(request.target, request.face);
			return { effect: "eff:t:3", dispatch: "sent", completion: "met", evidence: [] };
		},
		async drive(input: { lookAt?: unknown }, ticks: number) {
			calls.push("drive");
			hooks.onDrive?.(ticks, selfState);
			// lookAt 为点目标时按"走过去了"建模（spatial 的近距步进依赖它）；
			// 有 onDrive 钩子时移动语义归钩子（载具驾驶的 lookAt 只转向不位移）。
			const lookAt = input?.lookAt as { x?: unknown; y?: unknown; z?: unknown } | undefined;
			if (
				hooks.onDrive == null &&
				lookAt != null &&
				typeof lookAt.x === "number" &&
				typeof lookAt.y === "number" &&
				typeof lookAt.z === "number"
			) {
				selfState.place = {
					...selfState.place,
					position: { x: Math.floor(lookAt.x) + 0.5, y: Math.floor(lookAt.y), z: Math.floor(lookAt.z) + 0.5 },
				};
			}
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
			hooks.onAttack?.();
			return {
				receipt: { effect: "eff:t:6", dispatch: "sent", completion: "met", evidence: [] },
				hit: true,
				dead: hooks.attackDead ?? true,
			};
		},
		async awaitEvidence() {
			calls.push("awaitEvidence");
			return { hit: true, dead: true };
		},
		async useItem() {
			calls.push("useItem");
			return { effect: "eff:t:7", dispatch: "sent", completion: "met", evidence: [] };
		},
		async awaitBodyEvent(kind: string, options: { passengerId?: number; detached?: boolean } = {}) {
			calls.push(`bodyEvent:${kind}`);
			return (await hooks.bodyEvent?.(kind, options)) ?? { observed: false, vehicleId: null };
		},
		async leashedBySelf() {
			// 默认未拴（走 interact 路径）；已拴场景由 hook 显式建模（批 18 先拴后牵）。
			return hooks.leashedBySelf?.() ?? false;
		},
		async endSleep() {
			calls.push("endSleep");
			return { effect: "eff:t:12", dispatch: "sent", completion: "met", evidence: [] };
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
	const capabilities = builtinCatalog.bind({
		surface: hooks.surface ?? (() => null),
		runtime: () => ({ chat: async () => fact(0) as never, navigate: async (_owner, fn) => fn() }),
		gotoDirector: {
			async goto(request: { at: { x: number; y: number; z: number }; tolerance: number }) {
				calls.push(`goto:${key(request.at)}`);
				if (hooks.gotoFailure != null) throw hooks.gotoFailure();
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
