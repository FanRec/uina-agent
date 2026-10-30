/**
 * 多前端一致性测试——本设计的诚实性保证。
 *
 * 同一宿主、同一事实单流：直连 PresentationController 与
 * FrontendGatewayCore + SyncClient（内存双工传输）两条消费路径，
 * 产出的视图必须逐字段一致。必须覆盖"流中 join"：快照把开启段
 * （running 的 assistant/thinking）带过来，续流不重开新段。
 */

import { vi } from "vitest";
import { FrontendGatewayCore } from "../src/cli/frontend-gateway.js";
import type { HostEventRecord } from "../src/host/events.js";
import { PresentationController } from "../src/presentation/controller.js";
import { SyncClient, type SyncTransport } from "../src/presentation/sync.js";
import { describe, expect, test } from "./harness/index.js";

const scheduler = {
	schedule: (delayMs: number, fn: () => void) => {
		const timer = setTimeout(fn, delayMs);
		return () => clearTimeout(timer);
	},
};

/** 内存双工传输：SyncClient ↔ FrontendGatewayCore 全链路（走真实协议字节）。 */
function memoryTransport(core: FrontendGatewayCore): SyncTransport {
	let onMessage: ((data: string) => void) | undefined;
	let onClose: (() => void) | undefined;
	const clientId = core.attachConnection((data) => {
		onMessage?.(data);
		return true;
	});
	return {
		send: (data) => core.handleMessage(clientId, data),
		close: () => {
			onClose?.();
			core.handleClose(clientId);
		},
		onMessage: (handler) => {
			onMessage = handler;
		},
		onClose: (handler) => {
			onClose = handler;
		},
	};
}

function createSide(uinaHost: import("../src/host/host.js").UinaHost) {
	const direct = new PresentationController();
	direct.replaceAll(uinaHost.restoredEntries, uinaHost.restoredAuxiliary);
	const offDirect = uinaHost.onEventRecord((record: HostEventRecord) => direct.ingest(record));

	const core = new FrontendGatewayCore(uinaHost, "token");
	const clientController = new PresentationController();
	const client = new SyncClient(clientController, () => memoryTransport(core), {
		auth: "token",
		client: "一致性测试",
		scheduler,
	});
	client.start();
	return { direct, clientController, client, core, offDirect };
}

describe("多前端一致性（直连 vs 网关+SyncClient）", () => {
	test("同一事实序列产出逐字段相同的视图；意图归属进事实流", async ({ uina, scenario }) => {
		console.log("T1: enter");
		scenario.reply("第一轮回答").reply("第二轮回答").reply("第三轮（来自远端）");

		console.log("T1: scenario ready");
		const side = createSide(uina.host);
		console.log("T1: side created");
		await vi.waitFor(() => expect(side.client.state).toBe("synced"));
		console.log("T1: synced");

		await uina.send("第一轮");
		await uina.waitForIdle();
		await uina.send("第二轮");
		await uina.waitForIdle();

		// 远端意图走线上路径：发送 → 网关转发 → 宿主受理 → 事实回流两端
		expect(side.client.sendIntent({ type: "input.submit", text: "来自远端的第三轮", mode: "direct" })).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await uina.waitForIdle();

		side.offDirect();
		side.core.dispose();
		side.client.stop();

		// 同步合同 = transcript + trajectory（session 是各 Surface 自维护的状态缓存，
		// 由快照基线与状态事实驱动，不参与字节级等价）。
		const viewCore = (view: import("../src/presentation/controller.js").PresentationView) =>
			JSON.stringify({ transcript: view.transcript, trajectory: view.trajectory });
		expect(viewCore(side.clientController.view())).toBe(viewCore(side.direct.view()));
		const accepted = uina.events.all.find(
			(event) => event.type === "input_accepted" && event.source?.channel?.startsWith("gateway:"),
		);
		expect(accepted).toMatchObject({ source: { type: "operator", origin: "external" } });
		expect(
			(accepted as Extract<typeof accepted, { source?: { actor?: { label?: string } } }>).source?.actor?.label,
		).toBe("一致性测试");
	});

	test("流中 join：快照恢复开启段，后续事实无缝续流不重段", async ({ uina, scenario }) => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		scenario
			.when(() => true)
			.thenStream(async (_model, _request, onDelta) => {
				onDelta({ kind: "text", text: "前半句话，" });
				await gate;
				onDelta({ kind: "text", text: "后半句话。" });
				onDelta({ kind: "finish", reason: "stop" });
			});
		// 失败也必须放行门控：悬挂的流会让 vitest teardown 无限等待。
		try {
			const side = createSide(uina.host);
			const turnSettled = uina.host.submitText("讲个故事", "direct").catch(() => undefined);
			await vi.waitFor(() => expect(uina.isBusy()).toBe(true));
			await new Promise((resolve) => setTimeout(resolve, 30)); // 让"前半句"先落进投影

			// 此刻接入：快照必须带着 running 的 assistant 开启段
			await vi.waitFor(() => expect(side.client.state).toBe("synced"));
			const runningOf = (view: {
				transcript: readonly import("../src/presentation/projection.js").PresentationNode[];
			}) => view.transcript.find((node) => node.kind === "assistant" && node.status === "running");
			expect(runningOf(side.direct.view())).toMatchObject({ text: "前半句话，" });
			expect(runningOf(side.clientController.view())).toMatchObject({ text: "前半句话，" });

			release();
			await turnSettled;
			await uina.waitForIdle();

			side.offDirect();
			side.core.dispose();
			side.client.stop();

			// 开启段在两侧各只有一个，且全文一致——续流没有重开新段
			for (const view of [side.direct.view(), side.clientController.view()]) {
				expect(view.transcript.filter((node) => node.kind === "assistant")).toHaveLength(1);
			}
			const viewCore2 = (view: import("../src/presentation/controller.js").PresentationView) =>
				JSON.stringify({ transcript: view.transcript, trajectory: view.trajectory });
			expect(viewCore2(side.clientController.view())).toBe(viewCore2(side.direct.view()));
		} finally {
			release();
		}
	});
});
