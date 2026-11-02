/** Native World entry. Factory is inert; all resources belong to one activation. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BODY_ENDPOINT_EXPOSED_PREFIX } from "../../../../src/extensions/world-framework/seams.js";
import type { ServiceCompanionContext, WorldDef } from "../../../../src/extensions/world-framework/types.js";
import { MinecraftFacade } from "../executor/facade.js";
import { type ExecutorPolicy, MinecraftExecutor } from "../executor/index.js";
import { createBodyEndpoint } from "./body-endpoint.js";
import { actionSchemas, nativeGuide } from "./schema.js";

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
			const config = JSON.parse(
				await readFile(options.configPath ?? fileURLToPath(new URL("../config.json", import.meta.url)), "utf8"),
			);
			if (config.connection?.version !== "1.21.11")
				throw new Error("native Minecraft stage supports explicit version 1.21.11 only");
			const abort = () => {
				void close().catch(() => {});
			};
			ctx.signal.addEventListener("abort", abort, { once: true });
			detachAbort = () => ctx.signal.removeEventListener("abort", abort);
			try {
				starting = MinecraftExecutor.open({
					worldDataDir: ctx.worldDataDir,
					config,
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
