/**
 * 备料示例 Program 的行为矩阵（§8.2 / P01）：
 * - 多目标共享一份库存余额（同一木棍不被两次预支）；
 * - 每次动作后重读库存，不凭动作预期记账；
 * - 材料缺口给出具体缺口并交主脑（不假报成功）；
 * - EFFECT_UNCONFIRMED 不盲重派：以最新库存定去留；
 * - 终验只认 inventory@1 的实得数量。
 * 走真实 Program worker（QuickJS guest），host RPC 全部脚本化。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { readProgram } from "../../.uina/worlds/minecraft/library/program-source.js";
import { createProgram } from "../../.uina/worlds/minecraft/program/index.js";
import { createProgramValidator } from "../../.uina/worlds/minecraft/program/validator.js";

const sourcePath = fileURLToPath(new URL("../../.uina/worlds/minecraft/examples/prepare_gear.js", import.meta.url));
const validator = createProgramValidator();
afterAll(async () => {
	await validator.close();
});

/** 石镐 = 3 圆石 + 2 木棍（recipe@1 的单层直接配方计划）。 */
const RECIPE_PLAN = {
	recipes: [{ action: "craft", produces: { stone_pickaxe: 1 }, consumes: { cobblestone: 3, stick: 2 } }],
	plan: {
		steps: [
			{ item: "cobblestone", count: 3, action: "craft" },
			{ item: "stick", count: 2, action: "craft" },
		],
		need: { cobblestone: 3, stick: 2 },
		have: {},
		missing: {},
	},
};

interface ScriptOptions {
	counts: () => Record<string, number>;
	onCall?: (selector: string, input: { item?: string; count?: number }) => void;
	failures?: Map<string, { code: string; message: string }>;
}

/** 脚本化 ProgramHostApi：read/call/sleep/progress 应答注册表。 */
function fakeHost(script: ScriptOptions) {
	const calls: { selector: string; input: { item?: string; count?: number } }[] = [];
	const host = {
		call: async ({ selector, args }: { selector: string; args: { item?: string; count?: number } }) => {
			calls.push({ selector, input: args });
			script.onCall?.(selector, args);
			const failure = script.failures?.get(`${selector}:${args.item}`);
			if (failure) throw Object.assign(new Error(failure.message), failure, { effects: ["eff:unconfirmed"] });
			return { crafted: args.count };
		},
		read: async ({
			targets,
		}: {
			targets: Record<string, { ref: string; input?: { item?: string; count?: number } }>;
		}) => {
			const values: Record<string, unknown> = {};
			const versions: Record<string, string | null> = {};
			const unknown: Record<string, string[]> = {};
			for (const [key, target] of Object.entries(targets)) {
				if (target.ref === "inventory@1") {
					values[key] = { counts: script.counts() };
					versions[key] = null;
					unknown[key] = [];
				} else if (target.ref === "recipe@1") {
					const failure = script.failures?.get(`recipe:${target.input?.item}`);
					if (failure) throw Object.assign(new Error(failure.message), failure);
					values[key] = RECIPE_PLAN;
					versions[key] = null;
					unknown[key] = [];
				} else throw new Error(`unexpected read ${target.ref}`);
			}
			return { values, versions, unknown };
		},
		watch: async () => {
			throw new Error("unexpected watch");
		},
		sleep: async () => null,
		progress: async () => null,
		log: async () => null,
	};
	return { host, calls };
}

async function runPrepare(
	script: ScriptOptions,
	goals: { item: string; count: number }[],
): Promise<
	| { kind: "returned"; value: { prepared: { item: string; count: number }[] } }
	| { kind: "decision"; request: { reason: string } }
	| { kind: "failed"; failure: { code?: string; message?: string; progress?: { phase?: string } } }
> {
	const dir = await mkdtemp(join(tmpdir(), "uina-prepare-"));
	const service = await createProgram({
		dataRoot: dir,
		loadProgram: (name) => readProgram(dir, name),
		onChanged: () => {},
	});
	try {
		const program = await service.resolve({ code: await readFile(sourcePath, "utf8") });
		const validation = await service.validate(program);
		expect(validation.ok).toBe(true);
		const scope = service.openSegment({
			run: "run:prepare",
			segment: "seg:prepare:1",
			signal: new AbortController().signal,
		});
		const result = await scope.invoke({
			call: "call:prepare:1",
			program,
			input: { goals } as never,
			checkpoint: null,
			host: fakeHost(script).host as never,
			signal: new AbortController().signal,
		});
		await scope.close("finished");
		return result as never;
	} finally {
		await service.close();
		await rm(dir, { recursive: true, force: true });
	}
}

test("P01: shared balance, per-action re-read and final inventory verification", async () => {
	// 目标互不为原料：1 石镐 + 剩 5 圆石（初始 8，石镐消耗 3）。
	const inv = { cobblestone: 8, stick: 0, stone_pickaxe: 0 };
	const result = await runPrepare(
		{
			counts: () => ({ ...inv }),
			onCall: (selector, input) => {
				if (selector === "craft@1" && input.item === "stick") inv.stick = Number(input.count);
				if (selector === "craft@1" && input.item === "stone_pickaxe") {
					inv.cobblestone -= 3;
					inv.stick -= 2;
					inv.stone_pickaxe = 1;
				}
			},
		},
		[
			{ item: "stone_pickaxe", count: 1 },
			{ item: "cobblestone", count: 5 },
		],
	);
	expect(result.kind).toBe("returned");
	// 终验只认实得数量：石镐 1、圆石真实剩余 5（共享余额被石镐真实消耗）。
	expect(result.kind === "returned" && result.value.prepared).toEqual([
		{ item: "stone_pickaxe", count: 1 },
		{ item: "cobblestone", count: 5 },
	]);
});

test("P01: the second goal does not re-draw the shared stick balance", async () => {
	const seen: string[] = [];
	const inv = { cobblestone: 3, stick: 0, stone_pickaxe: 0 };
	const result = await runPrepare(
		{
			counts: () => ({ ...inv }),
			onCall: (selector, input) => {
				seen.push(`${selector}:${input.item}:${input.count}`);
				if (selector === "craft@1" && input.item === "stick") inv.stick = Number(input.count);
				if (selector === "craft@1" && input.item === "stone_pickaxe") inv.stone_pickaxe = 1;
			},
		},
		[
			{ item: "stick", count: 2 },
			{ item: "stone_pickaxe", count: 1 },
		],
	);
	expect(result.kind).toBe("returned");
	// stick 只补缺的 2 个；石镐那次合成消耗真实扣减后的余额，不再派发 stick。
	expect(seen).toEqual(["craft@1:stick:2", "craft@1:stone_pickaxe:1"]);
});

test("P01: a materials gap surfaces the concrete shortfall as a decision, never fake success", async () => {
	const result = await runPrepare(
		{
			counts: () => ({}),
			failures: new Map([["craft@1:cobblestone", { code: "MISSING_MATERIAL", message: "missing cobblestone x3" }]]),
		},
		[{ item: "stone_pickaxe", count: 1 }],
	);
	expect(result.kind).toBe("decision");
	expect(result.kind === "decision" && result.request.reason).toContain("无法备齐");
});

test("P01: EFFECT_UNCONFIRMED re-reads inventory and decides instead of replaying the write", async () => {
	const attempts: string[] = [];
	const result = await runPrepare(
		{
			counts: () => ({ cobblestone: 3, stick: 2, stone_pickaxe: 0 }),
			onCall: (selector, input) => attempts.push(`${selector}:${input.item}`),
			failures: new Map([["craft@1:stone_pickaxe", { code: "EFFECT_UNCONFIRMED", message: "unconfirmed" }]]),
		},
		[{ item: "stone_pickaxe", count: 1 }],
	);
	expect(result.kind).toBe("decision");
	expect(result.kind === "decision" && result.request.reason).toContain("未确认");
	// 同一写入只派发一次：不盲重派。
	expect(attempts.filter((entry) => entry === "craft@1:stone_pickaxe")).toHaveLength(1);
});
