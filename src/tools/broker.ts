import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type {
	ToolDef,
	ToolExecutionMode,
	ToolResultStatus,
} from "../core/types.js";

export interface Tool {
	def: ToolDef;
	executionMode?: ToolExecutionMode;
	/** Execute after the broker has validated the arguments. */
	run(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

export interface PreparedToolCall {
	name: string;
	args: Record<string, unknown>;
	tool?: Tool;
	validator?: ValidateFunction;
	error?: string;
}

export interface ToolExecutionResult {
	result: string;
	status: ToolResultStatus;
}

interface AjvLike {
	compile(schema: object): ValidateFunction;
	errorsText(errors: unknown): string;
}
type AjvConstructorType = new (options: {
	strict: boolean;
	allErrors: boolean;
}) => AjvLike;
const AjvConstructor = createRequire(import.meta.url)("ajv") as AjvConstructorType;
const ajv = new AjvConstructor({ strict: true, allErrors: true });

export class ToolBroker {
	private readonly tools = new Map<
		string,
		{ tool: Tool; validator: ValidateFunction }
	>();

	register(t: Tool): void {
		validateToolDefinition(t);
		const name = t.def.function.name;
		if (this.tools.has(name)) throw new Error(`工具重名: ${name}`);
		const validator = ajv.compile(t.def.function.parameters);
		this.tools.set(name, { tool: t, validator });
	}

	remove(name: string): void {
		this.tools.delete(name);
	}

	names(): string[] {
		return [...this.tools.keys()];
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name)?.tool;
	}

	defs(): ToolDef[] {
		return [...this.tools.values()].map(({ tool }) => tool.def);
	}

	/** Copy the currently registered tool implementations into another broker. */
	copyTo(target: ToolBroker): void {
		for (const { tool } of this.tools.values()) target.register(tool);
	}

	prepare(name: string, args: Record<string, unknown>): PreparedToolCall {
		const entry = this.tools.get(name);
		if (!entry) return { name, args, error: `未知工具 ${name}` };
		if (!entry.validator(args)) {
			return {
				name,
				args,
				tool: entry.tool,
				validator: entry.validator,
				error: `工具 ${name} 参数校验失败: ${ajv.errorsText(entry.validator.errors)}`,
			};
		}
		return { name, args, tool: entry.tool, validator: entry.validator };
	}

	async execute(
		prepared: PreparedToolCall,
		signal?: AbortSignal,
	): Promise<ToolExecutionResult> {
		if (prepared.error) {
			return {
				result: JSON.stringify({ error: prepared.error, status: "not_started" }),
				status: "not_started",
			};
		}
		if (!prepared.tool) {
			return {
				result: JSON.stringify({ error: `未知工具 ${prepared.name}`, status: "failed" }),
				status: "failed",
			};
		}
		if (signal?.aborted) {
			return {
				result: JSON.stringify({ error: "工具调用已取消", status: "cancelled" }),
				status: "cancelled",
			};
		}
		try {
			const result = await prepared.tool.run(prepared.args, signal);
			if (typeof result !== "string") throw new Error("工具必须返回字符串");
			return {
				result: signal?.aborted
					? JSON.stringify({ error: "工具已返回，但取消时无法确认副作用状态", status: "unknown", result })
					: result,
				status: signal?.aborted ? "unknown" : "succeeded",
			};
		} catch (error) {
			if (signal?.aborted) {
				return {
					result: JSON.stringify({ error: "工具已启动，但取消时结果未知", status: "unknown" }),
					status: "unknown",
				};
			}
			return {
				result: JSON.stringify({
					error: `${prepared.name} 执行失败: ${safeErrorMessage(error)}`,
					status: "failed",
				}),
				status: "failed",
			};
		}
	}

	async run(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<string> {
		return (await this.execute(this.prepare(name, args), signal)).result;
	}

	getExecutionMode(name: string): ToolExecutionMode {
		return this.tools.get(name)?.tool.executionMode ?? "parallel";
	}
}

function validateToolDefinition(t: Tool): void {
	if (!t || typeof t !== "object") throw new Error("工具导出不是对象");
	const fn = t.def?.function;
	if (
		t.def?.type !== "function" ||
		!fn ||
		typeof fn.name !== "string" ||
		!fn.name.trim() ||
		typeof fn.description !== "string" ||
		!fn.description.trim() ||
		!fn.parameters ||
		typeof fn.parameters !== "object" ||
		typeof t.run !== "function"
	) {
		throw new Error("工具声明不完整，需要 name、description、parameters 和 run");
	}
}

export function safeErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
