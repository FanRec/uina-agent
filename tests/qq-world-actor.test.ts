import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleQqCall, type QqAppDeps } from "../.uina/worlds/qq/src/app.js";
import { AttentionModel } from "../.uina/worlds/qq/src/attention.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { ConversationLocks } from "../.uina/worlds/qq/src/conversation-lock.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { MediaStaging } from "../.uina/worlds/qq/src/media.js";
import { OperationLog } from "../.uina/worlds/qq/src/operation-log.js";
import type { DeploymentGrants } from "../.uina/worlds/qq/src/grants.js";
import type { TransportCallOutcome } from "../.uina/worlds/qq/src/transport.js";
import { conversationRef, userRef, type MessageFact } from "../.uina/worlds/qq/src/types.js";

/**
 * 行动积木（设计 §4.5~§4.9 / T08/T09 前置）：参数映射层复用旧链路，
 * 断言平台调用形状与三态回执如实；呈现词序/排版不是逐字标准。
 */

const SELF = "10001";
const G1 = conversationRef("group", "30001");
const P1 = conversationRef("private", "20002");
const NOW = "2026-10-11T12:00:00Z";

let dir: string, deps: QqAppDeps, journal: FactsJournal;
let calls: { action: string; params: Record<string, unknown> }[];
let respond: (action: string) => TransportCallOutcome;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "uina-qq-actor-"));
	journal = new FactsJournal({ dataDir: dir, selfId: SELF });
	journal.recover();
	const control = new ControlStore({ dataDir: dir, selfId: SELF, now: () => NOW });
	control.load();
	const ops = new OperationLog({ dataDir: dir, selfId: SELF });
	ops.recover();
	calls = [];
	respond = () => ({ status: "ok", data: { message_id: 777 } });
	deps = {
		selfId: SELF,
		journal,
		control,
		ops,
		now: () => NOW,
		attention: new AttentionModel({ control }),
		locks: new ConversationLocks(),
		grants: {
			grants: [
				"observation",
				"messaging",
				"interaction",
				"attention.manage",
				"follow_up.manage",
				"requests.respond",
				"profile.modify",
				"messages.retract",
			],
		} as DeploymentGrants,
		media: { allowedRoots: [dir], staging: new MediaStaging({ stagingDir: join(dir, "staging"), ops }) },
		transport: {
			start: async () => ({ selfId: Number(SELF) }),
			stop: async () => {},
			onEvent: () => () => {},
			onRaw: () => () => {},
			onStatus: () => () => {},
			call: async (action, params = {}) => {
				calls.push({ action, params });
				return respond(action);
			},
		},
	};
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function call(action: string, params: Record<string, unknown>): ReturnType<typeof handleQqCall> {
	return handleQqCall(deps, action, params);
}

function message(overrides: Partial<MessageFact> = {}): MessageFact {
	return journal.appendMessage({
		ref: "m501",
		conversationRef: G1,
		senderRef: userRef("20002"),
		senderDisplayName: "甲",
		direction: "in",
		time: NOW,
		segments: [{ type: "text", text: "原文" }],
		source: "platform",
		...overrides,
	});
}

/* ---------- P5.1 send ---------- */

describe("send 发送积木（T08 前置）", () => {
	it("文本分段复用 speak 链路：私聊/群路由正确，回执携带外发消息引用", async () => {
		const toPrivate = await call("send", {
			conversationRef: P1,
			content: [{ type: "text", text: "你好" }],
		});
		expect(toPrivate.status).toBe("succeeded");
		expect(calls[0]!.action).toBe("send_private_msg");
		expect(String(toPrivate.result)).toContain("messageRef=m777");

		await call("send", { conversationRef: G1, content: [{ type: "text", text: "群发" }] });
		expect(calls[1]!.action).toBe("send_group_msg");
		expect((calls[1]!.params as { group_id?: number }).group_id).toBe(30001);
	});

	it("design 形状 path 映射为 staging 资源，平台收到 file URI", async () => {
		const root = join(dir, "allowed");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "pic.png"), "png-bytes", "utf8");
		journal.appendMessage({
			ref: "m1",
			conversationRef: P1,
			senderRef: userRef("20002"),
			senderDisplayName: "甲",
			direction: "in",
			time: NOW,
			segments: [{ type: "text", text: "hi" }],
			source: "platform",
		});
		const result = await call("send", {
			conversationRef: P1,
			content: [
				{ type: "text", text: "看图" },
				{ type: "image", path: join(root, "pic.png") },
			],
		});
		expect(result.status).toBe("succeeded");
		const wire = (calls[0]!.params as { message: { type: string; data: { file?: string } }[] }).message;
		expect(wire[0]!.type).toBe("text");
		expect(wire[1]!.type).toBe("image");
		// 已换算为 staging 内的 file URI，而非原 allowedRoots 路径。
		expect(wire[1]!.data.file).toMatch(/^file:\/\//);
		expect(decodeURIComponent(wire[1]!.data.file!)).toContain("/staging/");
	});

	it("未授 messaging 拒绝且平台调用为 0；replyTo 非本会话拒绝", async () => {
		deps = { ...deps, grants: { grants: ["observation"] } as DeploymentGrants };
		const denied = await call("send", { conversationRef: P1, content: [{ type: "text", text: "x" }] });
		expect(denied.status).toBe("failed");
		expect(calls).toHaveLength(0);

		deps = { ...deps, grants: { grants: ["messaging"] } as DeploymentGrants };
		const foreign = message(); // G1 的消息
		const mismatch = await call("send", {
			conversationRef: P1,
			content: [{ type: "text", text: "x" }],
			replyTo: foreign.ref,
		});
		expect(mismatch.status).toBe("failed");
		expect(calls).toHaveLength(0);
	});
});

/* ---------- P5.2 interact ---------- */

describe("interact 互动积木", () => {
	it("poke 路由 group_poke 并携带目标用户", async () => {
		const result = await call("interact", {
			action: "poke",
			conversationRef: G1,
			userRef: userRef("20002"),
		});
		expect(result.status).toBe("succeeded");
		expect(calls[0]!.action).toBe("group_poke");
		expect(calls[0]!.params).toMatchObject({ group_id: 30001, user_id: 20002 });
	});

	it("react 复用 gesture：仅群消息，is_set 固定为置上", async () => {
		message();
		const result = await call("interact", {
			action: "react",
			messageRef: "m501",
			reactionCode: "128077",
		});
		expect(result.status).toBe("succeeded");
		expect(calls[0]!.action).toBe("set_group_reaction");
		expect(calls[0]!.params).toMatchObject({ message_id: 501, code: "128077", is_set: true });
	});

	it("retract 复用 account 链路：自身发言可撤，他人消息拒绝", async () => {
		message({ ref: "m600", direction: "out", senderRef: userRef(SELF) });
		const ok = await call("interact", { action: "retract", messageRef: "m600" });
		expect(ok.status).toBe("succeeded");
		expect(calls[0]!.action).toBe("delete_msg");

		message({ ref: "m601", direction: "in", senderRef: userRef("20002") });
		const denied = await call("interact", { action: "retract", messageRef: "m601" });
		expect(denied.status).toBe("failed");
		expect(calls).toHaveLength(1); // 拒绝未产生新平台调用
	});

	it("retract 需要 messages.retract grant；未知 action 显式失败", async () => {
		deps = { ...deps, grants: { grants: ["interaction"] } as DeploymentGrants };
		message({ ref: "m600", direction: "out", senderRef: userRef(SELF) });
		const denied = await call("interact", { action: "retract", messageRef: "m600" });
		expect(denied.status).toBe("failed");
		expect(calls).toHaveLength(0);
		const bad = await call("interact", { action: "hug" });
		expect(bad.status).toBe("failed");
	});
});

/* ---------- P5.3 remind ---------- */

describe("remind 提醒积木", () => {
	it("create/list/resolve 全生命周期；f{n} 空间沿用", async () => {
		const empty = await call("remind", {});
		expect(empty.status).toBe("succeeded");
		expect(String(empty.result)).toMatch(/无 open 事项/);

		const created = await call("remind", {
			action: "create",
			targetRef: P1,
			note: "回看小明说的报价",
			reviewAt: "2026-10-12T09:00:00Z",
		});
		expect(created.status).toBe("succeeded");
		expect(String(created.result)).toContain("ref=f1");

		const listed = await call("remind", { action: "list" });
		expect(String(listed.result)).toContain("f1");
		expect(String(listed.result)).toContain("回看小明说的报价");

		const resolved = await call("remind", { action: "resolve", remindRef: "f1", resolution: "已回复报价" });
		expect(resolved.status).toBe("succeeded");
		expect(String(resolved.result)).toContain("state=closed");

		const again = await call("remind", { action: "resolve", remindRef: "f1", resolution: "重复" });
		expect(again.status).toBe("failed");
	});

	it("resolve 不存在的事项 not_found；create 需要 follow_up.manage", async () => {
		const missing = await call("remind", { action: "resolve", remindRef: "f9", resolution: "x" });
		expect(missing.status).toBe("failed");
		deps = { ...deps, grants: { grants: [] } as DeploymentGrants };
		const denied = await call("remind", { action: "create", targetRef: P1, note: "x" });
		expect(denied.status).toBe("failed");
	});
});

/* ---------- P5.4 requests ---------- */

describe("requests 审批积木", () => {
	function request(ref = "r1"): void {
		journal.appendRequest({
			platformFlag: `flag-${ref}`,
			ref,
			kind: "friend",
			state: "pending",
			requesterRef: userRef("20002"),
			requesterDisplayName: "小明",
			comment: "加个好友",
			time: NOW,
		});
	}

	it("list 汇集本地申请事实（观察授权）", async () => {
		request();
		const result = await call("requests", {});
		expect(result.status).toBe("succeeded");
		expect(String(result.result)).toContain("r1");
		expect(String(result.result)).toContain("pending");
	});

	it("respond accept 复用 respond_request：approve=true 上平台", async () => {
		request();
		const result = await call("requests", { action: "respond", requestRef: "r1", decision: "accept" });
		expect(result.status).toBe("succeeded");
		expect(calls[0]!.action).toBe("set_friend_add_request");
		expect(calls[0]!.params).toMatchObject({ flag: "flag-r1", approve: true });
	});

	it("respond decline 携带本地备注；重复处理拒绝", async () => {
		request();
		const declined = await call("requests", {
			action: "respond",
			requestRef: "r1",
			decision: "decline",
			reason: "暂时不加",
		});
		expect(declined.status).toBe("succeeded");
		expect(calls[0]!.params).toMatchObject({ approve: false });
		expect(String(declined.result)).toContain("本地备注");
		expect(String(declined.result)).toContain("暂时不加");

		const repeat = await call("requests", { action: "respond", requestRef: "r1", decision: "accept" });
		expect(repeat.status).toBe("failed");
	});

	it("respond 需要 requests.respond grant；未知申请 not_found", async () => {
		deps = { ...deps, grants: { grants: ["observation"] } as DeploymentGrants };
		request();
		const denied = await call("requests", { action: "respond", requestRef: "r1", decision: "accept" });
		expect(denied.status).toBe("failed");
		expect(calls).toHaveLength(0);
		deps = { ...deps, grants: { grants: ["requests.respond"] } as DeploymentGrants };
		const unknown = await call("requests", { action: "respond", requestRef: "r9", decision: "accept" });
		expect(unknown.status).toBe("failed");
	});
});

/* ---------- P5.5 profile ---------- */

describe("profile 资料积木", () => {
	it("get 复用 observe self：get_login_info 并呈现 u 引用", async () => {
		respond = () => ({ status: "ok", data: { user_id: 10001, nickname: "测试号" } });
		const result = await call("profile", {});
		expect(result.status).toBe("succeeded");
		expect(calls[0]!.action).toBe("get_login_info");
		expect(String(result.result)).toContain("u10001");
	});

	it("set_card / set_profile 复用 account 链路", async () => {
		const card = await call("profile", { action: "set_card", conversationRef: G1, card: "小测" });
		expect(card.status).toBe("succeeded");
		expect(calls[0]!.action).toBe("set_group_card");
		expect(calls[0]!.params).toMatchObject({ group_id: 30001, user_id: Number(SELF), card: "小测" });

		const profile = await call("profile", { action: "set_profile", nickname: "新昵称" });
		expect(profile.status).toBe("succeeded");
		expect(calls[1]!.action).toBe("set_qq_profile");
		expect(calls[1]!.params).toMatchObject({ nickname: "新昵称" });
	});

	it("写操作需要 profile.modify；get 需要 observation", async () => {
		deps = { ...deps, grants: { grants: [] } as DeploymentGrants };
		const deniedCard = await call("profile", { action: "set_card", conversationRef: G1, card: "x" });
		expect(deniedCard.status).toBe("failed");
		const deniedGet = await call("profile", {});
		expect(deniedGet.status).toBe("failed");
		expect(calls).toHaveLength(0);
	});
});
