import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Acceptance, ContinueRequest, RunRequest } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { MinecraftFacade } from "../../.uina/worlds/minecraft/executor/facade.js";
import type { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";
import { ExecutorLedger } from "../../.uina/worlds/minecraft/executor/ledger.js";
import type { RequestCredential } from "../../.uina/worlds/minecraft/executor/ledger-worker.js";
import { methods } from "../../.uina/worlds/minecraft/executor/protocol.js";
import { actionSchemas } from "../../.uina/worlds/minecraft/worlddef/schema.js";

function fixture() {
	const credentials = new Map<string, RequestCredential>();
	const submissions: RunRequest[] = [];
	const continuations: ContinueRequest[] = [];
	const found: unknown[] = [];
	const attempts: unknown[] = [];
	const snapshot = { run: "run:one", phase: "running", revision: 2, record: "record:one" };
	const accept = (requestId: string) =>
		({ kind: "accepted", requestId, segment: "segment:two", snapshot }) as Acceptance;
	const executor = {
		status: () => ({ actionsAllowed: true, side: { launch: "launch" } }),
		ledger: {
			putRequest: async (credential: RequestCredential) => {
				credentials.set(credential.requestId, credential);
			},
			getRequest: async (id: string) => credentials.get(id) ?? null,
			found: async (_id: string, lookup: unknown) => {
				found.push(lookup);
			},
			putAttempt: async (attempt: unknown) => {
				attempts.push(attempt);
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
		lookup: async (requestId: string) => ({ kind: "not_found", requestId }),
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
	return { executor, facade, credentials, submissions, continuations, found, attempts, accept };
}
const continuation = {
	op: "continue",
	run: "run:one",
	decision: "decision:one",
	entry: { code: "async function main(mc){return mc.checkpoint;}" },
	environment: "inherit",
};

test("continue saves its operation and exact request before dispatch; retry reuses it", async () => {
	const f = fixture();
	try {
		const result = await f.facade.execute("runs", continuation, new AbortController().signal);
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
		await f.facade.execute("runs", { op: "retry", request: credential.requestId }, new AbortController().signal);
		expect(f.continuations).toEqual([credential.request, credential.request]);
		expect(f.submissions).toEqual([]);
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
		const result = await f.facade.execute("runs", continuation, abort.signal);
		expect(result).toMatchObject({
			status: "not_started",
			details: { kind: "not_accepted", code: "REQUEST_CANCELLED" },
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
		const pending = f.facade.execute("runs", continuation, abort.signal);
		await expect.poll(() => f.continuations.length).toBe(1);
		abort.abort();
		const result = await pending;
		const requestId = f.continuations[0]!.requestId;
		expect(result).toMatchObject({
			status: "unknown",
			details: {
				kind: "unknown",
				requestId,
				nextCall: { action: "runs", params: { op: "request", request: requestId } },
			},
		});
		finish(f.accept(requestId));
		await expect.poll(() => f.found.length).toBe(1);
	} finally {
		await f.facade.close();
	}
});

test("run passes explicit replacement and preemption schedules to Runtime", async () => {
	const f = fixture();
	try {
		for (const schedule of [
			{ kind: "replace_pending", targets: ["run:old"] },
			{ kind: "preempt_current", expectedRun: "run:old" },
		]) {
			const result = await f.facade.execute("run", { selector: "chat@1", schedule }, new AbortController().signal);
			expect(result.status).toBe("succeeded");
			expect(f.submissions.at(-1)?.schedule).toEqual(schedule);
		}
	} finally {
		await f.facade.close();
	}
});

test("a decision in the short result window uses the same fixed report and Host receipt path", async () => {
	const f = fixture();
	const snapshot = {
		run: "run:one",
		phase: "awaiting_decision",
		revision: 3,
		record: "record:one",
		completionRef: "completion:decision",
		decision: "decision:two",
	};
	const delivery = {
		reportKind: "decision",
		completionRef: snapshot.completionRef,
		requestId: "request:continued",
		run: snapshot.run,
		segment: "segment:two",
		revision: snapshot.revision,
		recordBytes: 10,
		snapshot,
	};
	Object.assign(f.executor, {
		wait: async () => ({ kind: "result", snapshot }),
		rpc: async () => ({ delivery, disposition: "pending", eligible: true }),
		readRecord: async () => ({ kind: "inline", record: { kind: "completion", value: delivery } }),
	});
	try {
		const result = await f.facade.execute("runs", continuation, new AbortController().signal);
		expect(result).toMatchObject({
			status: "succeeded",
			receipt: { key: "completion:decision" },
			details: {
				kind: "result",
				reportKind: "decision",
				snapshot: { phase: "awaiting_decision" },
				content: { kind: "inline", report: { reportKind: "decision" } },
			},
		});
		expect(f.attempts).toMatchObject([{ key: "completion:decision", channel: "tool" }]);
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
		await expect(
			ledger.putRequest({
				...credential,
				operation: "submit",
				request: { requestId: "request", entry: credential.request.entry, schedule: { kind: "enqueue" } },
			}),
		).rejects.toThrow("REQUEST_CONFLICT");
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
	const facadeInput = new Ajv({ strict: false }).compile(actionSchemas.runs);
	expect(facadeInput(continuation)).toBe(true);
	expect(facadeInput({ ...continuation, entry: { ...continuation.entry, schedule: { kind: "enqueue" } } })).toBe(false);
});
