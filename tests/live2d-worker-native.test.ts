import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import { Live2DRuntimeProxy } from "../.uina/worlds/live2d/worker/proxy.js";
import type { BodyEndpoint } from "../src/extensions/world-framework/seams.js";
import { WorldActivation } from "../src/extensions/world-framework/world-activation.js";
import { createWorldTool } from "../src/extensions/world-framework/world-tool.js";
import type { Tool } from "../src/tools/broker.js";

function fixtureEvent(worker: Worker, event: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const message = (value: { t?: string; event?: string }) => {
			if (value.t === "fixture" && value.event === event) {
				off();
				resolve();
			}
		};
		const failed = (error: Error) => {
			off();
			reject(error);
		};
		const exited = () => failed(new Error("fixture exited before event"));
		const off = () => {
			worker.off("message", message);
			worker.off("error", failed);
			worker.off("exit", exited);
		};
		worker.on("message", message);
		worker.on("error", failed);
		worker.on("exit", exited);
	});
}
async function native(options: { holdMove?: boolean; focusBeforeReady?: boolean } = {}) {
	const worker = new Worker(new URL("./fixtures/live2d-worker.mjs", import.meta.url), {
		workerData: { holdMove: options.holdMove },
	});
	const proxy = new Live2DRuntimeProxy(worker);
	const exposed = new Map<string, unknown>();
	await proxy.start({
		signal: new AbortController().signal,
		expose(name: string, value: unknown) {
			exposed.set(name, value);
			if (options.focusBeforeReady && name.startsWith("body.endpoint:")) (value as BodyEndpoint).onFocus?.(false);
			return () => {
				exposed.delete(name);
			};
		},
	} as never);
	return { worker, proxy, exposed, endpoint: exposed.get("body.endpoint:live2d") as BodyEndpoint };
}
describe("Live2D 真实 Worker（隔离假设备）", () => {
	it("启动失败回滚真实 Worker 的已登记端点", async () => {
		const worker = new Worker(new URL("./fixtures/live2d-worker.mjs", import.meta.url), {
			workerData: { failStart: true },
		});
		const proxy = new Live2DRuntimeProxy(worker);
		const exposed = new Set<string>();
		await expect(
			proxy.start({
				signal: new AbortController().signal,
				expose(name: string) {
					exposed.add(name);
					return () => {
						exposed.delete(name);
					};
				},
			} as never),
		).rejects.toThrow("fixture connect failed");
		expect(exposed.size).toBe(0);
		expect(worker.threadId).toBe(-1);
	});
	it("清理失败穿过真实线程错误协议，停止仍释放全部资源", async () => {
		const h = await native();
		const modified = fixtureEvent(h.worker, "failRestore");
		h.worker.postMessage({ t: "fixture", action: "failRestore" });
		await modified;
		await expect(h.proxy.express({ motion: "stunt" }, {})).resolves.toMatchObject({
			status: "unknown",
			details: { cleanup: { tint: "unknown" } },
		});
		await expect(h.proxy.stop()).rejects.toThrow("清理未确认");
		expect(h.worker.threadId).toBe(-1);
		expect(h.exposed.size).toBe(0);
		expect(h.endpoint.state().online).toBe(false);
	});
	it("jiti 自举、实际动作结算、连接变化自动 sync，停止释放线程", async () => {
		const h = await native();
		try {
			expect(h.endpoint.state().online).toBe(true);
			await expect(h.proxy.express({ motion: "nod" }, {})).resolves.toMatchObject({
				status: "succeeded",
				details: { verification: "input_accepted" },
			});
			const updated = fixtureEvent(h.worker, "disconnect");
			h.worker.postMessage({ t: "fixture", action: "disconnect" });
			await updated;
			expect(h.endpoint.state().online).toBe(false);
			const cleared = fixtureEvent(h.worker, "clearCatalog");
			h.worker.postMessage({ t: "fixture", action: "clearCatalog" });
			await cleared;
			expect(h.endpoint.affordance().cues).toHaveLength(0);
			expect(h.endpoint.supportsCue?.("nod")).toBe(false);
		} finally {
			await h.proxy.stop();
		}
		expect(h.exposed.size).toBe(0);
		expect(h.worker.threadId).toBe(-1);
	});
	it("登记期焦点通知不会被 start 应答前的 adapter 吞掉", async () => {
		const h = await native({ focusBeforeReady: true });
		try {
			expect(JSON.parse(await h.proxy.diagnose()).focused).toBe(false);
		} finally {
			await h.proxy.stop();
		}
	});
	it("World 工具取消保留实际归位结论，不被外层改成未知", async () => {
		const h = await native({ holdMove: true });
		const controller = new AbortController();
		const app = createLive2DApp({ instance: h.proxy });
		const tool = createWorldTool(app, { getRuntime: () => ({ definition: app, enabled: true }) as never });
		await app.onStart?.({} as never);
		try {
			const moving = fixtureEvent(h.worker, "moving");
			const result = tool.run({ action: "express", params: { motion: "stunt" } }, controller.signal, {} as never);
			await moving;
			controller.abort();
			await expect(result).resolves.toMatchObject({
				status: "cancelled",
				details: { restored: true, cleanup: { pose: "confirmed", tint: "confirmed" } },
			});
			h.worker.postMessage({ t: "fixture", action: "release" });
		} finally {
			await app.onStop?.({} as never);
		}
	});
	it("异常退出撤销真实线程端点，在途动作未知且不复活缓存", async () => {
		const h = await native({ holdMove: true });
		const moving = fixtureEvent(h.worker, "moving");
		const result = h.proxy.express({ motion: "stunt" }, {});
		await moving;
		h.worker.postMessage({ t: "fixture", action: "exit" });
		await expect(result).resolves.toMatchObject({ status: "unknown", details: { reason: "engine_exited" } });
		expect(h.exposed.size).toBe(0);
		expect(h.endpoint.state().online).toBe(false);
		await h.proxy.stop().catch(() => {});
	});
	it("WorldActivation 先取消工具再停用，等待清理后移除共享资源", async () => {
		const worker = new Worker(new URL("./fixtures/live2d-worker.mjs", import.meta.url), {
			workerData: { holdMove: true },
		});
		const proxy = new Live2DRuntimeProxy(worker);
		const app = createLive2DApp({ instance: proxy });
		let tool: Tool | undefined;
		let registered = 0;
		const activation = new WorldActivation(app, {
			worldName: "live2d",
			runtime: { definition: app, enabled: true } as never,
			notifyExposed: () => {},
			pi: {
				registerTool(value: Tool) {
					tool = value;
					registered++;
					return () => {
						registered--;
					};
				},
				on: () => () => {},
			} as never,
		});
		await activation.start();
		const endpoint = activation.exposed.get("body.endpoint:live2d") as BodyEndpoint;
		const moving = fixtureEvent(worker, "moving");
		const result = tool!.run({ action: "express", params: { motion: "stunt" } }, undefined, {} as never);
		await moving;
		const stopped = activation.stop();
		await expect(result).resolves.toMatchObject({ status: "cancelled", details: { restored: true } });
		await stopped;
		expect(registered).toBe(0);
		expect(activation.exposed.size).toBe(0);
		expect(endpoint.state().online).toBe(false);
		expect(worker.threadId).toBe(-1);
	});
});
