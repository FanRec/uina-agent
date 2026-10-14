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
const loop = async (): Promise<void> => {
	let index = 0;
	while (!stopping) {
		const name = names[index % names.length]!;
		index += 1;
		const started = Date.now();
		const result = await runtime.express({ motion: name }, { signal: controller.signal });
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		if (!stopping) console.log(`[${new Date().toLocaleTimeString()}] ${name}: ${result.status}（${seconds}s）`);
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
