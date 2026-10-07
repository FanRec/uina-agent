import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleQqCall } from "../.uina/worlds/qq/src/app.js";
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
			userRef: `qq-user:${SELF}:20002`,
		});
		expect(result.status).toBe("failed");
		expect(result.details).toMatchObject({ reason: "grant_denied", effect: "not_started" });
		expect(ctx.transport.calls).toHaveLength(0);
		expect(String(result.result)).toContain("grant_denied");
	});

	it("respond_request 未授 → 0 平台调用", async () => {
		const result = await handleQqCall(ctx.deps, "account", {
			operation: "respond_request",
			requestRef: `qq-request:${SELF}:flag-1`,
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
				conversationRef: `qq-conversation:${SELF}:group:30003`,
				userRef: `qq-user:${SELF}:20002`,
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
			ref: `qq-message:${SELF}:42`,
			conversationRef: `qq-conversation:${SELF}:private:20002`,
			senderRef: `qq-user:${SELF}:20002`,
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
			conversationRef: "qq-conversation:10099:private:20002",
			content: [{ type: "text", text: "你好" }],
		});
		expect(result.status).toBe("failed");
		expect((result.details as { reason?: string } | undefined)?.reason).toBe("account_mismatch");
		expect(ctx.transport.calls).toHaveLength(0);
	});

	it("reply 属主不属于目标会话 → reply_target_mismatch", async () => {
		// 预置另一会话消息
		ctx.journal.appendMessage({
			ref: `qq-message:${SELF}:77`,
			conversationRef: `qq-conversation:${SELF}:private:30001`,
			senderRef: `qq-user:${SELF}:30001`,
			senderDisplayName: "别人",
			direction: "in",
			time: "2026-10-07T15:00:00+08:00",
			segments: [{ type: "text", text: "hi" }],
			source: "platform",
		});
		const result = await handleQqCall(ctx.deps, "speak", {
			conversationRef: `qq-conversation:${SELF}:private:20002`,
			replyTo: `qq-message:${SELF}:77`,
			content: [{ type: "text", text: "你好" }],
		});
		expect(result.status).toBe("failed");
		expect((result.details as { reason?: string } | undefined)?.reason).toBe("reply_target_mismatch");
		expect(ctx.transport.calls).toHaveLength(0);
	});

	it("私聊消息 reaction → unsupported_target，不外推", async () => {
		const result = await handleQqCall(ctx.deps, "gesture", {
			kind: "react",
			messageRef: `qq-message:${SELF}:42`,
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
			conversationRef: `qq-conversation:${SELF}:group:30003`,
			query: "小明",
		});
		expect(result.status).toBe("succeeded");
		expect(String(result.result)).toContain("qq-user:10001:20002");
		expect(String(result.result)).toContain("qq-user:10001:20009");
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
			conversationRef: `qq-conversation:${SELF}:group:30003`,
		});
		expect(result.status).toBe("succeeded");
		expect(String(result.result)).toContain("qq-user:10001:20002");
		expect(String(result.result)).toContain("qq-user:10001:20009");
	});

	it("members 查询失败：不倾倒原始回执，给下一步指引，完整 outcome 进 details", async () => {
		ctx.transport.script = () => ({
			status: "failed",
			reason: "retcode=500",
			kind: "rejected",
		});
		const result = await handleQqCall(ctx.deps, "observe", {
			scope: "members",
			conversationRef: `qq-conversation:${SELF}:group:30003`,
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
			conversationRef: `qq-conversation:${SELF}:private:20002`,
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
			conversationRef: `qq-conversation:${SELF}:private:20002`,
			content: [{ type: "text", text: "hi" }],
		});
		expect(result.status).toBe("failed");
		expect(ctx.ops.get(`qq-operation:${SELF}:1`)?.outcome).toBe("failed");
	});

	it("发送成功 → succeeded + messageRef + effect=applied", async () => {
		ctx.transport.script = () => ({ status: "ok", data: { message_id: 43 } });
		const result = await handleQqCall(ctx.deps, "speak", {
			conversationRef: `qq-conversation:${SELF}:private:20002`,
			content: [{ type: "text", text: "我把资料整理好了。" }],
		});
		expect(result.status).toBe("succeeded");
		expect(String(result.result)).toContain("messageRef=qq-message:10001:43");
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
			target: `qq-conversation:${SELF}:group:30003`,
			mode: "direct_only",
		});
		expect(setResult.status).toBe("succeeded");
		expect(String(setResult.result)).toContain("persisted=true");
		const clearResult = await handleQqCall(ctx.deps, "attention", {
			operation: "clear",
			target: `qq-conversation:${SELF}:group:30003`,
		});
		expect(clearResult.status).toBe("succeeded");
	});

	it("follow_up create/update/close 全链路", async () => {
		const created = await handleQqCall(ctx.deps, "follow_up", {
			operation: "create",
			targetRef: `qq-conversation:${SELF}:private:20002`,
			note: "整理完资料再联系小明",
			evidenceRefs: [`qq-message:${SELF}:42`],
			reviewAt: "2026-10-07T16:30:00+08:00",
		});
		expect(created.status).toBe("succeeded");
		expect(String(created.result)).toMatch(/ref=qq-follow-up:10001:\d+/);
		const ref = String(created.result).match(/ref=(qq-follow-up:\S+)/)![1]!;
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
			messageRef: `qq-message:${SELF}:999`,
		});
		expect(result.status).toBe("failed");
		expect((result.details as { reason?: string } | undefined)?.reason).toBe("message_unaddressable");
		expect(ctx.transport.calls.filter((c) => c.action === "delete_msg")).toHaveLength(0);
	});

	it("retract 平台核验非本人消息 → not_own_message，0 delete_msg 调用", async () => {
		ctx.transport.script = () => ({ status: "ok", data: { message_id: 888, user_id: 20002 } });
		const result = await handleQqCall(ctx.deps, "account", {
			operation: "retract",
			messageRef: `qq-message:${SELF}:888`,
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
			messageRef: `qq-message:${SELF}:889`,
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
			conversationRef: `qq-conversation:${SELF}:private:20002`,
			replyTo: `qq-message:${SELF}:42`,
			content: [{ type: "text", text: "看到了" }],
		});
		expect(result.status).toBe("succeeded");
	});

	it("replyTo 平台核验归属不一致 → reply_target_mismatch，0 发送调用", async () => {
		ctx.transport.script = () => ({ status: "ok", data: { message_id: 42, group_id: 99999 } });
		const result = await handleQqCall(ctx.deps, "speak", {
			conversationRef: `qq-conversation:${SELF}:group:30003`,
			replyTo: `qq-message:${SELF}:42`,
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
			ref: `qq-message:${SELF}:${ref}`,
			conversationRef: `qq-conversation:${SELF}:group:30003`,
			senderRef: `qq-user:${SELF}:20002`,
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

	it("expressions：无 query 走 fetch_sys_faces 并按 limit 截断", async () => {
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
		expect(text).toContain("显示前 10");
		expect((result.details as { count?: number } | undefined)?.count).toBe(60);
	});

	it("json 卡片：messages 呈现卡片原文前缀，不再是未知分段", async () => {
		appendFact("61", [{ type: "json", data: '{"alert":{"title":"分享标题"}}' }]);
		const result = await handleQqCall(ctx.deps, "observe", {
			scope: "messages",
			messageRefs: [`qq-message:${SELF}:61`],
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
			messageRefs: [`qq-message:${SELF}:62`],
		});
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain("合并转发");
		expect(text).toContain("真实昵称");
		expect(text).toContain("转发里的内容");
	});

	it("合并转发：超过 30 节点显式标注截断，不静默丢弃", async () => {
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
			messageRefs: [`qq-message:${SELF}:64`],
		});
		const text = String(result.result);
		expect(text).toContain("35 条");
		expect(text).toContain("仅显示前 30 条，余 5 条省略");
	});

	it("includeMedia：messages 抓取 image 段并附加 base64；失败逐条列出不阻断", async () => {
		appendFact("63", [
			{
				type: "image",
				mediaRef: `qq-media:${SELF}:1`,
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
				messageRefs: [`qq-message:${SELF}:63`],
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
