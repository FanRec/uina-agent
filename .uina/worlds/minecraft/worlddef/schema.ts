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
	"Minecraft：observe 读事实，describe 查实际能力合同和示例；run 接受 selector（能力如 collect@1；裸名为 programs/ 内的程序）或 code，两者恰一。代码是普通 JS：async function main(mc,input) { const {value}=await mc.read('inventory@1'); return await mc.call('craft@1',{item:'oak_planks',count:4}); }。input 缺省 {}；可用 read/call/sleep/progress/withBody、console；mc.progress({summary:'进行中'}) 覆盖当前进度。mc.withBody(async body=>body.call('collect@1',{item:'oak_log',count:2})) 显式委托；回调等待也持有身体。body 支持 drive/dig/attack/useItem/endUse/interact/equip/lookAt/writeSign/openContainer；window 支持 snapshot/click/close，仅 mode-0 左右点击。无 import/require/fs/net。程序完成只表示执行结束，世界效果以动作和观察为准；accepted 后后台继续。工具取消只结束等待，停止游戏任务用 runs.stop；unknown 按原 request 查证，retry 复用原意图。Library 管理/统一发现、waitUntil、decide/checkpoint/continue、feedback/loop、自保尚未交付；长同步计算用 await mc.sleep(0) 分片。缺料查看 progress/remaining，历史容器不是当前库存。";
