import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleQqCall, type QqAppDeps } from "../.uina/worlds/qq/src/app.js";
import { AttentionModel } from "../.uina/worlds/qq/src/attention.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { ConversationLocks } from "../.uina/worlds/qq/src/conversation-lock.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { createQqWorld } from "../.uina/worlds/qq/src/index.js";
import { OperationLog } from "../.uina/worlds/qq/src/operation-log.js";
import { renderReadWindow, renderCandidate as renderTapCandidate } from "../.uina/worlds/qq/src/render.js";
import { QqScheduler, type SchedulerDeps } from "../.uina/worlds/qq/src/scheduler.js";
import { createWorldTool } from "../src/extensions/world-framework/world-tool.js";

const NOW = "2026-10-11T04:00:00Z";
const SELF = "10001";
const CONV = "g30003";
let dir: string;
let deps: QqAppDeps;
let scheduler: QqScheduler;
let scheduled: { -readonly [K in keyof SchedulerDeps]: SchedulerDeps[K] };
let inputs: Parameters<SchedulerDeps["emit"]>[0][];
let nextId: number;

beforeEach(() => {
	vi.useFakeTimers();
	dir = mkdtempSync(join(tmpdir(), "uina-qq-review-"));
	const journal = new FactsJournal({ dataDir: dir, selfId: SELF });
	journal.recover();
	const control = new ControlStore({ dataDir: dir, selfId: SELF, now: () => NOW });
	control.load();
	const ops = new OperationLog({ dataDir: dir, selfId: SELF });
	ops.recover();
	deps = {
		selfId: SELF,
		journal,
		control,
		ops,
		now: () => NOW,
		attention: new AttentionModel(),
		locks: new ConversationLocks(),
		grants: { grants: ["observation", "attention.manage"] },
		transport: {
			start: async () => ({ selfId: Number(SELF) }),
			stop: async () => {},
			onEvent: () => () => {},
			onRaw: () => () => {},
			onStatus: () => () => {},
			call: async (action) =>
				action === "get_friend_list" || action === "get_group_list"
					? { status: "ok", data: [] }
					: { status: "failed", kind: "rejected", reason: "probe" },
		},
	};
	inputs = [];
	nextId = 0;
	scheduled = {
		selfId: SELF,
		journal,
		control,
		attention: deps.attention,
		now: () => NOW,
		emit: async (input) => {
			inputs.push(input);
		},
		renderRingWindow: (conv) =>
			renderReadWindow(conv, { journal, control, now: () => NOW }, { limit: 30, budgetChars: 14000 }),
		renderCandidate: (candidate) => renderTapCandidate(candidate, { journal, control, now: () => NOW }),
	};
	scheduler = new QqScheduler(scheduled);
});

afterEach(() => {
	scheduler.stop();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

it("settlement accounting retries idempotently and stop cancels late writes", async () => {
	focus();
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
	await inputs[0]!.render();
	const write = vi.spyOn(deps.journal, "recordDispatched").mockImplementationOnce(() => {
		throw new Error("busy");
	});
	scheduler.onInputSettled(inputs[0]!.id, true);
	expect(scheduler.inFlight).toBeNull();
	await vi.advanceTimersByTimeAsync(2000);
	expect(write).toHaveBeenCalledTimes(2);
	scheduler.onInputSettled(inputs[0]!.id, true);
	expect(write).toHaveBeenCalledTimes(2);
	arrive("again", CONV, "in");
	await vi.advanceTimersByTimeAsync(2500);
	await inputs[1]!.render();
	write.mockImplementation(() => {
		throw new Error("busy");
	});
	scheduler.onInputSettled(inputs[1]!.id, true);
	const calls = write.mock.calls.length;
	scheduler.stop();
	await vi.advanceTimersByTimeAsync(10000);
	expect(write).toHaveBeenCalledTimes(calls);
});

it("read cancelled during media expansion leaves consumption untouched", async () => {
	const abort = new AbortController();
	deps.journal.appendMessage({
		ref: "m88",
		conversationRef: CONV,
		direction: "in",
		time: NOW,
		senderRef: "u20002",
		senderDisplayName: null,
		source: "platform",
		segments: [{ type: "image", url: "https://fixture.invalid/a", understood: false }],
	});
	vi.stubGlobal("fetch", async () => {
		abort.abort();
		throw new Error("cancelled fetch");
	});
	const result = await handleQqCall(deps, "read", { conversationRef: CONV, includeMedia: true }, abort.signal);
	expect(result.status).toBe("cancelled");
	expect(deps.journal.dispatchedThroughOf(CONV)).toBe(0);
});

it("enqueue failure after materialization retains the constructed body for retry", async () => {
	focus();
	const bodies: (string | null)[] = [];
	let attempts = 0;
	scheduled.emit = async (input) => {
		bodies.push(await input.render());
		if (++attempts === 1) throw new Error("enqueue failure");
		inputs.push(input);
	};
	arrive("retained-body");
	await vi.advanceTimersByTimeAsync(5000);
	expect(attempts).toBe(2);
	expect(bodies).toHaveLength(2);
	expect(bodies[0]).toContain("retained-body");
	expect(bodies[1]).toBe(bodies[0]); // 重试复用已构建正文，不重建快照
	scheduler.onInputSettled(inputs[0]!.id, true);
	expect(deps.journal.dispatchedThroughOf(CONV)).toBe(1);
});

it("inbox online directory includes unseen names, paginates while counts change; directory failure is best-effort", async () => {
	deps.transport.call = async (action) => ({
		status: "ok",
		data:
			action === "get_group_list"
				? [
						{ group_id: 30003, group_name: "known group" },
						{ group_id: 40004, group_name: "unseen group" },
					]
				: [{ user_id: 20002, nickname: "friend" }],
	});
	const first = await handleQqCall(deps, "inbox", { limit: 1 });
	expect(first.details).toMatchObject({ total: 3, conversations: [{ name: "known group", pendingCount: 0 }] });
	arrive();
	const second = await handleQqCall(deps, "inbox", {
		limit: 1,
		cursor: (first.details as { nextCursor: string }).nextCursor,
	});
	expect(second.details).toMatchObject({ conversations: [{ name: "unseen group" }] });
	deps.attention.setFocus([CONV]);
	deps.transport.call = async () => ({ status: "failed", reason: "offline", kind: "not_connected" });
	// v3：在线目录仅补全名称，失败不阻塞红点一瞥；focus/push 照常生效
	const degraded = await handleQqCall(deps, "inbox", { focus: [], push: { target: CONV, off: true } });
	expect(degraded.status).toBe("succeeded");
	expect(deps.attention.focusList()).toEqual([]);
	expect(deps.control.effectivePush(CONV).off).toBe(true);
});

it("inbox persistence failure and invalid cursor preserve focus and push", async () => {
	deps.attention.setFocus([CONV]);
	const save = vi.spyOn(deps.control, "setPush").mockImplementation(() => {
		throw new Error("disk busy");
	});
	const result = await handleQqCall(deps, "inbox", { focus: [], push: { target: CONV, off: true } });
	expect(result.status).toBe("failed");
	expect(deps.attention.focusList()).toEqual([CONV]);
	expect(deps.control.effectivePush(CONV).off).toBe(false);
	save.mockRestore();
	const invalid = await handleQqCall(deps, "inbox", { focus: [], push: { target: CONV, off: true }, cursor: "bad" });
	expect(invalid.status).toBe("failed");
	expect(deps.attention.focusList()).toEqual([CONV]);
	expect(deps.control.effectivePush(CONV).off).toBe(false);
});

it("platform around history combines sides without receiving/consuming facts; failure never falls back", async () => {
	arrive("local-only");
	const calls: Record<string, unknown>[] = [];
	deps.transport.call = async (action, params) => {
		expect(action).toBe("get_group_msg_history");
		calls.push(params!);
		return {
			status: "ok",
			data: {
				messages: (params?.reverse_order ? [10, 11, 12] : [12, 13, 14]).map((id) => ({
					message_id: id,
					group_id: 30003,
					message_type: "group",
					user_id: 20002,
					time: 1791691200 + id,
					message: `history-${id}`,
				})),
			},
		};
	};
	const count = deps.journal.latestSequence(CONV);
	const result = await handleQqCall(deps, "browse", {
		conversationRef: CONV,
		direction: "around",
		anchorMessageRef: "m12",
		source: "platform",
		limit: 5,
	});
	expect(result.status).toBe("succeeded");
	expect(result.details).toMatchObject({ count: 5, oldest: "m10", newest: "m14", bookmarkMoved: false });
	expect(calls.map((params) => params.reverse_order)).toEqual([true, false]);
	expect(deps.journal.latestSequence(CONV)).toBe(count);
	expect(deps.journal.getMessage("m12")).toBeNull();
	expect(deps.journal.dispatchedThroughOf(CONV)).toBe(0);
	deps.transport.call = async () => ({ status: "failed", kind: "not_connected", reason: "offline" });
	expect((await handleQqCall(deps, "browse", { conversationRef: CONV, source: "platform" })).status).toBe("failed");
});

it("coverage intervals replay independently from archival", async () => {
	arrive();
	deps.journal.recordArchive("2026-10-12T00:00:00Z");
	let result = await handleQqCall(deps, "browse", { conversationRef: CONV });
	expect(result.details).toMatchObject({ archived: true, coverage: "local_observed" });
	deps.journal.recordCoverageGap({
		id: "missing-signal",
		from: "2026-10-11T03:59:00Z",
		to: null,
		reason: "explicit missing signal",
	});
	deps.journal.recordCoverageGap({
		id: "missing-signal",
		from: "2026-10-11T03:59:00Z",
		to: "2026-10-11T04:01:00Z",
		reason: "explicit missing signal",
	});
	const journal = new FactsJournal({ dataDir: dir, selfId: SELF });
	journal.recover();
	expect(journal.snapshot.coverageGaps).toHaveLength(1);
	result = await handleQqCall({ ...deps, journal }, "browse", { conversationRef: CONV });
	expect(result.details).toMatchObject({
		archived: true,
		coverage: "gap_detected",
		coverageGaps: [{ to: "2026-10-11T04:01:00Z" }],
	});
});

it("coverage overlap compares instants across timezone offsets", async () => {
	arrive();
	deps.journal.recordCoverageGap({
		id: "offset-gap",
		from: "2026-10-11T11:59:00+08:00",
		to: "2026-10-11T12:01:00+08:00",
		reason: "explicit transport error",
	});
	const result = await handleQqCall(deps, "browse", { conversationRef: CONV });
	expect(result.details).toMatchObject({ coverage: "gap_detected", archived: false });
});

it.each([14000, 500])("folded mixed messages retain usable expansion calls with budget %i", async (budgetChars) => {
	const fact = deps.journal.appendMessage({
		ref: "m901",
		conversationRef: CONV,
		direction: "in",
		senderRef: "u20002",
		senderDisplayName: null,
		time: NOW,
		source: "platform",
		segments: [
			{ type: "image", mediaRef: "image-1", url: "https://example.test/image.png", understood: false },
			{ type: "text", text: "first-part " + "x".repeat(2100) },
			{ type: "text", text: "second-part " + "y".repeat(2100) },
		],
	});
	const window = renderReadWindow(
		CONV,
		{ journal: deps.journal, control: deps.control, now: () => NOW },
		{ limit: 20, budgetChars },
	);
	expect(window.deliveredThrough).toBe(fact.sequence);
	expect(window.text).toContain(
		JSON.stringify({ action: "browse", params: { contentTarget: { messageRef: fact.ref, segmentIndex: 0 } } }),
	);
	expect(window.text).toContain(JSON.stringify({ action: "browse", params: { messageRefs: [fact.ref] } }));
	const expanded = await handleQqCall(deps, "browse", { messageRefs: [fact.ref] });
	expect(expanded.status).toBe("succeeded");
	expect(expanded.result).toContain("first-part");
	expect(expanded.result).toContain("second-part");
});

it("ring window excludes later own echo from delivery", async () => {
	focus();
	const incoming = arrive();
	arrive("own echo", CONV, "out");
	await vi.advanceTimersByTimeAsync(2500);
	const text = await inputs[0]!.render();
	expect(text).toContain(incoming.ref);
	expect(text).not.toContain("own echo");
	scheduler.onInputSettled(inputs[0]!.id, true);
	expect(deps.journal.dispatchedThroughOf(CONV)).toBe(incoming.sequence);
});

it("repeated rendering failure logs only a changed failure state", async () => {
	const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
	scheduled.renderRingWindow = () => {
		throw new Error("same render failure");
	};
	focus();
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
	for (let index = 0; index < 3; index++) {
		const input = inputs.at(-1)!;
		expect(await input.render()).toBeNull();
		scheduler.onInputSettled(input.id, false);
		await vi.advanceTimersByTimeAsync(2000);
	}
	expect(diagnostic).toHaveBeenCalledTimes(1);
});

it("local and platform history both expand media without journal writes", async () => {
	const fetcher = vi.fn(
		async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } }),
	);
	vi.stubGlobal("fetch", fetcher);
	const fact = deps.journal.appendMessage({
		ref: "m70",
		conversationRef: CONV,
		senderRef: "u20002",
		senderDisplayName: null,
		direction: "in",
		time: NOW,
		source: "platform",
		segments: [{ type: "image", understood: false, url: "https://fixture.invalid/image" }],
	});
	const local = await handleQqCall(deps, "browse", { conversationRef: CONV, includeMedia: true });
	expect(local.images).toHaveLength(1);
	deps.transport.call = async () => ({
		status: "ok",
		data: {
			messages: [
				{
					message_type: "group",
					group_id: 30003,
					message_id: 71,
					user_id: 20002,
					time: 1791691200,
					message: [{ type: "image", data: { url: "https://fixture.invalid/image" } }],
				},
			],
		},
	});
	const platform = await handleQqCall(deps, "browse", {
		conversationRef: CONV,
		source: "platform",
		includeMedia: true,
	});
	expect(platform.images).toHaveLength(1);
	expect(fetcher).toHaveBeenCalledTimes(2);
	expect(deps.journal.latestSequence(CONV)).toBe(fact.sequence);
	expect(deps.journal.dispatchedThroughOf(CONV)).toBe(0);
});

function arrive(text = "hello", conversationRef = CONV, direction: "in" | "out" = "in") {
	const fact = deps.journal.appendMessage({
		ref: `m${++nextId}`,
		conversationRef,
		direction,
		senderRef: direction === "out" ? `u${SELF}` : "u20002",
		senderDisplayName: null,
		time: NOW,
		source: direction === "out" ? "echo" : "platform",
		segments: [{ type: "text", text }],
	});
	scheduler.onFact({ kind: "message", fact });
	return fact;
}

function focus() {
	deps.attention.setFocus([CONV]);
}

it("F03 响铃排队后静音必须空退役", async () => {
	arrive("hello", "p20002"); // 私聊默认响铃
	await vi.advanceTimersByTimeAsync(2500);
	deps.control.setPush("p20002", { off: true });
	await expect(inputs[0]!.render()).resolves.toBeNull(); // 派发前重验：静音且未开窗 → 退役
});

it("F04 响铃排队后已被 read 消费完应空退役", async () => {
	focus();
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
	await handleQqCall(deps, "read", { conversationRef: CONV });
	await expect(inputs[0]!.render()).resolves.toBeNull();
});

it("F05 出站 echo 不得压制第一条入站响铃", async () => {
	focus();
	arrive("self sent", CONV, "out");
	arrive("first inbound");
	await vi.advanceTimersByTimeAsync(2500);
	expect(inputs).toHaveLength(1);
});

it("F06 新会话第一次重启不得封存未读", async () => {
	const config = {
		selfId: SELF,
		grants: { grants: ["observation"] as const },
		connection: {
			url: "ws://127.0.0.1:1",
			role: "Universal" as const,
			accessToken: "probe",
			requestTimeoutMs: 100,
			reconnect: { retries: 0, minDelayMs: 1, maxDelayMs: 2 },
		},
	};
	let receive: (event: unknown) => void = () => {};
	const transport = {
		...deps.transport,
		onEvent: (handler: (event: unknown) => void) => {
			receive = handler;
			return () => {};
		},
	};
	const context = {
		signal: new AbortController().signal,
		worldDataDir: dir,
		emitEvent: async () => ({ accepted: true as const }),
	};
	const world = createQqWorld({ config, transport });
	const actionContext = { signal: context.signal, operationIdentity: "world:qq/inbox" as const };
	try {
		await world.onStart!(context);
		receive({
			post_type: "message",
			message_type: "group",
			self_id: Number(SELF),
			group_id: 30003,
			user_id: 20002,
			message_id: 99,
			time: 1791691200,
			message: [{ type: "text", data: { text: "fresh" } }],
		});
		const before = await world.actions.inbox!.run({}, actionContext);
		await world.onStop!(context);
		await world.onStart!(context);
		const after = await world.actions.inbox!.run({}, actionContext);
		expect(before.details).toMatchObject({ conversations: [{ pendingCount: 1, archivedCount: 0 }] });
		expect(after.details).toMatchObject({ conversations: [{ pendingCount: 1, archivedCount: 0 }] });
	} finally {
		await world.onStop!(context);
	}
});

it("F07 渲染暂时失败后恢复，候选应重新排期", async () => {
	focus();
	scheduled.renderRingWindow = () => {
		throw new Error("temporary read failure");
	};
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
	expect(await inputs[0]!.render()).toBeNull();
	scheduled.renderRingWindow = (conv) =>
		renderReadWindow(
			conv,
			{ journal: deps.journal, control: deps.control, now: () => NOW },
			{ limit: 30, budgetChars: 14000 },
		);
	scheduler.onInputSettled(inputs[0]!.id, false);
	await vi.advanceTimersByTimeAsync(5000);
	expect(inputs).toHaveLength(2);
});

it("F08 记账 IO 失败不得锁死占位", async () => {
	focus();
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
	await inputs[0]!.render();
	vi.spyOn(deps.journal, "recordDispatched").mockImplementation(() => {
		throw new Error("EBUSY");
	});
	try {
		scheduler.onInputSettled(inputs[0]!.id, true);
	} catch {
		/* inspect state after the host catches */
	}
	expect(scheduler.inFlight).toBeNull();
});

it("F09 等待消费锁期间取消 read 不得推进书签", async () => {
	arrive();
	let release!: () => void;
	let started!: () => void;
	const began = new Promise<void>((resolve) => {
		started = resolve;
	});
	const held = deps.locks.run(
		CONV,
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
				started();
			}),
	);
	await began;
	const abort = new AbortController();
	const reading = handleQqCall(deps, "read", { conversationRef: CONV }, abort.signal);
	abort.abort();
	release();
	await held;
	const result = await reading;
	expect(result.status).toBe("cancelled");
	expect(deps.journal.dispatchedThroughOf(CONV)).toBe(0);
});

it("F10 跨会话 poke 独立拍肩，不与会话响铃混批", async () => {
	focus();
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
	await inputs[0]!.render(); // 完成物化：候选出 pending
	scheduler.onInputSettled(inputs[0]!.id, true); // 释放占位并记账
	const fact = {
		ref: deps.journal.mintEventRef(),
		kind: "poke" as const,
		time: NOW,
		source: "platform" as const,
		conversationRef: "g40004",
		targetRef: `u${SELF}`,
		actorRef: "u20002",
	};
	deps.journal.appendEvent(fact);
	scheduler.onFact({ kind: "event", fact });
	await vi.advanceTimersByTimeAsync(2500);
	expect(inputs).toHaveLength(2);
	expect(inputs[0]!.conversationRef).toBe(CONV);
	expect(inputs[1]!.conversationRef).toBe("g40004");
	expect(await inputs[1]!.render()).toContain(fact.ref);
});

it("F11 busy 时短防抖到期应进入邮箱占位", async () => {
	// Full busy Subject behavior is covered by qq-world-subject-integration.
	focus();
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
	expect(inputs).toHaveLength(1);
});

it("F12 第21条申请必须有合法的只读续页入口", async () => {
	for (let i = 1; i <= 21; i++)
		deps.journal.appendRequest({
			ref: `r${i}`,
			kind: "friend",
			state: "pending",
			time: NOW,
			requesterRef: `u${20000 + i}`,
			requesterDisplayName: null,
			comment: null,
			platformFlag: `flag-${i}`,
		});
	const result = await handleQqCall(deps, "requests", { action: "list" });
	const page = result.details as { nextCursor?: string };
	expect(page.nextCursor).toBeTruthy();
	const world = createQqWorld();
	world.actions.requests = { ...world.actions.requests!, run: (params) => handleQqCall(deps, "requests", params) };
	const tool = createWorldTool(world, { getRuntime: () => ({ definition: world, enabled: true }) });
	const next = await tool.run({ action: "requests", params: { action: "list", cursor: page.nextCursor } });
	expect(next.status).toBe("succeeded");
	expect(next.details).toMatchObject({ count: 1, hasMore: false });
});

it("F13 富消息的展开指引必须使用存活 action", async () => {
	focus();
	const fact = deps.journal.appendMessage({
		ref: "m55",
		conversationRef: CONV,
		direction: "in",
		time: NOW,
		senderRef: "u20002",
		senderDisplayName: null,
		source: "platform",
		segments: [{ type: "json", data: '{"hello":"world"}' }],
	});
	scheduler.onFact({ kind: "message", fact });
	await vi.advanceTimersByTimeAsync(2500);
	const text = await inputs[0]!.render();
	expect(text).not.toMatch(/observe/);
});

it("F15 延迟渲染新增到期提醒不能被再次投递", async () => {
	deps.control.createFollowUp({ targetRef: CONV, note: "A", reviewAt: NOW });
	scheduler.notifyControlTick();
	await vi.advanceTimersByTimeAsync(2500);
	const b = deps.control.createFollowUp({ targetRef: CONV, note: "B", reviewAt: NOW });
	const text = await inputs[0]!.render();
	expect(text).toContain(b.ref);
	scheduler.onInputSettled(inputs[0]!.id, true);
	expect(deps.control.getFollowUp(b.ref)?.reviewNotified).toBe(true);
});

it("F17 browse 点查 includeMedia=true 应展开已有图片", async () => {
	const fetcher = vi.fn(
		async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } }),
	);
	vi.stubGlobal("fetch", fetcher);
	try {
		const fact = deps.journal.appendMessage({
			ref: "m56",
			conversationRef: CONV,
			direction: "in",
			time: NOW,
			senderRef: "u20002",
			senderDisplayName: null,
			source: "platform",
			segments: [{ type: "image", url: "https://review.invalid/image", understood: false }],
		});
		const result = await handleQqCall(deps, "browse", { messageRefs: [fact.ref], includeMedia: true });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(result.images).toHaveLength(1);
	} finally {
		vi.unstubAllGlobals();
	}
});
