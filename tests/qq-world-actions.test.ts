import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleQqCall as runQqCall, type QqAppDeps } from "../.uina/worlds/qq/src/app.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { OperationLog } from "../.uina/worlds/qq/src/operation-log.js";
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
	return runQqCall(deps, action, { account: deps.selfId, ...params }, signal);
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
			"messages.mark_read",
			"groups.leave",
			"contacts.remove",
		]) as DeploymentGrants["grants"],
	};
	const deps = { selfId: SELF, grants, journal, control, ops, transport };
	const close = () => rmSync(dir, { recursive: true, force: true });
	return { deps, journal, control, ops, transport, close };
}

describe("G2 部署边界：grant 外拒绝且平台调用为 0", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup({ grants: ["observation", "messaging"] });
	});
	afterEach(() => ctx.close());

	it("remove_contact 未授 → failed/grant_denied/not_started，0 平台调用", async () => {
		const result = await handleQqCall(ctx.deps, "account", {
			operation: "remove_contact",
			userRef: `u20002`,
		});
		expect(result.status).toBe("failed");
		expect(result.details).toMatchObject({ reason: "grant_denied", effect: "not_started" });
		expect(ctx.transport.calls).toHaveLength(0);
		expect(String(result.result)).toContain("grant_denied");
	});

	it("respond_request 未授 → 0 平台调用", async () => {
		const result = await handleQqCall(ctx.deps, "account", {
			operation: "respond_request",
			requestRef: `r1`,
			decision: "accept",
		});
		expect(result.status).toBe("failed");
		expect(ctx.transport.calls).toHaveLength(0);
	});

	it("gesture 未授（只给 messaging）→ 0 平台调用", async () => {
		const noInteraction = setup({ grants: ["messaging"] });
		try {
			const result = await handleQqCall(noInteraction.deps, "gesture", {
				kind: "poke",
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

	it("跨账号会话 → account_mismatch，0 平台调用", async () => {
		const result = await handleQqCall(ctx.deps, "speak", {
			account: "10099",
			conversationRef: "p20002",
			content: [{ type: "text", text: "你好" }],
		});
		expect(result.status).toBe("failed");
		expect((result.details as { reason?: string } | undefined)?.reason).toBe("account_mismatch");
		expect(ctx.transport.calls).toHaveLength(0);
	});

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
		const result = await handleQqCall(ctx.deps, "speak", {
			conversationRef: `p20002`,
			replyTo: `m77`,
			content: [{ type: "text", text: "你好" }],
		});
		expect(result.status).toBe("failed");
		expect((result.details as { reason?: string } | undefined)?.reason).toBe("reply_target_mismatch");
		expect(ctx.transport.calls).toHaveLength(0);
	});

	it("私聊消息 reaction → unsupported_target，不外推", async () => {
		const result = await handleQqCall(ctx.deps, "gesture", {
			kind: "react",
			messageRef: `m42`,
			reactionCode: "128077",
		});
		expect(result.status).toBe("failed");
		expect((result.details as { reason?: string } | undefined)?.reason).toBe("unsupported_target");
		expect(ctx.transport.calls).toHaveLength(0);
	});

	it("重名成员返回多个候选，不默认选第一个（members scope 交由模型决策）", async () => {
		ctx.transport.script = () => ({
			status: "ok",
			data: {
				member_list: [
					{ user_id: 20002, nickname: "小明", card: "小明（主持人）", role: "admin" },
					{ user_id: 20009, nickname: "小明", card: "明明", role: "member" },
				],
			},
		});
		const result = await handleQqCall(ctx.deps, "observe", {
			scope: "members",
			conversationRef: `g30003`,
			query: "小明",
		});
		expect(result.status).toBe("succeeded");
		expect(String(result.result)).toContain("u20002");
		expect(String(result.result)).toContain("u20009");
	});

	it("members 兼容 SnowLuma 裸数组返回（get_group_member_list 实际形状）", async () => {
		ctx.transport.script = () => ({
			status: "ok",
			data: [
				{ user_id: 20002, nickname: "小明", card: "", role: "admin" },
				{ user_id: 20009, nickname: "阿明", card: "明明", role: "member" },
			],
		});
		const result = await handleQqCall(ctx.deps, "observe", {
			scope: "members",
			conversationRef: `g30003`,
		});
		expect(result.status).toBe("succeeded");
		expect(String(result.result)).toContain("u20002");
		expect(String(result.result)).toContain("u20009");
	});

	it("members 查询失败：不倾倒原始回执，给下一步指引，完整 outcome 进 details", async () => {
		ctx.transport.script = () => ({
			status: "failed",
			reason: "retcode=500",
			kind: "rejected",
		});
		const result = await handleQqCall(ctx.deps, "observe", {
			scope: "members",
			conversationRef: `g30003`,
		});
		expect(result.status).toBe("failed");
		const text = String(result.result);
		expect(text).not.toContain('{"status"');
		expect(text).toContain("下一步");
		expect((result.details as { outcome?: unknown } | undefined)?.outcome).toBeDefined();
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
		const result = await handleQqCall(ctx.deps, "speak", {
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
		const result = await handleQqCall(ctx.deps, "speak", {
			conversationRef: `p20002`,
			content: [{ type: "text", text: "hi" }],
		});
		expect(result.status).toBe("failed");
		expect(ctx.ops.get(`o1`)?.outcome).toBe("failed");
	});

	it("发送成功 → succeeded + messageRef + effect=applied", async () => {
		ctx.transport.script = () => ({ status: "ok", data: { message_id: 43 } });
		const result = await handleQqCall(ctx.deps, "speak", {
			conversationRef: `p20002`,
			content: [{ type: "text", text: "我把资料整理好了。" }],
		});
		expect(result.status).toBe("succeeded");
		expect(String(result.result)).toContain("messageRef=m43");
		expect(String(result.result)).toContain("effect=applied");
	});
});

describe("grant 不创造平台能力（presence 映射未核实）", () => {
	it("set_presence 即使已授 profile.modify 也明确拒绝", async () => {
		const ctx = setup();
		try {
			const result = await handleQqCall(ctx.deps, "account", {
				operation: "set_presence",
				presenceRef: `qq-presence:${SELF}:unverified-choice`,
			});
			expect(result.status).toBe("failed");
			expect((result.details as { reason?: string } | undefined)?.reason).toBe("presence_mapping_unverified");
			expect(ctx.transport.calls).toHaveLength(0);
		} finally {
			ctx.close();
		}
	});
});

describe("控制动作走 control store（成功等待持久确认）", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});
	afterEach(() => ctx.close());

	it("attention.set/clear 返回 revision 与 persisted=true", async () => {
		const setResult = await handleQqCall(ctx.deps, "attention", {
			operation: "set",
			target: `g30003`,
			mode: "direct_only",
		});
		expect(setResult.status).toBe("succeeded");
		expect(String(setResult.result)).toContain("persisted=true");
		const clearResult = await handleQqCall(ctx.deps, "attention", {
			operation: "clear",
			target: `g30003`,
		});
		expect(clearResult.status).toBe("succeeded");
	});

	it("follow_up create/update/close 全链路", async () => {
		const created = await handleQqCall(ctx.deps, "follow_up", {
			operation: "create",
			targetRef: `p20002`,
			note: "整理完资料再联系小明",
			evidenceRefs: [`m42`],
			reviewAt: "2026-10-07T16:30:00+08:00",
		});
		expect(created.status).toBe("succeeded");
		expect(String(created.result)).toMatch(/ref=f\d+/);
		const ref = String(created.result).match(/ref=(f\S+)/)![1]!;
		const closed = await handleQqCall(ctx.deps, "follow_up", { operation: "close", ref, resolution: "完成" });
		expect(closed.status).toBe("succeeded");
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
		const result = await handleQqCall(ctx.deps, "account", {
			operation: "retract",
			messageRef: `m999`,
		});
		expect(result.status).toBe("failed");
		expect((result.details as { reason?: string } | undefined)?.reason).toBe("message_unaddressable");
		expect(ctx.transport.calls.filter((c) => c.action === "delete_msg")).toHaveLength(0);
	});

	it("retract 平台核验非本人消息 → not_own_message，0 delete_msg 调用", async () => {
		ctx.transport.script = () => ({ status: "ok", data: { message_id: 888, user_id: 20002 } });
		const result = await handleQqCall(ctx.deps, "account", {
			operation: "retract",
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
		const result = await handleQqCall(ctx.deps, "account", {
			operation: "retract",
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
		const result = await handleQqCall(ctx.deps, "speak", {
			conversationRef: `p20002`,
			replyTo: `m42`,
			content: [{ type: "text", text: "看到了" }],
		});
		expect(result.status).toBe("succeeded");
	});

	it("replyTo 平台核验归属不一致 → reply_target_mismatch，0 发送调用", async () => {
		ctx.transport.script = () => ({ status: "ok", data: { message_id: 42, group_id: 99999 } });
		const result = await handleQqCall(ctx.deps, "speak", {
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
		ctx.transport.script = (action) => {
			if (action === "search_sys_faces") {
				return {
					status: "ok",
					data: {
						faces: [
							{ q_sid: "14", q_des: "微笑", emoji_name_alias: ["呲牙"], is_super: false },
							{ q_sid: "😀", q_des: "emoji grin", emoji_name_alias: [], is_super: false },
						],
					},
				};
			}
			return { status: "failed", reason: `unexpected action ${action}`, kind: "rejected" as const };
		};
		const result = await handleQqCall(ctx.deps, "observe", { scope: "expressions", kind: "face", query: "微笑" });
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
		const result = await handleQqCall(ctx.deps, "observe", { scope: "expressions", kind: "face", limit: 10 });
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect((result.details as { count?: number } | undefined)?.count).toBe(10);
		expect(result.details).toMatchObject({ total: 60, hasMore: true });
		const ids = [...text.matchAll(/^id=(\d+) \|/gm)].map((match) => Number(match[1]));
		let cursor = (result.details as { nextCursor?: string }).nextCursor;
		while (cursor) {
			const page = await handleQqCall(ctx.deps, "observe", { scope: "expressions", kind: "face", limit: 10, cursor });
			expect(page.status).toBe("succeeded");
			ids.push(...[...String(page.result).matchAll(/^id=(\d+) \|/gm)].map((match) => Number(match[1])));
			cursor = (page.details as { nextCursor?: string }).nextCursor;
		}
		expect(ids).toHaveLength(60);
		expect(new Set(ids).size).toBe(60);
		expect(ids[0]).toBe(1);
		expect(ids.at(-1)).toBe(60);
	});

	it("json 卡片：messages 呈现卡片原文前缀，不再是未知分段", async () => {
		appendFact("61", [{ type: "json", data: '{"alert":{"title":"分享标题"}}' }]);
		const result = await handleQqCall(ctx.deps, "observe", {
			scope: "messages",
			messageRefs: [`m61`],
		});
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain("[卡片]");
		expect(text).toContain("分享标题");
	});

	it("合并转发：messages 命中 forward 段时 get_forward_msg 一层展开；空名片回落昵称", async () => {
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
		const result = await handleQqCall(ctx.deps, "observe", {
			scope: "messages",
			messageRefs: [`m62`],
		});
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain("合并转发");
		expect(text).toContain("真实昵称");
		expect(text).toContain("转发里的内容");
	});

	it("合并转发：预览分页并提供完整读取入口", async () => {
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
		const result = await handleQqCall(ctx.deps, "observe", {
			scope: "messages",
			messageRefs: [`m64`],
		});
		const text = String(result.result);
		expect(text).toContain("20/35");
		expect(text).toContain('scope="content"');
		expect(text).toContain("nextCursor=");
	});

	it("includeMedia：messages 抓取 image 段并附加 base64；失败逐条列出不阻断", async () => {
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
			const result = await handleQqCall(ctx.deps, "observe", {
				scope: "messages",
				messageRefs: [`m63`],
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
	it("mark_read temp 会话按对端 uin 路由，不透传 NaN", async () => {
		const ctx = setup();
		try {
			const result = await handleQqCall(ctx.deps, "account", {
				operation: "mark_read",
				conversationRef: `t20002-g30003`,
			});
			expect(result.status).toBe("succeeded");
			expect(ctx.transport.calls).toHaveLength(1);
			expect(ctx.transport.calls[0]).toMatchObject({
				action: "mark_private_msg_as_read",
				params: { user_id: 20002 },
			});
			expect(Number.isFinite(ctx.transport.calls[0]!.params.user_id)).toBe(true);
		} finally {
			ctx.close();
		}
	});

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
			await handleQqCall(ctx.deps, "account", {
				operation: "respond_request",
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
			await handleQqCall(ctx.deps, "account", {
				operation: "respond_request",
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

	it("conversation 平台历史 count 钳制到 SnowLuma 上限 200", async () => {
		const ctx = setup();
		try {
			ctx.transport.script = () => ({ status: "ok", data: { messages: [] } });
			await handleQqCall(ctx.deps, "observe", {
				scope: "conversation",
				conversationRef: `g30003`,
				limit: 5000,
			});
			expect(ctx.transport.calls[0]).toMatchObject({
				action: "get_group_msg_history",
				params: { count: 200 },
			});
		} finally {
			ctx.close();
		}
	});
});

describe("ToolDef 对齐清理回归（批次6）", () => {
	it("capabilities.action 过滤：只探测并只返回指定类型的维度", async () => {
		const ctx = setup();
		try {
			ctx.transport.script = () => ({ status: "ok", data: { yes: true } });
			const result = await handleQqCall(ctx.deps, "observe", { scope: "capabilities", action: "image" });
			expect(result.status).toBe("succeeded");
			// 只探测 can_send_image，不碰 can_send_record
			expect(ctx.transport.calls.map((c) => c.action)).toEqual(["can_send_image"]);
			expect(String(result.result)).toContain("image:");
			expect(String(result.result)).not.toContain("audio:");
		} finally {
			ctx.close();
		}
	});

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
			const filtered = await handleQqCall(ctx.deps, "observe", { scope: "requests", kind: "group_invite" });
			expect(String(filtered.result)).toContain("r2");
			expect(String(filtered.result)).not.toContain("r1");
			const limited = await handleQqCall(ctx.deps, "observe", { scope: "requests", state: "all", limit: 1 });
			expect(String(limited.result)).toContain("nextCursor=");
			const second = await handleQqCall(ctx.deps, "observe", {
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

	it("follow_ups limit 分页（显式 nextCursor）", async () => {
		const ctx = setup();
		try {
			for (let i = 1; i <= 3; i++) {
				ctx.control.createFollowUp({ targetRef: `p2000${i}`, note: `事项${i}` });
			}
			const result = await handleQqCall(ctx.deps, "observe", { scope: "follow_ups", limit: 2 });
			expect(String(result.result)).toContain("nextCursor=");
			const second = await handleQqCall(ctx.deps, "observe", {
				scope: "follow_ups",
				limit: 2,
				cursor: (result.details as { nextCursor: string }).nextCursor,
			});
			expect(String(second.result)).toContain("f3 | state=open");
			expect(second.details).toMatchObject({ count: 1, total: 3, hasMore: false });
		} finally {
			ctx.close();
		}
	});

	it("contacts limit 分页（显式 nextCursor）", async () => {
		const ctx = setup();
		try {
			ctx.transport.script = () => ({
				status: "ok",
				data: [
					{ user_id: 1, nickname: "甲", remark: "" },
					{ user_id: 2, nickname: "乙", remark: "" },
					{ user_id: 3, nickname: "丙", remark: "" },
				],
			});
			const result = await handleQqCall(ctx.deps, "observe", { scope: "contacts", limit: 2 });
			expect(String(result.result)).toContain("nextCursor=");
			expect(String(result.result)).toContain("u2");
			expect(String(result.result)).not.toContain("u3");
			const second = await handleQqCall(ctx.deps, "observe", {
				scope: "contacts",
				limit: 2,
				cursor: (result.details as { nextCursor: string }).nextCursor,
			});
			expect(String(second.result)).toContain("u3 |");
			expect(String(second.result)).not.toContain("u2 |");
			expect(second.details).toMatchObject({ count: 1, total: 3, hasMore: false });
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
			const result = await handleQqCall(ctx.deps, "account", {
				operation: "set_profile",
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

describe("审查后清理回归（批次A）：conversations 合同修复", () => {
	it("conversations = 平台群列表 ∪ 本地保存会话；本地补充项标陈旧，平台群不重复", async () => {
		const ctx = setup();
		try {
			// 本地事实：平台在线列表里的群（应去重）+ 平台列表外的私聊（应补充）。
			ctx.journal.appendMessage({
				ref: `m901`,
				conversationRef: `g30003`,
				senderRef: `u20002`,
				senderDisplayName: "小明",
				direction: "in",
				time: "2026-10-07T15:00:00+08:00",
				segments: [{ type: "text", text: "群消息" }],
				source: "platform",
			});
			ctx.journal.appendMessage({
				ref: `m902`,
				conversationRef: `p20002`,
				senderRef: `u20002`,
				senderDisplayName: "小明",
				direction: "in",
				time: "2026-10-07T15:01:00+08:00",
				segments: [{ type: "text", text: "私聊消息" }],
				source: "platform",
			});
			ctx.transport.script = (action) =>
				action === "get_group_list"
					? { status: "ok", data: [{ group_id: 30003, group_name: "设计组" }] }
					: { status: "ok", data: {} };
			const result = await handleQqCall(ctx.deps, "observe", { scope: "conversations" });
			expect(result.status).toBe("succeeded");
			const text = String(result.result);
			expect(text).toContain(`g30003`);
			expect((text.match(new RegExp(`g30003`, "g")) ?? []).length).toBe(1);
			expect(text).toContain(`p20002`);
			expect(text).toContain("本地保存（陈旧性未核验）");
		} finally {
			ctx.close();
		}
	});

	it("conversations query 过滤命中私聊 ref", async () => {
		const ctx = setup();
		try {
			ctx.journal.appendMessage({
				ref: `m903`,
				conversationRef: `p20002`,
				senderRef: `u20002`,
				senderDisplayName: "小明",
				direction: "in",
				time: "2026-10-07T15:01:00+08:00",
				segments: [{ type: "text", text: "私聊消息" }],
				source: "platform",
			});
			ctx.transport.script = () => ({ status: "ok", data: [] });
			const result = await handleQqCall(ctx.deps, "observe", { scope: "conversations", query: "p20002" });
			const text = String(result.result);
			expect(text).toContain(`p20002`);
			expect(text).not.toContain("group:");
		} finally {
			ctx.close();
		}
	});
});

describe("短引用与无状态列表分页集成", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});
	afterEach(() => ctx.close());

	function rows(result: Awaited<ReturnType<typeof runQqCall>>): string[] {
		return [...String(result.result).matchAll(/^([ugpt][\w-]+) \|/gm)].map((match) => match[1]!);
	}

	it("members 每页重新取完整成员列表，三页无重复或遗漏", async () => {
		ctx.transport.script = () => ({
			status: "ok",
			data: [5, 2, 4, 1, 3].map((user_id) => ({ user_id, nickname: `成员${user_id}`, role: "member" })),
		});
		const collected: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await handleQqCall(ctx.deps, "observe", {
				scope: "members",
				conversationRef: "g30003",
				limit: 2,
				...(cursor ? { cursor } : {}),
			});
			expect(page.status).toBe("succeeded");
			collected.push(...rows(page));
			cursor = (page.details as { nextCursor?: string }).nextCursor;
		} while (cursor);
		expect(collected).toEqual(["u1", "u2", "u3", "u4", "u5"]);
		expect(ctx.transport.calls.map((call) => call.action)).toEqual([
			"get_group_member_list",
			"get_group_member_list",
			"get_group_member_list",
		]);
	});

	it("contacts 默认20条，续页覆盖剩余5条", async () => {
		ctx.transport.script = () => ({
			status: "ok",
			data: Array.from({ length: 25 }, (_, i) => ({ user_id: i + 1, nickname: `联系人${i + 1}` })),
		});
		const first = await handleQqCall(ctx.deps, "observe", { scope: "contacts" });
		expect(first.details).toMatchObject({ count: 20, total: 25, hasMore: true });
		const second = await handleQqCall(ctx.deps, "observe", {
			scope: "contacts",
			cursor: (first.details as { nextCursor: string }).nextCursor,
		});
		expect(rows(first)).toHaveLength(20);
		expect(rows(second)).toEqual(["u21", "u22", "u23", "u24", "u25"]);
		expect(new Set([...rows(first), ...rows(second)]).size).toBe(25);
		expect(second.details).toMatchObject({ count: 5, total: 25, hasMore: false });
		expect(String(second.result)).not.toContain("nextCursor=");
	});

	it("conversations kind 过滤覆盖本地 private/group/temp 并与在线群去重", async () => {
		for (const [ref, conversationRef] of [
			["m1001", "p20002"],
			["m1002", "g30004"],
			["m1003", "t20003-g30003"],
			["m1004", "g30003"],
		]) {
			ctx.journal.appendMessage({
				ref: ref!,
				conversationRef: conversationRef!,
				senderRef: "u20002",
				senderDisplayName: "成员",
				direction: "in",
				time: "2026-10-08T03:00:00Z",
				segments: [{ type: "text", text: "本地事实" }],
				source: "platform",
			});
		}
		ctx.transport.script = () => ({ status: "ok", data: [{ group_id: 30003, group_name: "在线群" }] });
		for (const [kind, expected] of [
			["private", ["p20002"]],
			["group", ["g30003", "g30004"]],
			["temp", ["t20003-g30003"]],
		] as const) {
			const result = await handleQqCall(ctx.deps, "observe", { scope: "conversations", kind });
			expect(result.status).toBe("succeeded");
			expect(rows(result)).toEqual(expected);
		}
	});

	it("列表数据变化返回 cursor_stale，跨查询条件返回 cursor_invalid", async () => {
		const contacts = [
			{ user_id: 1, nickname: "甲" },
			{ user_id: 2, nickname: "乙" },
			{ user_id: 3, nickname: "丙" },
		];
		ctx.transport.script = () => ({ status: "ok", data: contacts });
		const first = await handleQqCall(ctx.deps, "observe", { scope: "contacts", limit: 1 });
		const cursor = (first.details as { nextCursor: string }).nextCursor;
		contacts[1]!.nickname = "新名称";
		const stale = await handleQqCall(ctx.deps, "observe", { scope: "contacts", limit: 1, cursor });
		expect(stale.status).toBe("failed");
		expect(stale.details).toMatchObject({ reason: "cursor_stale" });
		const changedFilter = await handleQqCall(ctx.deps, "observe", { scope: "contacts", limit: 1, cursor, query: "甲" });
		expect(changedFilter.status).toBe("failed");
		expect(changedFilter.details).toMatchObject({ reason: "cursor_invalid" });
	});

	it("绕过fixture补账号：缺失或错误account、旧长引用均拒绝且0平台调用", async () => {
		for (const [action, params, reason] of [
			["observe", { scope: "status" }, "account_mismatch"],
			[
				"speak",
				{ account: "other", conversationRef: "p20002", content: [{ type: "text", text: "hi" }] },
				"account_mismatch",
			],
			[
				"speak",
				{
					account: SELF,
					conversationRef: "qq-conversation:10001:private:20002",
					content: [{ type: "text", text: "hi" }],
				},
				"invalid_target",
			],
			[
				"observe",
				{ account: SELF, scope: "members", conversationRef: "qq-conversation:10001:group:30003" },
				"invalid_target",
			],
			["account", { account: SELF, operation: "remove_contact", userRef: "qq-user:10001:20002" }, "invalid_target"],
			[
				"gesture",
				{ account: SELF, kind: "react", messageRef: "qq-message:10001:42", reactionCode: "14" },
				"invalid_target",
			],
		] as const) {
			const result = await runQqCall(ctx.deps, action, params);
			expect(result.status).toBe("failed");
			expect(result.details).toMatchObject({ reason });
		}
		expect(ctx.transport.calls).toHaveLength(0);
	});
});
