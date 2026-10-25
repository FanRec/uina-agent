/** Facade shapes only; native capability input schemas remain with their descriptors. */
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
			op("continue", { run: text, decision: text, entry: entry, environment: { enum: ["inherit", "current"] } }, [
				"run",
				"decision",
				"entry",
			]),
		],
	},
};

export const nativeGuide =
	"Minecraft：observe 读事实，describe 查实际能力合同和示例；run 接受 selector（能力如 collect@1；裸名为 programs/ 内的程序）或 code，两者恰一。代码是普通 JS：async function main(mc,input) { const {value}=await mc.read('inventory@1'); return await mc.call('craft@1',{item:'oak_planks',count:4}); }。code/selector 与 input 都放在 params 内，input 缺省 {}；可用 read/call/waitUntil/sleep/progress/withBody、console；mc.progress({summary:'进行中'}) 覆盖当前进度。mc.withBody(async body=>body.call('collect@1',{item:'oak_log',count:2})) 显式委托；回调等待也持有身体。body 支持 drive/dig/attack/useItem/endUse/interact/equip/lookAt/writeSign/openContainer；window 支持 snapshot/click/close，仅 mode-0 左右点击。无 import/require/fs/net。程序完成只表示执行结束，世界效果以动作和观察为准；accepted 后后台继续。工具取消只结束等待，停止游戏任务用 runs.stop；unknown 按原 request 查证，retry 复用原意图。describe 可发现能力与 program/blueprint/experience；精确描述不含正文，library.get 读原文。library 支持 list/get/save/update/delete，省略 kind 默认 program（list 枚举三类）。程序试做后用 library.save {name,summary,from:{run,segment,call}} 保存确切调用；先用 runs.calls 找程序 Call。update 的完整 source 与 metadata 补丁二选一，可带 expectedDigest；在途段使用固定源码，新运行读取新文件。经验是有条件的判断；蓝图原件只登记文件，不认证可施工。mc.waitUntil({inv:{ref:'inventory@1'}},s=>s.inv!==null&&(s.inv.counts.oak_log??0)>=1,{timeoutMs:5000}) 用普通同步布尔条件等待；返回 met/timeout 及 values/versions/unknown，来源重建返回 invalidated。可等 self/inventory/block/world/entities；events 先用 const {value:page}=await mc.read('events@1',{kinds:['chat']}) 取得 page.after，再等待 {messages:{ref:'events@1',input:{after:page.after,limit:200}}}；after 属于 target.input，waitUntil 第三参数只设 timeoutMs。出现 next 必须读完分页。waitUntil 不释放 withBody 持有的身体；需要其他任务供料时在作用域外等待。decide/checkpoint/continue、feedback/loop、自保尚未交付；长同步计算用 await mc.sleep(0) 分片。缺料查看 progress/remaining，历史容器不是当前库存。";
