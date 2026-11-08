/**
 * Window 协议最小真服探针（v2 A2）：只观察，不改产品代码。
 *
 * 目标：记录 1.21.11 下 window_click 发出后服务端到底回了什么——
 * stateId / windowId / slot updates / carriedItem / full vs partial / 时间线。
 * 用它判定 Uina 的 fullSequence + expectedClick 确认口径是否有上游依据，
 * 而不是把 UNKNOWN 归咎于"服务端没回"或靠加长超时掩盖。
 *
 * 跑法：先启动 dev-env Paper，再 pnpm dev:mc:window-probe
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mineflayer = require("mineflayer");

const events: {
	t: number;
	dir: "send" | "recv";
	name: string;
	windowId?: number;
	stateId?: number;
	slot?: number;
	carried?: unknown;
	items?: number;
	note?: string;
}[] = [];
const t0 = Date.now();
const mark = (e: Omit<(typeof events)[number], "t">) => events.push({ t: Date.now() - t0, ...e });

const bot = mineflayer.createBot({
	host: "127.0.0.1",
	port: 25565,
	// FanRec 是 dev-env/ops.json 里的 op，/give 与 /clear 才真正生效。
	username: "FanRec",
	version: "1.21.11",
	auth: "offline",
});

const done = (error?: unknown) => {
	if (error) console.log("PROBE_ERROR", error instanceof Error ? error.message : String(error));
	console.log("=== WINDOW PROBE TIMELINE ===");
	for (const e of events) console.log(JSON.stringify(e));
	console.log("=== END ===");
	bot.end();
};

const timer = setTimeout(() => done(new Error("probe timeout 25000ms")), 25000);
timer.unref();

bot.once("spawn", async () => {
	try {
		// 原始包监听：不经过 mineflayer 插件解释，保留 stateId。
		bot._client.on("window_items", (packet: Record<string, unknown>) => {
			mark({
				dir: "recv",
				name: "window_items",
				windowId: packet.windowId as number,
				stateId: packet.stateId as number,
				items: (packet.items as unknown[] | undefined)?.length,
				carried: packet.carriedItem === undefined ? "<undefined>" : packet.carriedItem,
			});
		});
		bot._client.on("set_slot", (packet: Record<string, unknown>) => {
			mark({
				dir: "recv",
				name: "set_slot",
				windowId: packet.windowId as number,
				stateId: packet.stateId as number,
				slot: packet.slot as number,
				carried: packet.item === undefined ? "<undefined>" : "present",
			});
		});
		const originalWrite = bot._client.write.bind(bot._client);
		bot._client.write = (name: string, packet: Record<string, unknown>) => {
			if (name === "window_click")
				mark({
					dir: "send",
					name,
					windowId: packet.windowId as number,
					stateId: packet.stateId as number,
					slot: packet.slot as number,
					note: `mode=${String(packet.mode)} button=${String(packet.mouseButton)}`,
				});
			return originalWrite(name, packet);
		};

		// 给自己一个可移动物品，轮询等到服务端同步进背包（不等固定毫秒）。
		bot.chat("/clear FanRec");
		bot.chat("/give FanRec minecraft:dirt 7");
		let slot = -1;
		for (let i = 0; i < 30 && slot < 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 200));
			slot = bot.inventory.slots.findIndex((item: unknown) => item && (item as { name: string }).name === "dirt");
		}
		mark({ dir: "recv", name: "local", note: `dirt found at slot ${slot}` });
		if (slot < 0) throw new Error("dirt never arrived; /give needs op");

		// 情形 1：mode-0 左键点击玩家背包槽（Uina 侧等价的 click）。
		// stateId:-1 是 Uina 当前硬编码；对照再用 mineflayer 自己跟踪的真实 stateId。
		bot._client.write("window_click", {
			windowId: 0,
			stateId: -1,
			slot,
			mouseButton: 0,
			mode: 0,
			changedSlots: [],
			cursorItem: null,
		});
		await new Promise((resolve) => setTimeout(resolve, 1200));
		mark({ dir: "recv", name: "local", note: "after forced-stateId click" });

		// 情形 2：mode-0 右键（半栈），同一强制 stateId。
		bot._client.write("window_click", {
			windowId: 0,
			stateId: -1,
			slot,
			mouseButton: 1,
			mode: 0,
			changedSlots: [],
			cursorItem: null,
		});
		await new Promise((resolve) => setTimeout(resolve, 1200));

		// 情形 3：mineflayer 官方 clickWindow（它用跟踪到的真实 stateId）。
		try {
			await bot.clickWindow(slot, 0, 0);
		} catch (error) {
			mark({ dir: "recv", name: "local", note: `official click failed: ${String(error)}` });
		}
		await new Promise((resolve) => setTimeout(resolve, 1200));

		clearTimeout(timer);
		done();
	} catch (error) {
		clearTimeout(timer);
		done(error);
	}
});
bot.on("error", (error: Error) => {
	clearTimeout(timer);
	done(error);
});
