/**
 * 能力面装配：声明 + 实现（唯一目录）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3–§4。
 * 组合根拿到描述符、validators、readers 与 callables：World 先校验再读查询，
 * Runtime 用 callables 执行动作，目录（describe/search）后续直接消费 descriptors。
 * 重复 ref 在这里显式失败——两套同名实现会让目录与执行分叉。
 */

import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type { NativeCallable, QueryDescriptor, QueryReader, QueryValidator } from "../contracts/capabilities.js";
import type { ExactRef, JsonValue, Ref } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import type { CapabilityDeps } from "./deps.js";
import { attackCallable, fightCallable } from "./actions/combat.js";
import { chatCallable } from "./actions/chat.js";
import { collectCallable, dropCallable, pickupCallable } from "./actions/carrying.js";
import { craftCallable } from "./actions/craft.js";
import { smeltCallable } from "./actions/smelt.js";
import { equipCallable, eatCallable } from "./actions/items.js";
import { gotoCallable, followCallable, fleeCallable } from "./actions/navigation.js";
import { surfaceCallable } from "./actions/surface.js";
import { excavateCallable } from "./actions/excavate.js";
import { tunnelCallable } from "./actions/tunnel.js";
import { placeCallable } from "./actions/building.js";
import { buildCallable } from "./actions/build.js";
import { mineCallable } from "./actions/mining.js";
import { useCallable } from "./actions/interaction.js";
import { forgetCallable } from "./actions/forget.js";
import { rememberCallable } from "./actions/remember.js";
import { exploreCallable } from "./actions/explore.js";
import { anvilCallable, brewCallable, enchantCallable, grindstoneCallable, tradeCallable } from "./actions/stations.js";
import { bodyQueries } from "./queries/body.js";
import { containerCallable, transferCallable } from "./actions/containers.js";
import { containerLastQuery } from "./queries/containers.js";
import { environmentQueries } from "./queries/environment.js";
import { eventsQuery } from "./queries/events.js";
import { knowledgeQueries } from "./queries/knowledge.js";
import { placesQuery } from "./queries/places.js";
import { regionQuery } from "./queries/region.js";
import { buildPlanQuery } from "./queries/build-plan.js";
import { routePlanQuery } from "./queries/route-plan.js";
import { terrainQueries } from "./queries/terrain.js";
import type { QuerySpec } from "./shared/query.js";

export interface BuiltCapabilities {
	/** 查询目录（含由 World 实现读取的 events@1）。 */
	queries: QueryDescriptor[];
	/** World 读取表：只含有当前/静态读取方式的查询。 */
	readers: ReadonlyMap<ExactRef, QueryReader>;
	/** World executes this boundary before any current/static/history dispatch. */
	validators: ReadonlyMap<ExactRef, QueryValidator>;
	callables: NativeCallable<JsonValue, JsonValue>[];
	refs: Ref[];
}

interface AjvLike {
	compile(schema: Record<string, unknown>): ValidateFunction;
	errorsText(errors?: ValidateFunction["errors"]): string;
}
const AjvCtor = createRequire(import.meta.url)("ajv") as new (options: {
	strict: boolean;
	allErrors: boolean;
}) => AjvLike;

export function buildCapabilities(deps: CapabilityDeps): BuiltCapabilities {
	const specs: QuerySpec[] = [
		...bodyQueries(),
		...terrainQueries({ knowledge: deps.knowledge }),
		regionQuery,
		...environmentQueries({ knowledge: deps.knowledge }),
		...knowledgeQueries({ knowledge: deps.knowledge }),
		eventsQuery,
		containerLastQuery,
		placesQuery,
		routePlanQuery,
		buildPlanQuery,
	];
	const readers = new Map<ExactRef, QueryReader>();
	const validators = new Map<ExactRef, QueryValidator>();
	const ajv = new AjvCtor({ strict: false, allErrors: true });
	for (const spec of specs) {
		const { ref, input } = spec.descriptor;
		if (validators.has(ref)) throw new Error(`duplicate query ref: ${ref}`);
		const validate = ajv.compile(input as Record<string, unknown>);
		validators.set(ref, (raw) => {
			const normalized = raw ?? {};
			if (!validate(normalized))
				throw callFailure({
					code: "INVALID_INPUT",
					source: "input",
					message: `${ref} input rejected: ${ajv.errorsText(validate.errors)}`,
					dispatch: "not_sent",
					effects: [],
					recoverable: true,
				});
			return normalized;
		});
		if (spec.reader != null) {
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
		craftCallable(deps),
		smeltCallable(deps),
		rememberCallable(deps),
		forgetCallable(deps),
		exploreCallable(deps),
		followCallable(deps),
		fleeCallable(deps),
		surfaceCallable(deps),
		fightCallable(deps),
		tunnelCallable(deps),
		excavateCallable(deps),
		buildCallable(deps),
		brewCallable(deps),
		enchantCallable(deps),
		anvilCallable(deps),
		grindstoneCallable(deps),
		tradeCallable(deps),
	];
	const seen = new Set<string>();
	for (const callable of callables) {
		if (seen.has(callable.descriptor.ref)) throw new Error(`duplicate callable ref: ${callable.descriptor.ref}`);
		seen.add(callable.descriptor.ref);
	}
	return {
		queries: specs.map((spec) => spec.descriptor),
		readers,
		validators,
		callables,
		refs: [...seen],
	};
}
