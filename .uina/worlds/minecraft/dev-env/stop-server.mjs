// 用 op 账号（UinaDev）进服发 /stop，让 Paper 保存并 exit 0。
// 用法：node .uina/worlds/minecraft/dev-env/stop-server.mjs
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mineflayer = require("mineflayer");

const bot = mineflayer.createBot({
	host: "127.0.0.1",
	port: 25565,
	username: "UinaDev",
	version: "1.21.11",
	auth: "offline",
});
let stopped = false;
bot.on("spawn", () => {
	setTimeout(() => {
		stopped = true;
		bot.chat("/stop");
		console.log("[stop-server] /stop sent");
	}, 1000);
});
bot.on("end", () => {
	console.log(stopped ? "[stop-server] connection closed after /stop" : "[stop-server] connection closed");
	process.exit(stopped ? 0 : 1);
});
bot.on("error", (err) => {
	console.error(`[stop-server] ${err.message}`);
	process.exit(1);
});
setTimeout(() => {
	console.error("[stop-server] timed out before the server closed the connection");
	process.exit(1);
}, 30000);
