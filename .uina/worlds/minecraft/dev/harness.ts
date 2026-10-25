/**
 * 开发入口共用装配：连接 dev 服并把 Driver/World/Runtime/能力面接起来。
 *
 * 唯一定义来源：docs/proposals/mc/development-plan.md §9、development-guide.md §5。
 * 场景文件（entry.ts 的 I1、k1.ts 的 K1）只写步骤与断言，不复制装配：
 * 两处装配一旦漂移，真服验证就会证明错的东西。
 * 端口互注入解循环：Runtime 消费 Driver/World 端口，Driver 消费 runtime.sink
 * （open 前用占位 sink，open 后接线；open 前无任何副作用）。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuiltCapabilities } from "../capabilities/index.js";
import type { NativeCallable } from "../contracts/capabilities.js";
import type { JsonValue } from "../contracts/values.js";
import { buildCapabilities } from "../capabilities/index.js";
import type { DriverExecutionSink } from "../contracts/runtime.js";
import type { Ref, Vec3 } from "../contracts/values.js";
import { PlayerPortImpl } from "../driver/body/player-port.js";
import { ClientHost } from "../driver/client-host.js";
import { DriverControlArbiter } from "../driver/control-arbiter.js";
import { FactsSource } from "../driver/facts/index.js";
import { GotoDirector } from "../driver/goto.js";
import type { MineflayerBot } from "../driver/mineflayer/adapter.js";
import { MinecraftRuntime } from "../runtime/index.js";
import { MinecraftWorld } from "../world/index.js";

export const DEV_SERVER = {
	host: "127.0.0.1",
	port: 25565,
	username: process.env.MC_DEV_USER ?? "UinaDev",
	version: "1.21.11",
};
const STORAGE_ID = "minecraft-runtime@1";

/** 每前缀独立单调发号；必须带启动命名空间（world.md §5.3）。 */
function makeIssuer(namespace: string): (prefix: string) => Ref {
	const counters = new Map<string, number>();
	return (prefix: string): Ref => {
		const next = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, next);
		return `${prefix}:${namespace}:${next}`;
	};
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function dist(a: Vec3, b: Vec3): number {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function fmtPos(p: Vec3): string {
	return `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`;
}

type BotEntityView = { entity?: { position?: { x: number; y: number; z: number }; onGround?: boolean } | null };

/**
 * 出生落定等待（验证侧准备）：服务端会把玩家放回上次位置，可能有坠落/惯性；
 * 位置静止且落地后再计算目标，避免寻路起点不稳。
 */
export async function waitForStill(bot: BotEntityView, log: (message: string) => void): Promise<void> {
	const deadline = Date.now() + 8000;
	let stable = 0;
	let last: Vec3 | null = null;
	while (Date.now() < deadline) {
		const pos = bot.entity?.position ?? null;
		if (pos != null && bot.entity?.onGround === true && last != null && dist(pos, last) < 0.01) {
			stable++;
			if (stable >= 3) return;
		} else {
			stable = 0;
		}
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
	host: ClientHost;
	facts: FactsSource;
	world: MinecraftWorld;
	runtime: MinecraftRuntime;
	capabilities: BuiltCapabilities;
	bot: MineflayerBot;
	log: (message: string) => void;
}

export async function openHarness(
	label: string,
	options: {
		binding?: { world: Ref; worldRevision: Ref };
		callables?: NativeCallable<JsonValue, JsonValue>[];
	} = {},
): Promise<DevHarness> {
	const log = (message: string): void => console.log(`[mc-${label}] ${message}`);
	const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
	const worldDataDir = join(repoRoot, ".uina", "world-data", "minecraft");
	mkdirSync(worldDataDir, { recursive: true });

	// per-boot 命名空间：禁冒号；绑定身份每次启动显式生成（不猜旧身份）
	const ns = `${label}-${Date.now().toString(36)}`;
	const worldRef = options.binding?.world ?? `wld:${ns}`;
	const binding = `bind:${ns}`;
	const worldRevision = options.binding?.worldRevision ?? `wldrev:${ns}`;
	const worldOwner: Ref = `owner:${ns}`;
	const activation: Ref = `act:${ns}`;

	const host = new ClientHost();
	const arbiter = new DriverControlArbiter();
	const mint = makeIssuer(ns);
	const facts = new FactsSource(host, { binding, world: worldRef, worldRevision, streamNamespace: ns });
	const sinkRef: { current: DriverExecutionSink | null } = { current: null };
	const sink: DriverExecutionSink = { record: (fact) => sinkRef.current?.record(fact) ?? null };
	const playerPort = new PlayerPortImpl({
		host,
		bot: () => host.bot,
		sink,
		sampleSelf: () => facts.sampleSelf(),
		arbiter,
		mintBody: () => mint("body"),
		mintOp: () => mint("op"),
		mintEff: () => mint("eff"),
		publishWindow: (observation) => facts.publishWindow(observation),
	});
	const gotoDirector = new GotoDirector({
		host,
		bot: () => host.bot,
		sink,
		arbiter,
		mintOp: () => mint("op"),
		mintEff: () => mint("eff"),
	});

	// runtime 用 getter：open 是两段式，受理只会发生在 open 之后。
	let runtime: MinecraftRuntime | null = null;
	const capabilities = buildCapabilities({
		runtime: () => {
			if (runtime == null) throw new Error("runtime is not open yet");
			return runtime;
		},
		gotoDirector,
		knowledge: () => facts.knowledge(),
	});
	capabilities.callables.push(...(options.callables ?? []));

	const world = new MinecraftWorld({
		facts,
		readers: capabilities.readers,
		dbPath: join(worldDataDir, "world-history.db"),
		binding: { binding, world: worldRef, worldRevision },
		namespace: ns,
	});

	log(`connecting ${DEV_SERVER.host}:${DEV_SERVER.port} as ${DEV_SERVER.username} (${DEV_SERVER.version})`);
	await host.connect(DEV_SERVER);
	if (host.state !== "ready" || host.identity == null) throw new Error(`client not ready: ${host.state}`);
	const bot = host.bot;
	if (bot == null) throw new Error("client host lost the bot after ready");
	log(
		`ready: connection=${host.identity.connection} incarnation=${host.identity.incarnation} ` +
			`dimension=${host.dimension ?? "unknown"} position=${host.position ? fmtPos(host.position) : "unknown"}`,
	);
	await waitForStill(bot as unknown as BotEntityView, log);

	// 协议号不在 Bot 类型上；从注册表版本元数据读取，读不到则如实缺省 environment
	const protocol = (bot as unknown as { registry?: { version?: { version?: number } } }).registry?.version?.version;
	const opened = await MinecraftRuntime.open({
		dbPath: join(worldDataDir, "runtime.db"),
		storageId: STORAGE_ID,
		namespace: ns,
		worldOwner,
		world,
		playerPort,
		callables: capabilities.callables,
		...(typeof protocol === "number" ? { environment: { serverVersion: bot.version, protocol } } : {}),
	});
	runtime = opened.runtime;
	sinkRef.current = runtime.sink;
	log(
		`runtime open: journal=${opened.start.journalMode} sync=${opened.start.synchronousMode} ` +
			`recovered=${JSON.stringify(opened.start.recoveredCounts)}`,
	);
	log(`history: ${await world.historyReady}`);

	return {
		label,
		ns,
		worldOwner,
		activation,
		host,
		facts,
		world,
		runtime: runtime as MinecraftRuntime,
		capabilities,
		bot,
		log,
	};
}

export async function closeHarness(h: DevHarness): Promise<void> {
	try {
		await h.runtime.close();
	} catch {
		// 收尾失败不影响错误上报
	}
	try {
		await h.world.close();
	} catch {
		// 同上
	}
	try {
		await h.host.close();
	} catch {
		// 同上
	}
}
