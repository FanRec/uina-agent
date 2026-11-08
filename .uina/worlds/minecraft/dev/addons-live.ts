/**
 * Addon 真服验收（addons.md §5）：连接已在运行的 Paper 1.21.11，不自行起停服。
 *
 * 覆盖：
 * - 安装/启用分离：未启用不 import、目录不暴露、动作 NOT_FOUND；
 * - 重连后装配生效：status.active.addons / describe(kind:"addon") / 包内能力可调用；
 * - 纵向闭环：example.press@1 在 BodyScope 内发自定义通道 → 服务端计数 → 事实回读 → 动作结算；
 * - 包内静态知识：example.recipes@1 与 item@1 的 example:uina_token（sourcesComplete=false）；
 * - 冻结语义：连接期间改 addons.json 不热替换，重连才生效。
 *
 * 用法：先启动 dev-env 服务器（含 uina-example-plugin），再 `pnpm dev:mc:addons`。
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addonStatus, disableAddon, enableAddon, installAddon } from "../addons/manage.js";
import { readAddonSelectionFile, selectionDigest, writeAddonSelectionFile } from "../addons/plan.js";
import type { CallRecord } from "../contracts/runtime.js";
import { createMinecraftWorld } from "../worlddef/index.js";
import type { SessionStatus } from "../worlddef/session-controller.js";
import type { ServiceCompanionContext, WorldDef } from "../../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import type { HostDeliveryPort } from "../../../../src/core/types.js";

const PORT = 25565;
const EXAMPLES = fileURLToPath(new URL("../examples/addons", import.meta.url));

function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = await read();
		if (check(value)) return value;
		if (Date.now() > deadline) throw new Error(`condition timed out: ${JSON.stringify(value)?.slice(0, 400)}`);
		await sleep(250);
	}
}

function stubContext(root: string): { ctx: ServiceCompanionContext; exposed: Map<string, unknown> } {
	const exposed = new Map<string, unknown>();
	const delivery = {
		namespace: "world:minecraft",
		session: "addons-live",
		durability: "durable",
		inspect: async () => ({ kind: "absent" }),
		retire: async () => ({ kind: "retired" }),
	} as unknown as HostDeliveryPort;
	return {
		exposed,
		ctx: {
			signal: new AbortController().signal,
			worldDataDir: root,
			emitEvent: async () => ({ accepted: true }),
			onHostEvent: () => () => {},
			isBusy: () => false,
			expose: (name: string, value: unknown) => {
				exposed.set(name, value);
				return () => exposed.delete(name);
			},
			delivery,
		} as ServiceCompanionContext,
	};
}

function act(world: WorldDef, action: string) {
	return async (params: Record<string, unknown>): Promise<ToolExecutionResult> =>
		await world.actions[action]!.run(params, {
			operationIdentity: `world:minecraft/${action}`,
			signal: new AbortController().signal,
		});
}

type Reply = ToolExecutionResult & { details: Record<string, unknown> };

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "uina-mc-addons-"));
	const legacyPath = join(root, "..", `uina-mc-addons-config-${process.pid}.json`);
	await writeFile(
		legacyPath,
		JSON.stringify({
			connection: { host: "127.0.0.1", port: PORT, username: "UinaAddon", authMode: "offline", version: "1.21.11" },
			binding: { world: "addons-live-world", worldRevision: "r1" },
		}),
		"utf8",
	);
	console.log(`[mc-addons] data root: ${root}`);

	const world = createMinecraftWorld({ legacyConfigPath: legacyPath });
	const { ctx } = stubContext(root);
	const session = act(world, "session");
	const describe = act(world, "describe") as (params: Record<string, unknown>) => Promise<Reply>;
	const observe = act(world, "observe") as (params: Record<string, unknown>) => Promise<Reply>;
	const run = act(world, "run") as (params: Record<string, unknown>) => Promise<Reply>;
	const runs = act(world, "runs") as (params: Record<string, unknown>) => Promise<Reply>;
	let passed = 0;
	const step = async (name: string, execute: () => Promise<void>) => {
		await execute();
		passed++;
		console.log(`[mc-addons] PASS ${name}`);
	};
	const status = async () => (await session({ op: "status" })).details as unknown as SessionStatus;

	const calls = async (runRef: string): Promise<CallRecord[]> => {
		const all: CallRecord[] = [];
		let cursor: string | undefined;
		do {
			const page = (await runs({ op: "calls", run: runRef, ...(cursor ? { cursor } : {}) })).details;
			all.push(...(page.items as CallRecord[]));
			cursor = page.next as string | undefined;
		} while (cursor);
		return all;
	};
	const readCall = async (recordRef: string): Promise<CallRecord> => {
		const reply = await runs({ op: "record", ref: recordRef, format: "inline" });
		const record = (reply.details as { record?: { value?: CallRecord } }).record;
		assert(record?.value != null, `call record unavailable: ${JSON.stringify(reply.details).slice(0, 200)}`);
		return record.value;
	};
	const finish = async (reply: Reply): Promise<{ run: string; phase: string; outcome?: string }> => {
		const accepted = reply.details as { kind?: string; run?: string; snapshot?: { run?: string } };
		assert(accepted.kind === "accepted" || accepted.kind === "result", JSON.stringify(reply.details).slice(0, 300));
		const runRef = typeof accepted.run === "string" ? accepted.run : accepted.snapshot?.run;
		assert(typeof runRef === "string", `no run ref: ${JSON.stringify(reply.details).slice(0, 300)}`);
		const result = await until(
			async () => (await runs({ op: "wait", run: runRef, timeoutMs: 2000 })).details,
			(value) => value.kind === "result",
			90_000,
		);
		return result.snapshot as { run: string; phase: string; outcome?: string };
	};

	try {
		await world.onStart!(ctx);

		await step("T0：安装包 ≠ 启用包——离线状态只报 installed，能力不在目录里", async () => {
			await installAddon(root, join(EXAMPLES, "example-mod"));
			const inventory = await addonStatus(root);
			assert(inventory.addons.length === 1, JSON.stringify(inventory.addons));
			assert(
				inventory.addons.every((addon) => addon.state === "installed" && addon.contributed.refs.length === 0),
				JSON.stringify(inventory.addons),
			);
			const described = await describe({ kind: "addon", name: "example-mod" });
			assert(described.status === "succeeded", JSON.stringify(described.details).slice(0, 300));
			const entry = described.details as { status: { state: string }; capabilities: string[] };
			assert(entry.status.state === "installed", JSON.stringify(entry));
			assert(
				entry.capabilities.length === 0,
				`offline capabilities must be empty: ${JSON.stringify(entry.capabilities)}`,
			);
			const missing = await describe({ selector: "example.machine@1" });
			assert(
				missing.status === "failed" && (missing.details as { code?: string }).code === "NOT_FOUND",
				JSON.stringify(missing.details).slice(0, 200),
			);
		});

		await step("T1：连接时未启用——包不 import、目录不暴露、动作 NOT_FOUND", async () => {
			const connected = (await session({ op: "connect", target: { server: "default" } })).details as SessionStatus;
			assert(connected.state === "connected", JSON.stringify(connected).slice(0, 300));
			const active = connected.active!;
			assert(active.addons.digest === selectionDigest([]), `empty digest expected: ${JSON.stringify(active.addons)}`);
			assert(active.addons.ids.length === 0, JSON.stringify(active.addons));

			const missing = await describe({ kind: "addon", name: "example-mod" });
			assert(
				missing.status === "failed" && (missing.details as { code?: string }).code === "NOT_FOUND",
				JSON.stringify(missing.details).slice(0, 200),
			);
			const refused = await run({ selector: "example.press@1", input: { times: 1 } });
			assert(
				refused.status === "failed" && (refused.details as { code?: string }).code === "NOT_FOUND",
				JSON.stringify(refused.details).slice(0, 200),
			);
		});

		let profileId = "";
		await step("T2：Profile 启用包——连接期间不热替换（仍 NOT_FOUND）", async () => {
			const profiles = (await readdir(join(root, "sessions"))).filter((entry) => /^[a-f0-9]{64}$/.test(entry));
			assert(profiles.length === 1, `expected one profile: ${JSON.stringify(profiles)}`);
			profileId = profiles[0]!;
			await enableAddon({ root, profileId, id: "example-mod", config: { verifyTimeoutMs: 4000 } });
			const frozen = await describe({ kind: "addon", name: "example-mod" });
			assert(
				frozen.status === "failed" && (frozen.details as { code?: string }).code === "NOT_FOUND",
				`selection must stay frozen for the live session: ${JSON.stringify(frozen.details).slice(0, 200)}`,
			);
			const st = await status();
			assert(st.active!.addons.ids.length === 0, JSON.stringify(st.active!.addons));

			// 坏计划必须在建立执行域之前失败：启用未安装的包 → connect 失败且不留下半开会话。
			const selection = await readAddonSelectionFile(join(root, "sessions", profileId));
			await writeAddonSelectionFile(join(root, "sessions", profileId), {
				enabled: { ...selection.enabled, ghost: {} },
			});
			await session({ op: "disconnect" });
			const failed = await session({ op: "connect", target: { server: "default" } });
			assert(
				failed.status === "failed" && (failed.details as { code?: string }).code === "ADDON_NOT_INSTALLED",
				JSON.stringify(failed.details).slice(0, 300),
			);
			const afterFailure = await status();
			assert(afterFailure.state === "disconnected" && afterFailure.active === null, JSON.stringify(afterFailure));
			await writeAddonSelectionFile(join(root, "sessions", profileId), { enabled: selection.enabled });
		});

		await step("T3：重连后装配生效——status/describe 报 loaded 与确切 ref", async () => {
			await session({ op: "disconnect" });
			const reconnected = (await session({ op: "connect", target: { server: "default" } })).details as SessionStatus;
			assert(reconnected.state === "connected", JSON.stringify(reconnected).slice(0, 300));
			const addons = reconnected.active!.addons;
			assert(addons.digest.length === 32, JSON.stringify(addons));
			assert(JSON.stringify(addons.ids) === JSON.stringify(["example-mod@1.0.0"]), JSON.stringify(addons));

			const described = await describe({ kind: "addon", name: "example-mod" });
			assert(described.status === "succeeded", JSON.stringify(described.details).slice(0, 300));
			const entry = described.details as {
				status: { state: string; contributed: { actions: number; queries: number; refs: string[] } };
				capabilities: string[];
				note: string;
			};
			assert(entry.status.state === "loaded", JSON.stringify(entry.status));
			assert(entry.status.contributed.actions === 1 && entry.status.contributed.queries === 2, JSON.stringify(entry));
			assert(
				JSON.stringify([...entry.capabilities].sort()) ===
					JSON.stringify(["example.machine@1", "example.press@1", "example.recipes@1"]),
				JSON.stringify(entry.capabilities),
			);
			assert(entry.note.includes("uina-example-plugin"), entry.note);
		});

		await step("T4：初始事实未知（不伪造 counter），静态配方与包内知识可读", async () => {
			const machine = await observe({ selector: "example.machine@1", input: {} });
			assert(machine.status === "succeeded", JSON.stringify(machine.details).slice(0, 300));
			const value = machine.details as { value: { counter: number | null }; coverage: string };
			assert(value.value.counter === null, `counter must be unknown before any payload: ${JSON.stringify(value)}`);
			assert(value.coverage === "partial", JSON.stringify(value));

			const recipes = await observe({ selector: "example.recipes@1", input: {} });
			assert(recipes.status === "succeeded", JSON.stringify(recipes.details).slice(0, 300));
			const recipeValue = recipes.details as {
				value: { recipes: { output: { item: string; count: number } }[] };
				unknown: string[];
			};
			assert(recipeValue.value.recipes[0]?.output.item === "example:uina_token", JSON.stringify(recipeValue));
			assert(
				recipeValue.unknown.some((note) => note.includes("not vanilla crafting")),
				JSON.stringify(recipeValue.unknown),
			);

			const item = await observe({ selector: "item@1", input: { name: "example:uina_token" } });
			assert(item.status === "succeeded", JSON.stringify(item.details).slice(0, 300));
			const itemValue = item.details as {
				value: { displayName: string; sources: unknown[]; sourcesComplete: boolean };
			};
			assert(itemValue.value.displayName === "Uina Token", JSON.stringify(itemValue));
			assert(
				itemValue.value.sources.length === 0 && itemValue.value.sourcesComplete === false,
				JSON.stringify(itemValue),
			);
		});

		await step("T5：纵向闭环——press 经自定义通道改服务端状态，回读确认后才返回", async () => {
			const accepted = await run({ selector: "example.press@1", input: { times: 2 } });
			assert(accepted.status === "succeeded", JSON.stringify(accepted.details).slice(0, 300));
			const snapshot = await finish(accepted);
			assert(snapshot.phase === "finished" && snapshot.outcome === "succeeded", JSON.stringify(snapshot));

			const listed = await calls(snapshot.run);
			const summary = listed.find((call) => call.ref === "example.press@1");
			assert(summary != null, `press call missing: ${JSON.stringify(listed.map((call) => call.ref))}`);
			const press = await readCall(summary.record);
			assert(press.execution === "returned", JSON.stringify(press).slice(0, 400));
			const result = press.value as { counter: number; verified: boolean };
			assert(result.verified === true && result.counter >= 2, JSON.stringify(result));

			const machine = await observe({ selector: "example.machine@1", input: {} });
			const value = machine.details as {
				value: { counter: number; item: string | null };
				coverage: string;
			};
			assert(value.coverage === "complete", JSON.stringify(value));
			assert(value.value.counter >= 2, JSON.stringify(value));
			assert(value.value.item === "example:uina_token", JSON.stringify(value));

			// 服务端确实把物品发进了背包（纸片 + PDC 身份）：不是只在 Payload 里报了个名字。
			const inventory = await observe({ selector: "inventory@1", input: {} });
			assert(inventory.status === "succeeded", JSON.stringify(inventory.details).slice(0, 300));
			const counts = (inventory.details as { value: { counts: Record<string, number> } }).value.counts;
			const paper = counts.paper ?? counts["minecraft:paper"] ?? 0;
			assert(paper >= 1, `server-granted item missing from inventory: ${JSON.stringify(counts)}`);
		});

		await step("T6：再次写入仍然生效（不是一次性放行 BodyScope）", async () => {
			const accepted = await run({ selector: "example.press@1", input: { times: 1 } });
			assert(accepted.status === "succeeded", JSON.stringify(accepted.details).slice(0, 300));
			const snapshot = await finish(accepted);
			assert(snapshot.outcome === "succeeded", JSON.stringify(snapshot));
			const machine = await observe({ selector: "example.machine@1", input: {} });
			const value = machine.details as { value: { counter: number } };
			assert(value.value.counter >= 3, JSON.stringify(value));
		});

		await step("T7：连接期间 disable 不卸载已装配能力；重连后包与能力一起消失", async () => {
			await disableAddon({ root, profileId, id: "example-mod" });
			const stillLoaded = await describe({ kind: "addon", name: "example-mod" });
			assert(stillLoaded.status === "succeeded", JSON.stringify(stillLoaded.details).slice(0, 200));

			await session({ op: "disconnect" });
			const reconnected = (await session({ op: "connect", target: { server: "default" } })).details as SessionStatus;
			assert(reconnected.state === "connected", JSON.stringify(reconnected).slice(0, 300));
			assert(
				JSON.stringify(reconnected.active!.addons.ids) === JSON.stringify([]),
				JSON.stringify(reconnected.active!.addons),
			);
			const gone = await describe({ kind: "addon", name: "example-mod" });
			assert(
				gone.status === "failed" && (gone.details as { code?: string }).code === "NOT_FOUND",
				JSON.stringify(gone.details).slice(0, 200),
			);
			const refused = await run({ selector: "example.press@1", input: { times: 1 } });
			assert(
				refused.status === "failed" && (refused.details as { code?: string }).code === "NOT_FOUND",
				JSON.stringify(refused.details).slice(0, 200),
			);
		});

		console.log(`[mc-addons] PASS ${passed}/8`);
	} finally {
		await Promise.resolve(world.onStop!(ctx)).catch(() => {});
		await rm(legacyPath, { force: true });
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

await main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
