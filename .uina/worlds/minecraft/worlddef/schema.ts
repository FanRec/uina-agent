/** Facade shapes only; native capability input schemas remain with their descriptors. */
const text = { type: "string", minLength: 1 };
const any = {};
const object = (properties: object, required: string[] = Object.keys(properties)) => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});
const op = (name: string, properties: object = {}, required: string[] = Object.keys(properties)) =>
	object({ op: { const: name }, ...properties }, ["op", ...required]);
const schedule = {
	oneOf: [
		object({ kind: { const: "enqueue" } }),
		object({ kind: { const: "replace_pending" }, targets: { type: "array", items: text } }, ["kind"]),
		object({ kind: { const: "preempt_current" }, expectedRun: text }),
	],
};
const entry = {
	oneOf: [
		object({ selector: text, input: any, schedule }, ["selector"]),
		object({ code: { type: "string" }, input: any, schedule }, ["code"]),
	],
};
export const actionSchemas: Record<string, Record<string, unknown>> = {
	observe: object({ selector: text, input: any }, ["selector"]),
	describe: {
		oneOf: [
			object({ cursor: text }, []),
			object({ query: { type: "string" }, cursor: text }, ["query"]),
			object({ selector: text }),
			object({ kind: { enum: ["capability", "program", "blueprint", "experience"] }, name: text }),
		],
	},
	run: entry,
	chat: object({ text: { type: "string", minLength: 1 } }),
	library: { type: "object" },
	runs: {
		oneOf: [
			op("status", { run: text }, []),
			op("list", { activeOnly: { type: "boolean" }, cursor: text }, []),
			op("request", { request: text }),
			op("retry", { request: text }),
			op(
				"wait",
				{ run: text, afterRevision: { type: "integer", minimum: 0 }, timeoutMs: { type: "number", minimum: 0 } },
				["run"],
			),
			op("record", { ref: text, format: { enum: ["auto", "inline", "file"] } }, ["ref"]),
			op("calls", { run: text, parent: text, cursor: text }, ["run"]),
			op("stop", { run: text }),
			op("stop", { request: text }),
			op("delivery", { ref: text, retry: { const: false } }, []),
			op("delivery", { ref: text, retry: { const: true }, expectedAttempt: text }),
			op("recover", { expected: object({ attachment: text, gateRevision: { type: "integer", minimum: 0 } }) }, []),
			op("continue", { run: text, decision: text, entry: entry, environment: { enum: ["inherit", "current"] } }, [
				"run",
				"decision",
				"entry",
			]),
		],
	},
};

export const nativeGuide =
	"Minecraft：observe 读取事实，describe 查能力合同和调用示例，run 使用确切 selector（如 collect@1），chat 发送消息或服务器指令；runs 查证、等候、读取记录、停止及恢复。accepted 表示已受理，后台继续执行；工具等待取消不停止 Run，停止用 runs.stop。unknown 先按原 request 查证，retry 复用原意图，不另发新动作。缺料看 progress/remaining；历史容器不是当前库存。程序、Library、决策续段和默认自保尚未交付。先 describe 查实际能力。";
