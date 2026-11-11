/**
 * collect@1 的自损支撑约束（§B1）：
 * - 唯一候选是脚下方块时不直接采挖——不挖掉自己站立的支撑，如实带进度失败；
 * - 存在其他候选时照常采集（不退化）。
 * 走真实 Program worker（QuickJS guest），host RPC 脚本化。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { collectProgram } from "../../.uina/worlds/minecraft/program/collect.js";
import { createProgram } from "../../.uina/worlds/minecraft/program/index.js";
import { createProgramValidator } from "../../.uina/worlds/minecraft/program/validator.js";

const validator = createProgramValidator();
afterAll(async () => {
	await validator.close();
});

interface ScriptOptions {
	/** blocks@1 返回的候选格。 */
	candidates: { x: number; y: number; z: number }[];
	/** 机器人站位（自足支撑 = 脚下一格）。 */
	position: { x: number; y: number; z: number };
	onMine?: (at: { x: number; y: number; z: number }) => void;
}

function fakeHost(script: ScriptOptions) {
	const calls: { selector: string; input: Record<string, unknown> }[] = [];
	let version = 0;
	const inventory = { counts: {} as Record<string, number> };
	const host = {
		call: async ({ selector, args }: { selector: string; args: Record<string, unknown> }) => {
			calls.push({ selector, input: args });
			if (selector === "mine@1") {
				script.onMine?.(args.at as { x: number; y: number; z: number });
				inventory.counts.raw_iron = (inventory.counts.raw_iron ?? 0) + 1;
				version += 1;
			}
			if (selector === "pickup@1") return {};
			if (selector === "mine@1") return { broken: true, tool: null };
			return { ok: true };
		},
		read: async ({ targets }: { targets: Record<string, { ref: string; input?: Record<string, unknown> }> }) => {
			const values: Record<string, unknown> = {};
			const versions: Record<string, string | null> = {};
			const unknown: Record<string, string[]> = {};
			for (const [key, target] of Object.entries(targets)) {
				if (target.ref === "item@1")
					values[key] = {
						name: "raw_iron",
						stackSize: 64,
						sourcesComplete: true,
						sources: [{ kind: "block", block: "iron_ore", harvest: { kind: "any" } }],
					};
				else if (target.ref === "inventory@1")
					values[key] = { counts: { ...inventory.counts }, slots: [], freeSlots: 10 };
				else if (target.ref === "self@1")
					values[key] = { place: { position: script.position, dimension: "overworld" }, onGround: true };
				else if (target.ref === "blocks@1")
					values[key] = { blocks: script.candidates.map((position) => ({ position })) };
				else throw new Error(`unexpected read ${target.ref}`);
				versions[key] = `v:${version}`;
				unknown[key] = [];
			}
			return { values, versions, unknown };
		},
		watch: async () => ({ status: "timeout" as const }),
		sleep: async () => null,
		progress: async () => null,
		log: async () => null,
	};
	return { host, calls, inventory };
}

async function runCollect(
	script: ScriptOptions,
): Promise<
	| { kind: "returned"; value: Record<string, unknown> }
	| { kind: "failed"; failure: { code?: string; message?: string; progress?: Record<string, unknown> } }
	| { kind: "decision"; request: { reason: string } }
> {
	const dir = await mkdtemp(join(tmpdir(), "uina-collect-"));
	const service = await createProgram({
		dataRoot: dir,
		loadProgram: (name) => Promise.reject(new Error(`no library program expected: ${name}`)),
		onChanged: () => {},
	});
	try {
		const program = await service.resolve({ code: collectProgram });
		const validation = await service.validate(program);
		expect(validation.ok).toBe(true);
		const scope = service.openSegment({
			run: "run:collect",
			segment: "seg:collect:1",
			signal: new AbortController().signal,
		});
		const result = await scope.invoke({
			call: "call:collect:1",
			program,
			input: { item: "raw_iron", count: 1, radius: 8 } as never,
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

test("B1: the standing support block as the only candidate is not mined; the failure carries real progress", async () => {
	const mineCalls: { x: number; y: number; z: number }[] = [];
	const result = await runCollect({
		// 唯一候选 = 站位 (10,64,10) 的支撑块 (10,63,10)。
		candidates: [{ x: 10, y: 63, z: 10 }],
		position: { x: 10, y: 64, z: 10 },
		onMine: (at) => mineCalls.push(at),
	});
	expect(result.kind).toBe("failed");
	expect(result.kind === "failed" && result.failure.code).toBe("NOT_FOUND");
	expect(result.kind === "failed" && result.failure.message).toContain("standing on");
	// 未派发任何挖掘/导航：不挖自己脚下。
	expect(mineCalls).toHaveLength(0);
});

test("B1: with another candidate the bot mines that one and keeps the standing support intact", async () => {
	const mineCalls: { x: number; y: number; z: number }[] = [];
	const result = await runCollect({
		candidates: [
			{ x: 10, y: 63, z: 10 }, // 支撑块（不采）
			{ x: 11, y: 63, z: 10 }, // 正常候选（距离 1，无需导航）
		],
		position: { x: 10, y: 64, z: 10 },
		onMine: (at) => mineCalls.push(at),
	});
	expect(result.kind).toBe("returned");
	expect(result.kind === "returned" && result.value.acquired).toBe(1);
	expect(mineCalls).toEqual([{ x: 11, y: 63, z: 10 }]);
});
