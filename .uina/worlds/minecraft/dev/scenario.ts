/**
 * 真服场景脚本的公共骨架：起调用、读事实、发 op 指令、逐步记账。
 *
 * 唯一定义来源：development-guide.md §5（游戏动作走真实服务端验证）。
 * 这里只做"跑一次调用并记录"，不含任何玩法判断——判断写在各自场景里。
 * 场景准备允许用 op 指令摆地形/物品，被测行为必须走能力层。
 */

import type { SelfState } from "../contracts/body.js";
import type { JsonValue, Vec3 } from "../contracts/values.js";
import { sleep, type DevHarness } from "./harness.js";

export interface CallResult {
	ok: boolean;
	value?: JsonValue;
	code?: string;
	message?: string;
}

export interface InventoryView {
	slots: { slot: number; name: string; count: number }[];
	counts: Record<string, number>;
	held?: { name: string; count: number };
	usedSlots?: number;
	freeSlots?: number;
}

export interface BlockView {
	name: string;
	position: Vec3;
	properties: Record<string, string>;
	sign: unknown;
}

export interface BlockRead {
	block: BlockView | null;
}

export interface EntityView {
	ref: { networkId: number };
	name: string;
	kind: string;
	position: Vec3;
	distance: number;
	item: { name: string; count: number } | null;
}

export interface Scenario {
	call: (ref: string, input: JsonValue, timeoutMs?: number) => Promise<CallResult>;
	readSelf: () => Promise<SelfState>;
	readBlock: (at: Vec3) => Promise<BlockView | null>;
	readInventory: () => Promise<InventoryView>;
	readEntities: (radius?: number) => Promise<EntityView[]>;
	readBlocks: (name: string, radius?: number) => Promise<{ position: Vec3; name: string }[]>;
	/** op 指令：走 chat@1 发 /命令，与服务端同一通道。 */
	command: (text: string) => Promise<void>;
	step: (name: string, run: () => Promise<string>) => Promise<void>;
	/** 打印汇总并设置退出码；返回失败条数。 */
	finish: () => number;
	log: (message: string) => void;
}

export function makeScenario(h: DevHarness, label: string): Scenario {
	const { world, runtime: rt, ns, worldOwner, activation } = h;
	const log = (message: string): void => console.log(`[mc-${label}] ${message}`);
	const results: { step: string; ok: boolean; detail: string }[] = [];
	let seq = 0;

	const call = async (ref: string, input: JsonValue, timeoutMs = 30000): Promise<CallResult> => {
		const requestId = `req:${ns}:${label}-${++seq}`;
		const acceptance = await rt.submit(
			{ worldOwner, activation },
			{ requestId, entry: { kind: "call", selector: ref, input }, schedule: { kind: "enqueue" } },
		);
		if (acceptance.kind !== "accepted") {
			return { ok: false, code: "REJECTED", message: JSON.stringify(acceptance) };
		}
		const reply = await rt.wait(acceptance.snapshot.run, { timeoutMs });
		if (reply.kind !== "result" || reply.snapshot.phase !== "finished") {
			// 验收脚本放弃这个步骤时显式停自己的 Run，避免它在后续步骤继续改世界。
			// 这不是产品工具的等待取消语义；正式工具仍不因等待结束而停止任务。
			await rt.stop({ requestId: `stop:${requestId}`, target: { run: acceptance.snapshot.run } });
			return { ok: false, code: "TIMEOUT", message: reply.kind };
		}
		if (reply.snapshot.outcome !== "succeeded") {
			// RunSummary 只带 code/message（contracts/runtime.ts）；hint/progress 只在调用记录里，
			// 场景不据此判定，失败面用"世界/库存有没有变"证明。
			return {
				ok: false,
				code: reply.snapshot.error?.code ?? reply.snapshot.outcome,
				message: reply.snapshot.error?.message,
			};
		}
		const record = rt.readRecord(reply.snapshot.record).value as unknown as { value?: JsonValue };
		return { ok: true, value: record.value };
	};

	const readSelf = async (): Promise<SelfState> => {
		const observation = await world.read<SelfState>({ ref: "self@1", input: {} });
		if (observation.value == null) throw new Error("self@1 returned null");
		return observation.value;
	};

	const readBlock = async (at: Vec3): Promise<BlockView | null> => {
		const observation = await world.read<BlockRead>({
			ref: "block@1",
			input: { at: { x: at.x, y: at.y, z: at.z } },
		});
		return observation.value?.block ?? null;
	};

	const readInventory = async (): Promise<InventoryView> => {
		const observation = await world.read<InventoryView>({ ref: "inventory@1", input: {} });
		if (observation.value == null) throw new Error("inventory@1 returned null");
		return observation.value;
	};

	const readEntities = async (radius = 16): Promise<EntityView[]> => {
		const observation = await world.read<{ entities: EntityView[] }>({
			ref: "entities@1",
			input: { radius, kind: "all", limit: 128 },
		});
		return observation.value?.entities ?? [];
	};

	const readBlocks = async (name: string, radius = 32): Promise<{ position: Vec3; name: string }[]> => {
		const observation = await world.read<{ blocks: { position: Vec3; name: string }[] }>({
			ref: "blocks@1",
			input: { name, radius, limit: 256 },
		});
		return observation.value?.blocks ?? [];
	};

	const command = async (text: string): Promise<void> => {
		const result = await call("chat@1", { text });
		if (!result.ok) throw new Error(`command failed: ${text} -> ${result.code} ${result.message ?? ""}`);
		await sleep(350);
	};

	const step = async (name: string, run: () => Promise<string>): Promise<void> => {
		try {
			const detail = await run();
			results.push({ step: name, ok: true, detail });
			log(`PASS ${name}: ${detail}`);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			results.push({ step: name, ok: false, detail });
			log(`FAIL ${name}: ${detail}`);
		}
	};

	const finish = (): number => {
		const failed = results.filter((entry) => !entry.ok);
		log("---- summary ----");
		for (const entry of results) log(`${entry.ok ? "PASS" : "FAIL"} ${entry.step}: ${entry.detail}`);
		log(`${label.toUpperCase()} ${failed.length === 0 ? "PASS" : `FAIL (${failed.length}/${results.length})`}`);
		if (failed.length > 0) process.exitCode = 1;
		return failed.length;
	};

	return { call, readSelf, readBlock, readInventory, readEntities, readBlocks, command, step, finish, log };
}
