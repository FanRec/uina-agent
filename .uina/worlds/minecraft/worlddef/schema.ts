/** Facade shapes only; native capability input schemas remain with their descriptors. */
import { descriptor as chatDescriptor } from "../capabilities/actions/chat.js";
import { librarySchema } from "../library/schema.js";

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
		object({ kind: { const: "enqueue" }, priority: { type: "boolean" } }, ["kind"]),
		object({ kind: { const: "replace_pending" }, targets: { type: "array", items: text } }, ["kind"]),
		object({ kind: { const: "preempt_current" }, expectedRun: text }),
	],
};
const port = { type: "integer", minimum: 1, maximum: 65535 };
const worldRef = object({ id: text, revision: text }, ["id"]);
const connectTarget = {
	oneOf: [
		object({ host: text, port, username: text, slot: text, world: worldRef }, ["host"]),
		object({ server: text, username: text, slot: text, world: worldRef }, ["server"]),
	],
};
const entry = (extra: object = {}) => ({
	oneOf: [
		object({ selector: text, input: any, ...extra }, ["selector"]),
		object({ code: { type: "string" }, input: any, ...extra }, ["code"]),
	],
});

export const actionSchemas: Record<string, Record<string, unknown>> = {
	session: {
		oneOf: [
			op("status", {}, []),
			op("list", {}, []),
			op("connect", { target: connectTarget }, ["target"]),
			op("disconnect", {}, []),
		],
	},
	observe: object({ selector: text, input: any }, ["selector"]),
	describe: {
		oneOf: [
			object({ cursor: text }, []),
			object({ query: { type: "string" }, cursor: text }, ["query"]),
			object({ selector: text }),
			object({ kind: { enum: ["capability", "guide", "program", "blueprint", "experience"] }, name: text }),
		],
	},
	run: entry({ schedule }),
	// 与 chat@1 descriptor 同源：facade 工具参数就是该能力的输入合同。
	chat: chatDescriptor.input,
	library: librarySchema,
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
			op("continue", { run: text, decision: text, entry: entry(), environment: { enum: ["inherit", "current"] } }, [
				"run",
				"decision",
				"entry",
			]),
		],
	},
};

/**
 * 工具 description 只负责"入口在哪、什么时候用"，不再承载 API 长文。
 *
 * 环境认知与实践原则由 WorldDef.environmentGuide 在活动会话时以 ENV_PROMPT.md 注入；
 * 运行时注入的 mc.* 合同、schedule 语义、Body/Window 用法与场景策略由
 * describe {kind:'guide',name:'…'} 按需返回的官方只读 Guide 承载；
 * 能力/程序/蓝图的精确 schema 由 describe 的 descriptor 与 library.get 承载；
 * 当前世界事实由 requestContext 状态帧承载。
 * 压缩准则：删掉的每一句都能在 Guide、descriptor、工具 schema 或错误 hint 里找回。
 */
export const nativeGuide =
	"Minecraft：用 session {op:'connect',target:{host:'…',username:'…'|server:'别名'}} 入服；status/list/disconnect 管理会话，同一时刻最多一个活跃客户端。describe 与 library 无连接也可用；observe/run/chat/runs 需要连接。observe 读世界事实；describe 查能力/程序/蓝图/经验/官方 Guide 的合同与示例（kind:'guide' 取全文），library.get 读个人资料原文。run 接受 selector（能力如 collect@1；裸名为 programs/ 内的程序）或 code，两者恰一，input 在 params 内；代码是普通 async function main(mc,input){...}，无 import/require/fs/net。Program 的 mc.* API、Body/Window、schedule 与场景做法按需查 Guide，不要凭记忆猜返回形状。run/chat/runs.continue 只回受理：accepted 表示已交给运行时、完成由 minecraft_completion 投递，not_accepted 表示未派发，unknown 必须用原 request 查证而不是重发；停止游戏任务用 runs.stop。当前世界状态由运行时在每次模型请求前自动附上最新快照，不必额外 observe。";
