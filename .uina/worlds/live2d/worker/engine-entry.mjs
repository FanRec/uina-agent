/**
 * 引擎 worker 线程入口（纯 JS）。
 *
 * 为何不是直接 new Worker(engine.ts)：tsx 的 loader 是线程局部的，worker 线程里
 * `.js` 说明符 → `.ts` 文件的相对导入映射失效（ERR_MODULE_NOT_FOUND）。
 * 因此入口保持纯 JS 原生可加载，再用宿主同款 jiti（ world-loader.ts 同参数）
 * 加载 TS 世界代码——jiti 的扩展名映射已被 world 在主线程的加载实证。
 */
import { createJiti } from "jiti";
import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("engine-entry.mjs 只能作为 worker_threads 入口运行");

const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const engineModule =
	/** @type {{ attachEngine: (post: (msg: unknown) => void) => { onMessage: (msg: unknown) => void } }} */ (
		await jiti.import("./engine.ts")
	);

const port = parentPort;
const engine = engineModule.attachEngine((msg) => port.postMessage(msg));
port.on("message", (msg) => engine.onMessage(msg));
