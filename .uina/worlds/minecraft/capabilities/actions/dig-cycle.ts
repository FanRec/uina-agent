/**
 * tunnel/excavate 共用的单格挖除与短腿行走（mine@1 同款证据口径）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 mine/tunnel/excavate。
 * 完成 = 服务端确认该格变为空气；掉落观察归各动作（excavate 聚合 drops）。
 * 这里只收敛"一格怎么挖、一站怎么走"的公共序列；失败映射由动作按合同执行。
 */

import type { ControlOwner, ItemSelector, SelfState } from "../../contracts/body.js";
import type { BodyCallScope, CallContext } from "../../contracts/capabilities.js";
import type { RegistryKnowledge } from "../../contracts/knowledge.js";
import type { CallFailure, EffectReceipt, Ref, Vec3 } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { readValue } from "../shared/observe.js";
import { BLOCK_REACH, blockReach, round2 } from "../shared/reach.js";
import { isLiquidBlock } from "../shared/spatial.js";
import { canHarvest, chooseTool, harvestRequirement } from "../shared/tools.js";
import { readBlockAt, readInventory } from "../shared/views.js";
import { placeOf } from "./place-cell.js";

export type DigCellResult =
	| { kind: "dug"; tool: string | null; name: string }
	| { kind: "open" }
	| { kind: "not_loaded" }
	| { kind: "liquid" }
	/** 采掘要求已知而当前库存不满足；names 为空表示已知没有任何工具采得动（如基岩）。 */
	| { kind: "unbreakable"; names: string[] }
	| { kind: "unreachable"; distance: number }
	| { kind: "not_met"; dispatch: EffectReceipt["dispatch"]; effect: Ref };

function heldItemName(inventory: Awaited<ReturnType<typeof readInventory>>): string | null {
	if (inventory.selectedSlot == null) return null;
	const held = inventory.slots.find((slot) => slot.slot === inventory.selectedSlot! + 36);
	return held?.name ?? null;
}

/**
 * 挖一格：读现场 → 可采性/液体/射程判别 → 选工具并装备 → dig 等服务端确认。
 * chooseTool 的 MISSING_TOOL/WRONG_STATE/MISSING_MATERIAL 原样上抛（派发前失败）；
 * 其余结局以判别结果返回，由动作决定是停是记 remaining。
 */
export async function digCell(
	deps: CapabilityDeps,
	scope: BodyCallScope,
	self: SelfState,
	position: Vec3,
): Promise<DigCellResult> {
	const block = await readBlockAt(scope.world, position);
	if (block == null) return { kind: "not_loaded" };
	if (block.name === "air") return { kind: "open" };
	if (isLiquidBlock(block.name)) return { kind: "liquid" };
	const reach = blockReach(self, position);
	if (reach > BLOCK_REACH) return { kind: "unreachable", distance: reach };
	const knowledge: RegistryKnowledge | null = deps.knowledge();
	const inventory = await readInventory(scope.world);
	// 知识缺失不是"挖不动"：交给 chooseTool 如实 WRONG_STATE（与 mine@1 同口径）。
	if (knowledge != null && !canHarvest(knowledge, inventory, block.name)) {
		const requirement = harvestRequirement(knowledge, block.name);
		return {
			kind: "unbreakable",
			names: requirement.kind === "tools" ? [...requirement.names] : [],
		};
	}
	const tool = chooseTool(knowledge, inventory, block.name);
	if (tool != null && heldItemName(inventory) !== tool) {
		const selector: ItemSelector = { name: tool, substitutions: [] };
		const equipped = await scope.player.equip(selector, "hand");
		if (equipped.completion !== "met") {
			return { kind: "not_met", dispatch: equipped.dispatch, effect: equipped.effect };
		}
	}
	let receipt: Awaited<ReturnType<typeof scope.player.dig>>;
	try {
		receipt = await scope.player.dig({ place: placeOf(self, position), block: position });
	} catch (error) {
		// Driver 零派发拒绝（例如瞄准期间这一格已经被挖成空气）：按世界读数复核，
		// 真的空了就按"无需再挖"收口，不把一次没有发出的写当成施工失败。
		const failure = error as Partial<CallFailure> | null;
		if (failure?.name === "CallFailure" && failure.dispatch === "not_sent") {
			const after = await readBlockAt(scope.world, position);
			if (after == null) return { kind: "not_loaded" };
			if (after.name === "air") return { kind: "open" };
		}
		throw error;
	}
	if (receipt.completion !== "met") {
		// 重力方块会在挖掘期间落走：回执等的是"这一格变成空气"，落走恰好让它提前空了。
		// 以世界读数为准——格已空就按挖掉算，否则如实返回未确认。
		const after = await readBlockAt(scope.world, position);
		if (after != null && after.name === "air")
			return { kind: "dug", tool: tool == null ? null : tool, name: block.name };
		return { kind: "not_met", dispatch: receipt.dispatch, effect: receipt.effect };
	}
	return { kind: "dug", tool: tool == null ? null : tool, name: block.name };
}

/**
 * 一段受控行走（excavate 的远距兜底）：顶层 navigate 作用域，
 * digThrough/placeToReach 由调用方给定；UNREACHABLE/TIMEOUT/CONTROL_CONFLICT 原样上抛。
 * 近距 1-2 格不要用它（经验 22：GoalNear 近距空路径/NoPath）——用 stepTo。
 */
export async function walkLeg(
	deps: CapabilityDeps,
	ctx: CallContext,
	owner: ControlOwner,
	at: Vec3,
	options: { tolerance: number; timeoutMs: number; digThrough: boolean },
): Promise<void> {
	await deps.runtime().navigate(owner, () =>
		deps.gotoDirector.goto(
			{
				at,
				tolerance: options.tolerance,
				sprint: true,
				digThrough: options.digThrough,
				placeToReach: false,
				timeoutMs: options.timeoutMs,
			},
			ctx.signal,
		),
	);
}

const STEP_BURST_TICKS = 4;

/**
 * 近距步进（MC-WORLD.md 经验 22）：1-2 格的站间移动不走寻路，直接
 * lookAt 目标脚位中心 + drive 前进（上坡档自动带跳），直到站上目标格。
 * 已在目标格水平范围内但未落定时松开键位等重力结算——贴墙死推会触发服务端
 * 位置回弹，把客户端物理状态（onGround）打坏，之后 drive 完全失效（真服实测）。
 * 上坡用退步助跑 + sprint-jump（贴脸起跳会楔进台阶面，经验 27）。
 * 必须在 withBody 内使用（drive 是身体操作）。
 */
export async function stepTo(
	ctx: CallContext,
	scope: BodyCallScope,
	target: Vec3,
	options?: { maxMs?: number; trace?: string[] },
): Promise<boolean> {
	const center = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 };
	const deadline = Date.now() + (options?.maxMs ?? 3000);
	for (;;) {
		const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
		const flat = Math.hypot(self.place.position.x - center.x, self.place.position.z - center.z);
		const settled = Math.abs(self.place.position.y - target.y) <= 0.55;
		if (flat <= 0.75 && settled) return true;
		options?.trace?.push(
			`${self.place.position.x.toFixed(2)},${self.place.position.y.toFixed(2)},${self.place.position.z.toFixed(2)}`,
		);
		if (ctx.signal.aborted || Date.now() >= deadline) return false;
		if (flat <= 0.75 && !settled) {
			// 停在目标格上空：松键让它落定，不推墙。
			await scope.player.drive({ keys: {} }, STEP_BURST_TICKS);
			continue;
		}
		const needJump = self.place.position.y < target.y - 0.25;
		if (needJump) {
			// 上坡：贴脸起跳会楔进台阶面（起跳后横向速度被面碰撞清零，真服实测）——
			// 已贴脸先退一步，再 sprint-jump 助跑让弧线越过踏步面。
			if (flat < 1.3) {
				await scope.player.drive({ keys: { back: true }, lookAt: center }, STEP_BURST_TICKS);
				continue;
			}
			await scope.player.drive({ keys: { forward: true, jump: true, sprint: true }, lookAt: center }, 10);
			continue;
		}
		await scope.player.drive({ keys: { forward: true }, lookAt: center }, STEP_BURST_TICKS);
	}
}

/** 距离提示文案（UNREACHABLE hint 用）。 */
export function reachHint(distance: number, position: Vec3): string {
	return `${position.x},${position.y},${position.z} out of reach (${round2(distance)} > ${BLOCK_REACH})`;
}
