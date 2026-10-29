import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBilibiliLiveWorld } from "../.uina/worlds/bilibili-live/src/index.js";
import {
	DEFAULT_NOTIFICATION_SETTINGS,
	loadNotificationSettings,
	parseNotificationSettings,
	saveNotificationSettings,
} from "../.uina/worlds/bilibili-live/src/notification-settings.js";
import { createWorldTool } from "../src/extensions/world-framework/world-tool.js";

describe("bilibili notification settings", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("uses off for ordinary chat and on for high value events", () => {
		expect(DEFAULT_NOTIFICATION_SETTINGS).toEqual({
			chat_messages: "off",
			room_status: "on",
			super_chats: "on",
			memberships: "on",
			gifts: "on",
		});
		expect(parseNotificationSettings({ chat_messages: "on", room_status: "off" })).toEqual({
			chat_messages: "on",
			room_status: "off",
			super_chats: "on",
			memberships: "on",
			gifts: "on",
		});
	});

	it("rejects unknown fields and values", () => {
		expect(() => parseNotificationSettings({ unknown: "on" })).toThrow();
		expect(() => parseNotificationSettings({ room_status: "sometimes" })).toThrow();
		expect(() => parseNotificationSettings({ gifts: "sometimes" })).toThrow();
	});

	it("persists and reloads settings", async () => {
		dir = mkdtempSync(join(tmpdir(), "uina-bili-settings-"));
		const path = join(dir, "notification-settings.json");
		const value = { ...DEFAULT_NOTIFICATION_SETTINGS, chat_messages: "on" as const };
		await saveNotificationSettings(path, value);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(value);
		expect(await loadNotificationSettings(path)).toEqual(value);
	});

	it("does not silently accept an invalid persisted file", async () => {
		dir = mkdtempSync(join(tmpdir(), "uina-bili-settings-"));
		const path = join(dir, "notification-settings.json");
		writeFileSync(path, JSON.stringify({ gifts: "invalid" }));
		await expect(loadNotificationSettings(path)).rejects.toThrow();
	});

	it("reports a notification settings write failure as a failed tool result", async () => {
		dir = mkdtempSync(join(tmpdir(), "uina-bili-settings-failure-"));
		const dataDir = join(dir, "world-data");
		const world = createBilibiliLiveWorld({ storage: { dataDir } });
		rmSync(dataDir, { recursive: true, force: true });
		writeFileSync(dataDir, "not a directory");
		const tool = createWorldTool(world, { getRuntime: () => ({ definition: world, enabled: true }) });

		const result = await tool.run({
			action: "notification_settings",
			params: { operation: "update", chat_messages: "on" },
		});
		expect(result.status).toBe("failed");
		expect(result.result).toContain("通知设置保存失败");
	});
});
