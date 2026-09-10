import type { Tool } from "../../tools/broker.js";
import type { JobRegistry } from "./registry.js";

const WAIT_DEFAULT_MS = 30_000;
/** setTimeout's own limit; longer waits are rejected explicitly, never clamped. */
const WAIT_MAX_MS = 2_147_483_647;

export function createJobTools(jobs: JobRegistry, ownerId: string): Tool[] {
	return [
		{
			def: {
				type: "function",
				function: {
					name: "job_list",
					description: "查看当前后台任务的状态、来源、当前执行内容和进度。",
					parameters: { type: "object", properties: {}, additionalProperties: false },
				},
			},
			run: async (_args, _signal, context) => ({ result: JSON.stringify(jobs.list(context?.ownerId ?? ownerId)), status: "succeeded" }),
		},
		{
			def: {
				type: "function",
				function: {
					name: "job_output",
					description: "读取后台任务的新输出；可等待新输出或任务结束。",
					parameters: {
						type: "object",
						properties: {
							job_id: { type: "string" }, cursor: { type: "integer", minimum: 0 },
							wait: { type: "boolean" }, timeout_ms: { type: "integer", minimum: 1 },
						}, required: ["job_id"], additionalProperties: false,
					},
				},
			},
			run: async (args, signal, context) => {
				const caller = context?.ownerId ?? ownerId;
				const id = requiredString(args.job_id, "job_id");
				const cursor = optionalInteger(args.cursor, 0, "cursor");
				if (args.wait === true) {
					const requested = optionalInteger(args.timeout_ms, WAIT_DEFAULT_MS, "timeout_ms");
					if (requested > WAIT_MAX_MS) throw new Error(`timeout_ms 超过上限 ${WAIT_MAX_MS}，请显式拆分为多次等待`);
					await jobs.wait(id, caller, requested, cursor, signal);
				}
				return { result: JSON.stringify(jobs.read(id, caller, cursor)), status: "succeeded" };
			},
		},
		{
			def: {
				type: "function",
				function: {
					name: "job_kill",
					description: "请求取消一个后台任务；任务真正停止后才会进入终态。",
					parameters: {
						type: "object", properties: { job_id: { type: "string" }, reason: { type: "string" } },
						required: ["job_id"], additionalProperties: false,
					},
				},
			},
			run: async (args, _signal, context) => {
				const caller = context?.ownerId ?? ownerId;
				const id = requiredString(args.job_id, "job_id");
				const reason = typeof args.reason === "string" ? args.reason : undefined;
				const outcome = jobs.cancel(id, caller, reason);
				return { result: JSON.stringify({ outcome, job: jobs.get(id, caller) }), status: "succeeded" };
			},
		},
	];
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
	return value;
}

function optionalInteger(value: unknown, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} 必须是非负整数`);
	return value as number;
}
