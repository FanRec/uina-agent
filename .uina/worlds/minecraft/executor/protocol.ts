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
const owner = object({ attachment: ref, gates, gateRevision: integer, validForMs: { type: "number", minimum: 0 } });
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

const definitions = {
	init: {
		input: object({
			launch: ref,
			origin: object({ worldOwner: ref, activation: ref }),
			storageId: ref,
			worldDataDir: ref,
			config: { type: "object" },
			unclean: { type: "boolean" },
			oldControlRetired: { type: "boolean" },
			ownerLifetimeMs: { type: "number", exclusiveMinimum: 0 },
			localGates: gates,
		}),
		output: status,
	},
	status: { input: object({}), output: status, cancellable: true },
	shutdown: { input: object({}), output: { type: "null" } },
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
		output: {
			oneOf: [
				object({ kind: { const: "accepted" }, requestId: ref, segment: ref, snapshot: summary }),
				object({ kind: { const: "unknown" }, requestId: ref, reason: { type: "string" } }),
				object({ kind: { const: "not_accepted" }, requestId: ref, code: ref, message: { type: "string" } }),
			],
		},
	},
	"runtime.lookup": {
		input: object({ requestId: ref }),
		output: shaped({ kind: { enum: ["found", "cancelled", "not_found", "unavailable"] } }),
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
	describe: { input: { type: "object" }, output: { type: "object" }, cancellable: true },
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
		output: shaped({ items: { type: "array" } }),
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
