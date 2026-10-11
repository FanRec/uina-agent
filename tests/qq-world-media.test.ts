import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type QqAppDeps, handleQqCall as runQqCall } from "../.uina/worlds/qq/src/app.js";
import { AttentionModel } from "../.uina/worlds/qq/src/attention.js";
import type { QqWorldConfig } from "../.uina/worlds/qq/src/config.js";
import { loadQqWorldConfig } from "../.uina/worlds/qq/src/config.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { ConversationLocks } from "../.uina/worlds/qq/src/conversation-lock.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { createQqWorld } from "../.uina/worlds/qq/src/index.js";
import { QqIngestion } from "../.uina/worlds/qq/src/ingest.js";
import { MediaStaging } from "../.uina/worlds/qq/src/media.js";
import { checkMediaPath, toFileUri } from "../.uina/worlds/qq/src/media-root.js";
import { OperationLog } from "../.uina/worlds/qq/src/operation-log.js";
import { segmentText } from "../.uina/worlds/qq/src/render.js";
import type { QqTransport, TransportCallOutcome } from "../.uina/worlds/qq/src/transport.js";

function handleQqCall(
	deps: QqAppDeps,
	action: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): ReturnType<typeof runQqCall> {
	return runQqCall(deps, action, { account: deps.selfId, ...params }, signal);
}

const SELF = "10001";
const TARGET = `p20002`;
let dir: string;
let root: string;
let ops: OperationLog;
let staging: MediaStaging;
let journal: FactsJournal;
let deps: QqAppDeps;
let calls: { action: string; params: Record<string, unknown>; echo?: string }[];
let respond: (action: string, params: Record<string, unknown>, echo?: string) => TransportCallOutcome;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "uina-qq-media-"));
	root = join(dir, "allowed");
	mkdirSync(root);
	ops = new OperationLog({ dataDir: dir, selfId: SELF });
	ops.recover();
	staging = new MediaStaging({ stagingDir: join(dir, "staging"), ops });
	journal = new FactsJournal({ dataDir: dir, selfId: SELF });
	journal.recover();
	const control = new ControlStore({ dataDir: dir, selfId: SELF });
	control.load();
	calls = [];
	respond = () => ({ status: "ok", data: { message_id: 90 } });
	const transport: QqTransport = {
		start: async () => ({ selfId: Number(SELF) }),
		stop: async () => {},
		onEvent: () => () => {},
		onRaw: () => () => {},
		onStatus: () => () => {},
		call: async (action, params = {}, _signal, echo) => {
			calls.push({ action, params, echo });
			return respond(action, params, echo);
		},
	};
	deps = {
		selfId: SELF,
		grants: { grants: ["observation", "messaging", "profile.modify"] },
		journal,
		control,
		ops,
		transport,
		attention: new AttentionModel({ control }),
		locks: new ConversationLocks(),
		media: { allowedRoots: [root], staging },
	};
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(name = "voice.wav", body = "media bytes") {
	const path = join(root, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
	return path;
}
function speak(content: Record<string, unknown>[], signal?: AbortSignal) {
	return handleQqCall(deps, "send", { conversationRef: TARGET, content }, signal);
}
function resource(path: string) {
	return { kind: "file", path };
}

describe("G8 roots/staging", () => {
	it("rejects lexical traversal even when resolve folds it back inside the root", () => {
		file();
		expect(checkMediaPath(root + "/sub/../voice.wav", { allowedRoots: [root] })).toMatchObject({
			ok: false,
			reason: "traversal",
		});
	});
	it("rejects sibling prefix, relative path, directory, and symlink/junction escape", () => {
		const outside = join(dir, "allowed-other");
		mkdirSync(outside);
		writeFileSync(join(outside, "x"), "secret");
		symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
		for (const path of [join(outside, "x"), join(root, "escape", "x"), "relative.wav", root]) {
			expect(checkMediaPath(path, { allowedRoots: [root] }).ok).toBe(false);
		}
		expect(checkMediaPath(file(), { allowedRoots: [] }).ok).toBe(false);
	});
	it("file URI round trips spaces, unicode and URL delimiters", () => {
		const path = file("音频 #100%.wav");
		expect(fileURLToPath(toFileUri(path))).toBe(resolve(path));
	});
	it("staging survives source deletion and preserves two equal basenames", () => {
		const ref = ops.newOperationRef();
		const source = file("a/voice.wav", "first");
		const first = staging.stage(source, ref);
		const second = staging.stage(file("b/voice.wav", "second"), ref);
		rmSync(source);
		expect(first).not.toBe(second);
		expect(readFileSync(first, "utf8")).toBe("first");
		expect(readFileSync(second, "utf8")).toBe("second");
	});
	it("restart cleanup removes settled copies, retains unknown and sources, and never resends", () => {
		const source = file();
		const ref = ops.newOperationRef();
		ops.commitIntent({
			ref,
			action: "send_private_msg",
			identity: "test",
			outcome: "unknown",
			echo: `${SELF}/${ref}`,
			startedAt: new Date().toISOString(),
		});
		const copy = staging.stage(source, ref);
		const recovered = new OperationLog({ dataDir: dir, selfId: SELF });
		recovered.recover();
		const restarted = new MediaStaging({ stagingDir: join(dir, "staging"), ops: recovered });
		expect(restarted.cleanupSettled()).toMatchObject({ removed: 0, keptUnknown: 1 });
		expect(existsSync(copy)).toBe(true);
		recovered.settleFromEchoReceipt(`${SELF}/${ref}`, { status: "ok" }, new Date().toISOString());
		expect(restarted.cleanupSettled()).toMatchObject({ removed: 1 });
		expect(existsSync(copy)).toBe(false);
		expect(existsSync(source)).toBe(true);
		expect(calls).toHaveLength(0);
	});
});

describe("G8 media facts and action composition", () => {
	it("World startup wires default roots and cleans only settled staging on restart", async () => {
		const config: QqWorldConfig = {
			selfId: SELF,
			grants: deps.grants,
			connection: {
				url: "ws://test.invalid",
				role: "Universal",
				accessToken: "fake",
				requestTimeoutMs: 100,
				reconnect: { retries: 0, minDelayMs: 10, maxDelayMs: 20 },
			},
		};
		const context = { worldDataDir: dir, signal: new AbortController().signal };
		const world = createQqWorld({ config, transport: deps.transport });
		try {
			await world.onStart?.(context);
			const source = join(dir, "v2", SELF, "fixture.wav");
			writeFileSync(source, "media bytes");
			const result = await world.actions.send!.run(
				{ conversationRef: TARGET, content: [{ type: "audio", path: source }] },
				{ operationIdentity: "world:qq/send", signal: context.signal },
			);
			expect(result.status).toBe("succeeded");
			const sent = calls.find((call) => call.action === "send_private_msg")!;
			const copy = fileURLToPath((sent.params.message as { data: { file: string } }[])[0]!.data.file);
			expect(existsSync(copy)).toBe(true);
			await world.onStop?.(context);
			await world.onStart?.(context);
			expect(existsSync(copy)).toBe(false);
			expect(calls.filter((call) => call.action === "send_private_msg")).toHaveLength(1);
		} finally {
			await world.onStop?.(context);
		}
	});
	it("durable barrier failure returns not_started without platform dispatch", async () => {
		vi.spyOn(ops, "commitIntent").mockImplementation(() => {
			throw new Error("intent cannot be durably committed");
		});
		const result = await handleQqCall(deps, "send", {
			conversationRef: TARGET,
			content: [{ type: "image", resource: resource(file()) }],
		});
		expect(result.status).toBe("failed");
		expect(result.details).toMatchObject({ reason: "intent_commit_failed", effect: "not_started" });
		expect(calls).toHaveLength(0);
	});
	it("successful writes retain operationRef in details and durable log without repeating it in normal text", async () => {
		const result = await speak([{ type: "image", resource: resource(file()) }]);
		expect(result.details).toMatchObject({ operationRef: "o1" });
		expect(String(result.result)).not.toContain("operationRef=o1");
		expect(ops.get("o1")).toMatchObject({ outcome: "succeeded", messageRef: "m90" });
		expect(calls[0]!.echo).toBe(`${SELF}/o1`);
	});
	it("receipt log failure preserves platform success and staging evidence", async () => {
		vi.spyOn(ops, "settle").mockImplementation(() => {
			throw new Error("disk unavailable");
		});
		const result = await speak([{ type: "image", resource: resource(file()) }]);
		expect(result.status).toBe("succeeded");
		expect(result.details).toMatchObject({ diagnostic: "operation_receipt_log_failed" });
		expect(staging.cleanupSettled().keptUnknown).toBe(1);
	});
	it("thrown transport after dispatch is unknown and retains the staged file", async () => {
		respond = () => {
			throw new Error("lost connection");
		};
		const result = await speak([{ type: "audio", resource: resource(file()) }]);
		expect(result.status).toBe("unknown");
		expect(calls).toHaveLength(1);
		expect(staging.cleanupSettled().keptUnknown).toBe(1);
	});
	it("media metadata is visible and never treated as an understood attachment", () => {
		expect(
			segmentText([
				{
					type: "image",
					mediaRef: `a1`,
					fileName: 'a"b.png',
					url: "https://example.test/p.png",
					understood: false,
				},
			]),
		).toContain(`ref=a1`);
	});
	it("qq_media with local file URL cannot bypass allowed roots", async () => {
		journal.appendMessage({
			ref: `m99`,
			conversationRef: TARGET,
			senderRef: null,
			senderDisplayName: null,
			direction: "in",
			source: "platform",
			time: new Date().toISOString(),
			segments: [{ type: "image", mediaRef: `a99`, url: "file:///C:/private.png", understood: false }],
		});
		const result = await speak([{ type: "image", resource: { kind: "qq_media", ref: `a99` } }]);
		expect(result.status).toBe("failed");
		expect(calls).toHaveLength(0);
	});
	it("media refs replay from facts and remain unique across restart and conversations", () => {
		const event = (id: number, peer: number) => ({
			post_type: "message",
			self_id: Number(SELF),
			time: 1791331200,
			message_type: "private",
			message_id: id,
			user_id: peer,
			message: [{ type: "image", data: { url: "https://example.test/a.png", file: "a.png" } }],
		});
		new QqIngestion(SELF, journal).handleEvent(event(1, 20002));
		const seg = journal.getMessage(`m1`)!.segments[0] as { mediaRef: string };
		const restored = new FactsJournal({ dataDir: dir, selfId: SELF });
		restored.recover();
		expect(restored.getMedia(seg.mediaRef)).toMatchObject({ type: "image", url: "https://example.test/a.png" });
		new QqIngestion(SELF, restored).handleEvent(event(2, 30003));
		const next = restored.getMessage(`m2`)!.segments[0] as { mediaRef: string };
		expect(next.mediaRef).not.toBe(seg.mediaRef);
	});
	it("text/image/audio stage before durable dispatch and audio uses record", async () => {
		const path = file();
		respond = (_action, params, echo) => {
			expect(ops.get(echo!.split("/")[1]!)).toMatchObject({ outcome: "unknown", echo });
			const segments = params.message as { type: string; data: { file?: string } }[];
			expect(segments.map((s) => s.type)).toEqual(["text", "image", "record", "text"]);
			for (const s of segments.filter((s) => s.data.file)) {
				const copy = fileURLToPath(s.data.file!);
				expect(copy).not.toBe(path);
				expect(readFileSync(copy, "utf8")).toBe("media bytes");
			}
			return { status: "ok", data: { message_id: 90 } };
		};
		const result = await speak([
			{ type: "text", text: "start" },
			...["image", "audio"].map((type) => ({ type, resource: resource(path) })),
			{ type: "text", text: "end" },
		]);
		expect(result.status).toBe("succeeded");
		expect(calls).toHaveLength(1);
	});
	it("video gets its own batch so upstream fallback cannot reorder adjacent text", async () => {
		const result = await speak([
			{ type: "video", resource: resource(file("video.mp4")) },
			{ type: "text", text: "after video" },
		]);
		expect(result.status).toBe("succeeded");
		expect(calls.map((c) => (c.params.message as { type: string }[]).map((s) => s.type))).toEqual([
			["video"],
			["text"],
		]);
	});
	it("ambiguous negative late receipt cannot mark an unknown upload as failed or delete its copy", async () => {
		respond = () => ({ status: "failed", kind: "timeout", reason: "timeout" });
		await speak([{ type: "audio", resource: resource(file()) }]);
		const echo = calls[0]!.echo!;
		ops.settleFromEchoReceipt(echo, { status: "failed", retcode: 100, data: null }, new Date().toISOString());
		expect(ops.get("o1")?.outcome).toBe("unknown");
		expect(staging.cleanupSettled().keptUnknown).toBe(1);
		ops.settleFromEchoReceipt(echo, { status: "failed", retcode: 1400, data: null }, new Date().toISOString());
		expect(ops.get("o1")?.outcome).toBe("failed");
	});
	it("file boundaries preserve actual dispatch order and return each confirmed receipt", async () => {
		const path = file("report.txt");
		const result = await speak([
			{ type: "file", resource: resource(path), name: "report.txt" },
			{ type: "text", text: "middle" },
			{ type: "file", resource: resource(path) },
		]);
		expect(calls.map((c) => (c.params.message as { type: string }[]).map((s) => s.type))).toEqual([
			["file"],
			["text"],
			["file"],
		]);
		expect(new Set(calls.map((c) => c.echo)).size).toBe(3);
		expect(result.status).toBe("succeeded");
		expect(result.details).toMatchObject({
			confirmedParts: [
				{ from: 0, through: 0 },
				{ from: 1, through: 1 },
				{ from: 2, through: 2 },
			],
		});
	});
	it("partial failure reports confirmed segments and never sends the remaining part", async () => {
		const path = file("report.txt");
		let count = 0;
		respond = () =>
			++count === 1
				? { status: "ok", data: { message_id: 101 } }
				: { status: "failed", kind: "rejected", reason: "file rejected" };
		const result = await speak([
			{ type: "text", text: "already sent" },
			{ type: "file", resource: resource(path) },
			{ type: "text", text: "do not send" },
		]);
		expect(result.status).toBe("failed");
		expect(result.details).toMatchObject({
			confirmedParts: [{ from: 0, through: 0, messageRef: `m101` }],
			stoppedAt: 1,
			remainingFrom: 2,
		});
		expect(calls).toHaveLength(2);
	});
	it("all batch copies are prepared before any externally visible part", async () => {
		const path = file("report.txt");
		const stage = staging.stage.bind(staging);
		let copies = 0;
		vi.spyOn(staging, "stage").mockImplementation((source, ref) => {
			if (++copies === 2) throw new Error("second copy failed");
			return stage(source, ref);
		});
		const result = await speak([
			{ type: "text", text: "do not send" },
			{ type: "file", resource: resource(path) },
			{ type: "file", resource: resource(path) },
		]);
		expect(result.status).toBe("failed");
		expect(calls).toHaveLength(0);
	});
	it("outside-root media in speak and avatar makes zero platform calls", async () => {
		const path = join(dir, "private.png");
		writeFileSync(path, "private");
		for (const result of [
			await speak([{ type: "image", resource: resource(path) }]),
			await handleQqCall(deps, "profile", { action: "set_avatar", avatarPath: path }),
		]) {
			expect(result.status).toBe("failed");
			expect(result.details).toMatchObject({ effect: "not_started" });
		}
		expect(calls).toHaveLength(0);
	});
	it("qq_media uses replayed URL with account/type/address validation", async () => {
		journal.appendMessage({
			ref: `m4`,
			conversationRef: TARGET,
			senderRef: null,
			senderDisplayName: null,
			direction: "in",
			source: "platform",
			time: new Date().toISOString(),
			segments: [{ type: "image", mediaRef: `a4`, url: "https://example.test/p.png", understood: false }],
		});
		const send = (ref: string, type = "image") => speak([{ type, resource: { kind: "qq_media", ref } }]);
		expect((await send(`a4`)).status).toBe("succeeded");
		expect(calls[0]!.params.message).toEqual([{ type: "image", data: { file: "https://example.test/p.png" } }]);
		for (const [ref, type] of [
			["bad-media-ref", "image"],
			[`a999999`, "image"],
			[`a4`, "audio"],
		]) {
			expect((await send(ref!, type)).status).toBe("failed");
		}
		expect(calls).toHaveLength(1);
	});
	it("timeout retains own copy, restart does not resend, platform rejection is failed", async () => {
		const path = file();
		respond = () => ({ status: "failed", kind: "timeout", reason: "timeout" });
		expect((await speak([{ type: "audio", resource: resource(path) }])).status).toBe("unknown");
		const segments = calls[0]!.params.message as { data: { file: string } }[];
		const copy = fileURLToPath(segments[0]!.data.file);
		rmSync(path);
		expect(readFileSync(copy, "utf8")).toBe("media bytes");
		expect(staging.cleanupSettled().keptUnknown).toBe(1);
		expect(calls).toHaveLength(1);
		respond = () => ({ status: "failed", kind: "rejected", reason: "unsupported audio format" });
		expect((await speak([{ type: "audio", resource: resource(file()) }])).status).toBe("failed");
	});
	it("copy failure and cancelled input never dispatch", async () => {
		const path = file();
		writeFileSync(join(dir, "blocked"), "not a directory");
		const broken: QqAppDeps = {
			...deps,
			media: { allowedRoots: [root], staging: new MediaStaging({ stagingDir: join(dir, "blocked"), ops }) },
		};
		const result = await handleQqCall(broken, "send", {
			conversationRef: TARGET,
			content: [{ type: "image", resource: resource(path) }],
		});
		expect(result.status).toBe("failed");
		expect(result.details).toMatchObject({ effect: "not_started" });
		const controller = new AbortController();
		controller.abort();
		expect((await speak([{ type: "audio", resource: resource(path) }], controller.signal)).status).toBe("cancelled");
		expect(calls).toHaveLength(0);
	});
	it("avatar uses own staged file and durable operation", async () => {
		const path = file("avatar.png");
		const result = await handleQqCall(deps, "profile", { action: "set_avatar", avatarPath: path });
		expect(result.status).toBe("succeeded");
		expect(calls[0]!.action).toBe("set_qq_avatar");
		const copy = fileURLToPath(calls[0]!.params.file as string);
		expect(copy).not.toBe(path);
		expect(readFileSync(copy, "utf8")).toBe("media bytes");
	});
	it("config accepts absolute roots and rejects malformed media roots", () => {
		const configPath = join(dir, "config.json");
		const base = {
			connection: { url: "ws://127.0.0.1:1", accessToken: "test" },
			selfId: SELF,
			deployment: { grants: [] },
		};
		writeFileSync(configPath, JSON.stringify({ ...base, media: { allowedRoots: [root] } }));
		expect(loadQqWorldConfig(configPath)).toMatchObject({ ok: true, config: { media: { allowedRoots: [root] } } });
		for (const media of [{ allowedRoots: ["relative"] }, { allowedRoots: "C:/" }, null]) {
			writeFileSync(configPath, JSON.stringify({ ...base, media }));
			expect(loadQqWorldConfig(configPath).ok).toBe(false);
		}
	});
});
