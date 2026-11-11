/**
 * 领域效果核验器（G4 首批落点）：ctx.verify 的注册实现。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §7（EffectVerifier）、known-gaps §G4。
 * 核验器不派发动作，只按效果已记录事实 + 当前世界读数给追加判断；
 * 未加载/读不到一律 unknown，不冒充 met 或 not_met。
 */

import type { EffectVerifier } from "../../contracts/runtime.js";
import type { Vec3 } from "../../contracts/values.js";
import { callFailure } from "../../contracts/values.js";
import { readObservation } from "./views.js";

export const DIG_VERIFIER_REF = "verify/dig@1";

interface DigTargetDetail {
	target?: { x: number; y: number; z: number };
	dimension?: string;
}

/** 最新一条带目标格的 dig 事实（receipt 优先于 dispatch，晚到截面覆盖早截面）。 */
function digFactOf(facts: { contract: string; kind: string; detail?: unknown }[]): {
	target: Vec3;
	dimension: string | null;
} | null {
	for (let i = facts.length - 1; i >= 0; i--) {
		const fact = facts[i];
		if (fact.contract !== "body.dig@1" || fact.kind !== "receipt") continue;
		const detail = fact.detail as DigTargetDetail | null;
		const target = detail?.target;
		if (
			target != null &&
			typeof target.x === "number" &&
			typeof target.y === "number" &&
			typeof target.z === "number"
		) {
			return { target: { x: target.x, y: target.y, z: target.z }, dimension: detail?.dimension ?? null };
		}
	}
	return null;
}

/**
 * dig 效果核验：目标格现在是空气吗？未加载 → unknown；仍为方块 → not_met。
 * 世界身份资格（§3.5.4）：事实带维度且与当前维度不一致时不给终态判断（跨维度
 * 的同坐标空气不能确认原效果）；旧格式事实没有维度身份，同样只做诊断观察。
 */
export function digVerifier(): EffectVerifier {
	return {
		check: async (effect, world) => {
			const digFacts = effect.facts.filter((fact) => fact.contract === "body.dig@1");
			if (digFacts.length === 0) {
				throw callFailure({
					code: "INVALID_INPUT",
					source: "capability",
					message: `verifier ${DIG_VERIFIER_REF} applies to body.dig@1 effects, not ${effect.operation}`,
					dispatch: "not_sent",
					effects: [effect.effect],
					recoverable: false,
				});
			}
			const dig = digFactOf(digFacts);
			if (dig == null) {
				return {
					completion: "unknown",
					evidence: [],
					reason: "dig effect facts carry no target position (older session format)",
				};
			}
			const { target } = dig;
			const self = await readObservation<{ place: { dimension?: string } }>(world, "self@1", {});
			const currentDimension = self.value?.place?.dimension ?? null;
			if (dig.dimension != null && currentDimension != null && dig.dimension !== currentDimension) {
				return {
					completion: "unknown",
					evidence: self.evidence ?? [],
					reason: `effect was recorded in ${dig.dimension}, current dimension is ${currentDimension}; a same-coordinate read cannot confirm it`,
				};
			}
			if (dig.dimension == null) {
				return {
					completion: "unknown",
					evidence: [],
					reason: "dig effect facts carry no dimension identity (older session format); this read is diagnostic only",
				};
			}
			// Vec3 没有索引签名，过 JsonValue 边界要拷成纯值。
			const observation = await readObservation<{ block: { name: string } | null }>(world, "block@1", {
				at: { x: target.x, y: target.y, z: target.z },
			});
			const evidence = observation.evidence ?? [];
			if (observation.value?.block == null) {
				return {
					completion: "unknown",
					evidence,
					reason: `cell ${target.x},${target.y},${target.z} is not loaded (unknown is not air)`,
				};
			}
			if (observation.value.block.name === "air") {
				return { completion: "met", evidence, reason: `cell ${target.x},${target.y},${target.z} is air` };
			}
			return {
				completion: "not_met",
				evidence,
				reason: `cell ${target.x},${target.y},${target.z} still holds ${observation.value.block.name}`,
			};
		},
	};
}

/** 组合根注册表：新增核验器随能力工作包到这里登记（known-gaps §G4）。 */
export function buildVerifiers(): Map<`${string}@${string}`, EffectVerifier> {
	return new Map([[DIG_VERIFIER_REF, digVerifier()]]);
}
