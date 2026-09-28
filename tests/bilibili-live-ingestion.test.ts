import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../.uina/apps/bilibili-live/src/config.js";
import { LiveEventBuffer } from "../.uina/apps/bilibili-live/src/buffer.js";
import { LiveEventIngestion } from "../.uina/apps/bilibili-live/src/live-event-ingestion.js";
import type { LiveClientAdapter, LiveClientEvent } from "../.uina/apps/bilibili-live/src/live-client-adapter.js";

class FakeClient extends EventEmitter implements LiveClientAdapter {
	async connect(): Promise<void> { this.emit("connected"); }
	async disconnect(): Promise<void> { this.emit("disconnected"); }
	override on(event: LiveClientEvent, listener: (payload: any) => void): this { return super.on(event, listener); }
}

describe("LiveEventIngestion", () => {
	let tempDir = "";
	afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

	it("drops stale generation events and stops forwarding after stop", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const config = loadConfig({ storage: { dataDir: tempDir } });
		const buffer = new LiveEventBuffer(config);
		const updates: string[] = [];
		const first = new FakeClient();
		const second = new FakeClient();
		const ingestion = new LiveEventIngestion(config, buffer, (update) => updates.push(update.type), () => undefined);
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

	it("returns a pure WakeDecision for threshold events", () => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-ingestion-"));
		const config = loadConfig({ storage: { dataDir: tempDir }, wakeup: { wakeOnSuperChat: true } });
		const buffer = new LiveEventBuffer(config);
		const wakes: unknown[] = [];
		const client = new FakeClient();
		const ingestion = new LiveEventIngestion(config, buffer, () => undefined, (decision) => wakes.push(decision));
		ingestion.replace(client);
		client.emit("superChat", { id: 7, uid: 42, uname: "user", price: 50, message: "hello", timestamp: 1000, startTime: 1000, endTime: 2000 });
		expect(wakes).toEqual([{ eventId: "7", reason: "superChat" }]);
		buffer.dispose();
	});
});
