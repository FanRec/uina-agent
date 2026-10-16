import { describe, expect, it } from "vitest";
import { isWorldDef } from "../src/extensions/world-framework/world-loader.js";
import createMinecraftWorldDef from "../.uina/worlds/minecraft/worlddef/index.js";

describe("minecraft worlddef", () => {
	it("骨架导出合法 WorldDef 且默认不启用", () => {
		const def = createMinecraftWorldDef();
		expect(isWorldDef(def)).toBe(true);
		expect(def.name).toBe("minecraft");
		expect(Object.keys(def.actions)).toContain("minecraft");
		expect(def.defaultState?.enabled).toBe(false);
	});

	it("façade 动作在执行侧未装配时返回 not_started 且不产生副作用", async () => {
		const def = createMinecraftWorldDef();
		const result = await def.actions.minecraft.run(
			{ action: "run", params: { call: "x@1" } },
			{
				operationIdentity: "world:minecraft/minecraft",
				signal: new AbortController().signal,
			},
		);
		expect(result.status).toBe("not_started");
	});
});
