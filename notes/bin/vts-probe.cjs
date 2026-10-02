// 探针：直接问 VTube Studio 要"模型到底有哪些参数、现在值是多少"
// 用途：判断 live2d 世界的姿态指令有没有真的落到模型上（而不是被模型忽略）
// 跑法：node notes/bin/vts-probe.cjs
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const tokenFile = path.join(__dirname, "..", "..", ".uina", "worlds", "live2d", "vts-token.json");
const { pluginName, pluginDeveloper, token } = JSON.parse(fs.readFileSync(tokenFile, "utf8"));

const ws = new WebSocket("ws://127.0.0.1:8001");
let step = "auth";

const req = (messageType, data) =>
	JSON.stringify({ apiName: "VTubeStudioPublicAPI", apiVersion: "1.0", requestID: messageType, messageType, data });

const timer = setTimeout(() => {
	console.error("!! 超时：没等到回包");
	process.exit(2);
}, 10000);

ws.on("open", () => {
	ws.send(
		req("AuthenticationRequest", {
			pluginName,
			pluginDeveloper,
			authenticationToken: token,
		}),
	);
});

ws.on("message", (raw) => {
	const msg = JSON.parse(raw.toString());
	if (process.env.VTS_DEBUG) console.log("<<", msg.messageType, JSON.stringify(msg.data || {}).slice(0, 200));
	if (msg.messageType === "APIError") {
		console.error("VTS API 报错：", JSON.stringify(msg.data));
		clearTimeout(timer);
		ws.close();
		process.exit(1);
	}
	if (!msg.messageType.endsWith("Response")) return;

	if (msg.messageType === "AuthenticationResponse") {
		if (!msg.data || msg.data.authenticated !== true) {
			console.error("认证失败：", JSON.stringify(msg.data));
			clearTimeout(timer);
			process.exit(3);
		}
		console.log("认证通过。");
		ws.send(req("InputParameterListRequest", {}));
		return;
	}

	if (step === "inject") {
		console.log("注入回包：", JSON.stringify(msg.data).slice(0, 400));
		clearTimeout(timer);
		ws.close();
		process.exit(0);
	}

	if (msg.messageType === "InputParameterListResponse") {
		const d = msg.data || {};
		console.log("原始回包字段：", Object.keys(d).join(", "));
		const params = [
			...(d.defaultParameters || []),
			...(d.customParameters || []),
			...(d.modelParameters || d.parameters || []),
		];
		console.log("modelLoaded:", d.modelLoaded, "| modelName:", d.modelName, "| 参数数:", params.length);
		if (params.length === 0) {
			console.log("--- 原样打印（截断 1200 字）---");
			console.log(JSON.stringify(d).slice(0, 1200));
		}
		console.log(
			`customParameters（模型自己的参数）: ${(d.customParameters || []).length} 个`,
			(d.customParameters || []).map((p) => p.name).join(", ") || "(空)",
		);
		for (const p of d.customParameters || []) {
			console.log(`  ${p.name} = ${p.value}  [${p.min}, ${p.max}]  默认 ${p.defaultValue}`);
		}
		if (process.env.VTS_INJECT) {
			const [name, value] = process.env.VTS_INJECT.split("=");
			console.log(`--- 试着注入 ${name} = ${value} ---`);
			step = "inject";
			ws.send(
				req("InjectParameterDataRequest", {
					faceFound: false,
					mode: "set",
					parameterValues: [{ id: name, value: Number(value), weight: 1 }],
				}),
			);
			return;
		}
		const interesting = params.filter((p) =>
			/^(ParamAngle|ParamBody|ParamCheek|ParamEyeLOpen|ParamEyeROpen|ParamEyeBall|ParamBrow|ParamMouthForm|ParamMouthOpen|FaceAngle|BodyAngle|EyeOpen|MouthOpen|MouthSmile|Brow)/.test(
				p.name,
			),
		);
		console.log("--- 全部参数名 ---");
		console.log(params.map((p) => p.name).join(", "));
		console.log("--- 姿态表里用到的那些 ---");
		for (const p of interesting) {
			console.log(
				`${p.name.padEnd(22)} 当前 ${String(p.value).padStart(8)}  范围 [${p.min}, ${p.max}]  默认 ${p.defaultValue}`,
			);
		}
		clearTimeout(timer);
		ws.close();
		process.exit(0);
	}
});

ws.on("error", (err) => {
	console.error("连接错误：", err.message);
	clearTimeout(timer);
	process.exit(1);
});
