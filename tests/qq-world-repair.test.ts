import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleObserve, handleQqCall, type QqAppDeps } from "../.uina/worlds/qq/src/app.js";
import { AttentionModel } from "../.uina/worlds/qq/src/attention.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { ConversationLocks } from "../.uina/worlds/qq/src/conversation-lock.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { MediaStaging } from "../.uina/worlds/qq/src/media.js";
import { OperationLog } from "../.uina/worlds/qq/src/operation-log.js";
import { renderCandidate as renderTapCandidate, renderReadWindow } from "../.uina/worlds/qq/src/render.js";
import { QqScheduler } from "../.uina/worlds/qq/src/scheduler.js";
import type { TransportCallOutcome } from "../.uina/worlds/qq/src/transport.js";
import type { MessageFact } from "../.uina/worlds/qq/src/types.js";

const SELF = "10001",
	GROUP = "g30003",
	NOW = "2026-10-08T10:00:00Z";
let dir: string, deps: QqAppDeps;
let calls: { action: string; params: Record<string, unknown> }[];
let respond: (action: string, params: Record<string, unknown>) => TransportCallOutcome;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "qq-repair-"));
	const journal = new FactsJournal({ dataDir: dir, selfId: SELF });
	journal.recover();
	const control = new ControlStore({ dataDir: dir, selfId: SELF, now: () => NOW });
	control.load();
	const ops = new OperationLog({ dataDir: dir, selfId: SELF });
	ops.recover();
	calls = [];
	respond = () => ({ status: "ok", data: { message_id: 90 } });
	deps = {
		selfId: SELF,
		journal,
		control,
		ops,
		now: () => NOW,
		attention: new AttentionModel(),
		locks: new ConversationLocks(),
		grants: { grants: ["observation", "messaging", "requests.respond"] },
		display: { timezone: "Asia/Shanghai" },
		media: { allowedRoots: [dir], staging: new MediaStaging({ stagingDir: join(dir, "staging"), ops }) },
		transport: {
			start: async () => ({ selfId: 10001 }),
			stop: async () => {},
			onEvent: () => () => {},
			onRaw: () => () => {},
			onStatus: () => () => {},
			call: async (action, params = {}) => {
				calls.push({ action, params });
				return respond(action, params);
			},
		},
	};
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});
function call(action: string, params: Record<string, unknown>) {
	return handleQqCall(deps, action, params);
}
function message(
	ref = "m42",
	segments: MessageFact["segments"] = [{ type: "text", text: "原文" }],
	conversationRef = GROUP,
) {
	return deps.journal.appendMessage({
		ref,
		conversationRef,
		senderRef: "u20002",
		senderDisplayName: "甲",
		direction: "in",
		time: NOW,
		segments,
		source: "platform",
	});
}
function request() {
	deps.journal.appendRequest({
		ref: "r1",
		platformFlag: "private-flag",
		kind: "friend",
		state: "pending",
		requesterRef: "u20002",
		requesterDisplayName: "甲",
		comment: "你好\n第二行",
		time: NOW,
	});
}
function cursor(result: { result: string; details?: unknown }): string {
	return (
		(result.details as { nextCursor?: string } | undefined)?.nextCursor ??
		/nextCursor=([^\s]+)/.exec(result.result)?.[1] ??
		""
	);
}
function history(mid: number) {
	return {
		message_id: mid,
		group_id: 30003,
		message_type: "group",
		time: 1791453600 + mid,
		sender: { user_id: 20002, nickname: "甲" },
		message: [
			{ type: "reply", data: { id: "42" } },
			{ type: "text", data: { text: `内容${mid}` } },
		],
	};
}

describe("QQ 修复：外部行为与操作事实", () => {
	it("replyTo 到达真实发送载荷及操作记录", async () => {
		message();
		const result = await call("send", {
			conversationRef: GROUP,
			replyTo: "m42",
			content: [{ type: "text", text: "收到" }],
		});
		expect(result.status).toBe("succeeded");
		expect(calls[0]!.params.message).toEqual([
			{ type: "reply", data: { id: "42" } },
			{ type: "text", data: { text: "收到" } },
		]);
		expect(deps.ops.all()[0]).toMatchObject({ replyTo: "m42", messageRef: "m90" });
	});
	it("拆批保持文件顺序，只给首条可引用消息加引用", async () => {
		message();
		const path = join(dir, "f.txt");
		writeFileSync(path, "test");
		await call("send", {
			conversationRef: GROUP,
			replyTo: "m42",
			content: [
				{ type: "file", resource: { kind: "file", path } },
				{ type: "text", text: "说明" },
				{ type: "file", resource: { kind: "file", path } },
			],
		});
		expect(calls).toHaveLength(3);
		const messages = calls.map((c) => c.params.message as { type: string }[]);
		expect(messages.map((m) => m.map((s) => s.type))).toEqual([["file"], ["reply", "text"], ["file"]]);
	});
	it("纯文件引用在派发前失败", async () => {
		message();
		const path = join(dir, "f.txt");
		writeFileSync(path, "test");
		const result = await call("send", {
			conversationRef: GROUP,
			replyTo: "m42",
			content: [{ type: "file", resource: { kind: "file", path } }],
		});
		expect(result.status).toBe("failed");
		expect(calls).toEqual([]);
	});
	it("temp 在线核验分别比较对端和源群", async () => {
		respond = (action) =>
			action === "get_msg"
				? {
						status: "ok",
						data: {
							message_id: 42,
							user_id: 20002,
							group_id: 30003,
							message_type: "private",
							sub_type: "group",
							sender: { user_id: 20002, group_id: 30003 },
							target_id: 10001,
						},
					}
				: { status: "ok", data: { message_id: 90 } };
		expect(
			(
				await call("send", {
					conversationRef: "t20002-g30003",
					replyTo: "m42",
					content: [{ type: "text", text: "收到" }],
				})
			).status,
		).toBe("succeeded");
		expect(calls.at(-1)!.params).toMatchObject({ user_id: 20002, group_id: 30003 });
	});
	it("引用在线核验接受字符串标识和sender用户，拒绝错消息与错账号", async () => {
		respond = (action) =>
			action === "get_msg"
				? {
						status: "ok",
						data: {
							message_id: "42",
							group_id: "30003",
							message_type: "private",
							sub_type: "group",
							sender: { user_id: "20002", group_id: "30003" },
							self_id: "10001",
						},
					}
				: { status: "ok", data: { message_id: 90 } };
		const params = { conversationRef: "t20002-g30003", replyTo: "m42", content: [{ type: "text", text: "收到" }] };
		expect((await call("send", params)).status).toBe("succeeded");
		for (const invalid of [
			{ message_id: 99, group_id: 30003 },
			{ message_id: 42, group_id: 30003, self_id: 99999 },
		]) {
			calls = [];
			respond = () => ({ status: "ok", data: invalid });
			expect((await call("send", { ...params, conversationRef: GROUP })).status).toBe("failed");
			expect(calls.map((c) => c.action)).toEqual(["get_msg"]);
		}
	});
	it("申请状态由操作日志派生，成功后不会重复派发且重启可恢复", async () => {
		request();
		await call("requests", { action: "respond", requestRef: "r1", decision: "accept" });
		const pending = await handleObserve(deps, { scope: "requests" });
		expect(pending.result).not.toContain("r1 |");
		expect((await call("requests", { action: "respond", requestRef: "r1", decision: "accept" })).status).toBe("failed");
		expect(calls).toHaveLength(1);
		const recovered = new OperationLog({ dataDir: dir, selfId: SELF });
		recovered.recover();
		deps = { ...deps, ops: recovered };
		expect((await handleObserve(deps, { scope: "requests", state: "all" })).result).toContain("confirmed");
	});
	it("未知申请不重复发送，迟到回执升级后呈现 confirmed", async () => {
		request();
		respond = () => ({ status: "failed", kind: "timeout", reason: "timeout" });
		const result = await call("requests", { action: "respond", requestRef: "r1", decision: "decline" });
		expect(result.status).toBe("unknown");
		await call("requests", { action: "respond", requestRef: "r1", decision: "decline" });
		expect(calls).toHaveLength(1);
		const op = deps.ops.all()[0]!;
		deps.ops.settleFromEchoReceipt(op.echo!, { status: "ok", retcode: 0 }, NOW);
		expect((await handleObserve(deps, { scope: "requests", state: "all" })).result).toContain("confirmed");
	});
	it("已确认迟到回执不会被随后到达的本地超时降级", () => {
		const ref = deps.ops.newOperationRef();
		deps.ops.commitIntent({
			ref,
			identity: "world:qq/speak",
			action: "send_group_msg",
			target: GROUP,
			outcome: "unknown",
			echo: `${SELF}/${ref}`,
			startedAt: NOW,
		});
		deps.ops.settleFromEchoReceipt(`${SELF}/${ref}`, { status: "ok", data: { message_id: 90 } }, NOW);
		deps.ops.settle(ref, "unknown", NOW, { reason: "timeout" });
		expect(deps.ops.get(ref)).toMatchObject({ outcome: "succeeded", messageRef: "m90" });
	});
	it("派发结果已被echo确认时，本地超时仍返回已确认结论", async () => {
		request();
		respond = () => {
			const op = deps.ops.all()[0]!;
			deps.ops.settleFromEchoReceipt(op.echo!, { status: "ok", retcode: 0 }, NOW);
			return { status: "failed", kind: "timeout", reason: "timeout" };
		};
		expect((await call("requests", { action: "respond", requestRef: "r1", decision: "accept" })).status).toBe(
			"succeeded",
		);
		expect((await handleObserve(deps, { scope: "requests", state: "all" })).result).toContain("confirmed");
	});
	it("echo 已确定拒绝时不把结果夸大为未知", async () => {
		request();
		respond = () => {
			const op = deps.ops.all()[0]!;
			deps.ops.settleFromEchoReceipt(op.echo!, { status: "failed", retcode: 1400 }, NOW);
			return { status: "failed", kind: "timeout", reason: "timeout" };
		};
		expect((await call("requests", { action: "respond", requestRef: "r1", decision: "accept" })).status).toBe("failed");
		expect(deps.ops.wasDeliveredUnknown("o1")).toBe(false);
	});
});

describe("QQ 修复：完整内容与历史分页", () => {
	it("点查缺本地消息时经 contentTarget 读取平台且不写入 journal", async () => {
		respond = (action) => ({ status: "ok", data: action === "get_msg" ? history(77) : { messages: [history(77)] } });
		expect((await call("browse", { contentTarget: { messageRef: "m77", segmentIndex: 0 } })).result).toContain(
			"内容77",
		);
		expect(deps.journal.getMessage("m77")).toBeNull();
	});
	it("Unicode 卡片续页可以读取完整原文", async () => {
		message("m43", [{ type: "json", data: "🙂".repeat(4100) + "末尾" }]);
		const first = await call("browse", { contentTarget: { messageRef: "m43", segmentIndex: 0 } });
		expect(first.status).toBe("succeeded");
		expect(cursor(first)).not.toBe("");
		const second = await call("browse", {
			contentTarget: { messageRef: "m43", segmentIndex: 0, cursor: cursor(first) },
		});
		expect(second.result).toContain("末尾");
		expect(second.result).not.toContain("�");
	});
	it("长转发节点可以继续读取第31条", async () => {
		message("m44", [{ type: "forward", resId: "forward-test" }]);
		respond = () => ({
			status: "ok",
			data: {
				messages: Array.from({ length: 45 }, (_, i) => ({
					sender: { user_id: 20002, nickname: "甲" },
					time: 1791453600,
					message: [{ type: "text", data: { text: `节点${i + 1}` } }],
				})),
			},
		});
		const first = await call("browse", { contentTarget: { messageRef: "m44", segmentIndex: 0 } });
		expect(first.status).toBe("succeeded");
		expect(first.result).not.toContain("节点31");
		const second = await call("browse", {
			contentTarget: { messageRef: "m44", segmentIndex: 0, cursor: cursor(first) },
		});
		expect(second.result).toContain("节点31");
	});
});

describe("QQ 修复：触发现场", () => {
	it("申请候选交付具体人物和留言，而不是空消息批次", async () => {
		vi.useFakeTimers();
		const emitted: string[] = [];
		request();
		const scheduler = new QqScheduler({
			selfId: SELF,
			journal: deps.journal,
			control: deps.control,
			attention: new AttentionModel(),
			now: () => NOW,
			renderCandidate: (c) => renderTapCandidate(c, { journal: deps.journal, control: deps.control, now: () => NOW }),
			renderRingWindow: (conv) =>
				renderReadWindow(
					conv,
					{ journal: deps.journal, control: deps.control, now: () => NOW },
					{ limit: 30, budgetChars: 14000 },
				),
			emit: async (i) => {
				emitted.push((await i.render()) ?? "");
			},
		});
		try {
			scheduler.onFact({ kind: "request", fact: deps.journal.snapshot.requests.get("r1")! });
			await vi.advanceTimersByTimeAsync(2000);
			expect(emitted[0]).toContain("u20002");
			expect(emitted[0]).toContain("你好");
			expect(emitted[0]).toContain("r1");
		} finally {
			scheduler.stop();
		}
	});
	it("已排队申请在处理成功后不继续提醒待处理", async () => {
		vi.useFakeTimers();
		request();
		const emitted: string[] = [];
		const scheduler = new QqScheduler({
			selfId: SELF,
			journal: deps.journal,
			control: deps.control,
			attention: new AttentionModel(),
			now: () => NOW,
			isRequestPending: (ref) =>
				!deps.ops.all().some((op) => op.target === ref && (op.outcome === "succeeded" || op.outcome === "unknown")),
			renderCandidate: (c) => renderTapCandidate(c, { journal: deps.journal, control: deps.control, now: () => NOW }),
			renderRingWindow: (conv) =>
				renderReadWindow(
					conv,
					{ journal: deps.journal, control: deps.control, now: () => NOW },
					{ limit: 30, budgetChars: 14000 },
				),
			emit: async (i) => {
				emitted.push((await i.render()) ?? "");
			},
		});
		try {
			scheduler.onFact({ kind: "request", fact: deps.journal.snapshot.requests.get("r1")! });
			await call("requests", { action: "respond", requestRef: "r1", decision: "accept" });
			await vi.advanceTimersByTimeAsync(2000);
			expect(emitted).toEqual([]);
		} finally {
			scheduler.stop();
		}
	});
	it("stop 后异步投递失败和迟到事实不会重新启动调度", async () => {
		vi.useFakeTimers();
		let rejectEmit: (reason: Error) => void = () => {};
		const emitted: string[] = [];
		const fact = message("m1", undefined, "p20002");
		const scheduler = new QqScheduler({
			selfId: SELF,
			journal: deps.journal,
			control: deps.control,
			attention: new AttentionModel(),
			now: () => NOW,
			renderRingWindow: () => ({ text: "消息", delivered: [], deliveredThrough: 0, remaining: 0 }),
			renderCandidate: () => "消息",
			emit: async (i) => {
				emitted.push(i.id);
				await new Promise<void>((_resolve, reject) => {
					rejectEmit = reject;
				});
			},
		});
		scheduler.onFact({ kind: "message", fact });
		// pulse 去抖 1200ms：等待首次派发挂起（占位成立）后再 stop
		await vi.advanceTimersByTimeAsync(2500);
		scheduler.stop();
		rejectEmit(new Error("late failure"));
		await vi.advanceTimersByTimeAsync(2000);
		scheduler.onFact({ kind: "message", fact });
		await vi.advanceTimersByTimeAsync(2000);
		expect(emitted).toHaveLength(1);
		expect(scheduler.inFlight).toBeNull();
		expect(scheduler.pendingCandidates).toEqual([]);
	});
});
