import type { ExtensionActivation } from "../runner.js";
import { createExecCommandTool } from "./exec-command/index.js";
import { createRuntimeReloadTool } from "./reload.js";
import getTimeTool from "./get-time/index.js";

/** Registers Uina's built-in runtime capabilities through the same activation
 * API used by project extensions. */
export function activateRuntimeTools(): ExtensionActivation {
	return (pi) => {
		pi.registerTool(getTimeTool);
		pi.registerTool(createExecCommandTool(pi.cwd));
		// runtime_reload：原生 Reload 工具（S2/S3），注册在内置 runtime-tools，
		// 不属于可被 extensions Reload 卸载的项目扩展。
		pi.registerTool(createRuntimeReloadTool(pi));
	};
}
