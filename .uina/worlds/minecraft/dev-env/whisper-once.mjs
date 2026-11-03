// 用独立小号向 UinaDev 发一条私聊（/tell），供场景验证 private 分类与推送。
// 与 stop-server.mjs 同一家法：原始 bot 只活在 dev-env 的 .mjs 工具里。
// 用法：node whisper-once.mjs [text]
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mineflayer = require("mineflayer");
const text = process.argv[2] ?? "meet me at base";
const bot = mineflayer.createBot({
	host: "127.0.0.1",
	port: 25565,
	username: "UinaFriend",
	version: "1.21.11",
	auth: "offline",
});
bot.on("spawn", () => {
	setTimeout(() => {
		bot.chat(`/tell UinaDev ${text}`);
		setTimeout(() => {
			bot.quit();
			process.exit(0);
		}, 1500);
	}, 1000);
});
bot.on("kicked", (reason) => {
	console.error(`kicked: ${reason}`);
	process.exit(1);
});
bot.on("error", (error) => {
	console.error(String(error));
	process.exit(1);
});
