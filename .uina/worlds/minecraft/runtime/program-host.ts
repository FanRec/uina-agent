import { randomUUID } from "node:crypto";
import type { BodyCallScope, CallContext } from "../contracts/capabilities.js";
import type {
	BlockTarget,
	EntityRef,
	WindowSession,
	WindowSnapshot,
	ItemSelector,
	StackExpectation,
	ControlInput,
	FeedbackStream,
	BlockPos,
	SignText,
} from "../contracts/body.js";
import type { ProgramHostApi, HandleRef } from "../contracts/program.js";
import { callFailure, plain, type JsonValue, type Vec3 } from "../contracts/values.js";
import type { WorldWatch } from "../contracts/world.js";
import { matchesItem } from "../contracts/items.js";

type BodyHandle = { kind: "body"; scope: BodyCallScope; release(): void; closed: Promise<void> };
type WindowHandle = {
	kind: "window";
	window: WindowSession;
	view: WindowSnapshot | null;
	needsSnapshot: boolean;
	body: BodyCallScope;
};
type StreamHandle = { kind: "stream"; stream: FeedbackStream };
type Handle = BodyHandle | WindowHandle | StreamHandle;
function fail(code: string, message: string): never {
	throw callFailure({ code, message, source: "program", dispatch: "not_sent", effects: [], recoverable: true });
}
function decodeVersion(token: string): import("../contracts/values.js").ObservationCursor {
	let cursor: import("../contracts/values.js").ObservationCursor;
	try {
		cursor = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as typeof cursor;
	} catch {
		return fail("INVALID_INPUT", "invalid observation version");
	}
	if (
		!cursor ||
		typeof cursor.stream !== "string" ||
		typeof cursor.epoch !== "string" ||
		!Number.isSafeInteger(cursor.sequence) ||
		cursor.sequence < 0
	)
		fail("INVALID_INPUT", "invalid observation version");
	return cursor;
}
export function createProgramHost(
	ctx: CallContext,
	resources: Set<() => Promise<void>>,
	access: (selector: string) => "read" | "act" | undefined,
): ProgramHostApi {
	const lifetime = new AbortController();
	const hostSignal = AbortSignal.any([ctx.signal, lifetime.signal]);
	const handles = new Map<string, Handle>();
	function live(): void {
		if (hostSignal.aborted) fail("PROGRAM_RETIRED", "call is retired");
	}
	function get(handle: string): Handle {
		live();
		const h = handles.get(handle);
		if (!h) return fail("ACCESS_DENIED", "handle does not belong to this call");
		return h;
	}
	const closeHandle = async ({ handle }: { handle: string }): Promise<null> => {
		const h = handles.get(handle);
		if (!h) return null;
		if (h.kind === "body") {
			h.release();
			try {
				await h.closed;
			} finally {
				handles.delete(handle);
			}
		} else if (h.kind === "stream") {
			await h.stream.close();
			handles.delete(handle);
		} else {
			await h.window.close({ force: ctx.signal.aborted });
			handles.delete(handle);
		}
		return null;
	};
	const close = async () => {
		lifetime.abort();
		await Promise.allSettled([...handles.keys()].map((handle) => closeHandle({ handle })));
	};
	resources.add(close);
	const api: ProgramHostApi = {
		call: async ({ selector, args, delegateBody, handle }) => {
			live();
			if (access(selector) === "read") fail("USE_MC_READ", "queries use mc.read");
			if (delegateBody) {
				const h = get(handle ?? "");
				if (h.kind !== "body") fail("ACCESS_DENIED", "body handle required");
				return h.scope.call(selector, args);
			}
			return ctx.call(selector, args);
		},
		read: async ({ targets, after }) => {
			live();
			const values: Record<string, JsonValue> = {},
				versions: Record<string, string | null> = {},
				unknown: Record<string, string[]> = {};
			for (const [key, target] of Object.entries(targets)) {
				if (access(target.ref) === "act" || !target.ref.includes("@"))
					fail("USE_MC_CALL", "actions and programs use mc.call");
				const value = await ctx.world
					.read<JsonValue>({ ref: target.ref as `${string}@${string}`, input: target.input ?? {} })
					.catch((error: unknown) => {
						const code = (error as { code?: string } | null)?.code;
						if (after?.[key] && (code === "DISCONNECTED" || code === "SOURCE_UNAVAILABLE")) return null;
						throw error;
					});
				live();
				if (value === null) return { kind: "invalidated", reason: "source_unavailable" };
				if (after?.[key] && value.cursor) {
					const previous = decodeVersion(after[key]!);
					if (previous.stream !== value.cursor.stream) return { kind: "invalidated", reason: "stream_changed" };
					if (previous.epoch !== value.cursor.epoch) return { kind: "invalidated", reason: "epoch_changed" };
					if (previous.sequence > value.cursor.sequence) return { kind: "invalidated", reason: "cursor_expired" };
				}
				values[key] = value.value;
				versions[key] = value.cursor ? Buffer.from(JSON.stringify(value.cursor)).toString("base64url") : null;
				unknown[key] = value.unknown;
			}
			return { values, versions, unknown };
		},
		watch: async ({ targets, after, timeoutMs }) => {
			live();
			if (!targets || typeof targets !== "object" || Array.isArray(targets) || Object.keys(targets).length === 0)
				fail("INVALID_INPUT", "wait targets must be a nonempty object");
			if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0))
				fail("INVALID_INPUT", "timeoutMs must be finite and non-negative");
			const controller = new AbortController();
			const signal = AbortSignal.any([ctx.signal, controller.signal]);
			const watches: WorldWatch[] = [];
			const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const schedule = () => {
				if (deadline === undefined) return;
				const remaining = deadline - performance.now();
				if (remaining <= 0) controller.abort("wait_deadline");
				else timer = setTimeout(schedule, Math.min(remaining, 2147483647));
			};
			const close = async () => {
				clearTimeout(timer);
				controller.abort();
				await Promise.allSettled(watches.map((w) => w.close()));
			};
			resources.add(close);
			schedule();
			try {
				const pending: Promise<import("../contracts/program.js").WatchResult>[] = [];
				for (const [key, target] of Object.entries(targets)) {
					if (!target || typeof target.ref !== "string" || typeof after?.[key] !== "string")
						fail("INVALID_INPUT", "each wait target requires an observation version");
					const cursor = decodeVersion(after[key]!);
					signal.throwIfAborted();
					const watch = await ctx.world.watch(
						{ ref: target.ref as `${string}@${string}`, input: target.input ?? {} },
						cursor,
						signal,
					);
					watches.push(watch);
					// Install a rejection handler immediately while subsequent targets are being registered.
					const next = watch
						.next(cursor, signal)
						.then((change) =>
							change.kind === "reset"
								? { status: "invalidated" as const, reason: change.reason }
								: { status: "changed" as const },
						);
					void next.catch(() => {});
					pending.push(next);
				}
				return await Promise.race(pending);
			} catch (error) {
				live();
				if (controller.signal.reason === "wait_deadline") return { status: "timeout" };
				throw error;
			} finally {
				await close();
				resources.delete(close);
			}
		},

		sleep: async ({ ms }) => {
			live();
			if (!Number.isFinite(ms) || ms < 0) fail("PROGRAM_INPUT_INVALID", "sleep ms must be finite and non-negative");
			await new Promise<void>((resolve, reject) => {
				const done = () => {
					hostSignal.removeEventListener("abort", abort);
					resolve();
				};
				const timer = setTimeout(done, ms);
				const abort = () => {
					clearTimeout(timer);
					hostSignal.removeEventListener("abort", abort);
					reject(
						callFailure({
							code: "CANCELLED",
							source: "environment",
							message: "sleep cancelled",
							dispatch: "not_sent",
							effects: [],
							recoverable: false,
						}),
					);
				};
				hostSignal.addEventListener("abort", abort, { once: true });
				if (hostSignal.aborted) abort();
			});
			return null;
		},
		progress: async ({ value }) => {
			if (!ctx.signal.aborted) await ctx.progress(value);
			return null;
		},
		log: async () => null, // Worker keeps the bounded diagnostic tail, not a second durable event stream.
		acquireBody: async () => {
			live();
			const handle = `handle:${randomUUID()}`;
			let grant!: (value: HandleRef) => void, reject!: (error: unknown) => void;
			const ready = new Promise<HandleRef>((a, b) => {
				grant = a;
				reject = b;
			});
			let release!: () => void;
			const released = new Promise<void>((r) => {
				release = r;
			});
			const closed = ctx.withBody(async (scope) => {
				await Promise.resolve();
				handles.set(handle, { kind: "body", scope, release, closed });
				grant({ handle, kind: "body" });
				await released;
			});
			void closed.catch(reject);
			return ready;
		},
		releaseBody: closeHandle,
		closeHandle,
		handleOp: async ({ handle, op, args }) => {
			const h = get(handle);
			const a = args as Record<string, JsonValue>;
			if (h.kind === "stream") {
				if (op === "next") return plain(await h.stream.next(a.after as number | null, ctx.signal));
				if (op === "apply")
					return plain(
						await h.stream.apply(
							a.frame as unknown as import("../contracts/body.js").FeedbackFrameRef,
							a.input as unknown as ControlInput,
						),
					);
				return fail("ACCESS_DENIED", "invalid stream operation");
			}
			if (h.kind === "window") {
				if (op === "snapshot") {
					const f = await h.window.snapshot();
					h.view = structuredClone(f.value);
					h.needsSnapshot = false;
					return plain(f);
				}
				if (op !== "click") fail("ACCESS_DENIED", `unsupported window operation ${op}`);
				if (h.needsSnapshot) fail("CONFLICT", "previous click requires an explicit snapshot");
				if (!h.view) {
					const f = await h.window.snapshot();
					h.view = structuredClone(f.value);
				}
				const view = h.view!;
				const slot = a.slot as number,
					mode = a.mode ?? "click",
					button = (a.button ?? 0) as number;
				if (mode !== "click" && mode !== 0) fail("INVALID_INPUT", "only mode-0 clicks are supported");
				if (!Number.isInteger(slot) || slot < 0 || slot >= view.layout.slotCount || ![0, 1].includes(button))
					fail("INVALID_INPUT", "invalid click slot/button");
				const stack = (item: JsonValue | null): StackExpectation =>
					item
						? {
								item: {
									name: (item as { name: string }).name,
									components: (item as { components?: JsonValue }).components,
								},
								count: (item as { count: number }).count,
							}
						: { item: null, count: 0 };
				const reference = view.slots.find((s) => s.slot === slot)?.item ?? null;
				if (a.expect !== undefined) {
					const e = a.expect as unknown as StackExpectation;
					if (!e || typeof e.count !== "number" || !("item" in e))
						fail("INVALID_INPUT", "expect must be a StackExpectation");
					const current = stack(reference);
					if (
						current.count !== e.count ||
						(e.item === null
							? reference !== null
							: reference === null ||
								!matchesItem(e.item, reference as unknown as import("../contracts/body.js").ItemValue))
					)
						fail("CONFLICT", "reference slot does not match expect");
				}
				const current = await h.window.snapshot();
				const receipt = await h.window.click({
					slot,
					mode: 0,
					button,
					expectedRevision: current.value.revision,
					expectedSlots: [{ slot, stack: stack(reference) }],
					expectedCursor: stack(view.cursor),
				});
				h.needsSnapshot = receipt.needsSnapshot;
				if (receipt.confirmed) {
					const changed = receipt.confirmed.slots.find((s) => s.slot === slot);
					if (changed) {
						const i = view.slots.findIndex((s) => s.slot === slot);
						view.slots[i] = structuredClone(changed);
					}
					view.cursor = structuredClone(receipt.confirmed.cursor);
				}
				return plain(receipt);
			}
			const player = h.scope.player;
			if (op === "waitClosed") {
				await h.closed;
				return fail("CONTROL_INVALID", "body scope ended");
			}
			const target = async (raw: JsonValue): Promise<BlockTarget | EntityRef> => {
				if (raw && typeof raw === "object" && !Array.isArray(raw) && "networkId" in raw)
					return raw as unknown as EntityRef;
				const at = raw as unknown as BlockPos;
				const self = await ctx.world.read<{ place: import("../contracts/values.js").Place }>({
					ref: "self@1",
					input: {},
				});
				const block = ("position" in at ? at.position : at) as Vec3;
				if (!block || ![block.x, block.y, block.z].every(Number.isInteger))
					fail("INVALID_INPUT", "block coordinates must be integers");
				const place = {
					...self.value.place,
					position: block,
					...("dimension" in at ? { dimension: at.dimension } : {}),
				};
				return { place, block };
			};
			switch (op) {
				case "feedback": {
					const stream = await player.feedback(
						a.sensors as unknown as Record<string, import("../contracts/world.js").WorldQuery>,
					);
					const id = `handle:${randomUUID()}`;
					handles.set(id, { kind: "stream", stream });
					return { handle: id, kind: "stream" };
				}
				case "drive":
					return plain(
						await player.drive(a.input as unknown as ControlInput, (a.opts as { ticks?: number })?.ticks ?? 1),
					);
				case "dig": {
					const t = await target(a.at!);
					if ("networkId" in t) fail("INVALID_INPUT", "dig requires a block");
					return plain(await player.dig(t, a.opts as { aim?: "target" | "preserve" }));
				}
				case "attack":
					return plain(await player.attack(a.target as unknown as EntityRef));
				case "useItem":
					return plain(await player.useItem(a.hand === "off" ? "off" : "main"));
				case "endUse":
					return plain(await player.endUse());
				case "equip":
					return plain(
						await player.equip(a.item as unknown as ItemSelector | null, a.hand === "off" ? "offhand" : "hand"),
					);
				case "lookAt":
					return plain(await player.lookAt(a.target as unknown as Vec3));
				case "interact": {
					const opts = a.opts as { hand?: "main" | "off"; face?: Vec3; cursor?: Vec3 };
					return plain(await player.interact({ target: await target(a.target!), ...opts, hand: opts.hand ?? "main" }));
				}
				case "writeSign": {
					const t = await target(a.at!);
					if ("networkId" in t) fail("INVALID_INPUT", "sign requires a block");
					return plain(await player.writeSign(t, a.opts as unknown as { side: "front" | "back"; lines: SignText }));
				}
				case "openContainer": {
					const window = await player.openContainer(await target(a.target!));
					const id = `handle:${randomUUID()}`;
					handles.set(id, { kind: "window", window, view: null, needsSnapshot: false, body: h.scope });
					return { handle: id, kind: "window" };
				}
				default:
					return fail("PROGRAM_UNAVAILABLE", `body operation ${op} is not delivered`);
			}
		},
	};
	return api;
}
