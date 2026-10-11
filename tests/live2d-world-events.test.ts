import { describe, expect, it } from "vitest";
import type { ServiceCompanionContext, WorldEvent } from "../src/extensions/world-framework/types.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import { compileMOCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";

class FakeVTSClient {
	private connected = false;
	private listener?: (connected: boolean) => void;
	private currentModel = { modelID: MO_MODEL_ID, modelName: "MO" };

	isConnected(): boolean {
		return this.connected;
	}

	getModelProfile() {
		return this.currentModel;
	}

	setModel(id: string, name: string) {
		this.currentModel = { modelID: id, modelName: name };
	}

	setConnectionChangeListener(listener: (connected: boolean) => void) {
		this.listener = listener;
	}

	connect() {
		// 手工触发，模拟异步连接建立
	}

	simulateConnection(connected: boolean) {
		this.connected = connected;
		this.listener?.(connected);
	}

	injectParameters() {}
	disconnect() {
		this.connected = false;
	}
}

describe("Live2D 身体状态事件帧通知 (World Event Frame)", () => {
	it("连接成功发射 body.ready 事件帧，断线发射 body.offline，具备复合指纹去重", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);
		const client = new FakeVTSClient();

		const events: WorldEvent[] = [];
		const ctx: ServiceCompanionContext = {
			signal: new AbortController().signal,
			emitEvent: async (ev) => {
				events.push(ev);
			},
		};

		const rt = new Live2DRuntime({
			client: client as never,
			rig,
			catalog,
		});

		await rt.start(ctx);
		expect(events).toHaveLength(0);

		// 1. 模拟连接就绪
		client.simulateConnection(true);
		expect(events).toHaveLength(1);
		const readyEv = events[0]!;
		expect(readyEv.channel).toBe("world");
		expect(readyEv.type).toBe("body.ready");
		expect(readyEv.text).toContain("[身体就绪: live2d]");
		expect(readyEv.text).toContain("nod(点头)");
		expect(readyEv.text).toContain("shake(摇头)");
		expect(readyEv.text).toContain("MO");
		expect(await readyEv.render?.()).toBe("🟢 Live2D 身体就绪 (MO)");

		// 2. 幂等去重：重复触发 connected=true 不额外发事件
		client.simulateConnection(true);
		expect(events).toHaveLength(1);

		// 3. 模拟断线
		client.simulateConnection(false);
		expect(events).toHaveLength(2);
		const offlineEv = events[1]!;
		expect(offlineEv.channel).toBe("world");
		expect(offlineEv.type).toBe("body.offline");
		expect(offlineEv.text).toContain("[身体离线: live2d]");
		expect(await offlineEv.render?.()).toBe("🔴 Live2D 身体离线");

		// 4. 重复断线幂等
		client.simulateConnection(false);
		expect(events).toHaveLength(2);

		// 5. 重新连上
		client.simulateConnection(true);
		expect(events).toHaveLength(3);
		expect(events[2]!.type).toBe("body.ready");

		await rt.stop();
	});

	it("未适配模型诚实发射 body.unadapted，换模型时指纹变化灵敏更新通知", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);
		const client = new FakeVTSClient();
		// 模拟用户在 VTS 开启了未适配模型
		client.setModel("unknown-id", "Hiyori");

		const events: WorldEvent[] = [];
		const ctx: ServiceCompanionContext = {
			signal: new AbortController().signal,
			emitEvent: async (ev) => {
				events.push(ev);
			},
		};

		const rt = new Live2DRuntime({
			client: client as never,
			rig,
			catalog,
		});

		await rt.start(ctx);
		client.simulateConnection(true);

		// 诚实发射 body.unadapted，绝不伪装为 body.ready
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("body.unadapted");
		expect(events[0]!.text).toContain("[身体未适配: live2d]");
		expect(events[0]!.text).toContain("Hiyori");
		expect(await events[0]!.render?.()).toBe("🟡 Live2D 未适配当前模型 (Hiyori)");

		// 换回已适配的 MO 模型，指纹变化，灵敏更新为 body.ready
		client.setModel(MO_MODEL_ID, "MO");
		client.simulateConnection(true);
		expect(events).toHaveLength(2);
		expect(events[1]!.type).toBe("body.ready");
		expect(events[1]!.text).toContain("[身体就绪: live2d]");
		expect(await events[1]!.render?.()).toBe("🟢 Live2D 身体就绪 (MO)");

		await rt.stop();
	});
});
