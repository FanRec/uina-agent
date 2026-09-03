import type { ExtensionActivation } from "../runner.js";
import type { JobRegistry, JobSnapshot } from "../jobs/registry.js";
import type { SubagentRegistry } from "../subagents/registry.js";
import { ToolBroker } from "../../tools/broker.js";
import { createExecCommandTool } from "./exec-command/index.js";
import getTimeTool from "./get-time/index.js";
import { createJobTools } from "../jobs/tools.js";
import { createSubagentTools } from "../subagents/tools.js";

export interface RuntimeToolsServices {
	jobs: JobRegistry;
	subagents: SubagentRegistry;
	onJobResolved(job: JobSnapshot): void;
}

/** Registers Uina's built-in runtime capabilities through the same activation
 * API used by project extensions. */
export function activateRuntimeTools(services: RuntimeToolsServices): ExtensionActivation {
	return (pi) => {
		pi.registerTool(getTimeTool);
		pi.registerTool(createExecCommandTool(services.jobs, "root"));
		for (const tool of createJobTools(services.jobs, "root")) pi.registerTool(tool);
		for (const tool of createSubagentTools(services.subagents, "root")) pi.registerTool(tool);
		const unsubscribe = services.jobs.onResolved(services.onJobResolved);
		return async () => {
			unsubscribe();
			await services.subagents.close();
			await services.jobs.close();
		};
	};
}

/** Child agents receive the explicit shared capability set, not an implicit
 * directory scan or a copied root registry. */
export function createChildTools(): ToolBroker {
	const tools = new ToolBroker();
	tools.register(getTimeTool);
	return tools;
}
