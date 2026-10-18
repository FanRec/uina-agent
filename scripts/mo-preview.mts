/**
 * Local MO action authoring preview. Offline sampling never creates a VTS client.
 *
 *   pnpm mo:preview -- [--seed N] <action...>       continuous live preview
 *   pnpm mo:preview -- --once [--seed N] <action>  live preview once
 *   pnpm mo:preview -- --repeat N [--seed S] <action>
 *   pnpm mo:preview -- --sample [--seed S] <action> <actionMs>
 *   pnpm mo:preview -- --list | --help
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { compileAction, sampleAction, type CompiledAction } from "../.uina/worlds/live2d/authoring/action.js";
import type { CatalogSnapshot, CatalogResolved, CatalogKind } from "../.uina/worlds/live2d/authoring/catalog.js";
import { deriveRandom, createRootSeed } from "../.uina/worlds/live2d/authoring/random.js";
import { MotionDirector, type MotionDirectorActionDiagnostics } from "../.uina/worlds/live2d/director/director.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { loadCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { MO_SPEECH } from "../.uina/worlds/live2d/models/mo/speech.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import { Live2DRuntime, pickVariantIndex } from "../.uina/worlds/live2d/runtime.js";

export interface PreviewArguments {
	readonly mode: "continuous" | "once" | "repeat" | "sample" | "list" | "help" | "scenario";
	readonly names: readonly string[];
	readonly seed?: number;
	readonly repeatCount?: number;
	readonly actionMs?: number;
	readonly offline?: boolean;
}

const USAGE = [
	"用法:",
	"  pnpm mo:preview -- --scenario idle|speech|mixed [--offline] [--seed N] 固定场景；speech/mixed 使用模拟电平，无真实音频",
	"  pnpm mo:preview -- [--seed N] <动作名...>          连续轮播（支持动作如 nod, sway 或背景如 idle, thinking）",
	"  pnpm mo:preview -- --once [--seed N] <动作名>      单次执行",
	"  pnpm mo:preview -- --repeat N [--seed S] <动作名>  固定 seed 重复 N 次",
	"  pnpm mo:preview -- --sample [--seed S] <动作名> <actionMs>  离线采样，不连接 VTS",
	"  pnpm mo:preview -- --list | --help",
].join("\n");

export function parsePreviewArguments(args: readonly string[]): PreviewArguments {
	let seed: number | undefined;
	let offline = false;
	let mode: PreviewArguments["mode"] = "continuous";
	let modeValue: number | undefined;
	const names: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--offline") {
			offline = true;
			continue;
		}
		if (arg === "--scenario") {
			if (mode !== "continuous" || names.length) throw new Error("场景不能混用其他模式");
			mode = "scenario";
			const scene = args[++index];
			if (!scene || !["idle", "speech", "mixed"].includes(scene)) throw new Error("场景只接受 idle/speech/mixed");
			names.push(scene);
			continue;
		}
		if (arg === "--seed") {
			const raw = args[index + 1];
			const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
			if (seed !== undefined || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff)
				throw new Error("--seed 只接受一个 0-4294967295 的整数。");
			seed = parsed;
			index++;
			continue;
		}
		if (arg === "--once" || arg === "--repeat" || arg === "--sample" || arg === "--list" || arg === "--help") {
			if (mode !== "continuous" || names.length || modeValue !== undefined)
				throw new Error("预览模式只能指定一次，且不能混用多个模式。");
			if (arg === "--once") mode = "once";
			else if (arg === "--repeat") {
				mode = "repeat";
				const raw = args[++index];
				const count = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
				if (!Number.isSafeInteger(count) || count <= 0) throw new Error("--repeat 次数必须是正安全整数。");
				modeValue = count;
			} else if (arg === "--sample") mode = "sample";
			else mode = arg === "--list" ? "list" : "help";
			continue;
		}
		if (arg.startsWith("--")) throw new Error("未知参数: " + arg);
		names.push(arg);
	}
	if (offline && mode !== "scenario") throw new Error("--offline 仅用于 --scenario");
	if (mode === "scenario" && names.length !== 1) throw new Error("场景不接受额外动作名");
	if (mode === "help") return { mode, names, ...(seed === undefined ? {} : { seed }) };
	if (mode === "list" && names.length) throw new Error("--list 不接受动作名。");
	if (mode === "once" && names.length !== 1) throw new Error("--once 必须且只能指定一个动作名。");
	if (mode === "repeat" && names.length !== 1) throw new Error("--repeat 必须且只能指定一个动作名。");
	if (mode === "sample") {
		if (names.length !== 2) throw new Error("--sample 需要一个动作名和一个 actionMs。");
		const parsed = Number(names[1]);
		if (!Number.isFinite(parsed) || parsed < 0) throw new Error("actionMs 必须是非负有限毫秒数。");
		modeValue = parsed;
		names.length = 1;
	}
	if ((mode === "continuous" || mode === "once" || mode === "repeat") && names.length === 0)
		throw new Error("至少指定一个动作名。");
	return {
		mode,
		names: Object.freeze(names),
		...(mode === "scenario" ? { seed: seed ?? 42, offline } : seed === undefined ? {} : { seed }),
		...(mode === "repeat" ? { repeatCount: modeValue! } : {}),
		...(mode === "sample" ? { actionMs: modeValue! } : {}),
	};
}

export function resolveAction(catalog: CatalogSnapshot, name: string): CatalogResolved<"motion"> {
	const resolved = catalog.resolve("motion", name);
	if (resolved) return resolved;

	const lower = name.toLowerCase();
	if (
		(lower === "idle" || lower === "待机" || lower === "呼吸" || lower === "background:idle") &&
		catalog.background.idle
	) {
		return {
			kind: "motion",
			name: "idle",
			aliases: ["background:idle", "待机", "呼吸"],
			entry: {
				description: "自然待机单短句（持续表演请用 --scenario idle）",
				definition: catalog.background.idle,
				atomic: false,
				playback: { fadeInMs: 450, fadeOutMs: 450 },
			},
		};
	}

	if (
		(lower === "thinking" || lower === "思考" || lower === "沉思" || lower === "background:thinking") &&
		catalog.background.thinking
	) {
		return {
			kind: "motion",
			name: "thinking",
			aliases: ["background:thinking", "思考", "沉思"],
			entry: {
				description: "思考单短句（Runtime 持续轮换）",
				definition: catalog.background.thinking,
				atomic: false,
				playback: { fadeInMs: 350, fadeOutMs: 450 },
			},
		};
	}

	const ambientResolved = catalog.resolve("ambient", name);
	if (ambientResolved) {
		return {
			kind: "motion",
			name: ambientResolved.name,
			aliases: ambientResolved.aliases,
			entry: {
				description: ambientResolved.entry.description,
				definition: ambientResolved.entry.motion,
				variants: ambientResolved.entry.variants,
				atomic: false,
			},
		};
	}

	const availableMotions = catalog
		.list("motion")
		.map(({ name: actionName, aliases }) => (aliases.length ? actionName + "(" + aliases.join("/") + ")" : actionName));
	const availableBackgrounds = [
		...(catalog.background.idle ? ["idle(background:idle/待机/呼吸)"] : []),
		...(catalog.background.thinking ? ["thinking(background:thinking/思考)"] : []),
	];
	const available = [...availableMotions, ...availableBackgrounds];
	throw new Error(
		available.length === 0
			? "当前模型没有可用动作（动作目录为空）。"
			: '动作不在当前模型目录: "' + name + '"。可用动作: ' + available.join(", "),
	);
}

export function wrapCatalogForPreview(catalog: CatalogSnapshot): CatalogSnapshot {
	return {
		modelID: catalog.modelID,
		background: catalog.background,
		resolveCue: (word) => catalog.resolveCue(word),
		list: (kind) => catalog.list(kind),
		resolve: <K extends CatalogKind>(kind: K, nameOrAlias: string): CatalogResolved<K> | undefined => {
			if (kind === "motion") {
				try {
					return resolveAction(catalog, nameOrAlias) as CatalogResolved<K>;
				} catch {
					return undefined;
				}
			}
			return catalog.resolve(kind, nameOrAlias);
		},
	};
}

function compileFirstPlay(
	rig: ModelRig,
	entry: CatalogResolved<"motion">,
	seed: number,
	playIndex = 0,
): { clip: CompiledAction; variantIndex: number } {
	const variants = entry.entry.variants ?? [];
	const variantIndex = variants.length
		? pickVariantIndex(variants.length + 1, undefined, deriveRandom(seed, "selection", entry.name, playIndex))
		: 0;
	const authoring = variantIndex === 0 ? entry.entry.definition : variants[variantIndex - 1]!;
	const clip = compileAction(authoring, rig.controls, deriveRandom(seed, "performance", entry.name, playIndex));
	return { clip, variantIndex };
}

function summarizeClip(clip: CompiledAction) {
	return {
		durationMs: clip.durationMs,
		speed: clip.speed,
		wallDurationMs: clip.durationMs / clip.speed,
		channels: clip.channels.map(({ axis, space, speech, extents }) => ({
			axis,
			space,
			...(speech === undefined ? {} : { speech }),
			...(extents === undefined ? {} : { extents }),
		})),
		spatial: clip.spatial,
	};
}

/** Compile and evaluate one action without constructing a VTS client or issuing external requests. */
export function buildOfflinePreviewSnapshot(
	rig: ModelRig,
	catalog: CatalogSnapshot,
	actionName: string,
	seed: number,
	requestedActionMs: number,
) {
	if (!Number.isFinite(requestedActionMs) || requestedActionMs < 0) throw new Error("actionMs 必须是非负有限毫秒数。");
	const resolved = resolveAction(catalog, actionName);
	const { clip, variantIndex } = compileFirstPlay(rig, resolved, seed);
	const actionMs = Math.min(requestedActionMs, clip.durationMs);
	const baseline = Object.fromEntries(Object.entries(rig.controls).map(([axis, control]) => [axis, control.neutral]));
	const rawTargets = sampleAction(clip, actionMs, baseline);
	const actionTargets = Object.entries(rawTargets).map(([axis, requested]) => {
		const control = rig.controls[axis]!;
		return {
			axis,
			requested,
			value: Math.max(control.min, Math.min(control.max, requested)),
			min: control.min,
			max: control.max,
			clamped: requested < control.min || requested > control.max,
		};
	});

	const director = new MotionDirector(rig.controls, {
		external: rig.external,
		rng: deriveRandom(seed, "autonomic", "world", 0),
		diagnostics: true,
	});
	director.play(clip, {
		...resolved.entry.playback,
		category: "voluntary",
		atomic: resolved.entry.atomic,
	});
	// Natural completion starts a handoff at duration; sample the final composed frame immediately before it.
	const directorActionMs = Math.min(actionMs, Math.max(0, clip.durationMs - 0.000001));
	const targetWallMs = directorActionMs / clip.speed;
	let elapsedWallMs = 0;
	if (targetWallMs === 0) director.step(0, 0);
	while (elapsedWallMs < targetWallMs) {
		const stepMs = Math.min(1000 / 60, targetWallMs - elapsedWallMs);
		director.step(stepMs, stepMs);
		elapsedWallMs += stepMs;
	}
	const diagnostics = director.getActionDiagnostics();
	return {
		mode: "offline-sample",
		modelID: rig.modelID,
		seed,
		action: resolved.name,
		playIndex: 0,
		variantIndex,
		requestedActionMs,
		actionMs,
		directorActionMs,
		plan: summarizeClip(clip),
		actionTargets,
		composition: diagnostics
			? {
					clockMs: diagnostics.clockMs,
					authoredTargets: diagnostics.authoredTargets,
					composedFrame: diagnostics.composedFrame,
					contributions: diagnostics.contributions,
					clampHits: diagnostics.clampHits,
				}
			: null,
	};
}

function printJson(label: string, value: unknown): void {
	console.log(label + " " + JSON.stringify(value));
}

async function waitReady(runtime: Live2DRuntime, stopping: () => boolean): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (!(runtime.connectionOnline && runtime.identityMatched())) {
		if (stopping()) return;
		if (Date.now() > deadline)
			throw new Error("等待 VTS 连接/模型绑定超时；请确认 VTube Studio 已启动、API 已授权且加载 MO 模型。");
		process.stdout.write("[预览] 等待 VTS 连接与模型绑定…\r");
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	console.log("[预览] 已就绪（VTS 已连接，模型绑定核验通过）。");
}

export function mixedScenarioSchedule(): readonly {
	atMs: number;
	type: "motion" | "interrupt" | "expression";
	name?: string;
}[] {
	return [
		...["nod", "curious", "glance", "shake", "chin_up", "smug_laugh", "head_toss", "nod", "curious"].map(
			(name, index) => ({ atMs: 8000 + index * 13000, type: "motion" as const, name }),
		),
		{ atMs: 8700, type: "interrupt" as const },
		{ atMs: 60700, type: "interrupt" as const },
		{ atMs: 16000, type: "expression" as const, name: "closed_eyes" },
		{ atMs: 19000, type: "expression" as const, name: "neutral_expression" },
	].sort((a, b) => a.atMs - b.atMs);
}

/** Fixed schedules use the production Runtime; offline transport records zero physical confirmations. */
export async function runPerformanceScenario(
	rig: ModelRig,
	catalog: CatalogSnapshot,
	scene: "idle" | "speech" | "mixed",
	seed = 42,
	offline = false,
	durationOverride?: number,
): Promise<void> {
	const durations = { idle: 300000, speech: 180000, mixed: 120000 };
	const durationMs = durationOverride ?? durations[scene];
	const evidence = () => ({
		generation: 0,
		sent: 0,
		accepted: 0,
		failed: 0,
		dropped: 0,
		filtered: 0,
		pending: 0,
		acceptedInputs: [],
		sentInputs: [],
	});
	const client = offline
		? ({
				isConnected: () => true,
				getModelProfile: () => ({ modelID: rig.modelID, physicsOutputs: [] }),
				getModelGeneration: () => 0,
				getConnectionGeneration: () => 0,
				setConnectionChangeListener: () => {},
				connect: () => {},
				disconnect: () => {},
				injectParameters: () => {},
				observeMotionInjections: () => ({ snapshot: evidence, finish: async () => evidence(), close: () => {} }),
			} as unknown as VTSClient)
		: new VTSClient();
	let lastClock = -1000;
	const runtime = new Live2DRuntime({
		rig,
		catalog,
		client,
		speech: MO_SPEECH,
		seed,
		// Offline composition is driven below without yielding to the interval clock.
		diagnostics: true,
		onPerformanceEvent: (event) => printJson("[表演]", event),
		onActionDiagnostics: (diagnostics) => {
			if (!diagnostics.clampHits.length && diagnostics.clockMs - lastClock < 1000) return;
			lastClock = diagnostics.clockMs;
			printJson("[场景帧]", {
				clockMs: diagnostics.clockMs,
				frame: diagnostics.composedFrame,
				handoffs: diagnostics.handoffs,
				clampHits: diagnostics.clampHits,
			});
		},
	});
	const controller = new AbortController();
	const pending = new Set<Promise<unknown>>();
	const onInterrupt = () => controller.abort();
	process.on("SIGINT", onInterrupt);
	process.on("SIGTERM", onInterrupt);
	printJson("[场景]", {
		scene,
		seed,
		durationMs,
		offline,
		audio: scene === "idle" ? "none" : "SIMULATED_LEVELS_NO_AUDIO",
		physicalEvidence: offline ? "none" : "requires_visual_review",
	});
	try {
		await runtime.start({} as never);
		if (!offline) await waitReady(runtime, () => controller.signal.aborted);
		let index = 0;
		const schedule = mixedScenarioSchedule();
		if (scene === "mixed")
			printJson("[场景跳过]", {
				capability: "costume",
				reason: catalog.list("costume").length ? "costume_requires_separate_restore_review" : "no_registered_costume",
			});
		const wallStart = performance.now();
		let lastStep = -1;
		while (!controller.signal.aborted) {
			const ms = offline ? ++lastStep * 20 : performance.now() - wallStart;
			if (ms >= durationMs) break;
			if (scene !== "idle") {
				const rms = ms % 7000 > 5300 ? 0 : 0.025 + 0.022 * Math.sin(ms / 170) ** 2;
				runtime.levelSink?.processLevel({ rms });
			}
			while (scene === "mixed" && index < schedule.length && ms >= schedule[index]!.atMs) {
				const event = schedule[index++]!;
				printJson("[场景事件]", event);
				if (event.type === "interrupt") {
					runtime.interrupt();
					continue;
				}
				if (event.type === "expression" && !catalog.resolve("expression", event.name!)) {
					printJson("[场景跳过]", { ...event, reason: "expression_not_registered" });
					continue;
				}
				const task =
					event.type === "motion"
						? runtime.express({ motion: event.name! }, { signal: controller.signal })
						: runtime.state({ expression: event.name! }, { signal: controller.signal });
				pending.add(task);
				void task.then(
					(result) => {
						pending.delete(task);
						printJson("[场景动作]", result);
					},
					(error: unknown) => {
						pending.delete(task);
						printJson("[场景错误]", String(error));
					},
				);
			}
			if (offline) {
				runtime.composeTick(20);
				await Promise.resolve();
			} else await new Promise((resolve) => setTimeout(resolve, 20));
		}
	} finally {
		controller.abort();
		runtime.levelSink?.reset();
		try {
			await runtime.stop();
		} finally {
			await Promise.allSettled([...pending]);
			process.off("SIGINT", onInterrupt);
			process.off("SIGTERM", onInterrupt);
		}
	}
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	let parsed: PreviewArguments;
	try {
		parsed = parsePreviewArguments(args);
	} catch (error) {
		console.error("[预览] " + (error instanceof Error ? error.message : String(error)) + "\n" + USAGE);
		process.exitCode = 1;
		return;
	}
	if (parsed.mode === "help") {
		console.log(USAGE);
		return;
	}
	const rig = await loadRig(MO_MODEL_ID);
	if (!rig) throw new Error("MO rig 装配失败，无法预览。");
	const catalog = loadCatalog(MO_MODEL_ID, rig);
	if (!catalog) throw new Error("MO 目录装配失败，无法预览。");
	if (parsed.mode === "list") {
		const actions = catalog
			.list("motion")
			.map(({ name, aliases, entry }) => ({ name, aliases, description: entry.description }));
		const backgrounds = [
			...(catalog.background.idle
				? [
						{
							name: "idle",
							aliases: ["background:idle", "待机", "呼吸"],
							description: "自然待机单短句（持续表演请用 --scenario idle）",
						},
					]
				: []),
			...(catalog.background.thinking
				? [
						{
							name: "thinking",
							aliases: ["background:thinking", "思考", "沉思"],
							description: "思考单短句（Runtime 持续轮换）",
						},
					]
				: []),
			...catalog.list("ambient").map(({ name, aliases, entry }) => ({
				name,
				aliases,
				description: entry.description,
			})),
		];
		printJson("[预览] 动作目录", {
			modelID: catalog.modelID,
			actions,
			backgrounds,
			empty: actions.length === 0 && backgrounds.length === 0,
		});
		return;
	}
	const seed = parsed.seed ?? createRootSeed();
	if (parsed.mode === "sample") {
		const snapshot = buildOfflinePreviewSnapshot(rig, catalog, parsed.names[0]!, seed, parsed.actionMs!);
		printJson("[预览] 离线采样（未连接 VTS、未产生外部副作用）", snapshot);
		return;
	}
	if (parsed.mode === "scenario") {
		await runPerformanceScenario(
			rig,
			catalog,
			parsed.names[0] as "idle" | "speech" | "mixed",
			parsed.seed ?? 42,
			parsed.offline ?? false,
		);
		return;
	}
	const previewCatalog = wrapCatalogForPreview(catalog);
	for (const name of parsed.names) resolveAction(previewCatalog, name);

	let lastDiagnosticClock = Number.NEGATIVE_INFINITY;
	const runtime = new Live2DRuntime({
		client: new VTSClient(),
		rig,
		catalog: previewCatalog,
		speech: MO_SPEECH,
		seed,
		diagnostics: true,
		onActionCompiled: ({ actionName, playIndex, clip }) =>
			printJson("[计划]", { actionName, playIndex, ...summarizeClip(clip) }),
		onPerformanceEvent: (event) => printJson("[表演]", event),
		onSpatialTrace: (trace) => printJson("[空间追踪]", trace),
		onActionDiagnostics: (diagnostics: MotionDirectorActionDiagnostics) => {
			if (diagnostics.clockMs - lastDiagnosticClock < 250 && diagnostics.clockMs !== 0) return;
			lastDiagnosticClock = diagnostics.clockMs;
			printJson("[合成诊断]", diagnostics);
		},
	});
	const controller = new AbortController();
	let stopping = false;
	let stopPromise: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		if (stopPromise) return stopPromise;
		stopping = true;
		controller.abort(new Error("preview stop"));
		stopPromise = runtime.stop();
		return stopPromise;
	};
	const onInterrupt = () => {
		console.log("\n[预览] 收到中断，safeStop 正在结算在途动作与空间清理…");
		void shutdown().then(
			() => process.exit(0),
			(error) => {
				console.error("[预览] 停车清理未完全确认:", error instanceof Error ? error.message : String(error));
				process.exit(1);
			},
		);
	};
	process.on("SIGINT", onInterrupt);
	process.on("SIGTERM", onInterrupt);
	try {
		await runtime.start({} as never);
		console.log("[预览] mode=" + parsed.mode + " seed=" + seed + "；停止时会调用 safeStop 并核验清理。");
		await waitReady(runtime, () => stopping);
		if (stopping) return;
		const count =
			parsed.mode === "once" ? 1 : parsed.mode === "repeat" ? parsed.repeatCount! : Number.POSITIVE_INFINITY;
		let index = 0;
		while (!stopping && index < count) {
			const name = parsed.names[parsed.mode === "continuous" ? index % parsed.names.length : 0]!;
			const started = Date.now();
			const result = await runtime.express({ motion: name }, { signal: controller.signal });
			index++;
			printJson("[结算]", {
				action: name,
				iteration: index,
				status: result.status,
				durationMs: Date.now() - started,
				result: result.result,
				details: result.details,
			});
			if (parsed.mode === "continuous" && result.status !== "succeeded" && !stopping)
				await new Promise((resolve) => setTimeout(resolve, 2000));
		}
	} finally {
		process.off("SIGINT", onInterrupt);
		process.off("SIGTERM", onInterrupt);
		if (!stopping) await shutdown();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void main().catch((error) => {
		console.error("[预览] 执行失败:", error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
