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
	description: "Omit for normal queuing.",
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
	...object({ selector: text, code: { type: "string" }, input: any, ...extra }, []),
	oneOf: [
		{ properties: { selector: {} }, required: ["selector"] },
		{ properties: { code: {} }, required: ["code"] },
	],
});
const detail = { const: "full" };

export const actionSchemas: Record<string, Record<string, unknown>> = {
	session: {
		oneOf: [
			op("status", { detail }, []),
			op("list", {}, []),
			op("connect", { target: connectTarget }, ["target"]),
			op("disconnect", {}, []),
		],
	},
	observe: object({ selector: { ...text, description: "Exact query ref, e.g. self@1." }, input: any, detail }, [
		"selector",
	]),
	describe: {
		oneOf: [
			object({ cursor: text }, []),
			object({ query: { type: "string" }, cursor: text }, ["query"]),
			object({ selector: text, includeSource: { type: "boolean" } }, ["selector"]),
			object({ kind: { enum: ["capability", "guide", "addon", "program", "blueprint", "experience"] }, name: text }),
		],
	},
	run: entry({ schedule }),
	// 与 chat@1 descriptor 同源：facade 工具参数就是该能力的输入合同。
	chat: chatDescriptor.input,
	library: librarySchema,
	tasks: {
		oneOf: [
			op("get", { task: text }),
			op("list", { activeOnly: { type: "boolean" }, cursor: text }, []),
			op("stop", { task: text }),
			op("trace", { task: text, parent: text, cursor: text, record: text }, ["task"]),
			op("continue", { task: text, decision: text, entry: entry(), environment: { enum: ["inherit", "current"] } }, [
				"task",
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
	"Minecraft：session 入服或离开，describe 找玩法和合同，observe 查现场（如 self@1），run 执行动作或 Program，chat 聊天，tasks 接回进度，library 读写自己的资料。入服可用 target:{host,username} 或 {server}。入服后附当前状态。后台任务先回受理，结束时通知。Program 用 async function main(mc,input)，等待用 await mc.sleep(ms)。接口见 describe {kind:'guide',name:'program_api'}。";
