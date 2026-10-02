import { describe, expect, it } from "vitest";
import { executeCancelActions, resolveCancelActions, type CancelState } from "../src/cli/cancel-decision.js";

const state = (overrides: Partial<CancelState> = {}): CancelState => ({
	busy: false,
	execRunning: false,
	cancellationPending: false,
	queuedCount: 0,
	...overrides,
});

describe("resolveCancelActions：ctrl+c 阶梯", () => {
	it("工作态首次按下：挂起标记 → （有队列时）退回队列 → 打断", () => {
		expect(resolveCancelActions("ctrl+c", state({ busy: true }))).toEqual([
			{ kind: "arm-pending", debounceMs: 2000 },
			{ kind: "interrupt" },
		]);
		expect(resolveCancelActions("ctrl+c", state({ busy: true, queuedCount: 2 }))).toEqual([
			{ kind: "arm-pending", debounceMs: 2000 },
			{ kind: "restore-queue" },
			{ kind: "interrupt" },
		]);
	});

	it("工作态标记已挂起：连击强退", () => {
		expect(resolveCancelActions("ctrl+c", state({ busy: true, cancellationPending: true }))).toEqual([
			{ kind: "force-exit" },
		]);
	});

	it("空闲但直跑命令在执行：只中止命令，不退出", () => {
		expect(resolveCancelActions("ctrl+c", state({ execRunning: true }))).toEqual([{ kind: "abort-exec" }]);
	});

	it("空闲且标记已挂起：优雅退出", () => {
		expect(resolveCancelActions("ctrl+c", state({ cancellationPending: true }))).toEqual([{ kind: "graceful-exit" }]);
	});

	it("完全空闲首次按下：提示 + 挂起防抖", () => {
		expect(resolveCancelActions("ctrl+c", state())).toEqual([
			{ kind: "notify", text: "再按一次 Ctrl+C 退出程序" },
			{ kind: "arm-pending", debounceMs: 2000 },
		]);
	});
});

describe("resolveCancelActions：escape 阶梯", () => {
	it("工作态有排队：立即投递队列（唯一动作）", () => {
		expect(resolveCancelActions("escape", state({ busy: true, queuedCount: 1 }))).toEqual([{ kind: "deliver-queued" }]);
	});

	it("工作态无排队：打断；直跑命令同时中止", () => {
		expect(resolveCancelActions("escape", state({ busy: true }))).toEqual([{ kind: "interrupt" }]);
		expect(resolveCancelActions("escape", state({ busy: true, execRunning: true }))).toEqual([
			{ kind: "interrupt" },
			{ kind: "abort-exec" },
		]);
	});

	it("空闲：只中止直跑命令；无事发生则为空", () => {
		expect(resolveCancelActions("escape", state({ execRunning: true }))).toEqual([{ kind: "abort-exec" }]);
		expect(resolveCancelActions("escape", state())).toEqual([]);
	});
});

describe("executeCancelActions：执行序与终态语义", () => {
	const mockHandlers = () => ({
		calls: [] as string[],
		forceExit() {
			this.calls.push("forceExit");
		},
		gracefulExit() {
			this.calls.push("gracefulExit");
		},
		abortExec() {
			this.calls.push("abortExec");
		},
		interrupt() {
			this.calls.push("interrupt");
		},
		deliverQueued() {
			this.calls.push("deliverQueued");
		},
		restoreQueue() {
			this.calls.push("restoreQueue");
		},
		armPending(ms: number) {
			this.calls.push(`armPending:${ms}`);
		},
		notify(text: string) {
			this.calls.push(`notify:${text}`);
		},
	});

	it("工作态 ctrl+c 序列：arm → restore（有队列）→ interrupt 全部依序执行", () => {
		const h = mockHandlers();
		executeCancelActions(resolveCancelActions("ctrl+c", state({ busy: true, queuedCount: 1 })), h);
		expect(h.calls).toEqual(["armPending:2000", "restoreQueue", "interrupt"]);
	});

	it("force-exit / graceful-exit / deliver-queued 为终态：后续动作不再执行", () => {
		const h = mockHandlers();
		executeCancelActions([{ kind: "force-exit" }, { kind: "interrupt" }], h);
		expect(h.calls).toEqual(["forceExit"]);

		const h2 = mockHandlers();
		executeCancelActions([{ kind: "graceful-exit" }, { kind: "abort-exec" }], h2);
		expect(h2.calls).toEqual(["gracefulExit"]);

		const h3 = mockHandlers();
		executeCancelActions([{ kind: "deliver-queued" }, { kind: "interrupt" }], h3);
		expect(h3.calls).toEqual(["deliverQueued"]);
	});

	it("空动作序列：零回调", () => {
		const h = mockHandlers();
		executeCancelActions([], h);
		expect(h.calls).toEqual([]);
	});
});
