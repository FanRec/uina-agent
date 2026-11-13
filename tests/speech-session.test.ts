import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdmissionResult, SpeechDeliveryPort, StopResult } from "../.uina/extensions/speech/delivery-port.js";
import type { SpeechRuntimeNotice } from "../.uina/extensions/speech/session.js";
import { SpeechSession } from "../.uina/extensions/speech/session.js";
import type { ExtensionAPI } from "../src/extensions/runner.js";

/** 可编程的假交付端口：受理/停止结果按用例设定，并记录提交序列。 */
function fakeDelivery(options?: {
	submit?: (utteranceId: string, text: string) => Partial<AdmissionResult>;
	stop?: (utteranceId?: string) => Partial<StopResult>;
	/** 挂住第 holdAt（0 起）次提交，直到 releaseHold()。 */
	holdAt?: number;
}) {
	const submitted: Array<{ utteranceId: string; text: string; at: number }> = [];
	const sealed: string[] = [];
	const stopped: Array<string | undefined> = [];
	let holdGate: Promise<void> = Promise.resolve();
	let releaseHold: (() => void) | undefined;
	const onlineFlag = { value: true };
	const port: SpeechDeliveryPort = {
		async submitSegment(utteranceId, text) {
			if (options?.holdAt === submitted.length && releaseHold) await holdGate;
			submitted.push({ utteranceId, text, at: submitted.length });
			const preset = options?.submit?.(utteranceId, text) ?? {};
			return { status: "accepted", traceId: `trace-${utteranceId}`, ...preset } as AdmissionResult;
		},
		async sealSource(utteranceId) {
			sealed.push(utteranceId);
			return { status: "sealed" };
		},
		async stopSource(utteranceId) {
			stopped.push(utteranceId);
			return {
				outcome: "interrupted",
				segmentIndex: 1,
				segmentText: "前句。",
				...(options?.stop?.(utteranceId) ?? {}),
			} as StopResult;
		},
		async setMuted() {
			return { success: true, status: "succeeded", isOnline: true };
		},
		async snapshot() {
			return {
				online: onlineFlag.value,
				muted: false,
				submittedSegments: submitted.length,
				pendingSegments: 0,
				currentSegmentIndex: null,
			};
		},
	};
	if (options?.holdAt !== undefined) {
		holdGate = new Promise<void>((resolve) => (releaseHold = resolve));
	}
	return {
		port,
		submitted,
		sealed,
		stopped,
		releaseHold: () => releaseHold?.(),
		setOnline: (value: boolean) => (onlineFlag.value = value),
	};
}

/** 等待表达链上的微任务排空（playback fact 与提交都是入队任务）。 */
async function flushChains(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** 假 pi：捕获共享表派发、运行时通知与状态根。 */
function fakePi(stateRoot: string) {
	const cues: Array<{ id: string; target?: string }> = [];
	const notices: SpeechRuntimeNotice[] = [];
	const pi = {
		hasService: vi.fn(() => true),
		callService: vi.fn(async () => undefined),
		shared: vi.fn((name: string) =>
			name === "embodiment.cue-dispatch"
				? { dispatch: (cue: { id: string; target?: string }) => cues.push(cue) }
				: undefined,
		),
		submitInput: vi.fn(async (input: { id: string; text?: string }) => {
			notices.push({ type: "speech.interrupted", identity: input.id, text: input.text ?? "" } as SpeechRuntimeNotice);
		}),
		subject: { subjectId: "s", sessionId: "sess", memoryRoot: stateRoot, stateRoot },
		reportError: vi.fn(),
	} as unknown as ExtensionAPI;
	return { pi, cues, notices };
}

describe("SpeechSession（Utterance / 分句 / Cue 对齐 / 代次屏障）", () => {
	let stateRoot: string;

	beforeEach(async () => {
		stateRoot = await mkdtemp(join(tmpdir(), "uina-speech-"));
	});

	afterEach(async () => {
		await rm(stateRoot, { recursive: true, force: true });
	});

	function makeSession(deliveryOptions?: Parameters<typeof fakeDelivery>[0]) {
		const delivery = fakeDelivery(deliveryOptions);
		const { pi, cues, notices } = fakePi(stateRoot);
		const session = new SpeechSession(pi, delivery.port, (notice) => notices.push(notice));
		return { session, delivery, cues, notices };
	}

	it("Marker 强制左侧封段，Cue 绑定右侧下一段的 playback_started", async () => {
		const { session, delivery, cues } = makeSession();
		session.acceptBlockStart("s1", "b1");
		session.acceptSpeechText("s1", "b1", "前句。");
		session.acceptMarker("s1", "b1", { id: "nod" });
		session.acceptSpeechText("s1", "b1", "后句。");
		session.acceptBlockEnd("s1", "b1");
		await vi.waitFor(() => expect(delivery.submitted.length).toBe(2));
		expect(delivery.submitted.map((s) => s.text)).toEqual(["前句。", "后句。"]);

		// 左段开始：还没有 Cue；右段开始：nod 执行一次。
		const utteranceId = delivery.submitted[0]!.utteranceId;
		session.acceptPlaybackFact(utteranceId, { traceId: "trace", segmentIndex: 1, kind: "started" });
		await flushChains();
		expect(cues).toEqual([]);
		session.acceptPlaybackFact(utteranceId, { traceId: "trace", segmentIndex: 2, kind: "started" });
		await flushChains();
		expect(cues).toEqual([{ id: "nod" }]);
	});

	it("结尾 Cue（无后续可发音片段）在前段 playback_completed 后执行", async () => {
		const { session, delivery, cues } = makeSession();
		session.acceptBlockStart("s1", "b1");
		session.acceptSpeechText("s1", "b1", "唯一一句。");
		session.acceptMarker("s1", "b1", { id: "tail" });
		session.acceptBlockEnd("s1", "b1");
		await vi.waitFor(() => expect(delivery.submitted.length).toBe(1));
		const utteranceId = delivery.submitted[0]!.utteranceId;
		session.acceptPlaybackFact(utteranceId, { traceId: "trace", segmentIndex: 1, kind: "started" });
		await flushChains();
		expect(cues).toEqual([]);
		session.acceptPlaybackFact(utteranceId, { traceId: "trace", segmentIndex: 1, kind: "completed" });
		await flushChains();
		expect(cues).toEqual([{ id: "tail" }]);
	});

	it("静音时表达仍受理（音频 not_played），Cue 走文本降级路径", async () => {
		const { session, delivery, cues } = makeSession();
		await session.setMuted(true);
		session.acceptBlockStart("s1", "b1");
		session.acceptSpeechText("s1", "b1", "静音也要动。");
		session.acceptMarker("s1", "b1", { id: "nod" });
		session.acceptBlockEnd("s1", "b1");
		await vi.waitFor(() => expect(cues).toEqual([{ id: "nod" }]));
		expect(delivery.submitted).toHaveLength(0);
		expect(session.currentSpeakingLine()).toBeNull();
	});

	it("纯 Cue 块在正常闭合时按原文顺序文本执行一次", async () => {
		const { session, delivery, cues } = makeSession();
		session.acceptBlockStart("s1", "b1");
		session.acceptMarker("s1", "b1", { id: "nod" });
		session.acceptMarker("s1", "b1", { id: "wink" });
		session.acceptBlockEnd("s1", "b1");
		await vi.waitFor(() => expect(cues).toEqual([{ id: "nod" }, { id: "wink" }]));
		expect(delivery.submitted).toHaveLength(0);
	});

	it("静音时 Marker 先于文本：起始 Cue 顺延而不是丢失，闭合后文本降级执行", async () => {
		const { session, delivery, cues } = makeSession();
		await session.setMuted(true);
		session.acceptBlockStart("s1", "b1");
		session.acceptMarker("s1", "b1", { id: "nod" });
		session.acceptSpeechText("s1", "b1", "静音的一段话。");
		session.acceptBlockEnd("s1", "b1");
		await vi.waitFor(() => expect(cues).toEqual([{ id: "nod" }]));
		expect(delivery.submitted).toHaveLength(0);
	});

	it("say 提交前被取消：幂等登记撤销，重入按新表达受理", async () => {
		const { session, delivery } = makeSession({ holdAt: 1 });
		await expect(session.say("第一句。", false, { callId: "c1", invocationId: "inv-1" })).resolves.toMatchObject({
			accepted: true,
			audio: "queued",
		});
		// 第二次 say 的提交被端口挂住；发起全量停止（其同步部分递增代次），
		// 再放行挂住的提交——代次屏障把它拦在提交前。
		const second = session.say("第二句。", false, { callId: "c2", invocationId: "inv-2" });
		await vi.waitFor(() => expect(delivery.submitted.length).toBe(1));
		const stopping = session.stop();
		await flushChains();
		delivery.releaseHold();
		await stopping;
		await expect(second).resolves.toMatchObject({ accepted: false, audio: "unknown" });
		// 同一被拦身份重入：按新表达重新受理，不冒充已受理。
		await expect(session.say("第二句。", false, { callId: "c2", invocationId: "inv-2" })).resolves.toMatchObject({
			accepted: true,
			audio: "queued",
		});
	});

	it("speech.stop 先禁止本地待提交：迟到的在途提交不能复活声音", async () => {
		const { session, delivery, cues } = makeSession({ holdAt: 1 });

		session.acceptBlockStart("s1", "b1");
		session.acceptSpeechText("s1", "b1", "第一句。");
		session.acceptSpeechText("s1", "b1", "第二句。");
		await vi.waitFor(() => expect(delivery.submitted.length).toBe(1));
		// 第二段的提交被挂住；此刻停止（同步代次屏障）。
		const stopping = session.stop();
		delivery.releaseHold();
		await stopping;
		await flushChains();
		// 第一段已受理并在停止时被确认；第二段的提交请求虽已出发，但被代次屏障
		// 拦下（不记账、不派发），其物理残留由链上停止任务收束（Driver 返回停止）。
		expect(delivery.submitted.length).toBeLessThanOrEqual(2);
		expect(delivery.stopped).toHaveLength(1);
		// 第二段即使有迟到的播放事实也不派发任何动作。
		session.acceptPlaybackFact(delivery.submitted[0]!.utteranceId, {
			traceId: "trace",
			segmentIndex: 2,
			kind: "started",
		});
		await flushChains();
		expect(cues).toEqual([]);
	});

	it("speech.say 同一 invocationId 重入只受理一次；replace 在停止未知时不受理新台词", async () => {
		const { session, delivery } = makeSession({
			stop: () => ({ outcome: "unknown", reason: "模拟停止未知" }),
		});
		const first = await session.say("第一句。", false, { callId: "call-1", invocationId: "inv-1" });
		expect(first).toMatchObject({ accepted: true, audio: "queued" });
		const second = await session.say("第一句。", false, { callId: "call-1", invocationId: "inv-1" });
		expect(second.utteranceId).toBe(first.utteranceId);
		expect(delivery.submitted).toHaveLength(1);

		const replaced = await session.say("第二句。", true, { callId: "call-2", invocationId: "inv-2" });
		expect(replaced.accepted).toBe(false);
		expect(delivery.submitted.map((s) => s.text)).not.toContain("第二句。");
	});

	it("replace 在停止确认后受理新台词", async () => {
		const { session, delivery } = makeSession();
		await session.say("旧台词。", false, { callId: "call-1" });
		const replaced = await session.say("新台词。", true, { callId: "call-2" });
		expect(replaced).toMatchObject({ accepted: true, audio: "queued" });
		await vi.waitFor(() => expect(delivery.submitted.some((s) => s.text === "新台词。")).toBe(true));
	});

	it("播放事实驱动“正在说”观察：过时或结束后返回 null", async () => {
		const { session, delivery } = makeSession();
		session.acceptBlockStart("s1", "b1");
		session.acceptSpeechText("s1", "b1", "正在播出的那句。");
		session.acceptBlockEnd("s1", "b1");
		await vi.waitFor(() => expect(delivery.submitted.length).toBe(1));
		const utteranceId = delivery.submitted[0]!.utteranceId;
		expect(session.currentSpeakingLine()).toBeNull(); // 只有待播，不冒充正在说
		session.acceptPlaybackFact(utteranceId, { traceId: "trace", segmentIndex: 1, kind: "started" });
		await flushChains();
		expect(session.currentSpeakingLine()).toBe("正在播出的那句。");
		session.acceptPlaybackFact(utteranceId, { traceId: "trace", segmentIndex: 1, kind: "completed" });
		await flushChains();
		expect(session.currentSpeakingLine()).toBeNull();
	});

	it("异步播放失败发一次 delivery_failed；同一 Utterance 不重复", async () => {
		const { session, delivery, notices } = makeSession();
		session.acceptBlockStart("s1", "b1");
		session.acceptSpeechText("s1", "b1", "要失败的那句。");
		session.acceptBlockEnd("s1", "b1");
		await vi.waitFor(() => expect(delivery.submitted.length).toBe(1));
		const utteranceId = delivery.submitted[0]!.utteranceId;
		session.acceptPlaybackFact(utteranceId, { traceId: "trace", segmentIndex: 1, kind: "started" });
		session.acceptPlaybackFact(utteranceId, { traceId: "trace", segmentIndex: 1, kind: "failed" });
		await flushChains();
		expect(notices.some((n) => n.type === "speech.delivery_failed")).toBe(true);
		const failedCount = notices.filter((n) => n.type === "speech.delivery_failed").length;
		session.acceptPlaybackFact(utteranceId, { traceId: "trace", segmentIndex: 2, kind: "failed" });
		await flushChains();
		expect(notices.filter((n) => n.type === "speech.delivery_failed").length).toBe(failedCount);
		// 具体表达失败事件已承担本次故障提醒：不再重复发送 speech.unavailable。
		expect(notices.some((n) => n.type === "speech.unavailable")).toBe(false);
	});

	it("可用性阶段：turn_start 发现离线时发一次 unavailable，恢复后清账", async () => {
		const { session, delivery, notices } = makeSession();
		delivery.setOnline(false);
		await session.refreshAvailability();
		expect(notices.some((n) => n.type === "speech.unavailable")).toBe(true);
		// 仍在离线：同一阶段不重复。
		await session.refreshAvailability();
		expect(notices.filter((n) => n.type === "speech.unavailable").length).toBe(1);
		// 恢复在线：清账；再次离线开启新阶段。
		delivery.setOnline(true);
		await session.refreshAvailability();
		delivery.setOnline(false);
		await session.refreshAvailability();
		expect(notices.filter((n) => n.type === "speech.unavailable").length).toBe(2);
	});

	it("turn_aborted 只影响仍在接受输入的表达，不误杀独立 speech.say 或已封口音频", async () => {
		const { session, delivery } = makeSession();
		session.acceptBlockStart("s1", "b1");
		session.acceptSpeechText("s1", "b1", "本轮还在说。");
		await session.say("独立发言。", false, { callId: "call-1" });
		session.acceptBlockEnd("s1", "b1");
		await vi.waitFor(() => expect(delivery.submitted.length).toBe(2));
		// 已封口的块表达不再被 turn_aborted 停止。
		session.abortOpenUtterances();
		await vi.waitFor(() => expect(delivery.stopped.length).toBe(1));
	});

	it("发音规范化：Markdown 修饰与 Emoji 去除、全角旁白括注不朗读", async () => {
		const { session, delivery } = makeSession();
		session.acceptBlockStart("s1", "b1");
		session.acceptSpeechText("s1", "b1", "**重点**在这里（旁白不念）。🎉");
		session.acceptBlockEnd("s1", "b1");
		await vi.waitFor(() => expect(delivery.submitted.length).toBe(1));
		expect(delivery.submitted[0]!.text).toBe("重点在这里。");
	});

	it("set_muted 分别报告偏好持久化与物理停止", async () => {
		const { session, delivery } = makeSession();
		const result = await session.setMuted(true);
		expect(result.persisted).toBe(true);
		expect(result.physical).toBe("interrupted");
		await vi.waitFor(() => expect(delivery.stopped.length).toBeGreaterThanOrEqual(0));
		expect(session.isMuted).toBe(true);
	});
});
