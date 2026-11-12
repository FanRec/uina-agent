/**
 * 工作站共用件（批 15）：站解析、开窗守卫、区域搬运与"结果物品的真实组件"。
 *
 * 五个工作站动作（brew / enchant / anvil / grindstone / trade）是同一套骨架：
 * 派发前判可预知失败 → 走过去 → 开窗 → 放输入 → 专用提交 → 按证据取结果。
 * 这里只放它们真正重复的部分；每项的玩法判断留在 actions/stations.ts。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 的 K7 五条合同；
 * 真服实测（archive/stations-implementation.md）确认了五类窗口的槽数、属性语义与提交包行为。
 */

import type {
	BlockTarget,
	EntityRef,
	ItemValue,
	SelfState,
	WindowSession,
	WindowSnapshot,
} from "../../contracts/body.js";
import type { BodyCallScope, CallContext } from "../../contracts/capabilities.js";
import type { RegistryKnowledge } from "../../contracts/knowledge.js";
import type { Ref, Vec3 } from "../../contracts/values.js";
import { approachBlock, withRelocation } from "./approach.js";
import { checkBudget } from "./observe.js";
import { findStation, placeStation } from "./stations.js";
import { assertSameDimension, fail, resolveGrid, resolvePoint, stripNamespace } from "./targets.js";
import { type InventorySnapshot, itemCountOf, readBlockAt } from "./views.js";
import {
	expectation,
	moveState,
	placeCursor,
	transferWindow,
	windowClick,
	windowItem,
	windowRegion,
	windowSlot,
} from "./window-transfer.js";

/** 一次调用里的站位：带世界/连接代次，用于复查是不是同一个站。 */
export interface Station {
	block: string;
	position: Vec3;
	target: BlockTarget;
	connection?: Ref;
	incarnation?: Ref;
}

export interface StationRequest {
	block: string;
	at?: unknown;
	deadline: number;
	/** 没有站也没有材料时的提示。 */
	hint: string;
}

/**
 * 定位工作站：显式 at / 8 格内最近的 / 用背包里的放一个。
 * 与 smelt@1 原来的 resolveFurnace 是同一件事，这里成为唯一实现。
 */
export async function resolveStation(
	ctx: CallContext,
	request: StationRequest,
	inventory: InventorySnapshot,
): Promise<Station> {
	const observation = await ctx.world.read<SelfState>({ ref: "self@1", input: {} });
	const self = observation.value;
	if (self == null) fail("WRONG_STATE", "self state is not available");
	checkBudget(ctx, request.deadline, request.block);
	let position: Vec3;
	if (request.at != null) {
		const point = resolvePoint(request.at, self);
		assertSameDimension(point, self, request.block);
		position = resolveGrid(request.at, self);
	} else {
		const nearby = await findStation(ctx, request.block, 8);
		if (nearby != null) {
			position = nearby;
		} else if (itemCountOf(inventory, request.block) > 0) {
			checkBudget(ctx, request.deadline, request.block);
			position = await placeStation(ctx, request.block);
		} else {
			fail("WRONG_STATE", `no ${request.block} nearby and none in the inventory`, { hint: request.hint });
		}
	}
	checkBudget(ctx, request.deadline, request.block);
	const block = await readBlockAt(ctx.world, position);
	if (block == null || stripNamespace(block.name) !== request.block)
		fail("NOT_FOUND", `target is not an observed ${request.block}`, {
			hint: `pass at with the ${request.block} position, or stand next to one`,
		});
	return {
		block: request.block,
		position,
		target: { block: position, place: { ...self.place, position } },
		connection: observation.connection,
		incarnation: observation.incarnation,
	};
}

/** 站还在原地且还是同一个世界/连接：过期的站位不能继续点。 */
export async function validateStation(ctx: CallContext, station: Station): Promise<void> {
	const current = await ctx.world.read<SelfState>({ ref: "self@1", input: {} });
	const original = station.target.place;
	const place = current.value?.place;
	if (
		place == null ||
		place.world !== original.world ||
		place.worldRevision !== original.worldRevision ||
		place.dimension !== original.dimension ||
		current.connection !== station.connection ||
		current.incarnation !== station.incarnation
	)
		fail("REFERENCE_STALE", `the original ${station.block} world or player identity changed`);
	const block = await readBlockAt(ctx.world, station.position);
	if (block == null || stripNamespace(block.name) !== station.block)
		fail("REFERENCE_STALE", `the original ${station.block} is no longer present`);
}

/**
 * 走到站前、开窗、断言窗口类型、跑完就强制关窗。
 * 窗口类型不符是硬失败：把 input/fuel 当普通格搬会静默错位。
 */
export async function withStation<T>(
	ctx: CallContext,
	station: Station,
	windowType: string,
	deadline: number,
	work: (window: WindowSession, snapshot: WindowSnapshot) => Promise<T>,
): Promise<T> {
	checkBudget(ctx, deadline, station.block);
	await validateStation(ctx, station);
	await approachBlock(ctx, station.position, station.block);
	await validateStation(ctx, station);
	checkBudget(ctx, deadline, station.block);
	// §5 局部自治：够近但 Driver 判定视线受阻时，释放 Body 后换少量安全站位再试；
	// 窗口写操作一旦开始，失败按原语义冒泡，不换位重放。
	return await withRelocation(ctx, station.position, station.block, async (scope: BodyCallScope) => {
		checkBudget(ctx, deadline, station.block);
		await validateStation(ctx, station);
		const window = await scope.player.openContainer(station.target);
		try {
			checkBudget(ctx, deadline, station.block);
			const snapshot = (await window.snapshot()).value;
			if (snapshot.type !== windowType)
				fail("UNSUPPORTED_WINDOW", `${station.block} opened ${snapshot.type}, expected ${windowType}`, {
					hint: "the server changed the menu shape for this version; the layout table must be updated first",
					recoverable: false,
				});
			return await work(window, snapshot);
		} finally {
			await window.close({ force: true });
		}
	});
}

/**
 * 实体工作站（商人）：没有方块可校验，走到实体跟前再开窗。
 * 站位与窗口类型仍然复核，交易语义留在调用方。
 */
export async function withEntity<T>(
	ctx: CallContext,
	ref: EntityRef,
	position: Vec3,
	windowType: string,
	deadline: number,
	work: (window: WindowSession, snapshot: WindowSnapshot) => Promise<T>,
): Promise<T> {
	checkBudget(ctx, deadline, "merchant");
	await approachBlock(ctx, position, "merchant");
	checkBudget(ctx, deadline, "merchant");
	return await withRelocation(
		ctx,
		{ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) },
		"merchant",
		async (scope: BodyCallScope) => {
			checkBudget(ctx, deadline, "merchant");
			const window = await scope.player.openContainer(ref);
			try {
				checkBudget(ctx, deadline, "merchant");
				const snapshot = (await window.snapshot()).value;
				if (snapshot.type !== windowType)
					fail("UNSUPPORTED_WINDOW", `this entity opened ${snapshot.type}, expected ${windowType}`, {
						hint: "only merchant menus are supported here",
						recoverable: false,
					});
				return await work(window, snapshot);
			} finally {
				await window.close({ force: true });
			}
		},
	);
}

/** 区域里的指定物品总数（材料预算与结算共用）。 */ export function countInRegion(
	snapshot: WindowSnapshot,
	region: string,
	name: string,
): number {
	return windowRegion(snapshot, region).reduce((sum, slot) => {
		const item = windowSlot(snapshot, slot);
		return sum + (item?.name === name ? item.count : 0);
	}, 0);
}

/** 整体取回一个区域（结果槽、付款槽、成品瓶都走它）。 */
export async function takeRegion(
	window: WindowSession,
	region: string,
	onProgress?: (amounts: { moved: Record<string, number> }) => Promise<void>,
): Promise<void> {
	await transferWindow(
		window,
		{ direction: "from", all: true },
		{ regions: { block: region, player: "player" }, ...(onProgress == null ? {} : { onProgress }) },
	);
}

/** 把背包里指定物品放进区域（自动落到该区域第一个空位或同类堆）。 */
export async function putRegion(window: WindowSession, region: string, item: string, count: number): Promise<void> {
	await transferWindow(window, { direction: "to", item, count }, { regions: { block: region, player: "player" } });
}

/**
 * 商人结果槽取货。服务端在取货后**立刻补货**（付款还有余量时结果槽马上又是成品），
 * 所以这次点击不满足"纯 mode-0 交换"的不变量：槽位后态不等于预测。
 * 这里只要求派发成功，完成由调用方的背包增量判定（与 drop@1 的地面增量同口径），
 * 不重放、也不用未知回执洗白。
 */
export async function clickResultSlot(window: WindowSession, snapshot: WindowSnapshot, slot: number): Promise<void> {
	const receipt = await window.click({
		slot,
		button: 0,
		mode: 0,
		expectedRevision: snapshot.revision,
		expectedSlots: [{ slot, stack: expectation(windowSlot(snapshot, slot)) }],
		expectedCursor: expectation(windowItem(snapshot.cursor)),
	});
	if (receipt.dispatch === "not_sent") fail("TARGET_NOT_MET", "the result click was not dispatched");
}

/**
 * 把玩家区某个**具体槽**的整摞搬到窗口目标槽。
 *
 * `transferWindow` 只能按物品名挑"第一个匹配"，当同一物品有多件实例（例如两把剑，
 * 一把已附魔一把没有）时无法指名。附魔/砂轮要的是"这一件"，所以在这里按槽号搬。
 */
export async function moveExact(
	window: WindowSession,
	snapshot: WindowSnapshot,
	sourceSlot: number,
	destinationSlot: number,
): Promise<WindowSnapshot> {
	const held = windowSlot(snapshot, sourceSlot);
	if (held == null) fail("NOT_FOUND", `nothing to move from inventory slot ${sourceSlot}`);
	if (windowSlot(snapshot, destinationSlot) != null)
		fail("WRONG_STATE", `the ${destinationSlot} slot is already occupied`);
	const state = moveState(snapshot);
	await windowClick(window, state, sourceSlot, 0);
	await windowClick(window, state, destinationSlot, 0);
	const moved = windowSlot(state.snapshot, destinationSlot);
	if (moved == null || moved.name !== held.name || moved.count !== held.count)
		fail("TARGET_NOT_MET", `expected ${held.count} ${held.name} in slot ${destinationSlot}`, { dispatch: "sent" });
	return state.snapshot;
}

/**
 * 把付款槽收敛到正好够一份。
 *
 * 服务端 `select_trade` 会把**整摞**付款搬进付款槽，取货后只要余量还够就又补一份成品——
 * 那样点击后态就不等于 mode-0 预测，回执只能是 unknown，整个 run 也会被结算成 unknown。
 * 先收敛成"正好一份"，取货就回到纯交换（与 craft@1 的"每批只摆恰好一批料"同一个道理）。
 */
export async function trimPayment(
	window: WindowSession,
	snapshot: WindowSnapshot,
	slot: number,
	amount: number,
): Promise<WindowSnapshot> {
	const have = windowSlot(snapshot, slot);
	if (have == null || have.count <= amount) return snapshot;
	const excess = have.count - amount;
	const state = moveState(snapshot);
	await windowClick(window, state, slot, 0);
	await placeCursor(window, state, [slot], amount, () => undefined);
	await placeCursor(window, state, windowRegion(state.snapshot, "player"), excess, () => undefined);
	return state.snapshot;
}

/** 物品的某个组件数据；类型名是裸名（enchantments / potion_contents / custom_name）。 */ export function componentOf(
	item: ItemValue | null,
	type: string,
): unknown {
	const components = item?.components as { added?: { type?: string; data?: unknown }[] } | null | undefined;
	const entry = components?.added?.find((part) => part?.type === type);
	return entry?.data ?? null;
}

/**
 * 附魔列表：只认真正的组件，不从物品名猜。
 * 附魔书用 stored_enchantments，装备用 enchantments；两者都有时一起列。
 */
export function enchantmentsOf(
	item: ItemValue | null,
	knowledge: RegistryKnowledge,
): { name: string; level: number }[] | null {
	const read = (type: string): { id: number; level: number }[] => {
		const data = componentOf(item, type) as { enchantments?: { id?: number; level?: number }[] } | null;
		return (data?.enchantments ?? []).filter(
			(entry): entry is { id: number; level: number } =>
				typeof entry?.id === "number" && typeof entry?.level === "number",
		);
	};
	const entries = [...read("enchantments"), ...read("stored_enchantments")];
	if (entries.length === 0) return null;
	return entries.map((entry) => ({
		// 查不到就报编号：不编一个像真名的假名字。
		name: knowledge.enchantment(entry.id)?.name ?? `#${entry.id}`,
		level: entry.level,
	}));
}

/** 自定义名（铁砧改名后才有）；没有就是 null。 */
export function customNameOf(item: ItemValue | null): string | null {
	const data = componentOf(item, "custom_name") as { value?: unknown } | null;
	return typeof data?.value === "string" ? data.value : null;
}

/** 药水注册表编号（服务端不下发 potion 注册表，只能报编号）。 */
export function potionIdOf(item: ItemValue | null): number | null {
	const data = componentOf(item, "potion_contents") as { potionId?: unknown } | null;
	return typeof data?.potionId === "number" ? data.potionId : null;
}

/** 堆叠上限：先用窗口里实测的 stackSize，再退回知识表；都没有就明确失败。 */
export function stackLimit(knowledge: RegistryKnowledge, snapshot: WindowSnapshot, name: string): number {
	const observed = snapshot.slots
		.map((slot) => slot.item as unknown as { name: string; stackSize?: number } | null)
		.find((item) => item?.name === name && item.stackSize != null)?.stackSize;
	const limit = observed ?? knowledge.item(name)?.stackSize;
	if (limit == null || limit < 1) fail("WRONG_STATE", `stack limit for ${name} is unknown`);
	return limit;
}
