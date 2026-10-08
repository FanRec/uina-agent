import type { ValidateFunction } from "ajv";
import { createRequire } from "node:module";
import type { Tool } from "../../tools/broker.js";
import type { ActionContext, WorldDef, WorldRuntime, OperationIdentity } from "./types.js";

interface AjvLike {
	compile(schema: object): ValidateFunction;
	errorsText(errors: unknown): string;
}
type AjvCtor = new (options: { strict: boolean; allErrors: boolean }) => AjvLike;
const Ajv = createRequire(import.meta.url)("ajv") as AjvCtor;
const ajv = new Ajv({ strict: true, allErrors: true });
export interface WorldToolOptions {
	getRuntime: () => WorldRuntime;
}

export function createWorldTool(def: WorldDef, _options: WorldToolOptions): Tool {
	const closeObjectSchema = (schema: Record<string, unknown>): Record<string, unknown> =>
		schema.type === "object" && schema.additionalProperties === undefined
			? { ...schema, additionalProperties: false }
			: schema;
	const validators = new Map<string, ValidateFunction>();
	for (const [name, action] of Object.entries(def.actions))
		if (action.parameters) validators.set(name, ajv.compile(closeObjectSchema(action.parameters)));
	const names = Object.keys(def.actions);
	const actionSchemas = names.map((name) => {
		const action = def.actions[name]!;
		return {
			type: "object",
			additionalProperties: false,
			properties: {
				action: { type: "string", const: name, description: action.description },
				params: action.parameters
					? closeObjectSchema(action.parameters)
					: {
							type: "object",
							additionalProperties: false,
							description: "此动作不接受参数。",
						},
			},
			required: action.parameters ? ["action", "params"] : ["action"],
		};
	});
	return {
		def: {
			type: "function",
			function: { name: def.name, description: def.description, parameters: { type: "object", oneOf: actionSchemas } },
		},
		...(def.executionMode ? { executionMode: def.executionMode } : {}),
		run: async (raw: Record<string, unknown>, signal?: AbortSignal) => {
			const actionName = typeof raw.action === "string" ? raw.action.trim() : "";
			const params =
				raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)
					? (raw.params as Record<string, unknown>)
					: {};
			const action = def.actions[actionName];
			const identity = `world:${def.name}/${actionName}` as OperationIdentity;
			if (!action)
				return {
					result: `【${def.name} 错误】未知操作: "${actionName}"。可用操作: ${names.join(", ")}`,
					status: "failed" as const,
					details: { operationIdentity: identity, worldName: def.name, action: actionName },
				};
			const validator = validators.get(actionName);
			if (validator && !validator(params))
				return {
					result: `【${def.name} 参数错误】${ajv.errorsText(validator.errors)}`,
					status: "failed" as const,
					details: { operationIdentity: identity, worldName: def.name, action: actionName },
				};
			if (action.validate) {
				const check = action.validate(params);
				if (!check.valid)
					return {
						result: `【${def.name} 参数错误】${check.error ?? "格式不匹配"}`,
						status: "failed" as const,
						details: { operationIdentity: identity, worldName: def.name, action: actionName },
					};
			}
			const ctx: ActionContext = { operationIdentity: identity, signal: signal ?? new AbortController().signal };
			try {
				if (signal?.aborted)
					return {
						result: `操作 "${actionName}" 已被取消。`,
						status: "cancelled" as const,
						details: { operationIdentity: identity, worldName: def.name, action: actionName },
					};
				const result = await action.run(params, ctx);
				if (typeof result === "string")
					return {
						result: `【${def.name} 合同错误】动作必须返回结构化工具结果。`,
						status: "failed" as const,
						details: { operationIdentity: identity, worldName: def.name, action: actionName, reason: "string_result" },
					};
				return {
					...result,
					details: {
						...(result.details && typeof result.details === "object" ? result.details : {}),
						operationIdentity: identity,
						worldName: def.name,
						action: actionName,
					},
				};
			} catch (error) {
				const effectUnknown = Boolean(
					error &&
						typeof error === "object" &&
						"effectUnknown" in error &&
						(error as { effectUnknown?: unknown }).effectUnknown === true,
				);
				return {
					result: signal?.aborted
						? `【${def.name} 已中止】外部副作用状态未知。`
						: effectUnknown
							? `【${def.name} 结果未知】外部副作用可能已经发生，请查询状态后再决定。`
							: `【${def.name} 执行失败】${error instanceof Error ? error.message : String(error)}`,
					status: signal?.aborted || effectUnknown ? ("unknown" as const) : ("failed" as const),
					details: {
						operationIdentity: identity,
						worldName: def.name,
						action: actionName,
						...(effectUnknown ? { effectStatus: "unknown" } : {}),
					},
				};
			}
		},
	};
}
