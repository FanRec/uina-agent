/**
 * 真服场景脚本的公共骨架：起调用、读事实、发 op 指令、逐步记账。
 *
 * 唯一定义来源：development-guide.md §5（游戏动作走真实服务端验证）。
 * 这里只做"跑一次调用并记录"，不含任何玩法判断——判断写在各自场景里。
 * 场景准备允许用 op 指令摆地形/物品，被测行为必须走能力层。
 */

import type { SelfState } from "../contracts/body.js";
import type { JsonValue, Vec3 } from "../contracts/values.js";
import { type DevHarness, sleep } from "./harness.js";

export interface CallResult {
	ok: boolean;
	value?: JsonValue;
	code?: string;
	message?: string;
}

export interface InventoryView {
	slots: { slot: number; name: string; count: number; components?: JsonValue; durability?: number | null }[];
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

export interface PlayerRowView {
	name: string;
	uuid: string | null;
	displayName: string | null;
	latencyMs: number | null;
	gameMode: string | null;
	tracked: { ref: { networkId: number }; position: Vec3; distance: number } | null;
}

export interface PlayersView {
	extent: "server_listed";
	players: PlayerRowView[];
	listedCount: number;
	truncated: boolean;
}

export interface SpawnedCall {
	run: string;
	requestId: string;
}

/** 服务端对"世界里有没有这个东西"的判决，取自 `/execute if` 的回执文本。 */
export interface ServerInventory {
	counts: Record<string, number>;
	/** server = `/data get` 解析成功；client = 回执被截断，退回 inventory@1 并如实标注。 */
	source: "server" | "client";
	truncated: boolean;
	/** 解析为空时的回执原文摘录：区分"真的空背包"与"回执形状没认出"。 */
	raw?: string;
}

export interface Scenario {
	call: (ref: string, input: JsonValue, timeoutMs?: number) => Promise<CallResult>;
	/** 后台派发：submit 后立即返回 run 引用（follow/fight 的"会话期间操作世界"用）。 */
	spawn: (ref: string, input: JsonValue) => Promise<SpawnedCall>;
	/** 等待 spawn 的 run 结束并结算为 CallResult；超时显式停自己的 Run。 */
	waitCall: (spawned: SpawnedCall, timeoutMs?: number) => Promise<CallResult>;
	readSelf: () => Promise<SelfState>;
	readBlock: (at: Vec3) => Promise<BlockView | null>;
	readInventory: () => Promise<InventoryView>;
	readEntities: (radius?: number) => Promise<EntityView[]>;
	readPlayers: (input?: { name?: string; limit?: number }) => Promise<PlayersView>;
	readBlocks: (name: string, radius?: number) => Promise<{ position: Vec3; name: string }[]>;
	/** op 指令：走 chat@1 发 /命令，与服务端同一通道。 */
	command: (text: string) => Promise<void>;
	/** 服务端真值：/data get entity <selector> <path> 的最新回执文本（骑乘态客户端
	 *  视图的独立对照源；events@1 升序，取最后一条匹配）。 */
	serverData: (selector: string, path: string) => Promise<string>;
	/** 服务端真值坐标：/data get Pos 的解析结果（解析失败返回 null）。 */
	serverPos: (selector: string) => Promise<Vec3 | null>;
	/** 发任意指令并返回它之后到达的第一条服务端回执文本（按事件游标切窗，不吃旧消息）。 */
	serverReply: (command: string) => Promise<string>;
	/** `/execute if ...` 的布尔判决；回执既非 passed 也非 failed 时抛错，不猜。 */
	serverProbe: (command: string) => Promise<boolean>;
	/** 逐格方块断言（结构核验用）。 */
	serverBlock: (at: Vec3, name: string) => Promise<boolean>;
	/** 服务端库存：/data get Inventory 解析；截断时退回 inventory@1 并标 source=client。 */
	serverInventory: (selector?: string) => Promise<ServerInventory>;
	/** 服务端血量与饥饿值（/data get Health 与 food）。 */
	serverHealth: (selector?: string) => Promise<{ health: number | null; food: number | null }>;
	/** 从游标起算某类事件；死亡计数必须这样取，否则历史事件会污染本次判定。 */
	eventsSince: (
		after: string | null,
		kinds?: ("chat" | "damage" | "death" | "connection")[],
	) => Promise<{ events: { payload?: unknown }[]; after: string | null }>;
	/** 当前事件游标（用于开窗前记录基线）。 */
	eventCursor: (kinds?: ("chat" | "damage" | "death" | "connection")[]) => Promise<string | null>;
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

	const spawn = async (ref: string, input: JsonValue): Promise<SpawnedCall> => {
		const requestId = `req:${ns}:${label}-${++seq}`;
		const acceptance = await rt.submit(
			{ worldOwner, activation },
			{ requestId, entry: { kind: "call", selector: ref, input }, schedule: { kind: "enqueue" } },
		);
		if (acceptance.kind !== "accepted") throw new Error(`${ref} rejected: ${JSON.stringify(acceptance)}`);
		return { run: acceptance.snapshot.run, requestId };
	};

	const waitCall = async (spawned: SpawnedCall, timeoutMs = 30000): Promise<CallResult> => {
		const reply = await rt.wait(spawned.run, { timeoutMs });
		if (reply.kind !== "result" || reply.snapshot.phase !== "finished") {
			// 验收脚本放弃这个步骤时显式停自己的 Run，避免它在后续步骤继续改世界。
			// 这不是产品工具的等待取消语义；正式工具仍不因等待结束而停止任务。
			await rt.stop({ requestId: `stop:${spawned.requestId}`, target: { run: spawned.run } });
			return { ok: false, code: "TIMEOUT", message: reply.kind };
		}
		if (reply.snapshot.outcome !== "succeeded") {
			// RunSummary 只带 code/message（contracts/runtime.ts）；hint/progress 只在调用记录里，
			// 场景不据此判定，失败面用"世界/库存有没有变"证明。
			// outcome 异常（如 unknown）时先读运行记录拿真实结果：记录里有值 = 调用其实成功，
			// 只是 outcome 未落；记录读不出值才把快照摘录带出来。
			try {
				const full = await rt.readRecord(reply.snapshot.record);
				if (full.kind === "inline") {
					const record = full.record.value as { value?: JsonValue; code?: string; message?: string };
					if (record.value !== undefined) {
						return { ok: true, value: record.value };
					}
					if (record.code != null) {
						return { ok: false, code: record.code, message: record.message };
					}
				}
			} catch {
				// 记录读不出：保持 outcome 侧信息
			}
			let recordDetail = "";
			try {
				const failed = await rt.readRecord(reply.snapshot.record);
				if (failed.kind === "inline") recordDetail = JSON.stringify(failed.record.value).slice(0, 3000);
			} catch {
				/* 记录读不出：保持快照摘录 */
			}
			return {
				ok: false,
				code: reply.snapshot.error?.code ?? reply.snapshot.outcome,
				message: `${reply.snapshot.error?.message ?? ""} | record=${recordDetail || `snapshot=${JSON.stringify(reply.snapshot).slice(0, 220)}`}`,
			};
		}
		const full = await rt.readRecord(reply.snapshot.record);
		if (full.kind !== "inline") throw new Error("expected inline development record");
		const record = full.record.value as { value?: JsonValue };
		return { ok: true, value: record.value };
	};

	const call = async (ref: string, input: JsonValue, timeoutMs = 30000): Promise<CallResult> =>
		await waitCall(await spawn(ref, input), timeoutMs);

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

	const readPlayers = async (input: { name?: string; limit?: number } = {}): Promise<PlayersView> => {
		const observation = await world.read<PlayersView>({ ref: "players@1", input });
		if (observation.value == null) throw new Error("players@1 returned null");
		return observation.value;
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

	const eventText = (payload: unknown): string => {
		// chat 事件的正文就在 payload.text；直接取可以避开 JSON 转义（`id: \"x\"` 会让字段正则失配）。
		if (payload != null && typeof payload === "object" && typeof (payload as { text?: unknown }).text === "string") {
			return (payload as { text: string }).text;
		}
		const raw = JSON.stringify(payload ?? "");
		const match = /"text":"((?:[^"\\]|\\.)*)"/.exec(raw);
		return match != null ? match[1] : raw;
	};

	const eventCursor = async (kinds: ("chat" | "damage" | "death" | "connection")[] = ["chat"]) => {
		const observation = await world.read<{ after?: string | null }>({
			ref: "events@1",
			input: { limit: 1, kinds },
		});
		return observation.value?.after ?? null;
	};

	const eventsSince = async (
		after: string | null,
		kinds: ("chat" | "damage" | "death" | "connection")[] = ["death"],
	) => {
		const observation = await world.read<{ events?: { payload?: unknown }[]; after?: string | null }>({
			ref: "events@1",
			input: { limit: 200, kinds, ...(after != null ? { after } : {}) },
		});
		return { events: observation.value?.events ?? [], after: observation.value?.after ?? null };
	};

	/**
	 * 按事件游标切窗发指令：先记游标、再发、只读窗内新事件。
	 * 旧实现扫最近 40 条并靠关键字匹配，历史回执与本轮回复无法区分（并发聊天即误判）。
	 */
	const serverReply = async (command: string): Promise<string> => {
		const cursor = await eventCursor();
		const result = await call("chat@1", { text: command });
		if (!result.ok) throw new Error(`command failed: ${command} -> ${result.code} ${result.message ?? ""}`);
		// 回执可能晚于固定等待到达：轮询到窗内出现消息为止（上限 2s），而不是猜一个 sleep。
		const deadline = Date.now() + 2000;
		let texts: string[] = [];
		while (texts.length === 0 && Date.now() < deadline) {
			await sleep(150);
			const observation = await world.read<{ events?: { payload?: unknown }[] }>({
				ref: "events@1",
				input: { limit: 20, kinds: ["chat"], ...(cursor != null ? { after: cursor } : {}) },
			});
			texts = (observation.value?.events ?? []).map((event) => eventText(event.payload));
		}
		return texts.at(-1) ?? "NO_OUTPUT";
	};

	const serverProbe = async (command: string): Promise<boolean> => {
		const text = await serverReply(command);
		if (text.includes("Test passed")) return true;
		if (text.includes("Test failed")) return false;
		throw new Error(`unrecognized /execute reply: ${text}`);
	};

	const serverBlock = async (at: Vec3, name: string): Promise<boolean> => {
		const block = name.includes(":") ? name : `minecraft:${name}`;
		return await serverProbe(`/execute if block ${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)} ${block}`);
	};

	const serverInventory = async (selector = process.env.MC_DEV_USER ?? "UinaDev"): Promise<ServerInventory> => {
		const text = await serverData(selector, "Inventory");
		if (text.includes("Found no elements matching") || text.includes("does not have the following entity data")) {
			return { counts: {}, source: "server", truncated: false };
		}
		const truncated = text.includes("...");
		const counts: Record<string, number> = {};
		if (!truncated) {
			for (const chunk of text.split(/\},\s*\{/)) {
				const id = /id:\s*"(?:minecraft:)?([a-z0-9_]+)"/.exec(chunk)?.[1];
				const count = /count:\s*(\d+)/.exec(chunk)?.[1];
				if (id != null && count != null) counts[id] = (counts[id] ?? 0) + Number(count);
			}
		}
		// 回执被截断时不猜：退回客户端视图（它同样由服务端包推进）并如实标注来源。
		if (truncated) return { counts: (await readInventory()).counts, source: "client", truncated };
		return {
			counts,
			source: "server",
			truncated,
			...(Object.keys(counts).length === 0 ? { raw: text.slice(0, 300) } : {}),
		};
	};

	const serverHealth = async (
		selector = process.env.MC_DEV_USER ?? "UinaDev",
	): Promise<{ health: number | null; food: number | null }> => {
		const parse = (text: string): number | null => {
			const match = /entity data:\s*(-?[\d.]+)/.exec(text);
			return match == null ? null : Number(match[1]);
		};
		const health = parse(await serverData(selector, "Health"));
		const food = parse(await serverData(selector, "foodLevel"));
		return { health, food };
	};

	// /data get 回执有两种形状（拿到数据 / 没有这个标签）；解析归各 serverXxx，这里只取原文。
	const serverData = (selector: string, path: string): Promise<string> =>
		serverReply(`/data get entity ${selector} ${path}`);

	const serverPos = async (selector: string): Promise<Vec3 | null> => {
		const text = await serverData(selector, "Pos");
		const match = /\[(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/.exec(text);
		return match == null ? null : { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
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

	return {
		call,
		spawn,
		waitCall,
		readSelf,
		readBlock,
		readInventory,
		readEntities,
		readPlayers,
		readBlocks,
		command,
		serverData,
		serverPos,
		serverReply,
		serverProbe,
		serverBlock,
		serverInventory,
		serverHealth,
		eventsSince,
		eventCursor,
		step,
		finish,
		log,
	};
}
