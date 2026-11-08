/** Game-side composition root shared by bootstrap and development scenarios. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { builtinCatalog } from "../capabilities/index.js";
import { prepareFeedback } from "../capabilities/shared/feedback.js";
import { buildVerifiers } from "../capabilities/shared/verify.js";
import { startSurvival } from "../capabilities/survival.js";
import { createConstruction } from "../construction/index.js";
import type { NativeCallable } from "../contracts/capabilities.js";
import type {
	CompanionInit,
	ConnectionWaitResult,
	ExecutionSideStatus,
	RetirementRequest,
} from "../contracts/executor.js";
import type { ProgramPort } from "../contracts/program.js";
import type {
	ControlRetirement,
	DriverExecutionSink,
	OwnerState,
	RunRequest,
	RunSummary,
	StopCommand,
} from "../contracts/runtime.js";
import type { ExactRef, JsonValue } from "../contracts/values.js";
import { plain } from "../contracts/values.js";
import { PlayerPortImpl } from "../driver/body/player-port.js";
import { ClientHost } from "../driver/client-host.js";
import { DriverControlArbiter } from "../driver/control-arbiter.js";
import { FactsSource } from "../driver/facts/index.js";
import { GotoDirector } from "../driver/goto.js";
import { canBreathe, planEscape } from "../driver/mineflayer/pathfinder.js";
import { createSurfaceProbe } from "../driver/mineflayer/world-scan.js";
import { parseExecutorConfig } from "../executor/config.js";
import { RpcError } from "../executor/ipc.js";
import type { RpcMethod } from "../executor/protocol.js";
import { createLibrary } from "../library/index.js";
import { readCallSource } from "../library/origin.js";
import { createProgram } from "../program/index.js";
import { MinecraftRuntime } from "../runtime/index.js";
import { MinecraftWorld } from "../world/index.js";
import { pruneExportedImages, readExportedImage } from "../world/map.js";
import { formatActiveRuns } from "../world/run-digest.js";
import { sampleStateFrame } from "../world/state-frame.js";
import { safetyNeedsAttention } from "./safety-route.js";

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
	if (binding.state === "unbound")
		console.warn(
			'[mc-world] config.binding is null: places/records are partitioned per launch and will NOT be readable after restart; set "binding": {"world": "...", "worldRevision": "..."} in config.json for a persistent world identity',
		);
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
	/** 状态面诊断有界：重试类故障可能反复发生，不设上限会无界增长。 */
	const pushFault = (fault: { code: string; message: string }): void => {
		faults.push(fault);
		if (faults.length > 32) faults.splice(0, faults.length - 32);
	};
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
		prepareFeedback: (sensors) => prepareFeedback(capabilities, facts)(sensors),
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
	const capabilities = builtinCatalog.bind({
		runtime: getRuntime,
		gotoDirector,
		knowledge: () => facts.knowledge(),
		surface: () => (host.bot ? createSurfaceProbe(host.bot) : null),
	});
	capabilities.callables.push(...(options.callables ?? []));
	// 状态帧（批37）：只读采样 + 文本投影，复用现有查询读取器（与 observe 同口径）。
	// 不再有定时推送：状态由宿主在每次模型请求前经 `state.snapshot` 取一份当前快照。
	const currentReader = (ref: ExactRef) => {
		const reader = capabilities.readers.get(ref);
		if (reader?.kind !== "current") throw new Error(`state frame requires a current reader for ${ref}`);
		return reader;
	};
	const stateReaders = {
		self: currentReader("self@1"),
		inventory: currentReader("inventory@1"),
		world: currentReader("world@1"),
	};
	// Library 先于 World 建：build.plan@1 的窄端口既要读库里的蓝图字节，又要经 region@1
	// 读现场，两者在装配期互为依赖。`world: () => world` 是惰性取值（与
	// CapabilityDeps.runtime 同一手法），调用只发生在首次 read 之后。
	// v3：伴生侧只读共享 library/（写入口收敛到宿主常驻 Library）；compile 仍给 describe 校验用。
	const library = createLibrary({
		dataRoot: init.sharedDataDir,
		compile: (material) => program!.validate(material),
		readSource: (origin) =>
			readCallSource(origin, {
				readRun: (run) => getRuntime().read(run),
				readRecord: (ref) => getRuntime().readRecord(ref),
				readSnapshot: (request) => program!.readSnapshot(request),
			}),
	});
	// map@1 的 PNG 缓存目录：查询产出与 read_image 读取共用这一份派生（world.md §8.6）。
	const imageDir = join(init.sessionDataDir, "exports", "images");
	// 启动即清上一会话的派生图片（fire-and-forget）：本会话 ref 尚未产出，磁盘占用有界。
	void pruneExportedImages(imageDir).catch(() => {});
	let world: MinecraftWorld;
	const construction = createConstruction({ blueprints: library, world: () => world });
	world = new MinecraftWorld({
		facts,
		readers: capabilities.readers,
		validators: capabilities.validators,
		queries: capabilities.queries,
		dbPath: join(init.sharedDataDir, "world-history.db"),
		binding,
		namespace,
		imageDir,
		// route.plan@1 的窄计划端口：组合根用 Driver 受控寻路实现，World 不依赖 Driver。
		routePlanner: { plan: (query) => gotoDirector.plan(query.input as Parameters<GotoDirector["plan"]>[0]) },
		// build.plan@1 的窄计划端口：组合根用 Construction 装配，World 不依赖 Construction。
		buildPlanner: construction,
	});
	try {
		program = await createProgram({
			dataRoot: init.sessionDataDir,
			loadProgram: (name) => library.loadProgram(name),
			onChanged: () => {
				runtime?.programChanged();
				options.onChanged?.();
			},
			onWorkerFault: (calls, reason) => runtime?.sealProgramCalls(calls, reason),
		});
		const opened = await MinecraftRuntime.open({
			evidence: world,
			onSafetyChanged: (record, cause) => {
				options.onChanged?.();
				// 未结算的干预还没有"发生了什么"，等终态那条再说。
				if (record.ended == null) return;
				if (!safetyNeedsAttention(record.ended, cause)) return;
				options.onGameEvent?.({
					ref: record.record,
					observedAt: record.finishedAt,
					payload: plain({
						kind: "safety_changed",
						intervention: record.intervention,
						record: record.record,
						ended: record.ended,
						outcome: record.outcome,
						interruptedRun: record.interruptedRun,
					}),
				});
			},
			verifiers: buildVerifiers(),
			dbPath: join(init.sessionDataDir, "runtime.db"),
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
		const detachControl = host.on((notice) => {
			if (
				notice.kind === "incarnation_invalidated" ||
				notice.kind === "incarnation_changed" ||
				notice.kind === "disconnected"
			)
				void getRuntime()
					.invalidateControl()
					.catch((error) =>
						requireRetirement({
							source: "runtime",
							subject: null,
							code: "CONTROL_ISOLATION_FAILED",
							detail: String(error),
						}),
					);
		});
		const survival = startSurvival({
			facts,
			world,
			runtime: getRuntime(),
			plan: (kind, threats, signal) => {
				const bot = host.bot;
				if (!bot) throw new Error("client disconnected");
				return planEscape(bot, kind, threats, signal);
			},
			breathable: (self) => (host.bot ? canBreathe(host.bot, self.place.position) : null),
			onFault: (error) => {
				pushFault({ code: "SAFETY_FAULT", message: String(error) });
				options.onChanged?.();
			},
		});
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
					pushFault({
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
				pushFault({ code: "CONNECTION_FAILED", message: error instanceof Error ? error.message : String(error) });
			});
		/** connection.wait 的入服事实快照；uuid 取登录会话，拿不到可靠来源就保持 null。 */
		const connectionSnapshot = (): ConnectionWaitResult => ({
			state: host.state,
			username: host.bot?.username ?? null,
			uuid: (host.bot as unknown as { uuid?: string } | null)?.uuid ?? null,
			reason: host.disconnectFacts?.reason ?? null,
		});
		// connected 在首个终态（ready/断开/故障）resolve；超时返回当前快照，不冒充结果。
		const waitConnection = async (timeoutMs: number, signal: AbortSignal): Promise<ConnectionWaitResult> => {
			if (signal.aborted) throw new RpcError("REQUEST_CANCELLED", "connection wait cancelled");
			let removeAbort = () => {};
			let cancelTimer = () => {};
			const aborted = new Promise<never>((_, reject) => {
				const onAbort = () => reject(new RpcError("REQUEST_CANCELLED", "connection wait cancelled"));
				signal.addEventListener("abort", onAbort, { once: true });
				removeAbort = () => signal.removeEventListener("abort", onAbort);
			});
			try {
				// 定时器必须清理：悬挂的 setTimeout 会拖住伴生进程事件循环，阻塞退役。
				const timer = new Promise<"timeout">((resolve) => {
					const handle = setTimeout(() => resolve("timeout"), timeoutMs);
					cancelTimer = () => clearTimeout(handle);
				});
				await Promise.race([connected.then(() => "terminal" as const), timer, aborted]);
				return connectionSnapshot();
			} finally {
				cancelTimer();
				removeAbort();
			}
		};
		const inspect = (): ExecutionSideStatus => ({
			launch: init.launch,
			storageId: init.storageId,
			observedAt: new Date().toISOString(),
			authMode: "offline",
			owner: getRuntime().inspectOwner(),
			connection: host.state,
			world: world.availability(),
			runtime: getRuntime().availability(),
			safety: getRuntime().inspectSafety(),
			program: program!.capacity(),
			faults: [...faults],
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
					() => survival.close(),
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
				detachControl();
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
				case "runtime.continue":
					assertActionAllowed();
					value = await getRuntime().continue(
						init.origin,
						payload as unknown as import("../contracts/runtime.js").ContinueRequest,
					);
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
				case "connection.wait":
					value = await waitConnection(typeof p.timeoutMs === "number" ? p.timeoutMs : 30_000, signal);
					break;
				case "program.changed":
					runtime?.programChanged();
					options.onChanged?.();
					value = null;
					break;
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
				// 请求前状态快照（批37）：一次采样同一提交边界，返回有界文本 + 可用性事实。
				case "state.snapshot": {
					const frame = sampleStateFrame({ facts, readers: stateReaders });
					// 活跃任务是请求前事实，不是事件：同一次 RPC 里附上，各自标采样时间。
					// null = 这次 Runtime 查询没读到；世界 Facts 照给，但这一段必须明说"未知"——
					// 静默省略会被读成"没有活跃任务"，也不能拿旧缓存充当实时结果。
					let activeRuns: RunSummary[] | null = null;
					try {
						activeRuns = (await getRuntime().list({ activeOnly: true })).items;
					} catch {
						// 保留 null：查询失败不是"零条"，由 formatActiveRuns 如实写出。
					}
					const digest = formatActiveRuns(activeRuns, new Date().toISOString());
					value = digest ? { ...frame, text: `${frame.text}\n${digest}` } : frame;
					break;
				}
				case "read_image": {
					// G11：只接受 map@1 实际产出的 ImageFileRef；核验 realpath/摘要后回 base64。
					const ref = payload as unknown as Parameters<typeof readExportedImage>[1];
					try {
						value = await readExportedImage(imageDir, ref);
					} catch (error) {
						throw new RpcError("INVALID_INPUT", error instanceof Error ? error.message : String(error));
					}
					break;
				}
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
