/**
 * 能力面装配：声明 + 实现（唯一目录）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3–§4。
 * 组合根只拿到 descriptors/readers/callables 三样：World 用 readers 读查询，
 * Runtime 用 callables 执行动作，目录（describe/search）后续直接消费 descriptors。
 * 重复 ref 在这里显式失败——两套同名实现会让目录与执行分叉。
 */

import type { NativeCallable, QueryDescriptor, QueryReader } from "../contracts/capabilities.js";
import type { ExactRef, JsonValue, Ref } from "../contracts/values.js";
import type { CapabilityDeps } from "./deps.js";
import { attackCallable } from "./actions/combat.js";
import { chatCallable } from "./actions/chat.js";
import { collectCallable, dropCallable, pickupCallable } from "./actions/carrying.js";
import { equipCallable, eatCallable } from "./actions/items.js";
import { gotoCallable } from "./actions/navigation.js";
import { placeCallable } from "./actions/building.js";
import { mineCallable } from "./actions/mining.js";
import { useCallable } from "./actions/interaction.js";
import { bodyQueries } from "./queries/body.js";
import { containerCallable, transferCallable } from "./actions/containers.js";
import { containerLastQuery } from "./queries/containers.js";
import { environmentQueries } from "./queries/environment.js";
import { eventsQuery } from "./queries/events.js";
import { knowledgeQueries } from "./queries/knowledge.js";
import { terrainQueries } from "./queries/terrain.js";
import type { QuerySpec } from "./shared/query.js";

export interface BuiltCapabilities {
	/** 查询目录（含由 World 实现读取的 events@1）。 */
	queries: QueryDescriptor[];
	/** World 读取表：只含有当前/静态读取方式的查询。 */
	readers: ReadonlyMap<ExactRef, QueryReader>;
	callables: NativeCallable<JsonValue, JsonValue>[];
	refs: Ref[];
}

export function buildCapabilities(deps: CapabilityDeps): BuiltCapabilities {
	const specs: QuerySpec[] = [
		...bodyQueries(),
		...terrainQueries({ knowledge: deps.knowledge }),
		...environmentQueries({ knowledge: deps.knowledge }),
		...knowledgeQueries({ knowledge: deps.knowledge }),
		eventsQuery,
		containerLastQuery,
	];
	const readers = new Map<ExactRef, QueryReader>();
	for (const spec of specs) {
		if (spec.reader != null) {
			if (readers.has(spec.descriptor.ref)) throw new Error(`duplicate query ref: ${spec.descriptor.ref}`);
			readers.set(spec.descriptor.ref, spec.reader);
		}
	}
	const callables = [
		chatCallable(deps),
		gotoCallable(deps),
		mineCallable(deps),
		placeCallable(deps),
		equipCallable(deps),
		eatCallable(deps),
		useCallable(deps),
		attackCallable(deps),
		collectCallable(deps),
		pickupCallable(deps),
		dropCallable(deps),
		containerCallable(deps),
		transferCallable(deps),
	];
	const seen = new Set<string>();
	for (const callable of callables) {
		if (seen.has(callable.descriptor.ref)) throw new Error(`duplicate callable ref: ${callable.descriptor.ref}`);
		seen.add(callable.descriptor.ref);
	}
	return {
		queries: specs.map((spec) => spec.descriptor),
		readers,
		callables,
		refs: [...seen],
	};
}
