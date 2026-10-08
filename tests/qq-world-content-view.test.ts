import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { QqIngestion } from "../.uina/worlds/qq/src/ingest.js";
import { decodeOneBotMessage, decodeOneBotSegments } from "../.uina/worlds/qq/src/message-codec.js";
import { expandImages, imageSourcesFromFacts, imageSourcesFromOneBot } from "../.uina/worlds/qq/src/media-fetch.js";
import {
	followUpRow,
	operationRecordLines,
	receipt,
	renderBatch,
	renderConversationPage,
	renderForwardNodes,
	renderMessageFacts,
	requestRow,
	segmentText,
	TimeView,
} from "../.uina/worlds/qq/src/render.js";

describe("QQ normalized content and correspondence", () => {
	let dir: string;
	let journal: FactsJournal;
	let ingest: QqIngestion;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "qq-content-view-"));
		journal = new FactsJournal({ dataDir: dir, selfId: "10001" });
		journal.recover();
		ingest = new QqIngestion("10001", journal);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.unstubAllGlobals();
	});
	function message(message: unknown, id: number | string = 1): void {
		ingest.handleEvent({
			post_type: "message",
			self_id: 10001,
			message_type: "group",
			group_id: 30003,
			message_id: id,
			user_id: 20002,
			sender: { user_id: 20002, nickname: "甲" },
			time: 1791378000,
			message,
		});
	}
	it("string ids, CQ replies, mention names and unknown segments survive ingestion", () => {
		message("号码20002 [CQ:reply,id=-2][CQ:face,id=14][CQ:at,qq=20003,name=乙][CQ:vendor,x=1]", "1");
		expect(journal.getMessage("m1")).toMatchObject({
			replyTo: "m-2",
			segments: [
				{ type: "text", text: "号码20002 " },
				{ type: "face", faceId: "14" },
				{ type: "mention", userRef: "u20003", displayName: "乙" },
				{ type: "unknown", rawType: "vendor" },
			],
		});
	});
	it("group recall preserves operator and author separately; private recall keeps its peer", () => {
		ingest.handleEvent({
			post_type: "notice",
			notice_type: "group_recall",
			time: 1791378000,
			group_id: 30003,
			user_id: 20002,
			operator_id: 20003,
			message_id: 1,
		});
		expect(journal.snapshot.events.get("g30003")?.[0]).toMatchObject({
			actorRef: "u20003",
			authorRef: "u20002",
			messageRef: "m1",
		});
		ingest.handleEvent({
			post_type: "notice",
			notice_type: "friend_recall",
			time: 1791378000,
			user_id: 20002,
			message_id: 2,
		});
		expect(journal.snapshot.events.get("p20002")?.[0]).toMatchObject({ kind: "recall", messageRef: "m2" });
	});
	it("poke actor and reaction deltas preserve real platform fields", () => {
		ingest.handleEvent({
			post_type: "notice",
			notice_type: "notify",
			sub_type: "poke",
			time: 1791378000,
			user_id: 20002,
			sender_id: 10001,
			target_id: 20002,
			action: "拍了拍",
			suffix: "肩膀",
		});
		expect(journal.snapshot.events.get("p20002")?.[0]).toMatchObject({
			actorRef: "u10001",
			targetRef: "u20002",
			action: "拍了拍",
			suffix: "肩膀",
		});
		ingest.handleEvent({
			post_type: "notice",
			notice_type: "group_msg_emoji_like",
			sub_type: "remove",
			time: 1791378000,
			group_id: 30003,
			operator_id: 20002,
			message_id: 1,
			likes: [{ emoji_id: "14", count: 2 }],
		});
		expect(journal.snapshot.events.get("g30003")?.[0]).toMatchObject({
			reaction: { operation: "remove", likes: [{ code: "14", count: 2 }] },
		});
	});
	it("ordinary media hides transport URLs and offers card/media content coordinates", () => {
		message([
			{ type: "json", data: { data: "卡".repeat(300) } },
			{ type: "image", data: { url: "https://secret.test/token", file: "图.png" } },
		]);
		const text = renderMessageFacts([journal.getMessage("m1")!], "10001").join("\n");
		expect(text).not.toContain("secret.test");
		expect(text).toContain('scope="content"');
		expect(text).toContain("segmentIndex=0");
		expect(text).toContain("segmentIndex=1");
		expect(segmentText([{ type: "face", faceId: "14" }], undefined, new Map([["14", "微笑"]]))).toContain("微笑");
	});
	it("forward pages keep every supplied node, its time and reply coordinate", () => {
		const nodes = Array.from({ length: 35 }, (_, i) => ({
			time: 1791378000,
			sender: { user_id: "20002", nickname: "甲" },
			message: [
				{ type: "reply", data: { id: "-2" } },
				{ type: "text", data: { text: `节点${i}` } },
			],
		}));
		const text = renderForwardNodes(nodes, { timezone: "Asia/Shanghai" }).join("\n");
		expect(text).toContain("节点34");
		expect(text).toContain("replyTo=m-2");
		expect(text).toContain("2026-");
	});
	it("historical timezone offset follows the rendered instant", () => {
		const time = new TimeView("America/New_York");
		expect(time.header("2026-01-01T12:00:00Z")).toContain("GMT-05:00");
		expect(time.header("2026-07-01T12:00:00Z")).toContain("GMT-04:00");
	});
	it("external multiline values are quoted once in request, followup and operation rows", () => {
		expect(
			requestRow({
				ref: "r1",
				kind: "friend",
				state: "pending",
				platformFlag: "secret",
				requesterRef: "u2",
				requesterDisplayName: null,
				comment: 'x\n"y',
				time: "2026-01-01T00:00:00Z",
			}),
		).not.toContain("x\n");
		expect(followUpRow({ ref: "f1", state: "open", targetRef: "p2", note: "x\ny", reviewAt: null })).not.toContain(
			"x\n",
		);
		const op = operationRecordLines({
			ref: "o1",
			action: "speak",
			outcome: "unknown",
			reason: "x\ny",
			messageRef: "m1",
			replyTo: "m2",
			partRange: { from: 1, through: 2 },
		}).join("\n");
		expect(op).not.toContain("x\n");
		expect(op).toContain("messageRef=m1");
		expect(op).toContain("replyTo=m2");
		expect(op).toContain("partRange=1..2");
	});
	it("image success and failures retain message, segment and media coordinates", async () => {
		message([
			{ type: "text", data: { text: "图片" } },
			{ type: "image", data: { url: "https://example.test/a.png" } },
		]);
		const sources = imageSourcesFromFacts([journal.getMessage("m1")!]);
		expect(sources[0]).toMatchObject({ messageRef: "m1", segmentIndex: 1, mediaRef: "a1" });
		expect(
			imageSourcesFromOneBot([
				{ message_id: "2", message: [{ type: "image", data: { url: "https://example.test/a.png" } }] },
			])[0],
		).toMatchObject({ messageRef: "m2", segmentIndex: 0 });
		vi.stubGlobal(
			"fetch",
			async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } }),
		);
		const success = await expandImages(sources);
		expect(success.note).toContain("messageRef=m1");
		expect(success.note).toContain("segmentIndex=1");
		expect(success.images[0]?.alt).toContain("a1");
		vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
		const failure = await expandImages(sources);
		expect(failure.note).toContain("messageRef=m1");
		expect(failure.note).toContain("segmentIndex=1");
	});
	it("history hints provide ownership only when raw coordinates do not contradict them", () => {
		const raw = {
			message_id: "9",
			time: 1791378000,
			sender: { user_id: "20002", nickname: "甲" },
			message: [
				{ type: "reply", data: { id: "2" } },
				{ type: "image", data: { url: "https://example.test/a.png" } },
			],
		};
		expect(decodeOneBotMessage(raw, "10001", "g30003")).toMatchObject({
			ref: "m9",
			conversationRef: "g30003",
			sequence: 0,
			source: "history",
			replyTo: "m2",
			segments: [{ type: "image", understood: false }],
		});
		expect(decodeOneBotMessage({ ...raw, message_type: "group", group_id: "30004" }, "10001", "g30003")).toBeNull();
		expect(
			decodeOneBotMessage({ ...raw, message_type: "private", sub_type: "group" }, "10001", "t20002-g30003"),
		).toMatchObject({ conversationRef: "t20002-g30003" });
		expect(decodeOneBotMessage({ ...raw, time: undefined }, "10001", "g30003")).toBeNull();
		expect(decodeOneBotMessage({ ...raw, message_id: Number.MAX_SAFE_INTEGER + 1 }, "10001", "g30003")).toBeNull();
		expect(decodeOneBotSegments("纯文本 u20002 &amp; 不猜关系")).toEqual({
			segments: [{ type: "text", text: "纯文本 u20002 &amp; 不猜关系" }],
		});
		expect(imageSourcesFromOneBot([raw])[0]).toMatchObject({ messageRef: "m9", segmentIndex: 0 });
	});
	it("forward image success and failure preserve all four content coordinates", async () => {
		const source = {
			messageRef: "m1",
			segmentIndex: 2,
			forwardNodeIndex: 35,
			nodeSegmentIndex: 1,
			alt: "转发图片",
			url: "https://example.test/a.png",
		};
		vi.stubGlobal(
			"fetch",
			async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } }),
		);
		const success = await expandImages([source]);
		for (const text of [success.note, success.images[0]!.alt!]) {
			expect(text).toContain("forwardNodeIndex=35");
			expect(text).toContain("nodeSegmentIndex=1");
		}
		vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
		const failure = await expandImages([source]);
		expect(failure.note).toContain("forwardNodeIndex=35");
		expect(failure.note).toContain("nodeSegmentIndex=1");
	});
	it("first scene tail retains an older reply anchor and labels missing originals", () => {
		message([{ type: "text", data: { text: "被引用的原文" } }], 1);
		for (let i = 2; i <= 18; i++) message([{ type: "text", data: { text: `新增${i}` } }], i);
		message(
			[
				{ type: "reply", data: { id: 1 } },
				{ type: "text", data: { text: "引用" } },
			],
			19,
		);
		message([{ type: "reply", data: { id: 999 } }], 20);
		const control = new ControlStore({ dataDir: dir, selfId: "10001" });
		const text = renderBatch(
			{
				key: "ordinary:g30003",
				conversationRef: "g30003",
				cls: "ordinary",
				origin: "external",
				count: 20,
				oldestAt: "2026-10-07T01:00:00Z",
			},
			{ journal, control, now: () => "2026-10-07T01:00:00Z" },
		);
		expect(text).toContain("被引用的原文");
		expect(text).toContain("必要前文");
		expect(text).toContain("replyTo=m999（原文不可用）");
	});
	it("conversation events use the same explicit timezone as message rows", () => {
		const page = renderConversationPage({
			conversationRef: "g30003",
			source: "local",
			direction: "latest",
			time: new TimeView("America/New_York"),
			lines: [],
			events: [{ ref: "e1", kind: "poke", timeIso: "2026-01-01T12:00:00Z", actorRef: "u2", targetRef: "u3" }],
		});
		expect(page.text).toContain("2026-01-01 07:00 | e1");
		expect(page.text).toContain("actor=u2");
		expect(page.text).toContain("target=u3");
	});
	it("successful receipts state the result in plain language without a duplicate status header", () => {
		const text = receipt.ok("sent", ["messageRef=m1"]);
		expect(text).toContain("已发送");
		expect(text).not.toContain("succeeded /");
		expect(text).toContain("messageRef=m1");
	});
	it("forward page node coordinates retain their position in the complete forward", () => {
		const text = renderForwardNodes([{ sender: { user_id: 20002, nickname: "甲" }, message: "页二" }], {}, 20).join(
			"\n",
		);
		expect(text).toContain("nodeIndex=20");
		expect(text).not.toContain("nodeIndex=0");
	});
	it.each(["json", "xml"])("explicit forward content preserves the complete %s payload and quotes once", (type) => {
		const payload = '原\n文"' + "x".repeat(300) + "CARD_END";
		const lines = renderForwardNodes(
			[{ sender: { user_id: 20002, nickname: "甲" }, message: [{ type, data: { data: payload } }] }],
			{},
			20,
		);
		const node = lines.find((line) => line.includes("nodeIndex=20"))!;
		expect(node).toContain("CARD_END");
		expect(node).not.toContain("[truncated]");
		const content = JSON.parse(node.slice(node.indexOf("：") + 1)) as string;
		expect(content).toContain('原\n文"');
		expect(content.endsWith("CARD_END")).toBe(true);
	});
	it.each(["json", "xml"])("ordinary %s preview is counted as partial even within the text budget", (type) => {
		message([{ type, data: { data: "x".repeat(300) + "CARD_END" } }], 1);
		message([{ type: "text", data: { text: "完整文字" } }], 2);
		const control = new ControlStore({ dataDir: dir, selfId: "10001" });
		const text = renderBatch(
			{
				key: "ordinary:g30003",
				conversationRef: "g30003",
				cls: "ordinary",
				origin: "external",
				count: 2,
				oldestAt: "2026-10-07T01:00:00Z",
			},
			{ journal, control, now: () => "2026-10-07T01:00:00Z", display: { batchBudgetChars: 14000 } },
		);
		expect(text).not.toContain("CARD_END");
		expect(text).toContain("[truncated]");
		expect(text).toContain("完整呈现 1 条，部分呈现 1 条");
		expect(text).toContain("hasMore=true");
		expect(text).not.toContain("因预算截断");
		expect(text).toContain('scope="content" messageRef=m1 segmentIndex=0');
	});
});
