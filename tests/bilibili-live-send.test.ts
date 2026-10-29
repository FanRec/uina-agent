// A5：sendDanmaku 外部取消信号透传——中止后弹幕是否送达未知，结果如实报告 unknown。
import { describe, expect, it, vi } from "vitest";
import { type SendDanmakuOptions, sendDanmaku } from "../.uina/worlds/bilibili-live/src/send.js";

function newAbortError(): Error {
	const error = new Error("This operation was aborted");
	error.name = "AbortError";
	return error;
}

function hangingFetch(): { release: () => void; fetchFn: typeof fetch } {
	let release!: () => void;
	let fail!: (error: Error) => void;
	const promise = new Promise<Response>((resolve, reject) => {
		release = () => resolve(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
		fail = reject;
	});
	const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
		init?.signal?.addEventListener("abort", () => fail(newAbortError()), { once: true });
		return promise;
	}) as unknown as typeof fetch;
	return { release, fetchFn };
}

function baseOptions(overrides: Partial<SendDanmakuOptions> = {}): SendDanmakuOptions {
	return {
		roomId: 1,
		message: "hello",
		sessdata: "s",
		biliJct: "j",
		timeoutMs: 5000,
		...overrides,
	};
}

describe("sendDanmaku 外部取消信号", () => {
	it("fetch 挂起时外部 abort：立即返回 unknown，不等超时", async () => {
		const { fetchFn, release } = hangingFetch();
		const controller = new AbortController();

		const work = sendDanmaku(baseOptions({ fetchFn, signal: controller.signal }));
		controller.abort();
		const outcome = await work;

		expect(outcome.status).toBe("unknown");
		expect(outcome.message).toContain("已取消等待");
		release(); // 释放挂起的 promise（其拒绝已由 sendDanmaku 消费）
	});

	it("外部信号先于调用前已中止：不派发请求，如实返回 not_started", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchFn = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));

		const outcome = await sendDanmaku(baseOptions({ fetchFn, signal: controller.signal }));

		expect(fetchFn).not.toHaveBeenCalled();
		expect(outcome.status).toBe("not_started");
	});

	it("无外部信号时超时中止仍走原路径（unknown + 超时文案）", async () => {
		const fetchFn = vi.fn(
			(_input: string | Request | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(newAbortError()), { once: true });
				}),
		) as unknown as typeof fetch;

		const outcome = await sendDanmaku(baseOptions({ fetchFn, timeoutMs: 20 }));

		expect(outcome.status).toBe("unknown");
		expect(outcome.message).toContain("超时");
	});
});
