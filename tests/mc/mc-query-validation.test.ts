import { describe, expect, test } from "vitest";
import type { ClientFactView } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { CallFailure, ExactRef, Fact, Vec3 } from "../../.uina/worlds/minecraft/contracts/values.js";
import { buildQueries } from "../../.uina/worlds/minecraft/capabilities/queries.js";
import type { QueryResolver } from "../../.uina/worlds/minecraft/world/current.js";

/**
 * 查询输入校验回归（public-api §3：descriptor.input 是输入的唯一定义）。
 *
 * 历史缺陷：resolver 里手写检查（空查询拒非空、intVec 逐分量、sections 1..4），
 * 与 descriptor.input 的 schema 各写一遍；schema 改了校验不跟，两者必然漂移。
 * 现在校验由 schema 编译而来，resolver 只管组装。
 */

const queries = buildQueries();

function resolverOf(ref: ExactRef): QueryResolver {
	const resolver = queries.resolvers.get(ref);
	if (resolver == null) throw new Error(`query ${ref} not registered`);
	return resolver;
}

const FACT: Fact<unknown> = {
	value: null,
	observedAt: "2026-01-01T00:00:00.000Z",
	source: "server",
	coverage: "complete",
	unknown: [],
	evidence: [],
};

interface ViewCalls {
	blockCalls: { block: Vec3; origin: Vec3 }[];
	sectionCalls: { section: Vec3; origin: Vec3 }[];
}

/** 最小视图：只实现被调用路径需要的方法，并记录实际收到的参数。 */
function makeView(): { view: ClientFactView; calls: ViewCalls } {
	const calls: ViewCalls = { blockCalls: [], sectionCalls: [] };
	const view = {
		scope: () => ({ binding: "bind:t", world: "world:t", worldRevision: "wrev:t", dimension: "overworld" }),
		self: () => FACT,
		inventory: () => FACT,
		entities: () => FACT,
		block: (target: { block: Vec3; place: { position: Vec3 } }) => {
			calls.blockCalls.push({ block: target.block, origin: target.place.position });
			return FACT;
		},
		sections: (targets: { section: Vec3; position: Vec3 }[]) => {
			calls.sectionCalls = targets.map((t) => ({ section: t.section, origin: t.position }));
			return FACT;
		},
	} as unknown as ClientFactView;
	return { view, calls };
}

async function captureFailure(run: () => unknown): Promise<CallFailure> {
	try {
		await run();
	} catch (err) {
		return err as CallFailure;
	}
	throw new Error("expected the resolver to reject");
}

describe("查询输入按 descriptor.input 校验", () => {
	test("空查询收到非空输入：INVALID_INPUT，不进入 resolver", async () => {
		const { view } = makeView();
		const err = await captureFailure(() => resolverOf("self@1")(view, { extra: true }));
		expect(err.code).toBe("INVALID_INPUT");
		expect(err.source).toBe("input");
		expect(err.dispatch).toBe("not_sent");
	});

	test("空查询收到 null：等同空对象放行（WorldQuery.input 允许 null）", async () => {
		const { view } = makeView();
		const fact = resolverOf("self@1")(view, null);
		expect(fact).toBe(FACT);
	});

	test("block@1 缺 block 或非整数：INVALID_INPUT", async () => {
		const { view } = makeView();
		const missing = await captureFailure(() => resolverOf("block@1")(view, {}));
		expect(missing.code).toBe("INVALID_INPUT");
		const fractional = await captureFailure(() => resolverOf("block@1")(view, { block: { x: 0.5, y: 64, z: 0 } }));
		expect(fractional.code).toBe("INVALID_INPUT");
	});

	test("block@1 合法输入：resolver 收到原始坐标", async () => {
		const { view, calls } = makeView();
		resolverOf("block@1")(view, { block: { x: 3, y: 70, z: -2 } });
		expect(calls.blockCalls).toEqual([{ block: { x: 3, y: 70, z: -2 }, origin: { x: 3, y: 70, z: -2 } }]);
	});

	test("blocks@1 数量超出 1..4：INVALID_INPUT（由 schema 的 minItems/maxItems 拦截）", async () => {
		const { view } = makeView();
		const section = { x: 0, y: 4, z: 0 };
		const tooMany = await captureFailure(() =>
			resolverOf("blocks@1")(view, { sections: Array.from({ length: 5 }, () => ({ section })) }),
		);
		expect(tooMany.code).toBe("INVALID_INPUT");
		const none = await captureFailure(() => resolverOf("blocks@1")(view, { sections: [] }));
		expect(none.code).toBe("INVALID_INPUT");
	});

	test("blocks@1 合法输入：section 原点按 16 倍换算后传给视图", async () => {
		const { view, calls } = makeView();
		resolverOf("blocks@1")(view, { sections: [{ section: { x: 1, y: 2, z: -1 } }] });
		expect(calls.sectionCalls).toEqual([{ section: { x: 1, y: 2, z: -1 }, origin: { x: 16, y: 32, z: -16 } }]);
	});
});
