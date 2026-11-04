/** Native World entry. Factory is inert; all resources belong to one activation. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BODY_ENDPOINT_EXPOSED_PREFIX } from "../../../../src/extensions/world-framework/seams.js";
import type { ServiceCompanionContext, WorldDef } from "../../../../src/extensions/world-framework/types.js";
import { MinecraftFacade } from "../executor/facade.js";
import { type ExecutorPolicy, MinecraftExecutor } from "../executor/index.js";
import { createBodyEndpoint } from "./body-endpoint.js";
import { actionSchemas, nativeGuide } from "./schema.js";
import {
	ensureIdentityFile,
	identityFromLegacyConfig,
	migrateLegacyRoot,
	MC_PROTOCOL_VERSION,
	profileDir,
	profileId,
} from "./session-identity.js";

export function createMinecraftWorld(
	options: {
		configPath?: string;
		executorPolicy?: Partial<ExecutorPolicy>;
		deliveryPolicy?: { shortWindowMs?: number; pollMs?: number };
	} = {},
): WorldDef {
	let executor: MinecraftExecutor | null = null,
		facade: MinecraftFacade | null = null;
	let closing: Promise<void> | null = null;
	let starting: Promise<MinecraftExecutor> | null = null;
	let detachBody: (() => void) | null = null,
		detachAbort: (() => void) | null = null;
	const close = (): Promise<void> =>
		(closing ??= (async () => {
			const errors: unknown[] = [];
			const results = await Promise.allSettled([
				facade?.close(),
				(async () => {
					const active = executor ?? (await starting?.catch(() => null));
					await active?.close();
				})(),
			]);
			for (const result of results) if (result.status === "rejected") errors.push(result.reason);
			detachBody?.();
			detachAbort?.();
			facade = null;
			executor = null;
			if (errors.length) throw new AggregateError(errors, "Minecraft activation close failed");
		})());
	return {
		name: "minecraft",
		description: nativeGuide,
		executionMode: "parallel",
		defaultState: { enabled: false },
		actions: Object.fromEntries(
			Object.entries(actionSchemas).map(([name, parameters]) => [
				name,
				{
					description:
						name === "run"
							? "Run an exact capability, named program or JavaScript code; accepted may continue in background"
							: name,
					parameters,
					run: async (params, ctx) =>
						facade
							? await facade.execute(name, params, ctx.signal)
							: { status: "not_started" as const, result: "Minecraft is not enabled" },
				},
			]),
		),
		async onStart(ctx: ServiceCompanionContext) {
			if (executor) throw new Error("Minecraft activation already running");
			if (
				!ctx.worldDataDir ||
				!ctx.emitEvent ||
				!ctx.onHostEvent ||
				!ctx.expose ||
				ctx.delivery?.durability !== "durable"
			)
				throw new Error("Minecraft requires worldDataDir, emitEvent, onHostEvent, expose and durable Host delivery");
			closing = null;
			if (ctx.signal.aborted) throw new Error("Minecraft activation already cancelled");
			const configPath = options.configPath ?? fileURLToPath(new URL("../config.json", import.meta.url));
			const legacyConfig = existsSync(configPath) ? (JSON.parse(await readFile(configPath, "utf8")) as unknown) : null;
			if (
				legacyConfig != null &&
				(legacyConfig as { connection?: { version?: string } }).connection?.version !== MC_PROTOCOL_VERSION
			)
				throw new Error(`native Minecraft stage supports explicit version ${MC_PROTOCOL_VERSION} only`);
			// M1 数据根：稳定根共享（history/library），executor/runtime/runs/exports 归 Profile。
			// 旧布局一次性迁入 legacy Profile；身份不可确认则保持不动。
			const migration = await migrateLegacyRoot(ctx.worldDataDir, legacyConfig);
			if (migration.reason) console.warn(`[mc-world] legacy migration skipped: ${migration.reason}`);
			const identity = identityFromLegacyConfig(legacyConfig);
			if (!identity) throw new Error("Minecraft requires config.json connection identity or a session connect");
			const sessionDataDir = profileDir(ctx.worldDataDir, profileId(identity));
			await ensureIdentityFile(sessionDataDir, identity);
			const abort = () => {
				void close().catch(() => {});
			};
			ctx.signal.addEventListener("abort", abort, { once: true });
			detachAbort = () => ctx.signal.removeEventListener("abort", abort);
			try {
				starting = MinecraftExecutor.open({
					ownershipDir: ctx.worldDataDir,
					sessionDataDir,
					sharedDataDir: ctx.worldDataDir,
					config: {
						connection: {
							host: identity.endpoint.host,
							port: identity.endpoint.port,
							username: identity.principal.username,
							authMode: "offline" as const,
							version: MC_PROTOCOL_VERSION,
						},
						binding:
							identity.world === "unbound" ? null : { world: identity.world, worldRevision: identity.worldRevision },
					},
					signal: ctx.signal,
					policy: options.executorPolicy,
				});
				executor = await starting;
				if (ctx.signal.aborted) {
					await close();
					throw new Error("Minecraft activation cancelled during start");
				}
				facade = new MinecraftFacade(executor, ctx, options.deliveryPolicy);
				const body = createBodyEndpoint(executor);
				detachBody = ctx.expose(BODY_ENDPOINT_EXPOSED_PREFIX + body.bodyId, body);
				facade.start();
			} catch (error) {
				await close();
				throw error;
			}
		},
		onStop: close,
	};
}

export default function minecraftWorld(): WorldDef {
	return createMinecraftWorld();
}
