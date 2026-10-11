import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleObserve, handleQqCall as runQqCall, type QqAppDeps } from "../.uina/worlds/qq/src/app.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { OperationLog } from "../.uina/worlds/qq/src/operation-log.js";
import { AttentionModel } from "../.uina/worlds/qq/src/attention.js";
import { ConversationLocks } from "../.uina/worlds/qq/src/conversation-lock.js";
import type { DeploymentGrants } from "../.uina/worlds/qq/src/grants.js";
import type {
	QqTransport,
	TransportCallOutcome,
	TransportEventHandler,
	TransportStatusHandler,
} from "../.uina/worlds/qq/src/transport.js";

function handleQqCall(
	deps: QqAppDeps,
	action: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): ReturnType<typeof runQqCall> {
	return runQqCall(deps, action, params, signal);
}

const SELF = "10001";

/** 假 transport：脚本化回执 + 调用计数（G2 的"SDK 写调用 0 次"硬断言）。 */
class FakeTransport implements QqTransport {
	calls: { action: string; params: Record<string, unknown> }[] = [];
	script: (action: string, params: Record<string, unknown>) => TransportCallOutcome = () => ({
		status: "ok",
		data: {},
	});
	private eventHandlers = new Set<TransportEventHandler>();

	call(action: string, params: Record<string, unknown> = {}): Promise<TransportCallOutcome> {
		this.calls.push({ action, params });
		return Promise.resolve(this.script(action, params));
	}
	start(): Promise<{ selfId: number }> {
		return Promise.resolve({ selfId: Number(SELF) });
	}
	stop(): Promise<void> {
		return Promise.resolve();
	}
	onEvent(handler: TransportEventHandler): () => void {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}
	onRaw(): () => void {
		return () => {};
	}
	onStatus(_handler: TransportStatusHandler): () => void {
		return () => {};
	}
	async emit(event: unknown): Promise<void> {
		for (const handler of this.eventHandlers) handler(event);
	}
}

interface SetupOptions {
	grants?: string[];
}

function setup(options: SetupOptions = {}) {
	const dir = mkdtempSync(join(tmpdir(), "uina-qq-app-"));
	const journal = new FactsJournal({ dataDir: dir, selfId: SELF });
	journal.recover();
	const control = new ControlStore({ dataDir: dir, selfId: SELF });
	control.load();
	const ops = new OperationLog({ dataDir: dir, selfId: SELF });
	ops.recover();
	ops.seedCounterFromExisting();
	const transport = new FakeTransport();
	const grants: DeploymentGrants = {
		grants: (options.grants ?? [
			"observation",
			"messaging",
			"interaction",
			"attention.manage",
			"follow_up.manage",
			"requests.respond",
			"profile.modify",
			"messages.retract",
		]) as DeploymentGrants["grants"],
	};
	const deps = {
		selfId: SELF,
		grants,
		journal,
		control,
		ops,
		transport,
		attention: new AttentionModel({ control }),
		locks: new ConversationLocks(),
	};
	const close = () => rmSync(dir, { recursive: true, force: true });
	return { deps, journal, control, ops, transport, close };
}

describe("G2 部署边界：grant 外拒绝且平台调用为 0", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup({ grants: ["observation", "messaging"] });
	});
	afterEach(() => ctx.close());

	it("requests respond 未授 → 0 平台调用", async () => {
		const result = await handleQqCall(ctx.deps, "requests", {
			action: "respond",
			requestRef: `r1`,
			decision: "accept",
		});
		expect(result.status).toBe("failed");
		expect(ctx.transport.calls).toHaveLength(0);
	});

	it("interact 未授（只给 messaging）→ 0 平台调用", async () => {
		const noInteraction = setup({ grants: ["messaging"] });
		try {
			const result = await handleQqCall(noInteraction.deps, "interact", {
				action: "poke",
				conversationRef: `g30003`,
				userRef: `u20002`,
			});
			expect(result.status).toBe("failed");
			expect(noInteraction.transport.calls).toHaveLength(0);
		} finally {
			noInteraction.close();
		}
	});
});

describe("G3 目标定位与语义拒绝", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
		// 预置一条属于 private:20002 的入站消息
		ctx.journal.appendMessage({
			ref: `m42`,
			conversationRef: `p20002`,
			senderRef: `u20002`,
			senderDisplayName: "小明",
			direction: "in",
			time: "2026-10-07T14:58:00+08:00",
			segments: [{ type: "text", text: "好，不着急。" }],
			source: "platform",
		});
	});
	afterEach(() => ctx.close());

	it("reply 属主不属于目标会话 → reply_target_mismatch", async () => {
		// 预置另一会话消息
		ctx.journal.appendMessage({
			ref: `m77`,
			conversationRef: `p30001`,
			senderRef: `u30001`,
			senderDisplayName: "别人",
			direction: "in",
			time: "2026-10-07T15:00:00+08:00",
			segments: [{ type: "text", text: "hi" }],
			source: "platform",
		});
		const result = await handleQqCall(ctx.deps, "send", {
			conversationRef: `p20002`,
			replyTo: `m77`,
			content: [{ type: "text", text: "你好" }],
		});
		expect(result.status).toBe("failed");
		expect((result.details as { reason?: string } | undefined)?.reason).toBe("reply_target_mismatch");
		expect(ctx.transport.calls).toHaveLength(0);
	});

	it("私聊消息 reaction → unsupported_target，不外推", async () => {
		const result = await handleQqCall(ctx.deps, "interact", {
			action: "react",
			messageRef: `m42`,
			reactionCode: "128077",
		});
		expect(result.status).toBe("failed");
		expect((result.details as { reason?: string } | undefined)?.reason).toBe("unsupported_target");
		expect(ctx.transport.calls).toHaveLength(0);
	});
});

describe("G6 未知结果：写超时 unknown 不重发", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});
	afterEach(() => ctx.close());

	it("超时 → unknown + operationRef；不自动重发；intent 先于平台调用落盘", async () => {
		ctx.transport.script = () => ({
			status: "failed",
			reason: "SnowLuma WebSocket request timed out after 200ms",
			kind: "timeout",
		});
		const result = await handleQqCall(ctx.deps, "send", {
			conversationRef: `p20002`,
			content: [{ type: "text", text: "hi" }],
		});
		expect(result.status).toBe("unknown");
		expect(String(result.result)).toContain("operationRef=");
		expect(String(result.result)).toContain("不自动重发");
		// 平台调用恰好一次（没有重发）
		expect(ctx.transport.calls).toHaveLength(1);
		// intent 已落盘
		expect(ctx.ops.listUnknown()).toHaveLength(1);
	});

	it("平台明确拒绝 → failed（不夸大为 unknown）", async () => {
		ctx.transport.script = () => ({ status: "failed", reason: "retcode=1200", kind: "rejected" });
		const result = await handleQqCall(ctx.deps, "send", {
			conversationRef: `p20002`,
			content: [{ type: "text", text: "hi" }],
		});
		expect(result.status).toBe("failed");
		expect(ctx.ops.get(`o1`)?.outcome).toBe("failed");
	});

	it("发送成功 → succeeded + messageRef + effect=applied", async () => {
		ctx.transport.script = () => ({ status: "ok", data: { message_id: 43 } });
		const result = await handleQqCall(ctx.deps, "send", {
			conversationRef: `p20002`,
			content: [{ type: "text", text: "我把资料整理好了。" }],
		});
		expect(result.status).toBe("succeeded");
		expect(String(result.result)).toContain("messageRef=m43");
		expect(String(result.result)).toContain("effect=applied");
	});
});

describe("remind 积木（follow_up 链路复用）", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});
	afterEach(() => ctx.close());

	it("remind create/resolve 全链路", async () => {
		const created = await handleQqCall(ctx.deps, "remind", {
			action: "create",
			targetRef: `p20002`,
			note: "整理完资料再联系小明",
			reviewAt: "2026-10-07T16:30:00+08:00",
		});
		expect(created.status).toBe("succeeded");
		expect(String(created.result)).toMatch(/ref=f\d+/);
		const ref = String(created.result).match(/ref=(f\S+)/)![1]!;
		const resolved = await handleQqCall(ctx.deps, "remind", {
			action: "resolve",
			remindRef: ref,
			resolution: "完成",
		});
		expect(resolved.status).toBe("succeeded");
	});
});

describe("审查修复回归：在线核验（不盲发）", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});
	afterEach(() => ctx.close());

	it("retract 本地未持有 + 平台查不到 → 明确不可用，0 delete_msg 调用", async () => {
		ctx.transport.script = (action) =>
			action === "get_msg"
				? { status: "failed", reason: "retcode=1400", kind: "rejected" }
				: { status: "ok", data: {} };
		const result = await handleQqCall(ctx.deps, "interact", {
			action: "retract",
			messageRef: `m999`,
		});
		expect(result.status).toBe("failed");
		expect((result.details as { reason?: string } | undefined)?.reason).toBe("message_unaddressable");
		expect(ctx.transport.calls.filter((c) => c.action === "delete_msg")).toHaveLength(0);
	});

	it("retract 平台核验非本人消息 → not_own_message，0 delete_msg 调用", async () => {
		ctx.transport.script = () => ({ status: "ok", data: { message_id: 888, user_id: 20002 } });
		const result = await handleQqCall(ctx.deps, "interact", {
			action: "retract",
			messageRef: `m888`,
		});
		expect((result.details as { reason?: string } | undefined)?.reason).toBe("not_own_message");
		expect(ctx.transport.calls.filter((c) => c.action === "delete_msg")).toHaveLength(0);
	});

	it("retract 平台核验是本人消息 → 正常撤回", async () => {
		ctx.transport.script = (action) =>
			action === "get_msg"
				? { status: "ok", data: { message_id: 889, user_id: Number(SELF) } }
				: { status: "ok", data: {} };
		const result = await handleQqCall(ctx.deps, "interact", {
			action: "retract",
			messageRef: `m889`,
		});
		expect(result.status).toBe("succeeded");
		expect(ctx.transport.calls.filter((c) => c.action === "delete_msg")).toHaveLength(1);
	});

	it("replyTo 本地未持有 + 平台核验归属一致 → 放行发送", async () => {
		ctx.transport.script = (action) =>
			action === "get_msg"
				? { status: "ok", data: { message_id: 42, user_id: 20002 } }
				: { status: "ok", data: { message_id: 51 } };
		const result = await handleQqCall(ctx.deps, "send", {
			conversationRef: `p20002`,
			replyTo: `m42`,
			content: [{ type: "text", text: "看到了" }],
		});
		expect(result.status).toBe("succeeded");
	});

	it("replyTo 平台核验归属不一致 → reply_target_mismatch，0 发送调用", async () => {
		ctx.transport.script = () => ({ status: "ok", data: { message_id: 42, group_id: 99999 } });
		const result = await handleQqCall(ctx.deps, "send", {
			conversationRef: `g30003`,
			replyTo: `m42`,
			content: [{ type: "text", text: "hi" }],
		});
		expect((result.details as { reason?: string } | undefined)?.reason).toBe("reply_target_mismatch");
		expect(ctx.transport.calls.filter((c) => c.action.startsWith("send_"))).toHaveLength(0);
	});
});

describe("批2 能力：expressions / 卡片与转发展开 / includeMedia", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});
	afterEach(() => ctx.close());

	function appendFact(ref: string, segments: import("../.uina/worlds/qq/src/types.js").MessageSegment[]): void {
		ctx.journal.appendMessage({
			ref: `m${ref}`,
			conversationRef: `g30003`,
			senderRef: `u20002`,
			senderDisplayName: "小明",
			direction: "in",
			time: "2026-10-07T15:00:00+08:00",
			segments,
			source: "platform",
		});
	}

	it("expressions：query 走 search_sys_faces，只回数字编码并给出 face/text 指引", async () => {
		let faces = [
			{ q_sid: "14", q_des: "微笑", emoji_name_alias: ["呲牙"], is_super: false },
			{ q_sid: "😀", q_des: "emoji grin", emoji_name_alias: [], is_super: false },
		];
		ctx.transport.script = (action) => {
			if (action === "search_sys_faces") {
				return {
					status: "ok",
					data: {
						faces,
					},
				};
			}
			return { status: "failed", reason: `unexpected action ${action}`, kind: "rejected" as const };
		};
		const malformed = await handleObserve(ctx.deps, { scope: "expressions", kind: "face", query: "微笑" });
		expect(malformed.status).toBe("failed");
		expect(malformed.details).toMatchObject({ reason: "malformed_response" });
		faces = faces.slice(0, 1);
		const result = await handleObserve(ctx.deps, { scope: "expressions", kind: "face", query: "微笑" });
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain("id=14");
		expect(text).toContain("只接受");
		expect(text).toContain("数字编码");
	});

	it("expressions：无 query 走 fetch_sys_faces 并按 limit 分页", async () => {
		ctx.transport.script = (action) => {
			if (action === "fetch_sys_faces") {
				return {
					status: "ok",
					data: {
						packs: [
							{
								pack_name: "经典",
								emojis: Array.from({ length: 60 }, (_, i) => ({
									q_sid: String(i + 1),
									q_des: `表情${i + 1}`,
									emoji_name_alias: [],
									is_super: false,
								})),
							},
						],
					},
				};
			}
			return { status: "failed", reason: `unexpected action ${action}`, kind: "rejected" as const };
		};
		const result = await handleObserve(ctx.deps, { scope: "expressions", kind: "face", limit: 10 });
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect((result.details as { count?: number } | undefined)?.count).toBe(10);
		expect(result.details).toMatchObject({ total: 60, hasMore: true });
		const ids = [...text.matchAll(/^id=(\d+) \|/gm)].map((match) => Number(match[1]));
		let cursor = (result.details as { nextCursor?: string }).nextCursor;
		while (cursor) {
			const page = await handleObserve(ctx.deps, { scope: "expressions", kind: "face", limit: 10, cursor });
			expect(page.status).toBe("succeeded");
			ids.push(...[...String(page.result).matchAll(/^id=(\d+) \|/gm)].map((match) => Number(match[1])));
			cursor = (page.details as { nextCursor?: string }).nextCursor;
		}
		expect(ids).toHaveLength(60);
		expect(new Set(ids).size).toBe(60);
		expect(ids[0]).toBe(1);
		expect(ids.at(-1)).toBe(60);
	});

	it("json 卡片：browse 点查呈现卡片原文前缀，不再是未知分段", async () => {
		appendFact("61", [{ type: "json", data: '{"alert":{"title":"分享标题"}}' }]);
		const result = await handleQqCall(ctx.deps, "browse", {
			messageRefs: [`m61`],
		});
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain("[卡片]");
		expect(text).toContain("分享标题");
	});

	it("合并转发：browse contentTarget 命中 forward 段时 get_forward_msg 一层展开；空名片回落昵称", async () => {
		appendFact("62", [{ type: "forward", resId: "res-1" }]);
		ctx.transport.script = (action) => {
			if (action === "get_forward_msg") {
				return {
					status: "ok",
					data: {
						messages: [
							{
								sender: { user_id: 20002, nickname: "真实昵称", card: "" },
								message: [{ type: "text", data: { text: "转发里的内容" } }],
							},
						],
					},
				};
			}
			return { status: "failed", reason: `unexpected action ${action}`, kind: "rejected" as const };
		};
		const result = await handleQqCall(ctx.deps, "browse", {
			contentTarget: { messageRef: `m62` },
		});
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain("合并转发");
		expect(text).toContain("真实昵称");
		expect(text).toContain("转发里的内容");
	});

	it("合并转发：contentTarget 预览分页并提供 nextCursor", async () => {
		appendFact("64", [{ type: "forward", resId: "res-2" }]);
		ctx.transport.script = (action) => {
			if (action === "get_forward_msg") {
				return {
					status: "ok",
					data: {
						messages: Array.from({ length: 35 }, (_, i) => ({
							sender: { user_id: 20000 + i, nickname: `成员${i}` },
							message: [{ type: "text", data: { text: `第 ${i} 条` } }],
						})),
					},
				};
			}
			return { status: "failed", reason: `unexpected action ${action}`, kind: "rejected" as const };
		};
		const result = await handleQqCall(ctx.deps, "browse", {
			contentTarget: { messageRef: `m64` },
		});
		const text = String(result.result);
		expect(text).toContain("20/35");
		expect(text).toContain('"cursor":');
	});

	it("includeMedia：read 抓取 image 段并附加 base64；失败逐条列出不阻断", async () => {
		appendFact("63", [
			{
				type: "image",
				mediaRef: `a1`,
				url: "https://example.test/a.png",
				fileName: "a.png",
				understood: false,
			},
		]);
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
		const fetchMock = async (url: string | URL | Request): Promise<Response> => {
			if (String(url) === "https://example.test/a.png") {
				return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
			}
			return new Response("gone", { status: 404 });
		};
		vi.stubGlobal("fetch", fetchMock);
		try {
			const result = await handleQqCall(ctx.deps, "read", {
				conversationRef: `g30003`,
				includeMedia: true,
			});
			expect(result.status).toBe("succeeded");
			expect(String(result.result)).toContain("media=请求展开 1 张：成功 1，失败 0");
			const images = (result as { images?: { data: string; mimeType: string }[] }).images;
			expect(images).toHaveLength(1);
			expect(images?.[0]?.mimeType).toBe("image/png");
			expect(images?.[0]?.data.length).toBeGreaterThan(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("平台参数路由修复回归", () => {
	it("respond_request 群邀请 sub_type=invite，加群申请 sub_type=add", async () => {
		const ctx = setup();
		try {
			ctx.journal.appendRequest({
				ref: `r1`,
				platformFlag: "flag-invite",
				kind: "group_invite",
				state: "pending",
				requesterRef: `u20002`,
				requesterDisplayName: null,
				targetConversationRef: `g30003`,
				comment: null,
				time: "2026-10-08T03:00:00Z",
			});
			await handleQqCall(ctx.deps, "requests", {
				action: "respond",
				requestRef: `r1`,
				decision: "accept",
			});
			expect(ctx.transport.calls[0]).toMatchObject({
				action: "set_group_add_request",
				params: { flag: "flag-invite", approve: true, sub_type: "invite" },
			});
			ctx.journal.appendRequest({
				ref: `r2`,
				platformFlag: "flag-join",
				kind: "group_join_request",
				state: "pending",
				requesterRef: `u20003`,
				requesterDisplayName: null,
				targetConversationRef: `g30003`,
				comment: "求加",
				time: "2026-10-08T03:01:00Z",
			});
			await handleQqCall(ctx.deps, "requests", {
				action: "respond",
				requestRef: `r2`,
				decision: "accept",
			});
			expect(ctx.transport.calls[1]).toMatchObject({
				action: "set_group_add_request",
				params: { sub_type: "add" },
			});
		} finally {
			ctx.close();
		}
	});
});

describe("审查修复回归（批次6）：requests 过滤与分页（内部 observe 入口）", () => {
	it("requests.kind 过滤 + limit 分页（显式 nextCursor）", async () => {
		const ctx = setup();
		try {
			ctx.journal.appendRequest({
				ref: `r1`,
				platformFlag: "k1",
				kind: "friend",
				state: "pending",
				requesterRef: `u20002`,
				requesterDisplayName: null,
				comment: null,
				time: "2026-10-08T03:00:00Z",
			});
			ctx.journal.appendRequest({
				ref: `r2`,
				platformFlag: "k2",
				kind: "group_invite",
				state: "pending",
				requesterRef: `u20003`,
				requesterDisplayName: null,
				targetConversationRef: `g30003`,
				comment: null,
				time: "2026-10-08T03:01:00Z",
			});
			const filtered = await handleObserve(ctx.deps, { scope: "requests", kind: "group_invite" });
			expect(String(filtered.result)).toContain("r2");
			expect(String(filtered.result)).not.toContain("r1");
			const limited = await handleObserve(ctx.deps, { scope: "requests", state: "all", limit: 1 });
			expect(String(limited.result)).toContain('"cursor":');
			const second = await handleObserve(ctx.deps, {
				scope: "requests",
				state: "all",
				limit: 1,
				cursor: (limited.details as { nextCursor: string }).nextCursor,
			});
			expect(String(second.result)).toContain("r2 | kind=group_invite");
			expect(String(second.result)).not.toContain("r1 |");
			expect(second.details).toMatchObject({ count: 1, total: 2, hasMore: false });
		} finally {
			ctx.close();
		}
	});

	it("set_profile 多字段非原子：第二字段失败保留已确认部分，不整包重试", async () => {
		const ctx = setup();
		try {
			ctx.transport.script = (action) =>
				action === "set_self_longnick"
					? { status: "failed", reason: "BAD_REQUEST", kind: "rejected" }
					: { status: "ok", data: {} };
			const result = await handleQqCall(ctx.deps, "profile", {
				action: "set_profile",
				nickname: "新昵称",
				signature: "新签名",
			});
			expect(result.status).toBe("failed");
			expect(String(result.result)).toContain('已确认部分：nickname="新昵称"');
			expect(String(result.result)).toContain("不整包重试");
			// 两次平台调用都发生（nickname 成功、signature 失败），不重发 nickname
			expect(ctx.transport.calls.map((c) => c.action)).toEqual(["set_qq_profile", "set_self_longnick"]);
		} finally {
			ctx.close();
		}
	});
});
