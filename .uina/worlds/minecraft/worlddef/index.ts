/** Native World entry. Factory is inert; all resources belong to one activation. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { builtinCatalog } from "../capabilities/index.js";
import { describeDirectory } from "../companion/directory.js";
import type { LibraryKind, ProgramOrigin } from "../contracts/library.js";
import type { ExecutorPolicy } from "../executor/index.js";
import { RpcError } from "../executor/ipc.js";
import { createLibrary, type FileLibrary } from "../library/index.js";
import { readCallSource } from "../library/origin.js";
import { readRunSnapshot } from "../program/index.js";
import { createProgramValidator, type ProgramValidator } from "../program/validator.js";
import type { WorldDef } from "../../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import { SessionController, sessionNotConnected, sessionResponse } from "./session-controller.js";
import { actionSchemas, nativeGuide } from "./schema.js";
import { MC_PROTOCOL_VERSION } from "./session-identity.js";

export function createMinecraftWorld(
	options: {
		executorPolicy?: Partial<ExecutorPolicy>;
		deliveryPolicy?: { shortWindowMs?: number; pollMs?: number };
		/** 旧 config.json 路径（迁移与 settings 种子输入）；默认世界包内 config.json。 */
		legacyConfigPath?: string;
	} = {},
): WorldDef {
	let controller: SessionController | null = null;
	let library: FileLibrary | null = null;
	let validator: ProgramValidator | null = null;
	let closing: Promise<void> | null = null;
	let detachAbort: (() => void) | null = null;

	const close = (): Promise<void> =>
		(closing ??= (async () => {
			const errors: unknown[] = [];
			try {
				await controller?.close();
			} catch (error) {
				errors.push(error);
			}
			controller = null;
			await validator?.close().catch(() => {});
			validator = null;
			library = null;
			detachAbort?.();
			detachAbort = null;
			if (errors.length) throw new AggregateError(errors, "Minecraft activation close failed");
		})());

	const invalidInput = (message: string): RpcError => new RpcError("INVALID_INPUT", message);
	const ok = (value: unknown): ToolExecutionResult => sessionResponse(value);

	/** save.from 的来源核验：活动会话走 Runtime RPC + Profile 根的固定快照；离线明确失败。 */
	const readSource = async (origin: ProgramOrigin) => {
		const session = controller?.session;
		if (!session) throw new RpcError("NOT_CONNECTED", "saving from a run requires the active session");
		return await readCallSource(origin, {
			readRun: (run) => session.executor.read(run),
			readRecord: (ref) => session.executor.readRecord(ref),
			readSnapshot: ({ run, digest }) => readRunSnapshot(session.sessionDataDir, run, digest),
		});
	};

	const libraryAction = async (params: Record<string, unknown>): Promise<ToolExecutionResult> => {
		const lib = library;
		if (!lib) return sessionNotConnected("library");
		const kind = (params.kind as LibraryKind | undefined) ?? "program";
		switch (params.op) {
			case "list":
				return ok(await lib.list(params as never));
			case "get": {
				const detail = await lib.get(kind, params.name as string);
				if (!detail) throw new RpcError("NOT_FOUND", "library entry not found");
				return ok(detail);
			}
			case "save":
				return ok(await lib.save(params as never));
			case "update":
				return ok(await lib.update(params as never));
			case "delete":
				await lib.delete(kind, params.name as string);
				return ok(null);
			default:
				throw invalidInput(`unknown library op ${String(params.op)}`);
		}
	};

	const route = async (
		name: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<ToolExecutionResult> => {
		switch (name) {
			case "session": {
				switch (params.op) {
					case "status":
						return ok(controller?.status() ?? { state: "disconnected", active: null });
					case "list":
						return ok(controller ? await controller.list() : []);
					case "connect": {
						if (!controller) return sessionNotConnected("session");
						const target = params.target;
						if (target == null || typeof target !== "object" || Array.isArray(target))
							throw invalidInput("session connect requires a target object");
						return ok(await controller.connect(target as never, signal));
					}
					case "disconnect": {
						if (!controller) return sessionNotConnected("session");
						return ok(await controller.disconnect(signal));
					}
					default:
						throw invalidInput(`unknown session op ${String(params.op)}`);
				}
			}
			case "describe":
				return ok(await describeDirectory(builtinCatalog, library!, params as never));
			case "library":
				return await libraryAction(params);
			default:
				// observe/run/chat/runs 只作用于当前会话；无连接或切换中 NOT_CONNECTED。
				return controller ? await controller.execute(name, params, signal) : sessionNotConnected(name);
		}
	};

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
					run: async (params: Record<string, unknown>, ctx: { signal: AbortSignal }) => {
						try {
							return await route(name, params, ctx.signal);
						} catch (error) {
							const e = error as { code?: string; message?: string };
							return sessionResponse(
								{ code: e.code ?? "INTERNAL", message: e.message ?? String(error) },
								e.code === "REQUEST_CANCELLED" ? "cancelled" : "failed",
							);
						}
					},
				},
			]),
		),
		async onStart(ctx) {
			if (controller) throw new Error("Minecraft activation already running");
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
			// 常驻层：静态 Catalog describe、共享 Library 与 SessionController；不读取固定连接、不打开 Bot。
			validator = createProgramValidator();
			library = createLibrary({
				dataRoot: ctx.worldDataDir,
				compile: (material) => {
					if (!validator) throw new Error("program validator is closed");
					return validator.validate(material);
				},
				readSource,
			});
			const legacyConfigPath = options.legacyConfigPath ?? fileURLToPath(new URL("../config.json", import.meta.url));
			const rawLegacy = existsSync(legacyConfigPath)
				? (JSON.parse(await readFile(legacyConfigPath, "utf8")) as unknown)
				: null;
			// 仅 1.21.11 合同产生的旧数据才参与迁移/种子；其余视同无 legacy 输入。
			const legacyConfig =
				rawLegacy != null &&
				(rawLegacy as { connection?: { version?: string } }).connection?.version === MC_PROTOCOL_VERSION
					? rawLegacy
					: null;
			const abort = () => {
				void close().catch(() => {});
			};
			ctx.signal.addEventListener("abort", abort, { once: true });
			detachAbort = () => ctx.signal.removeEventListener("abort", abort);
			try {
				controller = await SessionController.create({
					minecraftRoot: ctx.worldDataDir,
					ctx,
					expose: ctx.expose,
					executorPolicy: options.executorPolicy,
					deliveryPolicy: options.deliveryPolicy,
					legacyConfig,
				});
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
