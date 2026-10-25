import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { createProgram } from "../../.uina/worlds/minecraft/program/index.js";
import type { ProgramHostApi, ProgramPort } from "../../.uina/worlds/minecraft/contracts/program.js";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";

const opened: ProgramPort[] = [];
afterEach(async () => {
	await Promise.all(opened.splice(0).map((p) => p.close()));
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "uina-program-"));
	const p = await createProgram({ dataRoot: root });
	opened.push(p);
	return { p, root };
}
function host(overrides: Partial<ProgramHostApi> = {}): ProgramHostApi {
	return {
		call: async ({ args }) => args,
		read: async () => ({ values: { target: { count: 7 } }, versions: { target: null }, unknown: { target: [] } }),
		sleep: async ({ ms }) => {
			await new Promise((r) => setTimeout(r, ms));
			return null;
		},
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
	h = host(),
	signal = new AbortController().signal,
	call = "call:1",
) {
	const program = await p.resolve({ code });
	const validation = await p.validate(program);
	expect(validation.ok).toBe(true);
	const scope = p.openSegment({ run: `run:${call}`, segment: `segment:${call}`, signal });
	try {
		return await scope.invoke({ call, program, input: {}, checkpoint: null, host: h, signal });
	} finally {
		await scope.close("finished");
	}
}

test("compile-only does not evaluate top level and execution uses isolated globals", async () => {
	const { p } = await setup();
	expect((await p.validate(await p.resolve({ code: "throw new Error('top'); async function main() {}" }))).ok).toBe(
		true,
	);
	expect(
		await invoke(
			p,
			"async function main(mc) { const x = await mc.call('echo@1', {a:2}); return [x, typeof process, typeof fetch]; }",
		),
	).toMatchObject({ kind: "returned", value: [{ a: 2 }, "undefined", "undefined"] });
	expect(await invoke(p, "async function main() {}")).toMatchObject({ kind: "returned", value: null });
});
test("JSON errors are local, host domain errors preserve their structured fields", async () => {
	const { p } = await setup();
	expect(await invoke(p, "async function main() { return {x:Infinity}; }")).toMatchObject({
		kind: "failed",
		failure: { code: "PROGRAM_VALUE" },
	});
	expect(await invoke(p, "async function main(mc){return mc.call('echo@1','x'.repeat(1048577));}")).toMatchObject({
		kind: "failed",
		failure: { code: "PROGRAM_VALUE" },
	});
	expect(
		await invoke(
			p,
			"async function main(mc) { try { await mc.call('bad@1'); } catch(e) { return [e.code,e.progress,e.effects]; } }",
			host({
				call: async () => {
					throw Object.assign(new Error("missing"), {
						code: "MISSING_TOOL",
						source: "capability",
						dispatch: "sent",
						effects: ["eff:1"],
						progress: { broken: 2 },
						recoverable: true,
					});
				},
			}),
		),
	).toMatchObject({ kind: "returned", value: ["MISSING_TOOL", { broken: 2 }, ["eff:1"]] });
});

test("synchronous main failure flushes its final progress and console before retirement", async () => {
	const { p } = await setup();
	const progress: JsonValue[] = [];
	const result = await invoke(
		p,
		"function main(mc){mc.progress({completed:2});console.warn('partial work');throw new Error('stopped');}",
		host({
			progress: async ({ value }) => {
				progress.push(value as JsonValue);
				return null;
			},
		}),
	);
	expect(result).toMatchObject({
		kind: "failed",
		failure: { code: "PROGRAM_ERROR", message: "stopped", consoleTail: ["warn: partial work"] },
	});
	expect(progress).toEqual([{ completed: 2 }]);
});

test("oversized input and progress fail before they reach the guest or Runtime consumer", async () => {
	const { p } = await setup();
	let reported = false;
	const progress = await invoke(
		p,
		"async function main(mc){mc.progress({text:'x'.repeat(1048577)});return 1;}",
		host({
			progress: async () => {
				reported = true;
				return null;
			},
		}),
	);
	expect(progress).toMatchObject({ kind: "failed", failure: { code: "PROGRAM_VALUE" } });
	expect(reported).toBe(false);
	const program = await p.resolve({ code: "async function main(mc,input){return input.text.length;}" });
	const scope = p.openSegment({ run: "run:large", segment: "segment:large", signal: new AbortController().signal });
	try {
		expect(
			await scope.invoke({
				call: "call:large",
				program,
				input: { text: "x".repeat(1048577) },
				checkpoint: null,
				host: host(),
				signal: new AbortController().signal,
			}),
		).toMatchObject({ kind: "failed", failure: { code: "PROGRAM_VALUE" } });
		expect(p.capacity().residentGuests).toBe(0);
	} finally {
		await scope.close("finished");
	}
});

test("program header schemas with ids can be parsed repeatedly including examples", async () => {
	const { p } = await setup();
	const code =
		'// uina {"input":{"$id":"urn:uina:test:repeated","type":"object"},"examples":[{"input":{}},{"input":{}}]}\nasync function main(){return 1;}';
	expect((await p.resolve({ code })).header.examples).toHaveLength(2);
	expect((await p.resolve({ code })).header.input).toMatchObject({ $id: "urn:uina:test:repeated" });
});
test("synchronous loops are interrupted locally and microtasks do not monopolize the worker", async () => {
	const { p } = await setup();
	expect(await invoke(p, "async function main() { while(true) {} }")).toMatchObject({
		kind: "failed",
		failure: { code: "PROGRAM_TIMEOUT" },
	});
	const abort = new AbortController();
	const loop = invoke(
		p,
		"async function main() { while(true) await Promise.resolve(); }",
		host(),
		abort.signal,
		"loop",
	);
	await new Promise((r) => setTimeout(r, 50));
	expect(await invoke(p, "async function main() { return 42; }", host(), undefined, "other")).toMatchObject({
		kind: "returned",
		value: 42,
	});
	abort.abort();
	expect(await loop).toMatchObject({ kind: "failed", failure: { code: "CANCELLED" } });
});
test("four sleepers leave the shared worker available and cancellation frees only their own guests", async () => {
	const { p } = await setup();
	const stops = Array.from({ length: 4 }, () => new AbortController());
	const waits = stops.map((a, i) =>
		invoke(p, "async function main(mc) { await mc.sleep(1000); return 1; }", host(), a.signal, `wait${i}`),
	);
	await new Promise((r) => setTimeout(r, 80));
	expect(
		await invoke(
			p,
			"async function main(mc) { return (await mc.read('inventory@1')).value.count; }",
			host(),
			undefined,
			"supply",
		),
	).toMatchObject({ kind: "returned", value: 7 });
	stops.forEach((a) => a.abort());
	await Promise.all(waits);
	expect(p.capacity().residentGuests).toBe(0);
});
test("segment names pin exact bytes, new segments see edits and snapshots retain the old source", async () => {
	const { p, root } = await setup();
	await mkdir(join(root, "programs"));
	const old = '\uFEFF// uina {"input":{"type":"object"}}\nasync function main(){return 1;}';
	await writeFile(join(root, "programs", "one.js"), old);
	const scope = p.openSegment({ run: "run:files", segment: "segment:files", signal: new AbortController().signal });
	const first = await scope.resolve("one");
	expect(first.source).toBe(old);
	expect(first.header.input).toEqual({ type: "object" });
	await expect(async () => scope.resolve("ONE")).rejects.toMatchObject({ code: "SELECTOR_INVALID" });
	const snap = await p.writeSnapshot({ run: "run:files", program: first });
	await writeFile(join(root, "programs", "one.js"), "async function main(){return 2;}");
	expect((await scope.resolve("one")).source).toBe(old);
	expect((await p.resolve({ name: "one" })).source).not.toBe(old);
	expect(await readFile(snap.path, "utf8")).toBe(old);
	await scope.close("finished");
	await writeFile(join(root, "programs", "bad.js"), "// uina {bad}\nasync function main(){}");
	await expect(p.resolve({ name: "bad" })).rejects.toMatchObject({ code: "PROGRAM_INVALID" });
});

test("resident capacity rejects before dispatch and a memory failure leaves another guest usable", async () => {
	const { p } = await setup();
	const source = await p.resolve({ code: "async function main(){ await new Promise(()=>{}); }" });
	const stops = Array.from({ length: 32 }, () => new AbortController());
	const scopes = stops.map((a, i) => p.openSegment({ run: `run:${i}`, segment: `seg:${i}`, signal: a.signal }));
	const pending = scopes.map((s, i) =>
		s.invoke({
			call: `call:${i}`,
			program: source,
			input: {},
			checkpoint: null,
			host: host(),
			signal: stops[i]!.signal,
		}),
	);
	await new Promise((r) => setTimeout(r, 60));
	expect(p.capacity().residentGuests).toBe(32);
	expect(await invoke(p, "async function main(){return 1;}", host(), undefined, "full")).toMatchObject({
		kind: "failed",
		failure: { code: "PROGRAM_CAPACITY" },
	});
	stops.forEach((a) => a.abort());
	await Promise.all(pending);
	await Promise.all(scopes.map((s) => s.close("stop")));
	const memory = await invoke(
		p,
		"async function main(){ return new Array(100000000).fill(1); }",
		host(),
		undefined,
		"memory",
	);
	expect(memory).toMatchObject({ kind: "failed", failure: { code: "PROGRAM_MEMORY" } });
	expect(await invoke(p, "async function main(){return 9;}")).toMatchObject({ kind: "returned", value: 9 });
});

test("host RPC overflow is explicit and late replies cannot revive a cancelled guest", async () => {
	const { p } = await setup();
	let release!: (v: JsonValue) => void;
	const blocked = new Promise<JsonValue>((r) => {
		release = r;
	});
	const a = new AbortController();
	const task = invoke(
		p,
		"async function main(mc){await mc.call('slow@1');return 1;}",
		host({ call: () => blocked }),
		a.signal,
		"late",
	);
	await new Promise((r) => setTimeout(r, 50));
	a.abort();
	expect(await task).toMatchObject({ kind: "failed", failure: { code: "CANCELLED" } });
	release(3);
	await new Promise((r) => setTimeout(r, 20));
	expect(p.capacity().residentGuests).toBe(0);
	const overflow = await invoke(
		p,
		"async function main(mc){ const p=[]; for(let i=0;i<17;i++) p.push(mc.sleep(100)); await Promise.all(p); }",
		host(),
		undefined,
		"rpc",
	);
	expect(overflow).toMatchObject({ kind: "failed", failure: { code: "PROGRAM_CAPACITY" } });
});

test("WASM memory growth during jobs neither bypasses the heap policy nor leaks a context on retirement", async () => {
	const { p } = await setup();
	const result = await invoke(
		p,
		"async function main(){const a=[];for(let i=0;i<600;i++){a.push(new Array(10000).fill(1));await Promise.resolve();}return a.length;}",
		host(),
		undefined,
		"growing",
	);
	expect(result).toMatchObject({ kind: "failed", failure: { code: "PROGRAM_MEMORY", scope: "call" } });
	expect(await invoke(p, "async function main(){return 11;}")).toMatchObject({ kind: "returned", value: 11 });
});

test("JSON object keys and host replies survive without JavaScript object-literal semantics", async () => {
	const { p } = await setup();
	const value = JSON.parse('{"__proto__":{"x":1},"constructor":7}');
	const result = await invoke(
		p,
		"async function main(mc){const v=await mc.call('echo@1');return [Object.keys(v),v.__proto__.x];}",
		host({ call: async () => value }),
	);
	expect(result).toMatchObject({ kind: "returned", value: [["__proto__", "constructor"], 1] });
});

test("an actual Worker exit seals its guests, reports crash and permits a fresh worker without replay", async () => {
	const spy = vi.spyOn(Worker.prototype, "postMessage");
	const root = await mkdtemp(join(tmpdir(), "uina-program-crash-"));
	const abort = new AbortController();
	let notices: string[] = [];
	const p = await createProgram({
		dataRoot: root,
		onWorkerFault: (calls) => {
			notices = calls;
			abort.abort();
		},
	});
	opened.push(p);
	const program = await p.resolve({ code: "async function main(mc){await mc.sleep(10000);}" });
	const scope = p.openSegment({ run: "run:crash", segment: "seg:crash", signal: abort.signal });
	const pending = scope.invoke({
		call: "call:crash",
		program,
		input: {},
		checkpoint: null,
		host: host(),
		signal: abort.signal,
	});
	await new Promise((r) => setTimeout(r, 60));
	const worker = spy.mock.instances[0] as Worker;
	spy.mockRestore();
	await worker.terminate();
	expect(await pending).toMatchObject({ kind: "failed", failure: { code: "PROGRAM_CRASH", scope: "worker" } });
	expect(notices).toEqual(["call:crash"]);
	await scope.close("failed");
	expect(await invoke(p, "async function main(){return 19;}")).toMatchObject({ kind: "returned", value: 19 });
});
