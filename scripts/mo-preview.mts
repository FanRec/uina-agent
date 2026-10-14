/**
 * MO 动作预览脚本（本机 VTS + MO 模型）——作者迭代回路工具。
 *
 * 用法：pnpm mo:preview <动作名> [更多动作名...]
 *   - 动作名支持目录内的规范名与中文别名（nod / 点头 / 转圈圈 …）；
 *   - 多个动作按顺序轮播，每次播放重新 bake（幅度纹理每次不同，可观察连播变化）；
 *   - 走 runtime.express 与主脑完全相同的执行路径（gate / 变体轮换 / spatial 归位 / 结算）；
 *   - Ctrl-C 优雅停车（safeStop → 在途 spatial 清理结算）后再退出，再按一次硬退。
 */
import { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { loadCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { MO_SPEECH } from "../.uina/worlds/live2d/models/mo/speech.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

const names = process.argv.slice(2);
if (names.length === 0) {
	console.error("用法: pnpm mo:preview <动作名> [更多动作名...]   例: pnpm mo:preview nod 点头 wink");
	process.exit(1);
}

const rig = await loadRig(MO_MODEL_ID);
if (!rig) {
	console.error("[预览] rig 装配失败，无法预览。");
	process.exit(1);
}
const catalog = loadCatalog(MO_MODEL_ID, rig);
if (!catalog) {
	console.error("[预览] 目录装配失败，无法预览。");
	process.exit(1);
}
// 词表预检：未知名字 fail fast，不等播放时逐个报错。
for (const name of names) {
	if (!catalog.resolveCue(name)) {
		const available = catalog
			.list("motion")
			.map(({ name: n, aliases }) => (aliases.length ? `${n}(${aliases.join("/")})` : n));
		console.error(`[预览] 动作不在目录: "${name}"。可用: ${available.join(", ")}`);
		process.exit(1);
	}
}

const runtime = new Live2DRuntime({ client: new VTSClient(), rig, catalog, speech: MO_SPEECH });
await runtime.start({} as never);
console.log(`[预览] 轮播: ${names.join(" → ")}（每次播放重新 bake；Ctrl-C 停车退出）`);

let stopping = false;
const controller = new AbortController();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 就绪等待：VTS 连接、API 授权（首连需在 VTS 界面点击允许）与模型绑定都是异步事实，
 * 就绪前 express 会被 gate 以 model_not_ready/unadapted 秒拒——等就绪再开播，杜绝拒绝洪水。
 */
const waitReady = async (): Promise<void> => {
	const deadline = Date.now() + 60_000;
	while (!(runtime.connectionOnline && runtime.identityMatched())) {
		if (stopping) return;
		if (Date.now() > deadline) {
			console.error(
				"[预览] 等待 VTS 连接/模型绑定超时（60s）。请确认 VTube Studio 已启动、API 插件已授权（首次连接需在 VTS 界面点击允许）、当前已加载 MO 模型。",
			);
			process.exit(1);
		}
		process.stdout.write("[预览] 等待 VTS 连接与模型绑定…\r");
		await sleep(250);
	}
	console.log("[预览] 已就绪（VTS 已连接，模型绑定核验通过）。");
};

const loop = async (): Promise<void> => {
	await waitReady();
	if (stopping) return;
	let index = 0;
	while (!stopping) {
		const name = names[index % names.length]!;
		index += 1;
		const started = Date.now();
		const result = await runtime.express({ motion: name }, { signal: controller.signal });
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		const details = result.details as { reason?: string } | undefined;
		const reason = details?.reason ? `（${details.reason}）` : "";
		if (!stopping)
			console.log(
				`[${new Date().toLocaleTimeString()}] ${name}: ${result.status}${reason}（${seconds}s）${result.status === "succeeded" ? "" : ` — ${result.result}`}`,
			);
		// 失败退避：gate/执行拒绝时等待后重试（连接抖动/暂停等瞬态），绝不高速重试洪水
		if (result.status !== "succeeded") await sleep(2000);
	}
};

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
	if (stopping) {
		console.error("[预览] 再按一次强制退出。");
		process.exit(1);
	}
	stopping = true;
	console.log(`\n[预览] 收到 ${signal}，safeStop 停车中…（再按一次强制退出）`);
	controller.abort(new Error("preview stop"));
	try {
		await runtime.stop();
	} catch (error) {
		console.error("[预览] 停车清理未完全确认:", error instanceof Error ? error.message : String(error));
	}
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
	await loop();
} catch (error) {
	console.error("[预览] 执行异常:", error instanceof Error ? error.message : String(error));
	await shutdown("SIGTERM").catch(() => process.exit(1));
}
