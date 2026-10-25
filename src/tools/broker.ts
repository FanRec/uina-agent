import { validDeliveryTag } from "../core/delivery.js";
import { validImages } from "../core/content.js";
import { errorMessage } from "../core/errors.js";
import { Registrations } from "../core/registrations.js";
import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { ToolDef, ToolExecutionMode, ToolResultStatus } from "../core/types.js";
import { TOOL_RESULT_STATUSES } from "../core/types.js";
import { executeToolPipeline, type ToolCallRequest, type ToolPipelineOptions } from "./pipeline.js";
import { formatValidationErrors } from "./validation-errors.js";

/** Identity of the caller, independent of the extension that registered a tool. */
export interface ToolExecutionContext {
	readonly ownerId: string;
	readonly callerId?: string;
	readonly invocationId?: string;
}

export interface Tool {
	def: ToolDef;
	executionMode?: ToolExecutionMode;
	/** Execute after the broker has validated the arguments. */
	run(
		args: Record<string, unknown>,
		signal?: AbortSignal,
		context?: ToolExecutionContext,
	): Promise<ToolExecutionResult>;
}

export interface PreparedToolCall {
	name: string;
	args: Record<string, unknown>;
	tool?: Tool;
	validator?: ValidateFunction;
	error?: string;
	validationErrors?: ErrorObject[];
}

export interface ToolExecutionResult {
	receipt?: import("../core/types.js").HostDeliveryTag;
	/** Internal stamp from the actual registration; never trusted from Tool.run. */
	receiptNamespace?: string;
	images?: import("../core/content.js").ImageContent[];
	details?: unknown;
	result: string;
	status: ToolResultStatus;
	/** Ends this decision after recording the result; pending inputs remain queued. */
	continuation?: "stop";
}

interface AjvLike {
	compile(schema: object): ValidateFunction;
}
type AjvConstructorType = new (options: { strict: boolean; allErrors: boolean }) => AjvLike;
const AjvConstructor = createRequire(import.meta.url)("ajv") as AjvConstructorType;
const ajv = new AjvConstructor({ strict: true, allErrors: true });

export interface ToolView {
	names(): string[];
	defs(): ToolDef[];
	has(name: string): boolean;
	getExecutionMode(name: string): ToolExecutionMode;
	prepare(name: string, args: Record<string, unknown>): PreparedToolCall;
	execute(
		prepared: PreparedToolCall,
		signal?: AbortSignal,
		invocationId?: string,
		onValidated?: (result: ToolExecutionResult) => void,
	): Promise<ToolExecutionResult>;
	run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
	executePipeline(
		call: ToolCallRequest,
		options?: ToolPipelineOptions,
	): Promise<
		ToolExecutionResult & {
			callId: string;
			invocationId: string /** 原始执行结果（阶段 D/M7）：canonical journal 落盘用，未经 transformResult 改写。 */;
			canonical?: ToolExecutionResult;
		}
	>;
}

export interface ScopedToolOptions {
	/** Execution identity; inherited implementations run in this caller's context. */
	readonly ownerId?: string;
	readonly callerId?: string;
	/** When present, only these tool names are inherited/visible. */
	readonly include?: readonly string[];
	/** Tool names the child must not inherit/visible. */
	readonly exclude?: readonly string[];
}

export class ToolBroker implements ToolView {
	constructor(private readonly context?: ToolExecutionContext) {}

	getContext(): ToolExecutionContext | undefined {
		return this.context;
	}

	createScopedView(options: ScopedToolOptions = {}): ScopedToolView {
		return new ScopedToolView(this, options);
	}

	private readonly tools = new Registrations<{ tool: Tool; validator: ValidateFunction; deliveryNamespace: string }>();

	register(t: Tool, options: { replace?: boolean; deliveryNamespace?: string } = {}): () => void {
		validateToolDefinition(t);
		const name = t.def.function.name;
		if (this.tools.has(name) && !options.replace) throw new Error(`工具重名: ${name}`);
		const validator = ajv.compile(t.def.function.parameters);
		return this.tools.register(
			name,
			{ tool: t, validator, deliveryNamespace: options.deliveryNamespace ?? `tool:${name}` },
			options,
		);
	}

	remove(name: string): void {
		this.tools.delete(name);
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	names(): string[] {
		return [...this.tools.keys()];
	}

	getDeliveryNamespace(name: string): string | undefined {
		return this.tools.get(name)?.deliveryNamespace;
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name)?.tool;
	}

	defs(): ToolDef[] {
		return [...this.tools.values()].map(({ tool }) => tool.def);
	}

	prepare(name: string, args: Record<string, unknown>): PreparedToolCall {
		const entry = this.tools.get(name);
		if (!entry) return { name, args, error: `未知工具 ${name}` };
		if (!entry.validator(args)) {
			const validationErrors = structuredClone(entry.validator.errors ?? []);
			return {
				name,
				args,
				tool: entry.tool,
				validator: entry.validator,
				validationErrors,
				error: `工具 ${name} 参数校验失败: ${formatValidationErrors(entry.tool.def.function.parameters, args, validationErrors)}`,
			};
		}
		return { name, args, tool: entry.tool, validator: entry.validator };
	}

	async execute(
		prepared: PreparedToolCall,
		signal?: AbortSignal,
		invocationId?: string,
		onValidated?: (result: ToolExecutionResult) => void,
	): Promise<ToolExecutionResult> {
		if (prepared.error) {
			return {
				result: JSON.stringify({ error: prepared.error, status: "not_started" }),
				status: "not_started",
				...(prepared.validationErrors ? { details: { validationErrors: prepared.validationErrors } } : {}),
			};
		}
		const tool = this.tools.get(prepared.name)?.tool;
		if (!tool || tool !== prepared.tool) {
			return {
				result: JSON.stringify({ error: `工具不可用: ${prepared.name} 已被卸载或不存在`, status: "not_started" }),
				status: "not_started",
			};
		}
		return executeToolCore(
			tool,
			prepared.name,
			prepared.args,
			signal,
			this.context,
			invocationId,
			this.getDeliveryNamespace(prepared.name),
			onValidated,
		);
	}

	async run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		return (await this.execute(this.prepare(name, args), signal)).result;
	}

	async executePipeline(
		call: ToolCallRequest,
		options?: ToolPipelineOptions,
	): Promise<ToolExecutionResult & { callId: string; invocationId: string }> {
		return executeToolPipeline(this, call, options);
	}

	getExecutionMode(name: string): ToolExecutionMode {
		return this.tools.get(name)?.tool.executionMode ?? "parallel";
	}
}

async function executeToolCore(
	tool: Tool,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	context?: ToolExecutionContext,
	invocationId?: string,
	deliveryNamespace?: string,
	onValidated?: (result: ToolExecutionResult) => void,
): Promise<ToolExecutionResult> {
	if (signal?.aborted) {
		return {
			result: JSON.stringify({ error: "工具尚未启动，调用已取消", status: "not_started" }),
			status: "not_started",
		};
	}
	try {
		const result = await tool.run(
			args,
			signal,
			context ? { ...context, ...(invocationId ? { invocationId } : {}) } : undefined,
		);
		if (
			!result ||
			typeof result.result !== "string" ||
			!validImages(result.images) ||
			(result.receipt !== undefined && !validDeliveryTag(result.receipt)) ||
			!(TOOL_RESULT_STATUSES as readonly unknown[]).includes(result.status)
		) {
			throw new Error("工具必须返回 { result: string, status: ToolResultStatus }");
		}
		const validated: ToolExecutionResult = {
			...result,
			receipt: result.receipt ? Object.freeze({ key: result.receipt.key, attempt: result.receipt.attempt }) : undefined,
			receiptNamespace: result.receipt ? deliveryNamespace : undefined,
		};
		onValidated?.(validated);
		return validated;
	} catch (error) {
		if (signal?.aborted) {
			return {
				result: "工具已启动，但取消时结果未知。",
				status: "unknown",
				details: { reason: "tool_cancelled" },
			};
		}
		return {
			result: `${name} 执行失败: ${errorMessage(error)}`,
			status: "failed",
			details: { reason: "tool_error" },
		};
	}
}

export class ScopedToolView implements ToolView {
	readonly ownerId?: string;

	constructor(
		private readonly root: ToolBroker,
		private readonly options: ScopedToolOptions = {},
	) {
		this.ownerId = options.ownerId ?? root.getContext()?.ownerId;
	}

	private isAllowed(name: string): boolean {
		if (this.options.include && !this.options.include.includes(name)) return false;
		if (this.options.exclude && this.options.exclude.includes(name)) return false;
		return true;
	}

	has(name: string): boolean {
		return this.isAllowed(name) && this.root.has(name);
	}

	names(): string[] {
		return this.root.names().filter((name) => this.isAllowed(name));
	}

	defs(): ToolDef[] {
		return this.root.defs().filter((def) => this.isAllowed(def.function.name));
	}

	getExecutionMode(name: string): ToolExecutionMode {
		if (!this.has(name)) return "parallel";
		return this.root.getExecutionMode(name);
	}

	prepare(name: string, args: Record<string, unknown>): PreparedToolCall {
		if (!this.root.has(name)) {
			return { name, args, error: `工具不可用: ${name} (在宿主中已被卸载或不存在)` };
		}
		if (!this.isAllowed(name)) {
			const reason = this.options.exclude?.includes(name) ? "已被当前作用域策略排除" : "未包含在当前作用域允许名单中";
			return { name, args, error: `工具不可用: ${name} (${reason})` };
		}
		return this.root.prepare(name, args);
	}

	async execute(
		prepared: PreparedToolCall,
		signal?: AbortSignal,
		invocationId?: string,
		onValidated?: (result: ToolExecutionResult) => void,
	): Promise<ToolExecutionResult> {
		if (prepared.error) {
			return {
				result: JSON.stringify({ error: prepared.error, status: "not_started" }),
				status: "not_started",
				...(prepared.validationErrors ? { details: { validationErrors: prepared.validationErrors } } : {}),
			};
		}
		if (!this.isAllowed(prepared.name)) {
			const reason = this.options.exclude?.includes(prepared.name)
				? "已被当前作用域策略排除"
				: "未包含在当前作用域允许名单中";
			return {
				result: JSON.stringify({ error: `工具不可用: ${prepared.name} (${reason})`, status: "not_started" }),
				status: "not_started",
			};
		}
		const tool = this.root.get(prepared.name);
		if (!tool || tool !== prepared.tool) {
			return {
				result: JSON.stringify({ error: `工具不可用: ${prepared.name} 已被卸载或不存在`, status: "not_started" }),
				status: "not_started",
			};
		}
		const context: ToolExecutionContext | undefined =
			this.ownerId !== undefined ? { ownerId: this.ownerId, callerId: this.options.callerId } : this.root.getContext();
		return executeToolCore(
			tool,
			prepared.name,
			prepared.args,
			signal,
			context,
			invocationId,
			this.root.getDeliveryNamespace(prepared.name),
			onValidated,
		);
	}

	async run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		return (await this.execute(this.prepare(name, args), signal)).result;
	}

	async executePipeline(
		call: ToolCallRequest,
		options?: ToolPipelineOptions,
	): Promise<ToolExecutionResult & { callId: string; invocationId: string; canonical?: ToolExecutionResult }> {
		return executeToolPipeline(this, call, options);
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

export {
	executeToolPipeline,
	type ToolCallRequest,
	type ToolPipelineHooks,
	type ToolPipelineObservers,
	type ToolPipelineOptions,
} from "./pipeline.js";
