import type { Tool } from "../../tools/broker.js";
import type { JobRegistry } from "./registry.js";
import { createOwnedTool } from "../task-tool.js";

const WAIT_DEFAULT_MS = 30_000;
/** setTimeout's own limit; longer waits are rejected by schema explicitly, never clamped. */
const WAIT_MAX_MS = 2_147_483_647;

export function createJobTools(jobs: JobRegistry, ownerId: string): Tool[] {
	const tool = (
		name: string,
		description: string,
		parameters: Record<string, unknown>,
		handler: (args: Record<string, unknown>, caller: string, signal?: AbortSignal) => Promise<unknown> | unknown,
	) => createOwnedTool(name, description, parameters, handler, ownerId);

	return [
		tool(
			"job_list",
			"查看当前后台任务的状态、来源、当前执行内容和进度。",
			{ type: "object", properties: {}, additionalProperties: false },
			(_args, caller) => jobs.list(caller),
		),
		tool(
			"job_output",
			"读取后台任务的新输出；可等待新输出或任务结束。",
			{
				type: "object",
				properties: {
					job_id: { type: "string", minLength: 1 },
					cursor: { type: "integer", minimum: 0 },
					wait: { type: "boolean" },
					timeout_ms: { type: "integer", minimum: 1, maximum: WAIT_MAX_MS },
				},
				required: ["job_id"],
				additionalProperties: false,
			},
			async (args, caller, signal) => {
				const id = args.job_id as string;
				const cursor = (args.cursor as number | undefined) ?? 0;
				if (args.wait === true) {
					const requested = (args.timeout_ms as number | undefined) ?? WAIT_DEFAULT_MS;
					await jobs.wait(id, caller, requested, cursor, signal);
				}
				return jobs.read(id, caller, cursor);
			},
		),
		tool(
			"job_kill",
			"请求取消一个后台任务；任务真正停止后才会进入终态。",
			{
				type: "object",
				properties: {
					job_id: { type: "string", minLength: 1 },
					reason: { type: "string" },
				},
				required: ["job_id"],
				additionalProperties: false,
			},
			(args, caller) => {
				const id = args.job_id as string;
				const reason = typeof args.reason === "string" ? args.reason : undefined;
				const outcome = jobs.cancel(id, caller, reason);
				return { outcome, job: jobs.get(id, caller) };
			},
		),
	];
}


