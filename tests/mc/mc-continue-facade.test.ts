import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type {
	Acceptance,
	ContinueRequest,
	RunRequest,
	StopCommand,
} from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { MinecraftFacade } from "../../.uina/worlds/minecraft/executor/facade.js";
import type { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";
import { ExecutorLedger } from "../../.uina/worlds/minecraft/executor/ledger.js";
import type { RequestCredential, TaskRequestSelection } from "../../.uina/worlds/minecraft/executor/ledger-worker.js";
import { methods } from "../../.uina/worlds/minecraft/executor/protocol.js";
import { createMinecraftWorld } from "../../.uina/worlds/minecraft/worlddef/index.js";
import { actionSchemas } from "../../.uina/worlds/minecraft/worlddef/schema.js";
import { createWorldTool } from "../../src/extensions/world-framework/world-tool.js";

function fixture() {
	const credentials = new Map<string, RequestCredential>();
	const submissions: RunRequest[] = [];
	const continuations: ContinueRequest[] = [];
	const stops: StopCommand[] = [];
	const found: unknown[] = [];
	const attempts: unknown[] = [];
	const notices = new Map<string, string>();
	const snapshot = {
		run: "run:one",
		rootRequestId: "root",
		completion: { scope: "execution" },
		phase: "awaiting_decision",
		decision: "decision:one",
		revision: 2,
		record: "record:one",
	};
	const accept = (requestId: string) =>
		({ kind: "accepted", requestId, segment: "segment:two", snapshot }) as Acceptance;
	const executor = {
		status: () => ({ actionsAllowed: true, side: { launch: "launch" } }),
		ledger: {
			putRequest: async (credential: RequestCredential) => {
				credentials.set(credential.requestId, credential);
			},
			getRequest: async (id: string) => credentials.get(id) ?? null,
			requests: async (selection?: TaskRequestSelection) =>
				[...credentials.values()].filter(
					(item) =>
						selection?.kind !== "continuation" ||
						(item.operation === "continue" &&
							item.request.run === selection.run &&
							item.request.decision === selection.decision &&
							!item.run &&
							!item.refusal),
				),

			refuse: async (id: string, refusal: RequestCredential["refusal"]) => {
				credentials.get(id)!.refusal = refusal;
			},
			found: async (_id: string, lookup: unknown) => {
				found.push(lookup);
			},
			putAttempt: async (attempt: unknown) => {
				attempts.push(attempt);
			},
			markNotice: async (id: string, state: string) => {
				notices.set(id, state);
			},
		},
		submit: async (request: RunRequest) => {
			submissions.push(request);
			return accept(request.requestId);
		},
		continue: async (request: ContinueRequest) => {
			continuations.push(request);
			return accept(request.requestId);
		},
		stop: async (command: StopCommand) => {
			stops.push(command);
			return { intent: "durable", control: "stopped", snapshot: null };
		},
		lookup: async (requestId: string) => ({ kind: requestId === "root" ? "found" : "not_found", requestId, snapshot }),
		wait: async () => ({ kind: "timeout", snapshot }),
	};
	const facade = new MinecraftFacade(executor as unknown as MinecraftExecutor, {
		signal: new AbortController().signal,
		delivery: {
			namespace: "world:minecraft",
			session: "session",
			durability: "durable",
			inspect: async () => ({ kind: "absent" }),
			retire: async () => ({ kind: "retired" }),
		},
	});
	return {
		executor,
		facade,
		credentials,
		submissions,
		continuations,
		found,
		attempts,
		notices,
		stops,
		accept,
		snapshot,
	};
}
const continuation = {
	op: "continue",
	task: "task:local:root",
	decision: "decision:one",
	entry: { code: "async function main(mc){return mc.checkpoint;}" },
	environment: "inherit",
};

test("shared schema fields preserve mutually exclusive run and library inputs", () => {
	const world = createMinecraftWorld();
	expect(() => createWorldTool(world, { getRuntime: () => ({ definition: world, enabled: true }) })).not.toThrow();
	const Ajv = createRequire(import.meta.url)("ajv");
	const ajv = new Ajv({ strict: false });
	const run = ajv.compile(actionSchemas.run);
	const library = ajv.compile(actionSchemas.library);
	const input = { item: "oak_log" };
	const schedule = { kind: "enqueue", priority: true };
	const code = "async function main(){}";
	for (const params of [
		{ selector: "collect@1", input, schedule },
		{ code, input, schedule },
	])
		expect(run(params)).toBe(true);
	for (const params of [{ input }, { code, selector: "collect@1" }, { code, bogus: true }, { code: 42 }])
		expect(run(params)).toBe(false);
	const save = { op: "save", name: "fixture", summary: "test" };
	const update = { op: "update", name: "fixture" };
	const source = code;
	const from = { run: "r", segment: "s", call: "c" };
	const metadata = { summary: "revised" };
	for (const params of [
		{ ...save, source },
		{ ...save, from },
		{ ...save, kind: "blueprint" },
		{ ...update, source },
		{ ...update, metadata },
		{ ...update, kind: "experience", text: "note" },
	])
		expect(library(params)).toBe(true);
	for (const params of [
		save,
		{ ...save, source, from },
		{ ...save, from: { ...from, extra: true } },
		update,
		{ ...update, source, metadata },
		{ ...update, metadata, expectedDigest: "bad" },
	])
		expect(library(params)).toBe(false);
});

test.each([false, true])("construction decisions give read-only evidence (unconfirmed write: %s)", async (unknown) => {
	const f = fixture();
	const at = { x: 10, y: 100, z: 8 };
	const task = "task:local:root";
	const reason = unknown ? "the old segment has unconfirmed writes" : "Construction has unsatisfied target cells";
	const snapshot = {
		...f.snapshot,
		reason,
		completionRef: "completion:one",
		unknownEffects: unknown ? ["effect:one"] : [],
		unknownEffectCount: unknown ? 1 : 0,
	};
	f.credentials.set("root", {
		operation: "submit",
		requestId: "root",
		activation: "launch",
		createdAt: "now",
		request: {
			requestId: "root",
			entry: { kind: "call", selector: "build.resume@1", input: { cells: [{ at, block: "oak_log" }] } },
			schedule: { kind: "enqueue" },
		},
	});
	Object.assign(f.executor, {
		lookup: async () => ({ kind: "found", snapshot }),
		rpc: async () => ({ delivery: { completionRef: snapshot.completionRef, recordBytes: 500 } }),
		readRecord: async () => ({
			kind: "inline",
			record: {
				kind: "completion",
				value: {
					reportKind: "decision",
					snapshot: { ...snapshot, checkpoint: { kind: "program", value: { verified: 0, remaining: [at] } } },
				},
			},
		}),
	});
	const reply = await f.facade.execute("tasks", { op: "get", task }, new AbortController().signal);
	expect(reply.status).toBe("succeeded");
	expect(reply.details).toMatchObject({
		task,
		phase: "needs_input",
		reason,
		...(unknown ? { unknownEffectCount: 1 } : {}),
		construction: { verifiedAtCheckpoint: 0, cellsToRecheck: [at], cellsToRecheckCount: 1 },
		nextCall: unknown
			? { action: "tasks", params: { op: "trace", task, record: "effect:one" } }
			: { action: "observe", params: { selector: "block@1", input: { at } } },
	});
	expect(f.continuations).toEqual([]);
});

test("continue saves its operation and exact request before dispatch", async () => {
	const f = fixture();
	try {
		const result = await f.facade.execute("tasks", continuation, new AbortController().signal);
		expect(result.status).toBe("succeeded");
		const credential = [...f.credentials.values()][0]!;
		expect(credential).toMatchObject({
			operation: "continue",
			request: {
				run: "run:one",
				decision: "decision:one",
				environment: "inherit",
				entry: { kind: "program", source: { code: continuation.entry.code }, input: {} },
			},
		});
		expect(f.continuations).toEqual([credential.request]);
		expect(f.submissions).toEqual([]);
		expect(f.found).toMatchObject([{ operation: "continue" }]);
	} finally {
		await f.facade.close();
	}
});

test("cancellation after storing a continuation retains the credential without dispatch", async () => {
	const f = fixture();
	const abort = new AbortController();
	const put = f.executor.ledger.putRequest;
	f.executor.ledger.putRequest = async (credential) => {
		await put(credential);
		abort.abort();
	};
	try {
		const result = await f.facade.execute("tasks", continuation, abort.signal);
		expect(result).toMatchObject({
			status: "not_started",
			details: { kind: "rejected", code: "REQUEST_CANCELLED" },
		});
		expect(f.credentials.size).toBe(1);
		expect(f.continuations).toEqual([]);
	} finally {
		await f.facade.close();
	}
});

test("cancelling a continuation wait preserves late acceptance and offers original-request lookup", async () => {
	const f = fixture();
	const abort = new AbortController();
	let finish!: (value: Acceptance) => void;
	f.executor.continue = async (request) => {
		f.continuations.push(request);
		return new Promise((resolve) => {
			finish = resolve;
		});
	};
	try {
		const pending = f.facade.execute("tasks", continuation, abort.signal);
		await expect.poll(() => f.continuations.length).toBe(1);
		abort.abort();
		const result = await pending;
		const requestId = f.continuations[0]!.requestId;
		expect(result).toMatchObject({
			status: "unknown",
			details: { kind: "confirming", task: continuation.task },
		});
		expect(result.details).not.toHaveProperty("nextCall");
		const repeat = await f.facade.execute("tasks", continuation, new AbortController().signal);
		expect(repeat).toMatchObject({ details: { kind: "confirming", task: continuation.task } });
		expect(f.continuations).toHaveLength(1);
		finish(f.accept(requestId));
		await expect.poll(() => f.found.length).toBe(1);
	} finally {
		await f.facade.close();
	}
});

test("a lost submit acknowledgement uses the original task for lookup and stop", async () => {
	const f = fixture();
	const signal = new AbortController().signal;
	f.executor.submit = async (request) => {
		f.submissions.push(request);
		return { kind: "unknown", requestId: request.requestId, reason: "reply lost" };
	};
	try {
		const receipt = await f.facade.execute("run", { selector: "chat@1", input: { text: "once" } }, signal);
		const requestId = f.submissions[0]!.requestId;
		const task = "task:local:" + requestId;
		expect(receipt).toMatchObject({ status: "unknown", details: { kind: "confirming", task } });
		expect(await f.facade.execute("tasks", { op: "get", task }, signal)).toMatchObject({
			status: "unknown",
			details: { task, phase: "confirming" },
		});
		expect(await f.facade.execute("tasks", { op: "get", task: "task:another:" + requestId }, signal)).toMatchObject({
			details: { code: "TASK_PROFILE_MISMATCH" },
		});
		await f.facade.execute("tasks", { op: "stop", task }, signal);
		expect(f.stops).toMatchObject([{ target: { request: requestId } }]);
		const originalLookup = f.executor.lookup;
		f.executor.lookup = async (id) => {
			const found = await originalLookup("root");
			return { ...found, requestId: id, snapshot: { ...found.snapshot, rootRequestId: requestId } };
		};
		expect(await f.facade.execute("tasks", { op: "get", task }, signal)).toMatchObject({
			details: { task, phase: "needs_input" },
		});
		expect(f.submissions).toHaveLength(1);
	} finally {
		await f.facade.close();
	}
});

test("run passes explicit replacement and preemption schedules to Runtime", async () => {
	const f = fixture();
	try {
		for (const schedule of [
			{ kind: "replace_pending", targets: [continuation.task] },
			{ kind: "preempt_current", expectedRun: continuation.task },
			{ kind: "enqueue", priority: true },
		]) {
			const result = await f.facade.execute("run", { selector: "chat@1", schedule }, new AbortController().signal);
			expect(result.status).toBe("succeeded");
			expect(f.submissions.at(-1)?.schedule).toEqual(
				JSON.parse(JSON.stringify(schedule).replace(continuation.task, "run:one")),
			);
		}
	} finally {
		await f.facade.close();
	}
});

test("tasks.continue 只返回受理：决策结果由 Completion 独立交付", async () => {
	const f = fixture();
	try {
		const result = await f.facade.execute("tasks", continuation, new AbortController().signal);
		expect(result.status).toBe("succeeded");
		expect(result.continuation).toBe("yield");
		// 工具结果只给受理句柄。decision 副本属于 Completion：新段允许继续推进，
		// 但工具这一层不能把它当成"这一轮已经结束"。
		expect(JSON.parse(result.result)).toMatchObject({ kind: "accepted", task: continuation.task });
		expect(JSON.parse(result.result)).not.toHaveProperty("snapshot");
		expect(JSON.parse(result.result)).not.toHaveProperty("phase");
		// 交付只剩 Completion 一条路：受理不再创建 tool 通道的 Attempt。
		expect(f.attempts).toEqual([]);
		// 凭据按原 request 落库——受理回复丢掉时只能靠它查证，不能重发。
		expect([...f.credentials.values()]).toHaveLength(1);
	} finally {
		await f.facade.close();
	}
});

test("the ledger retains continuation intent across reopen and rejects schema v2 without migration", async () => {
	const dir = await mkdtemp(join(tmpdir(), "uina-continue-ledger-"));
	const path = join(dir, "ledger.db");
	const credential: RequestCredential = {
		operation: "continue",
		requestId: "request",
		request: {
			requestId: "request",
			run: "run",
			decision: "decision",
			entry: { kind: "program", source: { name: "resume" }, input: {} },
		},
		activation: "activation",
		createdAt: "2026-10-26T00:00:00.000Z",
	};
	let ledger = new ExecutorLedger();
	try {
		await ledger.open(path, "owner", "storage");
		await ledger.putRequest(credential);
		await ledger.close();
		ledger = new ExecutorLedger();
		await ledger.open(path, "owner", "storage");
		expect(await ledger.getRequest(credential.requestId)).toEqual(credential);
		const attempt = {
			key: "completion",
			attempt: "attempt",
			channel: "input" as const,
			namespace: "world",
			session: "session",
			activation: "activation",
			createdAt: credential.createdAt,
		};
		await ledger.putAttempt(attempt);
		await ledger.putAttempt({ ...attempt, key: "other", channel: "tool" });
		await expect(
			ledger.putRequest({
				...credential,
				operation: "submit",
				request: { requestId: "request", entry: credential.request.entry, schedule: { kind: "enqueue" } },
			}),
		).rejects.toThrow("REQUEST_CONFLICT");
		const refusal = { kind: "rejected", code: "DECISION_STALE", message: "decision moved" } as const;
		await ledger.refuse(credential.requestId, refusal);
		await ledger.close();
		ledger = new ExecutorLedger();
		await ledger.open(path, "owner", "storage");
		expect(await ledger.getRequest(credential.requestId)).toEqual({ ...credential, refusal });
		expect(await ledger.attempts(["missing", attempt.key])).toEqual(new Map([[attempt.key, attempt]]));
		await ledger.close();
		execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('UPDATE identity SET schema_version=2 WHERE id=1');db.close();",
				path,
			],
			{ windowsHide: true },
		);
		ledger = new ExecutorLedger();
		await expect(ledger.open(path, "owner", "storage")).rejects.toThrow("incompatible executor ledger schema");
	} finally {
		await ledger.close();
	}
});

test("continue IPC binds origin on the execution side and excludes scheduling", () => {
	const input = {
		requestId: "request",
		run: "run",
		decision: "decision",
		entry: { kind: "program", source: { name: "resume" }, input: {} },
	};
	const validate = methods.get("runtime.continue")?.input;
	expect(validate?.(input)).toBe(true);
	expect(validate?.({ ...input, origin: { worldOwner: "forged", activation: "forged" } })).toBe(false);
	expect(validate?.({ ...input, schedule: { kind: "enqueue" } })).toBe(false);
	const Ajv = createRequire(import.meta.url)("ajv");
	const facadeInput = new Ajv({ strict: false }).compile(actionSchemas.tasks);
	expect(facadeInput(continuation)).toBe(true);
	expect(facadeInput({ ...continuation, entry: { ...continuation.entry, schedule: { kind: "enqueue" } } })).toBe(false);
});

test("confirming 落交接义务才让出本轮；义务写不进时保持 unknown，不谎报拒绝", async () => {
	const f = fixture();
	const signal = new AbortController().signal;
	f.executor.submit = async (request) => {
		f.submissions.push(request);
		return { kind: "unknown", requestId: request.requestId, reason: "reply lost" };
	};
	try {
		const receipt = await f.facade.execute("run", { selector: "chat@1", input: { text: "once" } }, signal);
		const requestId = f.submissions[0]!.requestId;
		expect(receipt).toMatchObject({ status: "unknown", details: { kind: "confirming" } });
		expect(receipt.continuation).toBe("yield");
		expect(f.notices.get(requestId)).toBe("pending");
		expect(receipt.details).not.toHaveProperty("nextCall");

		// 账本写不进：仍是不确定受理，不让出本轮，也不改写成明确拒绝。
		f.executor.ledger.markNotice = async () => {
			throw new Error("ledger unavailable");
		};
		const second = await f.facade.execute("run", { selector: "chat@1", input: { text: "twice" } }, signal);
		expect(second).toMatchObject({ status: "unknown", details: { kind: "confirming" } });
		expect(second.continuation).toBeUndefined();
	} finally {
		await f.facade.close();
	}
});
