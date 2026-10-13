import { createJiti } from "jiti";
import { parentPort, workerData } from "node:worker_threads";

// 与生产自举相同的 loader 参数；测试依赖在本线程创建，不通过 structuredClone 传函数。
const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const { attachEngine } = await jiti.import("../../.uina/worlds/live2d/worker/engine.ts");
const { refactorWorkerRuntime } = await jiti.import("../live2d-refactor-fixture.ts");
const { emptyCatalog } = await jiti.import("../../.uina/worlds/live2d/authoring/catalog.ts");
let fixture;
let release;
const engine = attachEngine((message) => parentPort.postMessage(message), {
	runtimeFactory: (notify) => {
		fixture = refactorWorkerRuntime(notify);
		if (workerData?.failStart)
			fixture.client.connect = () => {
				throw new Error("fixture connect failed");
			};
		if (workerData?.holdMove) {
			const move = fixture.client.moveModel.bind(fixture.client);
			let first = true;
			fixture.client.moveModel = async (value) => {
				await move(value);
				if (!first) return;
				first = false;
				parentPort.postMessage({ t: "fixture", event: "moving" });
				await new Promise((resolve) => {
					release = resolve;
				});
			};
		}
		return fixture.runtime;
	},
});
parentPort.on("message", (message) => {
	if (message.t !== "fixture") {
		engine.onMessage(message);
		return;
	}
	if (message.action === "disconnect") {
		fixture.state.connected = false;
		fixture.state.listener(false);
	} else if (message.action === "release") release?.();
	else if (message.action === "clearCatalog") fixture.runtime.setCatalog(emptyCatalog(fixture.state.modelID));
	else if (message.action === "failRestore") fixture.state.failTintRestore = true;
	else if (message.action === "exit") process.exit(1);
	parentPort.postMessage({ t: "fixture", event: message.action });
});
