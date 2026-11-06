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
/** run 短窗覆盖（G8）：默认 3000ms，wait 覆盖，0 只受理不等；更久的等待用 runs.wait。 */
const wait = { type: "number", minimum: 0 };

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
			object({ kind: { enum: ["capability", "program", "blueprint", "experience"] }, name: text }),
		],
	},
	run: entry({ schedule, wait }),
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
 * 常驻指南只保留"每次写程序都会踩"的入口合同与执行语义，以及**没有其他可发现
 * 来源**的 mc API 要点（waitUntil 可等集合/返回语义、body 子操作、schedule 语义——
 * describe 只覆盖能力面，这些运行时注入的 mc.* 方法别处查不到）。API 细节与示例由
 * describe 按需发现（能力描述符自带合同与 examples，library.get 读原文）。
 * 压缩准则：删掉的每一句都必须能在 describe、工具 schema 或错误 hint 里找回。
 */
const baseGuide =
	"Minecraft：先用 session {op:'connect',target:{host:'…',username:'…'|server:'别名'}} 入服（status/list/disconnect 管理会话；同一时刻最多一个活跃客户端，切换用 connect 换目标）。describe 与 library 无连接也可用；observe/run/chat/runs 需要先连接。observe 读事实，describe 查能力/程序/蓝图/经验的实际合同与示例（不含正文，library.get 读原文）。run 接受 selector（能力如 collect@1；裸名为 programs/ 内的程序）或 code，两者恰一；code/selector 与 input 都在 params 内，input 缺省 {}。代码是普通 JS：async function main(mc,input){...}，无 import/require/fs/net；可用 read/call/waitUntil/sleep/progress/withBody、console；mc.progress({summary}) 覆盖当前进度。程序完成只表示执行结束，世界效果以动作和观察为准；accepted 后后台继续。工具取消只结束等待，停止游戏任务用 runs.stop；unknown 按原 request 查证。身体控制：mc.withBody(async body=>...) 显式委托持有身体；body.loop(step) 的 step 是同步函数（读 frame.self.value，返回 ControlInput 或 {done:true}），不能返回 Promise；body 还支持 drive/dig/attack/useItem/endUse/interact/equip/lookAt/writeSign/openContainer，window 支持 snapshot/click/close（仅 mode-0 左右点击）。帧窗约 250ms，长同步计算必须用 await mc.sleep(0) 分片，否则 apply 报 FRAME_EXPIRED。默认自保（岩浆/缺氧/低血新伤害）可打断身体：外层捕获 INTERRUPTED 后重读现场，旧句柄失效。waitUntil 用普通同步布尔条件等待；可等 self/inventory/block/world/entities，events 先 read events@1 取 page.after 放进 target.input；返回 met/timeout 与 values/versions/unknown，来源重建 invalidated；不释放 withBody 持有的身体，需要其他任务供料时在作用域外等待。run.schedule：priority:true 让该 Run 的身体申请插队一档（safety 仍最前），replace_pending 换掉排队项（可带 targets），preempt_current 抢占 control=active 的 Run（expectedRun 必填）；continue 不带 schedule。程序试做后用 library.save {name,summary,from:{run,segment,call}} 保存确切调用（先用 runs.calls 找 Call）；经验是有条件的判断。mc.decide(reason) 同步交还决策，根续段用只读 mc.checkpoint 取检查点，runs.continue {run,decision,entry,environment} 建新段，不恢复旧栈或身体。run 默认短窗 3000ms，{wait:毫秒} 覆盖（0 只受理不等，完成经 minecraft_completion 通知）；更久的显式等待用 runs.wait。minecraft_digest 是信息性摘要，精确读数用 observe。";

const controlGuide =
	"控制交接：持有身体等待的最小程序是 async function main(mc){return mc.withBody(async()=>mc.waitUntil({inv:{ref:'inventory@1'}},()=>false));}；先 runs list 找 control=active 的 run，再以该 run 作为 preempt_current 的 expectedRun 抢占。waiting 不代表持有身体；供料等待写在 withBody 外。";

export const nativeGuide = baseGuide + controlGuide;
