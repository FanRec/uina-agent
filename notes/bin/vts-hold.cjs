// 把某个参数按住不放（持续注入 N 秒），好让人肉眼看见。
// 单次注入只影响一帧，看不出来，所以这里按 ~30Hz 连发。
// 用法：node notes/bin/vts-hold.cjs ParamBodyAngleX 25 5
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const [name, valueRaw, secondsRaw] = process.argv.slice(2);
const value = Number(valueRaw);
const seconds = Number(secondsRaw || 5);
if (!name || Number.isNaN(value)) {
	console.error("用法: node notes/bin/vts-hold.cjs <参数名> <值> [秒数]");
	process.exit(9);
}

const tokenFile = path.join(__dirname, "..", "..", ".uina", "worlds", "live2d", "vts-token.json");
const { pluginName, pluginDeveloper, token } = JSON.parse(fs.readFileSync(tokenFile, "utf8"));

const ws = new WebSocket("ws://127.0.0.1:8001");
const req = (messageType, data) =>
	JSON.stringify({ apiName: "VTubeStudioPublicAPI", apiVersion: "1.0", requestID: messageType, messageType, data });

let timer = null;
let stopped = false;
let startedAt = 0;

ws.on("open", () => {
	ws.send(req("AuthenticationRequest", { pluginName, pluginDeveloper, authenticationToken: token }));
});

ws.on("message", (raw) => {
	const msg = JSON.parse(raw.toString());
	if (!msg.messageType.endsWith("Response")) return;

	if (msg.messageType === "AuthenticationResponse") {
		console.log(`认证通过。按住 ${name} = ${value}，持续 ${seconds} 秒…`);
		const started = Date.now();
		startedAt = started;
		const deadline = started + seconds * 1000;
		// 每 1 秒回读一次，看这个值到底维持了多久
		const watcher = setInterval(() => {
			ws.send(req("InputParameterListRequest", {}));
		}, 1000);
		timer = setInterval(() => {
			if (Date.now() > deadline) {
				if (!stopped) {
					stopped = true;
					clearInterval(timer);
					clearInterval(watcher);
					console.log("松手。");
					setTimeout(() => {
						ws.close();
						process.exit(0);
					}, 300);
				}
				return;
			}
			ws.send(
				req("InjectParameterDataRequest", {
					faceFound: false,
					mode: "set",
					parameterValues: [{ id: name, value, weight: 1 }],
				}),
			);
		}, 33);
		return;
	}

	if (msg.messageType === "InputParameterListResponse") {
		const d = msg.data || {};
		const all = [...(d.defaultParameters || []), ...(d.customParameters || [])];
		const hit = all.find((p) => p.name === name);
		const t = ((Date.now() - startedAt) / 1000).toFixed(1);
		console.log(`t=${t}s  ${name} = ${hit ? hit.value : "(没这个参数)"}`);
		return;
	}

	if (msg.messageType === "APIError") {
		console.error("VTS 报错:", JSON.stringify(msg.data));
		clearInterval(timer);
		ws.close();
		process.exit(4);
	}
});

ws.on("error", (err) => {
	console.error("连接错误：", err.message);
	process.exit(1);
});
