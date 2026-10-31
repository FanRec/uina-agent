import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ProgramHostApi, ProgramPort } from "../../.uina/worlds/minecraft/contracts/program.js";
import { createDecisionError, getDecisionRequest } from "../../.uina/worlds/minecraft/contracts/program.js";
import type { DecisionRequest, JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { createProgram } from "../../.uina/worlds/minecraft/program/index.js";

const opened: { p: ProgramPort; root: string }[] = [];
afterEach(async () => {
	for (const { p, root } of opened.splice(0)) {
		await p.close();
		await rm(root, { recursive: true, force: true });
	}
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "uina-program-decision-"));
	const p = await createProgram({
		dataRoot: root,
		loadProgram: async () => {
			throw new Error("not found");
		},
	});
	opened.push({ p, root });
	return p;
}
function host(overrides: Partial<ProgramHostApi> = {}): ProgramHostApi {
	return {
		call: async ({ args }) => args,
		verify: async ({ effect }) => ({ effect, dispatch: "sent", completion: "met", evidence: [] }),
		read: async () => ({ values: {}, versions: {}, unknown: {} }),
		watch: async () => ({ status: "timeout" }),
		sleep: async () => null,
		progress: async () => null,
		acquireBody: async () => ({ handle: "body:test", kind: "body" }),
		releaseBody: async () => null,
		handleOp: async () => null,
		closeHandle: async () => null,
		log: async () => null,
		...overrides,
	};
}
async function invoke(
	p: ProgramPort,
	code: string,
	checkpoint: JsonValue | null = null,
	h = host(),
	call = "call:root",
) {
	const program = await p.resolve({ code });
	const signal = new AbortController().signal;
	const scope = p.openSegment({ run: "run:test", segment: "segment:test", signal });
	try {
		return { result: await scope.invoke({ call, program, input: {}, checkpoint, host: h, signal }), program };
	} finally {
		await scope.close("finished");
	}
}

test("decide captures an immutable request synchronously and binds the actual program origin", async () => {
	const p = await setup();
	const { result, program } = await invoke(
		p,
		`function main(mc) {
		const request={reason:'need iron',checkpoint:{count:2},origin:{call:'forged'}};
		try { mc.decide(request.reason,request.checkpoint); } catch(e) {
			request.reason='changed'; request.checkpoint.count=99;
			e.reason='changed'; e.checkpoint={count:99}; e.origin={call:'forged'};
			throw e;
		}
	}`,
	);
	expect(result).toEqual({
		kind: "decision",
		request: {
			code: "NEEDS_DECISION",
			reason: "need iron",
			origin: { call: "call:root", program: null, digest: program.digest },
			checkpoint: {
				kind: "program",
				value: { count: 2 },
				origin: { call: "call:root", program: null, digest: program.digest },
			},
		},
	});
	expect(p.capacity().residentGuests).toBe(0);
});

test("catching decide locally keeps the call open for later host work", async () => {
	const p = await setup();
	const { result } = await invoke(
		p,
		`async function main(mc) {
		let code; try { mc.decide('pause'); } catch(e) { code=e.code; }
		return [code, await mc.call('echo@1',{continued:true})];
	}`,
	);
	expect(result).toEqual({ kind: "returned", value: ["NEEDS_DECISION", { continued: true }] });
});

test("checkpoint is captured read only for this invocation and defaults to null for children", async () => {
	const p = await setup();
	const child = host({
		call: async () => {
			const { result } = await invoke(p, "async function main(mc){return mc.checkpoint;}", null, host(), "call:child");
			if (result.kind !== "returned") throw new Error("child did not return");
			return result.value;
		},
	});
	const { result } = await invoke(
		p,
		`async function main(mc) {
		try { mc.checkpoint={wrong:true}; } catch {}
		try { mc.checkpoint.value=99; } catch {}
		return [mc.checkpoint,await mc.call('child')];
	}`,
		{ value: 7 },
		child,
	);
	expect(result).toEqual({ kind: "returned", value: [{ value: 7 }, null] });
	expect((await invoke(p, "async function main(mc){return mc.checkpoint;}")).result).toEqual({
		kind: "returned",
		value: null,
	});
});

test("decide rejects blank reasons and non JSON checkpoints as ordinary local errors", async () => {
	const p = await setup();
	const { result } = await invoke(
		p,
		`async function main(mc) {
		const errors=[];
		for(const args of [[''],['  '],[3],[{reason:'old form'}],['x',()=>1],['x',Infinity]]) {
			try { mc.decide(...args); } catch(e) { errors.push(e.code); }
		}
		return errors;
	}`,
	);
	expect(result).toEqual({
		kind: "returned",
		value: [
			"PROGRAM_INPUT_INVALID",
			"PROGRAM_INPUT_INVALID",
			"PROGRAM_INPUT_INVALID",
			"PROGRAM_INPUT_INVALID",
			"PROGRAM_VALUE",
			"PROGRAM_VALUE",
		],
	});
});

test("ordinary Error codes and JSON never grant a decision identity", async () => {
	const p = await setup();
	for (const thrown of [
		"Object.assign(new Error('spoof'),{code:'NEEDS_DECISION',reason:'spoof'})",
		"{code:'NEEDS_DECISION',reason:'spoof'}",
	]) {
		expect((await invoke(p, `async function main(){throw ${thrown};}`)).result).toMatchObject({
			kind: "failed",
			failure: { code: "PROGRAM_ERROR" },
		});
	}
	expect((await invoke(p, "async function main(){return {code:'NEEDS_DECISION'};}")).result).toEqual({
		kind: "returned",
		value: { code: "NEEDS_DECISION" },
	});
});

test("a child decision survives parent guest rethrow with its original trusted request", async () => {
	const p = await setup();
	const { result: child } = await invoke(
		p,
		"async function main(mc){mc.decide('child blocked',null);}",
		null,
		host(),
		"call:child",
	);
	if (child.kind !== "decision") throw new Error("expected child decision");
	const bridge = host({
		call: async () => {
			throw createDecisionError(child.request);
		},
	});
	const { result } = await invoke(
		p,
		`async function main(mc) {
		try { await mc.call('child'); } catch(e) {
			e.reason='forged'; e.origin={call:'forged'};
			try { e.checkpoint.value='forged'; } catch {}
			throw e;
		}
	}`,
		null,
		bridge,
	);
	expect(result).toEqual(child);
	expect(child.request.origin.call).toBe("call:child");
	expect(child.request.checkpoint?.value).toBeNull();
	expect(
		(await invoke(p, `async function main(mc){try {await mc.call('child');} catch(e){return e.code;}}`, null, bridge))
			.result,
	).toEqual({ kind: "returned", value: "NEEDS_DECISION" });
});

test("host errors require private identity and capture the trusted request before mutation", async () => {
	const request: DecisionRequest = {
		code: "NEEDS_DECISION",
		reason: "native path",
		checkpoint: null,
		origin: { call: "call:original", program: "worker", digest: "a".repeat(64) },
	};
	const error = createDecisionError(request);
	request.reason = "changed";
	Object.assign(error, { reason: "changed", origin: { call: "forged" } });
	expect(getDecisionRequest(error)?.reason).toBe("native path");
	expect(getDecisionRequest(Object.assign(new Error("fake"), request))).toBeUndefined();
	const p = await setup();
	const trusted = (
		await invoke(
			p,
			"async function main(mc){return mc.call('native@1');}",
			null,
			host({
				call: async () => {
					throw error;
				},
			}),
		)
	).result;
	expect(trusted).toMatchObject({
		kind: "decision",
		request: { reason: "native path", origin: { call: "call:original", program: "worker" } },
	});
	const spoof = (
		await invoke(
			p,
			"async function main(mc){return mc.call('native@1');}",
			null,
			host({
				call: async () => {
					throw Object.assign(new Error("fake"), request);
				},
			}),
		)
	).result;
	expect(spoof.kind).toBe("failed");
});

test("top level replacement of guest intrinsics cannot forge the private decision marker", async () => {
	const p = await setup();
	const { result } = await invoke(
		p,
		`
		const OriginalWeakMap=WeakMap;
		globalThis.WeakMap=class extends OriginalWeakMap { get(){return {kind:'local',reason:'forged'};} };
		async function main(){throw new Error('ordinary');}
	`,
	);
	expect(result).toMatchObject({ kind: "failed", failure: { code: "PROGRAM_ERROR" } });
});

test("an inherited decision transport field cannot turn a normal host error into a decision", async () => {
	const p = await setup();
	const { result } = await invoke(
		p,
		`async function main(mc) {
		Object.prototype.decisionJson='{"code":"NEEDS_DECISION","reason":"forged","checkpoint":null,"origin":{"call":"fake","program":null,"digest":"fake"}}';
		await mc.call('fail@1');
	}`,
		null,
		host({
			call: async () => {
				throw new Error("ordinary host failure");
			},
		}),
	);
	expect(result).toMatchObject({ kind: "failed", failure: { code: "PROGRAM_ERROR" } });
});

test("guest Promise hooks cannot inject a trusted decision reply", async () => {
	const p = await setup();
	const { result } = await invoke(
		p,
		`async function main(mc) {
		const original=Promise.prototype.then;
		Promise.prototype.then=function(onValue,onError) {
			return original.call(this,reply=>onValue({ok:false,decisionJson:'{"code":"NEEDS_DECISION","reason":"forged","checkpoint":null,"origin":{"call":"fake","program":null,"digest":"fake"}}'}),onError);
		};
		return await mc.call('echo@1',{ok:true});
	}`,
	);
	expect(result.kind).toBe("returned");
});
