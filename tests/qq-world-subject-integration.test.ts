import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { createQqWorld } from "../.uina/worlds/qq/src/index.js";
import type { QqTransport } from "../.uina/worlds/qq/src/transport.js";
import { WorldActivation } from "../src/extensions/world-framework/world-activation.js";
import { createWorldTool } from "../src/extensions/world-framework/world-tool.js";
import type { RuntimeEvent } from "../src/runtime/events.js";
import { openJsonlSession } from "../src/session/jsonl-store.js";
import { SubjectHarness } from "./harness/core/subject-harness.js";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function fixture() {
	vi.useFakeTimers();
	const dir = mkdtempSync(join(tmpdir(), "uina-qq-subject-"));
	const path = join(dir, "session.jsonl");
	const { store } = await openJsonlSession(path);
	let release!: () => void;
	let started!: () => void;
	const began = new Promise<void>((resolve) => {
		started = resolve;
	});
	let calls = 0;
	const harness = SubjectHarness.create({
		store,
		stream: async (_model, _request, delta, signal) => {
			if (++calls === 1) {
				await new Promise<void>((resolve) => {
					release = resolve;
					started();
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
			}
			if (signal?.aborted) return;
			delta({ kind: "text", text: "ok" });
			delta({ kind: "finish", reason: "stop" });
		},
	});
	const events: RuntimeEvent[] = [];
	harness.subscribe((event) => {
		events.push(event);
	});
	let receive: (event: unknown) => void = () => {};
	const transport: QqTransport = {
		start: async () => ({ selfId: 10001 }),
		stop: async () => {},
		onEvent: (handler) => {
			receive = handler;
			return () => {
				receive = () => {};
			};
		},
		onRaw: () => () => {},
		onStatus: () => () => {},
		call: async (action) => ({
			status: "ok",
			data: action === "get_group_list" || action === "get_friend_list" ? [] : {},
		}),
	};
	const world = createQqWorld({
		transport,
		config: {
			selfId: "10001",
			grants: { grants: ["observation", "attention.manage"] },
			connection: {
				url: "ws://127.0.0.1:1",
				role: "Universal",
				accessToken: "fixture",
				requestTimeoutMs: 100,
				reconnect: { retries: 0, minDelayMs: 1, maxDelayMs: 2 },
			},
		},
	});
	const pi = {
		subject: { stateRoot: dir },
		cwd: dir,
		submitInput: (input: Parameters<typeof harness.subject.accept>[0]) => harness.subject.accept(input),
		isBusy: () => harness.isBusy(),
		registerTool: () => () => {},
		on: (type: string, handler: (event: RuntimeEvent) => void) =>
			harness.subscribe((event) => {
				if (event.type === type) handler(event);
			}),
	};
	const activation = new WorldActivation(world, {
		pi: pi as never,
		runtime: { definition: world, enabled: true },
		worldName: "qq",
		notifyExposed: () => {},
	});
	await activation.start();
	const tool = createWorldTool(world, { getRuntime: () => ({ definition: world, enabled: true }) });
	const busy = harness.pushInput("foreground");
	await began;
	let messageId = 0;
	function arrive(text: string, groupId = 30003): void {
		receive({
			post_type: "message",
			message_type: "group",
			self_id: 10001,
			group_id: groupId,
			user_id: 20002,
			message_id: ++messageId,
			time: Math.floor(Date.now() / 1000),
			message: [{ type: "text", data: { text } }],
		});
	}
	function journal(): FactsJournal {
		const saved = new FactsJournal({ dataDir: join(dir, "world-data", "qq", "v2", "10001"), selfId: "10001" });
		saved.recover(true);
		return saved;
	}
	async function finish(interrupt = false): Promise<void> {
		if (interrupt) harness.interrupt();
		else release();
		await busy;
		await harness.waitForIdle();
	}
	async function close(): Promise<void> {
		release();
		harness.interrupt();
		await busy.catch(() => {});
		await harness.waitForIdle();
		await activation.stop();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
	return {
		store,
		events,
		harness,
		arrive,
		receive: (event: unknown) => receive(event),
		tool,
		journal,
		finish,
		close,
		path,
	};
}

it("World → Subject FIFO: 群零注入留红点，poke 拍肩在 busy 下排队并于空闲交付", async () => {
	const f = await fixture();
	try {
		f.arrive("body-first");
		await vi.advanceTimersByTimeAsync(2500);
		expect(f.store.state.queued.size).toBe(0); // 群不在场默认零注入
		expect(
			f.store.readRecords().filter((record) => record.kind === "input" && record.input.source?.ref === "qq"),
		).toHaveLength(0);
		f.receive({
			post_type: "notice",
			notice_type: "notify",
			sub_type: "poke",
			self_id: 10001,
			group_id: 40004,
			user_id: 20002,
			target_id: 10001,
			time: Math.floor(Date.now() / 1000),
		});
		await vi.advanceTimersByTimeAsync(2500);
		await vi.waitFor(() => expect(f.store.state.queued.size).toBe(1));
		await f.finish();
		const inputs = f.store
			.readRecords()
			.filter((record) => record.kind === "input" && record.input.source?.ref === "qq");
		expect(inputs).toHaveLength(1);
		const text = inputs[0]!.kind === "input" ? inputs[0]!.input.text : "";
		expect(text).toContain("poke");
		expect(text).toContain("g40004");
		expect(f.journal().dispatchedThroughOf("g30003")).toBe(0); // 红点语义：书签不动
		expect(readFileSync(f.path, "utf8")).not.toContain('"render":');
	} finally {
		await f.close();
	}
});

it("World → Subject: read/skip racing queued ring retires empty input; later ring persists actual delivery", async () => {
	const f = await fixture();
	try {
		await f.tool.run({ action: "inbox", params: { focus: ["g30003"] } });
		f.arrive("read-by-tool");
		f.arrive("skip-by-tool");
		await vi.advanceTimersByTimeAsync(2500);
		await vi.waitFor(() => expect(f.store.state.queued.size).toBe(1));
		await f.tool.run({ action: "read", params: { conversationRef: "g30003", limit: 1 } });
		await f.tool.run({ action: "skip", params: { conversationRef: "g30003" } });
		await f.finish();
		expect(f.events).toContainEqual(
			expect.objectContaining({ type: "input_settled", outcome: "retired", reason: "empty_render" }),
		);
		f.arrive("delivered-by-ring");
		await vi.advanceTimersByTimeAsync(2500);
		await f.harness.waitForIdle();
		const inputs = f.store
			.readRecords()
			.filter((record) => record.kind === "input" && record.input.source?.ref === "qq");
		expect(inputs).toHaveLength(1);
		expect(inputs[0]!.kind === "input" && inputs[0]!.input.text).toContain("delivered-by-ring");
		expect(f.journal().dispatchedThroughOf("g30003")).toBe(3);
	} finally {
		await f.close();
	}
});

it("World → Subject: appendInput retry reuses successful ring body across foreground interruption", async () => {
	const f = await fixture();
	try {
		await f.tool.run({ action: "inbox", params: { focus: ["g30003"] } });
		f.arrive("must-survive-retry");
		await vi.advanceTimersByTimeAsync(2500);
		await vi.waitFor(() => expect(f.store.state.queued.size).toBe(1));
		const append = f.store.appendInput.bind(f.store);
		let failed = false;
		const bodies: string[] = [];
		vi.spyOn(f.store, "appendInput").mockImplementation(async (input) => {
			if (input.source?.ref === "qq") {
				bodies.push(input.text ?? "");
				if (!failed) {
					failed = true;
					throw new Error("fixture append failure");
				}
			}
			await append(input);
		});
		await f.finish(true);
		await f.harness.subject.resumePending();
		expect(failed).toBe(true);
		expect(f.store.state.queued.size).toBe(1);
		await f.harness.subject.resumePending();
		await f.harness.waitForIdle();
		expect(failed).toBe(true);
		expect(bodies.length).toBeGreaterThanOrEqual(2);
		expect(new Set(bodies).size).toBe(1);
		expect(bodies[0]).toContain("must-survive-retry");
		expect(f.journal().dispatchedThroughOf("g30003")).toBe(1);
		expect(
			f.store.readRecords().filter((record) => record.kind === "input" && record.input.source?.ref === "qq"),
		).toHaveLength(1);
	} finally {
		await f.close();
	}
});
