import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleQqCall, type QqAppDeps } from "../../.uina/worlds/qq/src/app.js";
import { AttentionModel } from "../../.uina/worlds/qq/src/attention.js";
import { ControlStore } from "../../.uina/worlds/qq/src/control-store.js";
import { ConversationLocks } from "../../.uina/worlds/qq/src/conversation-lock.js";
import { FactsJournal } from "../../.uina/worlds/qq/src/facts-journal.js";
import { OperationLog } from "../../.uina/worlds/qq/src/operation-log.js";
import { QqScheduler, type SchedulerDeps } from "../../.uina/worlds/qq/src/scheduler.js";
import { renderBatch, renderFollowBody } from "../../.uina/worlds/qq/src/render.js";
import { createQqWorld } from "../../.uina/worlds/qq/src/index.js";
import { createWorldTool } from "../../src/extensions/world-framework/world-tool.js";

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
		attention: new AttentionModel({ control }),
		locks: new ConversationLocks(),
		grants: { grants: ["observation", "attention.manage"] },
		transport: {
			start: async () => ({ selfId: Number(SELF) }),
			stop: async () => {},
			onEvent: () => () => {},
			onRaw: () => () => {},
			onStatus: () => () => {},
			call: async () => ({ status: "failed", kind: "rejected", reason: "probe" }),
		},
	};
	inputs = [];
	nextId = 0;
	scheduled = {
		selfId: SELF,
		journal,
		control,
		attention: deps.attention,
		locks: deps.locks,
		now: () => NOW,
		emit: async (input) => {
			inputs.push(input);
		},
		renderBatch: (candidate) => renderBatch(candidate, { journal, control, now: () => NOW }),
		renderFollowBody: (conv) => renderFollowBody(conv, { journal, control, now: () => NOW }),
	};
	scheduler = new QqScheduler(scheduled);
});

afterEach(() => {
	scheduler.stop();
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
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
	deps.control.setPush(CONV, { mode: "follow" });
	deps.attention.setFocus([CONV]);
}

it("F01 follow 不得丢弃整条正文后推进消费书签", async () => {
	focus();
	for (let i = 0; i < 10; i++) arrive(`unique-${i} ${"x".repeat(1900)}`);
	await vi.advanceTimersByTimeAsync(2500);
	const text = await inputs[0]!.render();
	console.log("F01", {
		firstPresent: text?.includes("unique-0"),
		through: deps.journal.dispatchedThroughOf(CONV),
		textLength: text?.length,
	});
	expect(deps.journal.dispatchedThroughOf(CONV)).toBe(0);
});

it("F02 follow 排队后 focus=[] 必须阻止正文灌注", async () => {
	focus();
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
	deps.attention.setFocus([]);
	const text = await inputs[0]!.render();
	expect(text).not.toContain("[QQ 跟读]");
});

it("F03 通知排队后 mode=off 必须静音", async () => {
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
	deps.control.setPush(CONV, { mode: "off" });
	await expect(inputs[0]!.render()).resolves.toBeNull();
});

it("F04 follow 排队后已被 read 消费完应空退役", async () => {
	focus();
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
	await handleQqCall(deps, "read", { conversationRef: CONV });
	await expect(inputs[0]!.render()).resolves.toBeNull();
});

it("F05 出站 echo 不得压制第一条入站通知", async () => {
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
	const context = { signal: new AbortController().signal, worldDataDir: dir, emitEvent: async () => {} };
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
		console.log("F06", { before: before.details, after: after.details });
		expect(after.details).toMatchObject({ conversations: [{ pendingCount: 1, archivedCount: 0 }] });
	} finally {
		await world.onStop!(context);
	}
});

it("F07 渲染暂时失败后恢复，已有首条消息应重新排期", async () => {
	scheduled.renderBatch = () => {
		throw new Error("temporary read failure");
	};
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
	expect(await inputs[0]!.render()).toBeNull();
	scheduled.renderBatch = (candidate) =>
		renderBatch(candidate, { journal: deps.journal, control: deps.control, now: () => NOW });
	scheduler.onInputSettled(inputs[0]!.id, false);
	scheduler.notifyControlTick();
	scheduler.onAgentSettled();
	await vi.advanceTimersByTimeAsync(5000);
	expect(inputs).toHaveLength(2);
});

it("F08 通知记账 IO 失败不得锁死占位", async () => {
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
	await inputs[0]!.render();
	vi.spyOn(deps.journal, "recordNotified").mockImplementation(() => {
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
	console.log("F09", { status: result.status, through: deps.journal.dispatchedThroughOf(CONV) });
	expect(deps.journal.dispatchedThroughOf(CONV)).toBe(0);
});

it("F10 跨会话 poke 应升级现有纸条", async () => {
	arrive();
	await vi.advanceTimersByTimeAsync(2500);
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
	expect(await inputs[0]!.render()).toContain(fact.ref);
});

it("F11 busy 时短防抖到期应进入邮箱占位", async () => {
	scheduled.isBusy = () => true;
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
	const tool = createWorldTool(world, { getRuntime: () => ({ definition: world, enabled: true }) });
	const next = await tool.run({ action: "requests", params: { action: "list", cursor: page.nextCursor } });
	expect(next.status).toBe("succeeded");
});

it("F13 富消息的展开指引必须使用存活 action", async () => {
	const fact = deps.journal.appendMessage({
		ref: "m55",
		conversationRef: CONV,
		direction: "in",
		time: NOW,
		senderRef: "u20002",
		source: "platform",
		segments: [{ type: "json", data: '{"hello":"world"}' }],
	});
	scheduler.onFact({ kind: "message", fact });
	await vi.advanceTimersByTimeAsync(2500);
	const text = await inputs[0]!.render();
	expect(text).not.toMatch(/observe/);
});

it("F14 单条超长 follow 必须按字符压力退让", async () => {
	focus();
	arrive("x".repeat(20000));
	await vi.advanceTimersByTimeAsync(2500);
	const text = await inputs[0]!.render();
	console.log("F14", { length: text?.length, through: deps.journal.dispatchedThroughOf(CONV) });
	expect(text?.includes("自动正文已暂停灌注")).toBe(true);
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

it("F16 暂停结束摘要不得把已消费正文统计为未读", async () => {
	arrive();
	await handleQqCall(deps, "read", { conversationRef: CONV });
	deps.control.setPush(CONV, { pausedUntil: NOW });
	scheduler.notifyControlTick();
	await vi.advanceTimersByTimeAsync(2500);
	expect(inputs).toHaveLength(0);
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
