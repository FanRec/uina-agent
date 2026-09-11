import type { ExtensionActivation } from "../runner.js";
import type { JobRegistry } from "../jobs/registry.js";
import type { SubagentRegistry } from "../subagents/registry.js";
import { ToolBroker, ScopedToolView, type ScopedToolOptions } from "../../tools/broker.js";
import { createExecCommandTool } from "./exec-command/index.js";
import getTimeTool from "./get-time/index.js";
import { createJobTools } from "../jobs/tools.js";
import { createSubagentTools } from "../subagents/tools.js";

export interface RuntimeToolsServices {
	jobs: JobRegistry;
	subagents: SubagentRegistry;
}

/** Registers Uina's built-in runtime capabilities through the same activation
 * API used by project extensions. */
export function activateRuntimeTools(services: RuntimeToolsServices): ExtensionActivation {
	return (pi) => {
		pi.registerTool(getTimeTool);
		pi.registerTool(createExecCommandTool(services.jobs, "root"));
		for (const tool of createJobTools(services.jobs, "root")) pi.registerTool(tool);
		for (const tool of createSubagentTools(services.subagents, "root")) pi.registerTool(tool);
		const unsubscribe = services.jobs.onResolved(job => {
			const input = { id: `job-notice-${job.id}`, mode: "followUp" as const, source: { kind: "runtime" as const, type: "job-notice", ref: job.id }, text: `后台任务 ${job.id} 已结束，状态：${job.status}。任务：${job.label}。按需使用 job_output 读取结果；无需回复时可保持安静。`, data: { status: job.status, source: job.source } };
			const delivery = job.ownerId === "root" ? pi.submitInput(input) : services.subagents.acceptInput(job.ownerId, input);
			void delivery.catch(error => pi.ui.notify(`[runtime-tools] 后台结果投递失败：${String(error)}`, "error"));
		});
		return async () => {
			unsubscribe();
			await services.subagents.close();
			await services.jobs.close();
		};
	};
}

export type ChildToolOptions = ScopedToolOptions;

/**
 * Children inherit the parent's capability set by default via a read-only
 * delegation view (ScopedToolView) without duplicating tool registrations or
 * Ajv schema validators.
 */
export function createChildTools(source: ToolBroker, options: ChildToolOptions = {}): ScopedToolView {
	return source.createScopedView(options);
}
