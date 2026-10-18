import { Live2DRuntime, type Live2DRuntimeOptions } from "./runtime.js";
import { VTSClient } from "./adapter/vts-client.js";
import { loadRig, MO_MODEL_ID } from "./models/rig-loader.js";
import { loadCatalog } from "./models/mo/catalog.js";
import { MO_SPEECH } from "./models/mo/speech.js";
import { timingFromEnvironment } from "./timing.js";
/**
 * 进程内与 Worker 默认装配同源；注入 fake client 时不构造真实设备客户端。
 * 现场标定：`UINA_LIVE2D_TIMING` 的覆盖值先于代码选项，非法值在启动时直接失败（不做静默回退）。
 */
export async function createLive2DRuntime(options: Live2DRuntimeOptions = {}): Promise<Live2DRuntime> {
	const rig =
		options.rig ??
		(await loadRig(MO_MODEL_ID).catch((error: unknown) => {
			console.warn("[Live2D] rig 装配失败，保活注入停用:", error);
			return undefined;
		}));
	const timing = { ...timingFromEnvironment(process.env.UINA_LIVE2D_TIMING), ...options.timing };
	return new Live2DRuntime({
		...options,
		rig,
		client: options.client ?? new VTSClient(),
		catalog: options.catalog ?? (rig ? loadCatalog(rig.modelID, rig) : undefined),
		speech: options.speech ?? MO_SPEECH,
		timing,
	});
}
