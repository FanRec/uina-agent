/**
 * S3 首包探针：在真实 Paper 服上证明「全部协议贡献挂载后才放行连接」没有竞态。
 *
 * 运行：node .uina/worlds/minecraft/dev/probe-first-packet.mjs
 * 前置：dev-env/start-server.ps1 已启动 Paper 1.21.11 offline @127.0.0.1:25565。
 *
 * 这是取证脚本，不是单元测试，不进 CI。它验证：
 * 1. createClient 传自定义 connect 委托后返回时没有 socket、没有 connect 事件、没有写出任何包；
 * 2. createBot({ client }) 注入同一个 Client 也不会提前连接或写出；
 * 3. 两个 Addon 式 packet handler 在放行前同步安装，且两者都收到第一个服务器包；
 * 4. Configuration 阶段的包在 handler 安装后到达，并能从该阶段回复；
 * 5. 放行后连接正常进入 Play / spawn。
 */
import { createRequire } from "node:module";
import mineflayer from "mineflayer";
import mc from "minecraft-protocol";

const require = createRequire(import.meta.url);
// 复用上游自己的默认连接委托（含 SRV / DNS / stream 行为），不另写一套 TCP 连接。
const tcpDns = require("minecraft-protocol/src/client/tcp_dns.js");
if (typeof tcpDns !== "function") throw new Error("minecraft-protocol 内部连接接缝形状变化");

const HOST = "127.0.0.1";
const PORT = 25565;
const VERSION = "1.21.11";
const t0 = Date.now();
const now = () => Date.now() - t0;
const timeline = [];
const mark = (event, detail = {}) => timeline.push({ t: now(), event, ...detail });

const connector = { host: HOST, port: PORT };
tcpDns(null, connector);
if (typeof connector.connect !== "function") throw new Error("上游没有生成 connect 委托");

let resume = null;
const options = {
	host: HOST,
	port: PORT,
	username: "UinaProbe",
	version: VERSION,
	auth: "offline",
	// createClient 的 offline 分支同步调用这里；只登记放行函数，不建立 socket。
	connect: (client) => {
		resume = () => connector.connect(client);
		mark("connect_delegate_captured", { socket: client.socket != null });
	},
};

const client = mc.createClient(options);
mark("createClient_returned", { state: client.state, socket: client.socket != null, ended: client.ended });

const writes = [];
const originalWrite = client.write.bind(client);
client.write = (name, data) => {
	writes.push({ t: now(), name, state: client.state });
	return originalWrite(name, data);
};

client.on("connect", () => mark("connect_event", { state: client.state }));
client.on("error", (err) => mark("client_error", { message: err.message }));
client.on("end", (reason) => mark("client_end", { reason: String(reason) }));

const bot = mineflayer.createBot({ client, host: HOST, port: PORT, username: "UinaProbe", version: VERSION });
mark("createBot_returned", {
	registryReady: bot.registry != null,
	socket: client.socket != null,
	writes: writes.length,
});

const clientbound = [];
const addonSeen = { alpha: [], beta: [] };
let handlersInstalled = false;
// Driver 自己的观察与两个 Addon 贡献都在放行前同步安装。
for (const id of ["alpha", "beta"]) {
	client.on("packet", (_data, meta) => {
		if (!handlersInstalled) return;
		addonSeen[id].push({ t: now(), name: meta.name, state: client.state });
	});
}
client.on("packet", (_data, meta) => {
	if (!handlersInstalled) return;
	clientbound.push({ t: now(), name: meta.name, state: client.state });
});
handlersInstalled = true;
mark("addon_handlers_installed", {
	socket: client.socket != null,
	writes: writes.length,
	clientbound: clientbound.length,
});

// Configuration 阶段回复：确认状态已进入 configuration 后发一条无害自定义 payload。
let configurationReply = null;
client.on("packet", (_data, meta) => {
	if (configurationReply != null || client.state !== "configuration") return;
	configurationReply = { t: now(), afterPacket: meta.name };
	mark("configuration_reply", { state: client.state, afterPacket: meta.name });
	client.write("custom_payload", { channel: "uina:probe", data: Buffer.from([1]) });
});

if (resume == null) throw new Error("createClient 没有调用 connect 委托");
mark("resume_before", { socket: client.socket != null });
resume();
mark("resume_after", { socket: client.socket != null });

const spawn = await new Promise((resolve) => {
	const timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), 20000);
	const done = (result) => {
		clearTimeout(timer);
		resolve(result);
	};
	bot.once("spawn", () => done({ ok: true, t: now() }));
	bot.once("end", (reason) => done({ ok: false, reason: String(reason) }));
	bot.on("error", (err) => mark("bot_error", { message: err.message }));
});
mark("spawn_or_end", spawn);

const installed = timeline.find((e) => e.event === "addon_handlers_installed");
const resumed = timeline.find((e) => e.event === "resume_before");
const checks = {
	noSocketBeforeResume:
		timeline.find((e) => e.event === "createClient_returned")?.socket === false &&
		timeline.find((e) => e.event === "createBot_returned")?.socket === false &&
		installed?.socket === false,
	noWritesBeforeHandlers: installed?.writes === 0,
	noPacketsBeforeHandlers: installed?.clientbound === 0,
	firstWriteAfterResume: writes.length === 0 || writes[0].t >= resumed.t,
	bothAddonsSeeFirstPacket:
		addonSeen.alpha.length > 0 &&
		addonSeen.beta.length > 0 &&
		addonSeen.alpha[0].name === clientbound[0]?.name &&
		addonSeen.beta[0].name === clientbound[0]?.name,
	configurationHandled: clientbound.some((p) => p.state === "configuration") && configurationReply != null,
	spawnReached: spawn.ok,
};

console.log(
	JSON.stringify(
		{
			server: "Paper 1.21.11-132 @127.0.0.1:25565 (offline)",
			timeline,
			writes: {
				count: writes.length,
				first: writes.slice(0, 10),
				configurationPayload: writes.find((w) => w.name === "custom_payload" && w.state === "configuration") ?? null,
			},
			clientbound: {
				count: clientbound.length,
				first: clientbound.slice(0, 14),
				states: [...new Set(clientbound.map((p) => p.state))],
			},
			addonSeen: {
				alpha: addonSeen.alpha.length,
				beta: addonSeen.beta.length,
				firstAlpha: addonSeen.alpha[0] ?? null,
				firstBeta: addonSeen.beta[0] ?? null,
			},
			configurationReply,
			spawn,
			checks,
		},
		null,
		2,
	),
);

try {
	bot.quit();
} catch {
	// 探针已取证，退出前不强求优雅断线。
}
const ok = Object.values(checks).every(Boolean);
console.log(ok ? "PROBE PASS" : "PROBE FAIL");
process.exit(ok ? 0 : 1);
