/**
 * 能力目录（catalog.ts）合同：静态可发现、结构校验拒绝激活、模块化注入。
 *
 * 内置 56 项（18 查询 + 38 动作）由 mc-capability-queries.test.ts 的目录完整性
 * 断言守护；这里只测目录自身的机制：离线 descriptors、id/ref 唯一、schema 门、
 * 外部模块注入（不改 central array）与 bind 产出。
 */

import { describe, expect, test } from "vitest";
import type { MinecraftCapabilityModule } from "../../.uina/worlds/minecraft/capabilities/catalog.js";
import { CapabilityCatalog } from "../../.uina/worlds/minecraft/capabilities/catalog.js";
import type { CapabilityDeps } from "../../.uina/worlds/minecraft/capabilities/deps.js";
import { builtinModules, createCapabilityCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import { self } from "./mc-capability-harness.js";

const noopDeps = {} as CapabilityDeps;

function testModule(overrides: Partial<MinecraftCapabilityModule> = {}): MinecraftCapabilityModule {
	return {
		id: "test-module",
		definitions: [
			{
				kind: "query",
				descriptor: {
					ref: "test.echo@1",
					summary: "test-only echo query",
					input: { type: "object", additionalProperties: false },
					output: { type: "object" },
					access: "read",
					watchable: false,
					feedback: false,
					examples: [],
				},
				bind: () => ({
					kind: "static",
					read: () => ({ observedAt: "", source: "server", coverage: "partial", unknown: [], value: {}, evidence: [] }),
				}),
			},
		],
		...overrides,
	};
}

describe("能力目录", () => {
	test("离线列出全部 56 项 descriptor：不触发 bind、不依赖 deps", () => {
		const descriptors = createCapabilityCatalog().allDescriptors();
		const refs = descriptors.map((d) => d.ref).sort();
		expect(refs).toHaveLength(56);
		expect(refs.filter((ref) => ref.endsWith("@1"))).toHaveLength(56);
		const queries = descriptors.filter((d) => d.access === "read");
		const actions = descriptors.filter((d) => d.access === "act");
		expect(queries).toHaveLength(18);
		expect(actions).toHaveLength(38);
	});

	test("bind 产出与目录同源：18 查询 / 38 动作 / refs 只含动作", () => {
		const built = createCapabilityCatalog().bind(noopDeps);
		expect(built.queries).toHaveLength(18);
		expect(built.callables).toHaveLength(36);
		expect(built.programs.map(({ descriptor }) => descriptor.ref)).toEqual(["collect@1", "build.resume@1"]);
		expect(built.refs).toHaveLength(38);
		expect(new Set(built.refs).size).toBe(38);
		// query reader 与 descriptor 同一清单：self@1 有 reader，events@1 由 World 读取。
		expect(built.readers.has("self@1")).toBe(true);
		expect(built.readers.has("events@1")).toBe(false);
		expect(built.validators.has("self@1")).toBe(true);
		expect(built.validators.size).toBe(18);
		// bind 后的 reader 可用（self@1 读采样视图，不触碰 deps.runtime）。
		const reader = built.readers.get("self@1");
		expect(reader?.kind).toBe("current");
	});

	test("重复 ref 拒绝（同类与跨类），重复模块 id 拒绝", () => {
		expect(() => CapabilityCatalog.create([testModule(), testModule({ id: "test-module-2" })])).toThrow(
			"duplicate capability ref: test.echo@1",
		);
		expect(() =>
			CapabilityCatalog.create([
				testModule(),
				{
					id: "test-act",
					definitions: [
						{
							kind: "action",
							descriptor: {
								ref: "test.echo@1",
								summary: "cross-kind duplicate",
								input: { type: "object" },
								output: { type: "object" },
								access: "act",
								completion: { scope: "execution", description: "" },
								errors: [],
								requires: [],
								examples: [],
								implementation: "native",
							},
							bind: () => async () => ({}),
						},
					],
				},
			]),
		).toThrow("duplicate capability ref: test.echo@1");
		expect(() => CapabilityCatalog.create([testModule(), testModule({ id: "test-module", definitions: [] })])).toThrow(
			"duplicate capability module id: test-module",
		);
	});

	test("schema 不可编译的模块拒绝激活，不静默替换已有能力", () => {
		const broken: MinecraftCapabilityModule = {
			id: "broken",
			definitions: [
				{
					kind: "query",
					descriptor: {
						ref: "test.broken@1",
						summary: "bad schema",
						input: { type: "not-a-type" },
						output: { type: "object" },
						access: "read",
						watchable: false,
						feedback: false,
						examples: [],
					},
					bind: () => null,
				},
			],
		};
		expect(() => CapabilityCatalog.create([broken])).toThrow("test.broken@1 input schema rejected");
		expect(() => CapabilityCatalog.create([...builtinModules, broken])).toThrow(/test\.broken@1/);
	});

	test("注入测试模块无需修改内置清单：静态可见 + bind 可调 + 内置不受影响", () => {
		const catalog = CapabilityCatalog.create([...builtinModules, testModule()]);
		expect(catalog.allDescriptors().some((d) => d.ref === "test.echo@1")).toBe(true);
		const built = catalog.bind(noopDeps);
		expect(built.queries).toHaveLength(19);
		// testModule 只注入一个查询：动作数不变。
		expect(built.callables).toHaveLength(36);
		expect(built.programs.map(({ descriptor }) => descriptor.ref)).toEqual(["collect@1", "build.resume@1"]);
		const reader = built.readers.get("test.echo@1");
		expect(reader?.kind).toBe("static");
		// 注入不得扰动内置：重建纯内置目录，ref 集与默认目录一致。
		const pure = CapabilityCatalog.create(builtinModules);
		expect(pure.allDescriptors().some((d) => d.ref === "test.echo@1")).toBe(false);
		expect(pure.allDescriptors().length).toBe(createCapabilityCatalog().allDescriptors().length);
	});

	test("self@1 的 reader 读同一事实视图（绑定产物与采样合同对齐）", () => {
		const built = createCapabilityCatalog().bind(noopDeps);
		const reader = built.readers.get("self@1");
		if (reader?.kind !== "current") throw new Error("self@1 must have a current reader");
		const fact = reader.read(
			{
				self: () => ({
					observedAt: "2026-01-01T00:00:00.000Z",
					source: "server",
					coverage: "complete",
					unknown: [],
					evidence: [],
					value: self,
				}),
				inventory: () => ({
					observedAt: "2026-01-01T00:00:00.000Z",
					source: "server",
					coverage: "complete",
					unknown: ["inventory not received"],
					evidence: [],
					value: null,
				}),
			} as never,
			{},
		);
		expect(fact.value).toMatchObject({ armor: {} });
		expect(fact.unknown).toContain("inventory not received; held/armor unknown");
	});
});
