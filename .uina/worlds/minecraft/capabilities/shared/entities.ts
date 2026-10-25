/**
 * 实体目标解析：名字或 EntityRef → 当前跟踪集合里的一条实体。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 entities、§4 attack/use。
 * 名字只匹配当前跟踪范围内的实体；范围外不等于不存在，也不给"最近"以外的猜测。
 */

import type { EntityRef } from "../../contracts/body.js";
import type { WorldReadPort } from "../../contracts/world.js";
import { fail } from "./targets.js";
import { readObservation, type EntityEntryView } from "./views.js";

interface EntitiesValue {
	entities: EntityEntryView[];
	scanned: { radius: number };
}

export async function resolveEntity(
	world: WorldReadPort,
	target: string | EntityRef,
	radius = 16,
): Promise<EntityEntryView> {
	const observation = await readObservation<EntitiesValue>(world, "entities@1", { radius, kind: "all", limit: 128 });
	const entities = observation.value?.entities ?? [];
	if (typeof target !== "string") {
		const found = entities.find((entity) => entity.ref.networkId === target.networkId);
		if (found == null) {
			fail("REFERENCE_STALE", `entity ${target.networkId} is not tracked within ${radius} blocks`, {
				hint: "re-read entities@1; out of range is not proof of absence",
				recoverable: false,
			});
		}
		return found;
	}
	const name = target.replace(/^minecraft:/, "");
	const matches = entities.filter((entity) => entity.name === name || entity.name.endsWith(`:${name}`));
	if (matches.length === 0) {
		fail("NOT_FOUND", `no tracked entity named ${name} within ${radius} blocks`, {
			hint: "read entities@1 first; listing is not proof of absence beyond the radius",
		});
	}
	return matches[0];
}
