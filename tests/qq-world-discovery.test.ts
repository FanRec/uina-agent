import { createHash } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileReference } from "../.uina/worlds/qq/src/discovery.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { createQqWorld } from "../.uina/worlds/qq/src/index.js";
import type { QqTransport } from "../.uina/worlds/qq/src/transport.js";
import type { ExtensionAPI } from "../src/extensions/index.js";
import activateWorkspace from "../src/extensions/workspace-tools/index.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import { createWorldTool } from "../src/extensions/world-framework/world-tool.js";
import { ToolBroker } from "../src/tools/broker.js";

const SELF = "10001";
const closers: (() => Promise<void>)[] = [];
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), createWriteStream: vi.fn(actual.createWriteStream) };
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.mocked(fs.writeFileSync).mockImplementation(
		(await vi.importActual<typeof import("node:fs")>("node:fs")).writeFileSync,
	);
	vi.mocked(fs.createWriteStream).mockImplementation(
		(await vi.importActual<typeof import("node:fs")>("node:fs")).createWriteStream,
	);
	vi.unstubAllGlobals();
	for (const close of closers.splice(0)) await close();
});

async function fixture(grants = ["observation", "messaging", "interaction"]) {
	const root = mkdtempSync(join(tmpdir(), "uina-qq-discovery-"));
	const calls: { action: string; params: Record<string, unknown> }[] = [];
	let receive: (event: unknown) => void = () => {};
	let script: (action: string, params: Record<string, unknown>) => unknown | Promise<unknown> = (action) =>
		action === "fetch_sys_faces" ? { packs: [] } : [];
	const transport: QqTransport = {
		start: async () => ({ selfId: Number(SELF) }),
		stop: async () => {},
		onEvent: (handler) => {
			receive = handler;
			return () => {
				receive = () => {};
			};
		},
		onRaw: () => () => {},
		onStatus: () => () => {},
		call: async (action, params = {}) => {
			calls.push({ action, params });
			return { status: "ok", data: await script(action, params) };
		},
	};
	const world = createQqWorld({
		transport,
		config: {
			selfId: SELF,
			grants: { grants: grants as never },
			connection: {
				url: "ws://127.0.0.1:1",
				role: "Universal",
				accessToken: "test",
				requestTimeoutMs: 2000,
				reconnect: { retries: 0, minDelayMs: 1, maxDelayMs: 2 },
			},
		},
	});
	const context: ServiceCompanionContext = {
		signal: new AbortController().signal,
		submitInput: async () => {},
		emitEvent: async () => {},
		worldDataDir: root,
	};
	await world.onStart?.(context);
	const broker = new ToolBroker();
	broker.register(createWorldTool(world, { getRuntime: () => ({ definition: world, enabled: true }) }));
	activateWorkspace({ cwd: root, registerTool: (tool) => broker.register(tool) } as ExtensionAPI);
	const dir = join(root, "v2", SELF);
	function saved(): FactsJournal {
		const journal = new FactsJournal({ dataDir: dir, selfId: SELF });
		journal.recover(true);
		return journal;
	}
	function arrive(id: number, segments: unknown[], direction: "in" | "out" = "in", conv = "g30003"): void {
		receive({
			self_id: Number(SELF),
			post_type: direction === "in" ? "message" : "message_sent",
			message_type: conv.startsWith("g") ? "group" : "private",
			...(conv.startsWith("g") ? { group_id: Number(conv.slice(1)) } : {}),
			user_id: direction === "out" ? Number(SELF) : 20002,
			sender: { user_id: direction === "out" ? Number(SELF) : 20002, nickname: "小王" },
			message_id: id,
			time: 1791680400 + id,
			message: segments,
		});
	}
	async function call(action: string, params: Record<string, unknown>, signal?: AbortSignal) {
		return broker.execute(broker.prepare("qq", { action, params }), signal);
	}
	async function restart(): Promise<void> {
		await world.onStop?.(context);
		await world.onStart?.(context);
		calls.length = 0;
	}
	closers.push(async () => {
		await world.onStop?.(context);
		rmSync(root, { recursive: true, force: true });
	});
	calls.length = 0;
	return {
		root,
		dir,
		world,
		context,
		broker,
		transport,
		calls,
		call,
		arrive,
		saved,
		restart,
		script: (handler: typeof script) => {
			script = handler;
		},
	};
}

function details(result: { details?: unknown }): Record<string, any> {
	return result.details as Record<string, any>;
}

function fileResponse(text = "会议纪要\nhello") {
	const bytes = Buffer.from(text);
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(bytes, { headers: { "content-length": String(bytes.length), "content-type": "text/plain" } }),
		),
	);
	return bytes;
}

describe("QQ 发现合同：真实注册、Broker 与字段边界", () => {
	it("审查：表情目录校验或分页失败不污染呈现名称", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "face", data: { id: 14 } }]);
		ctx.script(() => ({ packs: [{ emojis: [{ q_sid: "14", q_des: "错误缓存" }, { q_sid: "bad" }] }] }));
		expect(details(await ctx.call("expressions", {})).reason).toBe("malformed_response");
		expect((await ctx.call("browse", { messageRefs: ["m1"] })).result).not.toContain("错误缓存");
		ctx.script(() => ({ packs: [{ emojis: [{ q_sid: "14", q_des: "错误缓存" }] }] }));
		expect(details(await ctx.call("expressions", { cursor: "invalid" })).reason).toBe("cursor_invalid");
		expect((await ctx.call("browse", { messageRefs: ["m1"] })).result).not.toContain("错误缓存");
	});

	it("审查：平台明确拒绝只表示当前查询被拒绝", async () => {
		const ctx = await fixture();
		ctx.transport.call = async () => ({ status: "failed", kind: "rejected", reason: "denied" });
		expect(details(await ctx.call("people", {})).reason).toBe("platform_denied");
	});
	it("D01/D02 人物重名保留引用，默认好友、成员数组、未知名称与角色", async () => {
		const ctx = await fixture();
		expect(Object.keys(ctx.world.actions)).toHaveLength(14);
		expect(ctx.broker.names().filter((name) => name === "qq")).toEqual(["qq"]);
		ctx.script(() => [
			{ user_id: 22, nickname: "小王" },
			{ user_id: 11, card: "小王", role: "admin" },
			{ user_id: 33 },
		]);
		const result = await ctx.call("people", { scope: "members", conversationRef: "g30003", query: "小王" });
		expect(result.status).toBe("succeeded");
		expect(details(result).items.map((item: any) => item.userRef)).toEqual(["u11", "u22"]);
		expect(details(result).items[1].role).toBeNull();
		expect(ctx.calls[0]).toEqual({ action: "get_group_member_list", params: { group_id: "30003", no_cache: true } });
		const friends = await ctx.call("people", {});
		expect(details(friends).items[2]).toMatchObject({ userRef: "u33", nameUnknown: true });
		ctx.script(() => ({ user_id: 22, nickname: "小王" }));
		expect(details(await ctx.call("people", { scope: "person", userRef: "u22" })).person.userRef).toBe("u22");
		ctx.script(() => ({ user_id: 23 }));
		expect(details(await ctx.call("people", { scope: "person", userRef: "u22" })).reason).toBe("malformed_response");
	});

	it("D03/D04/D05 所有列表可续页，畸形与空数组不同，条件/数据变化明确失效", async () => {
		const ctx = await fixture();
		let rows = [
			{ user_id: 1, nickname: "一" },
			{ user_id: 2, nickname: "二" },
			{ user_id: 3, nickname: "三" },
		];
		ctx.script(() => rows);
		const first = await ctx.call("people", { limit: 1 });
		ctx.arrive(1, [{ type: "text", data: { text: "无关消息" } }]);
		const next = details(first).nextCall;
		expect(details(await ctx.call(next.action, next.params)).items[0].userRef).toBe("u2");
		expect(details(await ctx.call("people", { ...next.params, limit: 2 })).reason).toBe("cursor_invalid");
		rows = rows.slice(1);
		expect(details(await ctx.call(next.action, next.params)).reason).toBe("cursor_stale");
		ctx.script(() => ({}));
		expect(details(await ctx.call("people", {})).reason).toBe("malformed_response");
		ctx.script(() => []);
		expect(details(await ctx.call("people", {}))).toMatchObject({ total: 0, hasMore: false });
	});

	it("D20 表情 face/reaction 编码与模板合法，畸形不能伪空，custom 被 schema 拒绝", async () => {
		const ctx = await fixture();
		ctx.script(() => ({
			packs: [
				{
					emojis: [
						{ q_sid: "14", q_des: "微笑" },
						{ q_sid: "21", q_des: "呲牙" },
					],
				},
			],
		}));
		const result = await ctx.call("expressions", { limit: 1 });
		const template = details(result).items[0].template;
		expect(
			ctx.broker.prepare("qq", { action: template.action, params: { ...template.params, conversationRef: "p20002" } })
				.error,
		).toBeUndefined();
		const next = details(result).nextCall;
		expect(details(await ctx.call(next.action, next.params)).items[0].faceId).toBe("21");
		const reaction = details(await ctx.call("expressions", { kind: "reaction" })).items[0];
		expect(
			ctx.broker.prepare("qq", { action: "interact", params: { ...reaction.template.params, messageRef: "m1" } }).error,
		).toBeUndefined();
		expect(ctx.broker.prepare("qq", { action: "expressions", params: { kind: "custom" } }).error).toBeDefined();
		ctx.script(() => ({}));
		expect(details(await ctx.call("expressions", {})).reason).toBe("malformed_response");
		ctx.script(() => ({ packs: [{ emojis: [{ q_sid: "😀" }] }] }));
		expect(details(await ctx.call("expressions", {})).reason).toBe("malformed_response");
	});

	it("D22 读取授权独立，平台失败明确，本地 search 不需连接或 observation", async () => {
		const ctx = await fixture([]);
		for (const [action, params] of [
			["people", {}],
			["expressions", {}],
			["files", { conversationRef: "g1" }],
			["fetch", { target: { mediaRef: "a1" } }],
		] as const)
			expect(details(await ctx.call(action, params)).reason).toBe("grant_denied");
		expect((await ctx.call("search", { query: "none" })).status).toBe("succeeded");
		expect(ctx.calls).toHaveLength(0);
		const available = await fixture();
		available.transport.call = async () => ({ status: "failed", kind: "not_connected", reason: "offline" });
		expect(details(await available.call("people", {})).reason).toBe("connection_unavailable");
	});
});

describe("QQ 本地检索", () => {
	it("审查：大小写展开不使真实命中的片段变成空正文", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "text", data: { text: `${"İ".repeat(300)}会议` } }]);
		const result = details(await ctx.call("search", { query: "会议" }));
		expect(result.items[0].snippets[0].text).toContain("会议");
		expect(result.items[0].snippets[0].truncated).toBe(true);
	});
	it("审查：epoch 时间按实际时间排序，归档比较不依赖 ISO 字符串形状", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "text", data: { text: "会议" } }]);
		const saved = ctx.saved();
		const fact = saved.getMessage("m1")!;
		saved.appendMessage({ ...fact, ref: "m2", time: "1970-01-01T00:00:00Z" });
		saved.appendMessage({ ...fact, ref: "m3", time: "1969-12-31T23:59:59Z" });
		saved.appendMessage({ ...fact, ref: "m4", time: "invalid" });
		saved.appendMessage({ ...fact, ref: "m5", time: "2026-10-11T08:30:00+08:00" });
		saved.recordArchive("2026-10-11T01:00:00Z");
		await ctx.restart();
		const rows = details(await ctx.call("search", { query: "会议" })).items;
		expect(rows.map((row: any) => row.messageRef)).toEqual(["m1", "m5", "m2", "m3", "m4"]);
		expect(rows.find((row: any) => row.messageRef === "m5").archived).toBe(true);
		expect(rows.find((row: any) => row.messageRef === "m4").time).toBeNull();
	});
	it("D16/D17/D19 来源、字段、撤回、归档、覆盖与书签独立", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [
			{ type: "text", data: { text: "Cafe\u0301 会议纪要" } },
			{ type: "file", data: { name: "纪要.txt", file_id: "f1" } },
		]);
		ctx.arrive(2, [{ type: "json", data: { data: "会议纪要" } }]);
		ctx.arrive(3, [
			{ type: "text", data: { text: "会" } },
			{ type: "text", data: { text: "议纪要" } },
		]);
		ctx.arrive(4, [{ type: "text", data: { text: "会议纪要已发" } }], "out");
		ctx.arrive(5, [{ type: "text", data: { text: "会议纪要" } }], "in", "g44444");
		const before = readFileSync(join(ctx.dir, "qq-facts.jsonl"));
		const result = await ctx.call("search", { query: "会议纪要", conversationRef: "g30003" });
		expect(result.status).toBe("succeeded");
		expect(details(result).items.map((row: any) => row.messageRef)).toEqual(["m4", "m1"]);
		expect(details(result)).toMatchObject({
			source: "local",
			searchableFields: ["text", "fileName"],
			coverage: { platformCompleteness: "unknown" },
		});
		expect(details(await ctx.call("search", { query: "CAFÉ" })).total).toBe(1);
		expect(details(await ctx.call("search", { query: "纪要.txt", senderRef: "u20002", direction: "in" })).total).toBe(
			1,
		);
		expect(readFileSync(join(ctx.dir, "qq-facts.jsonl"))).toEqual(before);
		expect(ctx.calls).toHaveLength(0);
		expect((await ctx.call("search", { query: "missing" })).result).toContain("本地已收录历史");
		expect(
			ctx.broker.prepare("qq", { action: "search", params: { query: "x", source: "platform" } }).error,
		).toBeDefined();
	});

	it("D18 命中集变化 stale，非命中到达和消费推进不影响分页", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "text", data: { text: "会议" } }]);
		ctx.arrive(2, [{ type: "text", data: { text: "会议" } }]);
		const first = details(await ctx.call("search", { query: "会议", limit: 1 }));
		ctx.arrive(3, [{ type: "text", data: { text: "不匹配" } }]);
		await ctx.call("skip", { conversationRef: "g30003" });
		expect(details(await ctx.call(first.nextCall.action, first.nextCall.params)).items[0].messageRef).toBe("m1");
		ctx.arrive(4, [{ type: "text", data: { text: "会议" } }]);
		expect(details(await ctx.call(first.nextCall.action, first.nextCall.params)).reason).toBe("cursor_stale");
	});

	it("时间范围有时区且为 [since,until)，禁止空词和倒置范围", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "text", data: { text: "会议" } }]);
		const time = ctx.saved().getMessage("m1")!.time;
		expect(details(await ctx.call("search", { query: "会议", since: time })).total).toBe(1);
		expect(details(await ctx.call("search", { query: "会议", until: time })).total).toBe(0);
		for (const params of [
			{ query: " " },
			{ query: "x", since: "2026-10-11T00:00:00" },
			{ query: "x", since: time, until: time },
		])
			expect(details(await ctx.call("search", params)).reason).toBe("invalid_params");
	});
});

describe("QQ 群目录与资源取得", () => {
	it("审查：文件流写盘失败明确归属本地存储，清理临时目录", async () => {
		const ctx = await fixture();
		fileResponse();
		ctx.arrive(1, [{ type: "file", data: { name: "doc.txt", url: "https://fixture.invalid/" } }]);
		vi.mocked(fs.createWriteStream).mockImplementation(
			() =>
				new Writable({
					write(_chunk, _encoding, callback) {
						callback(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
					},
				}) as fs.WriteStream,
		);
		expect(details(await ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } })).reason).toBe(
			"storage_failed",
		);
		expect(readdirSync(join(ctx.dir, "downloads"))).toEqual([]);
	});
	it("审查：下载超时覆盖 URL 刷新，迟到的刷新不提交定位", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "file", data: { name: "doc.txt", file_id: "f1", url: "https://old.invalid/" } }]);
		let finish!: (value: unknown) => void;
		let begin!: () => void;
		const refreshing = new Promise<void>((resolve) => {
			begin = resolve;
		});
		ctx.script(
			() =>
				new Promise((resolve) => {
					finish = resolve;
					begin();
				}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 403 })),
		);
		vi.useFakeTimers();
		const before = readFileSync(join(ctx.dir, "qq-facts.jsonl"));
		const pending = ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } });
		await refreshing;
		await vi.advanceTimersByTimeAsync(2001);
		finish({
			message_id: 1,
			message_type: "group",
			group_id: 30003,
			time: 1791680401,
			sender: { user_id: 20002 },
			message: [{ type: "file", data: { name: "doc.txt", file_id: "f1", url: "https://new.invalid/" } }],
		});
		expect(details(await pending).reason).toBe("download_timeout");
		expect(readFileSync(join(ctx.dir, "qq-facts.jsonl"))).toEqual(before);
		expect(existsSync(join(ctx.dir, "downloads"))).toBe(false);
	});
	it("审查：按消息分段拉取复用已刷新证据，不把 URL 回退到到达时的旧值", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "file", data: { name: "doc.txt", file_id: "f1", url: "https://old.invalid/" } }]);
		ctx.script(() => ({
			message_id: 1,
			message_type: "group",
			group_id: 30003,
			time: 1791680401,
			sender: { user_id: 20002 },
			message: [{ type: "file", data: { name: "doc.txt", file_id: "f1", url: "https://new.invalid/" } }],
		}));
		const download = vi.fn(async (url: string) =>
			url === "https://old.invalid/" ? new Response(null, { status: 403 }) : new Response("new"),
		);
		vi.stubGlobal("fetch", download);
		const target = { messageRef: "m1", segmentIndex: 0 };
		expect((await ctx.call("fetch", { target })).status).toBe("succeeded");
		const before = readFileSync(join(ctx.dir, "qq-facts.jsonl"));
		ctx.calls.length = 0;
		download.mockClear();
		expect((await ctx.call("fetch", { target })).status).toBe("succeeded");
		expect(download.mock.calls.map(([url]) => url)).toEqual(["https://new.invalid/"]);
		expect(ctx.calls).toHaveLength(0);
		expect(readFileSync(join(ctx.dir, "qq-facts.jsonl"))).toEqual(before);
	});

	it("审查：缺少私聊 hash 时不猜通用 get_file 路线", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "file", data: { name: "doc.txt", file_id: "f1" } }], "in", "p20002");
		ctx.script(() => ({ url: "https://fixture.invalid/file" }));
		const download = vi.fn();
		vi.stubGlobal("fetch", download);
		expect(details(await ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } })).reason).toBe(
			"locator_unavailable",
		);
		expect(ctx.calls).toHaveLength(0);
		expect(download).not.toHaveBeenCalled();
	});

	it("审查：缺失消息点查前核验绑定身份，不下载也不写定位", async () => {
		const ctx = await fixture();
		ctx.transport.snapshot = () => ({
			connected: true,
			identityVerified: true,
			selfId: "99999",
			observedAt: "now",
			lastError: null,
		});
		const before = readFileSync(join(ctx.dir, "qq-facts.jsonl"));
		expect(details(await ctx.call("fetch", { target: { messageRef: "m77", segmentIndex: 0 } })).reason).toBe(
			"identity_unverified",
		);
		expect(ctx.calls).toHaveLength(0);
		expect(readFileSync(join(ctx.dir, "qq-facts.jsonl"))).toEqual(before);
	});

	it("审查：消息刷新不得替换已知附件定位", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "image", data: { file: "original.jpg", url: "https://old.invalid/" } }]);
		ctx.script(() => ({
			message_id: 1,
			message_type: "group",
			group_id: 30003,
			time: 1791680401,
			sender: { user_id: 20002 },
			message: [{ type: "image", data: { file: "replacement.jpg", url: "https://new.invalid/" } }],
		}));
		const download = vi.fn(async () => new Response(null, { status: 403 }));
		vi.stubGlobal("fetch", download);
		const before = readFileSync(join(ctx.dir, "qq-facts.jsonl"));
		expect(details(await ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } })).reason).toBe(
			"resource_unavailable",
		);
		expect(download).toHaveBeenCalledTimes(1);
		expect(readFileSync(join(ctx.dir, "qq-facts.jsonl"))).toEqual(before);
	});

	it("审查：转发同一位置替换附件时保留旧引用，分配新引用", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "forward", data: { id: "forward1" } }]);
		let fileId = "old";
		ctx.script(() => ({
			messages: [
				{
					content: [
						{ type: "file", data: { file_id: fileId, name: "same.txt", url: `https://fixture.invalid/${fileId}` } },
					],
				},
			],
		}));
		const call = { contentTarget: { messageRef: "m1", segmentIndex: 0 } };
		const oldRef = details(await ctx.call("browse", call)).mediaTargets[0].mediaRef;
		fileId = "new";
		const newRef = details(await ctx.call("browse", call)).mediaTargets[0].mediaRef;
		expect(newRef).not.toBe(oldRef);
		await ctx.restart();
		expect(ctx.saved().getMedia(oldRef)?.locator?.fileId).toBe("old");
		expect(ctx.saved().getMedia(newRef)?.locator?.fileId).toBe("new");
	});
	it("D06/D07 文件夹/文件引用跨重启解析，目录不递归，畸形/截断/跨账号明确失败", async () => {
		const ctx = await fixture();
		ctx.script(() => ({
			files: [{ file_id: "f1", file_name: "纪要.txt", file_size: 12, busid: 102 }],
			folders: [{ folder_id: "dir1", folder_name: "资料" }],
		}));
		const first = details(await ctx.call("files", { conversationRef: "g30003", limit: 1 }));
		expect(first.items[0].kind).toBe("folder");
		const folderRef = first.items[0].folderRef;
		expect((await ctx.call("files", { conversationRef: "g30003", folderRef })).status).toBe("succeeded");
		expect(ctx.calls.at(-1)).toEqual({
			action: "get_group_files_by_folder",
			params: { group_id: "30003", folder_id: "dir1" },
		});
		expect(details(await ctx.call("files", { conversationRef: "g44444", folderRef })).reason).toBe("account_mismatch");
		const wrong = fileReference("folder", { account: "99999", conversationRef: "g30003", folderId: "dir1" });
		expect(details(await ctx.call("files", { conversationRef: "g30003", folderRef: wrong })).reason).toBe(
			"account_mismatch",
		);
		expect(
			ctx.broker.prepare("qq", { action: "files", params: { conversationRef: "g30003", action: "delete" } }).error,
		).toBeDefined();
		const second = details(await ctx.call(first.nextCall.action, first.nextCall.params));
		expect(second.items[0].nextCall.action).toBe("fetch");
		expect(second.coverage.directoryComplete).toBeNull();
		ctx.script(() => ({}));
		expect(details(await ctx.call("files", { conversationRef: "g30003" })).reason).toBe("malformed_response");
		ctx.script(() => ({ files: [], folders: [], has_more: true }));
		expect(details(await ctx.call("files", { conversationRef: "g30003" })).reason).toBe("directory_incomplete");
	});

	it("D08/D13/D14/D15 群文件→fetch→真实 read_file，并验证 send 参数与文件根拒绝", async () => {
		const ctx = await fixture();
		const bytes = fileResponse();
		ctx.script((action) =>
			action === "get_group_file_url"
				? { url: "http://fixture.invalid/resource" }
				: { files: [{ file_id: "f1", file_name: "origin.json", file_size: bytes.length }], folders: [] },
		);
		const file = details(await ctx.call("files", { conversationRef: "g30003" })).items[0];
		const result = await ctx.call(file.nextCall.action, file.nextCall.params);
		expect(result.status).toBe("succeeded");
		const resource = details(result).resource;
		expect(details(result)).toMatchObject({
			source: "platform",
			sizeBytes: bytes.length,
			integrity: "transport_checked",
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
		const read = await ctx.broker.execute(ctx.broker.prepare("read_file", { path: resource.path }));
		expect(read.status).toBe("succeeded");
		expect(read.result).toContain("会议纪要");
		expect(
			ctx.broker.prepare("qq", {
				action: "send",
				params: { conversationRef: "p20002", content: [{ type: "file", path: resource.path }] },
			}).error,
		).toBeUndefined();
		expect(ctx.calls.every((call) => call.action.startsWith("get_"))).toBe(true);
		const original = readFileSync(resource.path);
		await ctx.restart();
		expect(readFileSync(resource.path)).toEqual(original);
		expect((await ctx.call(file.nextCall.action, file.nextCall.params)).status).toBe("succeeded");
	});

	it("D08 文件消失或同名替换不下载，畸形/过期文件引用失败", async () => {
		const ctx = await fixture();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const ref = fileReference("file", { account: SELF, conversationRef: "g30003", folderId: null, fileId: "old" });
		ctx.script(() => ({ files: [{ file_id: "new", file_name: "same.txt" }], folders: [] }));
		expect(details(await ctx.call("fetch", { target: { fileRef: ref } })).reason).toBe("resource_unavailable");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(details(await ctx.call("fetch", { target: { fileRef: "qfile:v1:e30" } })).reason).toBe("invalid_reference");
	});

	it("D09/D10 私聊定位字段回放；平台本地路径不冒充资源", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "file", data: { name: "doc.txt", file_id: "f1", file_hash: "hash1" } }], "in", "p20002");
		const ref = ctx.saved().getMessage("m1")!.segments[0];
		expect(ref).toMatchObject({ locator: { fileId: "f1", fileHash: "hash1" } });
		ctx.script(() => ({ file: "C:\\platform-only\\doc.txt" }));
		expect(details(await ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } })).reason).toBe(
			"resource_unavailable",
		);
		expect(ctx.calls.at(-1)).toEqual({
			action: "get_private_file_url",
			params: { user_id: "20002", file_id: "f1", file_hash: "hash1" },
		});
		expect(existsSync(join(ctx.dir, "downloads"))).toBe(false);
	});

	it("D09 过期 URL 最多刷新一次，读取补充定位不制造 received/dispatched", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "file", data: { name: "doc.txt", file_id: "f1", url: "https://old.invalid" } }]);
		const fact = ctx.saved().getMessage("m1")!;
		ctx.script(() => ({
			message_id: 1,
			self_id: 10001,
			message_type: "group",
			group_id: 30003,
			time: 1791680401,
			sender: { user_id: 20002 },
			message: [{ type: "file", data: { name: "doc.txt", file_id: "f1", url: "https://new.invalid" } }],
		}));
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 403 }))
			.mockResolvedValueOnce(new Response("new"));
		vi.stubGlobal("fetch", fetchSpy);
		const result = await ctx.call("fetch", { target: { mediaRef: (fact.segments[0] as any).mediaRef } });
		expect(result.status).toBe("succeeded");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(ctx.saved().snapshot.messages.get("g30003")).toHaveLength(1);
		expect(ctx.saved().snapshot.dispatchedThrough.size).toBe(0);
		expect(ctx.saved().getMedia((fact.segments[0] as any).mediaRef)?.url).toBe("https://new.invalid");
	});

	it("D11 长度不符、目录写入失败不发布半文件", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "file", data: { name: "doc.txt", url: "https://fixture.invalid" } }]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("short", { headers: { "content-length": "100" } })),
		);
		expect(details(await ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } })).reason).toBe(
			"integrity_mismatch",
		);
		expect(readdirSync(join(ctx.dir, "downloads"))).toEqual([]);
		rmdirSync(join(ctx.dir, "downloads"));
		writeFileSync(join(ctx.dir, "downloads"), "blocked");
		fileResponse();
		expect(details(await ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } })).reason).toBe(
			"storage_failed",
		);
	});

	it("D12 stop 取消流式下载，无迟到发布或定位写入", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "file", data: { name: "doc.txt", url: "https://fixture.invalid" } }]);
		let began!: () => void;
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array([1]));
								began();
							},
						}),
					),
			),
		);
		const pending = ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } });
		await started;
		await ctx.world.onStop?.(ctx.context);
		const bytes = readFileSync(join(ctx.dir, "qq-facts.jsonl"));
		expect((await pending).status).toBe("cancelled");
		expect(readFileSync(join(ctx.dir, "qq-facts.jsonl"))).toEqual(bytes);
		expect(existsSync(join(ctx.dir, "downloads")) ? readdirSync(join(ctx.dir, "downloads")) : []).toEqual([]);
	});

	it("D14/D21 平台点查图片→fetch→真实 read_image；不收录为新消息", async () => {
		const ctx = await fixture();
		const bytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=",
			"base64",
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(bytes)),
		);
		ctx.script(() => ({
			self_id: 10001,
			message_id: 77,
			time: 1791680400,
			message_type: "group",
			group_id: 30003,
			sender: { user_id: 20002 },
			message: [{ type: "image", data: { url: "https://fixture.invalid/image", name: "image.png" } }],
		}));
		const fetched = await ctx.call("fetch", { target: { messageRef: "m77", segmentIndex: 0 } });
		expect(fetched.status).toBe("succeeded");
		const read = await ctx.broker.execute(ctx.broker.prepare("read_image", { path: details(fetched).resource.path }));
		expect(read.status).toBe("succeeded");
		expect(read.images?.[0]?.data).toBe(bytes.toString("base64"));
		expect(ctx.saved().snapshot.messages.size).toBe(0);
		expect(details(await ctx.call("search", { query: "image.png" })).total).toBe(0);
		const ref = details(fetched).origin.mediaRef;
		expect(ctx.saved().getMedia(ref)?.origin?.messageRef).toBe("m77");
	});

	it("D14 语音取得原始字节，不伪转写或转码；取消不落定位", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "record", data: { file: "voice.silk" } }]);
		ctx.script(() => ({ url: "https://fixture.invalid/voice" }));
		const bytes = Buffer.from("#!SILK_V3original");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(bytes)),
		);
		const result = await ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } });
		expect(result.status).toBe("succeeded");
		expect(details(result)).toMatchObject({ mediaType: "audio", mimeType: "audio/silk" });
		expect(readFileSync(details(result).resource.path)).toEqual(bytes);
		expect(ctx.calls.at(-1)?.action).toBe("get_record");
		expect(details(result).transcript).toBeUndefined();
		const abort = new AbortController();
		abort.abort();
		const before = readFileSync(join(ctx.dir, "qq-facts.jsonl"));
		expect((await ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } }, abort.signal)).status).toBe(
			"not_started",
		);
		expect(readFileSync(join(ctx.dir, "qq-facts.jsonl"))).toEqual(before);
	});

	it("D11 HTTP 实际字节流与元数据提交失败，不留下半发布资源", async () => {
		const ctx = await fixture();
		const bytes = Buffer.from("真实 HTTP 字节");
		const server = createServer((_request, response) => {
			response.setHeader("Content-Length", bytes.length);
			response.end(bytes);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		closers.push(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const port = (server.address() as { port: number }).port;
		ctx.arrive(1, [{ type: "file", data: { name: "actual.txt", url: `http://127.0.0.1:${port}/resource` } }]);
		const result = await ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } });
		expect(result.status).toBe("succeeded");
		expect(readFileSync(details(result).resource.path)).toEqual(bytes);
		const published = readdirSync(join(ctx.dir, "downloads"));
		const actualWrite = (await vi.importActual<typeof import("node:fs")>("node:fs")).writeFileSync;
		vi.spyOn(fs, "writeFileSync").mockImplementation((path, ...args) => {
			if (String(path).endsWith("origin.json")) throw new Error("disk failure");
			return actualWrite(path, ...args);
		});
		expect(details(await ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } })).reason).toBe(
			"storage_failed",
		);
		expect(readdirSync(join(ctx.dir, "downloads"))).toEqual(published);
	});

	it("D12 平台查询等待时 stop，迟到结果不写定位或下载", async () => {
		const ctx = await fixture();
		let resolve!: (value: unknown) => void;
		ctx.script(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const before = readFileSync(join(ctx.dir, "qq-facts.jsonl"));
		const pending = ctx.call("fetch", { target: { messageRef: "m77", segmentIndex: 0 } });
		await ctx.world.onStop?.(ctx.context);
		resolve({
			message_id: 77,
			time: 1791680400,
			message_type: "group",
			group_id: 30003,
			sender: { user_id: 20002 },
			message: [{ type: "file", data: { name: "doc.txt", url: "https://fixture.invalid" } }],
		});
		expect((await pending).status).toBe("cancelled");
		expect(readFileSync(join(ctx.dir, "qq-facts.jsonl"))).toEqual(before);
		expect(existsSync(join(ctx.dir, "downloads"))).toBe(false);
	});

	it("D13 并行 fetch 形成独立资源，重启后 mediaRef 与副本仍可读取", async () => {
		const ctx = await fixture();
		const bytes = fileResponse();
		ctx.arrive(1, [{ type: "file", data: { name: "same.txt", url: "https://fixture.invalid" } }]);
		const mediaRef = (ctx.saved().getMessage("m1")!.segments[0] as any).mediaRef;
		const [a, b] = await Promise.all([
			ctx.call("fetch", { target: { mediaRef } }),
			ctx.call("fetch", { target: { mediaRef } }),
		]);
		expect(a.status).toBe("succeeded");
		expect(b.status).toBe("succeeded");
		expect(details(a).resource.path).not.toBe(details(b).resource.path);
		await ctx.restart();
		expect(ctx.saved().getMedia(mediaRef)?.origin?.messageRef).toBe("m1");
		expect(readFileSync(details(a).resource.path)).toEqual(bytes);
		expect(readFileSync(details(b).resource.path)).toEqual(bytes);
	});

	it("D15 显式禁止的发送根保持拒绝，fetch 不扩大原配置", async () => {
		const ctx = await fixture();
		fileResponse();
		ctx.arrive(1, [{ type: "file", data: { name: "doc.txt", url: "https://fixture.invalid" } }]);
		const fetched = await ctx.call("fetch", { target: { messageRef: "m1", segmentIndex: 0 } });
		const config = createQqWorld({
			transport: ctx.transport,
			config: {
				selfId: SELF,
				grants: { grants: ["observation", "messaging"] },
				media: { allowedRoots: [] },
				connection: {
					url: "ws://127.0.0.1:1",
					role: "Universal",
					accessToken: "test",
					requestTimeoutMs: 2000,
					reconnect: { retries: 0, minDelayMs: 1, maxDelayMs: 2 },
				},
			},
		});
		await config.onStart?.(ctx.context);
		const tool = createWorldTool(config, { getRuntime: () => ({ definition: config, enabled: true }) });
		const send = await tool.run({
			action: "send",
			params: { conversationRef: "p20002", content: [{ type: "file", path: details(fetched).resource.path }] },
		});
		expect(send.status).toBe("failed");
		expect(ctx.calls.some((call) => call.action.startsWith("send_"))).toBe(false);
		await config.onStop?.(ctx.context);
	});

	it("D17 覆盖风险与封存分别回放，撤回命中仍明确呈现", async () => {
		const ctx = await fixture();
		ctx.arrive(1, [{ type: "text", data: { text: "会议" } }]);
		const saved = ctx.saved();
		saved.recordArchive("2026-10-12T00:00:00Z");
		saved.recordCoverageGap({
			id: "test",
			from: "2026-10-11T00:00:00Z",
			to: "2026-10-11T01:00:00Z",
			reason: "connection",
		});
		saved.appendEvent({
			ref: "e99",
			kind: "recall",
			conversationRef: "g30003",
			messageRef: "m1",
			time: "2026-10-11T01:00:00Z",
			source: "platform",
		});
		await ctx.restart();
		const result = details(await ctx.call("search", { query: "会议" }));
		expect(result.items[0]).toMatchObject({ recalled: true, archived: true });
		expect(result.coverage.gaps).toHaveLength(1);
		expect(result.coverage.archiveBefore).toBe("2026-10-12T00:00:00Z");
	});

	it("D21 转发节点附件提供合法 fetch 引用，重启后不串到其他附件", async () => {
		const ctx = await fixture();
		const bytes = fileResponse();
		ctx.arrive(1, [{ type: "forward", data: { id: "forward1" } }]);
		ctx.script(() => ({
			messages: [
				{
					sender: { user_id: 22, nickname: "小王" },
					content: [{ type: "file", data: { name: "doc.txt", url: "https://fixture.invalid" } }],
				},
			],
		}));
		const browse = await ctx.call("browse", { contentTarget: { messageRef: "m1", segmentIndex: 0 } });
		expect(browse.status).toBe("succeeded");
		const target = details(browse).mediaTargets[0];
		expect(target).toMatchObject({ forwardNodeIndex: 0, nodeSegmentIndex: 0 });
		expect(ctx.broker.prepare("qq", target.nextCall).error).toBeUndefined();
		await ctx.restart();
		const fetched = await ctx.call(target.nextCall.action, target.nextCall.params);
		expect(fetched.status).toBe("succeeded");
		expect(readFileSync(details(fetched).resource.path)).toEqual(bytes);
		expect(ctx.saved().snapshot.messages.get("g30003")).toHaveLength(1);
	});

	it("D19 五个读取动作不改变 focus/push、通知位置或阅读书签", async () => {
		const ctx = await fixture(["observation", "attention.manage"]);
		fileResponse();
		ctx.arrive(1, [{ type: "file", data: { name: "doc.txt", url: "https://fixture.invalid" } }]);
		ctx.script((action) =>
			action === "fetch_sys_faces"
				? { packs: [] }
				: action === "get_group_root_files"
					? { files: [], folders: [] }
					: [],
		);
		await ctx.call("inbox", { focus: ["g30003"], push: { target: "g30003", mode: "off" } });
		const controlPath = readdirSync(ctx.dir).find((name) => name.includes("control"))!;
		const control = readFileSync(join(ctx.dir, controlPath));
		const facts = readFileSync(join(ctx.dir, "qq-facts.jsonl"));
		for (const [action, params] of [
			["people", {}],
			["expressions", {}],
			["files", { conversationRef: "g30003" }],
			["search", { query: "doc" }],
			["fetch", { target: { messageRef: "m1", segmentIndex: 0 } }],
		] as const)
			expect((await ctx.call(action, params)).status).toBe("succeeded");
		expect(readFileSync(join(ctx.dir, controlPath))).toEqual(control);
		expect(readFileSync(join(ctx.dir, "qq-facts.jsonl"))).toEqual(facts);
		expect(ctx.saved().snapshot.dispatchedThrough.size).toBe(0);
	});

	it("D11 定位写盘失败发生在字节拉取前", async () => {
		const ctx = await fixture();
		ctx.script(() => ({
			message_id: 77,
			time: 1791680400,
			message_type: "group",
			group_id: 30003,
			sender: { user_id: 20002 },
			message: [{ type: "file", data: { url: "https://fixture.invalid" } }],
		}));
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		vi.spyOn(FactsJournal.prototype, "saveMediaLocator").mockImplementation(() => {
			throw new Error("disk failure");
		});
		expect(details(await ctx.call("fetch", { target: { messageRef: "m77", segmentIndex: 0 } })).reason).toBe(
			"storage_failed",
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(existsSync(join(ctx.dir, "downloads"))).toBe(false);
	});

	it("D22 绑定身份改变时拒绝查询，search 仍是本地读取", async () => {
		const ctx = await fixture();
		ctx.transport.snapshot = () => ({
			connected: true,
			identityVerified: true,
			selfId: "99999",
			observedAt: new Date().toISOString(),
			lastError: null,
		});
		expect(details(await ctx.call("people", {})).reason).toBe("identity_unverified");
		expect(ctx.calls).toHaveLength(0);
		expect((await ctx.call("search", { query: "none" })).status).toBe("succeeded");
	});

	it("D13 冷启动仅清理自有未发布目录，正式资源保留", async () => {
		const ctx = await fixture();
		const root = join(ctx.dir, "downloads");
		fs.mkdirSync(join(root, ".partial-abc123"), { recursive: true });
		writeFileSync(join(root, ".partial-abc123", "unfinished"), "partial");
		fs.mkdirSync(join(root, "published"));
		writeFileSync(join(root, "published", "file"), "complete");
		await ctx.restart();
		expect(existsSync(join(root, ".partial-abc123"))).toBe(false);
		expect(readFileSync(join(root, "published", "file"), "utf8")).toBe("complete");
	});
});
