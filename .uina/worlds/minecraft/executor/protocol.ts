/** One fixed wire method table. No reflection or caller-selected origins. */
import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";

const Ajv = createRequire(import.meta.url)("ajv") as new (
	options: object,
) => { compile(schema: object): ValidateFunction };
const ajv = new Ajv({ strict: false, allErrors: true });
const ref = { type: "string", minLength: 1 };
const integer = { type: "integer", minimum: 0 };
const any = {};
const object = (properties: object, required: string[] = Object.keys(properties)) => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});
const shaped = (properties: object, required: string[] = Object.keys(properties)) => ({
	type: "object",
	properties,
	required,
});
const gates = { type: "array", items: { enum: ["disabled", "emergency", "owner_lost"] }, uniqueItems: true };
const owner = object({
	attachment: { type: "string" },
	activation: { type: "string" },
	gates,
	gateRevision: integer,
	validForMs: { type: "number", minimum: 0 },
});
// Addon 计划：只传纯值（路径/配置/声明），不传函数、Catalog 实例或裸 Bot。
const serverRequirement = {
	type: "object",
	properties: {
		kind: { enum: ["plugin", "mod", "mod-or-plugin"] },
		id: ref,
		requiredFor: { enum: ["feature", "connection"] },
		note: { type: "string" },
	},
	required: ["kind", "id", "requiredFor"],
};
const resolvedAddon = object({
	id: ref,
	version: ref,
	api: { const: 1 },
	artifactDigest: ref,
	root: ref,
	entry: ref,
	config: any,
	configDigest: ref,
	dependencies: { type: "array", items: ref },
	requestedBy: { type: "array", items: ref },
	minecraft: { type: "array", items: { type: "string" } },
	serverRequirement: { oneOf: [{ type: "null" }, serverRequirement] },
});
const assemblyPlan = object({
	roots: { type: "array", items: ref },
	ordered: { type: "array", items: resolvedAddon },
	digest: ref,
});
const addonStatus = shaped({
	id: ref,
	version: ref,
	api: { const: 1 },
	state: { enum: ["installed", "loaded"] },
	artifactDigest: ref,
	evidence: shaped({
		planned: { type: "boolean" },
		loaded: { type: "boolean" },
		protocol: { enum: ["unknown", "not_required", "pending", "negotiated", "failed"] },
		dataReady: { type: "boolean" },
	}),
	minecraft: { type: "array", items: { type: "string" } },
	serverRequirement: { oneOf: [{ type: "null" }, serverRequirement] },
	dir: ref,
	contributed: shaped({
		actions: integer,
		queries: integer,
		knowledgeItems: integer,
		refs: { type: "array", items: ref },
	}),
});
const summary = shaped({
	run: ref,
	revision: integer,
	phase: { enum: ["queued", "running", "waiting", "stopping", "finished", "awaiting_decision"] },
	record: ref,
});
const status = shaped({
	launch: ref,
	storageId: ref,
	observedAt: ref,
	owner: { anyOf: [{ type: "null" }, owner] },
	connection: { enum: ["connecting", "syncing", "ready", "disconnected", "faulted"] },
	runtime: { enum: ["ready", "unavailable"] },
	world: { type: "object" },
	program: { type: ["object", "null"] },
	addons: { type: "array", items: addonStatus },
	addonConflicts: { type: "array", items: { type: "string" } },
	retirement: { type: ["object", "null"] },
});
const entry = {
	oneOf: [
		object({ kind: { const: "call" }, selector: ref, input: any }),
		object({
			kind: { const: "program" },
			source: { oneOf: [object({ code: { type: "string" } }), object({ name: ref })] },
			input: any,
		}),
	],
};
const schedule = {
	oneOf: [
		object({ kind: { const: "enqueue" } }),
		object({ kind: { const: "replace_pending" }, targets: { type: "array", items: ref } }, ["kind"]),
		object({ kind: { const: "preempt_current" }, expectedRun: ref }),
	],
};
const stopTarget = { oneOf: [object({ run: ref }), object({ request: ref })] };
const acceptance = {
	oneOf: [
		object({ kind: { const: "accepted" }, requestId: ref, segment: ref, snapshot: summary }),
		object({ kind: { const: "unknown" }, requestId: ref, reason: { type: "string" } }),
		object({ kind: { const: "not_accepted" }, requestId: ref, code: ref, message: { type: "string" } }),
	],
};

const definitions = {
	init: {
		input: object({
			launch: ref,
			origin: object({ worldOwner: ref, activation: ref }),
			storageId: ref,
			sessionDataDir: ref,
			sharedDataDir: ref,
			config: { type: "object" },
			addons: assemblyPlan,
			unclean: { type: "boolean" },
			oldControlRetired: { type: "boolean" },
			ownerLifetimeMs: { type: "number", exclusiveMinimum: 0 },
			localGates: gates,
		}),
		output: status,
	},
	status: { input: object({}), output: status, cancellable: true },
	shutdown: { input: object({}), output: { type: "null" } },
	// 只读目录快照：活动会话的 descriptor、addon 状态与选择摘要（纯 JSON，无函数/实例）。
	"directory.snapshot": {
		input: object({}),
		output: shaped({
			launch: ref,
			connection: { enum: ["connecting", "syncing", "ready", "disconnected", "faulted"] },
			descriptors: { type: "array", items: { type: "object" } },
			addons: { type: "array", items: addonStatus },
			selection: shaped({ digest: { type: ["string", "null"] } }),
		}),
		cancellable: true,
	},
	"runtime.attach": { input: object({}), output: owner },
	"runtime.heartbeat": { input: object({ attachment: ref }), output: owner },
	"runtime.setOwnerGate": {
		input: object(
			{
				requestId: ref,
				attachment: ref,
				gate: { enum: ["disabled", "emergency", "owner_lost"] },
				closed: { type: "boolean" },
				expectedRevision: integer,
			},
			["requestId", "attachment", "gate", "closed"],
		),
		output: shaped({
			requestId: ref,
			state: owner,
			persistence: { enum: ["confirmed", "unknown"] },
			control: { enum: ["stopping", "stopped", "unknown"] },
		}),
	},
	"runtime.submit": {
		input: object({ requestId: ref, entry, schedule }),
		output: acceptance,
	},
	"runtime.continue": {
		input: object({ requestId: ref, run: ref, decision: ref, entry, environment: { enum: ["inherit", "current"] } }, [
			"requestId",
			"run",
			"decision",
			"entry",
		]),
		output: acceptance,
	},
	"runtime.lookup": {
		input: object({ requestId: ref }),
		output: shaped({ kind: { enum: ["found", "cancelled", "rejected", "not_found", "unavailable"] } }),
		cancellable: true,
	},
	"runtime.read": { input: object({ run: ref }), output: summary, cancellable: true },
	"runtime.readRecord": {
		input: object({ ref, format: { enum: ["auto", "inline", "file"] } }, ["ref"]),
		output: shaped({ kind: { enum: ["inline", "file"] }, record: any }),
		cancellable: true,
	},
	"runtime.wait": {
		input: object({ run: ref, afterRevision: integer, timeoutMs: { type: "number", minimum: 0 } }, ["run"]),
		output: object({ kind: { enum: ["result", "changed", "timeout"] }, snapshot: summary }),
		cancellable: true,
	},
	"runtime.stop": {
		input: object({ requestId: ref, target: stopTarget }),
		output: shaped({
			requestId: ref,
			target: stopTarget,
			record: { type: ["string", "null"] },
			intent: { enum: ["durable", "unknown"] },
			control: { enum: ["stopping", "stopped", "unknown"] },
			snapshot: { anyOf: [{ type: "null" }, summary] },
		}),
	},
	// 入服终态等待：伴生侧等待 ClientHost 首个终态（ready/断开/故障）或超时，返回事实快照。
	"connection.wait": {
		input: object({ timeoutMs: { type: "number", minimum: 0 } }, []),
		output: object({
			state: { enum: ["connecting", "syncing", "ready", "disconnected", "faulted"] },
			username: { type: ["string", "null"] },
			uuid: { type: ["string", "null"] },
			reason: { type: ["string", "null"] },
		}),
		cancellable: true,
	},
	// Library 变更的窄通知：宿主常驻 Library 发布后让当前 Runtime 撤销过期程序缓存。
	"program.changed": { input: object({}), output: { type: "null" } },
	"runtime.list": {
		input: object({ activeOnly: { type: "boolean" }, cursor: ref }, []),
		output: shaped({ items: { type: "array" } }),
		cancellable: true,
	},
	"runtime.calls": {
		input: object({ run: ref, parent: ref, cursor: ref }, ["run"]),
		output: shaped({ items: { type: "array" } }),
		cancellable: true,
	},
	"runtime.pendingDeliveries": {
		input: object({ cursor: ref, limit: { type: "integer", minimum: 1, maximum: 100 } }, []),
		// total 是积压总数（与分页同条件），不是本页条数：有界扫描的调用方靠它区分
		// "还剩多少"与"这轮看了多少"。
		output: shaped({ items: { type: "array" }, total: { type: "integer" } }),
		cancellable: true,
	},
	"runtime.readDelivery": {
		input: object({ ref }),
		output: shaped({
			delivery: { type: "object" },
			disposition: { enum: ["pending", "committed"] },
			eligible: { type: "boolean" },
		}),
		cancellable: true,
	},
	"runtime.settleDelivery": {
		input: object({
			ref,
			receipt: object({
				namespace: ref,
				session: ref,
				key: ref,
				attempt: ref,
				record: ref,
				channel: { enum: ["tool", "input"] },
			}),
		}),
		output: { type: "null" },
	},

	observe: {
		input: object({ selector: ref, input: any }, ["selector"]),
		output: shaped({
			value: any,
			observedAt: ref,
			source: ref,
			coverage: { enum: ["complete", "partial"] },
			unknown: { type: "array", items: { type: "string" } },
			cursor: { type: ["object", "null"] },
		}),
		cancellable: true,
	},
	// 请求前状态帧（批37）：一次 facts.sample 同一提交边界，返回有界正文与可用性事实。
	// 只读、不消费消息、不推进任何水位——transformContext 也可能被上下文检视触发。
	"state.snapshot": {
		input: object({ profileId: ref }, []),
		output: shaped({
			text: { type: "string" },
			sampledAt: ref,
			connected: { type: "boolean" },
			unknown: { type: "array", items: { type: "string" } },
		}),
	},
	// G11 图片出口：只按 map@1 已产出的 ImageFileRef 读取，伴生进程核验目录/摘要后回 base64。
	read_image: {
		input: object({ path: ref, sha256: ref, bytes: integer, mimeType: ref }),
		output: object({ mimeType: ref, data: { type: "string", minLength: 1 } }),
		cancellable: true,
	},
} satisfies Record<string, { input: object; output: object; cancellable?: boolean }>;

export type RpcMethod = keyof typeof definitions;
export interface MethodSchema {
	input: ValidateFunction;
	output: ValidateFunction;
	cancellable: boolean;
}
export const methods = new Map<string, MethodSchema>(
	Object.entries(definitions).map(([name, spec]) => [
		name,
		{
			input: ajv.compile(spec.input),
			output: ajv.compile(spec.output),
			cancellable: "cancellable" in spec && spec.cancellable === true,
		},
	]),
);

const common = { v: { const: 1 }, launch: ref };
const id = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const error = object({ code: ref, message: { type: "string" }, failure: any, detail: any }, ["code", "message"]);
export const validateFrame = ajv.compile({
	oneOf: [
		object({ ...common, kind: { const: "request" }, id, method: ref, payload: any }),
		object({
			...common,
			kind: { const: "reply" },
			id,
			method: ref,
			result: { oneOf: [object({ ok: { const: true }, value: any }), object({ ok: { const: false }, error })] },
		}),
		object({ ...common, kind: { const: "cancel_wait" }, id }),
		object({
			...common,
			kind: { const: "retire_required" },
			request: object({
				launch: ref,
				source: { enum: ["runtime", "driver", "program"] },
				subject: { type: ["string", "null"] },
				code: { enum: ["CONTROL_ISOLATION_FAILED", "EXECUTION_DOMAIN_UNRETIRED"] },
				detail: { type: "string", maxLength: 2048 },
			}),
		}),
		object(
			{
				...common,
				kind: { const: "changed" },
				runs: { type: "array", items: object({ run: ref, revision: integer }) },
				statusChanged: { type: "boolean" },
				events: { type: "array", items: object({ ref, observedAt: ref, payload: any }) },
			},
			["v", "launch", "kind", "runs", "statusChanged"],
		),
	],
});
export const validateHello = ajv.compile(
	object({ ...common, kind: { const: "hello" }, pid: { type: "integer", minimum: 1 }, createdAt: ref }),
);
