import type { ExtensionActivation } from "../runner.js";
import { createExecCommandTool } from "./exec-command/index.js";
import getTimeTool from "./get-time/index.js";

/** Registers Uina's built-in runtime capabilities through the same activation
 * API used by project extensions. */
export function activateRuntimeTools(): ExtensionActivation {
	return (pi) => {
		pi.registerTool(getTimeTool);
		pi.registerTool(createExecCommandTool(pi.cwd));
	};
}
