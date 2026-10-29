/**
 * PresentationController 契约（W2e 转真实断言）。
 *
 * 只依赖平台中立的展示层；Host/Session 仅作 type-only 引用。
 * 契约来源：规划 §3.4 与附录 B.4。
 */

import { describe, expect, it } from "vitest";
import type { HostEventRecord, HostSnapshot } from "../src/host/events.js";
import type { SessionEntry } from "../src/session/types.js";
import { PresentationController, type PresentationChange } from "../src/presentation/controller.js";

function record(at: number, event: HostEventRecord["event"]): HostEventRecord {
	return { at, event };
}

describe("PresentationController 契约", () => {
	it("view() 在相同事实序列下返回稳定快照（两次调用逐字段相等）", () => {
		const controller = new PresentationController();
		controller.ingest(record(1000, { type: "turn_start", turnNumber: 1, userText: "检查目录" }));

		const first = controller.view();
		const second = controller.view();
		expect(first.transcript).toHaveLength(1);
		expect(first.transcript[0]).toMatchObject({ kind: "turn", turn: 1, status: "running", startedAt: 1000 });
		expect(first.trajectory.map((node) => node.kind)).toEqual(["turn_start"]);
		expect(second).toEqual(first);
		expect(second.transcript).toBe(first.transcript);
	});

	it("subscribe 只发增量事件，不重放全量视图", () => {
		const controller = new PresentationController();
		const changes: PresentationChange[] = [];
		controller.subscribe((change) => changes.push(change));

		const created = controller.ingest(record(1000, { type: "turn_start", turnNumber: 1, userText: "开始" }));
		expect(changes).toEqual([{ kind: "append", nodes: [created[0]] }]);

		const settled = controller.ingest(record(1200, { type: "turn_end", turnNumber: 1 }));
		expect(changes.at(-1)).toEqual({ kind: "update", node: settled[0] });
		expect(changes.every((change) => change.kind !== "replace")).toBe(true);

		const unsubscribe = controller.subscribe(() => {
			throw new Error("detached listener must not receive changes");
		});
		unsubscribe();
		controller.ingest(record(1300, { type: "notice", text: "提示" }));
	});

	it("dispatch 把动作送达 intent sink，detach 后不再投递", () => {
		const controller = new PresentationController();
		const received: unknown[] = [];
		const detach = controller.onIntent((intent) => received.push(intent));

		controller.dispatch({ type: "input.submit", text: "hello", mode: "direct" });
		expect(received).toEqual([{ type: "input.submit", text: "hello", mode: "direct" }]);

		detach();
		controller.dispatch({ type: "thinking.cycle" });
		expect(received).toHaveLength(1);
	});

	it("replaceAll 后旧节点全部清空，不残留上一段投影", () => {
		const controller = new PresentationController();
		controller.ingest(record(1000, { type: "turn_start", turnNumber: 1, userText: "旧问题" }));
		const changes: PresentationChange[] = [];
		controller.subscribe((change) => changes.push(change));

		const entries: SessionEntry[] = [
			{ kind: "message", timestamp: "2026-10-29T10:00:00.000Z", message: { role: "user", content: "新问题" } },
			{ kind: "message", timestamp: "2026-10-29T10:00:01.000Z", message: { role: "assistant", content: "新回答" } },
		];
		const view = controller.replaceAll(entries, []);
		expect(view.transcript.map((node) => node.id)).toEqual(["turn:1"]);
		expect(view.trajectory.map((node) => node.kind)).toEqual(["turn_start", "model_stream"]);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ kind: "replace", view });
		expect(controller.view().transcript).toBe(view.transcript);

		controller.replaceAll([], []);
		expect(controller.view().transcript).toEqual([]);
		expect(controller.view().trajectory).toEqual([]);
	});

	it("applySnapshot 只更新会话快照，不伪造展示节点", () => {
		const controller = new PresentationController();
		const snapshot: HostSnapshot = { modelName: "provider:model", busy: false, queue: [], queueDepth: 0 };
		const changes: PresentationChange[] = [];
		controller.subscribe((change) => changes.push(change));

		controller.applySnapshot(snapshot);

		expect(controller.view().session).toBe(snapshot);
		expect(controller.view().transcript).toEqual([]);
		expect(controller.view().trajectory).toEqual([]);
		expect(changes).toEqual([]);
	});
});
