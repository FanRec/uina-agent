import { describe, expect, it } from "vitest";
import type { PromptSnapshotRecord } from "../src/session/prompt-snapshots.js";
import { TranscriptContainer } from "../src/ui/components/transcript/transcript.js";
import { stripAnsi } from "../src/ui/core/utils.js";

describe("提示词与外部注入卡片回放", () => {
	it("回放时外部运行时输入显示为卡片而不是人类气泡，并保留提示词快照顺序", () => {
		const transcript = new TranscriptContainer();
		const snapshot: PromptSnapshotRecord = {
			id: "snap-1",
			seq: 2,
			timestamp: "2026-10-04T00:00:00.000Z",
			turnNumber: 1,
			fingerprint: "fp",
			systemPrompt: "你是一个会持续存在的主体。",
			injections: [{ extension: "world", kind: "messages", chars: 12, preview: "世界事件", messageCount: 1 }],
		};
		transcript.loadSession(
			[
				{
					kind: "input",
					id: "external-1",
					seq: 1,
					timestamp: snapshot.timestamp,
					input: {
						id: "external-1",
						order: 1,
						mode: "followUp",
						text: "外部事件正文",
						source: { kind: "runtime", type: "chat", origin: "external" },
					},
				},
				{
					kind: "message",
					id: "m1",
					seq: 3,
					timestamp: snapshot.timestamp,
					message: { role: "assistant", content: "收到" },
				},
			],
			[],
			[],
			[snapshot],
		);
		const rendered = stripAnsi(transcript.render(100).join("\n"));
		expect(rendered).toContain("外部注入");
		expect(rendered).toContain("提示词变更");
		expect(rendered).toContain("外部事件正文");
		expect(rendered).not.toContain("❯ 外部事件正文");
		expect(rendered.indexOf("外部注入")).toBeLessThan(rendered.indexOf("提示词变更"));
	});

	it("回放 custom_message 时保留图片元数据", () => {
		const transcript = new TranscriptContainer();
		transcript.loadSession(
			[
				{
					kind: "custom_message",
					id: "cm1",
					seq: 1,
					timestamp: "2026-10-04T00:00:00.000Z",
					customType: "vision",
					content: "看图",
					images: [{ type: "image", mimeType: "image/png", data: "abc" }],
				},
			],
			[],
		);
		expect(stripAnsi(transcript.render(80).join("\n"))).toContain("image/png");
	});
	it("当前回合中插入卡片不会截断后续模型输出", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "任务");
		transcript.appendToken("前半段");
		transcript.addPromptSnapshot({
			kind: "prompt",
			turnNumber: 1,
			systemPrompt: "更新后的提示词",
			injections: [],
		});
		transcript.appendToken("后半段");
		const rendered = stripAnsi(transcript.render(100).join("\n"));
		expect(rendered).toContain("前半段");
		expect(rendered).toContain("后半段");
	});
	it("普通用户回合中的快照不会把助手回复拆成空轮次", () => {
		const transcript = new TranscriptContainer();
		transcript.loadSession(
			[
				{
					kind: "input",
					id: "u1",
					seq: 1,
					timestamp: "2026-10-04T00:00:00.000Z",
					input: { id: "u1", order: 1, mode: "followUp", text: "用户问题" },
				},
				{
					kind: "message",
					id: "a1",
					seq: 3,
					timestamp: "2026-10-04T00:00:00.000Z",
					message: { role: "assistant", content: "助手回答" },
				},
			],
			[],
			[],
			[
				{
					id: "snap",
					seq: 2,
					timestamp: "2026-10-04T00:00:00.000Z",
					turnNumber: 1,
					fingerprint: "fp",
					systemPrompt: "BASE",
					injections: [],
				},
			],
		);
		expect(transcript.getHistory()).toHaveLength(1);
		expect(transcript.getHistory()[0]?.userText).toBe("用户问题");
		expect(stripAnsi(transcript.render(100).join("\n"))).toContain("助手回答");
	});
});
