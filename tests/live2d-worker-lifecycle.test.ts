import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { Live2DRuntimeProxy } from "../.uina/worlds/live2d/worker/proxy.js";
import type { EngineToMain, MainToEngine } from "../.uina/worlds/live2d/worker/protocol.js";
import type { BodyEndpoint } from "../src/extensions/world-framework/seams.js";

class FixturePort extends EventEmitter {
	readonly sent: MainToEngine[] = [];
	holdActions = false;
	failStop = false;
	terminations = 0;
	postMessage(message: MainToEngine) {
		this.sent.push(message);
		if (message.t !== "call") return;
		queueMicrotask(() => {
			if (message.op === "start") {
				this.emit("message", {
					t: "sync",
					state: { online: true, paused: false },
					affordance: {
						bodyId: "live2d",
						bodyType: "avatar_2d",
						description: "fake",
						cues: [{ id: "nod", description: "nod" }],
					},
				});
				this.emit("message", { t: "exposed", name: "body.endpoint:live2d" });
				this.emit("message", { t: "exposed", name: "voice.levelSink:live2d" });
			}
			if (message.op === "stop" && this.failStop) {
				this.emit("message", {
					t: "result",
					id: message.id,
					ok: false,
					op: message.op,
					error: { name: "Error", message: "清理未确认", reason: "cleanup_unconfirmed" },
				});
				return;
			}
			if (this.holdActions && message.op === "express") return;
			this.emit("message", { t: "result", id: message.id, op: message.op, ok: true, value: null });
		});
	}
	async terminate() {
		this.terminations++;
		return 0;
	}
}
async function harness() {
	const port = new FixturePort();
	const proxy = new Live2DRuntimeProxy(port);
	const exposed = new Map<string, unknown>();
	let unsubscribes = 0;
	await proxy.start({
		signal: new AbortController().signal,
		expose(name: string, value: unknown) {
			exposed.set(name, value);
			return () => {
				exposed.delete(name);
			};
		},
		onHostEvent() {
			return () => {
				unsubscribes++;
			};
		},
	} as never);
	return {
		port,
		proxy,
		exposed,
		endpoint: exposed.get("body.endpoint:live2d") as BodyEndpoint,
		unsubscribes: () => unsubscribes,
	};
}
describe("Live2D Worker 生命周期事实", () => {
	it("预取消启动直接回收线程，不留下构造期事件监听", async () => {
		const port = new FixturePort();
		const proxy = new Live2DRuntimeProxy(port);
		const controller = new AbortController();
		controller.abort(new Error("start cancelled"));
		await expect(proxy.start({ signal: controller.signal } as never)).rejects.toThrow("start cancelled");
		expect(port.terminations).toBe(1);
		expect(port.sent).toHaveLength(0);
		expect(port.listenerCount("message")).toBe(0);
	});
	it("退出撤销全部登记和订阅，保留引用离线，不再 fire", async () => {
		const h = await harness();
		h.port.emit("exit", 1);
		expect(h.exposed.size).toBe(0);
		expect(h.unsubscribes()).toBe(1);
		expect(h.endpoint.state()).toMatchObject({ online: false });
		const count = h.port.sent.length;
		h.endpoint.emitCue("nod");
		h.endpoint.interrupt?.();
		expect(h.port.sent).toHaveLength(count);
		h.port.emit("message", { t: "sync", state: { online: true, paused: false }, affordance: h.endpoint.affordance() });
		expect(h.endpoint.state().online).toBe(false);
		await h.proxy.stop().catch(() => {});
	});
	it("预取消零投递，结构化 cancelled 而非 Promise 拒绝", async () => {
		const h = await harness();
		const controller = new AbortController();
		controller.abort();
		const count = h.port.sent.length;
		try {
			await expect(h.proxy.express({ motion: "nod" }, { signal: controller.signal })).resolves.toMatchObject({
				status: "cancelled",
			});
			expect(h.port.sent).toHaveLength(count);
		} finally {
			await h.proxy.stop();
		}
	});
	it("运行取消等待引擎清理结果，保留结构化证据", async () => {
		const h = await harness();
		h.port.holdActions = true;
		const controller = new AbortController();
		const result = h.proxy.express({ motion: "nod" }, { signal: controller.signal });
		const expected = expect(result).resolves.toMatchObject({ status: "cancelled", details: { restored: true } });
		controller.abort();
		const call = h.port.sent.findLast((message) => message.t === "call" && message.op === "express")!;
		h.port.emit("message", {
			t: "result",
			id: (call as { id: number }).id,
			op: "express",
			ok: true,
			value: { status: "cancelled", result: "cancelled", details: { restored: true } },
		} satisfies EngineToMain);
		await expected;
		await h.proxy.stop();
	});
	it("投递后线程死亡返回 unknown，死后新调用 not_started", async () => {
		const h = await harness();
		h.port.holdActions = true;
		const expected = expect(h.proxy.express({ motion: "nod" }, {})).resolves.toMatchObject({
			status: "unknown",
			details: { reason: "engine_exited" },
		});
		h.port.emit("exit", 1);
		await expected;
		await expect(h.proxy.express({ motion: "nod" }, {})).resolves.toMatchObject({ status: "not_started" });
		await h.proxy.stop().catch(() => {});
	});
	it("正常 stop 保留清理失败且仍等待 terminate；重复 stop 幂等", async () => {
		const h = await harness();
		h.port.failStop = true;
		await expect(h.proxy.stop()).rejects.toThrow("清理未确认");
		await expect(h.proxy.stop()).rejects.toThrow("清理未确认");
		expect(h.port.terminations).toBe(1);
		expect(h.exposed.size).toBe(0);
	});
});
