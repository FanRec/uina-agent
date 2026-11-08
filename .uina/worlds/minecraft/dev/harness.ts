/** Development scenarios share the production execution-side composition. */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callableModule } from "../addons/contribute.js";
import type { BuiltCapabilities } from "../capabilities/index.js";
import { openExecutionSide } from "../companion/side.js";
import type { NativeCallable } from "../contracts/capabilities.js";
import type { JsonValue, Ref, Vec3 } from "../contracts/values.js";
import type { ClientHost } from "../driver/client-host.js";
import type { FactsSource } from "../driver/facts/index.js";
import type { MineflayerBot } from "../driver/mineflayer/adapter.js";
import type { MinecraftRuntime } from "../runtime/index.js";
import type { MinecraftWorld } from "../world/index.js";

export const DEV_SERVER = {
	host: "127.0.0.1",
	port: 25565,
	username: process.env.MC_DEV_USER ?? "UinaDev",
	version: "1.21.11",
};
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
export function dist(a: Vec3, b: Vec3): number {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
export function fmtPos(p: Vec3): string {
	return `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`;
}
type BotEntityView = { entity?: { position?: Vec3; onGround?: boolean } | null };
export async function waitForStill(bot: BotEntityView, log: (message: string) => void): Promise<void> {
	const deadline = Date.now() + 8000;
	let stable = 0;
	let last: Vec3 | null = null;
	while (Date.now() < deadline) {
		const pos = bot.entity?.position ?? null;
		if (pos != null && bot.entity?.onGround === true && last != null && dist(pos, last) < 0.01) {
			if (++stable >= 3) return;
		} else stable = 0;
		last = pos;
		await sleep(150);
	}
	log("warn: spawn stillness wait timed out; proceeding from last sampled position");
}
export interface DevHarness {
	label: string;
	ns: string;
	worldOwner: Ref;
	activation: Ref;
	dataRoot: string;
	host: ClientHost;
	facts: FactsSource;
	world: MinecraftWorld;
	runtime: MinecraftRuntime;
	capabilities: BuiltCapabilities;
	bot: MineflayerBot;
	log: (message: string) => void;
	/** 请求前状态帧（正式链路 = 宿主经 executor.rpc("state.snapshot")，这里直接走同进程 dispatch）。 */
	snapshot(): Promise<{ text: string; sampledAt: string; connected: boolean; unknown: string[] }>;
	close(): Promise<void>;
}
export async function openHarness(
	label: string,
	options: {
		binding?: { world: Ref; worldRevision: Ref };
		callables?: NativeCallable<JsonValue, JsonValue>[];
		dataRoot?: string;
		/** 重开同一数据根时复用上次的 ns：runtime.db 的 world_owner 与历史库身份都绑定它。 */
		ns?: string;
		/** 游戏侧事件（safety_changed / 死亡 / G6 digest 等）收集口，透传给 openExecutionSide。 */
		onGameEvent?: (notice: import("../contracts/executor.js").GameNotice) => void;
	} = {},
): Promise<DevHarness> {
	const log = (message: string): void => console.log(`[mc-${label}] ${message}`);
	const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
	const dataRoot = resolve(
		options.dataRoot ?? process.env.MC_DEV_DATA_DIR ?? join(repoRoot, ".uina", "world-data", "minecraft"),
	);
	await mkdir(dataRoot, { recursive: true });
	const ns = options.ns ?? `${label}-${randomUUID()}`;
	const worldOwner = `owner:${ns}`;
	const activation = `activation:${ns}`;
	const side = await openExecutionSide(
		{
			launch: `launch:${ns}`,
			origin: { worldOwner, activation },
			storageId: `storage:${ns}`,
			sessionDataDir: dataRoot,
			sharedDataDir: dataRoot,
			config: {
				connection: { ...DEV_SERVER, authMode: "offline" },
				binding: options.binding ?? { world: `world:${ns}`, worldRevision: `revision:${ns}` },
			},
			unclean: false,
			oldControlRetired: true,
			ownerLifetimeMs: 5000,
			localGates: [],
		},
		{
			// 开发探针仍进同一次 Catalog 装配（不是旁路注册表）。
			modules: options.callables?.length ? [callableModule(label, options.callables)] : undefined,
			onGameEvent: options.onGameEvent,
		},
	);
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	try {
		const owner = await side.attach();
		await side.runtime.setOwnerGate({
			requestId: randomUUID(),
			attachment: owner.attachment,
			gate: "disabled",
			closed: false,
			expectedRevision: owner.gateRevision,
		});
		heartbeat = setInterval(() => {
			void side.runtime.heartbeat(owner.attachment).catch((error: unknown) => log(`heartbeat: ${String(error)}`));
		}, 1000);
		await side.connected;
		if (side.host.state !== "ready" || !side.host.bot) throw new Error(`client not ready: ${side.host.state}`);
		await waitForStill(side.host.bot as unknown as BotEntityView, log);
		log(
			`data root: ${dataRoot}; runtime: ${side.start.journalMode}/${side.start.synchronousMode}; history: ${await side.world.historyReady}`,
		);
		return {
			label,
			ns,
			worldOwner,
			activation,
			dataRoot,
			host: side.host,
			facts: side.facts,
			world: side.world,
			runtime: side.runtime,
			capabilities: side.capabilities,
			bot: side.host.bot,
			log,
			snapshot: () =>
				side.dispatch("state.snapshot", {}, AbortSignal.timeout(5000)) as Promise<{
					text: string;
					sampledAt: string;
					connected: boolean;
					unknown: string[];
				}>,
			close: async () => {
				if (heartbeat) clearInterval(heartbeat);
				await side.close();
			},
		};
	} catch (error) {
		if (heartbeat) clearInterval(heartbeat);
		await side.close().catch(() => {});
		throw error;
	}
}
export async function closeHarness(h: DevHarness): Promise<void> {
	await h.close();
}
