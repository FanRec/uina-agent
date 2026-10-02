// 试着在 VTS 里建一个自定义参数，看它接不接。
// 用法：node notes/bin/vts-create-param.cjs ParamBodyAngleX
// 目的：验证"自定义参数能不能直接用模型自己的参数名"（VTS 之前报 453 说 Live2D 参数不能直接注入）
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const parameterName = process.argv[2];
if (!parameterName) {
	console.error("用法: node notes/bin/vts-create-param.cjs <参数名>");
	process.exit(9);
}

const tokenFile = path.join(__dirname, "..", "..", ".uina", "worlds", "live2d", "vts-token.json");
const { pluginName, pluginDeveloper, token } = JSON.parse(fs.readFileSync(tokenFile, "utf8"));

const ws = new WebSocket("ws://127.0.0.1:8001");
const req = (messageType, data) =>
	JSON.stringify({ apiName: "VTubeStudioPublicAPI", apiVersion: "1.0", requestID: messageType, messageType, data });

const timer = setTimeout(() => {
	console.error("!! 超时：没等到回包");
	process.exit(2);
}, 10000);

ws.on("open", () => {
	ws.send(req("AuthenticationRequest", { pluginName, pluginDeveloper, authenticationToken: token }));
});

ws.on("message", (raw) => {
	const msg = JSON.parse(raw.toString());
	if (process.env.VTS_DEBUG) console.log("<<", msg.messageType, JSON.stringify(msg.data || {}).slice(0, 300));
	if (!msg.messageType.endsWith("Response")) return;

	if (msg.messageType === "AuthenticationResponse") {
		console.log("--- 试着创建自定义参数:", parameterName, "---");
		ws.send(
			req("ParameterCreationRequest", {
				parameterName,
				explanation: "Uina body pose",
				min: -30,
				max: 30,
				defaultValue: 0,
			}),
		);
		return;
	}

	console.log("回包:", msg.messageType, JSON.stringify(msg.data || {}).slice(0, 400));
	clearTimeout(timer);
	ws.close();
	process.exit(msg.messageType === "ParameterCreationResponse" ? 0 : 4);
});

ws.on("error", (err) => {
	console.error("连接错误：", err.message);
	clearTimeout(timer);
	process.exit(1);
});
