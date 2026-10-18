/**
 * 连接冒烟：Driver 前置风险验证——mineflayer 4.39.0 ↔ Paper 1.21.11 协议兼容。
 *
 * 验证侧代码（development-plan §4-A）：服务端须已在 25565 运行。
 * 运行：pnpm exec tsx .uina/worlds/minecraft/dev-env/smoke-connection.mts
 * 通过标准：ready 后读到真实 protocol/维度/位置/生命值，退出码 0。
 */

import { ClientHost } from "../driver/client-host.js";

const host = new ClientHost();
const notices: string[] = [];
host.on((n) => {
	if (n.kind === "state") notices.push(`state=${n.state}`);
	if (n.kind === "incarnation_changed") notices.push(`incarnation=${n.identity.incarnation}`);
	if (n.kind === "disconnected") notices.push(`disconnected reason=${n.facts.reason ?? "unknown"}`);
});

try {
	await host.connect({ host: "127.0.0.1", port: 25565, username: "UinaDev", version: "1.21.11" });
} catch (err) {
	console.error("CONNECT FAILED:", err);
	process.exit(1);
}

if (host.state !== "ready" || host.bot == null) {
	console.error(`NOT READY: state=${host.state}`, notices.join(" "));
	await host.close();
	process.exit(1);
}

const bot = host.bot;
const identity = host.identity;
await new Promise((r) => setTimeout(r, 1500)); // 让首批物理步与世界同步完成

const pos = host.position;
const report = {
	identity,
	state: host.state,
	protocol: bot.protocolVersion,
	gameVersion: bot.version,
	dimension: host.dimension,
	position: pos,
	onGround: bot.entity.onGround,
	yaw: bot.entity.yaw,
	pitch: bot.entity.pitch,
	health: bot.health,
	food: bot.food,
	gameMode: bot.game.gameMode,
	worldName: bot.game.levelType ?? null,
	players: Object.keys(bot.players).length,
};

console.log(JSON.stringify(report, null, 2));
console.log("notices:", notices.join(" | "));

const ok =
	typeof report.protocol === "number" &&
	report.dimension != null &&
	report.position != null &&
	Number.isFinite(report.position.x) &&
	report.health > 0;

await host.close();
console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
process.exit(ok ? 0 : 1);
