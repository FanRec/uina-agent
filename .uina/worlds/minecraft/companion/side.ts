/** Game-side composition root shared by bootstrap and development scenarios. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describeDirectory, type DescribeParams } from "./directory.js";
import { buildCapabilities } from "../capabilities/index.js";
import type { NativeCallable } from "../contracts/capabilities.js";
import type { CompanionInit, ExecutionSideStatus, RetirementRequest } from "../contracts/executor.js";
import type {
	ControlRetirement,
	DriverExecutionSink,
	OwnerState,
	RunRequest,
	StopCommand,
} from "../contracts/runtime.js";
import type { ExactRef, JsonValue } from "../contracts/values.js";
import { plain } from "../contracts/values.js";
import { PlayerPortImpl } from "../driver/body/player-port.js";
import { ClientHost } from "../driver/client-host.js";
import { DriverControlArbiter } from "../driver/control-arbiter.js";
import { FactsSource } from "../driver/facts/index.js";
import { GotoDirector } from "../driver/goto.js";
import { parseExecutorConfig } from "../executor/config.js";
import type { RpcMethod } from "../executor/protocol.js";
import { RpcError } from "../executor/ipc.js";
import { MinecraftRuntime } from "../runtime/index.js";
import { MinecraftWorld } from "../world/index.js";
import { createProgram } from "../program/index.js";
import type { ProgramPort } from "../contracts/program.js";
import { createLibrary } from "../library/index.js";
import { readCallSource } from "../library/origin.js";
import type { LibraryRequest } from "../contracts/library.js";

export async function openExecutionSide(
	init: CompanionInit,
	options: {
		callables?: NativeCallable<JsonValue, JsonValue>[];
		onRetirement?: (request: RetirementRequest) => void;
		onChanged?: () => void;
		onGameEvent?: (notice: import("../contracts/executor.js").GameNotice) => void;
	} = {},
) {
	const config = parseExecutorConfig(init.config);
	const namespace = randomUUID();
	const binding =
		config.binding == null
			? {
					binding: `unbound:${init.launch}`,
					world: `unbound-world:${init.launch}`,
					worldRevision: `unbound-revision:${init.launch}`,
					state: "unbound" as const,
				}
			: { binding: `binding:${init.origin.worldOwner}`, ...config.binding, state: "bound" as const };
	const host = new ClientHost();
	const arbiter = new DriverControlArbiter();
	const counters = new Map<string, number>();
	const mint = (prefix: string) => {
		const n = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, n);
		return `${prefix}:${namespace}:${n}`;
	};
	const facts = new FactsSource(host, { ...binding, streamNamespace: namespace });
	let runtime: MinecraftRuntime | null = null;
	let program: ProgramPort | null = null;
	let retirement: RetirementRequest | null = null;
	let closing = false;
	let closePromise: Promise<void> | null = null;
	const faults: { code: string; message: string }[] = [];
	const requireRetirement = (notice: ControlRetirement): void => {
		if (retirement) return;
		let detail = notice.detail;
		while (Buffer.byteLength(detail) > 2048) detail = detail.slice(0, -1);
		retirement = { ...notice, detail, launch: init.launch };
		options.onRetirement?.(retirement);
	};
	const getRuntime = (): MinecraftRuntime => {
		if (!runtime) throw new RpcError("EXECUTOR_UNAVAILABLE", "runtime is not initialized");
		return runtime;
	};
	const assertActionAllowed = (): void => {
		if (closing || retirement) throw new RpcError("EXECUTOR_UNAVAILABLE", "execution side is closing/retiring");
		getRuntime().assertActionAllowed();
	};
	const sink: DriverExecutionSink = {
		record: (fact) => {
			if (!runtime) throw new Error("driver effect before runtime initialization");
			return runtime.sink.record(fact);
		},
	};
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
		assertActionAllowed,
		requireRetirement,
	});
	const gotoDirector = new GotoDirector({
		host,
		bot: () => host.bot,
		sink,
		arbiter,
		mintOp: () => mint("op"),
		mintEff: () => mint("eff"),
		assertActionAllowed,
		requireRetirement,
	});
	const importantEvents = facts.subscribe((notice) => {
		if (notice.kind !== "evidence") return;
		for (const record of notice.records) {
			const value = record.fact.value as Record<string, JsonValue>;
			if (
				value &&
				(value.kind === "death" ||
					(value.kind === "connection" && value.state === "disconnected") ||
					(value.kind === "chat" && value.channel === "private" && value.self === false))
			)
				options.onGameEvent?.({ ref: record.ref, observedAt: record.fact.observedAt, payload: value });
		}
	});
	const capabilities = buildCapabilities({ runtime: getRuntime, gotoDirector, knowledge: () => facts.knowledge() });
	capabilities.callables.push(...(options.callables ?? []));
	const world = new MinecraftWorld({
		facts,
		readers: capabilities.readers,
		validators: capabilities.validators,
		queries: capabilities.queries,
		dbPath: join(init.worldDataDir, "world-history.db"),
		binding,
		namespace,
	});
	try {
		const library = createLibrary({
			dataRoot: init.worldDataDir,
			compile: (material) => program!.validate(material),
			readSource: (origin) =>
				readCallSource(origin, {
					readRun: (run) => getRuntime().read(run),
					readRecord: (ref) => getRuntime().readRecord(ref),
					readSnapshot: (request) => program!.readSnapshot(request),
				}),
		});
		program = await createProgram({
			dataRoot: init.worldDataDir,
			loadProgram: (name) => library.loadProgram(name),
			onChanged: () => {
				runtime?.programChanged();
				options.onChanged?.();
			},
			onWorkerFault: (calls, reason) => runtime?.sealProgramCalls(calls, reason),
		});
		const opened = await MinecraftRuntime.open({
			dbPath: join(init.worldDataDir, "runtime.db"),
			storageId: init.storageId,
			namespace,
			worldOwner: init.origin.worldOwner,
			world,
			playerPort,
			callables: capabilities.callables,
			queryRefs: capabilities.queries.map((q) => q.ref),
			program,
			ownerLifetimeMs: init.ownerLifetimeMs,
			onChanged: options.onChanged,
			unclean: init.unclean,
			oldControlRetired: init.oldControlRetired,
			requireRetirement,
		});
		runtime = opened.runtime;
		const start = opened.start;
		let attached = false;
		const attach = async (): Promise<OwnerState> => {
			const owner = await getRuntime().attach(init.origin);
			if (!attached) {
				attached = true;
				for (const gate of init.localGates)
					await getRuntime().setOwnerGate({
						requestId: randomUUID(),
						attachment: owner.attachment,
						gate,
						closed: true,
					});
			}
			return getRuntime().inspectOwner()!;
		};
		// Storage/owner recovery is complete before any client can connect.
		const connected = host
			.connect(config.connection)
			.then(() => {
				if (closing) return;
				if (host.state === "ready" && host.bot?.username !== config.connection.username) {
					faults.push({
						code: "IDENTITY_MISMATCH",
						message: "server login name differs from configured offline username",
					});
					requireRetirement({
						source: "driver",
						subject: null,
						code: "CONTROL_ISOLATION_FAILED",
						detail: "offline login name mismatch",
					});
				}
			})
			.catch((error: unknown) => {
				faults.push({ code: "CONNECTION_FAILED", message: error instanceof Error ? error.message : String(error) });
			});
		const inspect = (): ExecutionSideStatus => ({
			launch: init.launch,
			storageId: init.storageId,
			observedAt: new Date().toISOString(),
			authMode: "offline",
			owner: getRuntime().inspectOwner(),
			connection: host.state,
			world: world.availability(),
			runtime: getRuntime().availability(),
			safety: { active: null, last: null },
			program: program!.capacity(),
			faults: [
				...faults,
				{ code: "SAFETY_NOT_IMPLEMENTED", message: "default self-preservation is not delivered in batch 4" },
			],
			retirement,
		});
		const close = (): Promise<void> =>
			(closePromise ??= (async () => {
				closing = true;
				importantEvents.close();
				const errors: unknown[] = [];
				const owner = getRuntime().inspectOwner();
				if (owner) {
					try {
						const receipt = await getRuntime().setOwnerGate({
							requestId: randomUUID(),
							attachment: owner.attachment,
							gate: "disabled",
							closed: true,
						});
						if (receipt.persistence !== "confirmed")
							errors.push(new Error(`disabled gate: ${receipt.persistence}/${receipt.control}`));
					} catch (error) {
						errors.push(error);
					}
				}
				// Gate receipt may still say stopping. Runtime.close waits for the actual control barrier.
				for (const shutdown of [
					() => getRuntime().close(),
					() => program!.close(),
					() => host.close(),
					() => world.close(),
				]) {
					try {
						await shutdown();
					} catch (error) {
						errors.push(error);
					}
				}
				if (retirement || errors.length) throw new AggregateError(errors, "execution side did not close cleanly");
			})());
		const dispatch = async (method: RpcMethod, payload: JsonValue, signal: AbortSignal): Promise<JsonValue> => {
			if (closing && method !== "shutdown") throw new RpcError("EXECUTOR_UNAVAILABLE", "execution side is closing");
			const p = payload as Record<string, JsonValue>;
			let value: unknown;
			switch (method) {
				case "status":
					value = inspect();
					break;
				case "shutdown":
					await close();
					return null;
				case "runtime.attach":
					value = await attach();
					break;
				case "runtime.heartbeat":
					value = await getRuntime().heartbeat(p.attachment as string);
					break;
				case "runtime.setOwnerGate":
					value = await getRuntime().setOwnerGate(
						payload as unknown as Parameters<MinecraftRuntime["setOwnerGate"]>[0],
					);
					break;
				case "runtime.submit":
					assertActionAllowed();
					value = await getRuntime().submit(init.origin, payload as unknown as RunRequest);
					break;
				case "runtime.lookup":
					value = getRuntime().lookup(p.requestId as string);
					break;
				case "runtime.read":
					value = await getRuntime().read(p.run as string);
					break;
				case "runtime.readRecord":
					value = await getRuntime().readRecord(p.ref as string, {
						format: p.format as import("../contracts/runtime.js").RecordFormat | undefined,
					});
					break;
				case "runtime.wait":
					value = await getRuntime().wait(
						p.run as string,
						{
							...(p.afterRevision === undefined ? {} : { afterRevision: p.afterRevision as number }),
							...(p.timeoutMs === undefined ? {} : { timeoutMs: p.timeoutMs as number }),
						},
						signal,
					);
					break;
				case "runtime.stop":
					value = await getRuntime().stop(payload as unknown as StopCommand);
					break;
				case "describe":
					value = await describeDirectory(capabilities, library, p as DescribeParams);
					break;
				case "library": {
					const request = payload as unknown as LibraryRequest;
					switch (request.op) {
						case "list":
							value = await library.list(request);
							break;
						case "get":
							value = await library.get(request.kind ?? "program", request.name);
							if (value === null) throw new RpcError("NOT_FOUND", "library entry not found");
							break;
						case "save":
							value = await library.save(request);
							break;
						case "update":
							value = await library.update(request);
							break;
						case "delete":
							await library.delete(request.kind ?? "program", request.name);
							value = null;
							break;
					}
					break;
				}
				case "runtime.list":
					value = await getRuntime().list(p as Parameters<MinecraftRuntime["list"]>[0]);
					break;
				case "runtime.calls":
					value = await getRuntime().listCalls(p.run as string, p as Parameters<MinecraftRuntime["listCalls"]>[1]);
					break;
				case "runtime.pendingDeliveries":
					value = await getRuntime().pendingDeliveries(p as Parameters<MinecraftRuntime["pendingDeliveries"]>[0]);
					break;
				case "runtime.readDelivery":
					value = await getRuntime().readDelivery(p.ref as string);
					break;
				case "runtime.settleDelivery":
					value = await getRuntime().settleDelivery(
						p.ref as string,
						p.receipt as unknown as import("../contracts/runtime.js").DeliveryReceipt,
					);
					break;

				case "observe":
					value = await world.read({ ref: p.selector as ExactRef, input: p.input ?? {} });
					break;
				default:
					throw new RpcError("PROTOCOL_ERROR", `${method} is not available after initialization`);
			}
			return plain(value);
		};
		return {
			host,
			facts,
			world,
			runtime: getRuntime(),
			capabilities,
			namespace,
			binding,
			start,
			connected,
			attach,
			inspect,
			dispatch,
			close,
		};
	} catch (error) {
		importantEvents.close();
		await Promise.allSettled([
			host.close(),
			world.close(),
			...(runtime ? [runtime.close()] : []),
			...(program ? [program.close()] : []),
		]);
		throw error;
	}
}

export type ExecutionSide = Awaited<ReturnType<typeof openExecutionSide>>;
