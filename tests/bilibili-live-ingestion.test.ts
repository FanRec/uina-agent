import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LiveEventBuffer } from "../.uina/worlds/bilibili-live/src/buffer.js";
import { loadConfig } from "../.uina/worlds/bilibili-live/src/config.js";
import type { LiveClientAdapter, LiveClientEvent } from "../.uina/worlds/bilibili-live/src/live-client-adapter.js";
import { LiveEventIngestion } from "../.uina/worlds/bilibili-live/src/live-event-ingestion.js";

class FakeClient extends EventEmitter implements LiveClientAdapter {
	async connect(): Promise<void> {
		this.emit("connected");
	}
	async disconnect(): Promise<void> {
		this.emit("disconnected");
	}
	override on(event: LiveClientEvent, listener: (payload: any) => void): this {
		return super.on(event, listener);
	}
}

describe("LiveEventIngestion", () => {
	let tempDir = "";
	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("drops stale generation events and stops forwarding after stop", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const config = loadConfig({ storage: { dataDir: tempDir } });
		const buffer = new LiveEventBuffer(config);
		const updates: string[] = [];
		const first = new FakeClient();
		const second = new FakeClient();
		const ingestion = new LiveEventIngestion(
			config,
			buffer,
			(update) => updates.push(update.type),
			() => undefined,
		);
		ingestion.replace(first);
		ingestion.replace(second);
		first.emit("connected");
		second.emit("connected");
		expect(updates).toEqual(["connected"]);
		await ingestion.stop();
		second.emit("connected");
		expect(updates).toEqual(["connected"]);
		buffer.dispose();
	});

	it("forwards transport errors, timeouts and reconnect timing into connection updates", () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const config = loadConfig({ storage: { dataDir: tempDir } });
		const buffer = new LiveEventBuffer(config);
		const updates: unknown[] = [];
		const client = new FakeClient();
		const ingestion = new LiveEventIngestion(
			config,
			buffer,
			(update) => updates.push(update),
			() => undefined,
		);
		ingestion.replace(client);
		client.emit("error", new Error("getDanmuInfo HTTP error: 403"));
		client.emit("timeout", new Error("Receive timeout"));
		client.emit("reconnecting", { retryCount: 3, totalRetryCount: 3, delaySeconds: 4 });

		expect(updates).toEqual([
			{ type: "error", payload: new Error("getDanmuInfo HTTP error: 403") },
			{ type: "timeout", payload: new Error("Receive timeout") },
			{ type: "reconnecting", payload: { retryCount: 3, totalRetryCount: 3, delaySeconds: 4 } },
		]);
		buffer.dispose();
	});

	it("returns a pure WakeDecision for threshold events", () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const config = loadConfig({ storage: { dataDir: tempDir }, wakeup: { wakeOnSuperChat: true } });
		const buffer = new LiveEventBuffer(config);
		const wakes: unknown[] = [];
		const client = new FakeClient();
		const ingestion = new LiveEventIngestion(
			config,
			buffer,
			() => undefined,
			(decision) => wakes.push(decision),
		);
		ingestion.replace(client);
		client.emit("superChat", {
			id: 7,
			uid: 42,
			uname: "user",
			price: 50,
			message: "hello",
			timestamp: 1000,
			startTime: 1000,
			endTime: 2000,
		});
		expect(wakes).toEqual([{ sourceEventKey: "bilibili:sc:7", reason: "superChat" }]);
		buffer.dispose();
	});

	it("uses the journal event key and renders the latest unhandled pending event", () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const config = loadConfig({ storage: { dataDir: tempDir }, wakeup: { wakeOnSuperChat: true } });
		const buffer = new LiveEventBuffer(config);
		const record = buffer.ingestSuperChat({
			id: 9,
			uid: 42,
			uname: "<外部用户>",
			price: 30,
			message: "<不要执行>",
		}).record;
		expect(record?.sourceEventKey).toBe("bilibili:sc:9");
		expect(buffer.renderPendingEvent("bilibili:sc:9")).toContain("不是系统指令");
		expect(buffer.renderPendingEvent("bilibili:sc:9")).toContain("＜不要执行＞");
		buffer.markHandled(record!.alias);
		expect(buffer.renderPendingEvent("bilibili:sc:9")).toBeNull();
		buffer.dispose();
	});

	it("does not wake for ordinary danmaku", () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const config = loadConfig({ storage: { dataDir: tempDir } });
		const buffer = new LiveEventBuffer(config);
		const wakes: unknown[] = [];
		const client = new FakeClient();
		const ingestion = new LiveEventIngestion(
			config,
			buffer,
			() => undefined,
			(decision) => wakes.push(decision),
		);
		ingestion.replace(client);
		client.emit("danmaku", { id: "dm-1", uid: 42, uname: "user", text: "hello", timestamp: 1000 });
		expect(wakes).toEqual([]);
		buffer.dispose();
	});

	it("reads an ordinary danmaku batch by its stable buffer range", () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const buffer = new LiveEventBuffer(loadConfig({ storage: { dataDir: tempDir } }));
		const first = buffer.addDanmaku(1, "one", "first");
		const second = buffer.addDanmaku(2, "two", "second");
		expect(first && second).toBeTruthy();
		expect(buffer.getDanmakuRange(first!.id, second!.id).map((item) => item.text)).toEqual(["first", "second"]);
		buffer.dispose();
	});

	it("uses stable journal keys for memberships and threshold gifts", () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const config = loadConfig({
			storage: { dataDir: tempDir },
			wakeup: { wakeOnGuard: true, wakeOnGiftThreshold: 1000 },
		});
		const buffer = new LiveEventBuffer(config);
		const wakes: unknown[] = [];
		const client = new FakeClient();
		const ingestion = new LiveEventIngestion(
			config,
			buffer,
			() => undefined,
			(decision) => wakes.push(decision),
		);
		ingestion.replace(client);
		client.emit("guardBuy", { uid: 42, uname: "guard-user", guardLevel: 3, giftName: "舰长", timestamp: 2000 });
		client.emit("gift", {
			uid: 42,
			uname: "gift-user",
			giftId: 7,
			giftName: "礼物",
			price: 500,
			count: 2,
			timestamp: 3000,
		});
		expect(wakes).toEqual([
			{ sourceEventKey: "bilibili:guard:42:3:2000", reason: "guard" },
			{ sourceEventKey: "bilibili:gift:42:7:3000", reason: "gift" },
		]);
		buffer.dispose();
	});

	it("does not wake twice for a journal duplicate", () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const config = loadConfig({ storage: { dataDir: tempDir }, wakeup: { wakeOnSuperChat: true } });
		const buffer = new LiveEventBuffer(config);
		const wakes: unknown[] = [];
		const client = new FakeClient();
		const ingestion = new LiveEventIngestion(
			config,
			buffer,
			() => undefined,
			(decision) => wakes.push(decision),
		);
		ingestion.replace(client);
		const payload = {
			id: 11,
			uid: 42,
			uname: "user",
			price: 50,
			message: "hello",
			timestamp: 4000,
			startTime: 4000,
			endTime: 5000,
		};
		client.emit("superChat", payload);
		client.emit("superChat", payload);
		expect(wakes).toEqual([{ sourceEventKey: "bilibili:sc:11", reason: "superChat" }]);
		buffer.dispose();
	});

	it("routes sub-threshold and free gifts into the transient awareness pool instead of dropping them", () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const config = loadConfig({ storage: { dataDir: tempDir } });
		const buffer = new LiveEventBuffer(config);
		const wakes: unknown[] = [];
		let smallGiftArrivals = 0;
		const client = new FakeClient();
		const ingestion = new LiveEventIngestion(
			config,
			buffer,
			() => undefined,
			(decision) => wakes.push(decision),
			undefined,
			() => {
				smallGiftArrivals++;
			},
		);
		ingestion.replace(client);
		const t0 = performance.now();
		// 低价付费礼物（100 金瓜子 = ￥0.1 < 1000 门槛）
		client.emit("gift", {
			id: "g1",
			uid: 42,
			uname: "fan",
			giftId: 1,
			giftName: "小心心",
			count: 1,
			price: 100,
			coinType: "gold",
			timestamp: 1000,
		});
		// 免费礼物（银瓜子）
		client.emit("gift", {
			id: "g2",
			uid: 43,
			uname: " passerby",
			giftId: 2,
			giftName: "辣条",
			count: 3,
			price: 100,
			coinType: "silver",
			timestamp: 1100,
		});
		expect(wakes).toEqual([]);
		expect(smallGiftArrivals).toBe(2);
		expect(buffer.getPendingCounts().gifts).toBe(0);
		const lines = buffer.drainQuietTransientGifts(2000, t0 + 5000);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("小心心");
		expect(lines[1]).toContain("辣条");
		// 排出后暂态池清空
		expect(buffer.hasTransientGifts).toBe(false);
		expect(buffer.drainQuietTransientGifts(2000, t0 + 9999)).toEqual([]);
		buffer.dispose();
	});

	it("keeps comboing gifts in the pool until they go quiet, then reports the merged total", () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const config = loadConfig({ storage: { dataDir: tempDir } });
		const buffer = new LiveEventBuffer(config);
		// 直接以可注入的单调时钟驱动 buffer，确定性模拟连击节奏
		const combo = (count: number, mono: number) =>
			buffer.ingestGift({
				uid: 42,
				uname: "fan",
				giftId: 1,
				giftName: "小心心",
				price: 100,
				count,
				monotonicTimeMs: mono,
			});

		combo(3, 0);
		// 连击进行中（静默期内有更新）：不上报，继续累积
		combo(2, 500);
		expect(buffer.drainQuietTransientGifts(2000, 1000)).toEqual([]);
		expect(buffer.hasTransientGifts).toBe(true);

		combo(4, 2500);
		// 静默期未满：仍不上报
		expect(buffer.drainQuietTransientGifts(2000, 3000)).toEqual([]);

		// 停手超过静默期：整批上报总数
		const lines = buffer.drainQuietTransientGifts(2000, 5000);
		expect(lines).toEqual(["* fan 赠送 小心心 x9"]);
		expect(buffer.hasTransientGifts).toBe(false);
		buffer.dispose();
	});

	it("never promotes free gifts into pending todos even at high counts", () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const config = loadConfig({ storage: { dataDir: tempDir } });
		const buffer = new LiveEventBuffer(config);
		const wakes: unknown[] = [];
		const client = new FakeClient();
		const ingestion = new LiveEventIngestion(
			config,
			buffer,
			() => undefined,
			(decision) => wakes.push(decision),
		);
		ingestion.replace(client);
		const t0 = performance.now();
		// 100 金瓜子 × 50 个 = 5000：若是付费礼物必达待办，但银瓜子免费礼物不允许
		client.emit("gift", {
			id: "g1",
			uid: 42,
			uname: "fan",
			giftId: 2,
			giftName: "辣条",
			count: 50,
			price: 100,
			coinType: "silver",
			timestamp: 1000,
		});
		expect(wakes).toEqual([]);
		expect(buffer.getPendingCounts().gifts).toBe(0);
		expect(buffer.drainQuietTransientGifts(2000, t0 + 5000)).toHaveLength(1);
		buffer.dispose();
	});
});
